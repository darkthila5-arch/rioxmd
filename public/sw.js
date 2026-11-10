// RIO X MD service worker (makes the site installable and shows an offline page when there is no internet).
// It only ever touches the public pair page, the premium page and plain static files. It NEVER handles /api, /admin, /settings or /health,
// so nothing private is stored, and every page / script / style is fetched from the network first (fresh after each deploy).
const CACHE = 'rio-pwa-v1';
const PAGES = new Set(['/', '/premium']);
const SKIP = /^\/(api|admin|settings|health)(\/|$)/;
const STATIC = /\.(?:css|js|png|jpe?g|webp|gif|svg|ico|webmanifest|woff2?)$/i;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(['/offline.html', '/icon-192.png', '/ghost.png', '/favicon-32.png'].map((u) => cache.add(u).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

// network first (5 s), the saved copy when the network fails
async function networkFirst(request, key) {
  const cache = await caches.open(CACHE);
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 5000);
    const res = await fetch(request, { signal: ctl.signal }).finally(() => clearTimeout(timer));
    if (res.ok && res.type === 'basic') cache.put(key, res.clone()).catch(() => {});
    return res;
  } catch {
    return (await cache.match(key)) || null;
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || req.headers.has('range')) return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || SKIP.test(url.pathname)) return; // the browser handles it as usual

  if (req.mode === 'navigate') {
    if (!PAGES.has(url.pathname)) return; // other pages (admin, settings ...) are never intercepted
    event.respondWith((async () => (await networkFirst(req, url.pathname)) || (await caches.match('/offline.html')) || Response.error())());
    return;
  }
  if (STATIC.test(url.pathname)) {
    event.respondWith((async () => (await networkFirst(req, req.url)) || Response.error())());
  }
});
