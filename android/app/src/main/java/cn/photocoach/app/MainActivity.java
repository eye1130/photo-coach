package cn.photocoach.app;

import android.Manifest;
import android.app.Activity;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.ConsoleMessage;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.util.Locale;

/**
 * 唯一的 Activity：一个全屏 WebView 加载线上 PWA。
 *
 * 为什么是 WebView 壳而不是 TWA：
 *   TWA 想隐藏地址栏必须通过 Digital Asset Links 验证，验证文件要放在
 *   https://<站点>/.well-known/assetlinks.json。本项目的托管平台用 `?sharecode=`
 *   做访问凭证，无凭证请求一律 403，Google 的验证器拿不到那个文件，
 *   结果就是「装上了但顶着一条地址栏」。WebView 壳不依赖任何域名验证。
 *
 * 原生层必须补的三件事（网页端做不到）：
 *   1. 摄像头权限 —— WebView 的 getUserMedia 走 onPermissionRequest，
 *      而它 grant 之后系统仍然要求 App 持有 CAMERA 运行时权限。
 *   2. 保存到相册 —— 网页端是 `<a download>` 指向 blob: URL，WebView 不处理
 *      download，点击毫无反应。这里用 JS 桥接把 base64 传过来写进 MediaStore。
 *   3. 外部链接 —— 页面里若出现站外链接，不能顶掉 App 本身，交给系统浏览器。
 */
public class MainActivity extends Activity {

    private static final String TAG = "PhotoCoach";

    /** 线上地址（含 sharecode）。与 app/build.gradle.kts 的 APP_URL 同源，改一处即可。 */
    private static final String START_URL = BuildConfig.APP_URL;

    /** 允许在 WebView 内打开的 host。其余一律交给系统浏览器。 */
    private static final String APP_HOST = "photo-coach-01631.app.workbuddy.host";

    /** 相册里的子目录名 */
    private static final String GALLERY_FOLDER = "拍照指导";

    private static final int REQUEST_CAMERA = 1001;
    private static final int REQUEST_STORAGE = 1002;

    private WebView webView;
    private View errorView;

    /** 网页发来、但因为 App 还没拿到系统权限而暂存的摄像头请求 */
    private PermissionRequest pendingWebPermission;

    // ------------------------------------------------------------ 生命周期

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        createContentView();
        configureWebView();
        webView.loadUrl(START_URL);
        ensureCameraPermission();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView == null) return;
        webView.onResume();
        webView.resumeTimers();
        // onPause 里停掉了摄像头轨道（见下），这里必须重载页面才能重新拿到画面。
        // 不重载的话页面会停在一帧静止的旧画面上，看起来像卡死。
        webView.loadUrl(START_URL);
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (webView == null) return;
        // 主动停掉摄像头：WebView 不像浏览器那样会派发 visibilitychange，
        // 不管的话退到后台相机还在取流，耗电且指示灯常亮。
        webView.evaluateJavascript(
                "(function(){try{var v=document.getElementById('camera');"
                        + "if(v&&v.srcObject){v.srcObject.getTracks().forEach(function(t){t.stop()});"
                        + "v.srcObject=null;}}catch(e){}return 1;})()",
                null);
        webView.onPause();
        webView.pauseTimers();
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.removeJavascriptInterface("PhotoCoachNative");
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        // 页面内有历史就回退，否则才是退出 App
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        super.onBackPressed();
    }

    // ------------------------------------------------------------ 视图

    private void createContentView() {
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.rgb(0x05, 0x07, 0x0A));

        webView = new WebView(this);
        webView.setBackgroundColor(Color.rgb(0x05, 0x07, 0x0A));
        root.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        errorView = buildErrorView();
        errorView.setVisibility(View.GONE);
        root.addView(errorView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        setContentView(root);
    }

    /**
     * 加载失败时盖在 WebView 上的一层原生视图。
     *
     * 刻意不用 loadDataWithBaseURL 塞一个 HTML 错误页：那会让 onPageStarted /
     * onPageFinished 收到一次「看起来正常」的回调，错误状态和真实状态互相覆盖，
     * 很容易写出「错误页自己触发错误页」的死循环。原生 View 没有这个问题。
     */
    private View buildErrorView() {
        LinearLayout container = new LinearLayout(this);
        container.setOrientation(LinearLayout.VERTICAL);
        container.setGravity(Gravity.CENTER);
        container.setBackgroundColor(Color.rgb(0x05, 0x07, 0x0A));
        int pad = dp(28);
        container.setPadding(pad, pad, pad, pad);

        TextView title = new TextView(this);
        title.setText("暂时打不开");
        title.setTextColor(Color.rgb(0xE8, 0xF0, 0xF5));
        title.setTextSize(18f);
        title.setGravity(Gravity.CENTER);

        TextView body = new TextView(this);
        body.setText("检查一下网络，或者稍后再试。\n如果是刚更新过版本，重试一次通常就好了。");
        body.setTextColor(Color.rgb(0x8F, 0xA3, 0xB0));
        body.setTextSize(14f);
        body.setGravity(Gravity.CENTER);
        body.setPadding(0, dp(10), 0, dp(22));

        Button retry = new Button(this);
        retry.setText("重试");
        retry.setAllCaps(false);
        retry.setOnClickListener(v -> {
            errorView.setVisibility(View.GONE);
            webView.loadUrl(START_URL);
        });

        container.addView(title);
        container.addView(body);
        container.addView(retry);
        return container;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private void showError() {
        if (errorView != null) errorView.setVisibility(View.VISIBLE);
    }

    // ------------------------------------------------------------ WebView 配置

    private void configureWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        // 页面里的 <video> 是静音自动播放，但保险起见别让「需要用户手势」卡住它
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        // 页面靠 UA 里的这个标记判断「跑在壳里」，从而把保存走原生桥接。
        // 见 src/ui.ts 的 nativeBridge()。
        settings.setUserAgentString(
                settings.getUserAgentString() + " PhotoCoachApp/" + BuildConfig.VERSION_NAME);

        // sharecode 是以 Set-Cookie 形式下发的，Cookie 必须放行
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (isInternal(uri)) return false;
                openExternally(uri);
                return true;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (!request.isForMainFrame()) return;
                Log.w(TAG, "主文档加载失败：" + error.getDescription());
                showError();
            }

            @Override
            public void onReceivedHttpError(WebView view, WebResourceRequest request,
                                            WebResourceResponse response) {
                if (!request.isForMainFrame()) return;
                // 典型场景：sharecode 失效导致整站 403
                if (response.getStatusCode() >= 400) {
                    Log.w(TAG, "主文档 HTTP " + response.getStatusCode());
                    showError();
                }
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(() -> handleWebPermissionRequest(request));
            }

            @Override
            public boolean onConsoleMessage(ConsoleMessage message) {
                Log.d(TAG, "[web] " + message.message() + " @" + message.lineNumber());
                return true;
            }
        });

        webView.addJavascriptInterface(new NativeBridge(), "PhotoCoachNative");
    }

    private boolean isInternal(Uri uri) {
        if (uri == null) return false;
        String scheme = uri.getScheme();
        if (scheme == null) return false;
        if (!scheme.equals("https") && !scheme.equals("http")) return false;
        String host = uri.getHost();
        if (host == null) return false;
        return host.equals(APP_HOST) || host.endsWith(".workbuddy.host");
    }

    private void openExternally(Uri uri) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (Exception error) {
            Log.w(TAG, "无法用外部应用打开链接：" + uri, error);
            toast("没有可以打开这个链接的应用");
        }
    }

    // ------------------------------------------------------------ 摄像头权限

    private void handleWebPermissionRequest(PermissionRequest request) {
        boolean wantsVideo = false;
        for (String resource : request.getResources()) {
            if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) {
                wantsVideo = true;
            }
        }
        if (!wantsVideo) {
            // 页面只要摄像头，不要麦克风；其它资源一律拒绝
            request.deny();
            return;
        }
        if (hasPermission(Manifest.permission.CAMERA)) {
            request.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE});
            return;
        }
        // 系统权限还没给：先存着，等用户授权回来再补发
        pendingWebPermission = request;
        ensureCameraPermission();
    }

    private boolean hasPermission(String permission) {
        return checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED;
    }

    private void ensureCameraPermission() {
        if (hasPermission(Manifest.permission.CAMERA)) return;
        requestPermissions(new String[]{Manifest.permission.CAMERA}, REQUEST_CAMERA);
    }

    /** Android 9 及以下写公共 Pictures 目录需要存储权限；10 起走 MediaStore 不需要。 */
    private boolean needsLegacyStoragePermission() {
        return Build.VERSION.SDK_INT <= Build.VERSION_CODES.P
                && !hasPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQUEST_CAMERA) return;

        boolean granted = grantResults.length > 0
                && grantResults[0] == PackageManager.PERMISSION_GRANTED;

        if (granted) {
            if (pendingWebPermission != null) {
                pendingWebPermission.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE});
                pendingWebPermission = null;
            }
            return;
        }

        if (pendingWebPermission != null) {
            pendingWebPermission.deny();
            pendingWebPermission = null;
        }
        toast("没有相机权限，App 无法开启摄像头");
    }

    // ------------------------------------------------------------ JS 桥接

    /**
     * 暴露给页面的原生能力。名字必须与 src/ui.ts 里的 `PhotoCoachNative` 一致。
     *
     * 注意：`@JavascriptInterface` 标注的方法运行在 WebView 的 JavaBridge 线程，
     * 不是主线程 —— 所以这里能放心做文件 IO，但弹 Toast 必须切回主线程。
     */
    private class NativeBridge {

        @JavascriptInterface
        public void saveImage(String dataUrl, String fileName) {
            if (dataUrl == null || !dataUrl.startsWith("data:")) {
                toastOnUi("保存失败：图片数据无效");
                return;
            }
            int comma = dataUrl.indexOf(',');
            if (comma < 0) {
                toastOnUi("保存失败：图片数据无效");
                return;
            }
            String meta = dataUrl.substring(0, comma);
            if (!meta.contains("base64")) {
                toastOnUi("保存失败：图片编码不支持");
                return;
            }
            byte[] bytes;
            try {
                bytes = Base64.decode(dataUrl.substring(comma + 1), Base64.DEFAULT);
            } catch (IllegalArgumentException error) {
                toastOnUi("保存失败：图片解码出错");
                return;
            }

            if (needsLegacyStoragePermission()) {
                // 老系统上先要一次权限，用户授权后重按保存即可
                runOnUiThread(() -> requestPermissions(
                        new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE}, REQUEST_STORAGE));
                toastOnUi("请允许存储权限后再点一次保存");
                return;
            }

            try {
                Uri saved = writeToGallery(bytes, sanitizeFileName(fileName));
                toastOnUi(saved != null ? "已保存到相册" : "保存失败");
            } catch (Exception error) {
                Log.w(TAG, "保存照片失败", error);
                toastOnUi("保存失败：" + error.getClass().getSimpleName());
            }
        }
    }

    /**
     * 写进系统相册。
     *
     * Android 10+ 走 MediaStore + IS_PENDING：先把文件标成「写入中」，写完再置 0，
     * 这样相册不会读到半个文件。
     */
    private Uri writeToGallery(byte[] bytes, String fileName) throws Exception {
        ContentResolver resolver = getContentResolver();

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ContentValues values = new ContentValues();
            values.put(MediaStore.Images.Media.DISPLAY_NAME, fileName);
            values.put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg");
            values.put(MediaStore.Images.Media.RELATIVE_PATH,
                    Environment.DIRECTORY_PICTURES + File.separator + GALLERY_FOLDER);
            values.put(MediaStore.Images.Media.IS_PENDING, 1);

            Uri uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
            if (uri == null) return null;

            try (OutputStream out = resolver.openOutputStream(uri)) {
                if (out == null) throw new IllegalStateException("无法写入相册");
                out.write(bytes);
                out.flush();
            }

            ContentValues done = new ContentValues();
            done.put(MediaStore.Images.Media.IS_PENDING, 0);
            resolver.update(uri, done, null, null);
            return uri;
        }

        File dir = new File(Environment.getExternalStoragePublicDirectory(
                Environment.DIRECTORY_PICTURES), GALLERY_FOLDER);
        if (!dir.exists() && !dir.mkdirs()) {
            throw new IllegalStateException("无法创建相册目录");
        }
        File file = new File(dir, fileName);
        try (OutputStream out = new FileOutputStream(file)) {
            out.write(bytes);
            out.flush();
        }
        sendBroadcast(new Intent(Intent.ACTION_MEDIA_SCANNER_SCAN_FILE, Uri.fromFile(file)));
        return Uri.fromFile(file);
    }

    /** 文件名来自网页，必须清洗：去掉路径分隔符与控制字符，限制长度，补 .jpg 后缀。 */
    private static String sanitizeFileName(String name) {
        String base = (name == null || name.trim().isEmpty()) ? "photo.jpg" : name.trim();
        base = base.replaceAll("[\\\\/:*?\"<>|\\r\\n\\t]", "_");
        String lower = base.toLowerCase(Locale.ROOT);
        if (!lower.endsWith(".jpg") && !lower.endsWith(".jpeg")) {
            base = base + ".jpg";
        }
        if (base.length() > 80) {
            int dot = base.lastIndexOf('.');
            String ext = dot > 0 ? base.substring(dot) : ".jpg";
            base = base.substring(0, 80 - ext.length()) + ext;
        }
        return base;
    }

    private void toastOnUi(final String message) {
        runOnUiThread(() -> toast(message));
    }

    private void toast(String message) {
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show();
    }
}
