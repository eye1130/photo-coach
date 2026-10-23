/**
 * 控件绑定层：首屏遮罩、状态条、开关组、姿势横滑条、快门、拍照预览。
 * 只负责 DOM，不掺业务判断（业务在 main.ts）。
 */

import type { PoseTemplate, ToggleKey } from './types';
import { SCENES, type SceneId } from './poseLibrary';
import { drawFigure, figureBounds } from './figure';

/**
 * Android 壳（`android/` 目录）注入的原生桥接对象。
 *
 * 为什么需要它：网页端的「保存到相册」是 `<a download>` 指向 `blob:` URL。
 * 浏览器里这是标准行为，但 WebView **不支持 download** —— 点下去毫无反应，
 * 而且 `setDownloadListener` 也不会为 `blob:` 触发（拿到的是空链接）。
 * 所以壳里必须由页面自己把 blob 读成 base64 交给原生，由原生写进 MediaStore。
 *
 * 名字 `PhotoCoachNative` 必须与 MainActivity.java 里
 * `addJavascriptInterface(new NativeBridge(), "PhotoCoachNative")` 一致。
 */
interface NativeBridge {
  saveImage(dataUrl: string, fileName: string): void;
  /**
   * 调起系统相机拍一张全分辨率照片（可选能力）。
   *
   * 为什么需要：WebView 的 `getUserMedia` 走的是「视频流」通道，分辨率受
   * WebRTC 采集能力限制（常见 720p/1080p），竖屏裁切后只剩几百像素宽。
   * 想拿到真正的原相机画质，只能交给系统相机 App 去拍。
   *
   * 做成可选：老版本 APK 里没有这个方法，网页端要能优雅降级。
   */
  openSystemCamera?(): void;
}

/** 取原生桥接；浏览器环境返回 null，调用方据此保留默认下载行为。 */
function nativeBridge(): NativeBridge | null {
  const bridge = (window as unknown as { PhotoCoachNative?: Partial<NativeBridge> }).PhotoCoachNative;
  if (!bridge || typeof bridge.saveImage !== 'function') return null;
  return bridge as NativeBridge;
}

/** Blob → base64 data URL（JS 桥接只能传字符串）。 */
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('照片读取失败'));
    reader.readAsDataURL(blob);
  });
}

export interface UiCallbacks {
  onStart: () => void;
  onSelectTemplate: (id: string) => void;
  onToggleChange: (key: ToggleKey, value: boolean) => void;
  onShutter: () => void;
  onPreviewClose: () => void;
  /**
   * 用户点了「用系统相机拍」。
   *
   * 必须**先**把摄像头放掉再跳转：系统相机也要打开同一个摄像头，
   * WebView 还占着的话它会黑屏或直接失败。恢复由原生回传的
   * `photocoach:resume` 事件负责（见 main.ts）。
   */
  onSystemCameraRequest: () => void;
}

/**
 * 姿势缩略图：统一用 `drawFigure` 的几何人形，**不**用真实轮廓素材。
 *
 * 理由：素材是 922px 高、描边按大尺寸烘焙的，缩到 44px 格里描边只剩亚像素、5% 填充
 * 几乎看不见，和另外 18 个无素材姿势的几何人形摆在同一排会像"两种画风混排"（看着像坏了）。
 * 缩略图的作用是"认出是哪个姿势"，几何人形更醒目也更一致。
 *
 * 每张按自身包围盒缩放填满（姿势差异大，统一尺度会让坐姿小得看不清）。
 */
function poseThumbnail(template: PoseTemplate, size = 44): HTMLCanvasElement {
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  const canvas = document.createElement('canvas');
  canvas.className = 'pose-thumb';
  canvas.width = Math.round(size * dpr);
  canvas.height = Math.round(size * dpr);
  canvas.style.width = `${size}px`;
  canvas.style.height = `${size}px`;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  ctx.scale(dpr, dpr);

  const bounds = figureBounds(template.points);
  const spanY = Math.max(1, bounds.maxY - bounds.minY);
  const spanX = Math.max(1, bounds.maxX - bounds.minX);
  const unit = Math.min((size * 0.78) / spanY, (size * 0.84) / spanX);
  const origin = {
    x: size / 2 - ((bounds.minX + bounds.maxX) / 2) * unit,
    y: size * 0.09 - bounds.minY * unit,
  };

  drawFigure(ctx, template.points, origin, unit, {
    edge: 'rgba(126, 216, 255, 0.95)',
    // 缩略图只有 40 多像素，主画面那套「5% 淡填充」在这里等于没有。
    // 小图靠填充把形状撑起来，线宽压到 1.4 才不会糊成一团。
    fill: 'rgba(126, 216, 255, 0.55)',
    lineWidth: 1.4,
  });
  return canvas;
}

export class Ui {
  private readonly root: HTMLElement;
  private readonly startOverlay: HTMLElement;
  private readonly startButton: HTMLButtonElement;
  private readonly startError: HTMLElement;
  private readonly startLoading: HTMLElement;
  private readonly loadingText: HTMLElement;
  private readonly statusModel: HTMLElement;
  private readonly statusFps: HTMLElement;
  private readonly statusPeople: HTMLElement;
  private readonly poseStrip: HTMLElement;
  private readonly sceneTabs: HTMLElement;
  private readonly templates: PoseTemplate[];
  private activeScene: SceneId = 'street';
  private readonly shutter: HTMLButtonElement;
  private readonly preview: HTMLElement;
  private readonly previewImg: HTMLImageElement;
  /**
   * 照片尺寸标注。**故意做成可选**：它是纯展示节点，一旦 HTML 与 JS 版本错位
   * （Service Worker 缓存了旧 index.html），`requireElement` 抛错会让整个 Ui
   * 构造失败 → 整页白屏。为一个标注付这个代价不值得。
   */
  private readonly previewMeta: HTMLElement | null;
  private readonly saveButton: HTMLAnchorElement;
  private readonly closeButton: HTMLButtonElement;
  private readonly systemCameraButton: HTMLButtonElement | null;
  private readonly toastElement: HTMLElement;
  private readonly toggleButtons: HTMLButtonElement[];
  private readonly toggleState: Record<ToggleKey, boolean>;
  private readonly callbacks: UiCallbacks;

  private previewUrl: string | null = null;
  /** 当前预览的原图。壳里保存相册要用它读成 base64，浏览器里用不到。 */
  private previewBlob: Blob | null = null;
  private toastTimer = 0;
  private shutterTimer = 0;
  /** 可点击提示的 click 处理器（移除监听时需要同一引用）。 */
  private toastActionHandler: (() => void) | null = null;

  constructor(templates: PoseTemplate[], toggles: Record<ToggleKey, boolean>, callbacks: UiCallbacks) {
    this.callbacks = callbacks;
    this.toggleState = { ...toggles };

    this.root = this.requireElement('app');
    this.startOverlay = this.requireElement('start-overlay');
    this.startButton = this.requireElement<HTMLButtonElement>('start-btn');
    this.startError = this.requireElement('start-error');
    this.startLoading = this.requireElement('start-loading');
    this.loadingText = this.requireElement('loading-text');
    this.statusModel = this.requireElement('status-model');
    this.statusFps = this.requireElement('status-fps');
    this.statusPeople = this.requireElement('status-people');
    this.poseStrip = this.requireElement('pose-strip');
    this.sceneTabs = this.requireElement('scene-tabs');
    this.templates = templates;
    this.shutter = this.requireElement<HTMLButtonElement>('shutter');
    this.preview = this.requireElement('preview');
    this.previewImg = this.requireElement<HTMLImageElement>('preview-img');
    this.previewMeta = document.getElementById('preview-meta');
    this.saveButton = this.requireElement<HTMLAnchorElement>('btn-save');
    this.closeButton = this.requireElement<HTMLButtonElement>('btn-close');
    this.systemCameraButton = document.getElementById('btn-system-camera') as HTMLButtonElement | null;
    this.toastElement = this.requireElement('toast');
    this.toggleButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-toggle]'));

    this.renderSceneTabs();
    this.renderPoseStrip();
    this.syncToggleButtons();
    this.bindEvents();
  }

  // ------------------------------------------------------------ 对外接口

  /** 状态机阶段：影响状态灯颜色。 */
  setPhase(phase: 'idle' | 'loading' | 'ready' | 'error'): void {
    this.root.dataset.phase = phase;
  }

  /** 顶部状态条。 */
  setStatus(status: { model?: string; fps?: number; detectFps?: number; people?: number }): void {
    if (status.model !== undefined) {
      this.statusModel.textContent = status.model;
    }
    if (status.fps !== undefined) {
      // 「检测 N 帧/s」= 每秒实际送进模型并拿到结果的帧数（降频后的推理频率），
      // 与画面里有没有人无关，避免用户把 0 误读成故障。
      const detect = Math.round(status.detectFps ?? 0);
      this.statusFps.textContent = `${Math.round(status.fps)} FPS · 检测 ${detect} 帧/s`;
    }
    if (status.people !== undefined) {
      this.statusPeople.textContent = status.people > 0 ? '人体 已识别' : '人体 未识别';
    }
  }

  /** 首屏遮罩显隐。 */
  setStartOverlayVisible(visible: boolean): void {
    this.startOverlay.classList.toggle('is-hidden', !visible);
  }

  /** 加载态：进度条 + 阶段文案 + 按钮禁用。 */
  setStartBusy(busy: boolean, message?: string): void {
    this.startLoading.hidden = !busy;
    this.startButton.disabled = busy;
    this.startButton.textContent = busy ? '正在准备摄像头…' : '开启摄像头';
    if (message) this.loadingText.textContent = message;
  }

  /** 首屏错误文案（null 表示清除）。 */
  setStartError(message: string | null): void {
    const hasMessage = !!message;
    this.startError.hidden = !hasMessage;
    this.startError.textContent = message ?? '';
  }

  /** 高亮当前姿势。 */
  setSelectedTemplate(id: string): void {
    const items = this.poseStrip.querySelectorAll<HTMLButtonElement>('.pose-item');
    items.forEach((item) => {
      const active = item.dataset.poseId === id;
      item.classList.toggle('is-active', active);
      item.setAttribute('aria-selected', String(active));
    });
  }

  /** 拍照预览弹层。 */
  showPreview(blob: Blob): void {
    this.revokePreviewUrl();
    this.previewBlob = blob;
    this.previewUrl = URL.createObjectURL(blob);
    this.previewImg.src = this.previewUrl;
    this.saveButton.href = this.previewUrl;
    this.saveButton.download = `拍照指导-${timestampForFileName(new Date())}.jpg`;
    this.preview.hidden = false;
    this.renderPreviewMeta();
  }

  hidePreview(): void {
    this.preview.hidden = true;
    this.previewImg.removeAttribute('src');
    if (this.previewMeta) this.previewMeta.textContent = '';
    this.previewBlob = null;
    this.revokePreviewUrl();
  }

  /**
   * 显示照片的实际像素尺寸。
   *
   * 这不是装饰：照片「糊」的时候，用户看到 499×1080 才能判断是采集分辨率不够，
   * 而不是对焦 / 手抖 / 保存压缩的问题。尺寸只能等图片解码完才知道，
   * 所以挂在 onload 上读 naturalWidth。
   */
  private renderPreviewMeta(): void {
    const meta = this.previewMeta;
    if (!meta) return;
    meta.textContent = '';
    this.previewImg.onload = () => {
      const width = this.previewImg.naturalWidth;
      const height = this.previewImg.naturalHeight;
      if (!width || !height) return;
      const megapixels = (width * height) / 1_000_000;
      meta.textContent = `${width} × ${height} · ${megapixels.toFixed(1)} MP`;
    };
  }

  /**
   * 通过原生桥接把照片写进系统相册（仅 Android 壳内可用）。
   *
   * 成功提示由原生侧弹（它才知道 MediaStore 到底成没成功），这里不重复弹。
   */
  private async saveViaBridge(bridge: NativeBridge): Promise<void> {
    const blob = this.previewBlob;
    if (!blob) {
      this.toast('还没有可保存的照片');
      return;
    }
    try {
      const dataUrl = await blobToDataUrl(blob);
      bridge.saveImage(dataUrl, this.saveButton.download || 'photo.jpg');
    } catch {
      this.toast('保存失败，请重试');
    }
  }

  /** 快门按下反馈。 */
  flashShutter(): void {
    this.shutter.classList.add('is-flashing');
    window.clearTimeout(this.shutterTimer);
    this.shutterTimer = window.setTimeout(() => {
      this.shutter.classList.remove('is-flashing');
    }, 180);
  }

  /** 轻提示（2 秒自动消失）。 */
  toast(message: string, durationMs = 2000): void {
    this.clearToastAction();
    this.toastElement.textContent = message;
    this.toastElement.classList.add('is-visible');
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      this.toastElement.classList.remove('is-visible');
    }, durationMs);
  }

  /**
   * 可点击的提示（PWA「有新版本」用）。
   *
   * 平时 toast 是 `role="status"` 的只读提示、且 `pointer-events: none`（不能挡住快门），
   * 只有这个场景才临时变成可点：加 `is-action` 类放开点击、点击后执行 action 并收起。
   */
  toastAction(message: string, action: () => void, durationMs = 12000): void {
    this.clearToastAction();
    this.toastElement.textContent = message;
    this.toastElement.classList.add('is-visible', 'is-action');
    this.toastElement.setAttribute('role', 'button');
    this.toastElement.setAttribute('tabindex', '0');

    const trigger = (): void => {
      this.clearToastAction();
      action();
    };
    this.toastActionHandler = trigger;
    this.toastElement.addEventListener('click', trigger);
    this.toastElement.addEventListener('keydown', this.onToastKeydown);

    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.clearToastAction(), durationMs);
  }

  // ------------------------------------------------------------ 内部实现

  private requireElement<T extends HTMLElement = HTMLElement>(id: string): T {
    const element = document.getElementById(id);
    if (!element) throw new Error(`缺少 DOM 节点 #${id}`);
    return element as T;
  }

  /** 场景 Tab：街拍 / 室内 / 户外。切换后重新渲染姿势条。 */
  private renderSceneTabs(): void {
    this.sceneTabs.innerHTML = '';
    for (const scene of SCENES) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'scene-tab';
      button.dataset.scene = scene.id;
      button.textContent = scene.name;
      button.title = scene.hint;
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', String(scene.id === this.activeScene));
      if (scene.id === this.activeScene) button.classList.add('is-active');
      button.addEventListener('click', () => {
        if (this.activeScene === scene.id) return;
        this.activeScene = scene.id;
        this.renderSceneTabs();
        this.renderPoseStrip();
      });
      this.sceneTabs.append(button);
    }
  }

  private renderPoseStrip(): void {
    this.poseStrip.innerHTML = '';
    const list = this.templates.filter((template) => template.scene === this.activeScene);
    for (const template of list) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'pose-item';
      button.dataset.poseId = template.id;
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', 'false');
      button.title = template.description;

      const icon = document.createElement('span');
      icon.className = 'pose-icon';
      icon.append(poseThumbnail(template));

      const label = document.createElement('span');
      label.className = 'pose-name';
      label.textContent = template.name;

      button.append(icon, label);
      button.addEventListener('click', () => {
        this.callbacks.onSelectTemplate(template.id);
      });
      this.poseStrip.append(button);
    }
  }

  private syncToggleButtons(): void {
    for (const button of this.toggleButtons) {
      const key = button.dataset.toggle as ToggleKey | undefined;
      if (!key) continue;
      const active = this.toggleState[key];
      button.classList.toggle('is-on', active);
      button.setAttribute('aria-pressed', String(active));
    }
  }

  private bindEvents(): void {
    this.startButton.addEventListener('click', () => {
      this.setStartError(null);
      this.callbacks.onStart();
    });

    this.shutter.addEventListener('click', () => {
      this.callbacks.onShutter();
    });

    this.closeButton.addEventListener('click', () => {
      this.hidePreview();
      this.callbacks.onPreviewClose();
    });

    // 「用系统相机拍」只在壳里有意义：浏览器里点它会跳到相机 App 再回来，
    // 照片还落在相册里，用户根本不知道发生了什么。
    const bridge = nativeBridge();
    const systemCamera = this.systemCameraButton;
    if (systemCamera) {
      if (bridge && typeof bridge.openSystemCamera === 'function') {
        systemCamera.hidden = false;
        systemCamera.addEventListener('click', () => {
          // 顺序不能反：先把摄像头让出来，系统相机才打得开
          this.hidePreview();
          this.callbacks.onPreviewClose();
          this.callbacks.onSystemCameraRequest();
          bridge.openSystemCamera?.();
        });
      } else {
        systemCamera.hidden = true;
      }
    }

    // 「保存到相册」：浏览器里交给 <a download> 的默认下载；Android 壳里
    // WebView 不支持 download，必须拦下来走原生桥接，否则点了没反应。
    this.saveButton.addEventListener('click', (event) => {
      const bridge = nativeBridge();
      if (!bridge) return; // 浏览器：保持默认行为
      event.preventDefault();
      void this.saveViaBridge(bridge);
    });

    for (const button of this.toggleButtons) {
      button.addEventListener('click', () => {
        const key = button.dataset.toggle as ToggleKey | undefined;
        if (!key) return;
        const next = !this.toggleState[key];
        this.toggleState[key] = next;
        button.classList.toggle('is-on', next);
        button.setAttribute('aria-pressed', String(next));
        this.callbacks.onToggleChange(key, next);
      });
    }
  }

  /** 收起「可点击提示」：移除点击/键盘监听、恢复只读语义、隐藏。幂等。 */
  private clearToastAction(): void {
    if (this.toastActionHandler) {
      this.toastElement.removeEventListener('click', this.toastActionHandler);
      this.toastActionHandler = null;
    }
    this.toastElement.removeEventListener('keydown', this.onToastKeydown);
    this.toastElement.classList.remove('is-visible', 'is-action');
    this.toastElement.setAttribute('role', 'status');
    this.toastElement.removeAttribute('tabindex');
  }

  /** 可点击提示也支持键盘（Enter / 空格）触发。 */
  private readonly onToastKeydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    this.toastElement.click();
  };

  private revokePreviewUrl(): void {
    if (this.previewUrl) {
      URL.revokeObjectURL(this.previewUrl);
      this.previewUrl = null;
    }
  }
}

/** 生成 20250101-120000 形式的文件名片段。 */
function timestampForFileName(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return [
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`,
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`,
  ].join('-');
}
