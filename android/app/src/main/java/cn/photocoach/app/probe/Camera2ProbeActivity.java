package cn.photocoach.app.probe;

import android.app.Activity;
import android.content.Context;
import android.graphics.Color;
import android.graphics.ImageFormat;
import android.graphics.SurfaceTexture;
import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraDevice;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.CaptureRequest;
import android.hardware.camera2.params.StreamConfigurationMap;
import android.media.Image;
import android.media.ImageReader;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.util.Log;
import android.util.Size;
import android.view.Gravity;
import android.view.Surface;
import android.view.TextureView;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;

/**
 * 验证「自建预览 + 原生叠加」这条路的画质上限。
 *
 * <p>只用平台 Camera2 API，不引 androidx / CameraX —— 壳工程刻意零依赖，
 * 加一个 CameraX 会把整个构建链拖进来，而这里要验证的东西（预览 + 全分辨率
 * JPEG + 自己画的叠加层）平台 API 就够了。
 *
 * <p>看三件事：
 * <ul>
 *   <li>预览能不能直接显示（不经过 WebView，没有「黑屏 1~2 秒」的问题）</li>
 *   <li>叠加层能不能和预览对齐</li>
 *   <li>最大 JPEG 尺寸是多少 —— 这个数字直接决定「画质够不够」</li>
 * </ul>
 */
public class Camera2ProbeActivity extends Activity {

    private static final String TAG = "PhotoCoachProbe";

    private TextureView textureView;
    private GuideOverlayView overlayView;
    private TextView infoView;

    private CameraDevice cameraDevice;
    private CameraCaptureSession captureSession;
    private ImageReader stillReader;
    private HandlerThread bgThread;
    private Handler bgHandler;

    private String cameraId;
    private Size previewSize;
    private Size stillSize;
    private int sensorOrientation;
    private Surface previewSurface;

    private boolean opening;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(buildContentView());

        bgThread = new HandlerThread("camera2-probe");
        bgThread.start();
        bgHandler = new Handler(bgThread.getLooper());

        textureView.setSurfaceTextureListener(new TextureView.SurfaceTextureListener() {
            @Override
            public void onSurfaceTextureAvailable(SurfaceTexture surface, int width, int height) {
                openCamera();
            }

            @Override
            public void onSurfaceTextureSizeChanged(SurfaceTexture surface, int width, int height) {
            }

            @Override
            public boolean onSurfaceTextureDestroyed(SurfaceTexture surface) {
                return true;
            }

            @Override
            public void onSurfaceTextureUpdated(SurfaceTexture surface) {
            }
        });
    }

    private View buildContentView() {
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);

        textureView = new TextureView(this);
        root.addView(textureView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        overlayView = new GuideOverlayView(this);
        overlayView.setStatus("Camera2 预览启动中…");
        root.addView(overlayView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.VERTICAL);
        bar.setBackgroundColor(Color.argb(150, 0, 0, 0));
        int pad = dp(12);
        bar.setPadding(pad, pad, pad, pad);
        FrameLayout.LayoutParams barParams = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        barParams.gravity = Gravity.BOTTOM;
        root.addView(bar, barParams);

        infoView = new TextView(this);
        infoView.setTextColor(Color.rgb(0x6C, 0xE7, 0xFF));
        infoView.setTextSize(12f);
        infoView.setText("读取相机能力…");
        bar.addView(infoView);

        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        bar.addView(row);

        row.addView(barButton("拍一张（全分辨率）", v -> takePicture()));
        row.addView(barButton("返回", v -> finish()));

        return root;
    }

    private Button barButton(String text, View.OnClickListener listener) {
        Button b = new Button(this);
        b.setText(text);
        b.setAllCaps(false);
        b.setTextSize(12f);
        b.setOnClickListener(listener);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0,
                ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        b.setLayoutParams(lp);
        return b;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    // ------------------------------------------------------------ 打开相机

    private void openCamera() {
        if (opening) return;
        opening = true;
        try {
            CameraManager manager = (CameraManager) getSystemService(Context.CAMERA_SERVICE);
            if (manager == null) {
                fail("没有 CameraManager");
                return;
            }
            cameraId = pickBackCamera(manager);
            if (cameraId == null) {
                fail("没有找到后置摄像头");
                return;
            }

            CameraCharacteristics characteristics = manager.getCameraCharacteristics(cameraId);
            StreamConfigurationMap map =
                    characteristics.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
            if (map == null) {
                fail("拿不到 StreamConfigurationMap");
                return;
            }

            Size[] jpegSizes = map.getOutputSizes(ImageFormat.JPEG);
            Size[] previewSizes = map.getOutputSizes(SurfaceTexture.class);
            if (jpegSizes == null || jpegSizes.length == 0
                    || previewSizes == null || previewSizes.length == 0) {
                fail("相机没有可用的输出尺寸");
                return;
            }

            stillSize = biggest(jpegSizes);
            previewSize = choosePreview(previewSizes, 1920, 1080);
            Integer orientation = characteristics.get(CameraCharacteristics.SENSOR_ORIENTATION);
            sensorOrientation = orientation == null ? 90 : orientation;

            stillReader = ImageReader.newInstance(
                    stillSize.getWidth(), stillSize.getHeight(), ImageFormat.JPEG, 1);
            stillReader.setOnImageAvailableListener(this::onStillAvailable, bgHandler);

            if (checkSelfPermission(android.Manifest.permission.CAMERA)
                    != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                fail("没有相机权限");
                return;
            }
            manager.openCamera(cameraId, stateCallback, bgHandler);
        } catch (CameraAccessException | SecurityException error) {
            fail("打开相机失败：" + error.getClass().getSimpleName());
        }
    }

    private String pickBackCamera(CameraManager manager) throws CameraAccessException {
        String fallback = null;
        for (String id : manager.getCameraIdList()) {
            CameraCharacteristics c = manager.getCameraCharacteristics(id);
            Integer facing = c.get(CameraCharacteristics.LENS_FACING);
            if (facing != null && facing == CameraCharacteristics.LENS_FACING_BACK) {
                return id;
            }
            if (fallback == null) fallback = id;
        }
        return fallback;
    }

    private static Size biggest(Size[] sizes) {
        Size best = sizes[0];
        for (Size s : sizes) {
            if ((long) s.getWidth() * s.getHeight() > (long) best.getWidth() * best.getHeight()) {
                best = s;
            }
        }
        return best;
    }

    /** 取一个接近 16:9、面积不超过 1080p 的预览尺寸。 */
    private static Size choosePreview(Size[] sizes, int targetW, int targetH) {
        Size best = sizes[0];
        double bestScore = Double.MAX_VALUE;
        double targetArea = (double) targetW * targetH;
        for (Size s : sizes) {
            double longSide = Math.max(s.getWidth(), s.getHeight());
            double shortSide = Math.min(s.getWidth(), s.getHeight());
            double aspect = longSide / shortSide;
            double area = (double) s.getWidth() * s.getHeight();
            double score = Math.abs(aspect - 16.0 / 9.0) * 6
                    + Math.abs(Math.log(area / targetArea));
            if (score < bestScore) {
                bestScore = score;
                best = s;
            }
        }
        return best;
    }

    private final CameraDevice.StateCallback stateCallback = new CameraDevice.StateCallback() {
        @Override
        public void onOpened(CameraDevice camera) {
            cameraDevice = camera;
            createSession();
        }

        @Override
        public void onDisconnected(CameraDevice camera) {
            camera.close();
            cameraDevice = null;
        }

        @Override
        public void onError(CameraDevice camera, int error) {
            camera.close();
            cameraDevice = null;
            fail("相机错误码 " + error);
        }
    };

    private void createSession() {
        SurfaceTexture texture = textureView.getSurfaceTexture();
        if (texture == null || cameraDevice == null) return;
        texture.setDefaultBufferSize(previewSize.getWidth(), previewSize.getHeight());
        previewSurface = new Surface(texture);

        try {
            CaptureRequest.Builder builder =
                    cameraDevice.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW);
            builder.addTarget(previewSurface);
            builder.set(CaptureRequest.CONTROL_AF_MODE,
                    CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE);

            List<Surface> surfaces = new ArrayList<>(
                    Arrays.asList(previewSurface, stillReader.getSurface()));

            cameraDevice.createCaptureSession(surfaces,
                    new CameraCaptureSession.StateCallback() {
                        @Override
                        public void onConfigured(CameraCaptureSession session) {
                            captureSession = session;
                            try {
                                session.setRepeatingRequest(builder.build(), null, bgHandler);
                                reportReady(true);
                            } catch (CameraAccessException error) {
                                fail("启动预览失败：" + error.getClass().getSimpleName());
                            }
                        }

                        @Override
                        public void onConfigureFailed(CameraCaptureSession session) {
                            // 预览 + 全分辨率 JPEG 一起配，个别机型会失败。
                            // 退化成只预览，至少证明预览这条路是通的。
                            fail("会话配置失败（预览+JPEG 组合不被支持），退化为仅预览");
                            createPreviewOnlySession();
                        }
                    }, bgHandler);
        } catch (CameraAccessException error) {
            fail("创建会话失败：" + error.getClass().getSimpleName());
        }
    }

    private void createPreviewOnlySession() {
        if (cameraDevice == null || previewSurface == null) return;
        try {
            CaptureRequest.Builder builder =
                    cameraDevice.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW);
            builder.addTarget(previewSurface);
            cameraDevice.createCaptureSession(
                    java.util.Collections.singletonList(previewSurface),
                    new CameraCaptureSession.StateCallback() {
                        @Override
                        public void onConfigured(CameraCaptureSession session) {
                            captureSession = session;
                            try {
                                session.setRepeatingRequest(builder.build(), null, bgHandler);
                                reportReady(false);
                            } catch (CameraAccessException error) {
                                fail("仅预览也失败了");
                            }
                        }

                        @Override
                        public void onConfigureFailed(CameraCaptureSession session) {
                            fail("仅预览也配置失败");
                        }
                    }, bgHandler);
        } catch (CameraAccessException error) {
            fail("退化会话失败");
        }
    }

    private void reportReady(boolean canCapture) {
        String text = String.format(Locale.US,
                "预览 %d×%d｜最大 JPEG %d×%d（%.1fMP）%s",
                previewSize.getWidth(), previewSize.getHeight(),
                stillSize.getWidth(), stillSize.getHeight(),
                stillSize.getWidth() * stillSize.getHeight() / 1_000_000f,
                canCapture ? "" : "｜本机不支持预览+拍照组合");
        runOnUiThread(() -> {
            infoView.setText(text);
            overlayView.setStatus("Camera2 自建预览｜叠加层正常");
        });
    }

    // ------------------------------------------------------------ 拍照

    private void takePicture() {
        if (captureSession == null || cameraDevice == null) {
            toast("预览还没起来");
            return;
        }
        try {
            CaptureRequest.Builder builder =
                    cameraDevice.createCaptureRequest(CameraDevice.TEMPLATE_STILL_CAPTURE);
            builder.addTarget(stillReader.getSurface());
            builder.set(CaptureRequest.CONTROL_AF_MODE,
                    CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE);
            // Activity 锁竖屏，所以直接用传感器方向即可
            builder.set(CaptureRequest.JPEG_ORIENTATION, sensorOrientation);
            captureSession.capture(builder.build(), null, bgHandler);
            toast("正在拍摄…");
        } catch (CameraAccessException error) {
            toast("拍照失败：" + error.getClass().getSimpleName());
        }
    }

    private void onStillAvailable(ImageReader reader) {
        Image image = null;
        try {
            image = reader.acquireLatestImage();
            if (image == null) return;
            ByteBuffer buffer = image.getPlanes()[0].getBuffer();
            byte[] bytes = new byte[buffer.remaining()];
            buffer.get(bytes);

            File dir = getExternalFilesDir("probe");
            if (dir != null && !dir.exists()) dir.mkdirs();
            File file = new File(dir, "camera2-" + System.currentTimeMillis() + ".jpg");
            try (OutputStream out = new FileOutputStream(file)) {
                out.write(bytes);
            }

            int width = image.getWidth();
            int height = image.getHeight();
            String text = String.format(Locale.US,
                    "已存 %d×%d（%.1f MB）\n%s",
                    width, height, bytes.length / 1024f / 1024f, file.getAbsolutePath());
            Log.i(TAG, text);
            runOnUiThread(() -> {
                infoView.setText(text);
                toast("拍好了：" + width + "×" + height);
            });
        } catch (Exception error) {
            Log.w(TAG, "保存照片失败", error);
            runOnUiThread(() -> toast("保存失败"));
        } finally {
            if (image != null) image.close();
        }
    }

    // ------------------------------------------------------------ 生命周期

    @Override
    protected void onPause() {
        closeCamera();
        super.onPause();
    }

    private void closeCamera() {
        opening = false;
        if (captureSession != null) {
            captureSession.close();
            captureSession = null;
        }
        if (cameraDevice != null) {
            cameraDevice.close();
            cameraDevice = null;
        }
        if (stillReader != null) {
            stillReader.close();
            stillReader = null;
        }
        if (previewSurface != null) {
            previewSurface.release();
            previewSurface = null;
        }
    }

    @Override
    protected void onDestroy() {
        closeCamera();
        if (bgThread != null) {
            bgThread.quitSafely();
            bgThread = null;
        }
        super.onDestroy();
    }

    private void fail(String message) {
        Log.w(TAG, message);
        runOnUiThread(() -> {
            if (overlayView != null) overlayView.setStatus(message);
            if (infoView != null) infoView.setText(message);
        });
    }

    private void toast(String message) {
        android.widget.Toast.makeText(this, message, android.widget.Toast.LENGTH_SHORT).show();
    }
}
