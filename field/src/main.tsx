import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { registerSW } from 'virtual:pwa-register'
import { flushSyncQueue, registerSyncListener } from './lib/crmSync'

registerSW({ immediate: true })
registerSyncListener()
void flushSyncQueue()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
