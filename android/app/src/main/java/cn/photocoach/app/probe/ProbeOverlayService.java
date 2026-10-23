package cn.photocoach.app.probe;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.PixelFormat;
import android.media.Image;
import android.media.ImageReader;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.SystemClock;
import android.util.Log;
import android.view.Gravity;
import android.view.WindowManager;

import java.nio.ByteBuffer;
import java.util.Locale;

/**
 * 验证服务：把「指导层盖在系统相机上」这件事的两个未知点一次测掉。
 *
 * <p>未知点一：**能不能画**。用 {@code TYPE_APPLICATION_OVERLAY} 加一层全屏、
 * 不接收触摸的浮窗。这个几乎必然成功 —— 悬浮窗本来就是画在别人窗口上面的。
 *
 * <p>未知点二：**能不能读到画面**。用 {@link MediaProjection} 把整块屏幕录下来，
 * 每 350ms 采样中间区域的平均亮度。如果系统相机预览被厂商打了
 * {@code FLAG_SECURE}，采样结果会接近 0（纯黑），浮层上的状态行会直接显示
 * 「疑似全黑」——这就是本次验证最想拿到的答案。
 *
 * <p>两个能力可以分开用：不带 MediaProjection 结果启动时，只显示浮层。
 *
 * <p>注意：浮层自己必须带 {@code FLAG_SECURE}，否则它会被自己录进去，
 * 检测器看到的是自己画的剪影而不是相机画面，形成反馈环。
 */
public class ProbeOverlayService extends Service {

    private static final String TAG = "PhotoCoachProbe";

    public static final String ACTION_SHOW = "cn.photocoach.app.probe.SHOW";
    public static final String ACTION_STOP = "cn.photocoach.app.probe.STOP";
    public static final String EXTRA_RESULT_CODE = "resultCode";
    public static final String EXTRA_RESULT_DATA = "resultData";

    private static final String CHANNEL_ID = "probe";
    private static final int NOTIFICATION_ID = 4201;

    /** 采样间隔。太密没必要 —— 我们只关心「有没有画面」，不追求帧率。 */
    private static final long SAMPLE_INTERVAL_MS = 350L;

    private WindowManager windowManager;
    private GuideOverlayView overlayView;

    private MediaProjection projection;
    private VirtualDisplay virtualDisplay;
    private ImageReader imageReader;
    private HandlerThread captureThread;
    private Handler captureHandler;
    private Handler uiHandler;

    private long lastSampleAt;
    private long sampleCount;
    private int minLuma = 255;
    private int maxLuma;
    private boolean foregroundStarted;
    private String pendingStatus = "";

    @Override
    public void onCreate() {
        super.onCreate();
        windowManager = (WindowManager) getSystemService(Context.WINDOW_SERVICE);
        uiHandler = new Handler(getMainLooper());
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) {
            stopSelf();
            return START_NOT_STICKY;
        }
        if (ACTION_STOP.equals(intent.getAction())) {
            stopSelf();
            return START_NOT_STICKY;
        }

        boolean wantCapture = intent.hasExtra(EXTRA_RESULT_DATA);

        // Android 14 的顺序要求很死：先 getMediaProjection 拿令牌 → 再 startForeground
        // （类型 mediaProjection）→ 最后才允许 createVirtualDisplay。
        // 顺序反了会抛 SecurityException，所以这里拆成三步走。
        if (wantCapture && !foregroundStarted) {
            if (!acquireProjection(intent)) {
                stopSelf();
                return START_NOT_STICKY;
            }
            startForegroundWithType();
            startVirtualDisplay();
        } else if (!foregroundStarted) {
            // 只显示浮层：不声明前台类型，普通通知即可，避免 FGS 类型校验。
            postPlainNotification();
        }

        showOverlay();
        if (!wantCapture) {
            setStatus("浮层已显示｜未录屏（只能画，读不到画面）");
        }
        return START_NOT_STICKY;
    }

    // ------------------------------------------------------------ 前台通知

    private void startForegroundWithType() {
        Notification notification = buildNotification("正在录屏采样，可切到系统相机观察");
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
        foregroundStarted = true;
    }

    private void postPlainNotification() {
        NotificationManager manager =
                (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) {
            manager.notify(NOTIFICATION_ID, buildNotification("指导浮层已开启"));
        }
    }

    private Notification buildNotification(String text) {
        NotificationManager manager =
                (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && manager != null) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID, "叠加验证", NotificationManager.IMPORTANCE_LOW);
            manager.createNotificationChannel(channel);
        }

        Intent stop = new Intent(this, ProbeOverlayService.class).setAction(ACTION_STOP);
        PendingIntent stopPending = PendingIntent.getService(
                this, 1, stop, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);
        return builder
                .setContentTitle("拍照指导 · 叠加验证")
                .setContentText(text)
                .setSmallIcon(android.R.drawable.ic_menu_camera)
                .setOngoing(true)
                .addAction(new Notification.Action.Builder(
                        null, "停止", stopPending).build())
                .build();
    }

    // ------------------------------------------------------------ 悬浮窗

    private void showOverlay() {
        if (overlayView != null || windowManager == null) return;

        overlayView = new GuideOverlayView(this);

        int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                : WindowManager.LayoutParams.TYPE_PHONE;

        WindowManager.LayoutParams params = new WindowManager.LayoutParams(
                WindowManager.LayoutParams.MATCH_PARENT,
                WindowManager.LayoutParams.MATCH_PARENT,
                type,
                // NOT_TOUCHABLE 是必须的：浮层要能盖住系统相机的快门按钮而不吃掉点击
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
                        | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
                        // 见类注释：防止自己的浮层被自己录进去
                        | WindowManager.LayoutParams.FLAG_SECURE,
                PixelFormat.TRANSLUCENT);
        params.gravity = Gravity.TOP | Gravity.START;
        params.x = 0;
        params.y = 0;

        try {
            windowManager.addView(overlayView, params);
            overlayView.setStatus(pendingStatus);
        } catch (Exception error) {
            // 没授权、或 ROM 拦了，直接说清楚，不要静默失败
            Log.w(TAG, "添加悬浮窗失败", error);
            overlayView = null;
        }
    }

    private void removeOverlay() {
        if (overlayView == null || windowManager == null) return;
        try {
            windowManager.removeView(overlayView);
        } catch (Exception ignored) {
            // 已经被系统移除了，忽略
        }
        overlayView = null;
    }

    private void setStatus(final String text) {
        // 浮层可能还没加进去（录屏先启动、浮层后显示），先把文字存下来
        pendingStatus = text;
        if (overlayView == null) return;
        uiHandler.post(() -> {
            if (overlayView != null) overlayView.setStatus(text);
        });
    }

    // ------------------------------------------------------------ 录屏采样

    private boolean acquireProjection(Intent intent) {
        int resultCode = intent.getIntExtra(EXTRA_RESULT_CODE, 0);
        Intent data = intent.getParcelableExtra(EXTRA_RESULT_DATA);
        if (data == null) return false;

        MediaProjectionManager manager =
                (MediaProjectionManager) getSystemService(Context.MEDIA_PROJECTION_SERVICE);
        if (manager == null) return false;

        try {
            projection = manager.getMediaProjection(resultCode, data);
        } catch (Exception error) {
            Log.w(TAG, "getMediaProjection 失败", error);
            return false;
        }
        if (projection == null) return false;

        // 官方文档：不注册回调就调 createVirtualDisplay 会抛 IllegalStateException，
        // 所以回调必须在这里注册，早于建虚拟屏。
        projection.registerCallback(new MediaProjection.Callback() {
            @Override
            public void onStop() {
                // 用户点了状态栏的停止、或锁屏，系统会调到这里
                setStatus("录屏已被系统停止");
            }
        }, uiHandler);

        return true;
    }

    private void startVirtualDisplay() {
        if (projection == null) return;

        android.util.DisplayMetrics metrics = getResources().getDisplayMetrics();
        // 采样用的虚拟屏刻意压到 360 宽：只判断「黑不黑」，不需要分辨率
        int width = Math.max(1, Math.min(metrics.widthPixels, 360));
        int height = Math.max(1, metrics.heightPixels * width / Math.max(1, metrics.widthPixels));
        int density = Math.max(1, metrics.densityDpi * width / Math.max(1, metrics.widthPixels));

        captureThread = new HandlerThread("probe-capture");
        captureThread.start();
        captureHandler = new Handler(captureThread.getLooper());

        try {
            imageReader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2);
            imageReader.setOnImageAvailableListener(this::onImageAvailable, captureHandler);

            // Android 14 起：同一个 MediaProjection 实例只允许 createVirtualDisplay 一次
            virtualDisplay = projection.createVirtualDisplay(
                    "probe-capture", width, height, density,
                    DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                    imageReader.getSurface(), null, captureHandler);
        } catch (Exception error) {
            Log.w(TAG, "创建录屏会话失败", error);
            setStatus("创建录屏会话失败：" + error.getClass().getSimpleName());
            return;
        }

        setStatus("录屏中｜等待采样…");
    }

    private void onImageAvailable(ImageReader reader) {
        Image image = null;
        try {
            image = reader.acquireLatestImage();
            if (image == null) return;

            long now = SystemClock.uptimeMillis();
            if (now - lastSampleAt < SAMPLE_INTERVAL_MS) return;
            lastSampleAt = now;

            Image.Plane plane = image.getPlanes()[0];
            ByteBuffer buffer = plane.getBuffer();
            int rowStride = plane.getRowStride();
            int pixelStride = plane.getPixelStride();
            int width = image.getWidth();
            int height = image.getHeight();
            int limit = buffer.limit();

            // 只取中间 60% 区域：屏幕边缘往往是相机 App 自己的黑边
            int x0 = width / 5;
            int x1 = width * 4 / 5;
            int y0 = height / 5;
            int y1 = height * 4 / 5;
            int step = Math.max(1, width / 60);

            long sum = 0;
            long count = 0;
            long dark = 0;
            for (int y = y0; y < y1; y += step) {
                int rowBase = y * rowStride;
                for (int x = x0; x < x1; x += step) {
                    int index = rowBase + x * pixelStride;
                    if (index + 2 >= limit) continue;
                    int r = buffer.get(index) & 0xFF;
                    int g = buffer.get(index + 1) & 0xFF;
                    int b = buffer.get(index + 2) & 0xFF;
                    int luma = (r * 77 + g * 150 + b * 29) >> 8;
                    sum += luma;
                    count++;
                    if (luma < 12) dark++;
                }
            }
            if (count == 0) return;

            int mean = (int) (sum / count);
            minLuma = Math.min(minLuma, mean);
            maxLuma = Math.max(maxLuma, mean);
            sampleCount++;

            String verdict;
            if (mean < 8) {
                verdict = "疑似全黑（FLAG_SECURE 或被遮挡）";
            } else if (dark * 100 / count > 90) {
                verdict = "几乎全黑";
            } else {
                verdict = "有画面";
            }

            String status = String.format(Locale.US,
                    "录屏 %s｜均值 %d｜范围 %d~%d｜样本 %d",
                    verdict, mean, minLuma, maxLuma, sampleCount);
            setStatus(status);
            Log.i(TAG, status);
        } catch (Exception error) {
            Log.w(TAG, "采样失败", error);
        } finally {
            if (image != null) image.close();
        }
    }

    // ------------------------------------------------------------ 收尾

    @Override
    public void onDestroy() {
        removeOverlay();
        if (virtualDisplay != null) {
            virtualDisplay.release();
            virtualDisplay = null;
        }
        if (imageReader != null) {
            imageReader.close();
            imageReader = null;
        }
        if (projection != null) {
            projection.stop();
            projection = null;
        }
        if (captureThread != null) {
            captureThread.quitSafely();
            captureThread = null;
        }
        if (foregroundStarted) {
            stopForeground(true);
            foregroundStarted = false;
        }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
