import { useEffect, useState } from 'react'
import {
  cachedMe,
  clearCrmSettings,
  confirmClock,
  defaultBaseUrl,
  endShift,
  fetchMe,
  fetchShiftStatus,
  getCrmSettings,
  pendingSyncCount,
  saveCrmSettings,
  startShift,
  syncAssignments,
  type CrmTechnician,
  type ShiftStatus,
} from '../../lib/crmSync'
import type { CrmAssignment } from '../../domain/types'

/** Production job or estimate visit — the card dresses as what it is (Phase 2). */
const JOB_STATUSES = new Set(['contracted', 'scheduled', 'in_progress'])

interface Props {
  /** Tapping a card opens the job site — the day's verbs live there, not here. */
  onOpenVisit: (assignment: CrmAssignment) => void
  /** My accounts (2026-09-01): the serviced-address history, no appointment needed. */
  onOpenAccounts?: () => void
  /** Purchases (2026-09-09): start a PO with no job — truck stock, warehouse, tool. */
  onOpenPurchases?: () => void
  onOpenMyTruck?: () => void
  /** A token was just consumed from the enrollment QR's URL fragment. */
  justEnrolled?: boolean
}


function formatScheduled(iso: string | null): string {
  if (!iso) return 'Not scheduled'
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  })
}

/** One visit on the day's list — who, where, when, and WHAT KIND it is. */
function VisitCard({ assignment, onOpen }: { assignment: CrmAssignment; onOpen: (a: CrmAssignment) => void }) {
  const isJob = JOB_STATUSES.has(assignment.visitStatus)
  return (
    <button
      type="button"
      onClick={() => onOpen(assignment)}
      className="block w-full rounded-lg border border-sky-900 bg-slate-800 p-3 text-left text-white"
    >
      <span className="flex items-center justify-between gap-2">
        <span className="font-medium">{assignment.customerName}</span>
        <span className={`shrink-0 rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
          isJob ? 'bg-amber-600 text-amber-50' : 'bg-sky-700 text-sky-100'
        }`}>
          {isJob ? 'Job' : 'Estimate'}
        </span>
      </span>
      <span className="block text-sm text-slate-300">{assignment.address.line1}</span>
      <span className="block text-xs text-slate-400">
        {assignment.address.city}, {assignment.address.state} {assignment.address.postalCode}
      </span>
      <span className="mt-1 block text-xs text-sky-300">
        {formatScheduled(assignment.scheduledStart)}
        {assignment.jobType ? ` · ${assignment.jobType}` : ''}
      </span>
      {(assignment.openFindingCount ?? 0) > 0 && (
        <span className="mt-1 block text-xs text-amber-300">
          {assignment.openFindingCount} open finding
          {assignment.openFindingCount === 1 ? '' : 's'} on record here
          {(assignment.declinedFindingCount ?? 0) > 0 &&
            ` · ${assignment.declinedFindingCount} already declined`}
        </span>
      )}
      {assignment.jurisdictionSource === 'default' && (
        <span className="mt-1 block text-xs text-amber-300">⚠ Jurisdiction not set by the office</span>
      )}
    </button>
  )
}

const fmtHm = (min: number) => `${Math.floor(min / 60)}h ${String(Math.round(min % 60)).padStart(2, '0')}m`

/** "YYYY-MM-DDTHH:mm" for a datetime-local input, in the phone's own clock. */
function localInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * THE SHIFT CLOCK — payroll, on the MAIN screen (Kyle, 2026-09-11): "clock in /
 * clock out ... working whether or not a job is assigned. Payroll hours are
 * clocked-in to clocked-out."
 *
 * Clocking out while a job clock runs PAUSES that job first, and this bar says
 * so. A clock left running past 12 hours is flagged: it has STOPPED ACCRUING
 * and the red banner asks for the real end time before it can count again.
 */
function ClockBar() {
  const [status, setStatus] = useState<ShiftStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [said, setSaid] = useState<string | null>(null)
  const [answer, setAnswer] = useState<Record<string, string>>({})
  const [, tick] = useState(0)

  const load = async () => {
    try {
      setStatus(await fetchShiftStatus())
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? `Clock needs signal — ${err.message}` : 'Clock needs signal.')
    }
  }
  useEffect(() => { void load() }, [])
  // Keep the running total honest without hammering the server.
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 30_000)
    return () => clearInterval(timer)
  }, [])

  const punch = async () => {
    setBusy(true)
    setError(null)
    setSaid(null)
    try {
      if (status?.clockedInAt) {
        const result = await endShift()
        setSaid(
          result.pausedJob
            ? `Clocked out — ${fmtHm(result.minutes)}. Your job clock was still running, so it was paused for you.`
            : `Clocked out — ${fmtHm(result.minutes)} on the shift.`,
        )
      } else {
        await startShift()
        setSaid('Clocked in. The day is running.')
      }
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const confirm = async (kind: 'shift' | 'job', id: string) => {
    const typed = answer[id]
    if (!typed) return
    setBusy(true)
    setError(null)
    try {
      await confirmClock(kind, id, new Date(typed).toISOString())
      setSaid('Thanks — that clock is squared away.')
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const running = status?.clockedInAt
    ? Math.max(0, Math.round((Date.now() - new Date(status.clockedInAt).getTime()) / 60_000))
    : 0
  const todayTotal = (status?.todayShiftMinutes ?? 0) + running

  return (
    <section className="space-y-2">
      <div className={`flex items-center justify-between gap-3 rounded-xl border p-3 ${
        status?.clockedInAt ? 'border-emerald-700 bg-emerald-950/40' : 'border-slate-700 bg-slate-800/60'
      }`}>
        <div>
          <p className="text-sm font-medium text-white">
            {status?.clockedInAt ? `Clocked in ${fmtHm(running)}` : 'Clocked out'}
          </p>
          <p className="text-xs text-slate-400">
            {fmtHm(todayTotal)} today
            {status && status.todayJobMinutes > 0 ? ` · ${fmtHm(status.todayJobMinutes)} on jobs` : ''}
          </p>
        </div>
        <button
          type="button"
          disabled={busy || !status}
          onClick={() => void punch()}
          className={`shrink-0 rounded-lg px-4 py-3 text-sm font-semibold text-white disabled:opacity-40 ${
            status?.clockedInAt ? 'bg-red-700' : 'bg-emerald-700'
          }`}
        >
          {busy ? '…' : status?.clockedInAt ? 'Clock out' : 'Clock in'}
        </button>
      </div>

      {said && <p className="rounded-lg bg-slate-800 p-2 text-xs text-emerald-200">{said}</p>}
      {error && <p className="rounded-lg bg-red-950/60 p-2 text-xs text-red-200">{error}</p>}

      {(status?.flagged ?? []).map((f) => (
        <div key={f.id} className="space-y-2 rounded-xl border border-red-600 bg-red-950/60 p-3">
          <p className="text-sm font-semibold text-red-100">
            A clock ran {f.hoursOpen} hours without stopping.
          </p>
          {f.jobLabel && <p className="text-sm font-medium text-red-50">{f.jobLabel}</p>}
          <p className="text-xs text-red-200">
            {f.kind === 'shift' ? 'Shift' : 'Job'} started {new Date(f.startedAt).toLocaleString()}. It stopped
            counting at 12 hours and will not count again until you tell us when it really ended.
          </p>
          <input
            type="datetime-local"
            className="w-full rounded border border-red-700 bg-slate-900 p-2 text-sm text-white"
            max={localInputValue(new Date())}
            value={answer[f.id] ?? ''}
            onChange={(e) => setAnswer((a) => ({ ...a, [f.id]: e.target.value }))}
          />
          <button
            type="button"
            disabled={busy || !answer[f.id]}
            onClick={() => void confirm(f.kind, f.id)}
            className="w-full rounded-lg bg-red-700 p-2 text-sm font-medium text-white disabled:opacity-40"
          >
            That's when I finished
          </button>
        </div>
      ))}
    </section>
  )
}

function relativeTime(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} hr ago`
  return `${Math.round(hours / 24)} d ago`
}

export function AssignmentScreen({ onOpenVisit, onOpenAccounts, onOpenPurchases, onOpenMyTruck, justEnrolled }: Props) {
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

  // Today first, by clock; everything else after. The tech's question at 7 AM
  // is "where am I going" — the list answers in that order.
  const todayKey = new Date().toDateString()
  const isToday = (a: CrmAssignment) =>
    a.scheduledStart != null && new Date(a.scheduledStart).toDateString() === todayKey
  const byClock = (a: CrmAssignment, b: CrmAssignment) => {
    const at = a.scheduledStart ? new Date(a.scheduledStart).getTime() : Infinity
    const bt = b.scheduledStart ? new Date(b.scheduledStart).getTime() : Infinity
    return at - bt
  }
  const todays = assignments.filter(isToday).sort(byClock)
  const later = assignments.filter((a) => !isToday(a)).sort(byClock)
  // Grouped by day (Kyle, 2026-09-01): a scheduled job shows up under its date,
  // so the week reads like a schedule. Unscheduled visits gather at the end.
  const laterByDay: Array<[string, CrmAssignment[]]> = []
  for (const a of later) {
    const key = a.scheduledStart
      ? new Date(a.scheduledStart).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })
      : 'Not scheduled yet'
    const bucket = laterByDay.find(([k]) => k === key)
    if (bucket) bucket[1].push(a)
    else laterByDay.push([key, [a]])
  }

  return (
    <div className="mx-auto max-w-xl space-y-5 p-6">
      <header className="space-y-1">
        <p className="text-xs uppercase tracking-[0.2em] text-sky-300">Red Cedar Electric</p>
        <h1 className="text-2xl font-semibold text-white">RCE Field</h1>
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
          {/* The shift clock rides the top of the main screen — it works whether
              or not there is a job on the list (Kyle, 2026-09-11). */}
          <ClockBar />

          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium text-slate-300">Today</h2>
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

            {todays.map((assignment) => (
              <VisitCard key={assignment.assignmentId} assignment={assignment} onOpen={onOpenVisit} />
            ))}
            {!loading && todays.length === 0 && (
              <p className="rounded-lg border border-slate-700 bg-slate-800/60 p-3 text-sm text-slate-400">
                Nothing on today's schedule.
              </p>
            )}

            {laterByDay.length > 0 && (
              <>
                <h2 className="pt-2 text-sm font-medium text-slate-300">Coming up</h2>
                {laterByDay.map(([day, list]) => (
                  <div key={day} className="space-y-2">
                    <h3 className="text-xs font-medium uppercase tracking-wide text-slate-500">{day}</h3>
                    {list.map((assignment) => (
                      <VisitCard key={assignment.assignmentId} assignment={assignment} onOpen={onOpenVisit} />
                    ))}
                  </div>
                ))}
              </>
            )}

            {!loading && assignments.length === 0 && (
              <p className="rounded-lg border border-slate-700 bg-slate-800/60 p-4 text-sm text-slate-400">
                No visits assigned to you right now — ask the office to assign you one.
              </p>
            )}
          </section>

          {onOpenAccounts && (
            <button
              type="button"
              onClick={onOpenAccounts}
              className="w-full rounded-lg border border-sky-800 bg-slate-800/60 p-3 text-sm font-medium text-sky-200"
            >
              🏠 My accounts — history at every address you service
            </button>
          )}

          {onOpenPurchases && (
            <button
              type="button"
              onClick={onOpenPurchases}
              className="w-full rounded-lg border border-amber-800 bg-slate-800/60 p-3 text-sm font-medium text-amber-200"
            >
              🧾 Purchases — get a PO number before you buy
            </button>
          )}

          {onOpenMyTruck && (
            <button
              type="button"
              onClick={onOpenMyTruck}
              className="w-full rounded-lg border border-emerald-800 bg-slate-800/60 p-3 text-sm font-medium text-emerald-200"
            >
              🚚 My truck — stock, tools, restock, land a PO
            </button>
          )}

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
