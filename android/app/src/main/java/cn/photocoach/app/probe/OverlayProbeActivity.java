package cn.photocoach.app.probe;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.media.projection.MediaProjectionManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.MediaStore;
import android.provider.Settings;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

/**
 * 验证入口（独立 launcher，不影响 {@link cn.photocoach.app.MainActivity}）。
 *
 * <p>四个按钮对应四个待验证的问题：
 * <ol>
 *   <li>能不能在系统相机上面画东西 → 悬浮窗</li>
 *   <li>能不能读到系统相机的画面 → 录屏采样（看浮层上的状态行是不是「全黑」）</li>
 *   <li>自建相机能拿到多大分辨率 → Camera2 预览 + 最大 JPEG</li>
 *   <li>系统相机长什么样 → 直接跳过去</li>
 * </ol>
 */
public class OverlayProbeActivity extends Activity {

    private static final String TAG = "PhotoCoachProbe";

    private static final int REQUEST_OVERLAY = 2001;
    private static final int REQUEST_PROJECTION = 2002;
    private static final int REQUEST_CAMERA = 2003;

    private TextView logView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(buildContentView());
    }

    private View buildContentView() {
        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(Color.rgb(0x05, 0x07, 0x0A));

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(20);
        root.setPadding(pad, dp(32), pad, pad);
        scroll.addView(root, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        TextView title = new TextView(this);
        title.setText("原生叠加 · 可行性验证");
        title.setTextColor(Color.rgb(0xE8, 0xF0, 0xF5));
        title.setTextSize(20f);
        root.addView(title);

        TextView desc = new TextView(this);
        desc.setText("用来验证两件事：① 指导层能不能盖在系统相机上；② 盖上去之后能不能读到画面。"
                + "\n\n建议顺序：先点 1，再点 2，然后按 Home 切到系统相机，观察浮层顶部那行状态。"
                + "如果一直显示「疑似全黑」，说明这台机器的系统相机预览禁止录屏。");
        desc.setTextColor(Color.rgb(0x8F, 0xA3, 0xB0));
        desc.setTextSize(13f);
        desc.setPadding(0, dp(10), 0, dp(18));
        root.addView(desc);

        root.addView(button("1. 显示指导浮层（需要「显示在其他应用上层」）", v -> requestOverlay()));
        root.addView(button("2. 开始录屏采样（每次都要点系统弹窗同意）", v -> requestProjection()));
        root.addView(button("3. 打开 Camera2 自建预览 + 叠加", v -> openCamera2Probe()));
        root.addView(button("4. 打开系统相机（对照用）", v -> openSystemCamera()));
        root.addView(button("停止浮层与录屏", v -> requestStop(
                new Intent(this, ProbeOverlayService.class).setAction(ProbeOverlayService.ACTION_STOP))));

        logView = new TextView(this);
        logView.setTextColor(Color.rgb(0x6C, 0xE7, 0xFF));
        logView.setTextSize(12f);
        logView.setPadding(0, dp(20), 0, 0);
        logView.setText("等待操作…");
        root.addView(logView);

        return scroll;
    }

    private Button button(String text, View.OnClickListener listener) {
        Button b = new Button(this);
        b.setText(text);
        b.setAllCaps(false);
        b.setTextSize(13f);
        b.setGravity(Gravity.START | Gravity.CENTER_VERTICAL);
        b.setOnClickListener(listener);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.bottomMargin = dp(8);
        b.setLayoutParams(lp);
        return b;
    }

    // ------------------------------------------------------------ 1. 悬浮窗

    private void requestOverlay() {
        if (Settings.canDrawOverlays(this)) {
            startOverlayOnly();
            return;
        }
        log("去系统设置里开「显示在其他应用上层」…");
        Intent intent = new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                Uri.parse("package:" + getPackageName()));
        try {
            startActivityForResult(intent, REQUEST_OVERLAY);
        } catch (Exception error) {
            log("打不开悬浮窗设置页：" + error.getClass().getSimpleName());
        }
    }

    private void startOverlayOnly() {
        startService(new Intent(this, ProbeOverlayService.class)
                .setAction(ProbeOverlayService.ACTION_SHOW));
        log("浮层已请求。按 Home 键回到桌面/系统相机，看它是不是还在最上层。");
    }

    // ------------------------------------------------------------ 2. 录屏

    private void requestProjection() {
        if (!Settings.canDrawOverlays(this)) {
            log("先给悬浮窗权限，否则录屏结果没有地方显示。");
            requestOverlay();
            return;
        }
        MediaProjectionManager manager =
                (MediaProjectionManager) getSystemService(MEDIA_PROJECTION_SERVICE);
        if (manager == null) {
            log("这台设备没有 MediaProjectionManager");
            return;
        }
        startActivityForResult(manager.createScreenCaptureIntent(), REQUEST_PROJECTION);
    }

    // ------------------------------------------------------------ 3/4. 相机

    private void openCamera2Probe() {
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.CAMERA}, REQUEST_CAMERA);
            return;
        }
        startActivity(new Intent(this, Camera2ProbeActivity.class));
    }

    private void openSystemCamera() {
        try {
            startActivity(new Intent(MediaStore.INTENT_ACTION_STILL_IMAGE_CAMERA));
        } catch (Exception error) {
            log("没有可用的系统相机：" + error.getClass().getSimpleName());
        }
    }

    // ------------------------------------------------------------ 回调

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQUEST_OVERLAY) {
            if (Settings.canDrawOverlays(this)) {
                log("悬浮窗权限已授予");
                startOverlayOnly();
            } else {
                log("悬浮窗权限被拒绝 —— 这条路在这台机器上直接走不通");
            }
            return;
        }
        if (requestCode == REQUEST_PROJECTION) {
            if (resultCode != RESULT_OK || data == null) {
                log("录屏授权被拒绝");
                return;
            }
            Intent intent = new Intent(this, ProbeOverlayService.class)
                    .setAction(ProbeOverlayService.ACTION_SHOW)
                    .putExtra(ProbeOverlayService.EXTRA_RESULT_CODE, resultCode)
                    .putExtra(ProbeOverlayService.EXTRA_RESULT_DATA, data);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(intent);
            } else {
                startService(intent);
            }
            log("录屏已启动。现在切到系统相机，浮层顶部会显示「有画面」或「疑似全黑」。");
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQUEST_CAMERA) return;
        if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
            openCamera2Probe();
        } else {
            log("相机权限被拒绝");
        }
    }

    private void requestStop(Intent intent) {
        try {
            startService(intent);
            log("已请求停止");
        } catch (Exception error) {
            Log.w(TAG, "停止服务失败", error);
            Toast.makeText(this, "停止失败", Toast.LENGTH_SHORT).show();
        }
    }

    private void log(String message) {
        Log.i(TAG, message);
        if (logView != null) logView.setText(message);
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
