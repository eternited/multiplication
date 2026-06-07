const CACHE = 'multiply-v2';

const STATIC = [
  '.',
  './index.html',
  './manifest.json'
];

// Все 90 аудиофайлов
const AUDIO = [];
for (let a = 2; a <= 10; a++) {
  for (let b = 1; b <= 10; b++) {
    AUDIO.push('./audio/' + a + 'x' + b + '.mp3');
  }
}

const ALL = STATIC.concat(AUDIO);

// HTML-shell всегда грузим сначала из сети, чтобы пользователь моментально получал
// последние правки кода. Кэшированный вариант — только для офлайна.
function isHtmlShell(url) {
  return /\/(index\.html)?(\?.*)?$/.test(url) || url.indexOf('/index.html') !== -1;
}

// Установка — кэшировать всё
self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(CACHE).then(function(cache) {
      return cache.addAll(ALL);
    })
  );
  self.skipWaiting();
});

// Активация — удалить старые кэши
self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(k) { return k !== CACHE; })
            .map(function(k) { return caches.delete(k); })
      );
    })
  );
  self.clients.claim();
});

// Запросы — сначала кэш, потом сеть
self.addEventListener('fetch', function(e) {
  // Firebase и внешние CDN — только сеть
  if (e.request.url.indexOf('firebaseapp.com') !== -1 ||
      e.request.url.indexOf('googleapis.com') !== -1 ||
      e.request.url.indexOf('gstatic.com') !== -1 ||
      e.request.url.indexOf('cdnjs.cloudflare.com') !== -1 ||
      e.request.url.indexOf('firestore.googleapis.com') !== -1) {
    return;
  }
  // HTML-shell: network-first (свежая версия приходит каждый онлайн-визит, не залипает старый код)
  if (e.request.mode === 'navigate' || isHtmlShell(e.request.url)) {
    e.respondWith(
      fetch(e.request).then(function(response) {
        if (response && response.status === 200) {
          var clone = response.clone();
          caches.open(CACHE).then(function(cache) { cache.put(e.request, clone); });
        }
        return response;
      }).catch(function() {
        return caches.match(e.request);
      })
    );
    return;
  }
  e.respondWith(
    caches.match(e.request).then(function(cached) {
      return cached || fetch(e.request).then(function(response) {
        // Кэшировать новые ресурсы
        if (response && response.status === 200) {
          var clone = response.clone();
          caches.open(CACHE).then(function(cache) {
            cache.put(e.request, clone);
          });
        }
        return response;
      });
    })
  );
});
