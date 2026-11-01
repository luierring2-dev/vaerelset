// Gør at uret og siden virker, selvom nettet er væk, når iPad'en genindlæser.
const CACHE = 'home-v2';
const APP_FILES = [
  './',
  './index.html',
  './style.css',
  './manifest.json',
  './icons/icon-180.png',
  './js/alarm.js',
  './js/app.js',
  './js/clock.js',
  './js/config.js',
  './js/http.js',
  './js/settings.js',
  './js/sound.js',
  './js/spotify.js',
  './js/storage.js',
  './js/theme.js',
  './js/todo.js',
  './js/weather.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(APP_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

  // Alle sidevisninger gemmes under samme nøgle, så en login-kode i adressen aldrig havner i cachen.
  const key = request.mode === 'navigate' ? './index.html' : request;
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(key, copy));
        }
        return response;
      })
      .catch(() => caches.match(key)),
  );
});
