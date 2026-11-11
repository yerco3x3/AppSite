/* =====================================================================
   Llavero de Sitios · funcionamiento sin conexión (service worker)
   Guarda en el equipo la página, la conexión a Firebase, sus librerías
   y las fuentes, para que la página abra aunque no haya señal.
   Los datos (sitios, instructivos, contactos) los guarda la propia
   página en el equipo; este archivo no los toca.
   Si cambias este archivo, sube el número de VERSION.
   ===================================================================== */
const VERSION = 'llavero-v1';
const SCOPE = self.registration.scope;
const INDEX = new URL('./', SCOPE).href;
const LOCAL = ['config.js', 'manifest.json', 'icon-192.png', 'icon-512.png', 'icon-maskable.png'].map((f) => new URL(f, SCOPE).href);
const SDK = ['app', 'auth', 'firestore'].map((m) => `https://www.gstatic.com/firebasejs/10.14.1/firebase-${m}-compat.js`);
const FONTS_CSS = 'https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Sans+Condensed:wght@600&family=IBM+Plex+Mono:wght@500;600&display=swap';
const NET_WAIT = 4000; // con señal débil, a los 4 s se usa la copia guardada

// Copia limpia (sin marca de redirección) para poder responder a una navegación
async function clean(r) {
  if (!r.redirected) return r;
  return new Response(await r.blob(), { status: r.status, statusText: r.statusText, headers: r.headers });
}

async function putRemote(cache, url) {
  try {
    const r = await fetch(url, { mode: 'cors', credentials: 'omit' });
    if (!r.ok) throw new Error(String(r.status));
    await cache.put(url, r.clone());
    return r;
  } catch (_) {
    try { const r = await fetch(url, { mode: 'no-cors' }); await cache.put(url, r); } catch (_) {}
    return null;
  }
}

// Solo los archivos de letras latinas (español); evita bajar alfabetos que no se usan
async function putFonts(cache) {
  const r = await putRemote(cache, FONTS_CSS);
  if (!r) return;
  const css = await r.text();
  const urls = [];
  const re = /\/\*\s*(latin(?:-ext)?)\s*\*\/\s*@font-face\s*\{[^}]*?url\((https:[^)]+)\)/g;
  let m;
  while ((m = re.exec(css))) urls.push(m[2]);
  await Promise.all(urls.map((u) => putRemote(cache, u)));
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    // La página es imprescindible; si no se puede guardar, se reintenta en la próxima visita
    const page = await fetch(new Request(INDEX, { cache: 'reload' }));
    if (!page.ok) throw new Error('No se pudo guardar la página');
    await cache.put(INDEX, await clean(page));
    await Promise.all(LOCAL.map(async (u) => {
      try { const r = await fetch(new Request(u, { cache: 'reload' })); if (r.ok) await cache.put(u, await clean(r)); } catch (_) {}
    }));
    await Promise.all(SDK.map((u) => putRemote(cache, u)));
    try { await putFonts(cache); } catch (_) {}
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('llavero-') && k !== VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

const wait = (ms) => new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms));

// Página y archivos propios: primero la red (para recibir cambios), y si no hay señal, la copia
async function networkFirst(event, key) {
  const cache = await caches.open(VERSION);
  const net = fetch(event.request).then((r) => {
    if (r && r.ok && r.type === 'basic') event.waitUntil(clean(r.clone()).then((c) => cache.put(key, c)).catch(() => {}));
    return r;
  });
  net.catch(() => {});
  try {
    const r = await Promise.race([net, wait(NET_WAIT)]);
    if (r.ok) return r;
    return (await cache.match(key, { ignoreSearch: true })) || r;
  } catch (_) {
    const hit = await cache.match(key, { ignoreSearch: true });
    return hit || net;
  }
}

// Librerías de Firebase y fuentes: no cambian (la versión va en la dirección), se usa la copia
async function cacheFirst(event) {
  const cache = await caches.open(VERSION);
  const hit = await cache.match(event.request.url);
  if (hit) return hit;
  const r = await fetch(event.request);
  if (r && (r.ok || r.type === 'opaque')) event.waitUntil(cache.put(event.request.url, r.clone()).catch(() => {}));
  return r;
}

async function staleWhileRevalidate(event) {
  const cache = await caches.open(VERSION);
  const hit = await cache.match(event.request.url);
  const net = fetch(event.request).then((r) => {
    if (r && (r.ok || r.type === 'opaque')) event.waitUntil(cache.put(event.request.url, r.clone()).catch(() => {}));
    return r;
  });
  if (hit) { net.catch(() => {}); return hit; }
  return net;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    if (!req.url.startsWith(SCOPE) || url.pathname.endsWith('/sw.js')) return;
    const key = req.mode === 'navigate' ? INDEX : url.origin + url.pathname;
    event.respondWith(networkFirst(event, key));
    return;
  }
  // Firestore y el ingreso (googleapis.com) nunca pasan por aquí: siempre van a la red
  if (url.hostname === 'www.gstatic.com' && url.pathname.startsWith('/firebasejs/')) { event.respondWith(cacheFirst(event)); return; }
  if (url.hostname === 'fonts.gstatic.com') { event.respondWith(cacheFirst(event)); return; }
  if (url.hostname === 'fonts.googleapis.com') { event.respondWith(staleWhileRevalidate(event)); return; }
});
