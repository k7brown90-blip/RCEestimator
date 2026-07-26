import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

// Served by the CRM's Express app under /field (see app/src/app.ts), not at the
// domain root — so the base, the manifest start_url and the service worker scope
// all have to agree on the prefix. Change this and the Express mount together.
export default defineConfig({
  base: '/field/',
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'Red Cedar Health Record',
        short_name: 'RCE Health',
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
