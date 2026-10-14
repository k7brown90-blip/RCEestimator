/**
 * The field Quote screen's estimate-level controls (2026-10-08, one-estimating-system plan, Phase 2):
 * "Adding into", "One-or-the-other options" + "Copy lines", and the totals with the "Discount" block.
 *
 * Kyle, 2026-10-08: the office and the truck are ONE estimating system — whatever Estimate Intake can
 * do to a draft, the Quote screen can do too, through the same server functions, worded the same.
 * Each control here is the phone's twin of one in PriceBookIntakePage.tsx:
 *
 *   Adding into [Option A] [B] [C] ...      the office's "Adding into" bar
 *   [ ] One-or-the-other options            OptionModeAndCopy's checkbox
 *   Copy [A] -> [B] [Copy lines]            OptionModeAndCopy's copy
 *   Discount [Military 5%] [Senior 5%] [Custom %] [Apply] [clear]    the Send panel's discount block
 *
 * NO MONEY ARITHMETIC IN THIS FILE (2026-09-24 Unit A trap 2). The discount in dollars, the amount
 * after it and the one-or-the-other range are worked out by the server (services/quoteMoney.ts, from
 * discounts.ts' rate and cap) and arrive in `quote.money`; this file only prints them. The office's
 * screen prices the discount in the browser — that copy was deliberately NOT ported.
 *
 * A SIGNED quote shuts every one of these. The reason is printed once, at the top of the Quote screen
 * (QuoteScreen); each greyed control here carries it as its tooltip and is greyed, never hidden.
 * (The server still lets the OFFICE change the discount, option names and mode on a signed estimate —
 * Kyle, 2026-09-29, they reach the customer through "Save changes to the estimate" — but the truck
 * cannot press that, so a change made here would sit on the draft unseen by anyone.)
 */

import { useEffect, useState } from 'react'
import type { QuoteState } from '../../lib/crmSync'
import { optionHint, type EstimateOptionLetter } from '../../../../shared/estimateOptions'
import { picksOne as picksExactlyOne, selectionPrice } from '../../../../shared/quoteMoney'
import { PRICED_WHEN_SIGNAL_RETURNS } from '../../../../shared/quotePreview'
import { cheapestSelection } from '../../../../shared/financingDisplay'
import { FinancingLine } from '../components/FinancingSheet'
import {
  COPY_SAME_REASON,
  copiedNotice,
  copyEmptyReason,
  customPercentLooksValid,
} from '../../lib/quoteOptions'
import { FINANCING_AFTER_ISSUE, savedAtWords } from './QuoteOffline'

const money = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `$${n.toFixed(2)}`)
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

// ─── Adding into ─────────────────────────────────────────────────────────────

/** Which option the next item from the price book lands in. "+ Add Option D" selects the new one. */
export function AddingIntoBar(props: {
  options: QuoteState['optionSet']['options']
  active: EstimateOptionLetter
  onSelect: (option: EstimateOptionLetter) => void
  /** The server's reason this quote is shut, or null. */
  lockedReason: string | null
}) {
  const { options, active, onSelect, lockedReason } = props
  const activeEntry = options.find((o) => o.option === active)
  return (
    <div className="space-y-1 rounded-lg border border-slate-700 bg-slate-800/60 p-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-slate-300">Adding into</span>
        {options.map((o) => (
          <button
            key={o.option}
            type="button"
            aria-pressed={active === o.option}
            disabled={Boolean(lockedReason)}
            title={lockedReason ?? (o.label ? `${o.label}` : `Put the next item in Option ${o.option}`)}
            onClick={() => onSelect(o.option)}
            className={
              active === o.option
                ? 'min-h-[2.5rem] rounded-full bg-sky-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50'
                : 'min-h-[2.5rem] rounded-full border border-slate-600 px-4 py-2 text-sm text-slate-200 disabled:opacity-50'
            }
          >
            Option {o.option}
          </button>
        ))}
      </div>
      <p className="text-[11px] text-slate-400">
        {activeEntry?.label ? `${activeEntry.label} — ` : ''}{optionHint(active, 'field')}
      </p>
    </div>
  )
}

// ─── One-or-the-other mode + Copy lines ──────────────────────────────────────

export function OptionModeAndCopy(props: {
  quote: Pick<QuoteState, 'optionSet' | 'money'>
  busy: boolean
  lockedReason: string | null
  /** Each of these refreshes the quote and THROWS the server's words on refusal. */
  onSetMode: (exclusive: boolean) => Promise<void>
  onCopy: (from: EstimateOptionLetter, to: EstimateOptionLetter) => Promise<{ copied: number }>
  /**
   * Why "Copy lines" alone is greyed (Phase 7 U5): it is decided at the office and goes round the
   * queue, so with no signal, or while this quote's changes are still on their way, it waits. The
   * mode checkbox is NOT greyed by this — it queues like any other edit.
   */
  copyBlockedReason?: string | null
}) {
  const { quote, busy, lockedReason, onSetMode, onCopy, copyBlockedReason = null } = props
  const entries = quote.optionSet.options
  const letters = entries.map((e) => e.option)
  const [fromPick, setFrom] = useState<EstimateOptionLetter>('A')
  const [toPick, setTo] = useState<EstimateOptionLetter>('B')
  // A pick that has since been removed falls back to the first / second option the quote has.
  const from: EstimateOptionLetter = letters.includes(fromPick) ? fromPick : letters[0]
  const to: EstimateOptionLetter = letters.includes(toPick) ? toPick : (letters[1] ?? letters[0])
  const [working, setWorking] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const sourceLines = entries.find((e) => e.option === from)?.lineCount ?? 0
  // Greyed WITH its reason, in this order: shut, no signal / changes on their way, the two boxes, nothing to copy.
  const copyReason = lockedReason ?? copyBlockedReason ?? (from === to ? COPY_SAME_REASON : sourceLines === 0 ? copyEmptyReason(from) : null)
  const disabled = busy || working

  const run = async (fn: () => Promise<void>) => {
    setWorking(true)
    setError(null)
    setNotice(null)
    try { await fn() } catch (e) { setError(errText(e)) } finally { setWorking(false) }
  }

  return (
    <div className="space-y-2 rounded-lg border border-slate-700 bg-slate-800/60 p-3">
      <label className="flex items-start gap-3 text-sm text-slate-200">
        <input
          type="checkbox"
          className="mt-0.5 h-5 w-5"
          checked={quote.money.exclusiveOptions}
          disabled={disabled || Boolean(lockedReason)}
          title={lockedReason ?? undefined}
          onChange={(e) => void run(() => onSetMode(e.target.checked))}
        />
        <span>
          <span className="font-medium">One-or-the-other options</span>
          <span className="ml-1 text-[11px] text-slate-400">
            — customer picks exactly ONE (e.g. three lengths, one charger). Unchecked: options add together.
          </span>
        </span>
      </label>

      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-300">
        Copy
        <select
          className="min-h-[2.5rem] rounded border border-slate-600 bg-slate-900 p-2 text-sm text-white"
          aria-label="Copy from option"
          value={from}
          disabled={disabled || Boolean(lockedReason)}
          onChange={(e) => setFrom(e.target.value as EstimateOptionLetter)}
        >
          {letters.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
        →
        <select
          className="min-h-[2.5rem] rounded border border-slate-600 bg-slate-900 p-2 text-sm text-white"
          aria-label="Copy into option"
          value={to}
          disabled={disabled || Boolean(lockedReason)}
          onChange={(e) => setTo(e.target.value as EstimateOptionLetter)}
        >
          {letters.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
        <button
          type="button"
          disabled={disabled || Boolean(copyReason)}
          title={copyReason ?? `Copy every line of Option ${from} into Option ${to}`}
          onClick={() => void run(async () => {
            const r = await onCopy(from, to)
            setNotice(copiedNotice(r.copied, from, to))
          })}
          className="min-h-[2.5rem] rounded-lg border border-slate-500 px-4 py-2 text-sm font-medium text-slate-100 disabled:opacity-50"
        >
          {working ? 'Working…' : 'Copy lines'}
        </button>
      </div>
      {/* The reason a greyed Copy is greyed, on the page — a tooltip does not exist on a phone. */}
      {copyReason && !lockedReason && <p className="text-xs text-amber-200">{copyReason}.</p>}
      {notice && <p className="text-xs text-emerald-300">{notice}</p>}
      {error && <p role="alert" className="rounded bg-red-950/60 p-2 text-xs text-red-200">{error}</p>}
    </div>
  )
}

// ─── Totals + Discount ───────────────────────────────────────────────────────

/**
 * The grand total, the discount in dollars and what the customer pays after it — all sent by the
 * server — and the Discount controls. The per-option rows that used to be here are gone: each
 * option's heading on the board already shows its own subtotal.
 */
export function QuoteTotals(props: {
  quote: Pick<QuoteState, 'total' | 'money'>
  busy: boolean
  lockedReason: string | null
  /** Refreshes the quote and THROWS the server's words on refusal. `type: null` clears. */
  onSetDiscount: (next: { type: 'military' | 'senior' | 'custom' | null; percent?: number | null }) => Promise<void>
  /**
   * Where the figures in `quote` come from (Phase 7 U5, lib/quoteSync.ts QuoteView.priceSource):
   * 'server' (the default) is the office's own; 'preview' is the labelled Preview from the price
   * sheet saved on this phone at `priceSheetAt`; 'none' means no figure at all — the quote was
   * changed on this phone and no sheet is saved, so the totals read "priced when signal returns".
   */
  priceSource?: 'server' | 'none' | 'preview'
  priceSheetAt?: string | null
  /** A discount change waiting to reach the office (words only): the buttons show IT as pressed, not the office's old programme. */
  pendingDiscount?: { type: 'military' | 'senior' | 'custom' | null; percent: number | null } | null
}) {
  const { quote, busy, lockedReason, onSetDiscount, priceSource = 'server', priceSheetAt = null, pendingDiscount = null } = props
  const m = quote.money
  const d = m.discount
  // What the discount buttons show as pressed: the change waiting on this phone if there is one, else the office's.
  const shownType = pendingDiscount ? pendingDiscount.type : (d?.type ?? null)
  const shownPercent = pendingDiscount ? pendingDiscount.percent : (d?.percent ?? null)
  const [customPct, setCustomPct] = useState('')
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The box shows the applied figure when the quote already carries one (as the office's does).
  useEffect(() => {
    if (shownType === 'custom' && shownPercent !== null) setCustomPct(String(shownPercent))
  }, [shownType, shownPercent])

  const off = busy || working || Boolean(lockedReason)
  const apply = async (next: Parameters<typeof onSetDiscount>[0]) => {
    setWorking(true)
    setError(null)
    try { await onSetDiscount(next) } catch (e) { setError(errText(e)) } finally { setWorking(false) }
  }
  const customValid = customPercentLooksValid(customPct)
  // The shared rule (shared/quoteMoney.ts) — the same one the CRM Presentation page asks.
  const picksOne = picksExactlyOne(m)

  /*
    "or from $X/mo with financing" under the total - the phone's twin of Estimate Intake's totals bar
    (review finding, 2026-10-08: the office builder showed it and the tech's builder did not). The
    figures are the server's (money.financing); this only picks WHICH selection to look up, exactly as
    the office does: ordinary mode = everything with work in it; one-or-the-other = the cheapest of
    the alternatives, and the sheet says so. Same sheet as "Show the customer" (FinancingSheet).
  */
  let finSelected: string[] = []
  let finLabel = ''
  if (picksOne) {
    const best = cheapestSelection(m.financing, (m.pickable ?? []).map((o) => [o]))
    if (best) {
      finSelected = best.key.split('+')
      finLabel = `Option ${best.key} (the cheapest of the alternatives)`
    }
  } else {
    finSelected = [...(m.pickable ?? [])]
    finLabel = `Option${finSelected.length > 1 ? 's' : ''} ${finSelected.join(' + ')}`
  }
  const finPrice = finSelected.length > 0 ? selectionPrice(m, finSelected) : null
  if (finLabel && (finPrice?.discount ?? 0) > 0) finLabel += ` (after ${money(finPrice?.discount)} discount)`

  // No figure to show at all: the quote was changed on this phone with no price sheet saved ('none'),
  // or a preview that could not price every option. The office's "incomplete" keeps its own word.
  const noFigure = priceSource === 'none' || (priceSource === 'preview' && (picksOne ? !m.range : quote.total === null))

  return (
    <section aria-label="Totals" className="space-y-2 rounded-lg border border-slate-700 bg-slate-800/70 p-3 text-sm">
      {/* The headline. One-or-the-other: a range, because a grand sum of choices is a lie (Kyle, 2026-08-29). */}
      <p className="flex justify-between font-semibold text-white">
        <span>{priceSource === 'preview' ? 'Preview total' : 'Total'}{picksOne ? ' — customer picks one' : ''}</span>
        <span>
          {noFigure
            ? <span className="text-xs font-normal text-amber-300">{PRICED_WHEN_SIGNAL_RETURNS}</span>
            : picksOne
              ? (m.range ? `${money(m.range.min)}–${money(m.range.max)}` : <span className="text-amber-300">incomplete</span>)
              : money(quote.total)}
        </span>
      </p>
      {priceSource === 'preview' && (
        <p className="text-[11px] text-sky-300">
          Preview — prices saved on this phone{priceSheetAt ? ` at ${savedAtWords(priceSheetAt)}` : ''}. The final price is set when the estimate is issued with signal.
        </p>
      )}

      {priceSource === 'server' ? (
        <FinancingLine
          financing={m.financing}
          selected={finSelected}
          label={finLabel}
          total={finPrice?.total ?? null}
          className="min-h-[2.5rem] text-sm font-semibold text-sky-300 underline"
        />
      ) : (
        <p className="text-[11px] text-slate-400">{FINANCING_AFTER_ISSUE}</p>
      )}

      {d && (
        <div className="space-y-1 border-t border-slate-600 pt-2 text-emerald-300">
          {d.rows.map((r) => (
            <p key={r.label} className="flex justify-between gap-2">
              <span>
                {picksOne || d.rows.length > 1 ? `${d.label} · ${r.label}` : d.label}
                {r.capped ? ' (capped)' : ''}
              </span>
              <span>
                −{money(r.amount)}
                {picksOne ? ` → ${money(r.after)}` : ''}
              </span>
            </p>
          ))}
          {d.pricedOnceComplete && (
            <p className="text-xs text-amber-300">
              {priceSource === 'none' ? `${d.label}: ${PRICED_WHEN_SIGNAL_RETURNS.toLowerCase()}` : 'The discount prices once every line is confirmed.'}
            </p>
          )}
          {!picksOne && m.discountedTotal !== null && (
            <p className="flex justify-between border-t border-slate-600 pt-1 font-semibold text-white">
              <span>After discount</span><span>{money(m.discountedTotal)}</span>
            </p>
          )}
          {picksOne && m.discountedRange && (
            <p className="flex justify-between border-t border-slate-600 pt-1 font-semibold text-white">
              <span>After discount</span>
              <span>{money(m.discountedRange.min)}–{money(m.discountedRange.max)}</span>
            </p>
          )}
          {d.rows.some((r) => r.comboSaving > 0) && (
            <p className="text-[11px] text-slate-400">Includes the material saving for taking the options together.</p>
          )}
        </div>
      )}

      {/* The Discount block — same words as the office's (Send to the customer -> Discount). */}
      <div className="space-y-2 border-t border-slate-600 pt-2">
        {pendingDiscount && <p className="text-[11px] text-amber-200">Discount change waiting to reach the office</p>}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-slate-300">Discount</span>
          {([['military', 'Military 5%'], ['senior', 'Senior 5%']] as const).map(([val, label]) => (
            <button
              key={val}
              type="button"
              aria-pressed={shownType === val}
              disabled={off}
              title={lockedReason ?? undefined}
              onClick={() => void apply({ type: shownType === val ? null : val })}
              className={
                shownType === val
                  ? 'min-h-[2.5rem] rounded-lg bg-sky-700 px-3 py-2 text-sm font-medium text-white disabled:opacity-50'
                  : 'min-h-[2.5rem] rounded-lg border border-slate-500 px-3 py-2 text-sm text-slate-100 disabled:opacity-50'
              }
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="number"
            inputMode="decimal"
            min={0.01}
            max={50}
            step={0.5}
            value={customPct}
            disabled={off}
            title={lockedReason ?? undefined}
            onChange={(e) => setCustomPct(e.target.value)}
            placeholder="Custom %"
            aria-label="Custom discount percentage"
            className="min-h-[2.5rem] w-28 rounded border border-slate-600 bg-slate-900 p-2 text-sm text-white"
          />
          <button
            type="button"
            disabled={off || !customValid}
            title={lockedReason ?? (customValid ? undefined : 'Type a percentage above 0 and at most 50')}
            onClick={() => void apply({ type: 'custom', percent: Number(customPct) })}
            className={
              shownType === 'custom'
                ? 'min-h-[2.5rem] rounded-lg bg-sky-700 px-3 py-2 text-sm font-medium text-white disabled:opacity-50'
                : 'min-h-[2.5rem] rounded-lg border border-slate-500 px-3 py-2 text-sm text-slate-100 disabled:opacity-50'
            }
          >
            {shownType === 'custom' && shownPercent === Number(customPct) ? `Custom ${shownPercent}%` : 'Apply'}
          </button>
          {shownType !== null && (
            <button
              type="button"
              disabled={off}
              title={lockedReason ?? 'Take the discount off this quote'}
              onClick={() => { void apply({ type: null }); setCustomPct('') }}
              className="min-h-[2.5rem] rounded-lg border border-slate-600 px-3 py-2 text-sm text-slate-200 disabled:opacity-50"
            >
              Clear
            </button>
          )}
        </div>
        {!customValid && customPct.trim() !== '' && (
          <p className="text-xs text-amber-200">A custom discount is a percentage above 0 and at most 50.</p>
        )}
        {d && (
          <p className="text-[11px] text-emerald-300">{d.terms} · shows on the customer&apos;s page and the PDF</p>
        )}
        {error && <p role="alert" className="rounded bg-red-950/60 p-2 text-xs text-red-200">{error}</p>}
      </div>
    </section>
  )
}
