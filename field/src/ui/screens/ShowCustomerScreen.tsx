/**
 * "Show the customer" — the screen the technician hands to the homeowner (Phase 3 unit B,
 * 2026-10-08, one-estimating-system plan).
 *
 * Kyle, 2026-09-24 (two apps, two places): showing the quote to the homeowner is a FIELD action — the
 * customer is standing next to the tech, so the screen they look at lives on the phone in the tech's
 * hand. Until now the field could only open the public link. This is the phone's twin of the CRM's
 * PresentationPage "Customer view", on the SAME numbers:
 *
 *   - Each option: its name and description, its price, and its lines as the customer reads them
 *     (description and quantity — no line prices, and no line location: the estimate the customer
 *     signs does not print one, so neither does this screen). An option's price is looked up in the
 *     same finished table as the total (`money.selections`), never the Quote screen's own
 *     per-option figure.
 *   - A tick per option (a round radio in one-or-the-other mode), a live total, the programme
 *     discount and the combined-options saving. The total is LOOKED UP in the finished table the
 *     server sent (`quote.money.selections`, shared/quoteMoney.ts `selectionPrice`) — this file
 *     adds nothing, so the phone, the office's screen and the customer's page cannot disagree.
 *   - "Back to the quote" — the tech's way out. The dark strip across the top is the ONLY part of
 *     the screen not meant for the customer, and EVERY message addressed to the technician lives in
 *     it (why Sign now is greyed, what pressing it records, the "lines had no price" warning and its
 *     "Sign anyway" override). Nothing the homeowner reads tells them to go back and price the
 *     quote, and nothing invites them to press past a warning (review finding, 2026-10-08).
 *   - "Sign now" — records the estimate FIRST if it has not been (or the tech edited it after it was
 *     issued), by the very rule the office's Present screen uses (shared/presentIssue.ts, the
 *     server's lifecycle), and then hands off to signing with the ticked options. A draft that is
 *     already issued and unchanged is NOT issued again: each press used to make a new revision and
 *     kill the customer's link (2026-10-08 audit §5).
 *
 * WHAT THE CUSTOMER MUST NEVER SEE ON THIS SCREEN (constants.md: the tech hands the phone over):
 * labour hours, labour dollars, Red Cedar's material cost, margins, Synchrony rates, notes and
 * assessment findings. `customerOptions` below copies NAMED FIELDS only — a key added to the quote
 * payload later cannot reach the page by accident — and ShowCustomerScreen.test.tsx feeds it a
 * payload laced with those keys and reads the markup.
 *
 * Nothing here is editable except the ticks. Prices, lines and discount are changed on the Quote
 * screen, behind "Back to the quote".
 */

import { useState } from 'react'
import type { QuoteState } from '../../lib/crmSync'
import type { EstimateOptionLetter } from '../../../../shared/estimateOptions'
import { defaultSelection, picksOne, selectionPrice, toggleSelection } from '../../../../shared/quoteMoney'
import { presentDecision, signNowReason, type PresentDecision } from '../../../../shared/presentIssue'
import { FinancingLine } from '../components/FinancingSheet'

const money = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `$${n.toFixed(2)}`)

// ─── What the customer is shown (named fields only) ──────────────────────────

export interface CustomerLine {
  description: string
  quantity: number
}

export interface CustomerOption {
  option: EstimateOptionLetter
  /** What the tech named the option, or null. */
  name: string | null
  /** The option's description, or null. */
  description: string | null
  /** The option's own price; null while a line in it is unpriced. */
  price: number | null
  lines: CustomerLine[]
}

/**
 * The options the customer chooses between: the ones that hold work (`money.pickable`), in letter
 * order, each with CUSTOMER fields only. AI-proposed lines that nobody confirmed are not part of
 * the quote and are not shown.
 */
export function customerOptions(quote: QuoteState): CustomerOption[] {
  const pickable = new Set<string>(quote.money.pickable)
  return quote.optionSet.options
    .filter((o) => pickable.has(o.option))
    .map((o) => {
      return {
        option: o.option,
        name: o.label,
        description: o.note,
        // The option's own subtotal from the server's finished table (the same one the total reads),
        // so the price on the card is the price that is frozen and signed.
        price: selectionPrice(quote.money, [o.option])?.subtotal ?? null,
        lines: quote.lines
          .filter((l) => l.option === o.option && l.state !== 'PROPOSED')
          .map((l) => ({ description: l.description, quantity: l.quantity })),
      }
    })
}

/**
 * Why "Show the customer" is greyed, or null. Nothing to show means no option holds work, or none
 * can be priced: a screen with no number on it is not something to hand to a homeowner.
 */
export function showCustomerReason(quote: QuoteState | null): string | null {
  if (!quote) return 'The quote is still loading.'
  if (quote.lines.length === 0) return 'Add some work to the quote first — there is nothing to show the customer yet.'
  if (quote.money.pickable.length === 0) return 'The work is still waiting on you (AI proposals or open questions) — confirm it, then it can be shown.'
  if (Object.keys(quote.money.selections).length === 0) return 'Nothing is priced yet — every option has a line with no price, so there is no number to show.'
  return null
}

// ─── Sign now ────────────────────────────────────────────────────────────────

export interface SignHandoff {
  estimateId: string
  number: string
  /** The options the customer ticked. On a one-or-the-other estimate the server refuses anything but exactly one. */
  selectedOptions: EstimateOptionLetter[]
}

/** Why "Sign now" is greyed (null = live), most useful reason first. */
export function signNowGreyedReason(args: {
  decision: PresentDecision
  ticked: readonly string[]
  /** The reason a first/revised issue would be refused (AI proposals, open questions), or null. */
  issueBlockedReason: string | null
  canSign: boolean
}): string | null {
  const { decision, ticked, issueBlockedReason, canSign } = args
  if (ticked.length === 0) return 'Tick at least one option — there is nothing to sign yet.'
  const decided = signNowReason(decision)
  if (decided) return decided
  if (decision.kind === 'issue' && issueBlockedReason) return issueBlockedReason
  if (!canSign) return 'Signing on this phone is not available yet.'
  return null
}

/** The line under the button: what pressing it records. */
export function signFooter(decision: PresentDecision): string {
  switch (decision.kind) {
    case 'issue':
      return decision.revises
        ? `Sign now saves your changes to estimate ${decision.revises.number} as revision ${decision.revises.revision + 1} (same number) and replaces the customer's link, then opens signing.`
        : 'Sign now records the estimate and freezes its prices, then opens signing. Nothing is frozen before then.'
    case 'reuse':
      return decision.changedSince
        ? `Estimate ${decision.number} rev ${decision.revision} is already recorded, and the quote has been edited since — those edits are not on it. Signing uses the estimate as it stands.`
        : `Estimate ${decision.number} rev ${decision.revision} is already recorded and nothing has changed since — signing uses it as it stands.`
    case 'blocked':
      return decision.reason
  }
}

/**
 * Press "Sign now": issue first when the decision says so, otherwise use the estimate that exists,
 * then hand off. Returns the lines that froze at $0 when an issue happened (the caller shows them
 * and does NOT hand off — a total lower than the work is the last thing to say out loud before a
 * customer signs), or the hand-off to sign with.
 */
export async function runSignNow(args: {
  decision: PresentDecision
  selectedOptions: EstimateOptionLetter[]
  /** Issue (or revise) the draft — QuoteScreen's `issueQuote` + refresh. */
  issue: () => Promise<{ estimateId: string; number: string; unpriced: string[] }>
}): Promise<{ handoff: SignHandoff } | { unpriced: string[]; estimateNumber: string }> {
  const { decision, selectedOptions, issue } = args
  if (decision.kind === 'blocked') throw new Error(decision.reason)
  if (decision.kind === 'reuse') {
    return { handoff: { estimateId: decision.estimateId, number: decision.number, selectedOptions } }
  }
  const r = await issue()
  if (r.unpriced.length > 0) return { unpriced: r.unpriced, estimateNumber: r.number }
  return { handoff: { estimateId: r.estimateId, number: r.number, selectedOptions } }
}

// ─── The screen ──────────────────────────────────────────────────────────────

export function ShowCustomerScreen(props: {
  quote: QuoteState
  /** Issue (or revise) the quote and refresh it — the same call as the green button on the Quote screen. */
  issue: () => Promise<{ estimateId: string; number: string; unpriced: string[] }>
  /**
   * Hand the customer on to signing, with what they ticked. Omitted where the app has no signing
   * screen to open: "Sign now" is then greyed WITH that reason, never hidden.
   */
  onSignInPerson?: (handoff: SignHandoff) => void
  /** The reason issuing would be refused (AI proposals or open questions waiting), or null. */
  issueBlockedReason: string | null
  onBack: () => void
  /** What starts ticked, for a render that is not the first look (tests). Defaults to the shared rule. */
  initialSelection?: readonly string[]
}) {
  const { quote, issue, onSignInPerson, issueBlockedReason, onBack, initialSelection } = props
  const m = quote.money
  const options = customerOptions(quote)
  const exclusive = picksOne(m)
  // null = the customer has not touched a tick: the shared default (everything, or the first option
  // in one-or-the-other mode). An empty array is a real choice — nothing ticked.
  const [picked, setPicked] = useState<readonly string[] | null>(initialSelection ?? null)
  const ticked: EstimateOptionLetter[] =
    picked === null
      ? defaultSelection(m)
      : (m.pickable.filter((o) => picked.includes(o)) as EstimateOptionLetter[])
  const [busy, setBusy] = useState(false)
  const [problems, setProblems] = useState<string[]>([])
  const [zeroWarned, setZeroWarned] = useState(false)

  const price = selectionPrice(m, ticked)
  const decision = presentDecision(quote.lifecycle)
  const greyed = signNowGreyedReason({ decision, ticked, issueBlockedReason, canSign: Boolean(onSignInPerson) })

  const sign = () => {
    if (!onSignInPerson) return
    setBusy(true)
    setProblems([])
    runSignNow({ decision, selectedOptions: ticked, issue })
      .then((r) => {
        if ('unpriced' in r) {
          // Said in the technician's strip, not under the homeowner's thumb; the override is the
          // technician's button there too.
          setZeroWarned(true)
          setProblems([
            `⚠ ${r.unpriced.length} line(s) had no price and were counted as $0, so estimate ${r.estimateNumber} is CHEAPER THAN THE WORK: ${r.unpriced.join('; ')}. ` +
              'Go back to the quote and price them, or press "Sign anyway" here to go on.',
          ])
          return
        }
        onSignInPerson(r.handoff)
      })
      .catch((err) => {
        // The engine's refusal reasons arrive on a 409 and are shown verbatim.
        const body = (err as { body?: { reasons?: string[] } }).body
        setProblems(body?.reasons?.length ? body.reasons : [err instanceof Error ? err.message : String(err)])
      })
      .finally(() => setBusy(false))
  }

  return (
    <div className="min-h-screen bg-slate-100 text-slate-900">
      {/* The technician's strip. Everything below it is for the customer; everything addressed to
          the technician is in here, and it stays on screen while the page scrolls. */}
      <div className="sticky top-0 z-20 bg-slate-900 p-3" data-testid="tech-strip">
        <button type="button" onClick={onBack} className="min-h-[2.5rem] text-sm font-medium text-sky-300 underline">
          ← Back to the quote
        </button>
        <p className="mt-1 text-xs text-slate-300" data-testid="tech-note">
          {greyed ?? signFooter(decision)}
        </p>
        {ticked.length > 0 && price === null && (
          <p className="mt-1 text-xs text-amber-300">Part of this is not priced yet — go back to the quote and price it.</p>
        )}
        {problems.length > 0 && (
          <ul className="mt-1 space-y-1">
            {problems.map((p, i) => (
              <li key={i} role="alert" className="rounded bg-amber-100 p-2 text-xs text-amber-900">{p}</li>
            ))}
          </ul>
        )}
        {zeroWarned && onSignInPerson && (
          <button
            type="button"
            disabled={busy || greyed !== null || price === null}
            onClick={sign}
            className="mt-2 min-h-[2.5rem] rounded-lg bg-amber-500 px-4 text-sm font-bold text-slate-900 disabled:opacity-40"
          >
            Sign anyway
          </button>
        )}
      </div>

      <div className="mx-auto max-w-xl space-y-4 p-4 pb-6">
        <header>
          <h1 className="text-3xl font-bold leading-tight">{quote.title}</h1>
          {quote.jobDescription && <p className="mt-2 text-lg text-slate-700">{quote.jobDescription}</p>}
        </header>

        {exclusive && (
          <p className="rounded-lg bg-sky-100 p-3 text-lg font-medium text-sky-900">
            Pick the ONE option you want.
          </p>
        )}
        {!exclusive && options.length > 1 && (
          <p className="text-base text-slate-600">Tick the work you want done. The total below follows what is ticked.</p>
        )}

        {options.map((o) => {
          const on = ticked.includes(o.option)
          return (
            <section
              key={o.option}
              aria-label={`Option ${o.option}`}
              className={`rounded-xl border-2 bg-white shadow-sm ${on ? 'border-sky-600' : 'border-slate-300 opacity-70'}`}
            >
              <label className="flex cursor-pointer items-start gap-4 p-4">
                <input
                  type={exclusive ? 'radio' : 'checkbox'}
                  name={exclusive ? 'show-optchoice' : undefined}
                  className="mt-1 h-8 w-8 shrink-0"
                  checked={on}
                  onChange={() => setPicked(toggleSelection(m, ticked, o.option))}
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-2xl font-bold">Option {o.option}</span>
                  {o.name && <span className="block text-xl font-semibold text-slate-800">{o.name}</span>}
                  {o.description && <span className="mt-1 block text-lg text-slate-700">{o.description}</span>}
                </span>
                <span className="shrink-0 text-right text-2xl font-bold">
                  {o.price === null ? <span className="text-base font-medium text-amber-700">not priced yet</span> : money(o.price)}
                </span>
              </label>
              <ul className="divide-y divide-slate-200 border-t border-slate-200">
                {o.lines.map((l, i) => (
                  <li key={i} className="px-4 py-3 text-lg">
                    {l.description}
                    {l.quantity !== 1 && <span className="ml-2 text-slate-600">× {l.quantity}</span>}
                  </li>
                ))}
              </ul>
            </section>
          )
        })}
      </div>

      {/* The total stays on screen while the customer reads and ticks. */}
      <div className="sticky bottom-0 z-10 border-t-2 border-slate-300 bg-white p-4 shadow-[0_-4px_12px_rgba(0,0,0,0.12)]">
        <div className="mx-auto max-w-xl space-y-2">
          <div className="flex items-end justify-between gap-3">
            <div className="text-base text-slate-600">
              {ticked.length === 0 ? 'Nothing selected' : `Option${ticked.length > 1 ? 's' : ''} ${ticked.join(' + ')}`}
              {(price?.trip ?? 0) > 0 && <span className="block text-sm">includes {money(price?.trip)} trip and job setup</span>}
            </div>
            <div className="text-right">
              {(price?.comboSaving ?? 0) > 0 && (
                <div className="text-base font-semibold text-green-700">multi-option discount −{money(price?.comboSaving)}</div>
              )}
              {(price?.discount ?? 0) > 0 && (
                <div className="text-base font-semibold text-green-700">
                  {m.discount?.label ?? 'Discount'} −{money(price?.discount)}
                </div>
              )}
              <div className="text-sm text-slate-600">Total</div>
              <div className="text-4xl font-bold" aria-label="Total">{money(price?.total ?? null)}</div>
              {/* "or from $X/mo with financing" (Phase 5 unit B, 2026-10-08): the SERVER's figures for
                  what is ticked (money.financing); pressing it opens the four Synchrony plan cards,
                  each with its disclosure. Nothing here records a choice. */}
              <FinancingLine
                financing={m.financing}
                selected={ticked}
                label={`Option${ticked.length > 1 ? 's' : ''} ${ticked.join(' + ')}`}
                total={price?.total ?? null}
              />
            </div>
          </div>
          {ticked.length > 0 && price === null && (
            <p className="text-sm text-slate-600">There is no total to show for this yet.</p>
          )}

          {/* Greyed WITH the reason - the reason is in the technician's strip at the top of this
              same screen (a tooltip does not exist on a phone), never as text the homeowner is
              told to act on. While the "no price" warning is open the customer's button stays
              off: pressing past it is the technician's call, from the strip. */}
          <button
            type="button"
            disabled={busy || greyed !== null || price === null || zeroWarned}
            onClick={sign}
            className="min-h-[3.5rem] w-full rounded-xl bg-emerald-700 p-3 text-xl font-bold text-white disabled:opacity-40"
          >
            {busy ? 'Preparing…' : 'Sign now'}
          </button>
        </div>
      </div>
    </div>
  )
}
