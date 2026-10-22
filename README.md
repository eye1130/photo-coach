# 拍照指导（Photo Coach）

> **接手开发请先读 [`AGENTS.md`](./AGENTS.md)** —— 工程约定、坐标系、剪影标定、素材生产链路、PWA 与部署、踩坑清单都在那里。
> 本文是产品说明；其中「剪影素材数量」「目录结构」等段落早于 2026-10-21 的线稿改造，已过时，**以 AGENTS.md 为准**。

一个「打开即取景」的 Web 相机：**实时把姿势剪影 + 构图提示叠在取景画面上**，用来解决两个真实痛点——

1. 不知道让对方摆什么姿势（只会说"笑一个""站好"）；
2. 不知道该怎么构图（人太小、头顶被切掉、脚出画、人歪在画面边缘）。

> 说明：安卓系统级悬浮窗拿不到系统相机画面，iOS 也禁止，技术上不成立。
> 所以本项目做的是**自己的全屏相机界面**：所有指导实时叠加在取景画面上，使用体验与"悬浮"完全一致。

---

## 快速开始

```bash
npm install
```

### 电脑自测（Chrome / Edge）

```bash
npm run dev
```

打开 http://localhost:5173 —— localhost 属于"安全上下文"，可以直接调摄像头。
桌面端把画面收成手机比例（约 460px 宽）方便调试。按 **空格** 也能拍照。

### 手机真机测试（同一 WiFi）

浏览器要求**安全上下文**才能调用摄像头，`http://192.168.x.x` 不行，必须 HTTPS：

```bash
npm run dev:https
```

1. 终端会打印 `https://192.168.x.x:5173`（Network 那一行），手机浏览器输入该地址；
2. 首次会提示证书不受信任 —— 选择「继续访问 / 高级 → 继续」（自签证书，仅测试用）；
3. 点「开启摄像头」→ 允许摄像头权限；
4. 用**后置摄像头**对着朋友，让对方看着屏幕照着剪影摆。

iOS Safari 额外注意：
- 必须允许摄像头（设置 → Safari → 相机 → 允许）；
- 语音提示需要先在页面上点一下（已由「开启摄像头」按钮满足用户手势要求）；
- 「保存到相册」在 iOS 上会打开分享/下载面板，选「存储图像」即可。

### 生产构建

```bash
npm run build     # tsc --noEmit + vite build
npm run preview   # 本地预览 dist
```

部署提示：`dist` 需要以 **HTTPS** 提供服务（摄像头硬性要求），并把 `dist/mp/` 一并部署
（`public/` 会被原样拷贝到 `dist/`）。

---

## 功能

| 功能 | 说明 |
| --- | --- |
| 姿势剪影 | 人体**线稿**（青色细线，无填充）叠加在画面里，被拍人照着摆；检测到人时按胯宽与身高自动贴合人物位置与大小 |
| 骨骼追踪 | MediaPipe Pose 33 点实时骨骼线（默认关闭，留给调试） |
| 姿势偏差提示 | 与当前模板对比关节角度/关键点位置，给出「左臂再抬高一点」这类具体指令 |
| 构图提示 | 脚出画、头顶太挤/太空、人太小/太大、左右偏移、手机歪了 |
| 三分网格 | 构图参考线 |
| 水平仪 | 用 `DeviceOrientationEvent` 判断手机是否拿歪 |
| 状态条 | 渲染帧率 · **检测 N 帧/s**（每秒实际送进模型并拿到结果的帧数，与画面里有没有人无关）· 人体识别状态 |
| 语音播报 | 可选，中文 TTS，4 秒节流 |
| 拍照 | 存相机原图（不含叠加层），可保存到本地 |

### 内置姿势（27 个，3 个场景）

| 场景 | 姿势 |
| --- | --- |
| 街拍 | 自然站、单手叉腰、双手抱胸、侧身回眸、手插兜、走路回头、双手插兜、靠墙、抬手遮阳、交叉站 |
| 室内 | 低头看手机、整理衣领、对镜自拍、倚窗、低头看书、靠吧台、倚门框、抱臂靠墙、伸手够高处 |
| 户外 | 迎风张臂、扶帽檐、跳起来、手搭凉棚、撩头发、比耶举手、背手远望、指向远方 |

**两套剪影渲染**（`src/silhouette.ts` / `src/figure.ts`）：

- **真实线稿剪影（20 个姿势）** —— AI 生成白底黑线 → 提取成青色线条 PNG，按实测关键点五步标定对齐，叠在真人身上能"套住"。素材在 `public/sil/`，共约 932KB。
- **程序化几何人形（其余 7 个）** —— 由关键点算出梯形躯干 + 胶囊四肢 + 椭圆头，任意姿势都能表达，但形状是"示意"而非真人轮廓。

为什么两套：线稿剪影对每个姿势都需要一张素材图，而 AI 生成复杂姿势（举手过头、身体转向、依赖环境参照的动作）合格率有限。两套共存 + 自动回退，比"全部用几何人形"好，也比"只保留有素材的 20 个姿势"覆盖广。

素材生产流程见 [`AGENTS.md` §8](./AGENTS.md)（含提示词模板、四条硬约束、以及 `.probe/SILHOUETTE-SOP.md` 里两个走不通的死路）。

---

## 目录结构

```
index.html            首屏 DOM + <script src="./mp/pose.js">
vite.config.ts        dev / dev:https 两套配置
src/main.ts           装配入口、状态机（idle/loading/ready/error）、提示调度
src/camera.ts         getUserMedia、video 挂载、rAF 帧循环、防重入 pose.send、拍照裁切
src/poseEngine.ts     角度计算、cover 坐标映射、指数平滑、人体框、头高
src/poseLibrary.ts    27 个姿势的参数化定义（只给手腕/踝目标点，肘膝由 IK 反解）
src/posture.ts        姿势库导出 + 偏差检测（角度/位置/跨度三类规则）
src/figure.ts         程序化几何人形渲染（7 个无素材姿势的兜底）
src/silhouette.ts     线稿素材管理 + 五步标定对齐绘制（20 个有素材姿势）
src/framing.ts        构图规则（优先级 1~6）+ 水平仪判定
src/overlay.ts        canvas 绘制：网格 / 剪影 / 骨骼 / 水平仪 / 提示气泡
src/ui.ts             控件绑定：首屏遮罩、开关组、场景 Tab、姿势条、快门、预览
src/pwa.ts            Service Worker 注册 + 新版本提示
src/types.ts          共用类型
src/style.css         暗色相机 UI
public/sil/           20 张线稿剪影 PNG（约 932KB，勿删改）
public/mp/            MediaPipe Pose 运行时 + lite 模型（18MB，勿删改）
public/icons/         PWA 图标 5 个
public/manifest.webmanifest  PWA 清单（start_url 带 sharecode，勿改）
public/sw.js          手写 Service Worker（加素材要同步 SIL_ASSETS）
AGENTS.md             工程约定文档 —— 接手开发先读这个
```

---

## 关键实现说明

### 1. 坐标映射（最容易踩的坑）

`video` 用 `object-fit: cover` 铺满容器会被裁切，归一化坐标不能直接乘 canvas 尺寸：

```ts
scale = max(cw / vw, ch / vh)   // cw,ch = 容器显示尺寸；vw,vh = video 实际分辨率
dw = vw * scale;  dh = vh * scale
ox = (cw - dw) / 2;  oy = (ch - dh) / 2
x = lm.x * dw + ox;  y = lm.y * dh + oy
```

canvas 的 `width/height` 按 `devicePixelRatio` 放大（上限 2.5），绘制前 `ctx.scale(dpr, dpr)`，
绘制坐标统一用 CSS px。

### 2. 姿势模板 = 剪影 + 偏差检测共用一份数据

模板用「相对骨架坐标」：原点 = 鼻尖，y 向下为正，**单位 = 头高**（鼻尖到两肩中点的距离）。
这样与分辨率、人物远近完全解耦，同一个人走近走远都不用改阈值。

```ts
type PoseTemplate = {
  id: string; name: string;
  points: Record<number, [number, number]>;   // 关键点索引 → [x, y]
  angles?: { a; b; c; target; tol; hint }[];  // 三点夹角（b 为顶点）
  positions?: { point; target; tol; hint }[]; // 关键点位置
  spans?: { a; b; target; tol; hint }[];      // 两点跨度（识别侧身）
};
```

- 画剪影：模板点 × 实测头高 → 平移到鼻尖位置；**x、y 共用同一个 `unit`（像素/头高），与
  `evaluatePosture` 里的 `headUnitPx()` 完全同源**，不存在横向拉伸。
- 剪影比例（`overlay.ts` 顶部常量）用 1024×1536 真人照反算标定过：头圆半径 0.29 头高
  （真人耳间距 0.57 头高）、肢体线宽 0.20 头高（真人肢体约 0.21 头高）。
  实测剪影中线与真人关键点最大偏差 0.029 头高（2.3px @ unit=79px）。
- 检测偏差：实测点 ÷ 实测头高 → 换算到模板坐标系后比较。
- 没有检测到人时，按三分法在画面中央显示一个默认站姿剪影（头高 = 画面高 × 0.08）。

### 3. 提示优先级与节流

构图规则 1~6 优先，姿势偏差排第 7，**同一时刻只显示一条**：

1. 脚出画（踝/脚尖 y > 0.97）
2. 头顶太挤（鼻尖 y < 0.10）
3. 人拍得太小（鼻尖 y > 0.28）
4. 人体框高占比 < 0.45 / > 0.92
5. 人体框中心 x 不在 [0.33, 0.67]
6. 手机横滚 |tilt| > 3°
7. 姿势偏差（角度/位置/跨度归一化误差最大的那条）

节流：同一条提示 3 秒内不重复；条件持续成立时气泡保持显示；条件消失后停留 1.2 秒再淡出。
另外同一条提示连续成立超过 **6 秒**会让位给其它提示（用 `shownAt` 判断），避免「人偏左」这类
长期成立的提示把姿势提示永久饿死；`evaluateFraming / evaluatePosture` 都有可选的 `excludeId` 参数
支持这件事，如果除去被让位的那条以外没有别的提示，则继续显示原提示，气泡不会闪烁。

默认开关：三分网格 ✅、姿势剪影 ✅、语音 ❌、**骨骼 ❌**（骨骼是调试信息，普通用户不需要看火柴人）。

### 4. 性能

- 姿态推理降频：每 2 帧送一次 + `video.currentTime` 判重 + 最小间隔 55ms；
- **防重入**：上一帧 `pose.send()` 未 resolve 时直接跳过本帧（否则内存暴涨/卡死）；
- 关键点指数平滑（alpha = 0.5）；
- `visibilitychange` 切后台暂停帧循环；
- 状态条 DOM 写入节流到 400ms。

### 5. MediaPipe 运行时

`public/mp/pose.js` 是 legacy Solutions 的 **IIFE 全局脚本**（挂 `window.Pose`），
必须用 `<script src="/mp/pose.js">` 引入，**不能 import**：

```ts
const pose = new window.Pose({ locateFile: (f) => `/mp/${f}` });
pose.setOptions({
  modelComplexity: 0,          // 只下载了 lite 模型，1/2 会 404
  smoothLandmarks: true,
  enableSegmentation: false,
  minDetectionConfidence: 0.5,
  minTrackingConfidence: 0.5,
});
pose.onResults(onResults);
await pose.send({ image: videoEl });   // 帧循环里手动驱动
```

**零外部资源**：不引 CDN 字体、不引图标库，所有图标都是内联 SVG，运行时只访问本站 `/mp/*`。

---

## 已知限制

- **剪影素材覆盖 20 / 27 个姿势**：其余 7 个走几何人形。两套剪影的"套人"效果不同——线稿能贴合真人的肩线、发际线、衣褶，几何人形只是示意。选姿势时如果发现某个姿势的人形明显"不像人"，那就是它在用几何人形兜底。
- **真实轮廓的横向标定有 ±14% 上限**：剪影会按真人胯宽做横向缩放，但钳制在 0.86~1.14 之间，避免侧身姿势被拉变形。所以特别胖或特别瘦的人，剪影会比真人略宽/略窄。
- **单人**：legacy Pose 只输出一个人，状态条的人数只会是 0 或 1；多人入镜时只跟最显著的那位。
- **精度**：`modelComplexity: 0`（lite）在远距离/背光/宽松衣服下抖动明显，属正常；近一点更准。
- **模板是示意性的**：姿势偏差用简化规则（角度/位置容差），不是严格的姿态匹配；左右方向按 MediaPipe 的
  「被拍者自身左右」约定，人物背对镜头时左右提示会反。
- **水平仪精度**：`DeviceOrientationEvent` 的倾斜角包含俯仰影响，抬头/低头取景时读数会偏；
  iOS 需要用户授权「运动与方向」，未授权时只显示提示不出水平仪。
- **拍照是相机原图裁切**：按屏幕可见构图（cover）裁切后导出 JPEG，不含剪影/提示叠加层；
  不同设备的实际视场角可能与预览略有差异。
- **前置摄像头**未做镜像处理（默认走后置）；桌面无后置时回退到默认摄像头。
- **证书**：`dev:https` 用的是自签证书，浏览器首次会警告，属预期行为。
- **首次加载**：wasm + 模型约 18MB（含 SIMD 与非 SIMD 两套 wasm，老 Safari 会自动回退），
  全部走本地，仍然需要几百毫秒到数秒（视设备而定），所以首屏会有阶段文案
  （加载运行时 → 初始化模型 → 就绪）。模型彻底不可用时会进入 error 状态并在首屏提示
  「姿态模型加载失败，请刷新重试」，不会假装就绪。

## 调试小技巧

- 阈值都集中在 `src/framing.ts` 的 `FRAMING` 常量、`src/posture.ts` 的模板 `tol` 字段；
- 想在桌面确认剪影位置：选中「单手叉腰」，站到画面中间，剪影应贴合你的身体（头高一致）；
- 打开控制台看 `[pose]` / `[camera]` 前缀日志可定位模型或摄像头问题。

## 踩过的坑（别再踩）

1. **剪影"看起来胖"不是缩放问题**。`drawSilhouette` 里模板点 → 像素始终是
   `x = origin.x + tx * unit`、`y = origin.y + ty * unit`，x/y 共用一个 `unit`
   （`headUnitPx(points)`，与 `evaluatePosture` 同源）。真人照实测 x/y 缩放系数分别是
   1.024 / 1.016（误差 1%），纵向对得很准。真正影响观感的是两个**标定量**：
   `HEAD_RADIUS_*_UNITS`（头部椭圆）和 `SILHOUETTE_LINE_UNITS`（线宽）——
   曾经头圆按 1.0 头高画（真人头只有 0.57 头高）、边框按 0.38 头高画，才显得"横向被拉伸"。
   觉得胖就去调这两个常量，不要动 `unit` / 不要给 x、y 分别乘系数。
2. **脚出画规则必须绕开 `visibility`**。脚已经出画时 MediaPipe 给踝/脚尖的 `visibility`
   往往 < 0.2，若用 `isVisible()` 过滤，规则 1 根本不会命中，提示会掉到「人拍得太小」——
   用户听到的就是错信息。`framing.lowestFootY()` 只校验坐标有效性（`Number.isFinite`
   且非 `(0,0)` 占位），不看 visibility，这是那条规则原先被抢走优先级的根因。
