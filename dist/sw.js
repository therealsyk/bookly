// Bookly service worker: precaches the app shell and caches audio already
// played, with a size cap. Books/PDFs live in IndexedDB, so they work offline
// without any network. No server URLs or secrets here.

const SHELL_CACHE = "bookly-shell";
const AUDIO_CACHE = "bookly-audio";
const MAX_AUDIO_BYTES = 500 * 1024 * 1024; // 500 MB cap

// Shell assets needed to boot the app offline. Relative URLs only, so they
// work on GitHub Pages (repo subpath) and locally. The install step fetches
// each one and skips any that 404 (e.g. hashed/bundled module names), so a
// missing entry never aborts the whole precache.
const SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./sw.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./locales/pt-PT.json",
  "./locales/en.json",
];

function isAudio(url) {
  return /\.(mp3|m4a|aac|ogg)(\?|$)/i.test(url);
}

// Keep the audio cache under MAX_AUDIO_BYTES by removing the oldest entries.
async function trimAudioCache() {
  const cache = await caches.open(AUDIO_CACHE);
  const items = await cache.keys();
  let total = 0;
  for (const req of items) {
    const res = await cache.match(req);
    if (res) total += (res.headers.get("content-length") ? Number(res.headers.get("content-length")) : 0);
  }
  // Oldest-first eviction: cache.keys() returns insertion order.
  for (const req of items) {
    if (total <= MAX_AUDIO_BYTES) break;
    const res = await cache.match(req);
    const size = res && res.headers.get("content-length") ? Number(res.headers.get("content-length")) : 0;
    await cache.delete(req);
    total -= size;
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      // Cache each entry independently: in the built app some module paths are
      // bundled/hashed and would 404, which must not abort the whole install.
      Promise.all(SHELL.map((path) => fetch(path).then((r) => r.ok ? cache.put(path, r) : null)))
    )
  );
});

// When a new version of the worker is ready, claim clients so the update applies.
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return; // only cache GETs

  // Audio: try network first (so it gets stored fresh), fall back to cache.
  if (isAudio(request.url)) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const clone = response.clone();
            caches.open(AUDIO_CACHE).then((cache) => {
              cache.put(request, clone);
              trimAudioCache();
            });
          }
          return response;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // Shell: serve from cache when offline.
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response && response.ok && SHELL.some((p) => request.url.endsWith(p))) {
          const clone = response.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put(request, clone));
        }
        return response;
      });
    })
  );
});
