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
 *
 * AFTER THE SIGNATURE (Kyle, 2026-09-21) the screen offers exactly two
 * choices — "Complete work now" (this consultation becomes the job; nothing
 * booked, the customer sent nothing) and "Schedule for later" (the job goes to
 * the office). The field's own booking ("Schedule for a later date") is gone:
 * scheduling is admin-only. "Pause job" sends any job underway back to the
 * office to reschedule, keeping everything on it — a different thing from the
 * job CLOCK's "Pause clock", which only stops a time session.
 *
 * WITH NO SIGNAL (Phase 7 unit U8, 2026-10-10; Kyle's rulings 9 and 10). The brief is the
 * office's and cannot load; the "issued — not signed yet" panel then renders from this phone's
 * saved copy of the visit's quote (quoteSync.workingQuoteMirrorForVisit, saved at the Today
 * screen while there was signal), labelled "This phone's copy, saved 2:14 PM", so "Show the
 * customer / Sign now" still opens. A signature taken on this phone shows as a card here until
 * the office has answered — "Signature saved on this phone — NOT recorded yet" with "Cancel this
 * signature (not recorded yet)", or the red "Not recorded: …" card with "Sign again" and "I've
 * called the customer — dismiss" — and while one waits, Complete work now, Schedule for later and
 * Collect payment are greyed "Waiting for the signature to reach the office". "Signed" is never
 * shown before the office's 2xx.
 */

import { useCallback, useEffect, useState } from 'react'
import {
  arriveAtJob,
  completeJobClock,
  completeWorkNow,
  pauseJobClock,
  pauseJobForLater,
  completeVisitFromField,
  emailEstimateToCustomer,
  emailFinancing,
  fetchJobBrief,
  fetchPurchaseOrders,
  isNetworkFailure,
  pendingReceiptCount,
  raiseChangeOrder,
  scheduleForLater,
  uploadJobPhoto,
  type FieldPurchaseOrder,
  type JobBrief,
} from '../../lib/crmSync'
import { onQuoteSyncSettled, pendingQuoteOpCountForVisit, workingQuoteMirrorForVisit } from '../../lib/quoteSync'
import {
  cancelSignature,
  dismissRefusedSignature,
  onSignatureSyncSettled,
  removeUnfiledSignature,
  signatureSyncNeedsSignIn,
  signaturesForVisit,
  type SignatureQueueRecord,
} from '../../lib/signatureQueue'
import { heldSignatureReason, signGate } from '../../lib/signatureGate'
import type { QuoteMirrorRecord } from '../../db/database'
import { CollectPayment } from '../components/CollectPayment'
import { CUSTOMER_PAGE_LABEL, EmailEstimateButton, EmailFinancingButton } from './QuoteLifecycle'
import { JOB_BRIEF_OFFLINE, OFFLINE_EMAIL_REASON } from './QuoteOffline'
import { SignaturePendingCard, WAITING_FOR_SIGNATURE, savedCopyWords } from './SignatureCards'
import { MaterialsUsedStep } from '../components/MaterialsUsedStep'
import { JobCompletionReport } from '../components/JobCompletionReport'
import {
  PhotoPicker,
  PoNumberBanner,
  PurchaseOrderList,
  StartPurchaseForm,
  type CreatedPo,
} from '../components/PurchaseOrderPanel'
import type { CrmAssignment } from '../../domain/types'
import { changeOrderBlockReason } from '../../../../shared/changeOrderBlock'

const JOB_STATUSES = new Set(['contracted', 'scheduled', 'in_progress', 'completed'])
/** A job can be PAUSED (sent back to scheduling) from these — work underway or booked. */
const PAUSABLE_STATUSES = new Set(['in_progress', 'scheduled'])

/**
 * Whether the "Estimate N issued — not signed yet" panel renders: the brief carries an estimate
 * that has no signature, the signed-only choice is not pending, and the visit is not done.
 *
 * Exported so a test can pin it (2026-10-08). Until the job brief carried an UNSIGNED estimate
 * (health-record.ts job-brief, same day), `brief.estimate` was either null or signed, so this was
 * never true and the panel — built twice, 2026-09-23 and 2026-09-24 — had never rendered on a
 * phone (2026-09-24 closing-out plan, "Unit 2 outcome").
 */
export function awaitingSignatureFor(
  brief: Pick<JobBrief, 'estimate'> | null,
  choicePending: boolean,
  alreadyDone: boolean,
): boolean {
  return Boolean(brief?.estimate) && !brief?.estimate?.signedAt && !choicePending && !alreadyDone
}

/**
 * Why "Raise a change order" is greyed on this job, or null when it can be pressed (Phase 2 unit E,
 * 2026-10-08). The wording is the office's (shared/changeOrderBlock.ts). The brief's estimate is the
 * job's live signed root when there is one, else a live unsigned one; "signed" is what unlocks it.
 * Exported so a test can pin it.
 */
export function changeOrderReasonFor(brief: Pick<JobBrief, 'estimate'> | null): string | null {
  if (!brief) return 'Loading the job...'
  return changeOrderBlockReason({ hasEstimate: Boolean(brief.estimate), signed: Boolean(brief.estimate?.signedAt) })
}

export function JobSiteScreen({
  assignment,
  onRunAssessment,
  onRunDiagnostics,
  onCapacityCheck,
  onBuildQuote,
  onShowCustomer,
  onOpenChangeOrder,
  onBack,
}: {
  assignment: CrmAssignment
  onRunAssessment: () => void
  /**
   * Run diagnostics (Kyle, 2026-09-20) — a second report TYPE on this visit, not
   * a second app. The assessment walks the HOUSE; the diagnostic walks one
   * CIRCUIT, breaker to last outlet, at $25-$50 an outlet by access.
   */
  onRunDiagnostics?: () => void
  onCapacityCheck?: () => void
  /** Quote in the field (2026-09-01): same book and gates as the office. */
  onBuildQuote?: () => void
  /**
   * "Show the customer / Sign now" from the Job site (review finding, 2026-10-08): opens the Quote
   * screen straight onto the customer's view of the quote this visit already issued, so the customer
   * who says yes a few minutes later signs IN PERSON on this phone (recorded as in person, with the
   * technician named), not through the emailed-link page. Omitted where the app cannot open it.
   */
  onShowCustomer?: () => void
  /**
   * "Raise a change order" (Phase 2 unit E): the server makes - or reopens - the change-order draft
   * against this job's signed estimate and the Quote screen opens on it.
   */
  onOpenChangeOrder?: (draftId: string) => void
  onBack: () => void
}) {
  const [brief, setBrief] = useState<JobBrief | null>(null)
  const [briefError, setBriefError] = useState<string | null>(null)
  const [coBusy, setCoBusy] = useState(false)
  const [coError, setCoError] = useState<string | null>(null)

  // No signal: the brief got no answer (fetch threw), never an HTTP refusal. With it, the saved copy
  // of the visit's quote stands in for the brief's estimate (U8).
  const [offline, setOffline] = useState(false)
  const [savedQuote, setSavedQuote] = useState<QuoteMirrorRecord | null>(null)
  // The brief is the office's and loads live. With no signal it says so in words (design §2), not
  // the browser's raw "Failed to fetch" (Phase 7 U5, 2026-10-10); a refusal keeps the office's words.
  const briefFailure = (err: unknown) => (isNetworkFailure(err) ? JOB_BRIEF_OFFLINE : err instanceof Error ? err.message : String(err))
  const loadBrief = useCallback(async (): Promise<void> => {
    try {
      setBrief(await fetchJobBrief(assignment.visitId))
      setBriefError(null)
      setOffline(false)
    } catch (err) {
      setBriefError(briefFailure(err))
      if (isNetworkFailure(err)) {
        setOffline(true)
        setSavedQuote((await workingQuoteMirrorForVisit(assignment.visitId).catch(() => undefined)) ?? null)
      }
    }
  }, [assignment.visitId])
  const reloadBrief = loadBrief
  useEffect(() => {
    let cancelled = false
    fetchJobBrief(assignment.visitId)
      .then((b) => { if (!cancelled) { setBrief(b); setOffline(false) } })
      .catch(async (err) => {
        if (cancelled) return
        setBriefError(briefFailure(err))
        if (isNetworkFailure(err)) {
          setOffline(true)
          const mirror = await workingQuoteMirrorForVisit(assignment.visitId).catch(() => undefined)
          if (!cancelled) setSavedQuote(mirror ?? null)
        }
      })
    return () => { cancelled = true }
  }, [assignment.visitId])
  // The browser's own word on the signal: back → the office's brief; gone → say so at once.
  useEffect(() => {
    const up = () => { void loadBrief() }
    const down = () => setOffline(true)
    window.addEventListener('online', up)
    window.addEventListener('offline', down)
    return () => {
      window.removeEventListener('online', up)
      window.removeEventListener('offline', down)
    }
  }, [loadBrief])

  // Signatures taken on this phone for this visit (U8): the newest one is the card; a queued one
  // greys the after-signature choices and the deposit. Re-read as the signature queue settles.
  const [signatures, setSignatures] = useState<SignatureQueueRecord[]>([])
  useEffect(() => {
    const read = () => { void signaturesForVisit(assignment.visitId).then(setSignatures).catch(() => undefined) }
    read()
    return onSignatureSyncSettled(read)
  }, [assignment.visitId])

  // Quote edits made on this phone that have not reached the office yet (Phase 7 U5) — the badge on
  // "Build the quote". Re-read as the queue drains in the background.
  const [quoteChangesWaiting, setQuoteChangesWaiting] = useState(0)
  useEffect(() => {
    const read = () => { void pendingQuoteOpCountForVisit(assignment.visitId).then(setQuoteChangesWaiting).catch(() => undefined) }
    read()
    return onQuoteSyncSettled(read)
  }, [assignment.visitId])

  // ── THE JOB CLOCK (Kyle, 2026-09-11): Arrive → Complete, or Pause on a
  // multi-day job. Job hours are the sum of the arrive-to-leave sessions and
  // they sit INSIDE the shift — arriving while clocked out starts the shift
  // too, and the screen says so. ──
  const [clockedInAt, setClockedInAt] = useState<string | null>(null)
  const [clockSaid, setClockSaid] = useState<string | null>(null)
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
            ? `Clock paused — ${fmtHm(result.minutes)} this session. You are still on the clock for the day.`
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

  // ── After the signature: Complete work now / Schedule for later (2026-09-21) ──
  const [choiceBusy, setChoiceBusy] = useState(false)
  const [choiceSaid, setChoiceSaid] = useState<string | null>(null)
  const [choiceError, setChoiceError] = useState<string | null>(null)
  const [handedToOffice, setHandedToOffice] = useState(false)
  const choose = async (choice: 'now' | 'later') => {
    const ok = window.confirm(
      choice === 'now'
        ? 'Complete the work now? This visit becomes the job — no scheduling, and the customer is sent nothing. You can pause it later if the work does not finish.'
        : 'Schedule for later? This visit closes and the job goes to the office to schedule. Nothing is booked here.',
    )
    if (!ok) return
    setChoiceBusy(true)
    setChoiceError(null)
    setChoiceSaid(null)
    try {
      if (choice === 'now') {
        await completeWorkNow(assignment.visitId)
        setChoiceSaid('This visit is the job now. Clock your time, file P.O.s and materials here, and mark it complete when the work is done.')
        await reloadBrief()
      } else {
        await scheduleForLater(assignment.visitId)
        setChoiceSaid('Handed to the office to schedule. This visit leaves your Today list.')
        setHandedToOffice(true)
        await reloadBrief()
      }
    } catch (err) {
      setChoiceError(err instanceof Error ? err.message : String(err))
    } finally {
      setChoiceBusy(false)
    }
  }

  // ── Pause JOB — back to the office to reschedule (2026-09-21) ──
  const [pauseReason, setPauseReason] = useState('')
  const [pauseOpen, setPauseOpen] = useState(false)
  const [pauseBusy, setPauseBusy] = useState(false)
  const [pauseSaid, setPauseSaid] = useState<string | null>(null)
  const [pauseError, setPauseError] = useState<string | null>(null)
  const pauseJob = async () => {
    if (!window.confirm('Pause this job and send it back to the office to reschedule? Its estimate, payments, P.O.s, time and materials stay on it. The customer is sent nothing.')) return
    setPauseBusy(true)
    setPauseError(null)
    setPauseSaid(null)
    try {
      const result = await pauseJobForLater(assignment.visitId, pauseReason.trim() || null)
      setClockedInAt(null)
      setPauseSaid(`Paused — the office will reschedule it. ${fmtHm(Math.round(result.laborHours * 60))} on the job so far stays on it.`)
      setPauseOpen(false)
      setPauseReason('')
      await reloadBrief()
    } catch (err) {
      setPauseError(err instanceof Error ? err.message : String(err))
    } finally {
      setPauseBusy(false)
    }
  }

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

  // ── Receipts (2026-09-17: "it is create p.o. -> upload receipt" — the
  // standalone Receipts section is gone; every receipt now files against a
  // P.O. from the Purchase orders section below. The durable upload queue
  // still drains in the background regardless — including receipts queued
  // before this change with no P.O. — so the pending count stays visible,
  // now next to Purchase orders.) ──
  const [pendingReceipts, setPendingReceipts] = useState(0)
  const refreshPendingReceipts = () => { void pendingReceiptCount().then(setPendingReceipts) }
  useEffect(() => { refreshPendingReceipts() }, [])

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

  const status = brief?.status ?? assignment.visitStatus ?? ''
  const isJob = JOB_STATUSES.has(status)
  const alreadyDone = brief?.status === 'completed' || Boolean(brief?.completedAt) || Boolean(closed) || handedToOffice
  const choicePending = Boolean(brief?.choicePending) && !alreadyDone
  // Before the signature (2026-09-23): an estimate is issued but the customer has not signed yet
  // (choicePending only ever turns true once signedAt is set), so today NOTHING renders here,
  // which reads as "this cannot be done." Show both choices, disabled, with why.
  // With no signal and no brief, the saved copy of the visit's quote says whether an estimate is
  // out for signing (U8): issued, live, unsigned. Its figures are the frozen table the office holds.
  const savedIssued = !brief && offline ? (savedQuote?.payload.lifecycle.issued ?? null) : null
  const savedAwaiting = Boolean(savedIssued && !savedIssued.signedAt && savedIssued.status !== 'lost' && !alreadyDone)
  const awaitingSignature = awaitingSignatureFor(brief, choicePending, alreadyDone) || savedAwaiting
  // The estimate the "not signed yet" panel names: the brief's, else the saved copy's.
  const panelEstimate = brief?.estimate
    ? { id: brief.estimate.id, number: brief.estimate.number, customerUrl: brief.estimate.customerUrl }
    : savedIssued
      ? { id: savedIssued.estimateId, number: savedIssued.number, customerUrl: savedIssued.customerUrl ?? undefined }
      : null
  // The signature this phone holds for the visit (U8): the newest is the card; queued or refused
  // means the customer's screen stays shut and the after-signature choices wait.
  const cardSignature = signatures[0] ?? null
  const heldSignature = signatures.find((s) => s.state === 'queued' || s.state === 'refused') ?? null
  const signatureWaiting = signatures.some((s) => s.state === 'queued')
  // Why "Show the customer / Sign now" is greyed, or null: a signature already held, or — with no
  // signal, from the saved copy — the one signing rule (expired by this clock, edits waiting, edited
  // after issue). With signal the Quote screen applies the rule itself.
  const showSignReason = heldSignature && panelEstimate
    ? heldSignatureReason(panelEstimate.number, heldSignature)
    : savedIssued && savedQuote
      ? signGate({
          issued: savedIssued,
          hasUnsavedChanges: savedQuote.payload.lifecycle.hasUnsavedChanges,
          waiting: quoteChangesWaiting,
          localOnlyQuote: savedQuote.origin === 'phone',
          offline: true,
          signature: null,
        }).reason
      : null
  const canPauseJob = Boolean(brief) && PAUSABLE_STATUSES.has(status) && !alreadyDone
  const waitingOnOffice = isJob && status === 'contracted' && !brief?.scheduledStart

  return (
    <div className="mx-auto max-w-xl space-y-4 p-6 pb-16">
      <button type="button" onClick={onBack} className="text-sm text-sky-300">
        ← Today
      </button>

      <header className="space-y-1">
        <span className={`inline-block rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
          isJob ? 'bg-amber-600 text-amber-50' : 'bg-sky-700 text-sky-100'
        }`}>
          {isJob ? (waitingOnOffice ? 'Job — waiting on the office to schedule' : 'Job') : 'Estimate visit'}
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

      {/* ── The JOB clock: Arrive → Complete, Pause clock on a multi-day job ── */}
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
                {clockBusy ? '…' : 'Pause clock'}
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
            Pause clock stops your time on this job and holds it open for another day. Complete closes your time on it.
            Either way you stay on the clock for the day until you clock out on the main screen.
          </p>
        </section>
      )}
      {clockSaid && <p className="rounded bg-slate-800 p-2 text-xs text-emerald-200">{clockSaid}</p>}
      {clockError && <p className="rounded bg-red-950/60 p-2 text-xs text-red-200">{clockError}</p>}

      {/* ── The scope — what was bought, never hours ── */}
      {brief?.estimate && (
        <section className="space-y-1 rounded-xl border border-slate-700 bg-slate-800/60 p-4">
          {/* An issued-but-unsigned estimate rides the brief too now (2026-10-08) — it is quoted
              work, not agreed work, and the heading says which. */}
          <h2 className="text-sm font-semibold text-white">
            {brief.estimate.signedAt ? 'Scope' : 'Quoted — not signed yet'} — {brief.estimate.title} <span className="text-xs font-normal text-slate-400">({brief.estimate.number})</span>
          </h2>
          {brief.estimate.scopeText && <p className="text-xs text-slate-400">{brief.estimate.scopeText}</p>}
          <ul className="space-y-0.5 pt-1 text-sm text-slate-300">
            {brief.estimate.lines.map((line, i) => (
              <li key={i}>· {line.quantity}× {line.description}</li>
            ))}
          </ul>
          {/* Change orders that joined this job (2026-09-20) — added scope, same visit. A tech
              who only sees the original estimate works from a stale brief. */}
          {(brief.estimate.changeOrders ?? []).map((co) => (
            <div key={co.number} className="mt-2 border-t border-slate-700 pt-2">
              <h3 className="text-sm font-semibold text-amber-200">
                Change order — {co.title} <span className="text-xs font-normal text-slate-400">({co.number})</span>
              </h3>
              {co.scopeText && <p className="text-xs text-slate-400">{co.scopeText}</p>}
              <ul className="space-y-0.5 pt-1 text-sm text-slate-300">
                {co.lines.map((line, i) => (
                  <li key={i}>· {line.quantity}× {line.description}</li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}
      {brief && !brief.estimate && (
        <p className="rounded-lg border border-slate-700 bg-slate-800/60 p-3 text-xs text-slate-400">
          {isJob ? 'No signed estimate linked to this job.' : 'Estimate visit — walk it, assess it, quote it.'}
        </p>
      )}
      {brief?.notes && <p className="rounded-lg bg-slate-800/60 p-3 text-xs text-slate-300">Office notes: {brief.notes}</p>}

      {/* ── A signature taken on this phone, until the office has answered (U8). ── */}
      {cardSignature && (
        <SignaturePendingCard
          row={cardSignature}
          offline={offline}
          busy={false}
          authNeeded={signatureSyncNeedsSignIn()}
          onCancel={async (id, reason) => {
            await cancelSignature(id, reason)
            setSignatures(await signaturesForVisit(assignment.visitId))
          }}
          onDismiss={async (id, reason) => {
            await dismissRefusedSignature(id, reason)
            setSignatures(await signaturesForVisit(assignment.visitId))
          }}
          onRemove={async (id) => {
            await removeUnfiledSignature(id)
            setSignatures(await signaturesForVisit(assignment.visitId))
          }}
          onSignAgain={onShowCustomer
            ? async () => {
                await dismissRefusedSignature(cardSignature.signatureId, 'Signing again on this phone')
                setSignatures(await signaturesForVisit(assignment.visitId))
                onShowCustomer()
              }
            : undefined}
        />
      )}

      {/* ── Signed. What happens now? Exactly two choices (Kyle, 2026-09-21). ── */}
      {choicePending && (
        <section className="space-y-2 rounded-xl border border-emerald-700 bg-emerald-950/30 p-4">
          <h2 className="text-sm font-semibold text-emerald-100">
            Signed — {brief?.estimate?.number}. What happens now?
          </h2>
          <button
            type="button"
            disabled={choiceBusy}
            onClick={() => void choose('now')}
            className="w-full rounded-lg bg-emerald-700 p-3 text-left text-sm font-semibold text-white disabled:opacity-40"
          >
            {choiceBusy ? '…' : 'Complete work now'}
            <span className="block text-[11px] font-normal text-emerald-100/80">
              This visit becomes the job. Same calendar block, nothing to schedule, the customer is sent nothing.
            </span>
          </button>
          <button
            type="button"
            disabled={choiceBusy}
            onClick={() => void choose('later')}
            className="w-full rounded-lg border border-slate-500 bg-slate-800 p-3 text-left text-sm font-semibold text-white disabled:opacity-40"
          >
            {choiceBusy ? '…' : 'Schedule for later'}
            <span className="block text-[11px] font-normal text-slate-300">
              Bigger than today. The job goes to the office to schedule; this visit closes.
            </span>
          </button>
        </section>
      )}
      {/* ── Issued, not signed yet. Both choices shown, disabled, with why (Kyle, 2026-09-23). ── */}
      {awaitingSignature && (
        <section className="space-y-2 rounded-xl border border-slate-600 bg-slate-800/40 p-4">
          <h2 className="text-sm font-semibold text-slate-200">
            Estimate {panelEstimate?.number} issued — not signed yet
          </h2>
          {/* With no signal the panel is read from this phone's saved copy of the quote (U8). */}
          {savedIssued && savedQuote && (
            <p className="text-[11px] text-sky-300">{savedCopyWords(savedQuote.snapshotAt)} — the estimate exactly as the office issued it.</p>
          )}
          {/*
            The door back to signing (2026-09-24): issuing shows this same link and share button
            for about thirty seconds (QuoteScreen.tsx), then "Back to the job" loses it for good.
            The ordinary case — customer says yes a few minutes later, while the tech is still on
            site — had no way back to the signing page. Same link and same email button as the
            QuoteScreen panel (IssuedEstimatePanel).
          */}
          {/*
            SIGNING AT THE HOUSE (review finding, 2026-10-08): "Show the customer" then "Sign now"
            records the signature IN PERSON with the technician named. The page link below is the
            customer's own-device door - a signature there is recorded as "from the emailed link" -
            so it is labelled that way and sits second.
          */}
          {onShowCustomer && (
            <>
              <button
                type="button"
                disabled={showSignReason !== null}
                onClick={onShowCustomer}
                title={showSignReason ?? 'Turn the phone around: the customer sees each option, ticks what they want, then signs on this phone'}
                className="w-full rounded-lg bg-sky-700 p-3 text-sm font-semibold text-white disabled:opacity-40"
              >
                Show the customer / Sign now
              </button>
              {/* Greyed WITH the reason, on the page as well as in the tooltip (U8). */}
              {showSignReason && <p className="text-[11px] text-amber-200">{showSignReason}</p>}
            </>
          )}
          {panelEstimate?.customerUrl && (
            <a
              href={panelEstimate.customerUrl}
              target="_blank"
              rel="noreferrer"
              className="block w-full rounded-lg border border-sky-700 p-3 text-center text-sm font-medium text-sky-200"
            >
              {CUSTOMER_PAGE_LABEL}
            </a>
          )}
          {/*
            EMAIL, not the OS share sheet (Kyle, 2026-10-01: "the text option for signiture needs
            chaged to email since we do not have text yet"; Red Cedar has no SMS). This panel
            still carried the old navigator.share button from 2026-09-24 and had never rendered on
            a phone, so nobody noticed; since the job brief began carrying an unsigned live
            estimate (2026-10-08) it renders, and it must say what the Quote screen's issued panel
            says. Same server send (sendEstimateEmail), same words. Photos ride from the Quote
            screen's ticks only - there are none to tick here, so none go.
          */}
          {panelEstimate?.id && (
            <EmailEstimateButton
              estimateId={panelEstimate.id}
              send={emailEstimateToCustomer}
              blockedReason={offline ? OFFLINE_EMAIL_REASON : null}
            />
          )}
          {/* And the financing link on its own, before the customer signs (Kyle, 2026-10-08). */}
          {panelEstimate?.id && (
            <EmailFinancingButton
              estimateId={panelEstimate.id}
              send={emailFinancing}
              blockedReason={offline ? OFFLINE_EMAIL_REASON : null}
            />
          )}
          <button
            type="button"
            disabled
            title={signatureWaiting ? WAITING_FOR_SIGNATURE : undefined}
            className="w-full cursor-not-allowed rounded-lg border border-slate-600 bg-slate-800 p-3 text-left text-sm font-semibold text-slate-500 opacity-60"
          >
            Complete work now
          </button>
          <button
            type="button"
            disabled
            title={signatureWaiting ? WAITING_FOR_SIGNATURE : undefined}
            className="w-full cursor-not-allowed rounded-lg border border-slate-600 bg-slate-800 p-3 text-left text-sm font-semibold text-slate-500 opacity-60"
          >
            Schedule for later
          </button>
          {signatureWaiting ? (
            /* A signature is on this phone and not at the office yet (U8): the two choices wait for it, and say so. */
            <p className="text-[11px] text-amber-200">{WAITING_FOR_SIGNATURE}. Both choices open the moment this card says Signed.</p>
          ) : (
            <p className="text-[11px] text-slate-400">
              The customer signs first — then you can do the work now in this block. To change the
              quote, open <span className="font-semibold text-slate-200">Build the quote</span> below — it
              reopens this estimate and saves your changes to it.
            </p>
          )}
        </section>
      )}
      {choiceSaid && <p className="rounded bg-emerald-900/50 p-2 text-xs text-emerald-200">{choiceSaid}</p>}
      {choiceError && <p className="rounded bg-red-950/60 p-2 text-xs text-red-200">{choiceError}</p>}

      {/* ── The assessment, one module of the visit ── */}
      <button
        type="button"
        onClick={onRunAssessment}
        className="w-full rounded-lg bg-sky-600 p-3 text-sm font-medium text-white"
      >
        ⚡ Run electrical assessment
      </button>
      {onRunDiagnostics && (
        <button
          type="button"
          onClick={onRunDiagnostics}
          className="w-full rounded-lg bg-indigo-600 p-3 text-sm font-medium text-white"
        >
          🔌 Run diagnostics — one circuit, breaker to last outlet
        </button>
      )}
      {/* Works with no signal (Phase 7 U5): the quote opens from this phone's saved copy, and edits queue. */}
      {onBuildQuote && (
        <button
          type="button"
          onClick={onBuildQuote}
          className="w-full rounded-lg border border-emerald-800 bg-emerald-950/40 p-2 text-xs text-emerald-200"
        >
          🧾 Build the quote
          {quoteChangesWaiting > 0 && (
            <span className="ml-2 rounded bg-amber-700 px-2 py-0.5 text-[10px] font-semibold text-amber-50">
              {quoteChangesWaiting} quote change{quoteChangesWaiting === 1 ? '' : 's'} waiting
            </span>
          )}
        </button>
      )}
      {/* The job grew after the customer signed: a change order is its own document against the signed estimate.
          Greyed WITH the reason while nothing is signed - never hidden (CLAUDE.md click-through rule 5). */}
      {onOpenChangeOrder && (() => {
        const block = changeOrderReasonFor(brief)
        return (
          <div className="space-y-1">
            <button
              type="button"
              disabled={block !== null || coBusy}
              title={block ?? 'Adds agreed work to this job — its own document the customer signs; one balance, one payment'}
              onClick={() => {
                setCoBusy(true)
                setCoError(null)
                raiseChangeOrder(assignment.visitId)
                  .then((r) => onOpenChangeOrder(r.draftId))
                  .catch((err) => setCoError(err instanceof Error ? err.message : String(err)))
                  .finally(() => setCoBusy(false))
              }}
              className="w-full rounded-lg border border-sky-800 bg-sky-950/40 p-3 text-sm font-medium text-sky-100 disabled:opacity-40"
            >
              {coBusy ? 'Opening the change order…' : 'Raise a change order'}
            </button>
            {block ? (
              <p className="text-[11px] text-slate-400">{block}</p>
            ) : (
              <p className="text-[11px] text-slate-400">
                The job grew after the customer signed? Add the new work (or take work off) as a change order. If one is already open
                for this job, this reopens it.
              </p>
            )}
            {coError && <p className="rounded bg-red-950/60 p-2 text-xs text-red-200">{coError}</p>}
          </div>
        )
      })()}
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

      {/* ── Purchase orders — number first, then the buy, then the receipt photo
          (Kyle, 2026-09-09; and 2026-09-17: "it is create p.o. -> upload
          receipt" — the standalone Receipts section is gone, so this is the
          only place a receipt gets filed) ── */}
      <section className="space-y-2 rounded-xl border border-slate-700 bg-slate-800/60 p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-white">Purchase orders</h2>
          <button type="button" className="text-xs text-sky-300 underline" onClick={() => setShowPo((s) => !s)}>
            {showPo ? 'hide' : 'new P.O.'}
          </button>
        </div>
        {/* A silent failure today is indistinguishable from a purchase never
            photographed (2026-09-11 incident) — this count is the difference.
            The durable queue keeps draining regardless, including receipts
            queued before P.O.s were required, so this stays visible even
            with no P.O.s shown below. */}
        {pendingReceipts > 0 && (
          <p className="rounded bg-amber-950/60 p-2 text-xs text-amber-200">
            {pendingReceipts} receipt{pendingReceipts === 1 ? '' : 's'} queued, waiting for signal to file.
          </p>
        )}
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

      {/* ── Payment — greyed while a signature taken here has not reached the office (U8) ── */}
      <CollectPayment visitId={assignment.visitId} blockedReason={signatureWaiting ? WAITING_FOR_SIGNATURE : null} />

      {/* ── Pause JOB — back to the office to reschedule (Kyle, 2026-09-21).
          The exit for a mistaken Complete work now and for work that will not
          finish today. Not the clock's pause above. ── */}
      {canPauseJob && (
        <section className="space-y-2 rounded-xl border border-slate-600 bg-slate-800/60 p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-100">Not finishing this job today?</h2>
            <button type="button" className="text-xs text-sky-300 underline" onClick={() => setPauseOpen((o) => !o)}>
              {pauseOpen ? 'hide' : 'Pause job'}
            </button>
          </div>
          {pauseOpen && (
            <div className="space-y-2">
              <p className="text-xs text-slate-400">
                Pause job sends it back to the office to reschedule. Its estimate, payments, P.O.s, time and materials
                stay on it; your clock on it stops. The customer is sent nothing. Also the way out if Complete work now
                was a mistake.
              </p>
              <input
                className="w-full rounded border border-slate-600 bg-slate-900 p-2 text-sm text-white placeholder:text-slate-500"
                placeholder="Why? (optional — ran out of daylight, parts, mistake…)"
                value={pauseReason}
                onChange={(e) => setPauseReason(e.target.value)}
                maxLength={300}
              />
              <button
                type="button"
                disabled={pauseBusy}
                onClick={() => void pauseJob()}
                className="w-full rounded-lg bg-slate-600 p-3 text-sm font-semibold text-white disabled:opacity-40"
              >
                {pauseBusy ? 'Pausing…' : 'Pause job — back to the office to reschedule'}
              </button>
            </div>
          )}
          {pauseSaid && <p className="rounded bg-slate-900 p-2 text-xs text-emerald-200">{pauseSaid}</p>}
          {pauseError && <p className="rounded bg-red-950/60 p-2 text-xs text-red-200">{pauseError}</p>}
        </section>
      )}

      {/* ── Job completion report (Kyle, 2026-10-29) — per invoice line: what was done and why, NEC
          articles, readings, photos. A job only (a consultation has no invoice), and ABOVE "Mark
          job complete" so it is written up before the job is closed. The same record the office
          edits in the CRM. ── */}
      {isJob && <JobCompletionReport visitId={assignment.visitId} />}

      {/* ── Close-out — every visit ends when the TECH says so (Kyle, 2026-09-05) ── */}
      {(
        <section className="space-y-2 rounded-xl border border-amber-800 bg-amber-950/20 p-4">
          <h2 className="text-sm font-semibold text-amber-200">{isJob ? 'Close the job out' : 'Close this visit out'}</h2>
          {alreadyDone ? (
            <p className="rounded bg-emerald-900/50 p-2 text-sm text-emerald-200">
              ✓ Closed. The office has been notified{isJob ? ' to schedule what comes next' : handedToOffice ? ' to schedule the job' : ''}.
            </p>
          ) : choicePending ? (
            <p className="text-xs text-slate-400">
              The estimate is signed — choose Complete work now or Schedule for later above. That is what closes this visit.
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
                {closing ? 'Closing…' : isJob ? 'Mark job complete' : 'Close this visit'}
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
