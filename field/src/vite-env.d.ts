/// <reference types="vite/client" />

declare module 'virtual:pwa-register' {
  export function registerSW(options?: { immediate?: boolean }): void
}

/** Stamped at build time (vite define) — the bundle's real identity, so a
 * stale service-worker cache is diagnosable from any synced record. */
declare const __BUILD_ID__: string
