/**
 * 叠加层绘制：三分网格 / 姿势剪影 / 实测骨骼 / 水平仪 / 提示气泡。
 *
 * 每帧全量重绘（clearRect + draw），不维护增量状态，逻辑简单且不会残留。
 * canvas 的 width/height 按 devicePixelRatio 放大，绘制前 ctx.scale(dpr, dpr)，
 * 这样所有绘制坐标都用 CSS px，与 getBoundingClientRect 一致。
 */

import type { Landmark, OverlayState, Point, PoseTemplate } from './types';
import {
  BONE_CONNECTIONS,
  LM,
  computeCoverMapping,
  headUnitPx,
  isVisible,
  mapLandmarks,
} from './poseEngine';
import { drawFigure } from './figure';
import { drawSilhouetteImage } from './silhouette';

const GRID_COLOR = 'rgba(255, 255, 255, 0.2)';
const GRID_ACCENT = 'rgba(255, 255, 255, 0.42)';
const BONE_COLOR = 'rgba(78, 230, 168, 0.95)';
const BONE_GLOW = 'rgba(78, 230, 168, 0.5)';
const JOINT_COLOR = 'rgba(255, 255, 255, 0.96)';
const LEVEL_OK = '#4ee6a8';
const LEVEL_WARN = '#ffb648';

/**
 * 剪影的配色、部位宽度、头部椭圆全部在 `figure.ts` 的 FIGURE_STYLE 里维护，
 * 主画布与底部缩略图共用同一份参数，保证「选的那个」和「看到的那个」是同一个形状。
 */

/** 提示气泡：出现动画时长 / 停留时间 / 淡出时长。 */
const HINT_APPEAR_MS = 240;
const HINT_HOLD_MS = 1200;
const HINT_FADE_MS = 420;

export class Overlay {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private width = 0;
  private height = 0;
  private dpr = 1;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法创建 canvas 2d 上下文');
    this.ctx = ctx;
    this.resize();
  }

  /** 容器尺寸或 dpr 变化时调用。 */
  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width || window.innerWidth));
    const height = Math.max(1, Math.round(rect.height || window.innerHeight));
    this.dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    this.width = width;
    this.height = height;
    this.canvas.width = Math.round(width * this.dpr);
    this.canvas.height = Math.round(height * this.dpr);
  }

  /** 渲染一帧。 */
  render(state: OverlayState): void {
    const { ctx } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);

    if (state.showGrid) {
      this.drawGrid();
    }

    const mapping = computeCoverMapping(this.width, this.height, state.videoWidth, state.videoHeight);
    const points =
      state.landmarks && state.landmarks.length >= 33 && state.videoWidth > 0
        ? mapLandmarks(state.landmarks, mapping)
        : null;

    if (state.showSilhouette && state.template) {
      this.drawSilhouette(state.template, points);
    }
    if (state.showSkeleton && points && state.landmarks) {
      this.drawSkeleton(points, state.landmarks);
    }
    if (state.tiltDeg !== null && Number.isFinite(state.tiltDeg)) {
      this.drawLevel(state.tiltDeg);
    }
    if (state.hint) {
      this.drawBubble(state.hint.text, state.hint.shownAt, state.hint.lastSeenAt);
    }
  }

  // ------------------------------------------------------------------ 网格

  private drawGrid(): void {
    const { ctx } = this;
    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = GRID_COLOR;
    ctx.beginPath();
    for (const ratio of [1 / 3, 2 / 3]) {
      ctx.moveTo(this.width * ratio, 0);
      ctx.lineTo(this.width * ratio, this.height);
      ctx.moveTo(0, this.height * ratio);
      ctx.lineTo(this.width, this.height * ratio);
    }
    ctx.stroke();

    // 中心十字，便于判断人物是否居中
    const cx = this.width / 2;
    const cy = this.height / 2;
    ctx.strokeStyle = GRID_ACCENT;
    ctx.beginPath();
    ctx.moveTo(cx - 10, cy);
    ctx.lineTo(cx + 10, cy);
    ctx.moveTo(cx, cy - 10);
    ctx.lineTo(cx, cy + 10);
    ctx.stroke();
    ctx.restore();
  }

  // ------------------------------------------------------------ 姿势剪影

  /**
   * 绘制参考剪影。
   *
   * 两条渲染路径，优先用「真实人体轮廓图片」：
   *   1. `drawSilhouetteImage`：素材已标定的真实轮廓 PNG，按实测关键点贴合（胯宽定横向、
   *      关键点跨度定纵向、胯中点定中线）。有素材的 9 个姿势走这里。
   *   2. `drawFigure`：几何人形回退。其余 18 个姿势没有素材、或素材加载失败时使用，
   *      保证任何情况下画面上都有人形可参考（绝不白屏）。
   *
   * 几何人形分支：检测到人时按实测头高缩放并贴合到人物位置；没人入镜时按三分法居中显示默认站姿。
   */
  private drawSilhouette(template: PoseTemplate, points: Point[] | null): void {
    const { ctx } = this;

    // 优先：真实人体轮廓图（内部已处理「无人入镜」的默认摆放）
    if (drawSilhouetteImage(ctx, template.id, points, this.width, this.height)) return;

    // 回退：程序化几何人形
    const nose = points ? points[LM.NOSE] : undefined;
    const measuredUnit = points ? headUnitPx(points) : 0;
    const detected = !!nose && Number.isFinite(measuredUnit) && measuredUnit > 8;

    // 没人入镜时的默认剪影：略缩小并上移，别压到底部姿势条
    const origin: Point = detected && nose ? nose : { x: this.width * 0.5, y: this.height * 0.3 };
    const unit = detected ? measuredUnit : Math.max(22, this.height * 0.072);

    drawFigure(ctx, template.points, origin, unit);
  }

  // -------------------------------------------------------------- 实测骨骼

  private drawSkeleton(points: Point[], landmarks: Landmark[]): void {
    const { ctx } = this;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.shadowColor = BONE_GLOW;
    ctx.shadowBlur = 8;
    ctx.strokeStyle = BONE_COLOR;
    ctx.lineWidth = 3.2;
    ctx.beginPath();
    for (const [a, b] of BONE_CONNECTIONS) {
      if (!isVisible(landmarks[a], 0.3) || !isVisible(landmarks[b], 0.3)) continue;
      const from = points[a];
      const to = points[b];
      if (!from || !to) continue;
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
    }
    ctx.stroke();

    ctx.shadowBlur = 0;
    ctx.fillStyle = JOINT_COLOR;
    for (let index = 0; index < points.length; index += 1) {
      if (!isVisible(landmarks[index], 0.3)) continue;
      const point = points[index];
      if (!point) continue;
      ctx.beginPath();
      ctx.arc(point.x, point.y, 3.2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------- 水平仪

  private drawLevel(tiltDeg: number): void {
    const { ctx } = this;
    const centerX = this.width / 2;
    const centerY = Math.max(this.height * 0.5, this.height - 168);
    const trackWidth = Math.min(180, this.width * 0.46);
    const leveled = Math.abs(tiltDeg) <= 3;
    const half = trackWidth / 2;

    ctx.save();

    // 轨道
    this.roundRect(centerX - half, centerY - 12, trackWidth, 24, 12);
    ctx.fillStyle = 'rgba(8, 12, 18, 0.5)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // 居中容差区
    const zone = trackWidth * 0.16;
    ctx.fillStyle = 'rgba(78, 230, 168, 0.2)';
    ctx.fillRect(centerX - zone / 2, centerY - 9, zone, 18);

    // 中心刻度
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
    ctx.beginPath();
    ctx.moveTo(centerX, centerY - 7);
    ctx.lineTo(centerX, centerY + 7);
    ctx.stroke();

    // 气泡
    const limit = half - 14;
    const offset = Math.max(-limit, Math.min(limit, tiltDeg * 6));
    ctx.beginPath();
    ctx.arc(centerX + offset, centerY, 8, 0, Math.PI * 2);
    ctx.fillStyle = leveled ? LEVEL_OK : LEVEL_WARN;
    ctx.fill();
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.35)';
    ctx.stroke();

    ctx.restore();
  }

  // ------------------------------------------------------------ 提示气泡

  private drawBubble(text: string, shownAt: number, lastSeenAt: number): void {
    const now = performance.now();
    const appearProgress = Math.min(1, Math.max(0, (now - shownAt) / HINT_APPEAR_MS));
    const ease = 1 - Math.pow(1 - appearProgress, 3);

    const idle = now - lastSeenAt;
    let alpha = 1;
    if (idle > HINT_HOLD_MS) {
      alpha = Math.max(0, 1 - (idle - HINT_HOLD_MS) / HINT_FADE_MS);
    }
    if (alpha <= 0.02) return;

    const { ctx } = this;
    const fontSize = this.width < 420 ? 19 : 22;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = `600 ${fontSize}px "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const maxBoxWidth = Math.min(this.width * 0.8, 460);
    const paddingX = 20;
    const lines = this.wrapText(text, maxBoxWidth - paddingX * 2);
    const lineHeight = fontSize * 1.42;
    const textWidth = lines.reduce((widest, line) => Math.max(widest, ctx.measureText(line).width), 0);
    const boxWidth = Math.min(maxBoxWidth, textWidth + paddingX * 2);
    const boxHeight = lines.length * lineHeight + 22;
    const centerX = this.width / 2;
    const boxTop = Math.max(this.height * 0.1, this.height * 0.16 - boxHeight / 2 + (1 - ease) * 14);
    const boxLeft = centerX - boxWidth / 2;

    this.roundRect(boxLeft, boxTop, boxWidth, boxHeight, 18);
    ctx.fillStyle = 'rgba(8, 12, 18, 0.74)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.16)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    const firstLineY = boxTop + 11 + lineHeight / 2;
    lines.forEach((line, index) => {
      ctx.fillText(line, centerX, firstLineY + index * lineHeight);
    });
    ctx.restore();
  }

  /** 按字符换行（中文逐字断行效果最好）。 */
  private wrapText(text: string, maxWidth: number): string[] {
    const { ctx } = this;
    const lines: string[] = [];
    let current = '';
    for (const char of Array.from(text)) {
      const candidate = current + char;
      if (current && ctx.measureText(candidate).width > maxWidth) {
        lines.push(current);
        current = char;
      } else {
        current = candidate;
      }
    }
    if (current) lines.push(current);
    return lines.length > 0 ? lines : [text];
  }

  /** 圆角矩形路径（不依赖 CanvasRenderingContext2D.roundRect，兼容老 Safari）。 */
  private roundRect(x: number, y: number, width: number, height: number, radius: number): void {
    const { ctx } = this;
    const r = Math.min(radius, width / 2, height / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + width - r, y);
    ctx.arcTo(x + width, y, x + width, y + r, r);
    ctx.lineTo(x + width, y + height - r);
    ctx.arcTo(x + width, y + height, x + width - r, y + height, r);
    ctx.lineTo(x + r, y + height);
    ctx.arcTo(x, y + height, x, y + height - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
  }
}
