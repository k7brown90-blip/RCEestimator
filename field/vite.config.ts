/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

// Served by the CRM's Express app under /field (see app/src/app.ts), not at the
// domain root — so the base, the manifest start_url and the service worker scope
// all have to agree on the prefix. Change this and the Express mount together.
export default defineConfig({
  base: '/field/',
  // The Article 220 engine lives in app/shared/, outside this package, so the
  // CRM and the server can run the same calculation. Vite sandboxes file reads
  // to the project root by default, so it has to be allowed explicitly.
  server: { fs: { allow: ['..'] } },
  test: {
    // Vitest's default include is rooted here, which would silently stop running
    // the 609 lines of Annex D tests the moment the engine moved out of src/.
    include: ['src/**/*.test.{ts,tsx}', '../shared/**/*.test.ts'],
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'RCE Field',
        short_name: 'RCE Field',
        description: 'Offline-first electrical health record inspection PWA',
        theme_color: '#07131f',
        background_color: '#07131f',
        display: 'standalone',
        start_url: '/field/',
        scope: '/field/',
        icons: [
          {
            src: 'pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
          },
        ],
      },
      strategies: 'injectManifest',
      srcDir: 'src/pwa',
      filename: 'service-worker.ts',
    }),
  ],
})
