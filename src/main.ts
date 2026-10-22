/**
 * 应用装配入口：状态机（idle / loading / ready / error）+ 全局开关 + 提示调度。
 *
 * 数据流：
 *   CameraController（video 帧循环 → Pose 推理 → 平滑关键点）
 *        ↓ landmarks
 *   framing.evaluateFraming（优先级 1~6） / posture.evaluatePosture（优先级 7）
 *        ↓ 单条最高优先级提示（带 3 秒节流）
 *   Overlay.render（网格 / 剪影 / 骨骼 / 水平仪 / 提示气泡）+ 可选语音播报
 */

import './style.css';
import { CameraController } from './camera';
import { evaluateFraming } from './framing';
import { Overlay } from './overlay';
import { POSE_TEMPLATES, evaluatePosture, findTemplate } from './posture';
import { registerServiceWorker } from './pwa';
import { SILHOUETTE_IDS, preloadSilhouettes } from './silhouette';
import { Ui } from './ui';
import type { HintCandidate, PoseTemplate, ToggleKey } from './types';

/** 同一条提示 3 秒内不重复出现。 */
const HINT_THROTTLE_MS = 3000;
/** 同一条提示连续成立超过该时长后，允许其它提示抢占（避免把低优先级提示永久饿死）。 */
const HINT_STICKY_MS = 6000;
/** 语音播报节流。 */
const SPEECH_THROTTLE_MS = 4000;
/** 状态条刷新节流（避免每帧写 DOM）。 */
const STATUS_REFRESH_MS = 400;

type Phase = 'idle' | 'loading' | 'ready' | 'error';

interface ActiveHint {
  id: string;
  text: string;
  shownAt: number;
  lastSeenAt: number;
}

const DEFAULT_TEMPLATE = requireFirstTemplate(POSE_TEMPLATES[0]);

function requireFirstTemplate(template: PoseTemplate | undefined): PoseTemplate {
  if (!template) throw new Error('姿势库为空，无法启动');
  return template;
}

function mustGet<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`缺少 DOM 节点 #${id}`);
  return element as T;
}

const video = mustGet<HTMLVideoElement>('camera');
const canvas = mustGet<HTMLCanvasElement>('overlay');

const overlay = new Overlay(canvas);
const camera = new CameraController(video);

/**
 * 剪影素材预加载：素材只有几十 KB，放在模块初始化阶段就开始拉，
 * 通常远早于 wasm 姿态模型就绪，因此启动流程里几乎是零等待。
 */
const silhouetteReady: Promise<void> = preloadSilhouettes(SILHOUETTE_IDS);

/** 等待剪影素材，但绝不为了图片让用户多等：超时后按「没加载出来 → 回退几何人形」继续。 */
function waitForSilhouettes(maxWaitMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = window.setTimeout(resolve, maxWaitMs);
    const done = (): void => {
      window.clearTimeout(timer);
      resolve();
    };
    silhouetteReady.then(done, done);
  });
}

const state: {
  phase: Phase;
  templateId: string;
  toggles: Record<ToggleKey, boolean>;
  tiltDeg: number | null;
} = {
  phase: 'idle',
  templateId: DEFAULT_TEMPLATE.id,
  // 骨骼是调试信息：用户看不懂火柴人，默认关；网格 + 剪影才是给人看的指导
  toggles: { grid: true, skeleton: false, silhouette: true, voice: false },
  tiltDeg: null,
};

let currentTemplate: PoseTemplate = DEFAULT_TEMPLATE;
let activeHint: ActiveHint | null = null;
const lastShownAt = new Map<string, number>();
let lastSpokenAt = 0;
let lastStatusAt = 0;

// ---------------------------------------------------------------- 提示调度

/**
 * 选出当前最该说的一句话：构图优先，其次姿势偏差。
 * @param excludeId 已连续显示超过 HINT_STICKY_MS 的提示，跳过它，让其它提示有机会出现
 *                  （否则「人偏左」这种持续成立的提示会把其它提示永久饿死）
 */
function pickCandidate(excludeId: string | null): HintCandidate | null {
  const landmarks = camera.landmarks;
  const framing = evaluateFraming(landmarks, state.tiltDeg, excludeId);
  if (framing) return framing;
  const posture = evaluatePosture(currentTemplate, landmarks, video.videoWidth, video.videoHeight, excludeId);
  if (posture) return posture;
  if (!excludeId) return null;

  // 除了「已连播 6 秒的那条」以外没有别的提示 → 仍然显示它，别让气泡闪一下消失。
  const fallbackFraming = evaluateFraming(landmarks, state.tiltDeg, null);
  if (fallbackFraming) return fallbackFraming;
  return evaluatePosture(currentTemplate, landmarks, video.videoWidth, video.videoHeight, null);
}

/**
 * 采样提示。条件持续成立时不断刷新 lastSeenAt（气泡保持显示），
 * 条件消失后由叠加层延迟 1.2 秒淡出。
 */
function sampleHint(): void {
  const now = performance.now();
  // 同一条提示连续成立超过 6 秒 → 让位给其它提示（用 shownAt 判断，不重置 shownAt 就不会饿死别人）
  const sticky =
    activeHint !== null && now - activeHint.shownAt > HINT_STICKY_MS && now - activeHint.lastSeenAt < 400;
  const candidate = pickCandidate(sticky && activeHint ? activeHint.id : null);
  if (!candidate) return;

  if (activeHint && activeHint.id === candidate.id) {
    activeHint.lastSeenAt = now;
    activeHint.text = candidate.text;
    return;
  }

  const previousAt = lastShownAt.get(candidate.id) ?? 0;
  if (now - previousAt < HINT_THROTTLE_MS) return;

  activeHint = { id: candidate.id, text: candidate.text, shownAt: now, lastSeenAt: now };
  lastShownAt.set(candidate.id, now);
  speak(candidate.text, now);
}

/** 语音播报（可开关，4 秒节流）。 */
function speak(text: string, now: number): void {
  if (!state.toggles.voice) return;
  if (now - lastSpokenAt < SPEECH_THROTTLE_MS) return;
  if (typeof window.speechSynthesis === 'undefined' || typeof SpeechSynthesisUtterance === 'undefined') return;
  try {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'zh-CN';
    utterance.rate = 1.05;
    utterance.pitch = 1;
    utterance.volume = 1;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
    lastSpokenAt = now;
  } catch (error) {
    console.warn('[speech] 播报失败', error);
  }
}

// ---------------------------------------------------------------- 每帧渲染

function renderFrame(): void {
  if (state.phase !== 'ready') return;
  sampleHint();

  overlay.render({
    landmarks: camera.landmarks,
    hint: activeHint
      ? { text: activeHint.text, shownAt: activeHint.shownAt, lastSeenAt: activeHint.lastSeenAt }
      : null,
    template: currentTemplate,
    showGrid: state.toggles.grid,
    showSkeleton: state.toggles.skeleton,
    showSilhouette: state.toggles.silhouette,
    tiltDeg: state.tiltDeg,
    videoWidth: video.videoWidth,
    videoHeight: video.videoHeight,
  });

  const now = performance.now();
  if (now - lastStatusAt >= STATUS_REFRESH_MS) {
    lastStatusAt = now;
    ui.setStatus({
      fps: camera.fps,
      detectFps: camera.detectFps,
      people: camera.landmarks ? 1 : 0,
    });
  }
}

// ---------------------------------------------------------------- 设备方向

const orientation = {
  attached: false,
  async request(): Promise<void> {
    if (this.attached) return;
    const EventCtor = (window as unknown as { DeviceOrientationEvent?: unknown }).DeviceOrientationEvent as
      | { requestPermission?: () => Promise<'granted' | 'denied' | 'default'> }
      | undefined;
    if (EventCtor && typeof EventCtor.requestPermission === 'function') {
      try {
        const result = await EventCtor.requestPermission();
        if (result !== 'granted') {
          ui.toast('未授权「运动与方向」，水平仪不可用');
        }
      } catch (error) {
        console.warn('[orientation] 权限请求失败', error);
      }
    }
    window.addEventListener('deviceorientation', handleOrientation, true);
    this.attached = true;
  },
  detach(): void {
    if (!this.attached) return;
    window.removeEventListener('deviceorientation', handleOrientation, true);
    this.attached = false;
    state.tiltDeg = null;
  },
};

function handleOrientation(event: DeviceOrientationEvent): void {
  const beta = typeof event.beta === 'number' ? event.beta : 0;
  const gamma = typeof event.gamma === 'number' ? event.gamma : 0;
  const portrait = window.innerHeight >= window.innerWidth;
  // 竖屏横滚看 gamma；横屏横滚看 beta（符号取反后语义一致：正值 = 画面顺时针歪）
  state.tiltDeg = portrait ? gamma : -beta;
}

// ---------------------------------------------------------------- UI 装配

const ui = new Ui(POSE_TEMPLATES, state.toggles, {
  onStart: () => {
    void startCamera();
  },
  onSelectTemplate: (id: string) => {
    selectTemplate(id);
  },
  onToggleChange: (key: ToggleKey, value: boolean) => {
    state.toggles[key] = value;
    if (key === 'voice' && !value) {
      window.speechSynthesis?.cancel();
    }
  },
  onShutter: () => {
    void takePhoto();
  },
  onPreviewClose: () => {
    // 关闭预览后恢复取景（video 一直在播放，无需额外处理）
  },
});

ui.setPhase('idle');
ui.setStatus({ model: '模型未加载', fps: 0, detectFps: 0, people: 0 });
ui.setSelectedTemplate(state.templateId);

// PWA：尽早注册（模块顶层，不等用户点「开启摄像头」）。
// 注册失败只会 warn，不影响拍照主流程；有新版本时复用底部 toast 提示，
// 用户点击后新 SW 接管 → controllerchange → 页面自动刷新。
registerServiceWorker({
  onUpdateReady: (applyUpdate: () => void) => {
    ui.toastAction('有新版本，点这里刷新', applyUpdate);
  },
});

function selectTemplate(id: string): void {
  currentTemplate = findTemplate(id);
  state.templateId = currentTemplate.id;
  ui.setSelectedTemplate(currentTemplate.id);
  // 换姿势后立刻允许新提示出现，并清掉旧气泡
  lastShownAt.clear();
  activeHint = null;
  ui.toast(currentTemplate.description);
}

// ---------------------------------------------------------------- 启动流程

async function startCamera(): Promise<void> {
  if (state.phase === 'loading' || state.phase === 'ready') return;

  state.phase = 'loading';
  ui.setPhase('loading');
  ui.setStartError(null);
  ui.setStartBusy(true, '加载姿态模型运行时…');
  ui.setStatus({ model: '加载模型中' });

  try {
    if (!camera.isPoseReady) {
      await camera.initPose();
    }

    // 剪影素材与模型是并行加载的；这里最多等 300ms，让首帧就看到真实轮廓，
    // 同时保证「图片慢」不会变成用户的等待成本（超时则首帧用几何人形，加载完成后自动切换）。
    await waitForSilhouettes(300);

    ui.setStartBusy(true, '初始化姿态模型…（本地 wasm）');
    ui.setStatus({ model: '模型初始化中' });

    ui.setStartBusy(true, '请求摄像头权限…');
    if (!camera.isStreamActive) {
      await camera.openCamera();
    }

    ui.setStartBusy(true, '准备就绪，即将进入取景…');
    await orientation.request();
    overlay.resize();

    state.phase = 'ready';
    ui.setPhase('ready');
    ui.setStatus({ model: '模型就绪', fps: 0, detectFps: 0, people: 0 });
    ui.setStartBusy(false);
    ui.setStartOverlayVisible(false);
    camera.start();
    ui.toast('选一个姿势，让对方照着剪影摆', 2600);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[start] 启动失败', error);
    state.phase = 'error';
    ui.setPhase('error');
    ui.setStartBusy(false);
    ui.setStartError(`启动失败：${message}`);
    ui.setStatus({ model: '启动失败' });
  }
}

// ---------------------------------------------------------------- 拍照

async function takePhoto(): Promise<void> {
  if (state.phase !== 'ready') return;
  ui.flashShutter();
  try {
    const blob = await camera.capture();
    ui.showPreview(blob);
  } catch (error) {
    console.error('[capture] 拍照失败', error);
    ui.toast('拍照失败，请重试');
  }
}

// ---------------------------------------------------------------- 全局事件

camera.onFrame = renderFrame;

// 模型加载/推理彻底失败时不能假装「就绪」：切 error 状态、回到首屏并给出可操作的提示
camera.onFatalError = (message: string): void => {
  if (state.phase === 'error') return;
  console.error('[app] 致命错误:', message);
  camera.pause();
  void camera.resetPose();
  state.phase = 'error';
  ui.setPhase('error');
  ui.setStartBusy(false);
  ui.setStartError(message);
  ui.setStartOverlayVisible(true);
  ui.setStatus({ model: '模型异常', people: 0 });
};

window.addEventListener('resize', () => {
  overlay.resize();
});

window.addEventListener('orientationchange', () => {
  window.setTimeout(() => overlay.resize(), 260);
});

video.addEventListener('loadedmetadata', () => {
  overlay.resize();
});

/**
 * 切后台 / 回前台：暂停或恢复取景。
 *
 * 抽成函数是因为有两个触发源，必须走同一套逻辑，否则两端行为会不一致。
 */
function suspendCamera(): void {
  // 真的把摄像头放掉，不只是停 rAF —— 只停循环的话轨道还在取流，
  // 退到后台指示灯会一直亮（WebView 壳里尤其明显）。
  camera.releaseCamera();
  window.speechSynthesis?.cancel();
}

function resumeCamera(): void {
  if (state.phase !== 'ready') return;
  camera.resume();
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) suspendCamera();
  else resumeCamera();
});

/**
 * Android 壳（`android/`）切后台/回前台时由原生派发这两个事件。
 *
 * 为什么需要：WebView **不会**像浏览器那样自己触发 `visibilitychange`，
 * 不补这一层，壳里退到后台摄像头会一直取流。原生侧见
 * `MainActivity.onPause/onResume`，事件名两端必须一致。
 */
window.addEventListener('photocoach:suspend', suspendCamera);
window.addEventListener('photocoach:resume', resumeCamera);

window.addEventListener('pagehide', () => {
  void camera.dispose();
});

// 键盘调试便利：空格 = 快门（桌面自测）
window.addEventListener('keydown', (event) => {
  if (event.code === 'Space' && state.phase === 'ready') {
    event.preventDefault();
    void takePhoto();
  }
});
