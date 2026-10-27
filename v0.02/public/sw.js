/* Minimal offline shell for Kanban Board (v0.02).
   Network-first for the page itself (so updates always win), cached copy only when the Pi is unreachable.
   Never touches /api/* or /healthz. Browsers only run this on secure origins (http://localhost on the Pi TV,
   or HTTPS later); phones on plain http://<pi-ip>:8080 skip it until v0.03 adds HTTPS. */
const CACHE='kanban-shell-v0.02';
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.add('./')).catch(()=>{}));self.skipWaiting();});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',e=>{
  const req=e.request,u=new URL(req.url);
  if(req.method!=='GET'||u.origin!==self.location.origin||u.pathname.includes('/api/')||u.pathname.endsWith('/healthz'))return;
  if(req.mode!=='navigate')return;
  e.respondWith(fetch(req).then(r=>{if(r.ok){const cp=r.clone();caches.open(CACHE).then(c=>c.put('./',cp));}return r;})
    .catch(()=>caches.match('./').then(r=>r||new Response('Board server unreachable',{status:503,headers:{'Content-Type':'text/plain'}}))));
});
