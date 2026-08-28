/* AppPrize Service Worker
 * - App shell：stale-while-revalidate（先回快取秒開，背景向伺服器驗證新版，
 *   有更新就寫回快取；配合頁面的 controllerchange 提示，一鍵重新整理即生效）
 * - ./data/：network-first（價格快照要新鮮），失敗退回快取
 * - 跨網域（proxy、匯率、iTunes）：不攔截，交給頁面自己的備援邏輯
 * - 換版：改 VERSION 會在 activate 時清掉所有舊快取
 */
const VERSION = 'appprize-v2';
const SHELL = [
  './',
  './index.html',
  './css/app.css',
  './js/app.js',
  './js/api.js',
  './js/parser.js',
  './js/storefronts.js',
  './js/fx.js',
  './js/db.js',
  './js/compare.js',
  './js/official.js',
  './manifest.webmanifest',
  './icons/favicon.svg',
  './icons/icon-192.png',
];

/** 繞過 HTTP 快取的同內容請求（GitHub Pages 的 max-age 會讓一般 fetch 拿到舊檔） */
function freshRequest(request, mode = 'no-cache') {
  if (request.mode === 'navigate') return new Request(request.url, { cache: mode });
  try {
    return new Request(request, { cache: mode });
  } catch {
    return request;
  }
}

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION)
      // cache: 'reload'：安裝時一律抓伺服器上的最新版，不吃 HTTP 快取
      .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;

  const scopePath = new URL(self.registration.scope).pathname;
  const isData = url.pathname.startsWith(scopePath + 'data/');

  if (isData) {
    // network-first：資料要新鮮
    e.respondWith(
      fetch(freshRequest(e.request))
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(e.request, copy));
          }
          return res;
        })
        .catch(() => caches.match(e.request)),
    );
    return;
  }

  // shell：stale-while-revalidate（背景驗證走 no-cache，確保拿得到新版）
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) => {
      const refresh = fetch(freshRequest(e.request))
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(e.request, copy));
          }
          return res;
        })
        .catch(() => hit);
      return hit || refresh;
    }),
  );
});
