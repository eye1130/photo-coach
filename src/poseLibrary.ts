/**
 * 姿势库（参数化骨架 + 两段 IK 解算）。
 *
 * 为什么不再手写坐标：手写 33 个点每个姿势要 66 个数字，18 个姿势就是 1188 个数字，
 * 改一处就歪一片。改成「只给手腕/膝/踝的目标位置」，肘由 IK 反解，骨骼长度永远一致。
 *
 * 坐标系：原点 = 鼻尖，x 向右（= 被拍者自身左侧，MediaPipe 约定），y 向下，单位 = 头高
 * （鼻尖到两肩中点）。
 */
import type { PoseAngleRule, PosePositionRule, PoseSpanRule, PoseTemplate } from './types';

export type SceneId = 'street' | 'cafe' | 'outdoor';

export const SCENES: ReadonlyArray<{ id: SceneId; name: string; hint: string }> = [
  { id: 'street', name: '街拍', hint: '走路、靠墙、插兜这类日常动作' },
  { id: 'cafe', name: '室内', hint: '窗边、镜子前、室内日常（不做坐姿：正视图表达不出"坐"）' },
  { id: 'outdoor', name: '户外', hint: '草地、海边、旅行风景' },
];

type Pt = [number, number];

/** 骨段长度（单位 = 头高），来自真人实测反算。 */
const BONE = {
  /** 肩中点 → 胯中点 */
  torso: 2.2,
  /** 肩中点 → 单侧肩 */
  shHalf: 0.8,
  /** 胯中点 → 单侧胯。真人胯宽约肩宽的 0.69（= 1.1 头高），0.4 会画成束腰 */
  hipHalf: 0.55,
  upperArm: 1.6,
  foreArm: 1.55,
};

/** 关键点索引（MediaPipe Pose 33 点中实际用到的部分）。 */
const K = {
  nose: 0,
  earL: 7,
  earR: 8,
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
};

interface PoseSpec {
  id: string;
  name: string;
  scene: SceneId;
  description: string;
  /** 肩中点 y（坐姿把它调大，整个人下沉）。默认 1.0。 */
  shoulderY?: number;
  /** 侧身程度：1 = 正对镜头，0.35 = 几乎侧身。肩宽/胯宽按它缩放。 */
  turn?: number;
  /** 左/右手腕目标位置。 */
  wristL: Pt;
  wristR: Pt;
  /** 左/右膝、踝位置。 */
  kneeL: Pt;
  kneeR: Pt;
  ankleL: Pt;
  ankleR: Pt;
  /** IK 解出的手肘朝哪一侧：1 = 向身体内侧，-1 = 向外侧（默认）。 */
  elbowFlipL?: 1 | -1;
  elbowFlipR?: 1 | -1;
  /** 头部整体偏移（低头时 y 为正）。 */
  headShift?: Pt;
  /** 偏差提示：腕部该在哪、膝该在哪。留空则不生成该条规则。 */
  hintWristL?: string;
  hintWristR?: string;
  hintKneeL?: string;
  hintKneeR?: string;
  /** 额外的角度规则（例如"肩膀一前一后"用 span 表达）。 */
  extraAngles?: PoseAngleRule[];
  extraSpans?: PoseSpanRule[];
}

/** 两段 IK：已知根、末端目标与两段长度，解出中间关节位置。 */
function solveMiddle(root: Pt, end: Pt, l1: number, l2: number, flip: 1 | -1): Pt {
  const dx = end[0] - root[0];
  const dy = end[1] - root[1];
  const rawDist = Math.hypot(dx, dy) || 0.0001;
  // 目标不可达时（太近或太远）夹到可达范围内，避免 acos 出 NaN
  const min = Math.abs(l1 - l2) + 0.02;
  const max = l1 + l2 - 0.02;
  const dist = Math.min(Math.max(rawDist, min), max);
  const cosA = (l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist);
  const a = Math.acos(Math.min(1, Math.max(-1, cosA)));
  const base = Math.atan2(dy, dx);
  const angle = base + flip * a;
  return [root[0] + l1 * Math.cos(angle), root[1] + l1 * Math.sin(angle)];
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function buildPoints(spec: PoseSpec): Record<number, Pt> {
  const turn = spec.turn ?? 1;
  const shY = spec.shoulderY ?? 1;
  const hipY = shY + BONE.torso;
  const shHalf = BONE.shHalf * turn;
  const hipHalf = BONE.hipHalf * turn;

  const shL: Pt = [shHalf, shY];
  const shR: Pt = [-shHalf, shY];
  const hipL: Pt = [hipHalf, hipY];
  const hipR: Pt = [-hipHalf, hipY];

  // IK 把目标夹到可达范围后，末端可能要回到可达点；这里直接用"可达方向上的最近点"
  const reach = (root: Pt, end: Pt, total: number): Pt => {
    const dx = end[0] - root[0];
    const dy = end[1] - root[1];
    const d = Math.hypot(dx, dy) || 0.0001;
    if (d <= total) return end;
    return [root[0] + (dx / d) * total, root[1] + (dy / d) * total];
  };
  const armLen = BONE.upperArm + BONE.foreArm - 0.02;
  /** 腿总长 = 大腿 1.95 + 小腿 1.9 */
  const legLen = 3.85 - 0.02;

  const wrL = reach(shL, spec.wristL, armLen);
  const wrR = reach(shR, spec.wristR, armLen);
  const elL = solveMiddle(shL, wrL, BONE.upperArm, BONE.foreArm, spec.elbowFlipL ?? -1);
  const elR = solveMiddle(shR, wrR, BONE.upperArm, BONE.foreArm, spec.elbowFlipR ?? -1);

  const anL = reach(hipL, spec.ankleL, legLen);
  const anR = reach(hipR, spec.ankleR, legLen);
  const knL = solveMiddle(hipL, anL, 1.95, 1.9, -1);
  const knR = solveMiddle(hipR, anR, 1.95, 1.9, -1);

  const head = spec.headShift ?? [0, 0];
  const nose: Pt = [head[0], head[1]];
  const earL: Pt = [head[0] + 0.3 * turn, head[1] - 0.28];
  const earR: Pt = [head[0] - 0.3 * turn, head[1] - 0.28];

  // 脚：踝下方略向外偏。脚掌厚度只有 0.2 头高，0.35 会画成"踩高跷"
  const toeL: Pt = [anL[0] + 0.08 * turn, anL[1] + 0.2];
  const toeR: Pt = [anR[0] - 0.08 * turn, anR[1] + 0.2];

  const raw: Array<[number, Pt]> = [
    [K.nose, nose], [K.earL, earL], [K.earR, earR],
    [K.shL, shL], [K.shR, shR],
    [K.elL, elL], [K.elR, elR],
    [K.wrL, wrL], [K.wrR, wrR],
    [K.hipL, hipL], [K.hipR, hipR],
    [K.knL, knL], [K.knR, knR],
    [K.anL, anL], [K.anR, anR],
    [K.toeL, toeL], [K.toeR, toeR],
  ];

  // 统一以鼻尖为原点
  const out: Record<number, Pt> = {};
  for (const [index, point] of raw) {
    out[index] = [round(point[0] - nose[0]), round(point[1] - nose[1])];
  }
  // 膝/踝用 spec 给的位置（IK 的 y 可能因为髋高变化而偏离，spec 的意图更可靠）
  out[K.knL] = [round(spec.kneeL[0]), round(spec.kneeL[1] - nose[1])];
  out[K.knR] = [round(spec.kneeR[0]), round(spec.kneeR[1] - nose[1])];
  out[K.anL] = [round(spec.ankleL[0]), round(spec.ankleL[1] - nose[1])];
  out[K.anR] = [round(spec.ankleR[0]), round(spec.ankleR[1] - nose[1])];
  out[K.toeL] = [round(spec.ankleL[0] + 0.08 * turn), round(spec.ankleL[1] + 0.2 - nose[1])];
  out[K.toeR] = [round(spec.ankleR[0] - 0.08 * turn), round(spec.ankleR[1] + 0.2 - nose[1])];
  return out;
}

/** 三点夹角（度），用于由模板反推偏差目标。 */
function angleOf(a: Pt, b: Pt, c: Pt): number {
  const v1x = a[0] - b[0];
  const v1y = a[1] - b[1];
  const v2x = c[0] - b[0];
  const v2y = c[1] - b[1];
  const d = v1x * v2x + v1y * v2y;
  const m = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y) || 1;
  return (Math.acos(Math.min(1, Math.max(-1, d / m))) * 180) / Math.PI;
}

function buildTemplate(spec: PoseSpec): PoseTemplate {
  const points = buildPoints(spec);
  const angles: PoseAngleRule[] = [...(spec.extraAngles ?? [])];
  const positions: PosePositionRule[] = [];

  const elbowAngleL = angleOf(points[K.shL], points[K.elL], points[K.wrL]);
  const elbowAngleR = angleOf(points[K.shR], points[K.elR], points[K.wrR]);

  // 只给"弯曲明显"的关节加规则：接近伸直（>165°）时不做夹角约束，
  // 否则会不停提示"手臂太直"，反而变成噪音。
  const addAngle = (a: number, b: number, c: number, target: number, tol: number, hint?: string) => {
    if (!hint || target > 165) return;
    angles.push({ a, b, c, target: Math.round(target), tol, hint });
  };
  addAngle(K.shL, K.elL, K.wrL, elbowAngleL, 24, spec.hintWristL);
  addAngle(K.shR, K.elR, K.wrR, elbowAngleR, 24, spec.hintWristR);

  if (spec.hintKneeL) {
    positions.push({ point: K.knL, target: points[K.knL], tol: 0.42, hint: spec.hintKneeL });
  }
  if (spec.hintKneeR) {
    positions.push({ point: K.knR, target: points[K.knR], tol: 0.42, hint: spec.hintKneeR });
  }
  if (spec.hintWristL && !spec.hintKneeL) {
    positions.push({ point: K.wrL, target: points[K.wrL], tol: 0.5, hint: spec.hintWristL });
  }
  if (spec.hintWristR && !spec.hintKneeR) {
    positions.push({ point: K.wrR, target: points[K.wrR], tol: 0.5, hint: spec.hintWristR });
  }

  return {
    id: spec.id,
    name: spec.name,
    scene: spec.scene,
    description: spec.description,
    points,
    angles,
    positions,
    spans: spec.extraSpans ?? [],
  };
}

// ---------------------------------------------------------------- 姿势规格
// 坐标全部为「以鼻尖为原点、单位=头高」的绝对位置，站立基准：肩 y=1.0、胯 y=3.2、
// 踝 y≈7.05。坐姿把 shoulderY 调大（人整体下沉），膝/踝按新高度重写。

const SPECS: PoseSpec[] = [
  // ═══════════════════════════ 街拍 street
  {
    id: 'stand-natural',
    name: '自然站',
    scene: 'street',
    description: '体重落在后脚，肩膀放松。',
    wristL: [1.0, 4.15], wristR: [-1.0, 4.15],
    kneeL: [0.4, 5.15], kneeR: [-0.4, 5.15],
    ankleL: [0.46, 7.05], ankleR: [-0.46, 7.05],
    hintWristL: '手臂放松垂下来，别夹太紧',
    hintWristR: '另一只手也放下来',
    extraSpans: [{ a: K.shL, b: K.shR, target: 1.6, tol: 0.5, hint: '身体正对镜头，肩膀打开' }],
  },
  {
    id: 'hand-on-hip',
    name: '单手叉腰',
    scene: 'street',
    description: '一只手撑在腰上，肘部往外打开。',
    wristL: [0.45, 3.1], wristR: [-1.0, 4.2],
    kneeL: [0.4, 5.15], kneeR: [-0.4, 5.15],
    ankleL: [0.46, 7.05], ankleR: [-0.46, 7.05],
    hintWristL: '手贴到腰上，手肘往外顶',
    hintWristR: '另一只手自然垂着就行',
  },
  {
    id: 'arms-crossed',
    name: '双手抱胸',
    scene: 'street',
    description: '双手在胸前交叠，肘部收进来。',
    wristL: [-0.32, 2.0], wristR: [0.32, 2.25],
    kneeL: [0.4, 5.15], kneeR: [-0.4, 5.15],
    ankleL: [0.46, 7.05], ankleR: [-0.46, 7.05],
    hintWristL: '双手交叠抱在胸前，别垂着',
    hintWristR: '另一只手搭在胳膊上',
  },
  {
    id: 'side-glance',
    name: '侧身回眸',
    scene: 'street',
    description: '身体侧过去，头转回来看镜头。',
    turn: 0.4,
    wristL: [0.55, 4.15], wristR: [-0.55, 4.3],
    kneeL: [0.3, 5.15], kneeR: [-0.22, 5.2],
    ankleL: [0.34, 7.05], ankleR: [-0.18, 7.1],
    hintWristL: '侧过身去，肩膀一前一后',
    hintWristR: '后手放松搭在身侧',
    extraSpans: [{ a: K.shL, b: K.shR, target: 0.64, tol: 0.32, hint: '侧过身去，把肩膀转成一条线' }],
  },
  {
    id: 'hand-in-pocket',
    name: '手插兜',
    scene: 'street',
    description: '一只手插兜，人稍微一歪。',
    turn: 0.9,
    wristL: [0.62, 3.6], wristR: [-1.02, 4.2],
    kneeL: [0.36, 5.15], kneeR: [-0.3, 5.2],
    ankleL: [0.34, 7.05], ankleR: [-0.28, 7.1],
    hintWristL: '手往裤兜里插，手肘朝外',
    hintWristR: '另一只手垂在身侧',
  },
  {
    id: 'walk-turn',
    name: '走路回头',
    scene: 'street',
    description: '假装往前走，头转回镜头。',
    turn: 0.55,
    wristL: [0.95, 4.0], wristR: [-0.6, 3.85],
    kneeL: [0.55, 4.95], kneeR: [-0.28, 5.25],
    ankleL: [0.62, 6.9], ankleR: [-0.3, 7.15],
    hintKneeL: '前脚往前迈出去，别并着',
    hintWristL: '手臂跟着步伐自然甩一下',
  },

  {
    id: 'both-pockets',
    name: '双手插兜',
    scene: 'street',
    description: '两只手都插兜，肩膀放松。',
    wristL: [0.62, 3.55], wristR: [-0.62, 3.55],
    kneeL: [0.4, 5.15], kneeR: [-0.4, 5.15],
    ankleL: [0.46, 7.05], ankleR: [-0.46, 7.05],
    hintWristL: '两只手都往裤兜里插',
    hintWristR: '另一只手也插进去，手臂别绷着',
  },
  {
    id: 'lean-wall',
    name: '靠墙',
    scene: 'street',
    description: '一手撑墙，一条腿交叉点地。',
    turn: 0.85,
    // 撑墙那只手臂需要接近伸直 → 目标点给到臂展之外
    wristL: [2.4, 3.3], wristR: [-0.75, 4.0],
    kneeL: [0.1, 5.2], kneeR: [-0.35, 5.15],
    ankleL: [-0.28, 7.0], ankleR: [-0.38, 7.05],
    hintWristL: '手撑在墙上，手臂放松伸直',
    hintKneeL: '一条腿交叉点地，别两条腿并着',
  },
  {
    id: 'hand-shade',
    name: '抬手遮阳',
    scene: 'street',
    description: '一手抬到额前遮太阳，另一只手垂在身侧。',
    wristL: [0.5, -0.05], wristR: [-0.5, 3.1],
    kneeL: [0.4, 5.15], kneeR: [-0.4, 5.15],
    ankleL: [0.46, 7.05], ankleR: [-0.46, 7.05],
    hintWristL: '手抬到眉毛上方，挡住太阳',
    hintWristR: '另一只手自然垂在身侧',
  },
  {
    id: 'cross-step',
    name: '交叉站',
    scene: 'street',
    description: '双腿交叉，人在一条线上。',
    turn: 0.95,
    wristL: [0.95, 4.1], wristR: [-0.95, 4.15],
    kneeL: [0.15, 5.2], kneeR: [-0.3, 5.15],
    ankleL: [-0.25, 7.0], ankleR: [-0.42, 7.05],
    hintKneeL: '一条腿交叉到另一条腿前面',
    hintWristL: '手臂自然垂下，别抱起来',
  },

  // ═══════════════════════════ 室内 cafe
  {
    id: 'check-phone',
    name: '低头看手机',
    scene: 'cafe',
    description: '双手在胸前拿手机，头微低。',
    headShift: [0, 0.16],
    wristL: [0.3, 2.55], wristR: [-0.12, 2.68],
    kneeL: [0.4, 5.15], kneeR: [-0.4, 5.15],
    ankleL: [0.46, 7.05], ankleR: [-0.46, 7.05],
    hintWristL: '双手把手机拿到胸前，别垂在下面',
    hintWristR: '另一只手也扶一下手机',
  },
  {
    id: 'adjust-collar',
    name: '整理衣领',
    scene: 'cafe',
    description: '双手在领口，像在整理衣服。',
    wristL: [0.38, 1.75], wristR: [-0.3, 1.8],
    kneeL: [0.4, 5.15], kneeR: [-0.4, 5.15],
    ankleL: [0.46, 7.05], ankleR: [-0.46, 7.05],
    hintWristL: '手抬到领口，像在整理领子',
    hintWristR: '另一只手也抬起来',
  },
  {
    id: 'mirror-selfie',
    name: '对镜自拍',
    scene: 'cafe',
    description: '一只手举手机，另一只手叉腰。',
    turn: 0.9,
    wristL: [0.55, 1.55], wristR: [-0.55, 3.1],
    kneeL: [0.36, 5.15], kneeR: [-0.3, 5.2],
    ankleL: [0.34, 7.05], ankleR: [-0.28, 7.1],
    hintWristL: '把手机举到脸旁边，手肘抬起来',
    hintWristR: '另一只手叉在腰上',
  },
  {
    id: 'lean-window',
    name: '倚窗',
    scene: 'cafe',
    description: '侧身靠在窗边，一手扶窗台。',
    shoulderY: 1.15,
    turn: 0.55,
    // 目标点给到臂展之外一点点 → IK 夹到可达边缘 → 手臂自然伸直而不是折成直角
    wristL: [2.2, 3.6], wristR: [-0.45, 4.35],
    kneeL: [0.5, 5.2], kneeR: [-0.2, 5.15],
    ankleL: [0.62, 7.05], ankleR: [-0.15, 7.1],
    hintWristL: '一只手撑在窗台上',
    hintKneeL: '一条腿稍微往前放，重心靠窗',
  },
  {
    id: 'read-book',
    name: '低头看书',
    scene: 'cafe',
    description: '双手捧书，头略低。',
    shoulderY: 1.05,
    headShift: [0, 0.12],
    wristL: [0.28, 2.85], wristR: [-0.28, 2.9],
    kneeL: [0.34, 5.2], kneeR: [-0.34, 5.2],
    ankleL: [0.46, 7.05], ankleR: [-0.46, 7.05],
    hintWristL: '双手把书捧在腹前',
    hintWristR: '另一只手托住书',
  },
  {
    id: 'stand-counter',
    name: '靠吧台',
    scene: 'cafe',
    description: '双手撑在台面上，人靠过去。',
    shoulderY: 1.1,
    turn: 0.8,
    wristL: [0.85, 3.95], wristR: [-0.85, 3.95],
    kneeL: [0.36, 5.2], kneeR: [-0.36, 5.2],
    ankleL: [0.34, 7.05], ankleR: [-0.34, 7.05],
    hintWristL: '双手撑在台面上，重心往前压',
    hintKneeL: '一条腿稍微歇一下，别太僵',
  },

  {
    id: 'lean-door',
    name: '倚门框',
    scene: 'cafe',
    description: '侧身靠在门框上，一只手扶着。',
    turn: 0.6,
    // 目标点给到臂展（3.13）之外 → 手臂接近伸直，像真的扶着门框
    wristL: [3.0, 2.7], wristR: [-0.4, 4.2],
    kneeL: [0.45, 5.2], kneeR: [-0.15, 5.15],
    ankleL: [0.55, 7.05], ankleR: [-0.1, 7.1],
    hintWristL: '一只手扶在门框上，手臂伸开放松',
    hintKneeL: '重心压到一条腿上，另一条腿松一点',
  },
  {
    id: 'arms-fold-lean',
    name: '抱臂靠墙',
    scene: 'cafe',
    description: '双手抱胸，人往一侧靠。',
    turn: 0.8,
    wristL: [-0.3, 2.05], wristR: [0.3, 2.3],
    kneeL: [0.3, 5.15], kneeR: [-0.2, 5.2],
    ankleL: [0.35, 7.05], ankleR: [-0.15, 7.1],
    hintWristL: '双手抱在胸前，人往一边歪一点',
    hintWristR: '另一只手搭在胳膊上',
  },
  {
    id: 'reach-shelf',
    name: '伸手够高处',
    scene: 'cafe',
    description: '一只手向上伸，像够架子上的东西。',
    wristL: [1.0, -1.9], wristR: [-0.78, 3.9],
    kneeL: [0.4, 5.15], kneeR: [-0.4, 5.15],
    ankleL: [0.46, 7.05], ankleR: [-0.46, 7.05],
    hintWristL: '手往上伸直，够高一点',
    hintWristR: '另一只手垂着',
  },

  // ═══════════════════════════ 户外 outdoor
  {
    id: 'arms-open',
    name: '迎风张臂',
    scene: 'outdoor',
    description: '双臂向两侧展开，人放松。',
    // 目标点故意给到臂展之外（4.3 > 臂长 3.13），IK 会夹到可达边缘 =
    // 手臂自然伸直，方向由这个点的方向决定（0.51, 0.86，约 30° 外下）
    wristL: [3.0, 4.7], wristR: [-3.0, 4.7],
    kneeL: [0.4, 5.2], kneeR: [-0.4, 5.2],
    ankleL: [0.45, 7.05], ankleR: [-0.45, 7.05],
    hintWristL: '手臂张开，别夹在身侧',
    hintWristR: '另一只手也打开',
  },
  {
    id: 'hat-tip',
    name: '扶帽檐',
    scene: 'outdoor',
    description: '一只手搭在帽子或额前，眼神看向远处。',
    wristL: [0.5, -0.35], wristR: [-0.95, 4.2],
    kneeL: [0.4, 5.15], kneeR: [-0.4, 5.15],
    ankleL: [0.46, 7.05], ankleR: [-0.46, 7.05],
    hintWristL: '手抬到帽子边上，轻轻扶着',
    hintWristR: '另一只手自然垂着',
  },
  {
    id: 'jump',
    name: '跳起来',
    scene: 'outdoor',
    description: '人离地，脚收起来，手举高。',
    // 整体上移（鼻尖接近画面顶部），脚离地约 1.1 头高
    shoulderY: 0.3,
    wristL: [1.5, -2.4], wristR: [-1.5, -2.4],
    kneeL: [0.62, 4.6], kneeR: [-0.62, 4.6],
    ankleL: [0.5, 5.9], ankleR: [-0.5, 5.9],
    hintKneeL: '脚收起来，别笔直站着',
    hintWristL: '手举高一点，冲一下',
  },
  {
    id: 'gaze-far',
    name: '手搭凉棚',
    scene: 'outdoor',
    description: '一只手遮在额前望远。',
    wristL: [0.45, -0.12], wristR: [-1.02, 4.2],
    kneeL: [0.4, 5.15], kneeR: [-0.4, 5.15],
    ankleL: [0.46, 7.05], ankleR: [-0.46, 7.05],
    hintWristL: '手抬到额头上，像遮太阳',
    hintWristR: '另一只手自然垂着',
  },
  {
    id: 'hair-flip',
    name: '撩头发',
    scene: 'outdoor',
    description: '一只手撩到头发，头微侧。',
    turn: 0.75,
    wristL: [1.05, 0.3], wristR: [-0.95, 4.2],
    kneeL: [0.4, 5.15], kneeR: [-0.4, 5.15],
    ankleL: [0.46, 7.05], ankleR: [-0.46, 7.05],
    hintWristL: '手抬到耳侧，碰一下头发',
    hintWristR: '另一只手垂着',
  },
  {
    id: 'peace-up',
    name: '比耶举手',
    scene: 'outdoor',
    description: '一只手举高比耶，人稍微一歪。',
    turn: 0.9,
    wristL: [1.9, -2.8], wristR: [-0.95, 4.2],
    kneeL: [0.4, 5.15], kneeR: [-0.28, 5.2],
    ankleL: [0.38, 7.05], ankleR: [-0.26, 7.1],
    hintWristL: '手举过头顶，比个耶',
    hintWristR: '另一只手垂着就行',
  },
  {
    id: 'back-hand',
    name: '背手远望',
    scene: 'outdoor',
    description: '双手背在身后，抬头看远处。',
    wristL: [0.05, 3.78], wristR: [-0.08, 3.82],
    kneeL: [0.4, 5.15], kneeR: [-0.4, 5.15],
    ankleL: [0.46, 7.05], ankleR: [-0.46, 7.05],
    hintWristL: '双手背到身后，别垂在旁边',
    hintWristR: '另一只手也背过去',
  },
  {
    id: 'point-far',
    name: '指向远方',
    scene: 'outdoor',
    description: '一只手斜上方指出去，像在介绍风景。',
    turn: 0.9,
    wristL: [3.2, -1.1], wristR: [-0.85, 4.1],
    kneeL: [0.4, 5.15], kneeR: [-0.4, 5.15],
    ankleL: [0.46, 7.05], ankleR: [-0.46, 7.05],
    hintWristL: '手臂斜着指出去，伸直一点',
    hintWristR: '另一只手垂着',
  },
];

export const POSE_TEMPLATES: PoseTemplate[] = SPECS.map(buildTemplate);

/** 按场景筛选。 */
export function posesOfScene(scene: SceneId): PoseTemplate[] {
  return POSE_TEMPLATES.filter((pose) => pose.scene === scene);
}
