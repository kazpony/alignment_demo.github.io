/* Service Worker — GitHub Pages サブパス対応（相対URL登録）。
   v2: スピン補正ロジックへ更新。CACHE名を変えて旧キャッシュを破棄。 */
const CACHE = 'align-pwa-v2';
const ASSETS = [
  './', './index.html', './styles.css',
  './estimator.js', './sensors.js', './app.js',
  './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png',
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  e.respondWith(
    caches.match(req).then((cached) => cached || fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      return res;
    }).catch(() => cached))
  );
});
