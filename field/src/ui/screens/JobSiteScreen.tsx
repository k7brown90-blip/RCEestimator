/**
 * The job site — one visit, everything the tech does there. (Phase 2, Kyle
 * 2026-08-25: "the field app is specific to getting the job done, the
 * electrical assessment done, and payment processed in the field.")
 *
 * Opens from the Today list. Shows the scope off the signed estimate (lines
 * and quantities — never hours, his standing rule), then the day's verbs:
 * run the assessment, add photos, file receipts, collect payment, and close
 * the job out from the driveway — which notifies the office to schedule
 * whatever comes next. The assessment is one module a visit can include, not
 * the identity of the app.
 */

import { useEffect, useState } from 'react'
import {
  arriveAtJob,
  completeJobClock,
  pauseJobClock,
  completeVisitFromField,
  fetchJobBrief,
  fetchPurchaseOrders,
  scheduleVisitFromField,
  uploadJobPhoto,
  uploadReceiptFromField,
  type FieldPurchaseOrder,
  type JobBrief,
} from '../../lib/crmSync'
import { CollectPayment } from '../components/CollectPayment'
import { MaterialsUsedStep } from '../components/MaterialsUsedStep'
import {
  PhotoPicker,
  PoNumberBanner,
  PurchaseOrderList,
  StartPurchaseForm,
  type CreatedPo,
} from '../components/PurchaseOrderPanel'
import type { CrmAssignment } from '../../domain/types'

const JOB_STATUSES = new Set(['contracted', 'scheduled', 'in_progress', 'completed'])

export function JobSiteScreen({
  assignment,
  onRunAssessment,
  onCapacityCheck,
  onBuildQuote,
  onBack,
}: {
  assignment: CrmAssignment
  onRunAssessment: () => void
  onCapacityCheck?: () => void
  /** Quote in the field (2026-09-01): same book and gates as the office. */
  onBuildQuote?: () => void
  onBack: () => void
}) {
  const [brief, setBrief] = useState<JobBrief | null>(null)
  const [briefError, setBriefError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchJobBrief(assignment.visitId)
      .then((b) => { if (!cancelled) setBrief(b) })
      .catch((err) => { if (!cancelled) setBriefError(err instanceof Error ? err.message : String(err)) })
    return () => { cancelled = true }
  }, [assignment.visitId])

  // ── THE JOB CLOCK (Kyle, 2026-09-11): Arrive → Complete, or Pause on a
  // multi-day job. Job hours are the sum of the arrive-to-leave sessions and
  // they sit INSIDE the shift — arriving while clocked out starts the shift
  // too, and the screen says so. ──
  const [clockedInAt, setClockedInAt] = useState<string | null>(null)
  const [clockSaid, setClockSaid] = useState<string | null>(null)
  // Schedule for later (phase 5): same scheduleJob the office uses — the
  // deposit gate's refusal comes back verbatim and tells the tech what to do.
  const [schedOpen, setSchedOpen] = useState(false)
  const [schedDate, setSchedDate] = useState('')
  const [schedTime, setSchedTime] = useState('08:00')
  const [schedEndDate, setSchedEndDate] = useState('')
  const [schedEndTime, setSchedEndTime] = useState('16:00')
  const [schedBusy, setSchedBusy] = useState(false)
  const [schedMsg, setSchedMsg] = useState<string | null>(null)
  const [laborMinutes, setLaborMinutes] = useState(0)
  const [clockBusy, setClockBusy] = useState(false)
  const [clockError, setClockError] = useState<string | null>(null)
  const [, forceTick] = useState(0)
  useEffect(() => {
    if (!brief) return
    setClockedInAt(brief.clockedInAt)
    setLaborMinutes(brief.laborMinutes)
  }, [brief])
  useEffect(() => {
    if (!clockedInAt) return
    const timer = setInterval(() => forceTick((n) => n + 1), 30_000)
    return () => clearInterval(timer)
  }, [clockedInAt])
  const punch = async (verb: 'arrive' | 'pause' | 'complete') => {
    setClockBusy(true)
    setClockError(null)
    setClockSaid(null)
    try {
      if (verb === 'arrive') {
        const result = await arriveAtJob(assignment.visitId)
        setClockedInAt(result.clockedInAt)
        // Rule 1 — when the arrival started the day, the screen has to say so.
        setClockSaid(
          [
            result.startedShift ? 'Shift started too — you were clocked out.' : null,
            result.pausedOther ? 'Your clock on the other job was paused.' : null,
          ].filter(Boolean).join(' ') || null,
        )
      } else {
        const result = verb === 'pause'
          ? await pauseJobClock(assignment.visitId)
          : await completeJobClock(assignment.visitId)
        setClockedInAt(null)
        setLaborMinutes(result.laborMinutes)
        setClockSaid(
          verb === 'pause'
            ? `Paused — ${fmtHm(result.minutes)} this session. You are still on the clock for the day.`
            : `Job time closed — ${fmtHm(result.minutes)} this session.`,
        )
      }
    } catch (err) {
      setClockError(err instanceof Error ? err.message : String(err))
    } finally {
      setClockBusy(false)
    }
  }
  const elapsedMin = clockedInAt ? Math.max(0, Math.round((Date.now() - new Date(clockedInAt).getTime()) / 60_000)) : 0
  const fmtHm = (min: number) => `${Math.floor(min / 60)}h ${min % 60}m`

  // ── Photos ──
  const [photoCaption, setPhotoCaption] = useState('')
  const [photoStatus, setPhotoStatus] = useState<string | null>(null)
  const [photoBusy, setPhotoBusy] = useState(false)
  const sendPhoto = async (file: File) => {
    setPhotoBusy(true)
    setPhotoStatus(null)
    try {
      await uploadJobPhoto(assignment.visitId, file, photoCaption.trim() || undefined)
      setPhotoStatus('✓ Photo filed to the job.')
      setPhotoCaption('')
    } catch (err) {
      setPhotoStatus(`Upload failed — ${err instanceof Error ? err.message : 'no signal?'} Try again with bars.`)
    } finally {
      setPhotoBusy(false)
    }
  }

  // ── Receipts ──
  const [showReceipt, setShowReceipt] = useState(false)
  const [receiptAmount, setReceiptAmount] = useState('')
  const [receiptVendor, setReceiptVendor] = useState('')
  const [receiptStatus, setReceiptStatus] = useState<string | null>(null)
  const [receiptBusy, setReceiptBusy] = useState(false)
  const sendReceipt = async (file: File) => {
    setReceiptBusy(true)
    setReceiptStatus(null)
    try {
      const result = await uploadReceiptFromField({
        visitId: assignment.visitId,
        blob: file,
        amount: Number(receiptAmount) > 0 ? Number(receiptAmount) : undefined,
        vendor: receiptVendor.trim() || undefined,
        category: 'materials',
      })
      setReceiptStatus(
        result.status === 'pending_review'
          ? `✓ Receipt filed ($${result.amount.toFixed(2)}) — the office reviews it.`
          : `✓ Receipt filed ($${result.amount.toFixed(2)}).`,
      )
      setReceiptAmount('')
      setReceiptVendor('')
    } catch (err) {
      setReceiptStatus(`Upload failed — ${err instanceof Error ? err.message : 'no signal?'}`)
    } finally {
      setReceiptBusy(false)
    }
  }

  // ── Purchase orders (Kyle, 2026-09-05: "allow a P.O. to be made"; 2026-09-09:
  // "start with a P.O. number then the purchase and photo verification of the receipt") ──
  const [showPo, setShowPo] = useState(false)
  const [poOrders, setPoOrders] = useState<FieldPurchaseOrder[]>([])
  const [justCreatedPo, setJustCreatedPo] = useState<CreatedPo | null>(null)
  const [poError, setPoError] = useState<string | null>(null)
  useEffect(() => {
    if (!showPo) return
    let cancelled = false
    void fetchPurchaseOrders(assignment.visitId)
      .then((r) => { if (!cancelled) { setPoOrders(r.orders); setPoError(null) } })
      .catch((err) => { if (!cancelled) setPoError(`Needs signal — ${err instanceof Error ? err.message : String(err)}`) })
    return () => { cancelled = true }
  }, [showPo, assignment.visitId])
  const reloadPos = () => {
    void fetchPurchaseOrders(assignment.visitId)
      .then((r) => { setPoOrders(r.orders); setPoError(null) })
      .catch((err) => setPoError(`Needs signal — ${err instanceof Error ? err.message : String(err)}`))
  }

  // ── Close-out ──
  const [showMaterials, setShowMaterials] = useState(false)
  const [closing, setClosing] = useState(false)
  const [closed, setClosed] = useState<{ warnings: string[] } | null>(null)
  const [closeError, setCloseError] = useState<string | null>(null)
  const closeOut = async () => {
    if (!window.confirm('Close this visit out? It leaves your Today list and the office gets notified.')) return
    setClosing(true)
    setCloseError(null)
    try {
      // Closing the job out completes the job clock too — the work stopped.
      // The SHIFT clock keeps running: the drive home is still paid time.
      if (clockedInAt) {
        const punchResult = await completeJobClock(assignment.visitId)
        setClockedInAt(null)
        setLaborMinutes(punchResult.laborMinutes)
      }
      const result = await completeVisitFromField(assignment.visitId)
      setClosed({ warnings: result.warnings })
    } catch (err) {
      setCloseError(err instanceof Error ? err.message : String(err))
    } finally {
      setClosing(false)
    }
  }

  const isJob = JOB_STATUSES.has(brief?.status ?? assignment.visitStatus ?? '')
  const alreadyDone = brief?.status === 'completed' || Boolean(brief?.completedAt) || Boolean(closed)

  return (
    <div className="mx-auto max-w-xl space-y-4 p-6 pb-16">
      <button type="button" onClick={onBack} className="text-sm text-sky-300">
        ← Today
      </button>

      <header className="space-y-1">
        <span className={`inline-block rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
          isJob ? 'bg-amber-600 text-amber-50' : 'bg-sky-700 text-sky-100'
        }`}>
          {isJob ? 'Job' : 'Estimate visit'}
        </span>
        <h1 className="text-xl font-semibold text-white">{assignment.customerName}</h1>
        <p className="text-sm text-slate-300">{assignment.address.formatted}</p>
        {brief?.customerPhone && (
          <a href={`tel:${brief.customerPhone}`} className="text-sm text-sky-300 underline">
            {brief.customerPhone}
          </a>
        )}
      </header>

      {briefError && <p className="rounded-lg bg-red-950/60 p-2 text-xs text-red-200">{briefError}</p>}

      {/* ── The JOB clock: Arrive → Complete, Pause on a multi-day job ── */}
      {brief && (
        <section className={`space-y-2 rounded-xl border p-3 ${
          clockedInAt ? 'border-emerald-700 bg-emerald-950/40' : 'border-slate-700 bg-slate-800/60'
        }`}>
          <div>
            <p className="text-sm font-medium text-white">
              {clockedInAt ? `On this job — ${fmtHm(elapsedMin)} this session` : 'Not on this job right now'}
            </p>
            <p className="text-xs text-slate-400">
              {laborMinutes > 0 ? `${fmtHm(laborMinutes)} already on this job` : 'No hours on this job yet'}
            </p>
          </div>
          {clockedInAt ? (
            <div className="flex gap-2">
              <button
                type="button"
                disabled={clockBusy}
                onClick={() => void punch('pause')}
                className="flex-1 rounded-lg bg-slate-600 px-3 py-3 text-sm font-semibold text-white disabled:opacity-40"
              >
                {clockBusy ? '…' : 'Pause'}
              </button>
              <button
                type="button"
                disabled={clockBusy}
                onClick={() => void punch('complete')}
                className="flex-1 rounded-lg bg-emerald-700 px-3 py-3 text-sm font-semibold text-white disabled:opacity-40"
              >
                {clockBusy ? '…' : 'Complete'}
              </button>
            </div>
          ) : (
            <button
              type="button"
              disabled={clockBusy}
              onClick={() => void punch('arrive')}
              className="w-full rounded-lg bg-emerald-700 px-4 py-3 text-sm font-semibold text-white disabled:opacity-40"
            >
              {clockBusy ? '…' : 'Arrive'}
            </button>
          )}
          <p className="text-[10px] text-slate-500">
            Pause holds the job open for another day. Complete closes your time on it. Either way you stay
            on the clock for the day until you clock out on the main screen.
          </p>
        </section>
      )}
      {clockSaid && <p className="rounded bg-slate-800 p-2 text-xs text-emerald-200">{clockSaid}</p>}
      {clockError && <p className="rounded bg-red-950/60 p-2 text-xs text-red-200">{clockError}</p>}

      {/* ── The scope — what was bought, never hours ── */}
      {brief?.estimate && (
        <section className="space-y-1 rounded-xl border border-slate-700 bg-slate-800/60 p-4">
          <h2 className="text-sm font-semibold text-white">
            Scope — {brief.estimate.title} <span className="text-xs font-normal text-slate-400">({brief.estimate.number})</span>
          </h2>
          {brief.estimate.scopeText && <p className="text-xs text-slate-400">{brief.estimate.scopeText}</p>}
          <ul className="space-y-0.5 pt-1 text-sm text-slate-300">
            {brief.estimate.lines.map((line, i) => (
              <li key={i}>· {line.quantity}× {line.description}</li>
            ))}
          </ul>
        </section>
      )}
      {brief && !brief.estimate && (
        <p className="rounded-lg border border-slate-700 bg-slate-800/60 p-3 text-xs text-slate-400">
          {isJob ? 'No signed estimate linked to this job.' : 'Estimate visit — walk it, assess it, quote it.'}
        </p>
      )}
      {brief?.notes && <p className="rounded-lg bg-slate-800/60 p-3 text-xs text-slate-300">Office notes: {brief.notes}</p>}

      {/* ── The assessment, one module of the visit ── */}
      <button
        type="button"
        onClick={onRunAssessment}
        className="w-full rounded-lg bg-sky-600 p-3 text-sm font-medium text-white"
      >
        ⚡ Run electrical assessment
      </button>
      <div className="space-y-2 rounded-lg border border-slate-700 bg-slate-800/60 p-2">
        <button type="button" onClick={() => setSchedOpen((o) => !o)} className="w-full text-left text-xs text-sky-200">
          📅 {schedOpen ? 'Hide scheduling' : 'Schedule for a later date'}
        </button>
        {schedOpen && (
          <div className="space-y-2">
            <div className="flex gap-2">
              <input type="date" value={schedDate} onChange={(e) => setSchedDate(e.target.value)} className="flex-1 rounded border border-slate-600 bg-slate-900 p-2 text-xs text-white" />
              <input type="time" value={schedTime} onChange={(e) => setSchedTime(e.target.value)} className="w-28 rounded border border-slate-600 bg-slate-900 p-2 text-xs text-white" />
            </div>
            <p className="text-[10px] text-slate-500">Multi-day? Set the end below — hours per day come from the times.</p>
            <div className="flex gap-2">
              <input type="date" value={schedEndDate || schedDate} min={schedDate || undefined} onChange={(e) => setSchedEndDate(e.target.value)} className="flex-1 rounded border border-slate-600 bg-slate-900 p-2 text-xs text-white" />
              <input type="time" value={schedEndTime} onChange={(e) => setSchedEndTime(e.target.value)} className="w-28 rounded border border-slate-600 bg-slate-900 p-2 text-xs text-white" />
            </div>
            <button
              type="button"
              disabled={schedBusy || !schedDate}
              onClick={() => {
                setSchedBusy(true); setSchedMsg(null)
                scheduleVisitFromField(assignment.visitId, schedDate, schedTime || null, schedEndDate || schedDate, schedEndTime || null)
                  .then((r) => setSchedMsg(r.scheduledStart ? `Scheduled — ${new Date(r.scheduledStart).toLocaleString()}. It's on your list under that day.` : 'Scheduled.'))
                  .catch((err) => setSchedMsg(err instanceof Error ? err.message : String(err)))
                  .finally(() => setSchedBusy(false))
              }}
              className="w-full rounded-lg bg-sky-700 p-2 text-xs font-medium text-white disabled:opacity-50"
            >
              {schedBusy ? 'Scheduling…' : 'Book it'}
            </button>
            {schedMsg && <p className="rounded bg-slate-900 p-2 text-[11px] text-slate-200">{schedMsg}</p>}
          </div>
        )}
      </div>
      {onBuildQuote && (
        <button
          type="button"
          onClick={onBuildQuote}
          className="w-full rounded-lg border border-emerald-800 bg-emerald-950/40 p-2 text-xs text-emerald-200"
        >
          🧾 Build the quote
        </button>
      )}
      {onCapacityCheck && (
        <button
          type="button"
          onClick={onCapacityCheck}
          className="w-full rounded-lg border border-slate-700 p-2 text-xs text-slate-300"
        >
          Adding load here? Run the 220.83 capacity check
        </button>
      )}

      {/* ── Photos ── */}
      <section className="space-y-2 rounded-xl border border-slate-700 bg-slate-800/60 p-4">
        <h2 className="text-sm font-semibold text-white">Job photos</h2>
        <input
          className="w-full rounded border border-slate-600 bg-slate-900 p-2 text-sm text-white placeholder:text-slate-500"
          placeholder="Caption (before / after / what it shows)"
          value={photoCaption}
          onChange={(e) => setPhotoCaption(e.target.value)}
        />
        <PhotoPicker onPick={(f) => void sendPhoto(f)} disabled={photoBusy} />
        {photoBusy && <p className="text-xs text-slate-400">Uploading…</p>}
        {photoStatus && <p className="text-xs text-slate-300">{photoStatus}</p>}
      </section>

      {/* ── Receipts ── */}
      <section className="space-y-2 rounded-xl border border-slate-700 bg-slate-800/60 p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-white">Receipts</h2>
          <button type="button" className="text-xs text-sky-300 underline" onClick={() => setShowReceipt((s) => !s)}>
            {showReceipt ? 'hide' : 'add receipt'}
          </button>
        </div>
        {showReceipt && (
          <>
            <div className="flex gap-2">
              <input
                className="w-24 rounded border border-slate-600 bg-slate-900 p-2 text-sm text-white placeholder:text-slate-500"
                type="number"
                step="0.01"
                placeholder="$ amt"
                value={receiptAmount}
                onChange={(e) => setReceiptAmount(e.target.value)}
              />
              <input
                className="flex-1 rounded border border-slate-600 bg-slate-900 p-2 text-sm text-white placeholder:text-slate-500"
                placeholder="Vendor (blank = auto-read)"
                value={receiptVendor}
                onChange={(e) => setReceiptVendor(e.target.value)}
              />
            </div>
            <PhotoPicker onPick={(f) => void sendReceipt(f)} disabled={receiptBusy} />
            {receiptBusy && <p className="text-xs text-slate-400">Uploading…</p>}
          </>
        )}
        {receiptStatus && <p className="text-xs text-slate-300">{receiptStatus}</p>}
      </section>

      {/* ── Purchase orders — number first, then the buy, then the receipt photo (Kyle, 2026-09-09) ── */}
      <section className="space-y-2 rounded-xl border border-slate-700 bg-slate-800/60 p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-white">Purchase orders</h2>
          <button type="button" className="text-xs text-sky-300 underline" onClick={() => setShowPo((s) => !s)}>
            {showPo ? 'hide' : 'new P.O.'}
          </button>
        </div>
        {showPo && (
          <StartPurchaseForm
            visitId={assignment.visitId}
            onCreated={(po) => { setJustCreatedPo(po); reloadPos() }}
          />
        )}
        {justCreatedPo && <PoNumberBanner po={justCreatedPo} />}
        {showPo && poError && <p className="rounded-lg bg-red-950/60 p-2 text-xs text-red-200">{poError}</p>}
        {showPo && (
          <div className="space-y-1 pt-1">
            <p className="text-[11px] text-slate-500">This job's POs</p>
            <PurchaseOrderList orders={poOrders} onChanged={reloadPos} />
          </div>
        )}
      </section>

      {/* ── Payment ── */}
      <CollectPayment visitId={assignment.visitId} />

      {/* ── Close-out — every visit ends when the TECH says so (Kyle, 2026-09-05) ── */}
      {(
        <section className="space-y-2 rounded-xl border border-amber-800 bg-amber-950/20 p-4">
          <h2 className="text-sm font-semibold text-amber-200">{isJob ? 'Close the job out' : 'Close this visit out'}</h2>
          {alreadyDone ? (
            <p className="rounded bg-emerald-900/50 p-2 text-sm text-emerald-200">
              ✓ Closed. The office has been notified{isJob ? ' to schedule what comes next' : ''}.
            </p>
          ) : (
            <>
              {/* Materials used (Kyle, 2026-09-09, Build 4): what came off the truck,
                  pre-filled from the signed estimate. The job is charged only through
                  this; closing without it is allowed and comes back as a warning. */}
              {isJob && (
                <div className="space-y-1">
                  <button type="button" className="text-xs text-sky-300 underline" onClick={() => setShowMaterials((s) => !s)}>
                    {showMaterials ? 'hide materials used' : 'Materials used — what came off the truck'}
                  </button>
                  {showMaterials && <MaterialsUsedStep visitId={assignment.visitId} />}
                </div>
              )}
              <p className="text-xs text-slate-400">
                {isJob
                  ? 'Work done, photos in, receipts filed, materials recorded, money collected? Closing notifies the office to schedule the install or follow-up.'
                  : 'Assessment sent, quote built, receipts filed? The visit stays on your Today list until you close it — closing logs it to the office.'}
              </p>
              <button
                type="button"
                disabled={closing}
                onClick={() => void closeOut()}
                className="w-full rounded-lg bg-amber-600 p-3 text-sm font-medium text-white disabled:opacity-40"
              >
                {closing ? 'Closing…' : 'Mark job complete'}
              </button>
            </>
          )}
          {closed?.warnings.map((w) => (
            <p key={w} className="rounded bg-amber-900/50 p-2 text-xs text-amber-200">⚠ {w}</p>
          ))}
          {closeError && <p className="rounded bg-red-950/60 p-2 text-xs text-red-200">{closeError}</p>}
        </section>
      )}
    </div>
  )
}
