// Двухуровневый кэш:
//  - SHELL (критический минимум для запуска) — атомарный install, секунды даже на медленной сети.
//    Если хоть один файл не скачался, install падает и браузер повторит установку позже —
//    активной остаётся предыдущая рабочая версия. Никаких "дырявых" критических кэшей.
//  - AUDIO (озвучка, 90 mp3) — отдельный кэш, докачивается В ФОНЕ и не блокирует установку.
//    Версию shell поднимаем при каждом изменении состава/стратегии; audio живёт своей жизнью.
const SHELL_CACHE = 'multiply-shell-v5';
const AUDIO_CACHE = 'multiply-audio-v1';
const KEEP_CACHES = [SHELL_CACHE, AUDIO_CACHE];

// Все ресурсы same-origin (библиотеки самохостятся в vendor/) — кэширование простое и проверяемое,
// без CORS/opaque-нюансов. sw.js сам себя не кэширует (браузер хранит скрипт SW отдельно).
const SHELL = [
  '.',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './vendor/react.production.min.js',
  './vendor/react-dom.production.min.js',
  './vendor/babel.min.js',
  './vendor/firebase-app-compat.js',
  './vendor/firebase-auth-compat.js',
  './vendor/firebase-firestore-compat.js'
];

// Все 90 аудиофайлов озвучки
const AUDIO = [];
for (let a = 2; a <= 10; a++) {
  for (let b = 1; b <= 10; b++) {
    AUDIO.push('./audio/' + a + 'x' + b + '.mp3');
  }
}

// Живой трафик Firebase (Auth/Firestore API) кэшировать нельзя.
function isLiveApi(url) {
  return url.indexOf('googleapis.com') !== -1 ||   // firestore, identitytoolkit, securetoken
         url.indexOf('firebaseapp.com') !== -1 ||
         url.indexOf('firebaseio.com') !== -1;
}

// HTML-shell всегда пробуем взять из сети, чтобы пользователь получал свежий код.
function isHtmlShell(url) {
  return /\/(index\.html)?(\?.*)?$/.test(url) || url.indexOf('/index.html') !== -1;
}

function isAudio(url) {
  return url.indexOf('/audio/') !== -1;
}

// Фоновая догрузка озвучки: докачиваем только недостающее. Ошибки не критичны —
// добьём при следующем онлайн-заходе (страница шлёт 'warm-audio' на каждой загрузке).
function warmAudioCache() {
  return caches.open(AUDIO_CACHE).then(function(cache) {
    return Promise.all(AUDIO.map(function(url) {
      return cache.match(url).then(function(hit) {
        if (hit) return;
        return cache.add(url).catch(function() {});
      });
    }));
  }).catch(function() {});
}

// install: атомарно и БЫСТРО — только критический набор (11 файлов, без аудио).
self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(SHELL_CACHE).then(function(cache) {
      return cache.addAll(SHELL);
    })
  );
  self.skipWaiting();
});

// activate: удалить кэши старых версий (audio-кэш сохраняется), забрать клиентов,
// затем — фоновая догрузка аудио (не блокирует активацию).
self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(k) { return KEEP_CACHES.indexOf(k) === -1; })
            .map(function(k) { return caches.delete(k); })
      );
    }).then(function() {
      return self.clients.claim();
    })
  );
  warmAudioCache(); // сознательно не в waitUntil — активация не ждёт 90 файлов
});

// Страница на каждой загрузке просит докачать недостающую озвучку.
// 'refresh-shell' — команда механизма обновления: скачать свежий index.html
// В КЭШ (мимо HTTP-кэша) и доложить об успехе через MessageChannel. Страница
// перезагружается только после ok:true — так обновление срабатывает даже на
// еле живой сети (перезагрузка возьмёт уже обновлённый кэш).
self.addEventListener('message', function(e) {
  if (e.data === 'warm-audio') warmAudioCache();
  if (e.data && e.data.type === 'refresh-shell') {
    var port = e.ports && e.ports[0];
    fetch('./index.html', { cache: 'reload' }).then(function(resp) {
      if (!resp || resp.status !== 200) throw new Error('bad status');
      return caches.open(SHELL_CACHE).then(function(cache) {
        // Навигация обслуживается из ключа '.', прямые запросы — из './index.html':
        // обновляем ОБА, иначе на слабой сети перезагрузка возьмёт старый корень.
        return cache.put('./index.html', resp.clone()).then(function() {
          return cache.put('.', resp.clone());
        });
      });
    }).then(function() {
      if (port) port.postMessage({ ok: true });
    }).catch(function() {
      if (port) port.postMessage({ ok: false });
    });
  }
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
        caches.open(SHELL_CACHE).then(function(cache) { cache.put(request, clone); });
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

// cache-first с сетевым фолбэком и дозаписью в указанный кэш.
function cacheFirst(request, cacheName) {
  return caches.match(request).then(function(cached) {
    if (cached) return cached;
    return fetch(request).then(function(response) {
      if (response && response.status === 200) {
        var clone = response.clone();
        caches.open(cacheName).then(function(cache) { cache.put(request, clone); });
      }
      return response;
    });
  });
}

self.addEventListener('fetch', function(e) {
  var url = e.request.url;
  // Не-GET (POST/PUT к Firestore и т.п.) и живой API — только сеть, мимо кэша.
  if (e.request.method !== 'GET') return;
  if (isLiveApi(url)) return;

  if (e.request.mode === 'navigate' || isHtmlShell(url)) {
    e.respondWith(networkFirstShell(e.request));
    return;
  }
  if (isAudio(url)) {
    e.respondWith(cacheFirst(e.request, AUDIO_CACHE));
    return;
  }
  e.respondWith(cacheFirst(e.request, SHELL_CACHE));
});
