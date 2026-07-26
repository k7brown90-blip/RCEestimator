// Bump on any change to this file — a new name is what forces waiting clients
// to reinstall and drop the previous cache.
const CACHE_NAME = "rce-v4";
const APP_SHELL = "/";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.add(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

/**
 * Navigations are network-first, and that is the whole point.
 *
 * index.html references content-hashed bundles (/assets/index-<hash>.js). Every
 * deploy emits a new hash and drops the old file, so a cached shell asks for a
 * bundle that no longer exists, the module script 404s, React never mounts, and
 * the page renders blank. Serving HTML cache-first bricks the app on the next
 * deploy and cannot recover on its own.
 *
 * The cached shell is kept only as an offline fallback.
 */
self.addEventListener("fetch", (event) => {
  const { request } = event;

  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Let the field PWA manage its own scope — it registers its own worker.
  if (url.pathname.startsWith("/field")) return;

  // Never touch API traffic beyond a plain pass-through.
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/mcp")) {
    event.respondWith(fetch(request));
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(APP_SHELL, copy));
          return response;
        })
        .catch(() => caches.match(APP_SHELL).then((cached) => cached || Response.error()))
    );
    return;
  }

  // Hashed assets are immutable, so cache-first is safe here — the filename
  // changes when the content does. Populated at runtime rather than precached,
  // so the cache always matches the shell that asked for it.
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.ok && url.origin === self.location.origin) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    })
  );
});
