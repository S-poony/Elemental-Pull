// Offline support, and the reason this counts as an installable PWA at all
// — which is what a Play Store TWA wraps. Deliberately hand-written and
// dependency-free: the whole game is one HTML file, one JS bundle, one CSS
// bundle and four icons, which does not need Workbox.
//
// Bump CACHE_VERSION whenever you want every client to drop its cached
// bundle on the next visit. You normally don't have to: Vite fingerprints
// asset filenames, so a new build fetches new URLs anyway, and the stale
// ones are cleaned out below.
const CACHE_VERSION = 'elemental-pull-v1';

// Resolved against the service worker's own location, so this works
// unchanged whether the game is served from a domain root or from a
// GitHub Pages /Elemental-Pull/ subpath.
const SHELL = ['./', './index.html', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      // addAll is all-or-nothing; a single 404 would abort the install and
      // leave the client with no worker at all, so failures are tolerated
      // here and the runtime handler picks the misses up later.
      .then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Navigations go to the network first so a deployed update is picked up
  // on the very next launch, and fall back to the cached shell when
  // there's no connection. Getting this backwards is how a PWA ends up
  // serving a months-old build to everyone who installed it.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() => caches.match(request).then((hit) => hit || caches.match('./index.html')))
    );
    return;
  }

  // Everything else is a fingerprinted asset: its URL changes when its
  // content does, so serving it from cache is always correct and always
  // instant.
  event.respondWith(
    caches.match(request).then((hit) => {
      if (hit) return hit;
      return fetch(request).then((response) => {
        if (response.ok && response.type === 'basic') {
          const copy = response.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    })
  );
});
