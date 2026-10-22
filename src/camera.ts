/**
 * 摄像头 + 姿态推理帧循环。
 *
 * 关键点：
 * 1. pose.send() 是异步的，必须防重入：上一帧未 resolve 时直接跳过，否则内存暴涨/卡死。
 * 2. 降频：每 2 帧送一次，且用 video.currentTime 判重（同一帧不重复送）。
 * 3. modelComplexity 必须为 0（public/mp 下只放了 lite 模型，1/2 会 404）。
 * 4. 运行时与模型全部走本地 /mp/ 目录，禁止外网加载。
 */

import type { Landmark, PoseInstance, PoseResults } from './types';
import { LandmarkSmoother } from './poseEngine';

/** 每 N 帧送一次推理。 */
const DETECT_EVERY_N_FRAMES = 2;
/** 两次推理的最小间隔（毫秒），避免高刷屏把 CPU 打满。 */
const MIN_SEND_INTERVAL_MS = 55;
/** 超过该时长没有新结果，视为目标丢失。 */
const RESULT_STALE_MS = 700;
/** FPS 统计窗口。 */
const STATS_WINDOW_MS = 500;
/** 单次推理的最长等待，超时强制解锁帧循环。 */
const SEND_TIMEOUT_MS = 2000;
/** 连续推理失败达到该次数即上报致命错误（避免模型坏了却一直显示"就绪"）。 */
const FATAL_SEND_ERRORS = 3;

/**
 * 生成一张 64×64 空白画布，用于 initialize() 失败后的一次功能性验证 send：
 * legacy Pose 的 initialize() 有时会误 reject，但真正的 send 仍可用，
 * 只有 send 也失败才能断定模型不可用。
 */
function createBlankCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#101418';
    ctx.fillRect(0, 0, 64, 64);
  }
  return canvas;
}

/**
 * MediaPipe 资源根目录：相对当前文档解析，保证部署在子路径时依然可用。
 * dev 下 document.baseURI 是 http://host:5173/ → /mp/
 */
function resolveMpBase(): string {
  try {
    return new URL('mp/', document.baseURI).href;
  } catch {
    return '/mp/';
  }
}

export class CameraController {
  private readonly video: HTMLVideoElement;
  private pose: PoseInstance | null = null;
  private stream: MediaStream | null = null;
  private rafId = 0;
  private running = false;
  private busy = false;
  private lastSentVideoTime = -1;
  private lastSendAt = 0;
  private frameIndex = 0;
  private readonly smoother = new LandmarkSmoother(0.5);
  private lastResultAt = 0;
  private frameCount = 0;
  private detectCount = 0;
  private statsWindowStart = 0;
  private warnedSend = false;
  private sendToken = 0;
  private sendWatchdog = 0;
  private consecutiveSendErrors = 0;

  /** 最新一帧平滑后的关键点（未检测到人时为 null）。 */
  landmarks: Landmark[] | null = null;
  /** 渲染帧率。 */
  fps = 0;
  /** 姿态推理帧率。 */
  detectFps = 0;
  /** 每帧回调（叠加层渲染入口）。 */
  onFrame: (() => void) | null = null;
  /** 模型就绪回调。 */
  onModelReady: (() => void) | null = null;
  /** 致命错误回调（模型加载/推理彻底失败），由 main 切到 error 状态。 */
  onFatalError: ((message: string) => void) | null = null;

  constructor(video: HTMLVideoElement) {
    this.video = video;
  }

  /** 摄像头流是否已打开。 */
  get isStreamActive(): boolean {
    return this.stream !== null;
  }

  /** 姿态模型是否已创建（重试启动时避免重复实例化）。 */
  get isPoseReady(): boolean {
    return this.pose !== null;
  }

  /** 初始化 MediaPipe Pose（模型从 /mp/ 本地目录加载）。 */
  async initPose(): Promise<void> {
    const PoseConstructor = window.Pose;
    if (typeof PoseConstructor !== 'function') {
      throw new Error('姿态模型脚本未加载（/mp/pose.js），请确认 public/mp 目录完整');
    }
    const mpBase = resolveMpBase();
    const pose = new PoseConstructor({
      // 运行时与模型全部在本站 /mp/ 下，禁止外网加载
      locateFile: (file: string) => `${mpBase}${file}`,
    });
    pose.setOptions({
      modelComplexity: 0,
      smoothLandmarks: true,
      enableSegmentation: false,
      minDetectionConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
    pose.onResults((results) => this.handleResults(results));
    this.pose = pose;

    // 预初始化，把 wasm/graph 加载提前到「加载中」阶段。
    // 失败时不能假装就绪：用一次空白帧 send 做功能验证，两次都失败就抛错，
    // 让 main 进入 error 状态并在首屏显示「姿态模型加载失败，请刷新重试」。
    try {
      await pose.initialize();
    } catch (error) {
      console.warn('[pose] initialize() 失败，改用空白帧验证模型是否可用', error);
      try {
        await pose.send({ image: createBlankCanvas() });
      } catch (warmUpError) {
        console.error('[pose] 姿态模型不可用', warmUpError);
        this.pose = null;
        throw new Error('姿态模型加载失败（/mp 下的 wasm 或模型文件可能缺失），请刷新重试');
      }
    }
    if (this.onModelReady) this.onModelReady();
  }

  /** 请求摄像头并挂载到 video 元素。 */
  async openCamera(): Promise<void> {
    if (typeof navigator.mediaDevices?.getUserMedia !== 'function') {
      throw new Error('当前浏览器不支持摄像头（需 HTTPS 或 localhost 安全上下文）');
    }

    const preferred: MediaStreamConstraints = {
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
      audio: false,
    };

    try {
      this.stream = await navigator.mediaDevices.getUserMedia(preferred);
    } catch (error) {
      console.warn('[camera] 后置摄像头不可用，回退到默认摄像头', error);
      this.stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    }

    this.video.srcObject = this.stream;
    this.video.muted = true;
    this.video.playsInline = true;
    try {
      await this.video.play();
    } catch (error) {
      console.warn('[camera] video.play() 被拒绝，等待用户手势', error);
    }
    await this.waitForFrameReady();
  }

  private async waitForFrameReady(timeoutMs = 6000): Promise<void> {
    if (this.video.videoWidth > 0) return;
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        cleanup();
        reject(new Error('摄像头画面加载超时，请检查相机权限'));
      }, timeoutMs);
      const onReady = (): void => {
        if (this.video.videoWidth > 0) {
          cleanup();
          resolve();
        }
      };
      const cleanup = (): void => {
        window.clearTimeout(timer);
        this.video.removeEventListener('loadedmetadata', onReady);
        this.video.removeEventListener('playing', onReady);
        this.video.removeEventListener('resize', onReady);
      };
      this.video.addEventListener('loadedmetadata', onReady);
      this.video.addEventListener('playing', onReady);
      this.video.addEventListener('resize', onReady);
    });
  }

  /** 启动帧循环。 */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.statsWindowStart = performance.now();
    this.frameCount = 0;
    this.detectCount = 0;
    this.rafId = window.requestAnimationFrame(this.tick);
  }

  /** 暂停帧循环（页面切后台）。 */
  pause(): void {
    this.running = false;
    if (this.rafId) {
      window.cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
  }

  /** 恢复帧循环。 */
  resume(): void {
    if (this.running || !this.stream) return;
    this.start();
  }

  /** 释放资源。 */
  async dispose(): Promise<void> {
    this.pause();
    window.clearTimeout(this.sendWatchdog);
    this.busy = false;
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
    this.video.srcObject = null;
    const pose = this.pose;
    this.pose = null;
    this.landmarks = null;
    if (pose) {
      try {
        await pose.close();
      } catch (error) {
        console.warn('[pose] 关闭失败', error);
      }
    }
  }

  /**
   * 丢弃当前 Pose 实例（推理彻底失败后调用），下次启动会重新初始化。
   * 保留摄像头流。
   */
  async resetPose(): Promise<void> {
    const pose = this.pose;
    this.pose = null;
    this.landmarks = null;
    this.smoother.reset();
    this.consecutiveSendErrors = 0;
    window.clearTimeout(this.sendWatchdog);
    this.busy = false;
    if (pose) {
      try {
        await pose.close();
      } catch (error) {
        console.warn('[pose] 关闭失败', error);
      }
    }
  }

  /**
   * 拍照：把当前 video 帧按「用户在屏幕上看到的构图」裁切后画到离屏 canvas。
   * 只保存原始画面，不含任何叠加层。
   */
  async capture(): Promise<Blob> {
    const video = this.video;
    const sourceWidth = video.videoWidth;
    const sourceHeight = video.videoHeight;
    if (!sourceWidth || !sourceHeight) {
      throw new Error('画面尚未就绪');
    }

    const rect = video.getBoundingClientRect();
    const targetAspect = rect.width > 0 && rect.height > 0 ? rect.width / rect.height : sourceWidth / sourceHeight;
    const sourceAspect = sourceWidth / sourceHeight;

    let cropWidth = sourceWidth;
    let cropHeight = sourceHeight;
    let cropX = 0;
    let cropY = 0;
    if (sourceAspect > targetAspect) {
      cropWidth = Math.round(sourceHeight * targetAspect);
      cropX = Math.round((sourceWidth - cropWidth) / 2);
    } else {
      cropHeight = Math.round(sourceWidth / targetAspect);
      cropY = Math.round((sourceHeight - cropHeight) / 2);
    }

    const canvas = document.createElement('canvas');
    canvas.width = cropWidth;
    canvas.height = cropHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法创建拍照画布');
    ctx.drawImage(video, cropX, cropY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);

    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => {
          if (blob) resolve(blob);
          else reject(new Error('照片编码失败'));
        },
        'image/jpeg',
        0.92,
      );
    });
  }

  // ------------------------------------------------------------ 内部实现

  private handleResults(results: PoseResults): void {
    // 只要模型返回结果就计数（不论画面里有没有人），
    // 这个值等于「每秒实际完成的推理次数」，用于状态条展示推理频率。
    this.detectCount += 1;

    const raw = results?.poseLandmarks;
    if (raw && raw.length >= 33) {
      this.landmarks = this.smoother.update(raw);
      this.lastResultAt = performance.now();
      return;
    }
    if (performance.now() - this.lastResultAt > RESULT_STALE_MS) {
      this.landmarks = null;
      this.smoother.reset();
    }
  }

  private tick = (): void => {
    if (!this.running) return;
    this.rafId = window.requestAnimationFrame(this.tick);

    const now = performance.now();
    this.frameCount += 1;
    if (this.statsWindowStart === 0) this.statsWindowStart = now;
    const windowSpan = now - this.statsWindowStart;
    if (windowSpan >= STATS_WINDOW_MS) {
      const seconds = windowSpan / 1000;
      this.fps = this.frameCount / seconds;
      this.detectFps = this.detectCount / seconds;
      this.frameCount = 0;
      this.detectCount = 0;
      this.statsWindowStart = now;
    }

    if (this.onFrame) this.onFrame();

    const video = this.video;
    if (!this.pose) return;
    if (video.readyState < 2 || video.videoWidth === 0) return;
    // 防重入：上一帧推理还没结束，直接跳过
    if (this.busy) return;
    // 同一帧不重复送
    if (video.currentTime === this.lastSentVideoTime) return;

    this.frameIndex += 1;
    if (this.frameIndex % DETECT_EVERY_N_FRAMES !== 0) return;
    if (now - this.lastSendAt < MIN_SEND_INTERVAL_MS) return;

    this.lastSentVideoTime = video.currentTime;
    this.lastSendAt = now;
    this.busy = true;

    // 每次 send 独占一个看门狗：无论 resolve / reject / 同步抛错，都在对应回调里清掉，
    // 保证不会出现「上一个定时器把下一次 send 的 busy 解锁」或「漏解一次」。
    // 看门狗兜底：万一 send 既不 resolve 也不 reject（wasm 崩了），2 秒后强制解锁，
    // 否则 busy 会永远为 true，检测静默停摆。
    this.sendToken += 1;
    const token = this.sendToken;
    let watchdog = 0;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      window.clearTimeout(watchdog);
      if (this.sendToken === token) this.busy = false;
    };

    const pose = this.pose;
    try {
      watchdog = window.setTimeout(() => {
        if (this.sendToken !== token) return;
        released = true;
        this.busy = false;
        console.warn('[pose] send 超时，已解锁帧循环');
      }, SEND_TIMEOUT_MS);
      this.sendWatchdog = watchdog;

      pose
        .send({ image: video })
        .then(() => {
          this.consecutiveSendErrors = 0;
          release();
        })
        .catch((error: unknown) => {
          this.registerSendError(error);
          release();
        });
    } catch (error) {
      this.registerSendError(error);
      release();
    }
  };

  /** 连续推理失败达到阈值就上报致命错误（避免模型坏了却一直显示"就绪"）。 */
  private registerSendError(error: unknown): void {
    this.consecutiveSendErrors += 1;
    if (!this.warnedSend) {
      this.warnedSend = true;
      console.warn('[pose] send 失败（后续同类错误不再打印）', error);
    }
    if (this.consecutiveSendErrors >= FATAL_SEND_ERRORS && this.onFatalError) {
      this.onFatalError('姿态模型推理持续失败（/mp 下的 wasm 或模型文件可能缺失），请刷新重试');
    }
  }
}
