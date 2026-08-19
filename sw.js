/**
 * Service Worker – Zone2 Trainer
 *
 * Strategie: Netz zuerst, Cache als Rückfall.
 *
 * Die erste Fassung lieferte alles aus dem Cache und fragte den Server nie
 * wieder. Ein Fehler war damit erst nach einem Hochzählen der Cache-Version
 * beim Nutzer – und wurde die vergessen, gar nicht. Für eine App, die während
 * einer Trainingseinheit zuverlässig sein muss, ist ein veralteter Stand das
 * schlechtere Übel gegenüber ein paar Kilobyte Netzverkehr beim Start.
 *
 * Der Cache bleibt trotzdem vollständig: ohne Netz startet die App normal.
 * Beim Wechsel auf eine neue Version wird nichts erzwungen – die Seite lädt
 * erst neu, wenn die App das erlaubt (also nie mitten in einer Einheit).
 */

const CACHE_NAME = 'zone2-trainer-v5';

const NETWORK_TIMEOUT_MS = 3500;

const STATIC_ASSETS = [
    './',
    './index.html',
    './manifest.json',
    './css/style.css',
    './icons/icon.svg',
    './icons/icon-192.png',
    './icons/icon-512.png',
    './js/app.js',
    './js/config.js',
    './js/storage.js',
    './js/session.js',
    './js/history.js',
    './js/audio.js',
    './js/wakelock.js',
    './js/hr_chart.js',
    './js/demo.js',
    './js/fit_export.js',
    './js/bluetooth/ble_base.js',
    './js/bluetooth/h10.js',
    './js/bluetooth/powermeter.js',
    './js/bluetooth/d100.js',
    './js/algorithms/hr_controller.js',
    './js/algorithms/pwhr_drift.js',
];

self.addEventListener('install', (event) => {
    event.waitUntil((async () => {
        const cache = await caches.open(CACHE_NAME);
        // Einzeln statt addAll: eine fehlende Datei darf nicht die ganze
        // Installation scheitern lassen.
        await Promise.all(STATIC_ASSETS.map(async (url) => {
            try {
                const res = await fetch(new Request(url, { cache: 'reload' }));
                if (res.ok) await cache.put(url, res);
            } catch (err) {
                console.warn('[SW] nicht vorgeladen:', url, err);
            }
        }));
    })());
    // Bewusst kein skipWaiting: die neue Fassung übernimmt erst, wenn die
    // Seite es erlaubt.
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        const keys = await caches.keys();
        await Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)));
        await self.clients.claim();
    })());
});

self.addEventListener('message', (event) => {
    if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;

    const url = new URL(req.url);
    if (url.origin !== self.location.origin) return;

    event.respondWith(networkFirst(req));
});

async function networkFirst(request) {
    const cache = await caches.open(CACHE_NAME);

    try {
        const response = await withTimeout(fetch(request), NETWORK_TIMEOUT_MS);
        if (response && response.ok && response.type === 'basic') {
            cache.put(request, response.clone()).catch(() => {});
        }
        return response;
    } catch {
        const cached = await cache.match(request);
        if (cached) return cached;

        // Navigationsanfragen landen notfalls auf der Startseite, damit die App
        // offline überhaupt hochkommt.
        if (request.mode === 'navigate') {
            const shell = await cache.match('./index.html') ?? await cache.match('./');
            if (shell) return shell;
        }

        return new Response('Offline und nicht im Zwischenspeicher.', {
            status: 503,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
    }
}

function withTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Zeitüberschreitung')), ms);
        promise.then(
            (v) => { clearTimeout(timer); resolve(v); },
            (e) => { clearTimeout(timer); reject(e); }
        );
    });
}
