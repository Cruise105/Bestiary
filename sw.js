// Offline support: every app file is cached on first visit, then served from the device.
// When you publish an update, bump VERSION so tablets pick up the new files on their next launch.
const VERSION = 'bestiary-v45';
const FILES = [
  './', './index.html', './styles.css', './app.js', './db.js', './parser.js', './combat.js', './encounters.js', './sync.js', './sheets.js', './cs-model.js', './cs-rules.js', './conditions.js', './conditions-srd.js', './player.html', './player.js',
  './srd-monsters.json', './srd2024-monsters.json', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png',
  './fonts/alegreya-latin-400-normal.woff2', './fonts/alegreya-latin-400-italic.woff2',
  './fonts/alegreya-latin-700-normal.woff2', './fonts/alegreya-latin-800-normal.woff2', './fonts/alegreya-latin-700-italic.woff2',
  './fonts/alegreya-sans-latin-400-normal.woff2', './fonts/alegreya-sans-latin-400-italic.woff2',
  './fonts/alegreya-sans-latin-500-normal.woff2', './fonts/alegreya-sans-latin-700-normal.woff2',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES.map(u => new Request(u, { cache: 'reload' })))).then(() => caches.open(VERSION)).then(c => c.add(new Request('/core/suite.js', { cache: 'reload' })).catch(() => {})) // the suite core, if reachable
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('bestiary-') && k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // The shared suite core (/core/) lives outside this app: always try the newest copy, fall back to the saved one offline
  if (e.request.method === 'GET' && url.origin === location.origin && url.pathname.startsWith('/core/')) {
    // no-cache: check with the server every time (GitHub Pages otherwise lets browsers reuse a copy for 10 minutes)
    e.respondWith(fetch(e.request, { cache: 'no-cache' }).then(res => { if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); } return res; })
      .catch(() => caches.match(e.request, { ignoreSearch: true })));
    return;
  }
  // only this app's files; the character sheet code it borrows is fetched fresh from its own folder
  if (e.request.method !== 'GET' || url.origin !== location.origin || !url.pathname.startsWith(new URL(self.registration.scope).pathname)) return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then(hit => hit || fetch(e.request))
  );
});
