/**
 * "Photos for the estimate" on the Quote screen (Phase 2 unit E, 2026-10-08, one estimating
 * system). The phone's twin of the office's photo picker on Estimate Intake, with ONE deliberate
 * difference of scope:
 *
 *   - the photos are THIS JOB's photos only (Kyle, 2026-10-09, ruling 2) - the quote's visit and its
 *     job chain, newest first. The office's picker keeps the whole account (Kyle, 2026-10-01:
 *     "sending the photos as evidence is our standard"); the tech is standing in one job, and the
 *     server refuses a photo from another job on the preview and on the email;
 *   - NOTHING rides the email unless it is ticked, and at most ten do;
 *   - a photo taken here is filed on the job, through the existing job-photo upload (the same one
 *     the Job site screen's "Job photos" uses) - there is no second upload path;
 *   - a photo added here has its way out right here: the technician who took it can take it back.
 *
 * The ticks live on the Quote screen (they go with "Email the estimate to the customer"); this
 * component only renders them. Nothing here touches money, hours or cost.
 */

import { useEffect, useRef, useState } from 'react'
import type { EstimatePhoto } from '../../../../shared/estimatePhotos'
import { PhotoPicker } from '../components/PurchaseOrderPanel'

/** The words under the heading - one place so the tests and the screen cannot drift. */
export function photosHint(max: number): string {
  return `Tick the photos to send with the estimate email - nothing goes unless it is ticked (up to ${max}). Only this job's photos are here, newest first.`
}

export const PHOTOS_EMPTY =
  'No photos on this job yet, so there is nothing to attach. Take one above - it is filed on this job.'

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function PhotoThumb({ id, load, alt }: { id: string; load: (photoId: string) => Promise<Blob>; alt: string }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    let made: string | null = null
    load(id)
      .then((blob) => {
        if (cancelled) return
        made = URL.createObjectURL(blob)
        setUrl(made)
      })
      .catch(() => { if (!cancelled) setUrl(null) })
    return () => {
      cancelled = true
      if (made) URL.revokeObjectURL(made)
    }
  }, [id, load])
  return url
    ? <img src={url} alt={alt} className="h-20 w-full object-cover" />
    : <div className="flex h-20 w-full items-center justify-center bg-slate-900 text-[10px] text-slate-500">photo</div>
}

export function QuotePhotos(props: {
  /** null = still loading. */
  photos: EstimatePhoto[] | null
  /** How many photos this job has; more than the list means the list is only the newest. */
  total?: number
  max: number
  selected: string[]
  /** Why ticking is unavailable (the estimate is signed - there is no estimate email left to send), or null. */
  tickLockedReason: string | null
  /** Another call on the Quote screen is in flight. */
  busy: boolean
  loadPreview: (photoId: string) => Promise<Blob>
  onToggle: (photoId: string) => void
  onAdd: (file: File, caption: string) => Promise<void>
  onRemove: (photoId: string) => Promise<void>
  /**
   * Start closed behind one line - "Photos for the estimate (N ticked)" - and open on a tap
   * (2026-10-08 review). In the builder the grid is up to sixty thumbnails between the totals and the
   * Issue button on a screen that is already long, and the photos only matter at the email; the issued
   * panel, which sits next to the email button, leaves it open. Closed means the thumbnails are not
   * even fetched.
   */
  collapsible?: boolean
  /**
   * No signal (Phase 7 U5): the upload is a live fetch and the list comes from the office, so taking,
   * removing and listing are greyed WITH this reason (design §2, "Needs signal — photos for the
   * estimate upload live"), never hidden. Null with signal.
   */
  offlineReason?: string | null
}) {
  const { photos, total, max, selected, tickLockedReason, busy, loadPreview, onToggle, onAdd, onRemove, collapsible = false, offlineReason = null } = props
  const [open, setOpen] = useState(!collapsible)
  const [caption, setCaption] = useState('')
  const [working, setWorking] = useState(false)
  const [said, setSaid] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])

  const add = async (file: File) => {
    setWorking(true); setError(null); setSaid(null)
    try {
      await onAdd(file, caption.trim())
      if (mounted.current) { setSaid('Photo filed to the job.'); setCaption('') }
    } catch (err) {
      if (mounted.current) setError(`Upload failed - ${errText(err)} Try again with bars.`)
    } finally {
      if (mounted.current) setWorking(false)
    }
  }
  const remove = async (id: string) => {
    if (!window.confirm('Remove this photo from the job? This cannot be undone.')) return
    setWorking(true); setError(null); setSaid(null)
    try {
      await onRemove(id)
      if (mounted.current) setSaid('Photo removed.')
    } catch (err) {
      if (mounted.current) setError(errText(err))
    } finally {
      if (mounted.current) setWorking(false)
    }
  }

  const full = selected.length >= max
  if (!open) {
    return (
      <section className="rounded-lg border border-slate-700 bg-slate-800/60">
        <button
          type="button"
          aria-expanded={false}
          onClick={() => setOpen(true)}
          className="flex w-full items-center justify-between gap-2 p-3 text-left text-sm font-semibold text-white"
        >
          <span>📷 Photos for the estimate ({selected.length} ticked)</span>
          <span className="text-xs font-normal text-slate-400">tap to open</span>
        </button>
      </section>
    )
  }
  return (
    <section className="space-y-2 rounded-lg border border-slate-700 bg-slate-800/60 p-3">
      {collapsible ? (
        <button
          type="button"
          aria-expanded
          onClick={() => setOpen(false)}
          className="flex w-full items-center justify-between gap-2 text-left text-sm font-semibold text-white"
        >
          <span>Photos for the estimate</span>
          <span className="text-xs font-normal text-slate-400">tap to close</span>
        </button>
      ) : (
        <h2 className="text-sm font-semibold text-white">Photos for the estimate</h2>
      )}
      <p className="text-[11px] text-slate-400">{photosHint(max)}</p>
      {offlineReason && <p className="text-[11px] text-amber-200">{offlineReason}</p>}
      <input
        className="w-full rounded border border-slate-600 bg-slate-900 p-2 text-xs text-white disabled:opacity-50"
        placeholder="Caption for the next photo (optional)"
        value={caption}
        disabled={working || busy || Boolean(offlineReason)}
        title={offlineReason ?? undefined}
        onChange={(e) => setCaption(e.target.value)}
      />
      <PhotoPicker onPick={(f) => void add(f)} disabled={working || busy || Boolean(offlineReason)} />
      {working && <p className="text-xs text-slate-400">Working...</p>}
      {said && <p className="text-xs text-emerald-300">{said}</p>}
      {error && <p className="rounded bg-red-950/60 p-2 text-xs text-red-200">{error}</p>}

      {photos === null && !offlineReason && <p className="text-xs text-slate-500">Loading photos...</p>}
      {photos === null && offlineReason && <p className="text-xs text-slate-500">The job&apos;s photos list when you have signal.</p>}
      {photos !== null && photos.length === 0 && <p className="text-xs text-slate-400">{offlineReason ? 'The job\'s photos list when you have signal.' : PHOTOS_EMPTY}</p>}
      {photos !== null && photos.length > 0 && (
        <>
          <p className="text-xs text-slate-300">
            {selected.length > 0 ? `${selected.length} of ${max} ticked to send` : `None ticked - none will be sent (up to ${max})`}
          </p>
          {tickLockedReason && <p className="text-[11px] text-amber-200">{tickLockedReason}</p>}
          {total !== undefined && total > photos.length && (
            <p className="text-[11px] text-slate-400">Showing the newest {photos.length} of {total} photos on this job. The office can attach any of the others.</p>
          )}
          <div className="grid grid-cols-3 gap-2">
            {photos.map((p) => {
              const on = selected.includes(p.id)
              const blocked = tickLockedReason !== null || (!on && full)
              const why = tickLockedReason ?? (!on && full ? `Up to ${max} photos ride one email - untick one first.` : undefined)
              const label = `${p.jobLabel}${p.caption ? ` - ${p.caption}` : ''}`
              return (
                <div key={p.id} className="space-y-1">
                  <button
                    type="button"
                    disabled={blocked}
                    title={why ?? label}
                    aria-pressed={on}
                    onClick={() => onToggle(p.id)}
                    className={`relative block w-full overflow-hidden rounded border-2 ${on ? 'border-emerald-400' : 'border-transparent'} disabled:opacity-40`}
                  >
                    <PhotoThumb id={p.id} load={loadPreview} alt={label} />
                    {on && <span className="absolute right-1 top-1 rounded bg-emerald-500 px-1 text-[10px] font-bold text-slate-900">sending</span>}
                  </button>
                  <p className="text-[10px] leading-tight text-slate-400">
                    {new Date(p.visitDate).toLocaleDateString()} - {p.jobLabel}
                    {p.onThisVisit ? ' (this visit)' : ''}
                    {p.caption ? <span className="block text-slate-300">{p.caption}</span> : null}
                  </p>
                  {p.canRemove && (
                    <button
                      type="button"
                      disabled={working || busy || Boolean(offlineReason)}
                      title={offlineReason ?? undefined}
                      onClick={() => void remove(p.id)}
                      className="text-[11px] text-red-300 underline disabled:opacity-40"
                    >
                      remove
                    </button>
                  )}
                </div>
              )
            })}
          </div>
          <p className="text-[10px] text-slate-500">
            You can remove the photos you took on this visit. Photos from the job's other visits, or added by the office, are removed from the office.
          </p>
        </>
      )}
    </section>
  )
}
