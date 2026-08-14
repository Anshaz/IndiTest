const CACHE_NAME = 'confluence-alarm-v1';
const ASSETS = ['./index.html', './manifest.json', './icon-192.png', './icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// App shell (HTML/CSS/JS/icons) is cached for offline install.
// Live API calls to Twelve Data always go to the network, never cached,
// so quotes are never served stale.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.hostname.includes('twelvedata.com')) return; // never cache live data
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
