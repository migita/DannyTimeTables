const CACHE_NAME = 'danny-times-v1';
const BASE = new URL('./', self.location.href);
const APP_SHELL = [
  BASE.href,
  new URL('index.html', BASE).href,
  new URL('manifest.webmanifest', BASE).href,
  new URL('icon.svg', BASE).href,
  new URL('icon-192.png', BASE).href,
  new URL('icon-512.png', BASE).href,
  new URL('apple-touch-icon.png', BASE).href,
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(APP_SHELL);

    const indexUrl = new URL('index.html', BASE).href;
    const indexResponse = await fetch(indexUrl, { cache: 'reload' });
    const html = await indexResponse.text();
    const bundleUrls = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
      .map((match) => new URL(match[1], indexUrl))
      .filter((url) => url.origin === self.location.origin)
      .map((url) => url.href);
    await cache.addAll([...new Set(bundleUrls)]);
  })());
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          void caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(async () => (
          await caches.match(request) ??
          await caches.match(BASE.href) ??
          await caches.match(new URL('index.html', BASE).href)
        )),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          void caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      });
      return cached ?? network;
    }),
  );
});
