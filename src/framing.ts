/**
 * 构图规则：按优先级从高到低检测，同一时刻只返回一条提示。
 *
 * 所有阈值集中在 FRAMING 常量区，方便按机型/口味微调。
 * 坐标均为归一化（0~1，相对 video 原始画面），与显示尺寸无关。
 */

import type { HintCandidate, Landmark } from './types';
import { LM, bodyBox, isVisible } from './poseEngine';

export const FRAMING = {
  /** 1. 脚出画：任一踝/脚尖 y 超过该值 */
  FOOT_EDGE_Y: 0.97,
  /** 2. 头顶太挤：鼻尖 y 低于该值 */
  HEAD_TIGHT_Y: 0.1,
  /** 3. 头顶太空（人太小）：鼻尖 y 高于该值 */
  HEAD_LOW_Y: 0.28,
  /** 4. 人物高度占比过小 */
  MIN_BODY_HEIGHT: 0.45,
  /** 4. 人物高度占比过大 */
  MAX_BODY_HEIGHT: 0.92,
  /** 5. 人体框中心 x 的舒适区间 */
  CENTER_MIN_X: 0.33,
  CENTER_MAX_X: 0.67,
  /** 6. 手机水平容差（度） */
  MAX_TILT_DEG: 3,
} as const;

/** 优先级：数字越小越优先。 */
const PRIORITY = {
  FOOT: 1,
  HEAD_TIGHT: 2,
  HEAD_LOW: 3,
  BODY_HEIGHT: 4,
  OFF_CENTER: 5,
  TILT: 6,
} as const;

/**
 * 评估构图与水平。
 * @param landmarks 归一化关键点，没有检测到人时传 null（仍会检查水平）
 * @param tiltDeg 手机横滚角度（度），不支持重力感应时传 null
 * @param excludeId 需要跳过的高优先级提示 id（已连续显示过久时由调用方传入，让位给其它提示）
 */
export function evaluateFraming(
  landmarks: Landmark[] | null,
  tiltDeg: number | null,
  excludeId?: string | null,
): HintCandidate | null {
  const candidates = collectCandidates(landmarks, tiltDeg);
  for (const candidate of candidates) {
    if (excludeId && candidate.id === excludeId) continue;
    return candidate;
  }
  return null;
}

/** 按优先级顺序收集所有成立的构图提示。 */
function collectCandidates(landmarks: Landmark[] | null, tiltDeg: number | null): HintCandidate[] {
  const candidates: HintCandidate[] = [];

  if (landmarks && landmarks.length >= 33) {
    // 1) 脚出画（最致命：拍完才发现没脚）。不受 visibility 限制 ——
    //    脚已经出画时 MediaPipe 往往给出很低的 visibility，过滤掉就漏报了，
    //    结果反而落到「人太小」那条，用户听到的还是错信息。
    const footLowestY = lowestFootY(landmarks);
    if (footLowestY !== null && footLowestY > FRAMING.FOOT_EDGE_Y) {
      candidates.push({ id: 'framing:foot-out', text: '脚快出画了，退后半步', priority: PRIORITY.FOOT });
    }

    const nose = landmarks[LM.NOSE];
    if (isVisible(nose, 0.2)) {
      const noseY = (nose as Landmark).y;
      // 2) 头顶太挤
      if (noseY < FRAMING.HEAD_TIGHT_Y) {
        candidates.push({ id: 'framing:head-tight', text: '头顶太挤，手机往下压一点', priority: PRIORITY.HEAD_TIGHT });
      } else if (noseY > FRAMING.HEAD_LOW_Y) {
        // 3) 头顶太空（人拍得太小）
        candidates.push({ id: 'framing:head-low', text: '人拍得太小，靠近一点', priority: PRIORITY.HEAD_LOW });
      }
    }

    // 4) 人物高度占比（bodyBox 已 clamp 到 0~1，半出画不会把框撑大）
    const box = bodyBox(landmarks);
    if (box) {
      if (box.h < FRAMING.MIN_BODY_HEIGHT) {
        candidates.push({
          id: 'framing:body-small',
          text: '再靠近点，让人占满画面',
          priority: PRIORITY.BODY_HEIGHT,
        });
      } else if (box.h > FRAMING.MAX_BODY_HEIGHT) {
        candidates.push({
          id: 'framing:body-large',
          text: '退后一点，别切到手脚',
          priority: PRIORITY.BODY_HEIGHT,
        });
      }

      // 5) 左右偏移
      if (box.cx < FRAMING.CENTER_MIN_X) {
        candidates.push({
          id: 'framing:off-center-left',
          text: '人偏左了，往右挪一点',
          priority: PRIORITY.OFF_CENTER,
        });
      } else if (box.cx > FRAMING.CENTER_MAX_X) {
        candidates.push({
          id: 'framing:off-center-right',
          text: '人偏右了，往左挪一点',
          priority: PRIORITY.OFF_CENTER,
        });
      }
    }
  }

  // 6) 手机水平（不依赖是否有人）
  if (tiltDeg !== null && Number.isFinite(tiltDeg) && Math.abs(tiltDeg) > FRAMING.MAX_TILT_DEG) {
    candidates.push({
      id: tiltDeg > 0 ? 'framing:tilt-cw' : 'framing:tilt-ccw',
      text: tiltDeg > 0 ? '手机拿歪了，往左转一点' : '手机拿歪了，往右转一点',
      priority: PRIORITY.TILT,
    });
  }

  return candidates;
}

/**
 * 取脚部（踝 + 脚尖）最低的归一化 y，全部不可见时返回 null。
 * 只校验坐标有效性，不校验 visibility（理由见上面脚出画规则）。
 */
function lowestFootY(landmarks: Landmark[]): number | null {
  const indexes = [LM.LEFT_ANKLE, LM.RIGHT_ANKLE, LM.LEFT_FOOT_INDEX, LM.RIGHT_FOOT_INDEX];
  let lowest: number | null = null;
  for (const index of indexes) {
    const landmark = landmarks[index];
    if (!landmark) continue;
    if (!Number.isFinite(landmark.x) || !Number.isFinite(landmark.y)) continue;
    if (landmark.x === 0 && landmark.y === 0) continue;
    lowest = lowest === null ? landmark.y : Math.max(lowest, landmark.y);
  }
  return lowest;
}
