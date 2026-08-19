/**
 * Service Worker – Zone2 Trainer PWA
 */

const CACHE_NAME = 'zone2-trainer-v4';
const BASE = self.registration.scope;

const STATIC_ASSETS = [
    BASE,
    BASE + 'index.html',
    BASE + 'css/style.css',
    BASE + 'js/app.js',
    BASE + 'js/config.js',
    BASE + 'js/session.js',
    BASE + 'js/history.js',
    BASE + 'js/fit_export.js',
    BASE + 'js/bluetooth/h10.js',
    BASE + 'js/bluetooth/powermeter.js',
    BASE + 'js/bluetooth/d100.js',
    BASE + 'js/algorithms/hr_controller.js',
    BASE + 'js/algorithms/pwhr_drift.js',
    BASE + 'manifest.json',
    BASE + 'icons/icon.svg',
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll(STATIC_ASSETS).catch((err) => {
                console.warn('[SW] Einige Assets konnten nicht gecacht werden:', err);
            });
        })
    );
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

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    if (url.hostname === 'cdn.jsdelivr.net') {
        event.respondWith(
            fetch(event.request)
                .then((response) => {
                    const cloned = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(event.request, cloned));
                    return response;
                })
                .catch(() => caches.match(event.request))
        );
        return;
    }

    if (url.origin === self.location.origin) {
        event.respondWith(
            caches.match(event.request).then((cached) => {
                if (cached) return cached;
                return fetch(event.request).then((response) => {
                    if (response && response.status === 200) {
                        const cloned = response.clone();
                        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, cloned));
                    }
                    return response;
                });
            })
        );
    }
});
