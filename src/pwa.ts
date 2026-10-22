/**
 * PWA 注册层：只负责 Service Worker 的注册、首次安装接管、新版本就绪事件，不掺 UI。
 *
 * 三个刻意的取舍：
 *   1. 注册失败一律只 warn、绝不 throw —— 相机 App 的主流程是 getUserMedia，
 *      不能因为 SW 装不上（旧版 iOS、非 https、隐私模式、受限 iframe）就白屏；
 *      这些环境里 App 依然完整可用，只是没有离线能力。
 *   2. **首次安装**主动让 SW 接管（CLAIM）：否则本页这一整轮都不会有 controller，
 *      `main.ts` 顶层 preload 的剪影、点"开启摄像头"后加载的 18MB `/mp` 都不经过 SW，
 *      用户"装完第一次打开 → 断网"就白搭，离线能力要等第二次打开才成立。
 *   3. **更新**不自动刷新：把 applyUpdate 交回调用方（main.ts），复用底部 toast，
 *      用户点了才 skipWaiting，避免"页面还是旧 JS、缓存已是新资源"的错位。
 *      首次安装与更新的分流依据就是 `controller` 是否为空（见 setup）。
 */

/** 更新就绪回调：参数是「应用更新」的函数，由调用方决定怎么提示用户。 */
export type UpdateReadyHandler = (applyUpdate: () => void) => void;

export interface PwaOptions {
  /** 检测到新版本（非首次安装）时调用；不传则静默，等下次导航自然切换。 */
  onUpdateReady?: UpdateReadyHandler;
}

/**
 * 注册 Service Worker。
 * 首次安装不触发 onUpdateReady；只有"已有 controller 又来新版本"才算更新。
 */
export function registerServiceWorker(options: PwaOptions = {}): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

  // 开发模式（npm run dev）刻意不注册：dev 下 vite 按需编译 /src/*.ts，
  // 而 SW 的 cache-first 会把这些模块 URL 缓存住 —— 改完代码刷新仍是旧模块，
  // HMR/热更新形同失效，排查半天以为是代码没生效。离线能力只在构建产物里需要。
  if (import.meta.env.DEV) return;

  const container: ServiceWorkerContainer = navigator.serviceWorker;
  const onUpdateReady = options.onUpdateReady;
  /** 防重复刷新：controllerchange 有触发多次的可能 */
  let reloading = false;
  /** 只有"用户点了新版本提示"这条路径才需要刷新（首次 CLAIM 不需要） */
  let reloadAfterSkipWaiting = false;
  let registration: ServiceWorkerRegistration | null = null;
  /** 已进入 waiting 的新 SW，用户点「刷新」时给它发 SKIP_WAITING */
  let waitingWorker: ServiceWorker | null = null;

  /** 应用更新：让 waiting 的新 SW 立刻接管，controllerchange 里再刷新页面。 */
  function applyUpdate(): void {
    const worker = waitingWorker ?? registration?.waiting ?? null;
    if (!worker) {
      // 极端情况：没有 waiting worker（它已自行激活）——直接刷新一次最稳。
      window.location.reload();
      return;
    }
    // 先置位再发消息：controllerchange 可能紧随其后同步到达。
    reloadAfterSkipWaiting = true;
    worker.postMessage({ type: 'SKIP_WAITING' });
  }

  function notifyUpdate(worker: ServiceWorker | null): void {
    waitingWorker = worker;
    if (onUpdateReady) onUpdateReady(applyUpdate);
  }

  function watchRegistration(reg: ServiceWorkerRegistration): void {
    registration = reg;

    // 情况 A：上次访问期间装好了新版本，用户当时没点刷新
    if (reg.waiting && container.controller) {
      notifyUpdate(reg.waiting);
    }

    // 情况 B：本次访问期间发现新版本
    reg.addEventListener('updatefound', () => {
      const installing = reg.installing;
      if (!installing) return;
      installing.addEventListener('statechange', () => {
        if (installing.state !== 'installed') return;
        // 没有 controller = 首次安装（SW 刚装好还没接管），不需要提示刷新；
        // 有 controller = 更新，此时才值得打断用户。
        if (!container.controller) return;
        notifyUpdate(reg.waiting ?? installing);
      });
    });
  }

  /**
   * 注册 + 首次安装接管。
   *
   * 顺序很重要：register 之后如果 `controller` 仍为空，说明这是首次安装，
   * 要等 SW 激活（`container.ready`）再发 CLAIM —— 此时本页还没发出的
   * `/mp`、`/sil` 请求才会经过 SW 被缓存。
   */
  async function setup(): Promise<void> {
    const reg = await container.register('./sw.js');
    watchRegistration(reg);

    if (container.controller) return; // 更新场景：走 waiting + 用户点刷新
    const ready = await container.ready;
    const worker = ready.active ?? reg.active ?? reg.waiting ?? reg.installing;
    if (worker) worker.postMessage({ type: 'CLAIM' });
  }

  // 无论注册成功还是失败，都不能影响主流程：失败只告警。
  try {
    void setup().catch((error: unknown) => {
      console.warn('[pwa] Service Worker 注册失败（忽略，不影响使用）', error);
    });
  } catch (error) {
    console.warn('[pwa] Service Worker 注册抛出异常（忽略，不影响使用）', error);
    return;
  }

  // 新 SW 接管后刷新。注意：首次安装的 CLAIM 也会触发本事件，
  // 但那时页面本身没变（就是刚加载的这一份），刷新纯属多余且会打断首屏 ——
  // 所以只有 reloadAfterSkipWaiting 为真（用户点了更新提示）才真的刷新。
  container.addEventListener('controllerchange', () => {
    if (!reloadAfterSkipWaiting) return;
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });
}
