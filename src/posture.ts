/**
 * 姿势偏差检测。
 *
 * 姿势数据本身在 `poseLibrary.ts`（参数化骨架 + IK 解算，18 个姿势 / 3 个场景）。
 * 这里只负责：拿当前模板与实测关键点比对，产出「最需要纠正的那一条」提示。
 */
import type { HintCandidate, Landmark, Point, PoseTemplate } from './types';
import { angleDeg, headUnitPx, isVisible, LM } from './poseEngine';
import { POSE_TEMPLATES } from './poseLibrary';

export { POSE_TEMPLATES };
export { SCENES, posesOfScene, type SceneId } from './poseLibrary';

/** 姿势偏差的优先级（构图规则 1~6 之后）。 */
const POSTURE_PRIORITY = 7;

/** 归一化偏差分数的下限：低于该值视为噪声，不打扰用户。 */
const MIN_SCORE = 0.25;

/** 按 id 取模板，找不到时返回第一个（保证 UI 永远有选中项）。 */
export function findTemplate(id: string): PoseTemplate {
  const found = POSE_TEMPLATES.find((template) => template.id === id);
  const fallback = POSE_TEMPLATES[0];
  if (found) return found;
  if (fallback) return fallback;
  throw new Error('姿势库为空');
}

interface Scored {
  score: number;
  candidate: HintCandidate;
}

/**
 * 对比模板与实测关键点，返回偏差最大的一条提示；没有明显偏差时返回 null。
 * @param template 当前选中的姿势
 * @param landmarks 归一化关键点（33 个）
 * @param videoWidth video 原始宽度
 * @param videoHeight video 原始高度
 * @param excludeId 需要跳过的高优先级提示 id（已连续显示过久时由调用方传入）
 */
export function evaluatePosture(
  template: PoseTemplate | null,
  landmarks: Landmark[] | null,
  videoWidth: number,
  videoHeight: number,
  excludeId?: string | null,
): HintCandidate | null {
  if (!template || !landmarks || landmarks.length < 33) return null;

  const vw = videoWidth > 0 ? videoWidth : 1280;
  const vh = videoHeight > 0 ? videoHeight : 720;
  const points: Point[] = landmarks.map((landmark) => ({ x: landmark.x * vw, y: landmark.y * vh }));

  const nose = points[LM.NOSE];
  const unit = headUnitPx(points);
  if (!nose || !Number.isFinite(unit) || unit < 6) return null;

  const toTemplateSpace = (point: Point): Point => ({
    x: (point.x - nose.x) / unit,
    y: (point.y - nose.y) / unit,
  });

  const scored: Scored[] = [];

  // 1) 关节夹角偏差
  (template.angles ?? []).forEach((rule, index) => {
    if (!isVisible(landmarks[rule.a], 0.35)) return;
    if (!isVisible(landmarks[rule.b], 0.35)) return;
    if (!isVisible(landmarks[rule.c], 0.35)) return;
    const a = points[rule.a];
    const b = points[rule.b];
    const c = points[rule.c];
    if (!a || !b || !c) return;
    const actual = angleDeg(a, b, c);
    const diff = Math.abs(actual - rule.target);
    if (diff <= rule.tol) return;
    scored.push({
      score: (diff - rule.tol) / Math.max(6, rule.tol),
      candidate: { id: `${template.id}:angle:${index}`, text: rule.hint, priority: POSTURE_PRIORITY },
    });
  });

  // 2) 关键点位置偏差（在模板坐标系下比较，与远近无关）
  (template.positions ?? []).forEach((rule, index) => {
    if (!isVisible(landmarks[rule.point], 0.35)) return;
    const point = points[rule.point];
    if (!point) return;
    const actual = toTemplateSpace(point);
    const dx = actual.x - rule.target[0];
    const dy = actual.y - rule.target[1];
    const dist = Math.hypot(dx, dy);
    if (dist <= rule.tol) return;
    scored.push({
      score: (dist - rule.tol) / Math.max(0.15, rule.tol),
      candidate: { id: `${template.id}:pos:${index}`, text: rule.hint, priority: POSTURE_PRIORITY },
    });
  });

  // 3) 跨度偏差（例如侧身时肩宽会明显变窄）
  (template.spans ?? []).forEach((rule, index) => {
    if (!isVisible(landmarks[rule.a], 0.35)) return;
    if (!isVisible(landmarks[rule.b], 0.35)) return;
    const a = points[rule.a];
    const b = points[rule.b];
    if (!a || !b) return;
    const span = Math.hypot(a.x - b.x, a.y - b.y) / unit;
    const diff = Math.abs(span - rule.target);
    if (diff <= rule.tol) return;
    scored.push({
      score: (diff - rule.tol) / Math.max(0.1, rule.tol),
      candidate: { id: `${template.id}:span:${index}`, text: rule.hint, priority: POSTURE_PRIORITY },
    });
  });

  if (scored.length === 0) return null;
  scored.sort((left, right) => right.score - left.score);
  for (const entry of scored) {
    if (entry.score < MIN_SCORE) return null;
    if (excludeId && entry.candidate.id === excludeId) continue;
    return entry.candidate;
  }
  return null;
}
