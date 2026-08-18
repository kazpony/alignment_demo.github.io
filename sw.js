/* Service Worker — GitHub Pages サブパス対応 / 更新確実反映
   v7: 【重要】HTML/JS/CSS を含む全アセットを network-first に統一。
       これにより「新HTML × 古JS」のような版ずれを根絶する。
       キャッシュはオフライン時のフォールバックとしてのみ使用。 */
const CACHE = 'align-pwa-v7';
const ASSETS = [
  './', './index.html', './styles.css',
  './estimator.js', './magnetics.js', './sensors.js', './app.js',
  './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png',
];
self.addEventListener('install', (e)=>{ e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting())); });
self.addEventListener('activate', (e)=>{ e.waitUntil(
  caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())); });
self.addEventListener('message', (e)=>{ if(e.data&&e.data.type==='SKIP_WAITING') self.skipWaiting(); });

self.addEventListener('fetch', (e)=>{
  const req=e.request; if(req.method!=='GET') return;
  // 全て network-first: オンライン時は常に最新、失敗時のみキャッシュ
  e.respondWith(
    fetch(req).then(res=>{
      const copy=res.clone();
      caches.open(CACHE).then(c=>c.put(req,copy)).catch(()=>{});
      return res;
    }).catch(()=> caches.match(req).then(c=> c || (req.mode==='navigate' ? caches.match('./index.html') : undefined)))
  );
});
