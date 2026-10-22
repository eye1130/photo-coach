/**
 * 人形「简笔画」绘制。
 *
 * 演进过程（每一版都是用户真机反馈逼出来的）：
 *   1. 火柴人 —— 关节中心连线，只有一根线宽，永远"套不住"人；
 *   2. 纸片人 —— 粗描边 + 实心胶囊四肢，边界清楚了，但像"充气人"；
 *   3. 简笔画 —— 所有部位都是「一圈细轮廓 + 5% 淡填充」，线是线、体积靠淡色提示。
 *
 * 关键取舍（用户原话）："就算手在身体前面，也是简单两笔轮廓就 ok 了"。
 * 所以**不做遮挡裁剪** —— 手压在躯干上就直接叠着画，轮廓线交叉反而像手绘示意。
 * 处理遮挡要引入逐段 z 序和裁剪，成本极高，收益为零。
 *
 * 另一条规矩：**所有描边宽度一致**。原来按部位给不同线宽（关节还画实心圆点），
 * 视觉上就变成一堆粗细不一的香肠；统一线宽才有"笔"的感觉。
 */
import type { Point } from './types';

export const FIGURE_STYLE = {
  /** 轮廓色（亮）——用户靠它判断"我该站到哪条边" */
  edge: 'rgba(126, 216, 255, 1)',
  /** 内部填充：用户实测 30% → 20% → 5%，只留一点"体积感" */
  fill: 'rgba(126, 216, 255, 0.05)',
  /** 描边宽度 = 头高 × 该系数（手机上 1 头高约 70~100px → 线宽 3~5px） */
  lineOfH: 0.075,
  /** 线宽下限，防止头很小时线消失 */
  minLine: 1.6,
  /**
   * 各部位**直径**（单位 = 头高），按真人实测比例，保证轮廓能卡住人。
   * 注意：这组值从「实心胶囊」时代调过一次 —— 实心时 0.21 看着正合适，
   * 改成细轮廓后同样的数字会瘦成竹竿，所以整体上浮约 30%。
   */
  width: {
    upperArm: 0.25,
    foreArm: 0.19,
    thigh: 0.34,
    shin: 0.27,
    neck: 0.3,
    hand: 0.13,
    foot: 0.16,
  },
  /** 头部椭圆（单位 = 头高）：真人头高 > 头宽，正圆包不住 */
  head: { rx: 0.32, ry: 0.5, cy: -0.06 },
  /** 腰部收窄系数（相对肩半宽）。真人女性腰宽约肩宽的 0.62，不收腰就是方纸箱 */
  waistOfShoulder: 0.62,
} as const;

const IDX = {
  shL: 11,
  shR: 12,
  elL: 13,
  elR: 14,
  wrL: 15,
  wrR: 16,
  hipL: 23,
  hipR: 24,
  knL: 25,
  knR: 26,
  anL: 27,
  anR: 28,
  toeL: 31,
  toeR: 32,
} as const;

export interface FigureOptions {
  edge?: string;
  fill?: string;
  /** 覆盖线宽（像素），缩略图这类小尺寸用 */
  lineWidth?: number;
  /** 只画轮廓不填充（缩略图用，5% 在 44px 下等于没有） */
  outlineOnly?: boolean;
  /**
   * 四肢画法：
   *  - 'line'    —— 有粗细的圆头线条，身体保留轮廓。最像简笔画小人，线条最少；
   *  - 'outline' —— 和身体一样用「轮廓 + 淡填充」，更像解剖示意，但关节处
   *                 两段胶囊的圆弧会叠出"竹节"感，线也多。
   */
  limbs?: 'line' | 'outline';
}

/**
 * 在 canvas 上画一个简笔画人形。
 * @param points 关键点（模板坐标系：原点=鼻尖，单位=头高）
 * @param origin 鼻尖在画布上的像素位置
 * @param unit 一个「头高」对应多少像素
 */
export function drawFigure(
  ctx: CanvasRenderingContext2D,
  points: Record<number, [number, number]>,
  origin: Point,
  unit: number,
  options: FigureOptions = {},
): void {
  const edge = options.edge ?? FIGURE_STYLE.edge;
  const fill = options.fill ?? FIGURE_STYLE.fill;
  const line = options.lineWidth ?? Math.max(FIGURE_STYLE.minLine, unit * FIGURE_STYLE.lineOfH);
  const W = FIGURE_STYLE.width;

  const px = (index: number): Point | null => {
    const point = points[index];
    if (!point) return null;
    return { x: origin.x + point[0] * unit, y: origin.y + point[1] * unit };
  };

  const shL = px(IDX.shL);
  const shR = px(IDX.shR);
  const hipL = px(IDX.hipL);
  const hipR = px(IDX.hipR);
  if (!shL || !shR || !hipL || !hipR) return;

  const elL = px(IDX.elL);
  const elR = px(IDX.elR);
  const wrL = px(IDX.wrL);
  const wrR = px(IDX.wrR);
  const knL = px(IDX.knL);
  const knR = px(IDX.knR);
  const anL = px(IDX.anL);
  const anR = px(IDX.anR);
  const toeL = px(IDX.toeL);
  const toeR = px(IDX.toeR);

  /** 头高单位 → 像素直径 */
  const dia = (v: number): number => v * unit;

  // ── 所有部位先算成 path，再统一两遍绘制 ────────────────────────
  // 先填充后描边：否则后画的填充会盖掉先画的轮廓线，交叉处断线很难看。
  const paths: Array<() => void> = [];
  /** 四肢线（limbs='line' 模式用）：a→b 的圆头粗线 */
  const limbLines: Array<{ a: Point; b: Point; w: number }> = [];
  const limbs = options.limbs ?? 'line';

  /** 胶囊轮廓：两端半圆 + 两条切线，这是「一段肢体」最省事的画法 */
  const capsule = (a: Point | null, b: Point | null, width: number): void => {
    if (!a || !b) return;
    const r = dia(width) / 2;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 0.01) {
      paths.push(() => {
        ctx.beginPath();
        ctx.arc(a.x, a.y, r, 0, Math.PI * 2);
        ctx.closePath();
      });
      return;
    }
    const ang = Math.atan2(dy, dx);
    paths.push(() => {
      ctx.beginPath();
      // a 端半圆绕「背面」（远离 b 那侧），b 端半圆绕「前方」
      ctx.arc(a.x, a.y, r, ang + Math.PI / 2, ang + Math.PI * 1.5, false);
      ctx.arc(b.x, b.y, r, ang - Math.PI / 2, ang + Math.PI / 2, false);
      ctx.closePath();
    });
  };

  /** 一段肢体：按模式决定走胶囊轮廓还是粗线 */
  const limb = (a: Point | null, b: Point | null, width: number): void => {
    if (!a || !b) return;
    if (limbs === 'outline') {
      capsule(a, b, width);
    } else {
      limbLines.push({ a, b, w: dia(width) });
    }
  };

  const ellipse = (cx: number, cy: number, rx: number, ry: number): void => {
    paths.push(() => {
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      ctx.closePath();
    });
  };

  // 头
  ellipse(
    origin.x,
    origin.y + FIGURE_STYLE.head.cy * unit,
    FIGURE_STYLE.head.rx * unit,
    FIGURE_STYLE.head.ry * unit,
  );

  // 脖子：下巴到肩中点
  const shoulderMid: Point = { x: (shL.x + shR.x) / 2, y: (shL.y + shR.y) / 2 };
  const chin: Point = { x: origin.x, y: origin.y + 0.42 * unit };
  capsule(chin, shoulderMid, W.neck);

  // 躯干：肩 → 腰 → 胯，两侧用曲线收腰。
  // 只用四个角连直线的话是个"空心方框"，看着像纸箱而不是人。
  // 顶部仍然走斜肩（直接连水平线会变成硬纸板背心）。
  paths.push(() => {
    const topY = shoulderMid.y - 0.03 * unit;
    // 颈根位置：从肩峰向中线插值。⚠️ 必须相对 origin 插值 ——
    // 原来写成 shL.x * 0.42（直接拿画布绝对坐标乘），整条肩线被甩到画布左边，
    // 每个姿势都拖出一条横穿身体的粗线。
    const lerpToMid = (x: number): number => origin.x + (x - origin.x) * 0.38;
    // 腰：高度取躯干 62% 处，半宽按肩半宽收缩
    const waistY = shoulderMid.y + (hipL.y - shoulderMid.y) * 0.62;
    const waistHalf = (Math.abs(shL.x - origin.x) || unit) * FIGURE_STYLE.waistOfShoulder;
    const waistL = origin.x + waistHalf;
    const waistR = origin.x - waistHalf;
    const midY = (shL.y + waistY) / 2;

    ctx.beginPath();
    ctx.moveTo(shL.x, shL.y);
    ctx.lineTo(lerpToMid(shL.x), topY);
    ctx.lineTo(lerpToMid(shR.x), topY);
    ctx.lineTo(shR.x, shR.y);
    // 右侧：肩 → 腰（收）→ 胯（再展开）
    ctx.quadraticCurveTo(shR.x, midY, waistR, waistY);
    ctx.quadraticCurveTo(hipR.x, waistY + (hipR.y - waistY) * 0.5, hipR.x, hipR.y);
    ctx.lineTo(hipL.x, hipL.y);
    // 左侧镜像
    ctx.quadraticCurveTo(hipL.x, waistY + (hipL.y - waistY) * 0.5, waistL, waistY);
    ctx.quadraticCurveTo(shL.x, midY, shL.x, shL.y);
    ctx.closePath();
  });

  // 手臂：肩 → 肘 → 腕
  limb(shL, elL, W.upperArm);
  limb(elL, wrL, W.foreArm);
  limb(shR, elR, W.upperArm);
  limb(elR, wrR, W.foreArm);

  // 手：一个小圆
  if (wrL) ellipse(wrL.x, wrL.y, dia(W.hand) / 2, dia(W.hand) / 2);
  if (wrR) ellipse(wrR.x, wrR.y, dia(W.hand) / 2, dia(W.hand) / 2);

  // 腿：胯 → 膝 → 踝
  limb(hipL, knL, W.thigh);
  limb(knL, anL, W.shin);
  limb(hipR, knR, W.thigh);
  limb(knR, anR, W.shin);

  // 脚：踝 → 脚尖。
  // 模板里没有 31/32（toe）点，直接用踝会画到脚踝就断了，人像"截肢"。
  // 缺脚尖时按踝往下偏外补一小段，长度约 0.3 头高，正好一个人的脚长。
  const footL: Point | null = toeL ?? (anL ? { x: anL.x + 0.06 * unit, y: anL.y + 0.3 * unit } : null);
  const footR: Point | null = toeR ?? (anR ? { x: anR.x - 0.06 * unit, y: anR.y + 0.3 * unit } : null);
  limb(anL, footL, W.foot);
  limb(anR, footR, W.foot);

  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  // 第一遍：淡填充
  if (!options.outlineOnly) {
    ctx.fillStyle = fill;
    for (const path of paths) {
      path();
      ctx.fill();
    }
  }

  // 第二遍：统一线宽的轮廓线，压在所有填充之上
  ctx.strokeStyle = edge;
  ctx.lineWidth = line;
  for (const path of paths) {
    path();
    ctx.stroke();
  }

  // 第三遍：四肢粗线放在最上层 —— 手抱在胸前、插兜这类姿势本来就是手臂压躯干，
  // 压反了看起来像手臂长在背后。
  if (limbLines.length > 0) {
    ctx.strokeStyle = limbs === 'line' ? edge : fill;
    for (const seg of limbLines) {
      ctx.lineWidth = seg.w;
      ctx.beginPath();
      ctx.moveTo(seg.a.x, seg.a.y);
      ctx.lineTo(seg.b.x, seg.b.y);
      ctx.stroke();
    }
  }

  ctx.restore();
}

/** 计算一组模板点的包围盒（用于缩略图自适应）。 */
export function figureBounds(points: Record<number, [number, number]>): {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
} {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const key of Object.keys(points)) {
    const point = points[Number(key)];
    if (!point) continue;
    if (point[0] < minX) minX = point[0];
    if (point[0] > maxX) maxX = point[0];
    if (point[1] < minY) minY = point[1];
    if (point[1] > maxY) maxY = point[1];
  }
  if (!Number.isFinite(minX)) return { minX: 0, maxX: 0, minY: 0, maxY: 0 };
  return { minX, maxX, minY, maxY };
}
