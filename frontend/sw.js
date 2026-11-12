// Minimal service worker: caches static shell assets for offline use.
const CACHE = "bookly-shell";
const SHELL = ["/", "/index.html", "/app.js", "/styles.css", "/manifest.json"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL))
  );
});

self.addEventListener("fetch", (event) => {
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
