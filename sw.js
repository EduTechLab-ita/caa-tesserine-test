// ══════════════════════════════════════════════════════════════════
//  Service Worker – Tesserine CAA
//  ⚙️  Aggiorna CACHE_NAME ad ogni deploy per forzare il refresh
// ══════════════════════════════════════════════════════════════════

const CACHE_NAME = 'caartella-v5.50';

const STATIC_ASSETS = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/dictionary.js',
  './js/drive.js',
  './js/ephemeral-store.js',
  './js/parser.js',
  './js/arasaac.js',
  './js/lemmatizer.js',
  './js/custom-images.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  // jsPDF ora è nostro (28/07/2026): niente più cdnjs.cloudflare.com, quindi nessun
  // IP esposto a un terzo fuori UE e nessun CDN che i firewall scolastici possano
  // bloccare. 356 KB nel precache è un prezzo onesto per avere la stampa PDF che
  // funziona sempre, anche a rete filtrata.
  './vendor/jspdf.umd.min.js',
];

// ── Install: pre-cacha i file statici ─────────────────────────────
self.addEventListener('install', event => {
  self.skipWaiting();   // prende controllo immediatamente
  event.waitUntil(
    // cache:'reload' = dal server, mai dalla cache HTTP del browser: altrimenti la cache
    // nuova può nascere con dentro i file della versione vecchia (visto il 20/09/2026).
    caches.open(CACHE_NAME).then(cache =>
      cache.addAll(STATIC_ASSETS.map(u => new Request(u, { cache: 'reload' }))))
  );
});

// ── Activate: elimina cache vecchie ──────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ── Fetch: cache-first per asset locali, network-first per ARASAAC
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Le API ARASAAC vanno sempre in rete (immagini dinamiche)
  if (url.hostname.includes('arasaac.org')) {
    event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
    return;
  }

  // Google (accesso, Drive) e Firebase non passano dal SW: intercettarne le POST e le
  // connessioni in ascolto causa "Failed to fetch" intermittenti (v5.49).
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;

  // Asset locali: cache-first
  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request))
  );
});
