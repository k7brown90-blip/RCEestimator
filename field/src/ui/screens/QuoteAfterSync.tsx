/**
 * The Quote screen AFTER a sync — what the office answered to the edits this phone queued (Phase 7
 * unit U6, 2026-10-10, one-estimating-system plan, design §3 and §5).
 *
 * Three things can come back from the office, and each gets its own card with the tech's choices
 * on it, never hidden:
 *
 *   - A REFUSAL (RefusalBanner): "1 change was refused: <the office's own words>", with
 *     [Discard this change] and [Discard all N waiting changes]. A refused edit stops that quote's
 *     later edits (a later one may depend on it) and is never retried on its own; the tech decides.
 *   - "THE OFFICE ALREADY STARTED A QUOTE FOR THIS VISIT" (RebasePrompt): the start-quote this
 *     phone queued was refused 409 with the office's draft id. [Add my N lines to it] re-points the
 *     queued line and option edits at the office's draft (the client ids keep the replay
 *     idempotent); each of the tech's SETTINGS edits — title/scope, discount, mode, option names —
 *     is listed as "Apply mine too?" and applied only when ticked, carrying the office's current
 *     value as `expected`, so nothing of the office's is overwritten silently (U6 trap: a rebase
 *     never auto-applies the tech's draft settings). [Keep them on this phone for now] leaves
 *     everything as it is. [Discard them] drops the phone's quote whole.
 *   - "CHECK THE PRICES" (CheckPricesPanel): the office priced what landed from its own book. The
 *     panel lists what is new or different (lib/priceCheck.ts — equality only, both numbers, no
 *     arithmetic) and Issue, Show the customer and Sign now stay greyed with "Check the prices
 *     first" until "I've checked the prices". A phone UX gate: the server's own finalize checks
 *     still decide the issue.
 *
 * Rendered to static markup by the tests (the field suite runs in node with no DOM); the handlers
 * are the lib's (lib/quoteSync.ts discardQuoteOp / discardAllQuoteOps / applyRebase /
 * discardRebase / markPricesReviewed), passed in by the screen.
 */

import { useState } from 'react'
import type { QuoteOpRecord } from '../../db/database'
import { describeQuoteOp, type QuoteOpWordsLookup } from '../../lib/quoteOpWords'
import { isSettingsOp } from '../../lib/quoteSync'
import type { PriceCheckReport } from '../../lib/priceCheck'
import { savedAtWords } from './QuoteOffline'

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

// ─── A refusal ────────────────────────────────────────────────────────────────────────────────

export const OFFICE_STARTED_FIRST = 'The office already started a quote for this visit'

/** "1 change was refused: <words>" — the heading of the banner. */
export function refusedHeading(refused: readonly Pick<QuoteOpRecord, 'body' | 'refusal'>[], lookup: QuoteOpWordsLookup): string {
  const [first] = refused
  if (!first) return ''
  const words = `${describeQuoteOp(first, lookup)} — ${first.refusal ?? 'no reason given'}`
  return refused.length === 1 ? `1 change was refused: ${words}` : `${refused.length} changes were refused. First: ${words}`
}

/**
 * The office said no to a queued edit, in its own words (design §5). The two exits are here, on
 * the card, as well as on the row under "Changes waiting". `waiting` is everything on the quote
 * that has not reached the office — the refused edit and the ones queued behind it.
 */
export function RefusalBanner(props: {
  refused: readonly QuoteOpRecord[]
  waiting: number
  lookup: QuoteOpWordsLookup
  busy: boolean
  /** Resolves with the words for what went. */
  onDiscard: (opId: string) => Promise<string>
  onDiscardAll: () => Promise<string>
}) {
  const { refused, waiting, lookup, busy, onDiscard, onDiscardAll } = props
  const [said, setSaid] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  if (refused.length === 0) return null
  const run = async (fn: () => Promise<string>) => {
    setWorking(true); setError(null); setSaid(null)
    try { setSaid(await fn()) } catch (err) { setError(errText(err)) } finally { setWorking(false) }
  }
  const one = refused[0]
  return (
    <section role="alert" aria-label="A change was refused" className="space-y-2 rounded-lg border border-red-800 bg-red-950/50 p-3 text-xs text-red-100">
      <p className="font-semibold">{refusedHeading(refused, lookup)}</p>
      <p className="text-red-200/90">
        The changes queued after it wait until you decide. Discard it and the rest go to the office; discard all of them and the quote is as the office has it.
      </p>
      {said && <p className="rounded bg-slate-900 p-2 text-emerald-200">{said}</p>}
      {error && <p className="rounded bg-red-900/60 p-2 text-red-100">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy || working}
          onClick={() => {
            if (!window.confirm(`Discard this change? ${describeQuoteOp(one, lookup)}\n\nIt never reached the office, so it is simply gone — along with any later change that depended on it.`)) return
            void run(() => onDiscard(one.opId))
          }}
          className="rounded-lg border border-red-400 px-3 py-2 font-semibold text-red-100 disabled:opacity-40"
        >
          Discard this change
        </button>
        <button
          type="button"
          disabled={busy || working || waiting === 0}
          onClick={() => {
            if (!window.confirm(`Discard all ${waiting} waiting change${waiting === 1 ? '' : 's'}? None of them reached the office, so they are simply gone.`)) return
            void run(onDiscardAll)
          }}
          className="rounded-lg border border-red-400 px-3 py-2 font-semibold text-red-100 disabled:opacity-40"
        >
          Discard all {waiting} waiting change{waiting === 1 ? '' : 's'}
        </button>
      </div>
    </section>
  )
}

// ─── The office started one first ─────────────────────────────────────────────────────────────

/** The line and option edits that move, and the settings edits that are each asked about. */
export function rebaseParts(ops: readonly QuoteOpRecord[]): { lines: number; moves: QuoteOpRecord[]; settings: QuoteOpRecord[] } {
  const live = ops.filter((o) => o.status !== 'delivered' && o.kind !== 'start_quote')
  return {
    lines: live.filter((o) => o.kind === 'add_line').length,
    moves: live.filter((o) => !isSettingsOp(o)),
    settings: live.filter((o) => isSettingsOp(o)),
  }
}

/** "Add my 3 lines to it", or "Add my changes to it" when no line was added. */
export function addMineLabel(lines: number): string {
  return lines > 0 ? `Add my ${lines} line${lines === 1 ? '' : 's'} to it` : 'Add my changes to it'
}

export function RebasePrompt(props: {
  /** Every edit on the phone's quote (the refused start-quote included). */
  ops: readonly QuoteOpRecord[]
  lookup: QuoteOpWordsLookup
  busy: boolean
  /** Why "Add my lines to it" is greyed (no signal: the office's quote is read first), or null. */
  addBlockedReason: string | null
  /** The ids of the settings edits the tech ticked "Apply mine too?" on. */
  onAddMine: (applySettings: string[]) => Promise<void>
  onKeep: () => void
  onDiscard: () => Promise<void>
}) {
  const { ops, lookup, busy, addBlockedReason, onAddMine, onKeep, onDiscard } = props
  const parts = rebaseParts(ops)
  const [apply, setApply] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  const run = async (fn: () => Promise<void>) => {
    setWorking(true); setError(null)
    try { await fn() } catch (err) { setError(errText(err)) } finally { setWorking(false) }
  }
  const off = busy || working
  const movesWords = parts.moves.length === 1 ? '1 change' : `${parts.moves.length} changes`
  return (
    <section role="alert" aria-label="The office already started a quote" className="space-y-2 rounded-lg border border-amber-700 bg-amber-950/50 p-3 text-xs text-amber-100">
      <p className="font-semibold">{OFFICE_STARTED_FIRST}</p>
      <p className="text-amber-200/90">
        This phone started its own while it had no signal. Your {movesWords} on it — {parts.lines} line{parts.lines === 1 ? '' : 's'} added, the rest edits and options — can be added to the office&apos;s quote; they go through in order with the same ids, so nothing lands twice.
      </p>
      {parts.settings.length > 0 && (
        <fieldset className="space-y-1 rounded border border-amber-800 p-2">
          <legend className="px-1 text-amber-200">Apply mine too? The office&apos;s quote keeps its own unless you tick.</legend>
          {parts.settings.map((op) => (
            <label key={op.opId} className="flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-0.5 h-5 w-5"
                checked={apply.includes(op.opId)}
                disabled={off}
                onChange={(e) => setApply((prev) => (e.target.checked ? [...prev, op.opId] : prev.filter((id) => id !== op.opId)))}
              />
              <span>{describeQuoteOp(op, lookup)}</span>
            </label>
          ))}
        </fieldset>
      )}
      {error && <p className="rounded bg-red-950/60 p-2 text-red-200">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={off || addBlockedReason !== null}
          title={addBlockedReason ?? "Moves your changes onto the office's quote and sends them"}
          onClick={() => void run(() => onAddMine(apply))}
          className="rounded-lg bg-emerald-700 px-3 py-2 font-semibold text-white disabled:opacity-40"
        >
          {addMineLabel(parts.lines)}
        </button>
        <button type="button" disabled={off} onClick={onKeep} className="rounded-lg border border-amber-500 px-3 py-2 font-semibold text-amber-100 disabled:opacity-40">
          Keep them on this phone for now
        </button>
        <button
          type="button"
          disabled={off}
          onClick={() => {
            if (!window.confirm(`Discard this phone's quote and its ${movesWords}? None of it reached the office. The office's quote opens in its place.`)) return
            void run(onDiscard)
          }}
          className="rounded-lg border border-red-400 px-3 py-2 font-semibold text-red-100 disabled:opacity-40"
        >
          Discard them
        </button>
      </div>
      {addBlockedReason && <p className="text-amber-200">{addBlockedReason}</p>}
    </section>
  )
}

// ─── Check the prices ─────────────────────────────────────────────────────────────────────────

export const CHECK_PRICES_HEADING = "Prices from the office's book — check before issuing"
export const CHECKED_PRICES_LABEL = "I've checked the prices"
export const NOTHING_TO_FLAG = 'Nothing to flag: every figure the office sent matches what this phone showed.'

export function CheckPricesPanel(props: {
  report: PriceCheckReport
  /** When the phone took its note of what it showed, or null. */
  shownAt: string | null
  busy: boolean
  onChecked: () => Promise<void>
}) {
  const { report, shownAt, busy, onChecked } = props
  const [error, setError] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  const tone = (kind: PriceCheckReport['rows'][number]['kind']) =>
    kind === 'gap' || kind === 'rate' ? 'text-amber-200' : kind === 'retired' ? 'text-slate-300' : 'text-white'
  return (
    <section aria-label="Check the prices" className="space-y-2 rounded-lg border border-sky-700 bg-sky-950/50 p-3 text-xs text-sky-100">
      <p className="font-semibold">{CHECK_PRICES_HEADING}</p>
      <p className="text-sky-200/90">
        The office priced what this phone sent from its own book.
        {report.comparedWith === 'preview' && ' Beside each figure is the Preview this phone showed'}
        {report.comparedWith === 'none' && ' This phone showed no figure for these lines'}
        {shownAt ? ` (noted ${savedAtWords(shownAt)}).` : '.'}
        {' '}Issue, Show the customer and Sign now open once you have checked.
      </p>
      {report.clean ? (
        <p className="rounded bg-slate-900/60 p-2 text-emerald-200">{NOTHING_TO_FLAG}</p>
      ) : (
        <ul className="space-y-1">
          {report.rows.map((row, i) => (
            <li key={i} className={`rounded bg-slate-900/60 p-2 ${tone(row.kind)}`}>{row.words}</li>
          ))}
        </ul>
      )}
      {error && <p className="rounded bg-red-950/60 p-2 text-red-200">{error}</p>}
      <button
        type="button"
        disabled={busy || working}
        onClick={() => {
          setWorking(true); setError(null)
          onChecked().catch((err) => setError(errText(err))).finally(() => setWorking(false))
        }}
        className="w-full rounded-lg bg-sky-700 p-3 text-sm font-semibold text-white disabled:opacity-40"
      >
        {CHECKED_PRICES_LABEL}
      </button>
    </section>
  )
}
