# AGENTS.md — 拍照指导（Photo Coach）

> **这是工程约定文档，给接手开发的人 / Agent 看。**
> `README.md` 是产品说明（部分是早期写的，剪影数量等已过时）；两者冲突时**以本文为准**。
> 最后更新：2026-10-22

---

## 0. 60 秒上手

**一句话**：打开摄像头，把姿势剪影 + 构图提示实时叠在取景画面上，解决「帮人拍照时不会指导姿势、不会构图」。

**当前状态**

| 项 | 状态 |
| --- | --- |
| 姿势库 | 27 个 / 3 个场景（街拍·室内·户外） |
| 剪影素材 | **20 个**有真实线稿素材，7 个走程序化几何人形兜底 |
| 形态 | PWA（可添加到手机主屏，全屏独立窗口，离线可用） |
| Android APK | WebView 壳（`android/`），GitHub Actions 云端出包，见 §14 |
| 线上地址 | `https://2e6d73676aed42759e5e88229b9d0269.sg.agentos-app.run`（**每次部署都会变，见 §14.8**） |
| Service Worker | `VERSION = 'v3'` |

**立刻能跑**

```bash
npm install
npm run dev          # http://localhost:5173（localhost 是安全上下文，能调摄像头）
npm run build        # tsc --noEmit + vite build → dist/
```

**四条红线（违反了会出事）**

1. **不许改 `public/mp/`** 下任何文件。18MB MediaPipe 运行时，动一个字节模型就加载不出来。
2. **不许改 `public/manifest.webmanifest` 里的 `start_url`**（它带着 `?sharecode=`）。原因见 §9.3，改错会让用户点桌面图标白屏。
3. **不许把导航请求（`request.mode === 'navigate'`）改成 cache-first**。否则发版后用户永远拿不到新版本。
4. **加姿势必须同时改两处**：`src/silhouette.ts` 的 `SILHOUETTE_GEOM` **和** `public/sw.js` 的 `SIL_ASSETS`。漏第二处 = 「联网能看、离线没有」。见 §8。

**改完必须跑的验证**

```bash
node node_modules/typescript/bin/tsc --noEmit
node node_modules/vite/bin/vite.js build
node .probe/smoke-dist.mjs        # 冒烟：素材数量、三个姿势能渲染、0 报错
```

动了 `sw.js` / manifest / PWA 相关，还要加跑 `.probe/pwa-check.mjs`（见 §10）。

---

## 1. 产品与形态

**不是悬浮窗。** 安卓系统级悬浮窗拿不到系统相机画面，iOS 禁止，技术上不成立。所以做的是**自建全屏相机界面**，所有指导叠加在自己的取景画面上，使用体验与「悬浮」一致。

**核心用法**（用户原话）：
> 我直接把镜头推前推后，卡住主角的脸和身体轮廓，还可以指挥女生如何摆放姿势卡进去轮廓里面。

所以剪影是**参考线**，不是装饰。它必须能准确套住真人——这是整个项目所有标定工作的意义所在。

---

## 2. 环境与命令

**平台**：Windows + Git Bash。路径含中文（`J:\project\拍照指导`），写脚本时注意编码。

**`npx` 不可用** —— 会唤起 `wsl.exe`，被沙箱安全策略拦掉。所有命令走 `<node> node_modules/<pkg>/bin/<entry>`：

```bash
NODE="C:/Users/张超office/.workbuddy/binaries/node/versions/22.22.2-6/node.exe"
PY="C:/Users/张超office/.workbuddy/binaries/python/envs/default/Scripts/python.exe"

"$NODE" node_modules/typescript/bin/tsc --noEmit
"$NODE" node_modules/vite/bin/vite.js build
"$NODE" node_modules/vite/bin/vite.js              # dev
```

**端口约定**

| 端口 | 用途 | 备注 |
| --- | --- | --- |
| 5173 | `npm run dev` | 项目默认 |
| 4173 | `vite preview` 默认 | |
| 5200 | 常驻的 `dist` 预览服务 | **别人在用，不要占** |
| 5xxx | 探针自建的静态服务器 | 用完自己关掉 |

**注意**：`5200` 是 `vite preview`（服务 `dist/`），**不是 dev server**。改源码后不重新 build，直接访问它看到的还是旧代码。curl `/src/xxx.ts` 返回的是 index.html，别被这个骗了。

**Python 依赖**（素材处理链路用）：`opencv-python`、`numpy`、`Pillow`，装在 `.workbuddy` 的 venv 里，用 `$PY` 调用。

---

## 3. 目录与文件职责

```
index.html              首屏 DOM + <script src="./mp/pose.js">（解析期加载，必须是普通 script）
vite.config.ts          dev / dev:https 两套；base: './'
tsconfig.json

src/main.ts             装配入口：状态机(idle→loading→ready→error)、提示调度与节流、拍照、设备方向
src/camera.ts           getUserMedia、帧循环(rAF)、防重入 pose.send、帧率统计、拍照裁切
src/poseEngine.ts       角度计算、cover 坐标映射、指数平滑、人体框、头高单位
src/poseLibrary.ts      27 个姿势的参数化定义（只给手腕/踝目标点，肘膝由 IK 反解）
src/posture.ts          姿势库导出 + 偏差检测（角度/位置/跨度三类规则）
src/silhouette.ts       ★ 剪影素材管理 + 五步标定对齐（20 个有素材姿势）
src/figure.ts           程序化几何人形（7 个无素材姿势的兜底）
src/framing.ts          构图规则（优先级 1~6）+ 水平仪判定
src/overlay.ts          canvas 绘制：网格/剪影/骨骼/水平仪/提示气泡
src/ui.ts               控件绑定：首屏遮罩、开关组、场景 Tab、姿势条、快门、预览
src/pwa.ts              Service Worker 注册 + 新版本提示
src/types.ts            共用类型
src/style.css           暗色相机 UI（含 safe-area）

public/mp/              MediaPipe Pose 运行时 + lite 模型（18MB，勿动）
public/sil/             20 张线稿剪影 PNG（共 932KB）
public/icons/           PWA 图标 5 个（由 .probe/make_icons.py 生成）
public/manifest.webmanifest
public/sw.js            手写 Service Worker

android/                Android WebView 壳（独立 Gradle 工程，不含业务代码）
  app/src/main/java/cn/photocoach/app/MainActivity.java   唯一的 Activity
  app/src/main/res/     mipmap 图标由 .probe/make_android_icons.py 生成
.github/workflows/android.yml   CI：出 APK + 网页端构建校验

.probe/                 全部是探针/素材工具脚本，不参与构建
```

---

## 4. 一帧的生命周期

```
camera.ts 的 rAF 循环
  ├─ 每 2 帧 + 最小间隔 55ms 才送一次模型（降频）
  ├─ 上一帧 pose.send() 未 resolve 就跳过本帧（防重入，否则内存暴涨）
  └─ pose.onResults → 坐标映射(cover) → LandmarkSmoother 平滑 → camera.landmarks
        ↓
main.ts renderFrame()（每帧）
  ├─ sampleHint()      构图规则 1~6 + 姿势偏差 7，同一时刻只留一条，节流
  └─ overlay.render()  网格 / 剪影 / 骨骼 / 水平仪 / 气泡
        ↓
overlay.ts 按 showSilhouette 分流
  ├─ 有素材 → silhouette.drawSilhouetteImage()
  │             ├─ 检测到人 → drawAligned()   五步标定，贴着真人画
  │             └─ 没人     → drawDefault()   固定占位（脚底 0.80 画高、身高 0.62 画高）
  └─ 没素材/加载失败 → figure.drawFigure()    程序化几何人形
```

**提示优先级**（`framing.ts` 的 `FRAMING` 常量，顺序不可换）：
`脚出画 1 → 头顶太挤 2 → 人太小 3 → 人物高度占比 4 → 左右偏移 5 → 手机歪 6 → 姿势偏差 7`

节流规则在 `main.ts` 的 `sampleHint()`：同条提示 3 秒内不重复；条件持续成立时气泡保持；消失后停留 1.2 秒淡出；同一条连续成立超 6 秒让位给其它提示（避免「人偏左」把姿势提示永久饿死）。

---

## 5. 坐标系统（最容易踩坑的地方）

存在三套坐标，转换必须走 `poseEngine.computeCoverMapping`：

1. **归一化坐标**（0~1）：MediaPipe 原始输出，相对 video 的**实际分辨率**。
2. **画面坐标**（CSS px）：canvas 绘制用。
3. **模板坐标**：姿势库内部用，原点=鼻尖、y 向下、单位=头高。

`video` 用 `object-fit: cover` 铺满容器，画面被裁切过，所以归一化坐标**不能直接乘 canvas 尺寸**：

```ts
scale = max(cw / vw, ch / vh)      // cw,ch = 容器显示尺寸；vw,vh = video 实际分辨率
dw = vw * scale;  dh = vh * scale
ox = (cw - dw) / 2;  oy = (ch - dh) / 2
x = lm.x * dw + ox;  y = lm.y * dh + oy
```

canvas 的 `width/height` 按 `devicePixelRatio` 放大（上限 2.5），绘制前 `ctx.scale(dpr, dpr)`，**绘制坐标统一用 CSS px**。

---

## 6. 姿势模板 = 剪影和偏差检测共用的单一数据源

```ts
type PoseTemplate = {
  id: string; name: string;
  scene: 'street' | 'cafe' | 'outdoor';
  turn?: number;                                 // 侧身程度，影响 IK
  wristL/wristR/kneeL/kneeR/ankleL/ankleR: [x, y]; // 目标点，肘膝由 IK 反解
  angles?:    { a; b; c; target; tol; hint }[];  // 三点夹角（b 为顶点）
  positions?: { point; target; tol; hint }[];    // 关键点位置
  spans?:     { a; b; target; tol; hint }[];     // 两点跨度（识别侧身）
};
```

**为什么用「头高」作单位**：原点=鼻尖，单位=鼻尖到两肩中点的距离。这样与分辨率、人物远近完全解耦，同一个人走近走远都不用改阈值。

**关键不变量**：`headUnitPx(points)` 是唯一的单位来源，`figure.ts`、`silhouette.ts`、`posture.ts` 都用它。
**不要**给 x、y 分别乘不同系数——曾经有人这么干，剪影看起来「被横向拉伸」，实际根因是头部椭圆半径和线宽两个标定量写错了（真人头只有 0.57 头高，当时按 1.0 画）。

---

## 7. 剪影渲染

### 7.1 两种渲染模式

| 模式 | 触发条件 | 实现 |
| --- | --- | --- |
| 线稿剪影 | 该姿势在 `SILHOUETTE_GEOM` 里有记录 **且** PNG 加载成功 | `silhouette.ts` |
| 几何人形 | 没有素材 / 素材加载失败 / `refH <= 0` / 关键点退化 | `figure.ts` |

三层 fallback 必须都保留。少任何一层，个别姿势就会整块消失或画出鬼影。

### 7.2 五步标定（`drawAligned`，顺序不可换）

```ts
1. 身高   bodyH  = (landmark 的 y 跨度) / 0.9165   // 关键点只覆盖「眼/耳→脚趾」，占身高 91.65%
2. 脚底   bottom = maxY + 0.0095 * bodyH           // 再往下补一个鞋底厚度
3. 中线   cx     = (左胯.x + 右胯.x) / 2           // 侧身时包围盒中心会偏，必须用胯中点
4. 横缩   sx     = clamp(真人胯宽 / 素材臀宽, 0.86, 1.14)
5. 缩放   k      = bodyH / refH
          其中  refH = padT + h - headTop
          绘制  ctx.drawImage(img, cx - hipX, bottom - (padT + h) * k, imgW, imgH)
```

### 7.3 `headTop`：一个必须存在的字段

`headTop` 是**头顶在 PNG 里的 y 坐标**。

**为什么不能直接用内容包围盒高度**：举手过顶的姿势，包围盒顶边是**手指尖**，不是头顶。

| 素材 | 包围盒顶 | 实际头顶 | 偏差 |
| --- | --- | --- | --- |
| peace-up（比耶） | 8 | 177 | **169px ≈ 身高 19%** |
| jump（跳起来） | 8 | 90 | 82px |
| lean-wall | 8 | 15 | 7px |

用错参考高度的后果：整张图被缩小并下压，**脑袋落到真人下巴以下**。这是 2026-10-21 用真人照片伪装摄像头才测出来的（假摄像头画面里没人，走的是 `drawDefault`，从来没跑到对齐分支）。

**`hipOfH` 的定义也跟着改了**：现在是「臀宽 ÷ (脚底 − 头顶)」，早期是「臀宽 ÷ 内容包围盒高」。新增素材必须按新定义。

### 7.4 无人入镜时的默认摆放

脚底压在 `0.80` 画高处（给底部姿势条留呼吸），身高占 `0.62` 画高，水平居中，极端张开姿势按画面宽度 `0.88` 收一点。
0.80 是实测值：390×844 / 430×900 / 375×667 / 820×1180 四种视口下脚底距姿势条顶边分别 75 / 86 / 39 / 142 px，最窄的 375×667 也留 39px。

---

## 8. 加一个姿势：完整步骤

### 8.1 只加姿势定义（不需要新素材）

改 `src/poseLibrary.ts`，在对应场景里加一条。字段含义见 §6。
提示文案 `hintWristL/hintWristR` 必须**和实际动作一致**——曾经「抬手遮阳」写着「一手叉腰」，但线稿里那只手是垂着的，用户照着做对不上。

### 8.2 加一个带剪影素材的姿势（完整链路）

```
① 生成线稿（ImageGen 文生图）
② 提线成青色 PNG          .probe/line_extract.py
③ 算几何参数              .probe/geom_all.py
④ 放进 public/sil/
⑤ 写进 SILHOUETTE_GEOM    src/silhouette.ts
⑥ 写进 SIL_ASSETS         public/sw.js        ← 最容易漏！
⑦ 跑 build + smoke + pwa-check
```

**① 生成线稿的提示词模板**（`{POSE}` 处替换成姿势描述）：

```
Minimalist black line art on a pure white background. One full-body female figure,
full length from top of head to soles of feet, not cropped, generous white space around her,
facing the camera straight on. She wears a fitted sleeveless tank top and slim straight-leg
trousers, flat sandals. Thin clean confident continuous pencil strokes: only the body silhouette
outline plus a few major clothing fold lines. Hair drawn as one simple clean outline mass,
no individual hair strands. Blank empty face with absolutely no facial features - no eyes,
no eyebrows, no nose, no mouth - only the smooth oval head outline. No shading, no hatching,
no color, no fill, no background, no ground line, no shadow, no text, no watermark, no border.
Fashion illustration croquis style, very minimal detail. Pose: {POSE}
```

**四条硬约束**（踩过才知道）：

| 约束 | 原因 |
| --- | --- |
| `Blank empty face with absolutely no facial features` | 五官会被提成碎线，糊在脸上 |
| `Hair drawn as one simple clean outline mass` | 头发丝会被提成一团杂线（`hair-flip` 就吃了这个亏） |
| 服装固定「贴身背心 + 修身长裤」 | 宽松衣物会遮住肢体，剪影里看不出腿在哪 |
| 肢体与躯干之间要有白缝 | 手臂贴身时会和躯干连成一整块 |

**AI 不听话的地方**：腿部细节（交叉腿）需要大写强调才画得出来，例如 `her legs are CROSSED in a clear X shape`。身体转向要说 `shoulders overlapping in a single vertical line`、`chest points to the left`，否则会画成正面站立。

**② 提线**

```bash
"$PY" .probe/line_extract.py <输入.png> <.probe/out/<id>.png> --id <id> --drop-text
```

- 用 `--drop-text` 而不是 `--crop-bottom`：前者只吃掉右下角「AI生成」水印，后者会把脚一起裁掉。
- 核心算法是**背景减除**（`bg = medianBlur(gray,61)`，判据 `bg - gray > 12`），**不要**改回固定灰度阈值——AI 线稿的「白底」实测是 247 浅灰，固定阈值 140 只能抓到 0.79%，整张会散架。

**③ 算几何参数**

```bash
"$PY" .probe/geom_all.py     # 直接打印 20 条 TS 代码，复制进 SILHOUETTE_GEOM
```

- 头顶：躯干中线 ±0.09w 窄列带里第一条有墨的行（举手的手指在头侧方、比头窄，窄带能绕开）。
- 臀宽：45% 身高那一行取**整行** min/max。
  ⚠️ **不要**改成「只取躯干中线附近的窗口」——线稿同一行可能只穿过一条折线，`arms-crossed` 会量出 3px。
  ⚠️ 但整行法对「迎风张臂」失效（最外侧是手臂末端，量出 0.4082，正常 0.15~0.25），该姿势在脚本里有 `HIP_OVERRIDE` 人工指定。

**⑤⑥ 双写**

```ts
// src/silhouette.ts
'new-pose': { imgW: 351, imgH: 916, padL: 8, padT: 8, w: 334, h: 899, headTop: 8, hipOfH: 0.238, hipCx: 0.3832 },
```

```js
// public/sw.js 的 SIL_ASSETS
'./sil/new-pose.png',
```

**⑦ 改版本号**：`public/sw.js` 的 `VERSION` 必须 +1，否则已装用户不会更新缓存。

---

## 9. PWA 与部署

### 9.1 结构

- `display: standalone` + `orientation: portrait` → 全屏独立窗口，无地址栏。
- 图标在 `public/icons/`，由 `.probe/make_icons.py` 生成（深色圆角底 + 青色取景框角标 + 火柴人，与 `index.html` 内联 SVG favicon 同款）。
- 不支持 SW 的环境、非安全上下文（`http://192.168.x.x`）下 `registerServiceWorker` 会静默返回，不能报错影响主流程。

### 9.2 Service Worker 策略（`public/sw.js`）

| 请求 | 策略 | 原因 |
| --- | --- | --- |
| 导航（HTML） | **network-first**，失败回退 shell 缓存 | HTML 引用的 JS 文件名带 hash，缓存住 HTML 就永远拿不到新版本 |
| `/sil/*` `/mp/*` `/assets/*` `/icons/*` | **cache-first**，miss 则 fetch 并写入 | 相机页最怕卡，本地有就直接用 |
| 非 GET / 跨域 | 直接 `return`，不拦截 | 避免 opaque 响应污染缓存 |

**install 阶段只预缓存**：shell（HTML/manifest/图标）+ **20 张剪影** + `mp/pose.js`。
**`/mp` 的 18MB 模型不进预缓存** —— 会让安装阶段超时，一旦 `addAll` 失败整个 SW 都装不上。模型走运行时懒缓存，用户点一次「开启摄像头」就都进去了。

**更新策略**：不自动 `skipWaiting`。新 SW 进 waiting → 页面 toast「有新版本，点这里刷新」→ 用户点 → `SKIP_WAITING` → `controllerchange` → reload。
自动 skipWaiting 会造成「页面还是旧 JS、缓存已是新资源」的错位。

**首次安装例外**：页面发现 `navigator.serviceWorker.controller === null`（本页从未被接管）会主动发 `{type:'CLAIM'}` 让 SW 接管。不这么做，首次会话里 `/mp` 和 `/sil` 全都不进缓存，用户装完第一次打开必须联网。
`controllerchange` 的 reload 必须用 `reloadAfterSkipWaiting` 标志闸住，否则首次 CLAIM 也会触发多余刷新。

### 9.3 部署

**2026-10-23 起改为自有服务器，域名固定 `https://photo.galois1130.site`。**
完整操作见 `deploy/README.md`，这里只记结论和原因。

| 环节 | 做法 |
| --- | --- |
| 网页包 | `.github/workflows/web.yml` push 后自动构建，发到固定 Release `web-latest` |
| 服务器 | 华为云 ECS + nginx，静态目录 `/var/www/photo-coach` |
| 更新 | 服务器上 `bash deploy/update.sh`，3~5 秒，不动 APK |
| 证书 | acme.sh + Let's Encrypt，自动续期 |
| 配置 | `deploy/nginx-ssl.conf.tpl`，缓存策略的每条原因写在注释里 |

**为什么服务器不自己构建**：要在服务器装 Node，华为云 EulerOS 版本兼容坑多。
GitHub Actions 构建好、服务器只解压，少一层依赖就少一类故障。

**为什么用子域名 `photo.` 而不是主域名**：主域名和 `www` 上还挂着两个旧服务，
动主域名会带崩它们。子域名完全独立。

**⚠️ 早期托管方案（已废弃）**：`workbuddy_sites_deploy` 每次部署都会换一条新链接，
旧链接立刻 400（详见 §14.8）。只在应急时还能用，日常不要再用。

**关于 `start_url` 与 sharecode（历史遗留，现已不需要）**

早期托管平台用 `?sharecode=XXX` 当访问凭证，响应种 30 天 cookie，无凭证访问一律 403。
那时 `start_url` 必须写成 `"./?sharecode=..."`，否则 cookie 到期后用户点桌面图标就是一片白屏。

2026-10-23 换到新托管后**不再有访问凭证**，`start_url` 已恢复成 `"./"`。
`handleNavigate` 里「非 2xx 回退 shell 缓存」的双保险继续保留，仍然有用。

---

## 10. 验证探针

`.probe/` 下的脚本都不参与构建，但**改完要跑**。

| 脚本 | 验什么 | 什么时候跑 |
| --- | --- | --- |
| `smoke-dist.mjs` | 素材数量、三个代表姿势能渲染、0 报错 | 每次 build 后 |
| `pwa-check.mjs` | SW 状态 / manifest 字段 / 离线启动 / 相机过 SW / 缓存分层 / **首访即离线** | 动了 SW 或 PWA |
| `pwa-update-check.mjs` | 更新链路 E2E（弹提示 → 点击 → 切换 → 清旧缓存） | 改了 SW 更新逻辑 |
| `pwa-live-check.mjs` | **线上真实环境**（含 sharecode 变量） | 每次部署后 |
| `list-poses.mjs` | 打印 27 个姿势 + 素材覆盖情况 | 加/删姿势后 |
| `shot10.mjs` `shot5b.mjs` | 各姿势在 App 内的实际渲染截图 | 改剪影后 |
| `shot-real.mjs` | **用人照片伪装摄像头**，验证 `drawAligned` 对齐分支 | 改标定后，必跑 |
| `geom_all.py` | 生成几何参数 | 加素材时 |
| `line_extract.py` | 线稿提线 | 加素材时 |
| `make_icons.py` | 生成 PWA 图标 | 改图标时 |

**写探针时踩过的坑（会误判成产品 bug）**：

- **假摄像头画面里没人** → 走的是 `drawDefault`，`drawAligned` 一次都跑不到。要验对齐必须用 `shot-real.mjs`（`evaluateOnNewDocument` 里替换 `getUserMedia`，返回 `<canvas>.captureStream()`），且照片要裁到人物占画面约 85%，否则 App 会正确提示「人拍得太小」，测不到贴合。
- **读 `window.__silLoaded` 太早**：`page.reload({waitUntil:'domcontentloaded'})` 之后立刻读必然是 0，要等约 4 秒图片解码完。
- **headless 没加 `--use-fake-device-for-media-stream`**：`getUserMedia` 报 `Requested device not found`，会被误读成「离线相机起不来」。
- **没关 Chrome 的 HTTP 缓存**：会让「缓存其实没生效」看起来像生效了。探针里要 `setCacheEnabled(false)`。

---

## 11. 血泪坑清单（按踩到的时间排序）

1. **剪影「看起来胖」不是缩放问题**。x、y 共用一个 `unit`，真人照实测缩放系数 1.024 / 1.016（误差 1%）。真正影响观感的是**头部椭圆半径**和**线宽**两个标定量。觉得胖就调这两个，别去动 `unit`。
2. **脚出画规则必须绕开 `visibility`**。脚已出画时 MediaPipe 给踝/脚尖的 `visibility` 往往 < 0.2，用 `isVisible()` 过滤会导致规则 1 永不命中，提示掉到「人拍得太小」——用户听到的是错信息。`framing.lowestFootY()` 只校验坐标有效，不看 visibility。
3. **`npx` 会唤起 `wsl.exe` 被安全策略拦**。一律用 `node node_modules/...`。
4. **姿势模板没有脚尖点（31/32）**，`figure.ts` 画腿画到踝就断，人像「截肢」。缺脚尖时按踝往下偏外补 `0.3 * unit`。
5. **几何人形肩线插值写错**：`ctx.lineTo(shL.x * 0.42, midTopY)` 拿画布**绝对坐标**乘 0.42，整条肩线甩到画布左侧，每个姿势都拖出一条横穿身体的粗线。必须相对 origin 插值。
6. **AI 线稿的「白底」不是纯白**（实测 247 浅灰，线条从 0 渐变到 246），固定灰度阈值抓不到淡的部分，必须用背景减除。
7. **AI 图右下角有「AI生成」水印**，不处理会被当成线条提出来，且会让内容包围盒变大。用 `--drop-text`。
8. **`drawAligned` 用内容包围盒当身高参考**，举手过顶的姿势会整体缩水、脑袋掉到下巴以下。必须用 `headTop`。见 §7.3。
9. **臀宽不能用「躯干中线附近窗口」量**，线稿同一行可能只穿过一条折线。用整行 min/max，个别张开双臂的姿势人工指定。
10. **`start_url` 不带 sharecode**，桌面图标 30 天后白屏。见 §9.3。
11. **`handleAsset` 只查 `ASSET_CACHE`**，预缓存进 `SHELL_CACHE` 的剪影和 `pose.js` 全部 miss → 断网时「页面起来了、一张剪影都没有」。必须 `(await cache.match(req)) || (await caches.match(req))`。
12. **`index.html` 里的 `pose.js` 在解析期加载**，早于 SW 就绪，靠运行时缓存永远拿不到，必须放进预缓存，且引用写成 `./mp/pose.js` 与 SW 缓存 key 对齐。
13. **「拍出来糊」的根因是竖屏裁切，不是对焦**。画面 `object-fit: cover` 铺满竖屏容器，拍照又按容器宽高比（约 0.46）裁切，所以
    **照片宽度 ≈ 采集高度 × 0.46**。采集只有 720p 时裁完剩 331px 宽，看着就是糊的。真正的解法是把**采集高度**顶上去
    （`getUserMedia` 的 `ideal` 只管「尽力」，拿到流后必须用 `track.getCapabilities()` + `applyConstraints` 再顶一次），
    而不是调 JPEG 质量。判断依据看预览层的 `宽 × 高 · N MP` 标注。
14. **采集分辨率提上去之后必须给推理降采样**。MediaPipe lite 内部只用 256×256，直接把 4K `video` 喂给 `pose.send()`
    等于每帧传一张 800 万像素纹理，检测帧率会掉到个位数。`camera.ts` 的 `inferenceInput()` 会先缩到 640 宽再送，
    输出是归一化坐标，精度不受影响。

---

## 12. 已知限制

- **单人**：legacy Pose 只输出一个人，多人入镜只跟最显著的那位。
- **横向标定钳制在 ±14%**（0.86~1.14），特别胖/瘦的人剪影会比真人略宽/略窄。
- **`modelComplexity: 0`（lite）**在远距离、背光、宽松衣服下抖动明显；不能改成 1/2，只下载了 lite 模型，会 404。
- **左右方向按「被拍者自身左右」**，人物背对镜头时姿势提示会反。
- **水平仪**：`DeviceOrientationEvent` 的倾斜角含俯仰影响，抬头/低头取景时读数偏；iOS 需授权「运动与方向」。
- **前置摄像头未做镜像**（默认后置）。
- **拍照是相机原图按可见构图裁切**，不含叠加层；不同设备视场角可能与预览略有差异。
- **照片分辨率受 WebRTC 采集能力限制**，不是相机传感器的上限。竖屏裁切后宽度 ≈ 采集高度 × 0.46，
  1080p 采集只剩约 500px 宽。`camera.ts` 会尽量顶到设备上限、并尝试 `ImageCapture.takePhoto()` 拿静态照片，
  但真正的原相机画质只能靠壳里的「用系统相机拍一张」入口（见 §14.2）。
- **`side-glance` 的头发是实心块**（其余是轮廓线），AI 出图时画成了填充，提取后头顶一小片实心青色，可接受。

---

## 13. 待办

**高优先**

- [ ] 真机长期试用，收集「卡不准 / 姿势不好用」的具体案例。剪影标定的剩余误差只有在真机上才看得出来。
- [ ] `gaze-far`（手搭凉棚）和 `hand-shade`（抬手遮阳）**是同一个姿势**，建议删一个。

**素材**

- [ ] 剩余 7 个无素材姿势：`mirror-selfie` `read-book` `stand-counter` `lean-door` `arms-fold-lean` `reach-shelf` `gaze-far`。
      注意其中 5 个依赖道具/家具（手机、书、吧台、门框、货架），线稿容易画脏，生成时要避免把家具画进画面。

**工程**

- [ ] `README.md` 有多处过时（剪影 9 个 → 实际 20 个、目录结构缺 PWA 文件、「5% 填充」的描述已不适用），需要按本文重写。
- [ ] `.probe/` 下有一批阶段性脚本（`sil-*.mjs`、`cutout*.py`、`photosketch*.py`、`geom_line10.py`、`geom_fix.py` 等）已经不再使用，可以归档到 `.probe/archive/`。
- [ ] `.probe/silhouette.ts.bak` 是改 `headTop` 前的备份，确认后可删。
- [ ] 如果要上架/换域名：注意 `manifest.webmanifest` 里的 `start_url` sharecode 要同步改。
- [ ] 想彻底摆脱 WebView 的画质上限，只剩两条路：① App 内自写 Camera2 拍照（黑屏 1~2 秒，
      要处理旋转/尺寸/厂商差异）；② 把指导层做成原生浮层盖在系统相机上（安卓系统级悬浮窗
      拿不到系统相机画面，实际不成立）。目前的折中是「主快门走 WebRTC + 预览层提供系统相机入口」。

---

## 14. Android 壳与 CI 打包

**结论先行**：做的是 **WebView 壳**，不是 TWA。壳里没有业务代码，改功能只改网页、重新部署，
**不需要重新出包**。

### 14.1 为什么不是 TWA

TWA 隐藏地址栏必须通过 Digital Asset Links 验证，验证文件得放在
`https://<站点>/.well-known/assetlinks.json`。而本站点的托管平台用 `?sharecode=` 做访问凭证，
**无凭证请求一律 403**（§9.3）。Google 的验证器是设备侧直连，带不上这个凭证 →
文件读不到 → 验证失败 → TWA 退化成 Custom Tab，**顶部顶着一条地址栏**，等于白做。

WebView 壳不依赖任何域名验证。代价：引擎性能略低于 Chrome。

### 14.2 原生层必须补的四件事

网页端做不到、只能原生补，**改壳时优先看这四条**：

| 问题 | 网页端表现 | 原生补法 |
| --- | --- | --- |
| 摄像头权限 | `getUserMedia` 被拒 | `onPermissionRequest` 授权 `RESOURCE_VIDEO_CAPTURE`，**同时** App 要持有 `CAMERA` 运行时权限（缺一不可，只 grant 不申请系统权限仍然黑屏） |
| 保存到相册 | `<a download>` 指向 `blob:`，**点了毫无反应** | JS 桥接 `PhotoCoachNative.saveImage(dataUrl, fileName)` → `MediaStore`（10+ 用 `IS_PENDING`） |
| 站外链接 | 会顶掉 App | `shouldOverrideUrlLoading` 判 host，非本站交给系统浏览器 |
| 原相机画质 | `getUserMedia` 走视频流通道，竖屏裁切后只剩几百像素宽 | JS 桥接 `PhotoCoachNative.openSystemCamera()` → `ACTION_IMAGE_CAPTURE` + `MediaStore` 预占 uri |

**关于第 4 条（`openSystemCamera`）：快门直连，不是补充入口。**

2026-10-23 用户真机反馈「拍出来还是模糊，要原相机、要防抖」之后改成：
**壳内按快门 = 直接跳系统相机**，不再走网页抓帧。理由：

- WebView 的 `getUserMedia` 走视频流通道，分辨率受 WebRTC 采集能力限制；
- 竖屏 `cover` 裁切后照片宽度只有采集高度的 0.46 倍（1080p 采集 → 499×1080）；
- 拿不到相机硬件的 OIS 防抖。

系统相机是硬件级拍照通道，画质 / 防抖 / 多帧合成都是设备上限。代价是离开指导界面 ——
但此时用户已照着剪影摆好姿势，跳过去直接按快门即可。浏览器里（无桥接）仍走抓帧 + 预览。

不做 App 内 Camera2 的原因：与 `getUserMedia` 互斥，要停流、等系统释放、再开相机，
中间黑屏 1~2 秒，还得自己处理旋转、输出尺寸、各厂商差异，且无法本地验证。

流程上三个必须记住的点：
- **跳转前必须先把摄像头放掉**（`main.ts` 的 `takePhoto()` 里先 `suspendCamera()` 再调桥接），
  否则系统相机会黑屏或打不开。原生侧还额外 `postDelayed 180ms`，等系统真正释放。
- **回来不用额外处理**：从系统相机返回必然走 `onResume`，那里派发 `photocoach:resume`，网页自动重新取流。
- **跳转失败必须有兜底**：没相机 App / 权限不足 / 存储异常时不会走 `onResume`，
  原生 `notifyCameraFailed()` 派发 `photocoach:camera-failed`，网页先恢复取景、1.2 秒后回退 WebRTC 抓帧。
  漏了这条，用户按一下快门就卡在黑屏上，只能杀进程。

### 14.3 保存为什么不能走 `setDownloadListener`

页面给的是 `blob:` URL，`DownloadListener` **不会为 `blob:` 触发**，拿到的是空链接。
必须由页面自己把 blob 读成 base64 交给原生：`src/ui.ts` 的 `nativeBridge()` / `saveViaBridge()`。
**桥接对象名 `PhotoCoachNative` 两端必须一致**，改一侧记得同步另一侧。

### 14.4 出包

不用本地 JDK / SDK，全部走 CI：

```
推到 main（仅 android/** 或 workflow 变更才触发）
  → Actions「Build Android APK」
  → Artifacts 下载 photo-coach-apk
```

也可以在 Actions 页面手动 Run workflow。本地构建见 `android/README.md`。

### 14.5 签名

用 Android SDK 自带的 `debug.keystore`（公开密钥，跨机器一致）→ 每次 CI 出的包签名相同，
**新版本可直接覆盖安装**。所以仓库里不需要也不该放任何 keystore（`.gitignore` 已挡）。

### 14.6 壳的行为约定（改动前先读）

- **切后台靠事件补位，不重载页面**。WebView 不派发 `visibilitychange`，所以原生在
  `onPause` 派发 `photocoach:suspend`、`onResume` 派发 `photocoach:resume`，网页端
  （`src/main.ts`）用与浏览器同一套 `suspendCamera` / `resumeCamera` 处理。
  **事件名两端必须一致。** 不要改成 `loadUrl` 重载 —— 那会丢掉选中的姿势和拍照预览，
  而且 `onResume` 紧跟 `onCreate` 触发，会白白加载两遍。
- **切后台要真的停轨道**。`camera.pause()` 只停 rAF，摄像头仍在取流；浏览器会兜一层，
  WebView 不会。所以 `camera.releaseCamera()` 负责停轨道，`resume()` 在轨道为空时重新取流。
  刻意不复用 `dispose()` —— 它会把 wasm 模型一起关掉，回来要重新初始化。
- **不做 edge-to-edge**。系统栏保持可见、刷成 `#05070A`。藏起来又没真正贴边会出现
  「顶部被压住 / 底部多黑边」，且 `env(safe-area-inset-*)` 两种布局下行为不一致。
- **地址写死在 `app/build.gradle.kts` 的 `APP_URL`**。换部署地址时三处同步：该字段、
  `public/manifest.webmanifest` 的 `start_url`、§9.3。
- **仓库不放 `gradle-wrapper.jar`**，CI 用 `gradle/actions/setup-gradle` 装 Gradle 8.7（配 AGP 8.5.2）。
- **`NativeBridge` 必须是 public 类**。`@JavascriptInterface` 靠反射调用，非 public 的类
  在部分 ROM 上会抛 `IllegalAccessException`，症状是「对象在、方法调不到」，极难排查。
- **桥接方法是「可选能力」的写法**。老版本 APK 里没有新方法，网页端必须能优雅降级：
  `NativeBridge` 接口里把新方法声明成可选（`openSystemCamera?()`），调用处用
  `typeof bridge.openSystemCamera === 'function'` 判一下，缺了就隐藏对应按钮。
  否则新网页配旧 APK 会直接抛错。
- **`launchSystemCamera` 不用 `resolveActivity` 预判**。Android 11 起的包可见性限制会让它对
  未在 `<queries>` 声明的应用返回 null，明明有相机却判成「没有」。直接 `startActivityForResult`
  再 catch 异常更可靠。

### 14.7 壳工程刻意零依赖

`app/build.gradle.kts` 的 `dependencies {}` 是空的：不用 androidx / appcompat / kotlin。
好处是 CI 只需 AGP 一个插件，构建失败面最小。代价是不能用 ViewBinding，但总共就一个
Activity + 一个 WebView，手写足够。**加依赖前先想清楚值不值。**

### 14.8 域名漂移（2026-10-23 已解决）

**曾经的坑**：早期托管平台每次部署都换一条新链接，旧链接立刻 400。
`APP_URL` 写死在 APK 里，于是「每改一次网页就要重新出包 + 用户重装」，
WebView 壳最大的优势（网页独立更新）完全消失。

实测三次，`sandboxId` 都是同一个，但 `shareLink` 每次都变，
`domainPrefix` 参数不起作用（域名是随机 hash，不是 `photo-coach`）：

| 部署 | 链接 | 下一次部署后 |
| --- | --- | --- |
| 第 1 次 | `8dec044d…sg.agentos-app.run` | **400** |
| 第 2 次 | `242ff01c…sg.agentos-app.run` | **400** |
| 第 3 次 | `2e6d7367…sg.agentos-app.run` | 已废弃 |

**现在的解法**：自有域名 `https://photo.galois1130.site`（华为云 ECS + nginx）。
`APP_URL` / `APP_HOST` 从此**不需要再改**，网页更新走 `deploy/update.sh`。
详细部署说明见 `deploy/README.md`。

**唯一还需要重出包的情况**：换域名、改壳代码、改权限声明。

**历史备选方案（未实施，留档）**：把 `dist/` 打进 APK 的 `assets/web/`，用
`shouldInterceptRequest` 把 `https://appassets.androidplatform.net/web/...` 映射到 assets。
好处是彻底摆脱域名依赖、离线天然可用、启动不用下载 18MB。
注意：assets 走 `file://` 会失去安全上下文、`getUserMedia` 直接不可用，
必须用 `https://` 的自定义域名映射，不能图省事用 `file:///android_asset/`。
现在域名稳定了，这个方案收益不大，暂不做。

