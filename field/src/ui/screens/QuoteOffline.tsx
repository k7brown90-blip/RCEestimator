/**
 * The Quote screen with no signal — the strip, the waiting list and the words (Phase 7 unit U5,
 * 2026-10-10, one-estimating-system plan).
 *
 * Kyle, 2026-09-22: "They would have to be able to do estimates ... without service."
 *
 * What is here is what the tech SEES of the queue (lib/quoteSync.ts): the header strip that says
 * "No signal — N changes waiting" or "Sending N changes…", the "Changes waiting (N)" list with a
 * Discard on each change (the exit for a thing that exists only on this phone — standing rule), and
 * the one place every "greyed with its reason" sentence from the design's §2 table is worded, so
 * the screen, the issued panel, the picker and the tests cannot drift apart.
 *
 * Nothing here prices anything: the figures a line shows come from the view (the office's own, or
 * the labelled Preview from the saved price sheet), and these components only print the label.
 */

import { useState } from 'react'
import type { QuoteOpRecord } from '../../db/database'
import type { QuoteViewLine } from '../../lib/quoteSync'
import { describeQuoteOp, quoteOpStatusWords, type QuoteOpWordsLookup } from '../../lib/quoteOpWords'
import { MAY_COME_DOWN, PRICED_WHEN_SIGNAL_RETURNS } from '../../../../shared/quotePreview'
import { SIGN_NEEDS_ISSUE_REASON } from '../../lib/signatureGate'

// ─── The words (design §1 and §2, one sentence each) ──────────────────────────────────────────

/** The banner under the header with no signal (§1). */
export const NO_SIGNAL_BANNER = 'No signal — this quote is saved on this phone and goes to the office when you have signal.'

/** Issue / "Save changes to the estimate" with no signal (§2). */
export const OFFLINE_ISSUE_REASON = 'Needs signal — the estimate number and final price come from the office'
/** Issue while changes are still on their way (online, queue not empty). */
export function sendingIssueReason(waiting: number): string {
  return `Sending ${waiting} change${waiting === 1 ? '' : 's'} to the office — issue once ${waiting === 1 ? 'it has' : 'they have'} landed`
}
/** Anything blocked by a refused change: the tech decides on it first. */
export const REFUSED_FIRST_REASON = 'A change was refused by the office — Discard it under "Changes waiting" first'
/** Issue, Show the customer and Sign now after a sync, until "I've checked the prices" (§2, §3; U6). */
export const CHECK_PRICES_FIRST = 'Check the prices first — the office priced what this phone sent; see "Prices from the office\'s book" above'
/** Sign now on a preview (§2, "Sign on a quote built or changed offline"; U6) — the gate's own sentence (lib/signatureGate.ts). */
export const PREVIEW_SIGN_REASON = SIGN_NEEDS_ISSUE_REASON
/** The watermark across the customer's view of a preview (§1; U6). */
export const PREVIEW_WATERMARK = 'Preview — the final price is set when the estimate is issued'
/** "Show the customer" on a preview with nothing priced in it. */
export function previewNothingToShowReason(quoteReason: string | null): string {
  return quoteReason
    ? `Nothing to show yet — ${quoteReason.charAt(0).toLowerCase()}${quoteReason.slice(1)}`
    : 'Nothing to show yet — every option has a line that is priced when signal returns'
}
/** The strip after a 401: the queue waits for the tech, not for signal (§5). */
export function signInAgainWords(waiting: number): string {
  return `Sign in again — ${waiting} change${waiting === 1 ? '' : 's'} waiting`
}
export const SIGN_IN_AGAIN_HINT = 'The office no longer accepts this phone\'s sign-in. Reconnect this device from the Today screen (Connection settings); the changes go on their own once it is signed in.'

/** "Show the customer" on a quote changed on this phone: nothing signable yet (§2, "Sign on a quote built or changed offline"). */
export const OFFLINE_SHOW_REASON = 'No signal — the customer\'s view shows the office\'s figures; it opens when your changes have reached the office'
export const SENDING_SHOW_REASON = 'Sending your changes — the customer\'s view opens when they have reached the office'
/**
 * "Show the customer" with no signal on an UNCHANGED saved quote that was never issued: the figures
 * on it are the office's draft figures, not frozen ones, and nothing on it can be signed (U8, Kyle's
 * ruling 9: with no signal only an estimate issued with signal and saved on this phone is shown and signed).
 */
export const OFFLINE_SHOW_SAVED_REASON = 'Needs signal — this quote has not been issued; with no signal only an estimate issued with signal and saved on this phone can be shown and signed'

/** Walk the job (AI), basic match, Confirm / Reject, Open questions (§2). */
export const OFFLINE_AI_REASON = 'Needs signal — the AI and the office\'s suggestions are online only'
/** The lifecycle calls decided at the office (§2). */
export const OFFLINE_COPY_LINES_REASON = 'Needs signal — copying lines is decided at the office'
export const OFFLINE_COPY_NEW_REASON = 'Needs signal — a new quote is started at the office'
export const OFFLINE_DELETE_REASON = 'Needs signal — the office has this quote, so deleting it needs the office'
export const OFFLINE_CHANGE_ORDER_REASON = 'Needs signal — a change order is opened against the signed estimate at the office'
/**
 * Online, but this draft has changes still on their way (or landed, with the office's answer not
 * back yet): a call that goes round the queue would land out of order.
 */
export function waitForChangesReason(waiting: number): string {
  if (waiting <= 0) return 'Wait for the office\'s answer to your changes first'
  return `Wait for your ${waiting} waiting change${waiting === 1 ? '' : 's'} to reach the office first`
}
/** Discard on the start of a phone-only quote: the exit for the whole quote is "Delete this quote". */
export const DISCARD_START_REASON = 'This quote exists only on this phone — use "Delete this quote" below to drop it whole'
export const DISCARD_FIRST_REASON = 'Discard the changes under "Changes waiting" first — they would have nowhere to go'

/** Photos for the estimate (§2): uploadJobPhoto is a bare fetch. */
export const OFFLINE_PHOTOS_REASON = 'Needs signal — photos for the estimate upload live'
/** Email the estimate, the financing link, Send to a different address (§2). */
export const OFFLINE_EMAIL_REASON = 'Needs signal'
/** The Job site's brief when it cannot load (§2) — in place of the raw "Failed to fetch". */
export const JOB_BRIEF_OFFLINE = 'No signal — job details from the office load when you have signal'
/** Under the totals while the figures are a preview or blank (§2). */
export const FINANCING_AFTER_ISSUE = 'Financing shown once the estimate is issued'
/** The picker with no signal and nothing saved. */
export const NO_SAVED_BOOK = 'No price book saved on this phone yet — open the Today screen once with signal and it is saved for next time.'

/** "7:02 AM" today, "Oct 9, 7:02 AM" otherwise — "Price book saved on this phone at 7:02 AM". */
export function savedAtWords(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const today = d.toDateString() === new Date().toDateString()
  return today
    ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

/** The words under a line's figure (design §3 badges), or null when the figure is the office's own. */
export function lineFigureWords(line: Pick<QuoteViewLine, 'priceStatus' | 'priceReason'>): string | null {
  if (line.priceStatus === 'preview') return 'Preview'
  if (line.priceStatus === 'mayComeDown') return line.priceReason ?? MAY_COME_DOWN
  if (line.priceStatus === 'unpriced') return line.priceReason ?? PRICED_WHEN_SIGNAL_RETURNS
  return null
}

// ─── The header strip ─────────────────────────────────────────────────────────────────────────

/**
 * One line under the header, always, while anything is off the ordinary: no signal, or changes
 * still on their way. With signal and nothing waiting it renders nothing — the screen reads as it
 * always did.
 */
export function SignalStrip(props: {
  offline: boolean
  waiting: number
  refused: number
  /** The office answered 401 on the last try (U6): "Sign in again — N changes waiting" in place of "Sending". */
  authNeeded?: boolean
}) {
  const { offline, waiting, refused, authNeeded = false } = props
  if (!offline && waiting === 0 && refused === 0) return null
  const n = (k: number) => `${k} change${k === 1 ? '' : 's'}`
  const signIn = !offline && authNeeded && waiting > 0
  return (
    <div role="status" className={`space-y-1 rounded-lg border p-3 text-xs ${offline || signIn ? 'border-amber-700 bg-amber-950/50 text-amber-100' : 'border-sky-800 bg-sky-950/50 text-sky-100'}`}>
      {offline && (
        <p className="font-semibold">{waiting > 0 ? `No signal — ${n(waiting)} waiting` : 'No signal'}</p>
      )}
      {offline && <p>{NO_SIGNAL_BANNER}</p>}
      {signIn && <p className="font-semibold">{signInAgainWords(waiting)}</p>}
      {signIn && <p>{SIGN_IN_AGAIN_HINT}</p>}
      {!offline && !signIn && waiting > 0 && <p className="font-semibold">Sending {n(waiting)}…</p>}
      {refused > 0 && (
        <p className="font-semibold text-red-200">
          {n(refused)} refused by the office — see &quot;Changes waiting&quot; below
        </p>
      )}
    </div>
  )
}

// ─── Changes waiting (N) ──────────────────────────────────────────────────────────────────────

/**
 * Every edit on this phone that the office has not finished with, in order, each with its words
 * and a Discard. Discarding one takes the changes that depended on it (an edit to a line whose add
 * is discarded), and the screen says which went. A change the office already took cannot be
 * discarded — it is the office's now — and the button says so rather than vanishing.
 */
export function ChangesWaiting(props: {
  ops: readonly QuoteOpRecord[]
  lookup: QuoteOpWordsLookup
  busy: boolean
  /** Resolves with the words for what went (the screen prints them here). THROWS when the change is on the wire. */
  onDiscard: (opId: string) => Promise<string>
  /** Open from the start (tests, and a screen with a refusal to show). */
  startOpen?: boolean
}) {
  const { ops, lookup, busy, onDiscard, startOpen = false } = props
  const [open, setOpen] = useState(startOpen)
  const [said, setSaid] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  const pending = ops.filter((o) => o.status !== 'delivered').length
  if (ops.length === 0) return null
  const discard = async (op: QuoteOpRecord) => {
    if (!window.confirm(`Discard this change? ${describeQuoteOp(op, lookup)}\n\nIt never reached the office, so it is simply gone — along with any later change that depended on it.`)) return
    setWorking(true); setError(null); setSaid(null)
    try {
      setSaid(await onDiscard(op.opId))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setWorking(false)
    }
  }
  return (
    <section aria-label="Changes waiting" className="rounded-lg border border-slate-700 bg-slate-800/60">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 p-3 text-left text-sm font-semibold text-white"
      >
        <span>Changes waiting ({pending})</span>
        <span className="text-xs font-normal text-slate-400">{open ? 'tap to close' : 'tap to open'}</span>
      </button>
      {open && (
        <div className="space-y-2 border-t border-slate-700 p-3">
          <p className="text-[11px] text-slate-400">
            What this phone has done to the quote that the office has not finished with, in order. Discard a change and it is gone — it never reached the office.
          </p>
          {said && <p className="rounded bg-slate-900 p-2 text-xs text-emerald-200">{said}</p>}
          {error && <p role="alert" className="rounded bg-red-950/60 p-2 text-xs text-red-200">{error}</p>}
          <ol className="space-y-2">
            {ops.map((op) => {
              const delivered = op.status === 'delivered'
              const refused = op.status === 'refused'
              const why = delivered
                ? 'This change already reached the office — it can only be changed there now.'
                : op.kind === 'start_quote'
                  ? DISCARD_START_REASON
                  : undefined
              return (
                <li key={op.opId} className={`rounded border p-2 text-xs ${refused ? 'border-red-800 bg-red-950/40' : 'border-slate-700 bg-slate-900/40'}`}>
                  <p className="text-slate-100">{describeQuoteOp(op, lookup)}</p>
                  <p className={refused ? 'text-red-200' : 'text-slate-400'}>{quoteOpStatusWords(op)}</p>
                  <button
                    type="button"
                    disabled={busy || working || why !== undefined}
                    title={why ?? 'Drops this change (and any that depended on it) from this phone'}
                    onClick={() => void discard(op)}
                    className="mt-1 text-red-300 underline disabled:opacity-40"
                  >
                    Discard
                  </button>
                </li>
              )
            })}
          </ol>
        </div>
      )}
    </section>
  )
}

/** "Price book saved on this phone at 7:02 AM" — the age of the saved book, always on screen with no signal (§3). */
export function PriceBookAge(props: { cachedAt: string | null; what?: string }) {
  const { cachedAt, what = 'Price book' } = props
  if (!cachedAt) return <p className="text-[11px] text-amber-200">{NO_SAVED_BOOK}</p>
  return <p className="text-[11px] text-slate-400">{what} saved on this phone at {savedAtWords(cachedAt)}</p>
}
