/**
 * 全项目共用类型定义。
 */

/** 二维点（像素坐标 / 归一化坐标都由调用方约定）。 */
export interface Point {
  x: number;
  y: number;
}

/** MediaPipe Pose 的单个关键点，坐标归一化到 0~1（相对 video 画面）。 */
export interface Landmark {
  x: number;
  y: number;
  z?: number;
  visibility?: number;
}

/** 人体框（归一化坐标，0~1）。 */
export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
  cx: number;
  cy: number;
}

/** video 用 object-fit: cover 铺满容器时的缩放/偏移参数。 */
export interface CoverMapping {
  scale: number;
  dw: number;
  dh: number;
  ox: number;
  oy: number;
}

/** 三点夹角规则：以 b 为顶点，target 为目标角度（度），tol 为允许偏差。 */
export interface PoseAngleRule {
  a: number;
  b: number;
  c: number;
  target: number;
  tol: number;
  hint: string;
}

/** 关键点位置规则：target 为骨架坐标系下的目标位置（单位=头高）。 */
export interface PosePositionRule {
  point: number;
  target: [number, number];
  tol: number;
  hint: string;
}

/** 两点距离规则：用来判断肩膀跨度（侧身时跨度会显著变小）。 */
export interface PoseSpanRule {
  a: number;
  b: number;
  target: number;
  tol: number;
  hint: string;
}

/**
 * 姿势模板：剪影绘制与偏差检测共用同一份数据。
 * points 使用「相对骨架坐标」：原点 = 鼻尖，y 向下为正，单位 = 头高（鼻尖到两肩中点的距离）。
 * 注意：为了与实测关键点直接可比，奇数是「被拍者的左侧」，在画面中位于右侧（人物面向镜头）。
 */
export interface PoseTemplate {
  id: string;
  name: string;
  /** 所属场景，用于底部横滑条分组。 */
  scene: 'street' | 'cafe' | 'outdoor';
  description: string;
  points: Record<number, [number, number]>;
  angles?: PoseAngleRule[];
  positions?: PosePositionRule[];
  spans?: PoseSpanRule[];
}

/** 一条待展示的提示（高优先级优先显示）。 */
export interface HintCandidate {
  id: string;
  text: string;
  /** 1 = 最高优先级。构图规则 1~6，姿势偏差 7。 */
  priority: number;
}

/** 叠加层需要的提示状态（含出现/淡出时间戳）。 */
export interface OverlayHint {
  text: string;
  /** 开始显示的时间戳（performance.now）。 */
  shownAt: number;
  /** 最后一次仍然成立的时间戳，用于延迟淡出。 */
  lastSeenAt: number;
}

/** 叠加层渲染状态。 */
export interface OverlayState {
  landmarks: Landmark[] | null;
  hint: OverlayHint | null;
  template: PoseTemplate | null;
  showGrid: boolean;
  showSkeleton: boolean;
  showSilhouette: boolean;
  tiltDeg: number | null;
  videoWidth: number;
  videoHeight: number;
}

/** 右侧四个开关的键名。 */
export type ToggleKey = 'grid' | 'skeleton' | 'silhouette' | 'voice';

/** MediaPipe Pose legacy 实例的最小类型描述（官方 bundle 无类型声明）。 */
export interface PoseInstance {
  setOptions(options: Record<string, unknown>): void;
  onResults(callback: (results: PoseResults) => void): void;
  initialize(): Promise<void>;
  send(input: { image: HTMLVideoElement | HTMLCanvasElement | HTMLImageElement }): Promise<void>;
  close(): Promise<void>;
  reset(): void;
}

export interface PoseResults {
  poseLandmarks?: Landmark[];
  poseWorldLandmarks?: Landmark[];
}

declare global {
  interface Window {
    /** public/mp/pose.js 注入的全局构造函数。 */
    Pose?: new (config?: { locateFile?: (file: string) => string }) => PoseInstance;
    POSE_CONNECTIONS?: number[][];
  }
}
