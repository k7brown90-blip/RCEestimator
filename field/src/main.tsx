import { StrictMode } from 'react'
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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App justEnrolled={justEnrolled} />
  </StrictMode>,
)
