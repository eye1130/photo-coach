# android/ —— Android 壳工程

把线上 PWA 装进一个原生 WebView 外壳，产出一个可侧载安装的 APK。
**不含业务代码**，所有 UI / 相机 / 剪影逻辑仍在 `../src/` 里，改完部署网页即可，不需要重新出包。

---

## 为什么是 WebView 壳，不是 TWA

TWA（Trusted Web Activity）是标准做法，但它有一个硬门槛：想隐藏地址栏，必须通过
**Digital Asset Links** 验证 —— 验证文件得放在 `https://<站点>/.well-known/assetlinks.json`。

本项目的托管平台用 `?sharecode=XXX` 做访问凭证，**无凭证请求一律 403**（见 `../AGENTS.md` §9.3）。
Google 的验证器是设备侧直接发请求，带不上这个凭证，所以那个文件它永远读不到 →
验证失败 → TWA 退化成 Custom Tab，**顶部顶着一条浏览器地址栏**。

WebView 壳不依赖任何域名验证，100% 可控。代价是引擎性能略低于 Chrome，以及下面这些
「网页端做不到、必须原生补」的事。

---

## 原生层补的三件事

| 问题 | 网页端的表现 | 原生怎么补 |
| --- | --- | --- |
| 摄像头权限 | `getUserMedia` 被拒 | `WebChromeClient.onPermissionRequest` 授权 `RESOURCE_VIDEO_CAPTURE`，**同时** App 自身要持有 `CAMERA` 运行时权限（两者缺一不可） |
| 保存到相册 | `<a download>` 指向 `blob:`，**点了毫无反应** | JS 桥接 `PhotoCoachNative.saveImage(dataUrl, fileName)` → 写 `MediaStore`（Android 10+ 用 `IS_PENDING` 保证不写出半个文件） |
| 站外链接 | 会顶掉 App 本身 | `shouldOverrideUrlLoading` 判断 host，非本站交给系统浏览器 |

### 为什么保存不走 `setDownloadListener`

页面给的是 `blob:` URL，而 `DownloadListener` **不会为 `blob:` 触发**，拿到的是空链接。
所以必须由页面自己把 blob 读成 base64 交给原生 —— 对应实现见 `../src/ui.ts` 的
`nativeBridge()` / `saveViaBridge()`，以及 `MainActivity.NativeBridge`。

**桥接对象名 `PhotoCoachNative` 两端必须一致**，改任一侧记得同步另一侧。

---

## 本地构建

本机不需要 JDK / Android SDK —— **出包全部交给 CI**（见 `../.github/workflows/android.yml`）。

真要在本地跑，需要 JDK 17 + Android SDK（compileSdk 34），然后：

```bash
cd android
gradle :app:assembleDebug
# 产物：app/build/outputs/apk/debug/app-debug.apk
```

注意：本项目**不用 Gradle Wrapper**（仓库里没有 `gradle-wrapper.jar`，二进制不便 review），
所以本地必须自己装 Gradle ≥ 8.7。

## 出包流程

1. 推到 GitHub 的 `main` 分支（只改了 `android/**` 才会触发）
2. Actions → **Build Android APK** → 等绿
3. 页面底部 Artifacts 下载 `photo-coach-apk`
4. 手机上传安装（需允许「安装未知来源应用」）

也可以在 Actions 页面手动 **Run workflow** 强制出包。

## 签名

用 Android SDK 自带的 `debug.keystore`（别名 `androiddebugkey`，密码 `android`）。
它是随 SDK 分发的**公开**密钥，且跨机器内容一致 —— 所以：

- 仓库里不需要、也不应该放任何 keystore（`.gitignore` 已挡掉 `*.keystore` / `*.jks`）
- 每次 CI 出的包签名相同，**新版本可以直接覆盖安装**，不用先卸载

要上架应用商店时必须换成正式密钥，届时签名会变，用户需要卸载重装。

---

## 已知行为与限制

- **切后台会真正释放摄像头**：WebView 不像浏览器那样派发 `visibilitychange`，所以原生在
  `onPause` 里往页面派发 `photocoach:suspend`、`onResume` 里派发 `photocoach:resume`，
  由网页端（`../src/main.ts`）走与浏览器完全相同的释放/恢复逻辑。**事件名两端必须一致。**
  - 网页端为此新增了 `camera.releaseCamera()`（只停轨道、保留姿态模型），
    `resume()` 会在轨道已释放时自动重新取流。不走 `dispose()`，因为那会把 wasm 模型一起关掉。
- **首次启动要联网**：App 打开的是线上地址，`?sharecode=` 会种 30 天 cookie。
  Service Worker 生效后才有离线能力；第一次启动如果断网会看到「暂时打不开」。
- **不改 `start_url` 的 sharecode**：地址写死在 `app/build.gradle.kts` 的 `APP_URL`。
  换部署地址时三处同步：本文件、`public/manifest.webmanifest`、`AGENTS.md` §9.3。
- **竖屏锁定**：`AndroidManifest.xml` 的 `screenOrientation="portrait"`，与 PWA 一致。
- **不做 edge-to-edge**：系统栏保持可见、颜色刷成页面底色（`#05070A`）。一旦藏起来又没真正
  贴边，就会出现「顶部被状态栏压住」或「底部多一条黑边」，且 `env(safe-area-inset-*)` 的行为
  在两种布局下不一致。详见 `res/values/themes.xml` 的注释。
