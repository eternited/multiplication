// Версию кэша поднимаем при каждом изменении списка ресурсов или стратегии —
// activate удалит старые кэши.
const CACHE = 'multiply-v4';

// Локальная статика (app shell). sw.js сам себя НЕ кэширует — браузер хранит
// скрипт SW отдельно, запросы на его обновление идут мимо fetch-обработчика.
const STATIC = [
  '.',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

// CDN-скрипты, без которых приложение не стартует. Список должен В ТОЧНОСТИ
// совпадать с <script src> в index.html — автотест сверяет их автоматически.
const CDN = [
  'https://cdnjs.cloudflare.com/ajax/libs/react/18.2.0/umd/react.production.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.2.0/umd/react-dom.production.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/babel-standalone/7.23.2/babel.min.js',
  'https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/10.7.1/firebase-auth-compat.js',
  'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore-compat.js'
];

// Все 90 аудиофайлов озвучки
const AUDIO = [];
for (let a = 2; a <= 10; a++) {
  for (let b = 1; b <= 10; b++) {
    AUDIO.push('./audio/' + a + 'x' + b + '.mp3');
  }
}

const ALL = STATIC.concat(CDN, AUDIO);

// Живой трафик Firebase (Auth/Firestore API) кэшировать НЕЛЬЗЯ.
// ВАЖНО: gstatic.com сюда не входит — оттуда грузится сам SDK, его как раз кэшируем.
function isLiveApi(url) {
  return url.indexOf('googleapis.com') !== -1 ||   // firestore, identitytoolkit, securetoken
         url.indexOf('firebaseapp.com') !== -1 ||
         url.indexOf('firebaseio.com') !== -1;
}

// HTML-shell всегда пробуем взять из сети, чтобы пользователь получал свежий код.
function isHtmlShell(url) {
  return /\/(index\.html)?(\?.*)?$/.test(url) || url.indexOf('/index.html') !== -1;
}

// Установка — кэшировать всё, но УСТОЙЧИВО: каждый ресурс добавляется отдельно,
// одна недоступная запись (например, битый mp3) не валит установку SW целиком.
// Что не скачалось сейчас — докэшируется при первом онлайн-запросе (см. fetch ниже).
self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(CACHE).then(function(cache) {
      return Promise.all(ALL.map(function(url) {
        return cache.add(url).catch(function(err) {
          console.warn('[SW] не закэшировался:', url, err && err.message);
        });
      }));
    })
  );
  self.skipWaiting();
});

// Активация — удалить старые версии кэша
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

// Network-first с таймаутом для HTML-shell: если сеть не ответила за 3 секунды
// (офлайн или lie-fi), отдаём кэш — приложение открывается быстро, а не висит.
function networkFirstShell(request) {
  function fromCache() {
    return caches.match(request).then(function(cached) {
      return cached || caches.match('./index.html');
    });
  }
  return new Promise(function(resolve) {
    var settled = false;
    var timer = setTimeout(function() {
      fromCache().then(function(cached) {
        if (cached && !settled) { settled = true; resolve(cached); }
        // если кэша нет — продолжаем ждать сеть, fetch ниже разрешит промис
      });
    }, 3000);
    fetch(request).then(function(response) {
      clearTimeout(timer);
      if (response && response.status === 200) {
        var clone = response.clone();
        caches.open(CACHE).then(function(cache) { cache.put(request, clone); });
      }
      if (!settled) { settled = true; resolve(response); }
    }).catch(function() {
      clearTimeout(timer);
      fromCache().then(function(cached) {
        if (!settled) { settled = true; resolve(cached); }
      });
    });
  });
}

self.addEventListener('fetch', function(e) {
  var url = e.request.url;
  // Не-GET (POST/PUT к Firestore и т.п.) и живой API — только сеть, мимо кэша.
  if (e.request.method !== 'GET') return;
  if (isLiveApi(url)) return;

  // HTML-shell: network-first с таймаутом и фолбэком на кэш
  if (e.request.mode === 'navigate' || isHtmlShell(url)) {
    e.respondWith(networkFirstShell(e.request));
    return;
  }

  // Всё остальное — локальная статика, аудио, CDN-скрипты (React/Babel/Firebase SDK):
  // cache-first с сетевым фолбэком и дозаписью в кэш.
  e.respondWith(
    caches.match(e.request).then(function(cached) {
      if (cached) return cached;
      return fetch(e.request).then(function(response) {
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
