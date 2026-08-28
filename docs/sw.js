/* AppPrize Service Worker
 * - App shell：stale-while-revalidate（先回快取秒開，背景抓新版更新快取，
 *   下次載入即為新版 — 不需手動改版本號）
 * - ./data/：network-first（價格快照要新鮮），失敗退回快取
 * - 跨網域（proxy、匯率、iTunes）：不攔截，交給頁面自己的備援邏輯
 */
const VERSION = 'appprize-v1';
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

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()),
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
      fetch(e.request)
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

  // shell：stale-while-revalidate
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) => {
      const refresh = fetch(e.request)
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
