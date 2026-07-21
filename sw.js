const VERSION = '2026.07.20.09';
const CACHE   = `blockdrop-${VERSION}`;
const FILES   = ['./', './index.html', './style.css', './game.js', './levels.js', './manifest.json', './icon.svg', './qrcode.min.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)));
  self.skipWaiting(); // activate new SW immediately after install
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()) // take control of all open tabs
  );
  // Notify all clients that a new version is available
  self.clients.matchAll({ type: 'window' }).then(clients =>
    clients.forEach(c => c.postMessage({ type: 'NEW_VERSION', version: VERSION }))
  );
});

self.addEventListener('fetch', e =>
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)))
);
