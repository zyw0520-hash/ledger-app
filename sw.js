const VERSION = 'ledger-v22';
const SHELL = [
  './',
  './index.html',
  './manifest.json',
  './css/style.css',
  './lib/dexie.min.js',
  './lib/chart.umd.js',
  './js/app.js',
  './js/calc.js',
  './js/sync.js',
  './js/dialog.js',
  './js/currency.js',
  './js/db.js',
  './js/rates.js',
  './js/recurring.js',
  './js/backup.js',
  './js/views/detail.js',
  './js/views/entry.js',
  './js/views/stats.js',
  './js/views/settings.js',
  './js/tests/selftest.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;

  // 汇率 API：network-first，失败回退缓存
  if (['api.frankfurter.app', 'open.er-api.com'].includes(url.hostname)) {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          const copy = res.clone();
          caches.open(VERSION).then(c => c.put(e.request, copy));
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // 本地资源：cache-first
  if (url.origin === location.origin) {
    e.respondWith(
      caches.match(e.request, { ignoreSearch: url.pathname === '/' }).then(hit => {
        if (hit) return hit;
        return fetch(e.request).then(res => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(VERSION).then(c => c.put(e.request, copy));
          }
          return res;
        });
      })
    );
  }
});
