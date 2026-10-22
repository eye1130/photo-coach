/**
 * 真实人体轮廓剪影：素材管理 + 与真人关键点对齐绘制。
 *
 * 为什么不用程序化几何人形：火柴人/梯形躯干是「关节中心的连线」，本身没有肩宽、
 * 衣褶、头形，视觉上永远套不住真人。这里改用 AI 生成并逐像素标定的真实人体轮廓 PNG
 * （`public/sil/*.png`，青色轮廓 + 5% 填充已烘焙进图片），直接按实测关键点缩放贴合。
 *
 * 材质策略：
 *   - 9 个姿势有素材，其余 18 个由 overlay 回退到 `figure.ts` 的几何人形；
 *   - 素材加载失败不抛错，同样回退几何人形（绝不能白屏）；
 *   - **只用「当前姿势自己的」素材**：宁可回退几何人形，也绝不拿别的姿势的轮廓顶替
 *     （用户选了 A 却看到 B，比不显示更糟）；
 *   - 图片只解码一次并缓存 `HTMLImageElement`，每帧只做 `drawImage`（GPU 合成）。
 *
 * 底部缩略图不使用本模块：44px 下真轮廓的描边会糊成一团，横滑条统一用几何人形。
 *
 * 对齐算法（真人照片逐像素验证通过，勿随意改结构）：以「胯宽」做横向标定、
 * 以「关键点 y 跨度 → 身高」做纵向标定，坐标原点取胯中点而非包围盒中心（侧身姿势才不偏）。
 */

import type { Point } from './types';

/** 单张剪影素材的几何标定数据（单位：图片自身像素）。 */
export interface SilhouetteGeometry {
  /** PNG 整图宽 */
  imgW: number;
  /** PNG 整图高 */
  imgH: number;
  /** 内容（人形本体）左边缘在图内的偏移 */
  padL: number;
  /** 内容（人形本体）上边缘在图内的偏移 */
  padT: number;
  /** 内容宽度 */
  w: number;
  /** 内容高度 */
  h: number;
  /** 头顶在 PNG 里的 y 坐标（px）。内容包围盒顶边就是头顶时等于 padT。 */
  headTop: number;
  /** 臀部宽度 ÷ 身高（身高 = 脚底 − 头顶，即 `padT + h - headTop`） */
  hipOfH: number;
  /** 臀部中心在内容宽度中的横向比例（0 = 左边缘，0.5 = 正中） */
  hipCx: number;
}

/**
 * 素材几何表：逐张实测，直接作为标定基准使用。
 * 只包含「有素材」的姿势，key 必须与 `poseLibrary.ts` 里的 `PoseTemplate.id` 一致。
 *
 * 素材全部为**手绘线稿**：AI 生成白底黑线 → 提线转青色（`imgH` 一律 916、`pad` 8）。
 * 早期有过一代「实心人体轮廓 + 5% 填充」的素材，2026-10-21 已全部替换完毕。
 * 线稿比实心块更能"卡"住真人的肩线、手臂位置，且没有填充色块压住相机画面。
 *
 * `headTop` 是头顶的 y。举手过顶（peace-up / jump）或手臂斜上举（arms-open）的素材，
 * 内容包围盒顶是手指尖而不是头顶，必须单独记录，否则垂直标定会整体缩水
 * （peace-up 的包围盒顶比头顶高 169px，约占身高 19%，会让剪影整体缩小并下压、
 * 脑袋落到真人下巴以下）。`hipOfH` 的「身高」也统一按「脚底 − 头顶」算。
 */
export const SILHOUETTE_GEOM: Readonly<Record<string, SilhouetteGeometry | undefined>> = {
  'hand-on-hip': { imgW: 348, imgH: 916, padL: 8, padT: 8, w: 331, h: 899, headTop: 8, hipOfH: 0.1835, hipCx: 0.497 },
  'arms-crossed': { imgW: 204, imgH: 916, padL: 8, padT: 8, w: 187, h: 899, headTop: 8, hipOfH: 0.1702, hipCx: 0.5107 },
  'hair-flip': { imgW: 437, imgH: 916, padL: 8, padT: 8, w: 420, h: 899, headTop: 8, hipOfH: 0.2536, hipCx: 0.5452 },
  'hand-shade': { imgW: 286, imgH: 916, padL: 8, padT: 8, w: 269, h: 899, headTop: 8, hipOfH: 0.2058, hipCx: 0.6264 },
  'walk-turn': { imgW: 371, imgH: 916, padL: 8, padT: 8, w: 354, h: 899, headTop: 8, hipOfH: 0.2937, hipCx: 0.4859 },
  'lean-wall': { imgW: 364, imgH: 916, padL: 8, padT: 8, w: 347, h: 899, headTop: 15, hipOfH: 0.2242, hipCx: 0.5101 },
  'cross-step': { imgW: 188, imgH: 916, padL: 8, padT: 8, w: 171, h: 899, headTop: 8, hipOfH: 0.1502, hipCx: 0.4708 },
  'check-phone': { imgW: 216, imgH: 916, padL: 8, padT: 8, w: 199, h: 899, headTop: 8, hipOfH: 0.1724, hipCx: 0.5101 },
  'adjust-collar': { imgW: 391, imgH: 916, padL: 8, padT: 8, w: 374, h: 899, headTop: 8, hipOfH: 0.1835, hipCx: 0.4906 },
  'lean-window': { imgW: 271, imgH: 916, padL: 8, padT: 8, w: 254, h: 899, headTop: 8, hipOfH: 0.1924, hipCx: 0.3878 },
  'peace-up': { imgW: 205, imgH: 916, padL: 8, padT: 8, w: 188, h: 899, headTop: 177, hipOfH: 0.1753, hipCx: 0.5638 },
  'hat-tip': { imgW: 313, imgH: 916, padL: 8, padT: 8, w: 296, h: 899, headTop: 8, hipOfH: 0.1735, hipCx: 0.4932 },
  'point-far': { imgW: 535, imgH: 916, padL: 8, padT: 8, w: 518, h: 899, headTop: 8, hipOfH: 0.1835, hipCx: 0.6766 },
  'jump': { imgW: 677, imgH: 916, padL: 8, padT: 8, w: 660, h: 899, headTop: 90, hipOfH: 0.164, hipCx: 0.4985 },
  'back-hand': { imgW: 245, imgH: 916, padL: 8, padT: 8, w: 228, h: 899, headTop: 10, hipOfH: 0.1806, hipCx: 0.6184 },
  'stand-natural': { imgW: 351, imgH: 916, padL: 8, padT: 8, w: 334, h: 899, headTop: 8, hipOfH: 0.238, hipCx: 0.3832 },
  'arms-open': { imgW: 449, imgH: 916, padL: 8, padT: 8, w: 432, h: 899, headTop: 8, hipOfH: 0.2202, hipCx: 0.485 },
  'both-pockets': { imgW: 277, imgH: 916, padL: 8, padT: 8, w: 260, h: 899, headTop: 8, hipOfH: 0.1802, hipCx: 0.55 },
  'hand-in-pocket': { imgW: 341, imgH: 916, padL: 8, padT: 8, w: 324, h: 899, headTop: 8, hipOfH: 0.1935, hipCx: 0.5988 },
  'side-glance': { imgW: 242, imgH: 916, padL: 8, padT: 8, w: 225, h: 899, headTop: 19, hipOfH: 0.1836, hipCx: 0.3711 },
};

/** 有素材的姿势 id 列表（供启动时批量预加载）。 */
export const SILHOUETTE_IDS: readonly string[] = Object.keys(SILHOUETTE_GEOM);

/** MediaPipe 关键点：鼻子 / 左胯 / 右胯 / 左踝 / 右踝。 */
const NOSE = 0;
const HIP_L = 23;
const HIP_R = 24;
const ANKLE_L = 27;
const ANKLE_R = 28;

/** 判定「画面里有人」所需的有效关键点。 */
const REQUIRED_POINTS: readonly number[] = [NOSE, HIP_L, HIP_R, ANKLE_L, ANKLE_R];

/**
 * 纵向标定：landmarks 的 y 跨度只覆盖「眼/耳 → 脚趾」，占实际身高的 91.65%。
 */
const LANDMARK_SPAN_OF_HEIGHT = 0.9165;
/** 脚趾关键点再往下一个鞋底厚度（占身高）。 */
const SOLE_BELOW_TOES = 0.0095;
/** 关节点 23-24 在髋关节中心，比体表轮廓窄，实测系数 2.2。 */
const HIP_LANDMARK_TO_SURFACE = 2.2;
/** 横向缩放钳制范围：防止侧身姿势被拉变形（±14%）。 */
const SCALE_MIN = 0.86;
const SCALE_MAX = 1.14;
/** 有效身高下限（px）：低于此值视为检测失败，交回调用方回退。 */
const MIN_BODY_HEIGHT_PX = 8;

/** 无人入镜：脚底落在 0.80 画高处（给底部姿势条留呼吸），身高占 0.62 画高，水平按三分法居中。 */
const DEFAULT_BOTTOM_RATIO = 0.8;
const DEFAULT_HEIGHT_RATIO = 0.62;
/** 默认摆放时留出左右边距，极端的张开姿势（arms-open）在窄屏也不会溢出。 */
const DEFAULT_MAX_WIDTH_RATIO = 0.88;

// ------------------------------------------------------------------ 素材管理

/**
 * 素材根目录：相对当前文档解析，保证部署在子路径时依然可用。
 * dev 下 BASE_URL 为 './'，document.baseURI 为 http://host:5173/ → http://host:5173/sil/
 */
function resolveSilhouetteBase(): string {
  const base = import.meta.env.BASE_URL || './';
  try {
    return new URL(`${base}sil/`, document.baseURI).href;
  } catch {
    return './sil/';
  }
}

const SILHOUETTE_BASE = resolveSilhouetteBase();

/** 已解码可绘制的图片。 */
const loadedImages = new Map<string, HTMLImageElement>();
/** 进行中（或已完成）的加载任务，用于去重，避免重复请求。 */
const pendingLoads = new Map<string, Promise<string | null>>();

/** 调试钩子：把已加载成功的 id 写到 window 上，便于自测脚本断言。 */
function publishDebugHook(): void {
  try {
    window.__silLoaded = Array.from(loadedImages.keys());
  } catch {
    // window 不存在（非浏览器环境）时忽略：钩子仅用于调试。
  }
}

/** 该姿势是否有剪影素材。 */
export function hasSilhouette(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(SILHOUETTE_GEOM, id);
}

/** 取已加载的图片；未加载/加载失败返回 null。 */
export function getSilhouette(id: string): HTMLImageElement | null {
  return loadedImages.get(id) ?? null;
}

/** 当前已成功加载的剪影 id（调试/自测用）。 */
export function loadedSilhouetteIds(): string[] {
  return Array.from(loadedImages.keys());
}

/**
 * 加载单张素材。
 * @returns 成功返回 id，失败返回 null（不 reject，失败只意味着走几何人形回退）
 */
function loadSilhouette(id: string): Promise<string | null> {
  if (loadedImages.has(id)) return Promise.resolve(id);
  const inflight = pendingLoads.get(id);
  if (inflight) return inflight;

  const task = new Promise<string | null>((resolve) => {
    const image = new Image();
    image.decoding = 'async';
    let settled = false;

    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      if (ok) {
        loadedImages.set(id, image);
        publishDebugHook();
        resolve(id);
        return;
      }
      console.warn(`[silhouette] 剪影素材加载失败，该姿势回退几何人形：${id}`);
      resolve(null);
    };

    image.onload = (): void => {
      // decode() 把解码提前到首帧之前，避免第一次 drawImage 时掉帧；
      // 解码失败也当作可用（位图已在内存里），不要因此丢掉素材。
      if (typeof image.decode === 'function') {
        image.decode().then(
          () => finish(true),
          () => finish(true),
        );
      } else {
        finish(true);
      }
    };
    image.onerror = (): void => finish(false);
    image.src = `${SILHOUETTE_BASE}${id}.png`;
  });

  pendingLoads.set(id, task);
  return task;
}

/**
 * 批量预加载剪影素材。
 *
 * 单张失败既不会 reject 也不会中断其它图（`Promise.allSettled`），
 * 失败的图在绘制时由 `getSilhouette` 返回 null，调用方自动回退几何人形。
 */
export function preloadSilhouettes(ids: readonly string[]): Promise<void> {
  const tasks = ids.filter((id) => hasSilhouette(id)).map((id) => loadSilhouette(id));
  return Promise.allSettled(tasks).then(() => {
    publishDebugHook();
  });
}

// ------------------------------------------------------------------ 绘制

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 关键点是否足够支撑一次贴合绘制（长度、有限数值都要过关）。 */
function isPersonPoints(points: readonly Point[] | null | undefined): points is readonly Point[] {
  if (!points || points.length < 33) return false;
  for (const index of REQUIRED_POINTS) {
    const point = points[index];
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;
  }
  return true;
}

/**
 * 把剪影贴着真人画上去。
 *
 * 五步标定（顺序不可换，数值为真人实测结果）：
 *   1. 身高 = 关键点 y 跨度 ÷ 0.9165
 *   2. 脚底 = 最大 y + 一个鞋底厚度
 *   3. 躯干中线 = 胯中点（侧身时包围盒中心会偏）
 *   4. 横向缩放 = 真人胯宽 ÷ 素材臀宽，钳制在 ±14%
 *   5. 让素材的「胯中心」落在 (cx, bottom - 0.55·bodyH) 附近，内容底边落在脚底线
 *
 * @returns 是否完成绘制（关键点退化时返回 false，由调用方回退）
 */
function drawAligned(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  geom: SilhouetteGeometry,
  points: readonly Point[],
): boolean {
  let maxY = -Infinity;
  let minY = Infinity;
  for (const point of points) {
    if (!Number.isFinite(point.y)) continue;
    if (point.y > maxY) maxY = point.y;
    if (point.y < minY) minY = point.y;
  }
  if (!Number.isFinite(maxY) || !Number.isFinite(minY)) return false;

  // 1) 身高
  const bodyH = (maxY - minY) / LANDMARK_SPAN_OF_HEIGHT;
  if (!Number.isFinite(bodyH) || bodyH < MIN_BODY_HEIGHT_PX) return false;

  // 2) 脚底
  const bottom = maxY + SOLE_BELOW_TOES * bodyH;

  // 3) 躯干中线：胯中点
  const hipL = points[HIP_L] as Point;
  const hipR = points[HIP_R] as Point;
  const cx = (hipL.x + hipR.x) / 2;

  // 4) 横向标定：素材臀宽 == 真人胯宽
  const realHipW = Math.abs(hipL.x - hipR.x) * HIP_LANDMARK_TO_SURFACE;
  const silHipW = geom.hipOfH * bodyH;
  const sx = silHipW > 1 ? clamp(realHipW / silHipW, SCALE_MIN, SCALE_MAX) : 1;

  // 5) 绘制：内容高度 → bodyH 的比例 k。参照高度取「头顶 → 脚底」，
  //    不能用内容包围盒高度 geom.h —— 举手过顶的姿势包围盒顶是手指尖而不是头顶，
  //    用 geom.h 会把整个人按「手到脚」的高度压缩，脑袋落到真人下巴以下。
  const refH = geom.padT + geom.h - geom.headTop;
  if (!(refH > 0)) return false;
  const k = bodyH / refH;
  const imgW = geom.imgW * k * sx;
  const imgH = geom.imgH * k;
  if (!(imgW > 1) || !(imgH > 1) || !Number.isFinite(cx)) return false;

  const hipX = (geom.padL + geom.hipCx * geom.w) * k * sx; // 胯中心在图内的横向位置
  const bottomY = (geom.padT + geom.h) * k; // 内容底边在图内的纵向位置（脚底，未变）

  ctx.drawImage(image, cx - hipX, bottom - bottomY, imgW, imgH);
  return true;
}

/**
 * 无人入镜时的默认摆放：脚底压在 `DEFAULT_BOTTOM_RATIO` 画高处、身高占 0.62 画高、水平居中。
 *
 * 脚底线为什么是 0.80 而不是更低：底部压着姿势横滑条 + 快门，实测（390×844 / 430×900 /
 * 375×667 / 820×1180 四种视口）取 0.80 时脚底距离姿势条顶边分别是 75 / 86 / 39 / 142 px，
 * 最窄的 375×667 也留出 39px 呼吸；取 0.86 时 375×667 的脚底会压进姿势条 1px。
 * 极端张开的姿势再按画面宽度等比收一点（`DEFAULT_MAX_WIDTH_RATIO`），避免窄屏左右溢出。
 */
function drawDefault(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  geom: SilhouetteGeometry,
  canvasW: number,
  canvasH: number,
): boolean {
  if (!(canvasW > 1) || !(canvasH > 1)) return false;

  const targetH = canvasH * DEFAULT_HEIGHT_RATIO;
  const maxW = canvasW * DEFAULT_MAX_WIDTH_RATIO;
  // 参照高度同 drawAligned：头顶 → 脚底。这样「62% 画高」在各姿势之间才是同一个身高，
  // 而不是「手尖到脚底 62% 画高」（比耶 / 跳起会被缩得比站姿矮一截）。
  const refH = geom.padT + geom.h - geom.headTop;
  if (!(refH > 0)) return false;
  const k = Math.min(targetH / refH, maxW / geom.w);
  if (!(k > 0) || !Number.isFinite(k)) return false;

  const imgW = geom.imgW * k;
  const imgH = geom.imgH * k;
  const contentCx = (geom.padL + geom.w / 2) * k; // 内容中心在图内的横向位置
  const bottomY = (geom.padT + geom.h) * k; // 内容底边在图内的纵向位置（脚底，未变）
  const x = canvasW * 0.5 - contentCx;
  const y = canvasH * DEFAULT_BOTTOM_RATIO - bottomY;

  ctx.drawImage(image, x, y, imgW, imgH);
  return true;
}

/**
 * 绘制剪影图。
 *
 * @param ctx 目标 2d 上下文（主画布或缩略图）
 * @param id 姿势 id
 * @param points MediaPipe 33 点映射到画布像素后的坐标；null / 不合法表示无人入镜
 * @param canvasW 画布宽（CSS px）
 * @param canvasH 画布高（CSS px）
 * @returns true = 已用剪影图绘制；false = 该姿势无素材/素材未加载/关键点不足，调用方应回退 `drawFigure`
 */
export function drawSilhouetteImage(
  ctx: CanvasRenderingContext2D,
  id: string,
  points: readonly Point[] | null,
  canvasW: number,
  canvasH: number,
): boolean {
  const geom = SILHOUETTE_GEOM[id];
  const image = getSilhouette(id);

  if (isPersonPoints(points)) {
    // 检测到人但该姿势没素材（或素材加载失败）→ 交回调用方用几何人形回退
    if (!geom || !image) return false;
    return drawAligned(ctx, image, geom, points);
  }

  // 无人入镜：只有当前姿势自己有素材才画剪影；没素材就交回 drawFigure，
  // 否则会画出「别的姿势」的剪影 —— 用户选了 A 却看到 B，比不显示更糟。
  if (!geom || !image) return false;
  return drawDefault(ctx, image, geom, canvasW, canvasH);
}

declare global {
  interface Window {
    /** 已成功加载的剪影 id（自测/调试钩子）。 */
    __silLoaded?: string[];
  }
}

// 初始化调试钩子，保证自测脚本在加载完成前也能读到（空数组）。
publishDebugHook();
