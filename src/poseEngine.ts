/**
 * 关键点工具层：坐标映射、角度计算、人体框、指数平滑。
 *
 * MediaPipe Pose 输出 33 个归一化关键点（0~1，相对 video 原始画面）。
 * video 用 object-fit: cover 铺满容器会产生裁切，所以「归一化坐标 * 画布尺寸」是错的，
 * 必须先算 cover 缩放，见 computeCoverMapping / mapPoint。
 */

import type { BBox, CoverMapping, Landmark, Point } from './types';

/** 常用关键点索引。 */
export const LM = {
  NOSE: 0,
  LEFT_EYE: 2,
  RIGHT_EYE: 5,
  LEFT_EAR: 7,
  RIGHT_EAR: 8,
  LEFT_SHOULDER: 11,
  RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13,
  RIGHT_ELBOW: 14,
  LEFT_WRIST: 15,
  RIGHT_WRIST: 16,
  LEFT_HIP: 23,
  RIGHT_HIP: 24,
  LEFT_KNEE: 25,
  RIGHT_KNEE: 26,
  LEFT_ANKLE: 27,
  RIGHT_ANKLE: 28,
  LEFT_FOOT_INDEX: 31,
  RIGHT_FOOT_INDEX: 32,
} as const;

/** 实测骨骼连线（与 Pose 官方 POSE_CONNECTIONS 一致）。 */
export const BONE_CONNECTIONS: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 7],
  [0, 4],
  [4, 5],
  [5, 6],
  [6, 8],
  [9, 10],
  [11, 12],
  [11, 13],
  [13, 15],
  [15, 17],
  [15, 19],
  [15, 21],
  [17, 19],
  [12, 14],
  [14, 16],
  [16, 18],
  [16, 20],
  [16, 22],
  [18, 20],
  [11, 23],
  [12, 24],
  [23, 24],
  [23, 25],
  [24, 26],
  [25, 27],
  [26, 28],
  [27, 29],
  [28, 30],
  [29, 31],
  [30, 32],
  [27, 31],
  [28, 32],
];

/**
 * 剪影/缩略图用的骨架连线（去掉面部与手指，只留躯干四肢）。
 * 注意：这里刻意不含「鼻尖 → 肩」两条斜线 —— 那会在头部下方画出一个三角形，
 * 视觉上像「山」/披风。脖子由绘制方用 NECK_TOP → NECK_BOTTOM 单独补一条竖线。
 */
export const TEMPLATE_BONES: ReadonlyArray<readonly [number, number]> = [
  [11, 12],
  [11, 13],
  [13, 15],
  [12, 14],
  [14, 16],
  [11, 23],
  [12, 24],
  [23, 24],
  [23, 25],
  [25, 27],
  [27, 31],
  [24, 26],
  [26, 28],
  [28, 32],
];

/** 颈部起点（下巴下方一点，模板坐标：原点=鼻尖，单位=头高）。 */
export const NECK_TOP: readonly [number, number] = [0, 0.55];

/** 颈部终点（两肩中点）。 */
export const NECK_BOTTOM: readonly [number, number] = [0, 1.0];

/**
 * 计算 object-fit: cover 的缩放与偏移。
 * @param cw 画布（容器）显示宽度，CSS px
 * @param ch 画布（容器）显示高度，CSS px
 * @param vw video 实际宽度（videoWidth）
 * @param vh video 实际高度（videoHeight）
 */
export function computeCoverMapping(cw: number, ch: number, vw: number, vh: number): CoverMapping {
  if (!(cw > 0) || !(ch > 0) || !(vw > 0) || !(vh > 0)) {
    return { scale: 1, dw: Math.max(1, cw), dh: Math.max(1, ch), ox: 0, oy: 0 };
  }
  const scale = Math.max(cw / vw, ch / vh);
  const dw = vw * scale;
  const dh = vh * scale;
  return { scale, dw, dh, ox: (cw - dw) / 2, oy: (ch - dh) / 2 };
}

/** 归一化点 → 画布像素点。 */
export function mapPoint(point: { x: number; y: number }, mapping: CoverMapping): Point {
  return {
    x: point.x * mapping.dw + mapping.ox,
    y: point.y * mapping.dh + mapping.oy,
  };
}

/** 批量映射。 */
export function mapLandmarks(landmarks: Landmark[], mapping: CoverMapping): Point[] {
  return landmarks.map((landmark) => mapPoint(landmark, mapping));
}

/** 两点距离。 */
export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** 两点中点。 */
export function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/**
 * 三点夹角（度），b 为顶点。返回 0~180。
 * 任一边退化时返回 180（视为伸直），避免产生假提示。
 */
export function angleDeg(a: Point, b: Point, c: Point): number {
  const abx = a.x - b.x;
  const aby = a.y - b.y;
  const cbx = c.x - b.x;
  const cby = c.y - b.y;
  const magA = Math.hypot(abx, aby);
  const magC = Math.hypot(cbx, cby);
  if (magA < 1e-6 || magC < 1e-6) return 180;
  const cosine = (abx * cbx + aby * cby) / (magA * magC);
  const clamped = Math.min(1, Math.max(-1, cosine));
  return (Math.acos(clamped) * 180) / Math.PI;
}

/** 关键点是否可用（坐标有效且可见度达标）。 */
export function isVisible(landmark: Landmark | undefined, minVisibility = 0.3): boolean {
  if (!landmark) return false;
  if (!Number.isFinite(landmark.x) || !Number.isFinite(landmark.y)) return false;
  // 部分设备/版本返回全 0 的占位点
  if (landmark.x === 0 && landmark.y === 0) return false;
  const visibility = landmark.visibility;
  if (typeof visibility === 'number' && Number.isFinite(visibility)) {
    return visibility >= minVisibility;
  }
  return true;
}

/**
 * 「头高」像素值：鼻尖到两肩中点的距离。
 * 这是姿势模板的尺度单位，与分辨率、人物远近解耦。
 */
export function headUnitPx(points: Point[]): number {
  const nose = points[LM.NOSE];
  const leftShoulder = points[LM.LEFT_SHOULDER];
  const rightShoulder = points[LM.RIGHT_SHOULDER];
  if (!nose || !leftShoulder || !rightShoulder) return 0;
  const unit = distance(nose, midpoint(leftShoulder, rightShoulder));
  return Number.isFinite(unit) ? unit : 0;
}

/**
 * 人体框（归一化坐标 0~1），用于构图规则。
 * 关键点全部 clamp 到 [0,1] 之后再算宽高：人物半出画时（例如脚已经压到画面外，
 * 关键点 y 会 > 1）不 clamp 会把框"撑大"，让人物高度占比误判成「人太大」。
 */
export function bodyBox(landmarks: Landmark[]): BBox | null {
  const indexes = [0, 7, 8, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28, 31, 32];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let count = 0;
  for (const index of indexes) {
    const landmark = landmarks[index];
    if (!isVisible(landmark, 0.25)) continue;
    const point = landmark as Landmark;
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
    count += 1;
  }
  if (count < 4 || !Number.isFinite(minX) || !Number.isFinite(maxX)) return null;

  const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
  const x = clamp01(minX);
  const y = clamp01(minY);
  const right = clamp01(maxX);
  const bottom = clamp01(maxY);
  const w = Math.max(0.001, right - x);
  const h = Math.max(0.001, bottom - y);
  return { x, y, w, h, cx: x + w / 2, cy: y + h / 2 };
}

/** 指数平滑，减少关键点抖动。 */
export class LandmarkSmoother {
  private previous: Landmark[] | null = null;

  constructor(private readonly alpha: number = 0.5) {}

  /** 输入一帧原始关键点，返回平滑后的关键点（首帧直接透传）。 */
  update(next: Landmark[]): Landmark[] {
    if (!next || next.length === 0) {
      this.previous = null;
      return [];
    }
    const previous = this.previous;
    if (!previous || previous.length !== next.length) {
      const copy = next.map((landmark) => ({ ...landmark }));
      this.previous = copy;
      return copy;
    }
    const alpha = Math.min(0.95, Math.max(0.05, this.alpha));
    const smoothed: Landmark[] = next.map((landmark, index) => {
      const before = previous[index] as Landmark;
      const beforeVisibility = before.visibility ?? 1;
      const currentVisibility = landmark.visibility ?? 1;
      return {
        x: before.x + (landmark.x - before.x) * alpha,
        y: before.y + (landmark.y - before.y) * alpha,
        z: (before.z ?? 0) + ((landmark.z ?? 0) - (before.z ?? 0)) * alpha,
        visibility: beforeVisibility + (currentVisibility - beforeVisibility) * alpha,
      };
    });
    this.previous = smoothed;
    return smoothed;
  }

  /** 丢失目标后调用，避免下次出现时从旧位置"滑"过来。 */
  reset(): void {
    this.previous = null;
  }
}
