const CACHE = 'petsmart-entregas-v15';
const FILES = [
  './', './index.html', './app.js', './firebase-config.js', './manifest.webmanifest',
  './icon-delivery-v15.svg', './icon-delivery-192-v15.png', './icon-delivery-512-v15.png',
  './icon-delivery-maskable-512-v15.png', './apple-touch-icon-v15.png', './pets-hero.svg'
];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(key => key.startsWith('petsmart-entregas-') && key !== CACHE).map(key => caches.delete(key))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(fetch(event.request).then(response => {
    if (response && response.ok) caches.open(CACHE).then(cache => cache.put(event.request, response.clone()));
    return response;
  }).catch(() => caches.match(event.request).then(cached => cached || caches.match('./index.html'))));
});
