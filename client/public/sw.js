// Bump on any change to this file — a new name is what forces waiting clients
// to reinstall and drop the previous cache.
const CACHE_NAME = "rce-v5";
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

/**
 * Web push for Messages (work order agent-team, U7). The server sends a title, one generic line, a tap URL
 * and a tag - never a customer's name, address or phone, never message text. Showing it is all this does;
 * what a tap opens is decided by the URL the server chose (/messages?thread=<id>).
 */
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = {};
  }
  const title = typeof data.title === "string" && data.title ? data.title : "Red Cedar Messages";
  const options = {
    body: typeof data.body === "string" ? data.body : "",
    tag: typeof data.tag === "string" ? data.tag : undefined,
    icon: "/logo.png",
    data: { url: typeof data.url === "string" ? data.url : "/messages" },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  // Only a path on this site: the notification's URL is a path (/messages?thread=...), never another origin.
  let target = "/messages";
  const wanted = event.notification.data && event.notification.data.url;
  if (typeof wanted === "string" && wanted.startsWith("/") && !wanted.startsWith("//") && !wanted.startsWith("/field")) {
    target = wanted;
  }
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      const open = windows.find((w) => new URL(w.url).origin === self.location.origin && !new URL(w.url).pathname.startsWith("/field"));
      if (open) {
        return open.focus().then(() => (typeof open.navigate === "function" ? open.navigate(target) : undefined));
      }
      return self.clients.openWindow(target);
    })
  );
});
