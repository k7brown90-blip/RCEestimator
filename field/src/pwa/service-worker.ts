/// <reference lib="webworker" />

import { precacheAndRoute } from 'workbox-precaching'

declare const self: ServiceWorkerGlobalScope

precacheAndRoute(self.__WB_MANIFEST)

self.addEventListener('install', (event) => {
  self.skipWaiting()
  event.waitUntil(self.clients.claim())
})

// Web push for Messages (work order agent-team, U7). The server sends a title, one generic line, a tap path and
// a tag: never a customer's name, address or phone, and never message text. A tap opens that thread in the
// field app (/field/?thread=<id>), on this origin only.
self.addEventListener('push', (event) => {
  let data: { title?: unknown; body?: unknown; tag?: unknown; url?: unknown } = {}
  try {
    data = event.data ? (event.data.json() as typeof data) : {}
  } catch {
    data = {}
  }
  const title = typeof data.title === 'string' && data.title ? data.title : 'Red Cedar Messages'
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof data.body === 'string' ? data.body : '',
      tag: typeof data.tag === 'string' ? data.tag : undefined,
      icon: '/field/pwa-192x192.png',
      data: { url: typeof data.url === 'string' ? data.url : '/field/' },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const wanted = (event.notification.data as { url?: unknown } | null)?.url
  const target = typeof wanted === 'string' && wanted.startsWith('/field/') && !wanted.startsWith('//') ? wanted : '/field/'
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (windows) => {
      const open = windows.find((w) => new URL(w.url).origin === self.location.origin && new URL(w.url).pathname.startsWith('/field'))
      if (open) {
        await open.focus()
        // The thread id rides in the address; the app reads it on load, so open the address afresh.
        return open.navigate(target)
      }
      return self.clients.openWindow(target)
    }),
  )
})
