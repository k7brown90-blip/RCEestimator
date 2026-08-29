import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { registerSW } from 'virtual:pwa-register'
import { consumeEnrollmentToken, flushSyncQueue, registerSyncListener } from './lib/crmSync'

// Before createRoot — PropertyScreen reads the saved token in a useState
// initializer, so enrolling any later wouldn't take effect until a reload.
const justEnrolled = consumeEnrollmentToken()

registerSW({ immediate: true })
registerSyncListener()
void flushSyncQueue()

// A new service worker taking control means a newer bundle exists than the one
// running. Announce it instead of running stale silently (Kyle's Caysens walk,
// 2026-08-29, happened on a pre-update cache) — but never force a reload:
// yanking the page mid-inspection is worse than one more tap.
navigator.serviceWorker?.addEventListener('controllerchange', () => {
  window.dispatchEvent(new CustomEvent('rce-app-updated'))
})

/**
 * Fixed banner over every screen once a newer bundle takes control — one tap
 * to reload, never forced (a draft in Dexie survives, but yanking the page
 * mid-walk is still worse than a tap). Shows the running build id so a stale
 * app is identifiable on sight.
 */
function UpdateBanner() {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    const onUpdated = () => setReady(true)
    window.addEventListener('rce-app-updated', onUpdated)
    return () => window.removeEventListener('rce-app-updated', onUpdated)
  }, [])
  if (!ready) return null
  return (
    <button
      type="button"
      onClick={() => window.location.reload()}
      className="fixed inset-x-2 top-2 z-50 rounded-lg bg-amber-500 p-2 text-center text-sm font-semibold text-slate-900 shadow-lg"
    >
      App updated — tap to load the new version (running {__BUILD_ID__})
    </button>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <UpdateBanner />
    <App justEnrolled={justEnrolled} />
  </StrictMode>,
)
