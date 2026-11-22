/**
 * Field Messages screen (work order agent-team, U7): "Turn on notifications on this device", then
 * "Notifications on ✓ · Turn off". Greyed WITH the reason beside it when this phone cannot do it ("On iPhone,
 * add RCE to the Home Screen first, then open it from there.") or the office has not set notifications up yet.
 * A notification says "New message on a job thread" and nothing about the customer; a tap opens that thread.
 * The same logic as the office's button (shared/hub/pushClient.ts).
 */
import { useEffect, useState } from 'react'
import { fetchHubPushHere, fetchHubPushKey, subscribeHubPush, unsubscribeHubPush, type HubPushKey } from '../../lib/crmSync'
import { currentPushEndpoint, pushBlockedReason, readPushEnv, turnOffPush, turnOnPush } from '../../../../shared/hub/pushClient'

export function NotificationsButton() {
  const [server, setServer] = useState<HubPushKey | undefined>(undefined)
  const [here, setHere] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const key = await fetchHubPushKey()
        const endpoint = await currentPushEndpoint()
        // On means THIS device's address is held for this technician - not that they have some device.
        const onHere = endpoint !== null && (await fetchHubPushHere(endpoint))
        if (alive) {
          setServer(key)
          setHere(onHere)
        }
      } catch {
        // No signal: the button stays greyed with "Checking…" until there is.
      }
    })()
    return () => { alive = false }
  }, [])

  const reason = server ? pushBlockedReason(readPushEnv(), server) : 'Checking whether notifications can be turned on…'

  async function turnOn() {
    if (!server?.publicKey) return
    setBusy(true)
    setError(null)
    try {
      await turnOnPush(server.publicKey, (sub) => subscribeHubPush(sub))
      setHere(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function turnOff() {
    setBusy(true)
    setError(null)
    try {
      await turnOffPush((endpoint) => unsubscribeHubPush(endpoint))
      setHere(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (here) {
    return (
      <p className="flex flex-wrap items-center gap-2 text-xs text-slate-300">
        <span className="font-semibold text-emerald-300">Notifications on ✓</span>
        <button type="button" onClick={() => void turnOff()} disabled={busy} className="rounded border border-slate-600 px-2 py-1 text-xs text-slate-200 disabled:opacity-40">
          {busy ? 'Turning off…' : 'Turn off'}
        </button>
        {error && <span className="text-red-300">{error}</span>}
      </p>
    )
  }
  return (
    <div className="space-y-1">
      <button
        type="button"
        onClick={() => void turnOn()}
        disabled={busy || reason !== null || !server?.publicKey}
        title={reason ?? undefined}
        className="w-full rounded-lg border border-slate-600 p-2 text-xs text-slate-200 disabled:opacity-40"
      >
        {busy ? 'Turning on…' : 'Turn on notifications on this device'}
      </button>
      {reason && <p className="text-xs text-slate-400">{reason}</p>}
      {error && <p className="text-xs text-red-300">{error}</p>}
    </div>
  )
}
