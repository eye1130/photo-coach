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
 * 送进模型的输入最大宽度。
 *
 * MediaPipe lite 内部会把输入缩到 256×256，直接喂 4K 视频流等于每帧白传一张
 * 800 万像素的纹理，帧率会被拖垮。降到 640 宽后推理结果完全不变 ——
 * 输出的关键点是**归一化坐标**，与输入尺寸无关。
 */
const INFER_MAX_WIDTH = 640;

/** `ImageCapture.takePhoto()` 的超时。部分机型会挂住不返回，必须兜底。 */
const STILL_PHOTO_TIMEOUT_MS = 2500;

/** 实际采集分辨率（拍照清晰度的物理上限就取决于它）。 */
export interface CaptureResolution {
  width: number;
  height: number;
}

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
  /** 推理降采样用的离屏画布（只在采集分辨率超过 INFER_MAX_WIDTH 时才用）。 */
  private readonly inferCanvas: HTMLCanvasElement;
  private readonly inferCtx: CanvasRenderingContext2D | null;
  /** 当前实际采集分辨率，0 表示还没拿到流。 */
  private captureWidth = 0;
  private captureHeight = 0;

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
    this.inferCanvas = document.createElement('canvas');
    // alpha: false —— 输入永远是摄像头画面，不需要透明通道，关掉省一次合成
    this.inferCtx = this.inferCanvas.getContext('2d', { alpha: false });
  }

  /** 当前实际采集分辨率。拍照清晰度的上限就是这个值。 */
  get resolution(): CaptureResolution {
    return { width: this.captureWidth, height: this.captureHeight };
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

  /**
   * 请求摄像头并挂载到 video 元素。
   *
   * 分辨率策略：**优先把采集高度顶到设备上限**。
   *
   * 画面用 `object-fit: cover` 铺满竖屏容器，拍照时又按容器宽高比裁切，
   * 竖屏（约 0.46 宽高比）下裁出来的宽度 ≈ 采集高度 × 0.46 ——
   * 1080p 的流裁完只剩 499px 宽，这就是「拍出来糊」的直接原因。
   * 所以 `ideal` 从 2160 高度起步，拿到流后再用 `applyConstraints` 顶到设备真实上限。
   */
  async openCamera(): Promise<void> {
    if (typeof navigator.mediaDevices?.getUserMedia !== 'function') {
      throw new Error('当前浏览器不支持摄像头（需 HTTPS 或 localhost 安全上下文）');
    }

    const preferred: MediaStreamConstraints = {
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 3840 },
        height: { ideal: 2160 },
      },
      audio: false,
    };

    try {
      this.stream = await navigator.mediaDevices.getUserMedia(preferred);
    } catch (error) {
      console.warn('[camera] 高分辨率请求被拒，回退到后置摄像头默认约束', error);
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        });
      } catch (fallbackError) {
        console.warn('[camera] 后置摄像头不可用，回退到默认摄像头', fallbackError);
        this.stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      }
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
    await this.upgradeResolution();
  }

  /**
   * 把采集分辨率顶到设备上限。
   *
   * `getUserMedia` 的 `ideal` 只是「尽力而为」，Chrome / WebView 经常先给
   * 640×480 或 1280×720。真正能开到多大只有 `track.getCapabilities()` 知道，
   * 所以拿到流之后再 `applyConstraints` 试一次。
   *
   * 顶不上去不算错误：设备不支持就保持原样，只是照片没那么清晰。
   */
  private async upgradeResolution(): Promise<void> {
    const track = this.stream?.getVideoTracks()[0];
    if (!track) return;

    const current = track.getSettings();
    this.captureWidth = current.width ?? 0;
    this.captureHeight = current.height ?? 0;

    let targetWidth = this.captureWidth;
    let targetHeight = this.captureHeight;
    try {
      const caps = track.getCapabilities?.();
      if (caps?.width?.max) targetWidth = caps.width.max;
      if (caps?.height?.max) targetHeight = caps.height.max;
    } catch (error) {
      console.warn('[camera] 读取摄像头能力失败，保持当前分辨率', error);
    }

    // 已经到上限、或拿不到能力信息：不要白跑一次 applyConstraints（画面会闪一下）
    if (targetWidth <= this.captureWidth && targetHeight <= this.captureHeight) return;

    try {
      await track.applyConstraints({
        width: { ideal: targetWidth },
        height: { ideal: targetHeight },
      });
    } catch (error) {
      console.warn('[camera] 提升采集分辨率失败，保持当前分辨率', error);
    }

    const finalSettings = track.getSettings();
    this.captureWidth = finalSettings.width ?? this.captureWidth;
    this.captureHeight = finalSettings.height ?? this.captureHeight;
    console.info(
      `[camera] 采集分辨率 ${current.width}×${current.height} → ${this.captureWidth}×${this.captureHeight}`,
    );
  }

  /**
   * 推理输入：超过 640 宽就先降采样。
   *
   * 采集分辨率提上去之后必须走这条路，否则每帧上传一张 4K 纹理给 wasm，
   * 推理帧率会从 20fps 掉到个位数，指导体验反而变差。
   * 输出是归一化坐标，降采样不会影响关键点精度。
   */
  private inferenceInput(): HTMLCanvasElement | HTMLVideoElement {
    const video = this.video;
    const width = video.videoWidth;
    const height = video.videoHeight;
    const ctx = this.inferCtx;
    if (!ctx || width <= INFER_MAX_WIDTH || height <= 0) return video;

    const scale = INFER_MAX_WIDTH / width;
    const targetW = Math.max(1, Math.round(width * scale));
    const targetH = Math.max(1, Math.round(height * scale));
    if (this.inferCanvas.width !== targetW || this.inferCanvas.height !== targetH) {
      this.inferCanvas.width = targetW;
      this.inferCanvas.height = targetH;
    }
    ctx.drawImage(video, 0, 0, targetW, targetH);
    return this.inferCanvas;
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

  /**
   * 只释放摄像头，保留姿态模型。
   *
   * 与 `dispose()` 的区别：dispose 会把 Pose 实例一起关掉，下次要重新初始化 wasm
   * （1 秒左右）；这里只停轨道，回来重新取流就能继续，模型不用重来。
   *
   * 为什么必须真的停轨道而不是只 `pause()`：`pause()` 只停了 rAF 循环，摄像头仍在
   * 取流 —— 浏览器在切后台时会自己兜一层，但 **WebView 壳不会**，退到后台相机指示灯
   * 会一直亮着。所以「切后台 = 释放摄像头」这条必须写在网页端，两端才一致。
   */
  releaseCamera(): void {
    this.pause();
    window.clearTimeout(this.sendWatchdog);
    this.busy = false;
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
    this.video.srcObject = null;
    this.landmarks = null;
  }

  /**
   * 恢复帧循环。摄像头若已被 `releaseCamera()` 释放，会先重新取流。
   *
   * 重新取流是异步的，这里刻意不返回 Promise：调用方（visibilitychange / 原生事件）
   * 本来就是「发后不管」的语义。失败时保持暂停即可，不要往上抛导致页面报错。
   */
  resume(): void {
    if (this.running) return;
    if (!this.stream) {
      void this.openCamera()
        .then(() => this.start())
        .catch((error: unknown) => {
          console.warn('[camera] 恢复摄像头失败，需要用户重新点「开启摄像头」', error);
        });
      return;
    }
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
   * 拍照：按「用户在屏幕上看到的构图」裁切后编码成 JPEG。
   * 只保存原始画面，不含任何叠加层。
   *
   * 两条取图路径：
   * 1. `ImageCapture.takePhoto()` —— 走摄像头的**静态拍照通道**，分辨率通常高于
   *    视频流，部分机型还会带上多帧合成 / 降噪。这是 WebView 里能拿到的最高画质。
   * 2. 回退：直接从 video 抓当前帧。
   *
   * takePhoto 在 Chrome/WebView 上支持度参差，任何异常都静默回退，不影响正常拍照。
   */
  async capture(): Promise<Blob> {
    const video = this.video;
    const sourceWidth = video.videoWidth;
    const sourceHeight = video.videoHeight;
    if (!sourceWidth || !sourceHeight) {
      throw new Error('画面尚未就绪');
    }

    const still = await this.takeStillPhoto();
    try {
      if (still) {
        return await this.cropAndEncode(still, still.width, still.height);
      }
      return await this.cropAndEncode(video, sourceWidth, sourceHeight);
    } finally {
      still?.close();
      // takePhoto 会短暂停掉视频流，正常情况几百毫秒内自己恢复。
      // 万一没恢复（部分机型），取景画面会一直黑着 —— 这里兜一手。
      window.setTimeout(() => this.recoverIfStalled(), 900);
    }
  }

  /**
   * 取景画面停了就重新取流。
   *
   * 只有 `takeStillPhoto()` 走过静态拍照通道才可能触发：`ImageCapture.takePhoto()`
   * 在部分 ROM 上会 stop 掉 video track 却不再 restart，表现为「拍完一张，之后一直黑屏」。
   */
  private recoverIfStalled(): void {
    if (!this.running) return;
    if (this.video.readyState >= 2 && this.video.videoWidth > 0) return;
    console.warn('[camera] 拍照后取景画面未恢复，重新取流');
    void this.openCamera()
      .then(() => this.start())
      .catch((error: unknown) => {
        console.warn('[camera] 重新取流失败', error);
      });
  }

  /**
   * 尝试用 `ImageCapture.takePhoto()` 拍一张静态照片。
   *
   * 为什么值得试：视频流是「为了流畅牺牲画质」的通道（可能只有 720p），
   * 而静态拍照通道能拿到传感器更高分辨率。实测差异可以到 4~8 倍像素。
   *
   * 三道保险，任何一道不过就返回 null 走回退：
   * - 接口不存在 / 抛错
   * - 2.5 秒不返回（部分机型会挂住）
   * - 拿到的照片方向或像素数不优于视频帧（说明没实际收益）
   */
  private async takeStillPhoto(): Promise<ImageBitmap | null> {
    const track = this.stream?.getVideoTracks()[0];
    if (!track) return null;

    // 视频流本身已经很高（≥ 2000 高，典型 4K/4:3 全分辨率）时直接跳过：
    // takePhoto 要重配摄像头 + 解码一张全尺寸大图，实测多花 1.4 秒，
    // 而像素数不会有任何提升 —— 白等。
    if (this.captureHeight >= 2000) return null;

    const ImageCaptureCtor = (
      window as unknown as {
        ImageCapture?: new (track: MediaStreamTrack) => { takePhoto: () => Promise<Blob> };
      }
    ).ImageCapture;
    if (typeof ImageCaptureCtor !== 'function') return null;

    // 拍照期间停掉帧循环：takePhoto 会短暂占用摄像头，同时跑推理容易互相干扰
    const wasRunning = this.running;
    this.pause();
    try {
      const capture = new ImageCaptureCtor(track);
      const blob = await Promise.race<Blob | null>([
        capture.takePhoto(),
        new Promise<null>((resolve) => {
          window.setTimeout(() => resolve(null), STILL_PHOTO_TIMEOUT_MS);
        }),
      ]);
      if (!blob) return null;

      const bitmap = await createImageBitmap(blob);
      const video = this.video;
      const videoLandscape = video.videoWidth >= video.videoHeight;
      const stillLandscape = bitmap.width >= bitmap.height;
      // 方向校验：部分机型返回的是传感器原始方向（横躺），和取景画面不一致，
      // 直接用会导致照片转了 90°，宁可不占这个便宜。
      if (videoLandscape !== stillLandscape) {
        bitmap.close();
        return null;
      }
      // 像素数没有提升就没必要用，省一次多余的解码
      if (bitmap.width * bitmap.height <= video.videoWidth * video.videoHeight) {
        bitmap.close();
        return null;
      }
      return bitmap;
    } catch (error) {
      console.warn('[capture] 静态拍照不可用，回退到视频帧', error);
      return null;
    } finally {
      if (wasRunning) this.start();
    }
  }

  /** 按取景容器宽高比裁切并编码为 JPEG。 */
  private async cropAndEncode(
    source: CanvasImageSource,
    sourceWidth: number,
    sourceHeight: number,
  ): Promise<Blob> {
    const rect = this.video.getBoundingClientRect();
    const targetAspect =
      rect.width > 0 && rect.height > 0 ? rect.width / rect.height : sourceWidth / sourceHeight;
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
    ctx.drawImage(source, cropX, cropY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);

    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => {
          if (blob) resolve(blob);
          else reject(new Error('照片编码失败'));
        },
        'image/jpeg',
        // 0.95：照片是唯一交付物，多几百 KB 换肉眼可见的清晰度值得
        0.95,
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
        .send({ image: this.inferenceInput() })
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
