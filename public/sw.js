/**
 * 拍照指导 Service Worker（手写，无构建工具、无 Workbox）。
 *
 * 设计目标：**添加到主屏后能离线启动，并且第一次打开就能离线**，同时绝不让
 * 18MB 的 MediaPipe 包拖慢/搞挂安装。
 *
 * 三条策略，各自的原因写在对应位置：
 *   1. install  —— 预缓存 app shell（HTML/manifest/图标）+ **20 张剪影 PNG**（共 932KB）
 *      + `mp/pose.js`（47KB，解析期脚本，见 SHELL_ASSETS 里的说明）。
 *      剪影必须预缓存：它们在 main.ts 模块顶层就 preload，那时 SW 还没就绪，靠
 *      "运行时缓存"根本来不及。`/mp/` 的模型本体（18MB wasm+tflite）**故意不进预缓存**：
 *      安装阶段下载 18MB 极易超时，一旦失败整个 SW 就装不上，用户连"离线打开"
 *      都拿不到；它改为首次使用时按需缓存（cache-first）。
 *   2. activate —— 清掉旧版本缓存（cache 名以版本号结尾），但**不无条件** clients.claim()。
 *      首次安装场景见文件末尾 CLAIM 消息；更新场景交给用户点刷新。
 *   3. fetch    —— 导航请求走 network-first（保证用户拿到最新 HTML），其余同源静态资源
 *      走 cache-first（相机页最怕卡，本地有就直接用）。
 *
 * 版本升级方式：改 VERSION 即可。旧缓存会在新 SW activate 时被清掉。
 *
 * ⚠️ 部署相关：本项目的托管平台用 `?sharecode=` 作为访问凭证（种 30 天 cookie），
 * 不带凭证直接访问 `/` 会 403。所以 manifest 里的 `start_url` 特意写成
 * `./?sharecode=...`，保证每次从桌面图标启动都能重新拿到凭证；
 * 导航返回非 2xx 时也会回退缓存（见 handleNavigate），双保险。
 */

const VERSION = 'v3';
const SHELL_CACHE = 'shell-' + VERSION;
const ASSET_CACHE = 'asset-' + VERSION;

/**
 * app shell：离线启动所需的最小集合 + 桌面图标 + **解析期就必须存在的运行时脚本**。
 * 不含 `/mp/` 的大块资源（18MB，见文件头说明）；`/sil/` 单独列在下面。
 */
const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  // iOS 添加到主屏用 apple-touch-icon；favicon-32 是桌面标签页兜底。都只有几 KB。
  './icons/apple-touch-icon-180.png',
  './icons/favicon-32.png',
  // ⚠️ /mp 里唯一的例外：pose.js（47KB）由 index.html 的 <script> 在**解析期**加载，
  // 那时 SW 还没激活、请求根本不经过 SW，因此"用到再缓存"对它永远无效 ——
  // 不预缓存的话，首次打开后断网会缺 window.Pose，相机直接起不来。
  // 模型本体（tflite / wasm / data / binarypb，共 18MB）仍然不进预缓存。
  './mp/pose.js',
];

/**
 * 剪影素材（20 张，共 932KB）。
 *
 * 为什么必须预缓存而不是等用到再缓存：`main.ts` 在**模块顶层**就调用
 * `preloadSilhouettes(SILHOUETTE_IDS)`，这个时机早于 SW 注册完成，这些请求
 * 根本不会经过 SW；等 SW 就绪时图已经下载完了，缓存里什么都没有 —— 用户第一次
 * 打开后断网，一张剪影都看不到。932KB 的代价可以接受。
 *
 * Service Worker 无法枚举目录，只能显式写死清单；新增素材时记得同步这里
 * （`.probe` 里有个脚本会比对 SILHOUETTE_GEOM 的 key 与这份清单）。
 */
const SIL_ASSETS = [
  './sil/adjust-collar.png',
  './sil/arms-crossed.png',
  './sil/arms-open.png',
  './sil/back-hand.png',
  './sil/both-pockets.png',
  './sil/check-phone.png',
  './sil/cross-step.png',
  './sil/hair-flip.png',
  './sil/hand-in-pocket.png',
  './sil/hand-on-hip.png',
  './sil/hand-shade.png',
  './sil/hat-tip.png',
  './sil/jump.png',
  './sil/lean-wall.png',
  './sil/lean-window.png',
  './sil/peace-up.png',
  './sil/point-far.png',
  './sil/side-glance.png',
  './sil/stand-natural.png',
  './sil/walk-turn.png',
];

/** 离线且缓存里连 shell 都没有时的兜底响应（宁可给一句话，也不要白屏）。 */
const OFFLINE_FALLBACK = new Response('离线且缓存为空，请联网后重新打开一次。', {
  status: 503,
  statusText: 'Offline',
  headers: { 'Content-Type': 'text/plain; charset=utf-8' },
});

// ---------------------------------------------------------------- install

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // 逐个 add 而不是 addAll：addAll 是原子的，任何一个 404 都会让整个安装失败，
      // 而"少一张图标"不该导致 App 装不上。单个失败只告警，其它照样缓存。
      const urls = SHELL_ASSETS.concat(SIL_ASSETS);
      const results = await Promise.allSettled(urls.map((url) => cache.add(url)));
      results.forEach((result, index) => {
        if (result.status === 'rejected') {
          console.warn('[sw] 预缓存失败：', urls[index], result.reason);
        }
      });
    })(),
  );
});

// ---------------------------------------------------------------- activate

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      const stale = keys.filter((key) => !key.endsWith(VERSION));
      await Promise.all(stale.map((key) => caches.delete(key)));
      // 这里刻意不调用 self.clients.claim()：
      // 新 SW 立刻接管旧页面的后果是「页面还是旧 JS、缓存已经是新资源」，
      // 两代代码混用会出现莫名其妙的错位（例如旧代码请求已改名的资源）。
      // 让新 SW 等到下一次导航再接管，配合下面的 SKIP_WAITING 消息机制，
      // 由用户在"有新版本"的提示里主动确认刷新。
    })(),
  );
});

// ---------------------------------------------------------------- fetch

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // 非 GET（POST 等）直接放行，交给浏览器默认处理，不要拦截。
  if (request.method !== 'GET') return;

  // 只处理同源请求：跨域（字体/埋点/第三方）放行，避免 opaque 响应污染缓存。
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigate(request));
    return;
  }

  event.respondWith(handleAsset(request));
});

/**
 * 导航请求：network-first。
 *
 * 为什么不让 HTML 走 cache-first：HTML 里引用的 JS/CSS 文件名带 hash，
 * 一旦 HTML 被缓存住，发版后用户会一直加载旧 HTML + 旧 hash 的资源，
 * 永远看不到新版本。所以导航永远先问网络，成功就顺手刷新 shell 缓存，
 * 断网才用缓存兜底（这才是"离线可用"的意义）。
 */
async function handleNavigate(request) {
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      const cache = await caches.open(SHELL_CACHE);
      // 不 await：写缓存晚一点没关系，不能因为磁盘慢拖慢首屏。
      cache.put('./index.html', response.clone()).catch(() => {});
      return response;
    }
    // 服务端返回非 2xx 时不要直接把错误页交给用户。
    // 真实场景：部署平台用 `?sharecode=` 做访问凭证，凭证过期（30 天）或
    // 从桌面图标直接启动而 URL 里没带凭证时，站点会返回 403 —— 界面上就是
    // 一片白，用户只会认为"这个 App 坏了"。有缓存就先用缓存把 App 拉起来。
    const cached = await caches.match('./index.html', { ignoreSearch: true });
    if (cached) {
      console.warn('[sw] 导航返回', response ? response.status : 'no-response', '，改用缓存启动');
      return cached;
    }
    return response;
  } catch (error) {
    const cached = await caches.match('./index.html', { ignoreSearch: true });
    if (cached) return cached;
    console.warn('[sw] 离线且无 shell 缓存', error);
    return OFFLINE_FALLBACK;
  }
}

/**
 * 静态资源：cache-first（stale-while-revalidate 的简化版，不主动后台更新）。
 *
 * `/mp/*` 的 wasm / tflite 与 `/sil/*` 的 PNG 都走这条：命中缓存直接返回，
 * 没命中就下载、克隆一份进缓存。写缓存一律 catch —— 隐私模式、磁盘满、
 * 响应体已被消费都会让 put() 抛错，绝不能因此让页面拿不到资源。
 */
async function handleAsset(request) {
  const cache = await caches.open(ASSET_CACHE);
  // 先查 asset 缓存，miss 再查全部缓存。
  // 为什么必须查全部：`/sil/*.png` 和 `/mp/pose.js` 是 install 阶段预缓存进
  // SHELL_CACHE 的，只查 ASSET_CACHE 会全部 miss → 联网时能现拉所以看不出问题，
  // 一旦离线就是「页面起来了但剪影一张都没有」。
  const cached = (await cache.match(request)) || (await caches.match(request));
  if (cached) return cached;

  const response = await fetch(request);
  // 只缓存"完整且成功"的响应；206（Range）之类不能直接 put。
  if (response && response.ok && response.status === 200) {
    cache.put(request, response.clone()).catch((error) => {
      console.warn('[sw] 写缓存失败（忽略）', request.url, error);
    });
  }
  return response;
}

// ---------------------------------------------------------------- 更新 / 首次接管

/**
 * 两条消息，分别对应两个场景：
 *
 * - `SKIP_WAITING`（**更新**场景）：**不自动 skipWaiting**。自动跳过等待会立刻激活
 *   新 SW，但当前页面的 JS 还是旧的 —— 旧页面 + 新缓存 = 状态错位（典型表现：
 *   资源 404、模块加载失败）。所以流程是：新 SW 进入 waiting → 页面弹
 *   「有新版本，点这里刷新」→ 用户点击 → 页面 postMessage → 新 SW 接管 →
 *   页面监听 controllerchange 后 reload，此时新旧完全一致。
 *
 * - `CLAIM`（**首次安装**场景）：页面主动要求接管。首次安装时页面在整个生命周期里
 *   都没有 controller（activate 里刻意不无条件 claim），于是本页后续发出的
 *   `/mp/`（18MB）和 `/sil/` 请求都不会经过 SW、也就不会进缓存 —— 用户"装完
 *   第一次打开 → 断网"会直接失败，离线能力要等到第二次打开才成立。
 *   首次安装不存在"旧页面 + 新缓存"的错位风险（页面和 SW 是同一版本、同一时刻
 *   加载的），所以这时 claim 是安全的。
 *
 * 两条策略不矛盾：**更新**不 claim（等用户点），**首次安装**由页面显式要求 claim。
 * 页面只在 `controller === null`（从未被接管）时才发 CLAIM，见 src/pwa.ts。
 */
self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data) return;

  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }

  if (data.type === 'CLAIM') {
    self.clients.claim();
  }
});
