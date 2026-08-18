/* Service Worker — GitHub Pages サブパス対応 / 更新確実反映
   v5: 8の字校正を任意化。HTMLは network-first。 */
const CACHE = 'align-pwa-v6';
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
  const isHTML = req.mode==='navigate' || (req.headers.get('accept')||'').includes('text/html');
  if(isHTML){
    e.respondWith(fetch(req).then(res=>{ const c=res.clone(); caches.open(CACHE).then(x=>x.put(req,c)).catch(()=>{}); return res; })
      .catch(()=>caches.match(req).then(c=>c||caches.match('./index.html'))));
    return;
  }
  e.respondWith(caches.match(req).then(cached=>cached||fetch(req).then(res=>{ const c=res.clone(); caches.open(CACHE).then(x=>x.put(req,c)).catch(()=>{}); return res; }).catch(()=>cached)));
});
