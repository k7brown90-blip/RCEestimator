import { useEffect, useState } from 'react'
import { db, saveProperty } from '../../db/database'
import {
  cachedMe,
  clearCrmSettings,
  defaultBaseUrl,
  fetchMe,
  fetchVisitPaymentInfo,
  getCrmSettings,
  pendingSyncCount,
  saveCrmSettings,
  syncAssignments,
  type CrmTechnician,
  type VisitPaymentInfo,
} from '../../lib/crmSync'
import type { CrmAssignment, Property } from '../../domain/types'

/**
 * Collect payment in the driveway (Kyle, 2026-08-25: "no way of charging a
 * card on either the admin side or field tech side"). The customer scans the
 * QR or takes the shared link and pays on their own phone through Stripe
 * Checkout — the tech never touches a card number and can't change an amount.
 * Needs signal, deliberately: payment status has to be live to be trusted.
 */
function CollectPayment({ visitId }: { visitId: string }) {
  const [open, setOpen] = useState(false)
  const [info, setInfo] = useState<VisitPaymentInfo | null | 'none'>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await fetchVisitPaymentInfo(visitId)
      setInfo(result ?? 'none')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => { setOpen(true); void load() }}
        className="mt-1 w-full rounded-lg border border-emerald-800 bg-emerald-950/40 p-2 text-xs text-emerald-200"
      >
        💳 Collect payment
      </button>
    )
  }

  return (
    <div className="mt-1 space-y-2 rounded-lg border border-emerald-800 bg-emerald-950/30 p-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-emerald-200">Collect payment</span>
        <span className="flex gap-3">
          <button type="button" className="text-xs text-sky-300 underline" onClick={() => void load()}>
            {loading ? 'checking…' : 'refresh'}
          </button>
          <button type="button" className="text-xs text-slate-400 underline" onClick={() => setOpen(false)}>
            close
          </button>
        </span>
      </div>
      {error && <p className="rounded bg-red-950/60 p-2 text-xs text-red-200">{error}</p>}
      {info === 'none' && (
        <p className="text-xs text-slate-400">No signed estimate on this visit yet — nothing to collect.</p>
      )}
      {info && info !== 'none' && (
        <>
          <p className="text-xs text-slate-300">
            Invoice {info.number} · total ${info.billedTotal.toFixed(2)}
            {info.totalPaid > 0 && ` · paid $${info.totalPaid.toFixed(2)}`}
          </p>
          {info.paidInFull ? (
            <p className="rounded bg-emerald-900/60 p-2 text-sm font-medium text-emerald-200">
              ✓ Paid in full — nothing to collect.
            </p>
          ) : (
            <>
              {!info.depositSatisfied && (
                <div className="rounded-lg bg-white p-2 text-center">
                  <p className="mb-1 text-xs font-medium text-slate-800">
                    Deposit due: ${(info.depositDue - info.depositPaid).toFixed(2)} — customer scans:
                  </p>
                  <img src={info.depositQrUrl} alt="Deposit payment QR" className="mx-auto h-44 w-44" />
                </div>
              )}
              {info.depositSatisfied && (
                <div className="rounded-lg bg-white p-2 text-center">
                  <p className="mb-1 text-xs font-medium text-slate-800">
                    Balance due: ${info.balance.toFixed(2)} — customer scans:
                  </p>
                  <img src={info.qrUrl} alt="Payment QR" className="mx-auto h-44 w-44" />
                </div>
              )}
              <div className="flex gap-2">
                <a
                  href={info.depositSatisfied ? info.payUrl : info.depositPayUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="flex-1 rounded-lg bg-sky-600 p-2 text-center text-xs font-medium text-white"
                >
                  Open pay page
                </a>
                {typeof navigator.share === 'function' && (
                  <button
                    type="button"
                    className="flex-1 rounded-lg border border-slate-600 p-2 text-xs text-slate-200"
                    onClick={() =>
                      void navigator.share({
                        title: 'Red Cedar Electric — pay online',
                        url: info.depositSatisfied ? info.payUrl : info.depositPayUrl,
                      }).catch(() => {})
                    }
                  >
                    Share link
                  </button>
                )}
              </div>
              <p className="text-[10px] text-slate-500">
                Tap refresh after they pay — the paid mark comes from the office record, live.
              </p>
            </>
          )}
        </>
      )}
    </div>
  )
}

interface Props {
  onStart: (property: Property, technician: string) => void
  /**
   * Open the 220.83 capacity check for this job without starting an assessment
   * — the common case is an ordinary service call and a question at the door.
   */
  onCapacityCheck?: (assignment: CrmAssignment) => void
  /** A token was just consumed from the enrollment QR's URL fragment. */
  justEnrolled?: boolean
}

function formatScheduled(iso: string | null): string {
  if (!iso) return 'Not scheduled'
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  })
}

function relativeTime(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} hr ago`
  return `${Math.round(hours / 24)} d ago`
}

export function AssignmentScreen({ onStart, onCapacityCheck, justEnrolled }: Props) {
  const [configured, setConfigured] = useState(getCrmSettings() !== null)
  const [technician, setTechnician] = useState<CrmTechnician | null>(null)
  const [assignments, setAssignments] = useState<CrmAssignment[]>([])
  const [stale, setStale] = useState(false)
  const [cachedAt, setCachedAt] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(0)
  const [showSettings, setShowSettings] = useState(false)
  const [baseUrl, setBaseUrl] = useState(getCrmSettings()?.baseUrl ?? defaultBaseUrl())
  const [token, setToken] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    void pendingSyncCount().then(setPending)
    if (configured) void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configured])

  async function load() {
    setLoading(true)
    setStatus('Loading your jobs…')
    // The cached identity keeps the technician's name on screen offline; the
    // network read refreshes it and re-validates the token.
    setTechnician(await cachedMe())
    try {
      setTechnician(await fetchMe())
      setError(null)
    } catch (err) {
      if (justEnrolled) {
        // A bad or revoked QR otherwise presents as an empty job list, which
        // looks exactly like having no work scheduled.
        clearCrmSettings()
        setConfigured(false)
        setError(
          err instanceof Error
            ? `Enrollment failed: ${err.message}. Ask the office for a fresh QR code.`
            : 'Enrollment failed. Ask the office for a fresh QR code.',
        )
        setLoading(false)
        setStatus(null)
        return
      }
    }

    const result = await syncAssignments()
    setAssignments(result.assignments)
    setStale(result.stale)
    setCachedAt(result.cachedAt)
    setStatus(null)
    setLoading(false)
  }

  async function startAssignment(assignment: CrmAssignment) {
    // Reuse the local property if this job was opened before, so a resumed
    // inspection keeps its existing draft and photos.
    const existing = (await db.properties.toArray()).find((p) => p.crm?.visitId === assignment.visitId)
    if (existing) {
      onStart(existing, technician?.name ?? 'Unknown technician')
      return
    }
    const property: Property = {
      id: crypto.randomUUID(),
      address: assignment.address.formatted,
      jurisdictionId: assignment.jurisdictionId,
      jurisdictionSource: assignment.jurisdictionSource,
      createdAt: new Date().toISOString(),
      crm: {
        visitId: assignment.visitId,
        propertyId: assignment.propertyId,
        customerId: assignment.customerId,
        customerName: assignment.customerName,
      },
    }
    await saveProperty(property)
    onStart(property, technician?.name ?? 'Unknown technician')
  }

  return (
    <div className="mx-auto max-w-xl space-y-5 p-6">
      <header className="space-y-1">
        <p className="text-xs uppercase tracking-[0.2em] text-sky-300">Red Cedar Electric</p>
        <h1 className="text-2xl font-semibold text-white">Electrical Health Record</h1>
        {technician && <p className="text-sm text-slate-400">Signed in as {technician.name}</p>}
      </header>

      {error && <p className="rounded-lg bg-red-900/60 p-3 text-sm text-red-200">{error}</p>}

      {pending > 0 && (
        <p className="rounded-lg bg-amber-900/50 p-3 text-xs text-amber-200">
          {pending} completed record{pending > 1 ? 's' : ''} queued for sync — will push
          automatically when you're back online.
        </p>
      )}

      {!configured ? (
        <section className="space-y-3 rounded-xl border border-sky-800 bg-slate-900/60 p-4">
          <h2 className="text-sm font-medium text-sky-300">Connect this device</h2>
          <p className="text-xs text-slate-400">
            Scan the QR code on the CRM's Team page, or paste your access token below.
          </p>
          <input
            className="w-full rounded-lg border border-slate-600 bg-slate-800 p-3 text-sm text-white"
            placeholder="CRM server URL"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
          <input
            className="w-full rounded-lg border border-slate-600 bg-slate-800 p-3 text-sm text-white"
            placeholder="Technician access token"
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
          <button
            type="button"
            disabled={!baseUrl.trim() || !token.trim()}
            onClick={() => {
              saveCrmSettings({ baseUrl, token })
              setToken('')
              setError(null)
              setConfigured(true)
            }}
            className="w-full rounded-lg bg-sky-600 p-3 text-sm font-medium text-white disabled:opacity-40"
          >
            Connect
          </button>
        </section>
      ) : (
        <>
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium text-slate-300">Your scheduled jobs</h2>
              <button
                type="button"
                onClick={() => void load()}
                disabled={loading}
                className="text-xs text-sky-300 underline disabled:opacity-40"
              >
                Refresh
              </button>
            </div>

            {stale && (
              <p className="rounded-lg bg-slate-800 p-2 text-xs text-amber-200">
                Offline — showing the copy saved{cachedAt ? ` ${relativeTime(cachedAt)}` : ''}.
                You can still complete a record; it'll sync when you reconnect.
              </p>
            )}

            {status && <p className="text-xs text-slate-400">{status}</p>}

            {assignments.map((assignment) => (
              <div key={assignment.assignmentId}>
              <button
                type="button"
                onClick={() => void startAssignment(assignment)}
                className="block w-full rounded-lg border border-sky-900 bg-slate-800 p-3 text-left text-white"
              >
                <span className="font-medium">{assignment.customerName}</span>
                <span className="block text-sm text-slate-300">{assignment.address.line1}</span>
                <span className="block text-xs text-slate-400">
                  {assignment.address.city}, {assignment.address.state} {assignment.address.postalCode}
                </span>
                <span className="mt-1 block text-xs text-sky-300">
                  {formatScheduled(assignment.scheduledStart)}
                  {assignment.jobType ? ` · ${assignment.jobType}` : ''}
                </span>
                {assignment.lastInspectionDate && (
                  <span className="block text-xs text-slate-500">
                    Last assessed {new Date(assignment.lastInspectionDate).toLocaleDateString()}
                  </span>
                )}
                {(assignment.openFindingCount ?? 0) > 0 && (
                  <span className="mt-1 block text-xs text-amber-300">
                    {assignment.openFindingCount} open finding
                    {assignment.openFindingCount === 1 ? '' : 's'} on record here
                    {(assignment.declinedFindingCount ?? 0) > 0 &&
                      ` · ${assignment.declinedFindingCount} already declined`}
                  </span>
                )}
                {assignment.jurisdictionSource === 'default' && (
                  <span className="mt-1 block text-xs text-amber-300">
                    ⚠ Jurisdiction not set by the office
                  </span>
                )}
              </button>
              {onCapacityCheck && (
                <button
                  type="button"
                  onClick={() => onCapacityCheck(assignment)}
                  className="mt-1 w-full rounded-lg border border-slate-700 p-2 text-xs text-slate-300"
                >
                  Adding load here? Run the 220.83 capacity check
                </button>
              )}
              <CollectPayment visitId={assignment.visitId} />
              </div>
            ))}

            {!loading && assignments.length === 0 && (
              <p className="rounded-lg border border-slate-700 bg-slate-800/60 p-4 text-sm text-slate-400">
                No jobs assigned to you right now. Records are opened from a scheduled
                job — ask the office to assign you one.
              </p>
            )}
          </section>

          <button
            type="button"
            onClick={() => setShowSettings((s) => !s)}
            className="text-xs text-slate-500 underline"
          >
            {showSettings ? 'Hide connection settings' : 'Connection settings'}
          </button>

          {showSettings && (
            <div className="space-y-2 rounded-xl border border-slate-700 bg-slate-800/60 p-4">
              <p className="text-xs text-slate-400">Connected to {getCrmSettings()?.baseUrl}</p>
              <button
                type="button"
                onClick={() => {
                  clearCrmSettings()
                  setConfigured(false)
                  setAssignments([])
                  setTechnician(null)
                }}
                className="rounded-lg border border-slate-600 p-2 text-sm text-slate-300"
              >
                Disconnect this device
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
