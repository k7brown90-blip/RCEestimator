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

import { useEffect, useRef, useState } from 'react'
import {
  completeVisitFromField,
  fetchJobBrief,
  uploadJobPhoto,
  uploadReceiptFromField,
  type JobBrief,
} from '../../lib/crmSync'
import { CollectPayment } from '../components/CollectPayment'
import type { CrmAssignment } from '../../domain/types'

const JOB_STATUSES = new Set(['contracted', 'scheduled', 'in_progress', 'completed'])

/**
 * Camera AND gallery (Kyle, 2026-08-25: "needs access to the phones photo
 * gallery for upload along with the take photo option"). Two inputs on
 * purpose: `capture` forces the camera and locks the gallery out, so each
 * door gets its own input instead of one ambiguous chooser.
 */
function PhotoPicker({ onPick, disabled }: { onPick: (file: File) => void; disabled?: boolean }) {
  const cameraRef = useRef<HTMLInputElement>(null)
  const galleryRef = useRef<HTMLInputElement>(null)
  const handle = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) onPick(file)
    e.target.value = ''
  }
  return (
    <div className="flex gap-2">
      <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={handle} />
      <input ref={galleryRef} type="file" accept="image/*" className="hidden" onChange={handle} />
      <button
        type="button"
        disabled={disabled}
        onClick={() => cameraRef.current?.click()}
        className="flex-1 rounded-lg border border-slate-600 p-2 text-xs text-slate-200 disabled:opacity-40"
      >
        📷 Take photo
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={() => galleryRef.current?.click()}
        className="flex-1 rounded-lg border border-slate-600 p-2 text-xs text-slate-200 disabled:opacity-40"
      >
        🖼 From gallery
      </button>
    </div>
  )
}

export function JobSiteScreen({
  assignment,
  onRunAssessment,
  onCapacityCheck,
  onBack,
}: {
  assignment: CrmAssignment
  onRunAssessment: () => void
  onCapacityCheck?: () => void
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

  // ── Close-out ──
  const [closing, setClosing] = useState(false)
  const [closed, setClosed] = useState<{ warnings: string[] } | null>(null)
  const [closeError, setCloseError] = useState<string | null>(null)
  const closeOut = async () => {
    if (!window.confirm('Close this job out? The office gets notified to schedule what comes next.')) return
    setClosing(true)
    setCloseError(null)
    try {
      const result = await completeVisitFromField(assignment.visitId)
      setClosed({ warnings: result.warnings })
    } catch (err) {
      setCloseError(err instanceof Error ? err.message : String(err))
    } finally {
      setClosing(false)
    }
  }

  const isJob = JOB_STATUSES.has(brief?.status ?? assignment.visitStatus ?? '')
  const alreadyDone = brief?.status === 'completed' || Boolean(closed)

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

      {/* ── Payment ── */}
      <CollectPayment visitId={assignment.visitId} />

      {/* ── Close-out — jobs only ── */}
      {isJob && (
        <section className="space-y-2 rounded-xl border border-amber-800 bg-amber-950/20 p-4">
          <h2 className="text-sm font-semibold text-amber-200">Close the job out</h2>
          {alreadyDone ? (
            <p className="rounded bg-emerald-900/50 p-2 text-sm text-emerald-200">
              ✓ Closed. The office has been notified to schedule what comes next.
            </p>
          ) : (
            <>
              <p className="text-xs text-slate-400">
                Work done, photos in, receipts filed, money collected? Closing notifies the office
                to schedule the install or follow-up.
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
