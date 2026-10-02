// Offline support: every app file is cached on first visit, then served from the device.
// When you publish an update, bump VERSION so tablets pick up the new files on their next launch.
const VERSION = 'bestiary-v2';
const FILES = [
  './', './index.html', './styles.css', './app.js', './db.js', './parser.js',
  './srd-monsters.json', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png',
  './fonts/alegreya-latin-400-normal.woff2', './fonts/alegreya-latin-400-italic.woff2',
  './fonts/alegreya-latin-700-normal.woff2', './fonts/alegreya-latin-800-normal.woff2',
  './fonts/alegreya-sans-latin-400-normal.woff2', './fonts/alegreya-sans-latin-400-italic.woff2',
  './fonts/alegreya-sans-latin-500-normal.woff2', './fonts/alegreya-sans-latin-700-normal.woff2',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then(hit => hit || fetch(e.request))
  );
});
