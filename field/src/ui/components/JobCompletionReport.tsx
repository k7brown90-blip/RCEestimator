/**
 * "Job completion report" on the Job site screen - the technician's door onto the SAME record the
 * office edits in the CRM (Kyle, 2026-10-29: "Each separate line item can get photos and an
 * explination of what was done and why"; asked who fills it in: "Both").
 *
 * For each invoice line the customer signed for: what was done and why, the NEC articles (starting
 * from the price book's), readings (label / value / unit) and photos. The tech is standing at the
 * panel, so a photo is taken here ("Add photo" - the camera or the gallery, through the existing
 * job-photo upload) or picked from photos already filed on this job.
 *
 * Standing rules: every write-up has its way out ("Clear", confirmed) on the line itself; a button
 * that cannot be pressed says why on the screen; with no signal the screen says so rather than
 * dropping anything (nothing is queued - the tech saves again with bars).
 */

import { useCallback, useEffect, useState } from 'react'
import {
  clearCompletionLine,
  fetchCompletionLines,
  fetchVisitPhotos,
  fetchVisitPhotoThumb,
  saveCompletionLine,
  type VisitPhotoSummary,
} from '../../lib/crmSync'
import {
  CLEAR_NEEDS_ENTRY,
  NOT_WRITTEN_UP,
  PHOTO_LIMIT_REASON,
  addPhotoToDraft,
  bodyFromDraft,
  canAddNecRef,
  canAddReading,
  completionFailureWords,
  draftFromLine,
  lineSource,
  lineTitle,
  photoRoom,
  saveBlockReason,
  writtenUpWords,
  type CompletionDraft,
} from '../../lib/completionReport'
import {
  MAX_EXPLANATION_LENGTH,
  MAX_NEC_REF_LENGTH,
  MAX_NEC_REFS,
  MAX_READING_LABEL_LENGTH,
  MAX_READING_UNIT_LENGTH,
  MAX_READING_VALUE_LENGTH,
  MAX_READINGS,
} from '../../../../shared/jobCompletionLimits'
import type { CompletionLineView } from '../../../../shared/jobCompletion'
import { PhotoPicker } from './PurchaseOrderPanel'

const input = 'w-full rounded border border-slate-600 bg-slate-900 p-3 text-sm text-white placeholder:text-slate-500'
const smallBtn = 'rounded-lg border border-slate-600 px-3 py-3 text-xs text-slate-200 disabled:opacity-40'

// ── One row in the list ──────────────────────────────────────────────────────────────────────────
export function CompletionLineRow({ line, open, onToggle }: { line: CompletionLineView; open: boolean; onToggle: () => void }) {
  const source = lineSource(line)
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className={`flex w-full items-start justify-between gap-2 rounded-lg border p-3 text-left ${
        line.entry ? 'border-emerald-800 bg-emerald-950/30' : 'border-slate-600 bg-slate-900/60'
      }`}
    >
      <span className="min-w-0">
        <span className="block text-sm font-medium text-white">{lineTitle(line)}</span>
        {source && <span className="block text-[11px] text-amber-200">{source}</span>}
        <span className={`block text-xs ${line.entry ? 'text-emerald-200' : 'text-slate-400'}`}>
          {line.entry ? summaryOf(line) : NOT_WRITTEN_UP}
        </span>
      </span>
      <span className="shrink-0 text-xs text-sky-300">{open ? 'Close' : line.entry ? 'Edit' : 'Write up'}</span>
    </button>
  )
}

function summaryOf(line: CompletionLineView): string {
  const e = line.entry
  if (!e) return NOT_WRITTEN_UP
  const bits = ['Written up']
  if (e.readings.length > 0) bits.push(`${e.readings.length} reading${e.readings.length === 1 ? '' : 's'}`)
  if (e.photoIds.length > 0) bits.push(`${e.photoIds.length} photo${e.photoIds.length === 1 ? '' : 's'}`)
  return bits.join(' · ')
}

// ── The open line ────────────────────────────────────────────────────────────────────────────────
function photoLabel(id: string, photos: VisitPhotoSummary[]): string {
  const p = photos.find((t) => t.id === id)
  if (!p) return 'Photo on this job'
  const time = new Date(p.uploadedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return p.caption ? `${p.caption} · ${time}` : `Photo · ${time}`
}

/**
 * A small picture of one of THIS visit's photos. The bearer token can't ride an <img> src, so the
 * thumbnail is fetched with the header and shown through a blob URL (released when it unmounts).
 * If it can't load (no signal), the box says so quietly - the photo is still on the line.
 */
export function PhotoThumb({ visitId, photoId }: { visitId: string; photoId: string }) {
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let cancelled = false
    let made: string | null = null
    setUrl(null)
    setFailed(false)
    fetchVisitPhotoThumb(visitId, photoId)
      .then((blob) => {
        if (cancelled) return
        made = URL.createObjectURL(blob)
        setUrl(made)
      })
      .catch(() => { if (!cancelled) setFailed(true) })
    return () => {
      cancelled = true
      if (made) URL.revokeObjectURL(made)
    }
  }, [visitId, photoId])
  return url ? (
    <img src={url} alt="" className="h-14 w-14 shrink-0 rounded object-cover" />
  ) : (
    <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded bg-slate-800 text-[9px] text-slate-500">
      {failed ? 'no preview' : '…'}
    </span>
  )
}

export function CompletionLineEditor({
  line,
  draft,
  onDraft,
  visitId,
  photos,
  photosNote,
  busy,
  photoBusy,
  error,
  note,
  onSave,
  onClear,
  onPhoto,
}: {
  line: CompletionLineView
  draft: CompletionDraft
  onDraft: (d: CompletionDraft) => void
  visitId: string
  /** Every photo on this visit, newest first (the server's list). */
  photos: VisitPhotoSummary[]
  /** Why the list could not load (no signal), or null. */
  photosNote: string | null
  busy: boolean
  photoBusy: boolean
  error: string | null
  note: string | null
  onSave: () => void
  onClear: () => void
  onPhoto: (file: File) => void
}) {
  const blocked = saveBlockReason(draft)
  const room = photoRoom(draft)
  const pickable = photos.filter((t) => !draft.photoIds.includes(t.id))
  return (
    <div className="space-y-3 rounded-lg border border-slate-600 bg-slate-950/40 p-3">
      <label className="block space-y-1">
        <span className="text-xs font-semibold text-slate-200">What was done and why</span>
        <textarea
          className={`${input} min-h-28`}
          rows={5}
          maxLength={MAX_EXPLANATION_LENGTH}
          placeholder="Replaced the outlet because… tested… left it…"
          value={draft.explanation}
          onChange={(e) => onDraft({ ...draft, explanation: e.target.value })}
        />
      </label>

      <div className="space-y-2">
        <p className="text-xs font-semibold text-slate-200">NEC articles</p>
        {draft.necRefs.length === 0 && <p className="text-[11px] text-slate-400">No article cited on this line.</p>}
        {draft.necRefs.map((ref, i) => (
          <div key={i} className="flex gap-2">
            <input
              className={input}
              aria-label={`NEC article ${i + 1}`}
              placeholder="e.g. 210.8(A)"
              maxLength={MAX_NEC_REF_LENGTH}
              value={ref}
              onChange={(e) => onDraft({ ...draft, necRefs: draft.necRefs.map((r, j) => (j === i ? e.target.value : r)) })}
            />
            <button
              type="button"
              aria-label={`Remove NEC article ${ref || i + 1}`}
              className={smallBtn}
              onClick={() => onDraft({ ...draft, necRefs: draft.necRefs.filter((_, j) => j !== i) })}
            >
              ×
            </button>
          </div>
        ))}
        <button
          type="button"
          disabled={!canAddNecRef(draft)}
          className={smallBtn}
          onClick={() => onDraft({ ...draft, necRefs: [...draft.necRefs, ''] })}
        >
          + Add article
        </button>
        {!canAddNecRef(draft) && <p className="text-[11px] text-amber-200">At most {MAX_NEC_REFS} articles on one line.</p>}
      </div>

      <div className="space-y-2">
        <p className="text-xs font-semibold text-slate-200">Readings</p>
        {draft.readings.length === 0 && <p className="text-[11px] text-slate-400">No readings on this line.</p>}
        {draft.readings.map((r, i) => (
          <div key={i} className="space-y-1 rounded border border-slate-700 p-2">
            <input
              className={input}
              aria-label={`Reading ${i + 1} label`}
              placeholder="Label (Voltage L1-L2)"
              maxLength={MAX_READING_LABEL_LENGTH}
              value={r.label}
              onChange={(e) => onDraft({ ...draft, readings: draft.readings.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })}
            />
            <div className="flex gap-2">
              <input
                className={input}
                aria-label={`Reading ${i + 1} value`}
                placeholder="Value (240)"
                inputMode="decimal"
                maxLength={MAX_READING_VALUE_LENGTH}
                value={r.value}
                onChange={(e) => onDraft({ ...draft, readings: draft.readings.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })}
              />
              <input
                className={input}
                aria-label={`Reading ${i + 1} unit`}
                placeholder="Unit (V)"
                maxLength={MAX_READING_UNIT_LENGTH}
                value={r.unit}
                onChange={(e) => onDraft({ ...draft, readings: draft.readings.map((x, j) => (j === i ? { ...x, unit: e.target.value } : x)) })}
              />
              <button
                type="button"
                aria-label={`Remove reading ${r.label || i + 1}`}
                className={smallBtn}
                onClick={() => onDraft({ ...draft, readings: draft.readings.filter((_, j) => j !== i) })}
              >
                ×
              </button>
            </div>
          </div>
        ))}
        <button
          type="button"
          disabled={!canAddReading(draft)}
          className={smallBtn}
          onClick={() => onDraft({ ...draft, readings: [...draft.readings, { label: '', value: '', unit: '' }] })}
        >
          + Add reading
        </button>
        {!canAddReading(draft) && <p className="text-[11px] text-amber-200">At most {MAX_READINGS} readings on one line.</p>}
      </div>

      <div className="space-y-2">
        <p className="text-xs font-semibold text-slate-200">Photos</p>
        {draft.photoIds.length === 0 && <p className="text-[11px] text-slate-400">No photos on this line.</p>}
        <ul className="space-y-1">
          {draft.photoIds.map((id) => (
            <li key={id} className="flex items-center gap-2 rounded border border-slate-700 p-1 text-xs text-slate-200">
              <PhotoThumb visitId={visitId} photoId={id} />
              <span className="min-w-0 flex-1 truncate">{photoLabel(id, photos)}</span>
              <button
                type="button"
                aria-label={`Remove photo ${photoLabel(id, photos)}`}
                className={smallBtn}
                onClick={() => onDraft({ ...draft, photoIds: draft.photoIds.filter((p) => p !== id) })}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
        <PhotoPicker
          onPick={onPhoto}
          disabled={photoBusy || room <= 0}
          cameraLabel="📷 Add photo — camera"
          galleryLabel="🖼 Add photo — gallery"
        />
        {photoBusy && <p className="text-xs text-slate-400">Uploading the photo…</p>}
        {room <= 0 && <p className="text-[11px] text-amber-200">{PHOTO_LIMIT_REASON}</p>}
        {photosNote && <p className="text-[11px] text-amber-200">{photosNote}</p>}
        {pickable.length > 0 && room > 0 && (
          <div className="space-y-1">
            <p className="text-[11px] text-slate-400">Or pick a photo already taken on this job</p>
            <div className="flex flex-wrap gap-2">
              {pickable.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  aria-label={`Add photo ${photoLabel(t.id, photos)} to this line`}
                  className="flex w-24 flex-col items-center gap-1 rounded-lg border border-slate-600 p-1 text-[10px] text-slate-200"
                  onClick={() => onDraft({ ...draft, photoIds: [...draft.photoIds, t.id] })}
                >
                  <PhotoThumb visitId={visitId} photoId={t.id} />
                  <span className="w-full truncate">+ {photoLabel(t.id, photos)}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {error && <p className="rounded bg-red-950/60 p-2 text-xs text-red-200">{error}</p>}
      {note && <p className="rounded bg-emerald-900/50 p-2 text-xs text-emerald-200">{note}</p>}

      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy || photoBusy || blocked !== null}
          title={blocked ?? undefined}
          onClick={onSave}
          className="flex-1 rounded-lg bg-emerald-700 px-3 py-3 text-sm font-semibold text-white disabled:opacity-40"
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          disabled={busy || line.entry === null}
          title={line.entry === null ? CLEAR_NEEDS_ENTRY : 'Take this line off the report'}
          onClick={onClear}
          className="rounded-lg border border-red-800 px-4 py-3 text-sm font-semibold text-red-200 disabled:opacity-40"
        >
          Clear
        </button>
      </div>
      {blocked && <p className="text-[11px] text-amber-200">{blocked}</p>}
      {line.entry === null && <p className="text-[11px] text-slate-400">{CLEAR_NEEDS_ENTRY}</p>}
    </div>
  )
}

// ── The section ──────────────────────────────────────────────────────────────────────────────────
export function JobCompletionReport({ visitId }: { visitId: string }) {
  const [lines, setLines] = useState<CompletionLineView[] | null>(null)
  const [invoiceNumber, setInvoiceNumber] = useState<string | null>(null)
  const [reason, setReason] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [draft, setDraft] = useState<CompletionDraft | null>(null)
  const [busy, setBusy] = useState(false)
  const [photoBusy, setPhotoBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [photos, setPhotos] = useState<VisitPhotoSummary[]>([])
  const [photosNote, setPhotosNote] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const r = await fetchCompletionLines(visitId)
      setLines(r.lines)
      setInvoiceNumber(r.invoiceNumber)
      setReason(r.reason)
      setLoadError(null)
    } catch (err) {
      setLoadError(completionFailureWords(err, 'load'))
    }
  }, [visitId])
  useEffect(() => { void load() }, [load])

  const loadPhotos = useCallback(async () => {
    try {
      setPhotos(await fetchVisitPhotos(visitId))
      setPhotosNote(null)
    } catch (err) {
      setPhotosNote(completionFailureWords(err, 'list'))
    }
  }, [visitId])

  const replaceLine = (next: CompletionLineView) =>
    setLines((cur) => (cur ?? []).map((l) => (l.lineId === next.lineId ? next : l)))

  const toggle = (line: CompletionLineView) => {
    if (openId === line.lineId) { setOpenId(null); setDraft(null); return }
    setOpenId(line.lineId)
    setDraft(draftFromLine(line))
    setError(null)
    setNote(null)
    void loadPhotos()
  }

  const save = async (line: CompletionLineView) => {
    if (!draft) return
    setBusy(true); setError(null); setNote(null)
    try {
      replaceLine(await saveCompletionLine(visitId, line.lineId, bodyFromDraft(draft)))
      setOpenId(null); setDraft(null)
    } catch (err) {
      setError(completionFailureWords(err, 'save'))
    } finally {
      setBusy(false)
    }
  }

  const clear = async (line: CompletionLineView) => {
    if (!window.confirm(`Clear the write-up on "${lineTitle(line)}"? It comes off the report (the photos stay on the job).`)) return
    setBusy(true); setError(null); setNote(null)
    try {
      await clearCompletionLine(visitId, line.lineId)
      replaceLine({ ...line, entry: null })
      setOpenId(null); setDraft(null)
    } catch (err) {
      setError(completionFailureWords(err, 'clear'))
    } finally {
      setBusy(false)
    }
  }

  const addPhoto = async (file: File) => {
    if (!draft) return
    setPhotoBusy(true); setError(null); setNote(null)
    try {
      setDraft(await addPhotoToDraft(visitId, file, draft))
      void loadPhotos()
      setNote('Photo filed to the job and added here — press Save to keep it on this line.')
    } catch (err) {
      setError(completionFailureWords(err, 'photo'))
    } finally {
      setPhotoBusy(false)
    }
  }

  const all = lines ?? []
  return (
    <section className="space-y-2 rounded-xl border border-slate-700 bg-slate-800/60 p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-white">
          Job completion report{invoiceNumber ? <span className="text-xs font-normal text-slate-400"> — Invoice {invoiceNumber}</span> : null}
        </h2>
        {lines && all.length > 0 && <span className="text-xs text-slate-300">{writtenUpWords(all)}</span>}
      </div>
      <p className="text-[11px] text-slate-400">
        For each line on the invoice: what was done and why, the NEC articles, readings and photos. The office sees the same write-up.
      </p>
      {loadError && (
        <div className="space-y-2">
          <p className="rounded bg-amber-950/60 p-2 text-xs text-amber-200">{loadError}</p>
          <button type="button" className={smallBtn} onClick={() => void load()}>Try again</button>
        </div>
      )}
      {!loadError && lines === null && <p className="text-xs text-slate-400">Loading the lines…</p>}
      {lines && all.length === 0 && !loadError && (
        <p className="rounded bg-slate-900/60 p-2 text-xs text-slate-300">{reason ?? 'No signed invoice lines on this job yet.'}</p>
      )}
      <div className="space-y-2">
        {all.map((line) => (
          <div key={line.lineId} className="space-y-2">
            <CompletionLineRow line={line} open={openId === line.lineId} onToggle={() => toggle(line)} />
            {openId === line.lineId && draft && (
              <CompletionLineEditor
                line={line}
                draft={draft}
                onDraft={setDraft}
                visitId={visitId}
                photos={photos}
                photosNote={photosNote}
                busy={busy}
                photoBusy={photoBusy}
                error={error}
                note={note}
                onSave={() => void save(line)}
                onClear={() => void clear(line)}
                onPhoto={(f) => void addPhoto(f)}
              />
            )}
          </div>
        ))}
      </div>
    </section>
  )
}
