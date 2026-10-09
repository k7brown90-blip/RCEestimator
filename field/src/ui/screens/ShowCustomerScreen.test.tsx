/**
 * "Show the customer" (Phase 3 unit B, 2026-10-08): the screen the technician hands to the homeowner.
 * Rendered to static markup (the field suite runs in node with no DOM) and read the way the customer
 * reads it, plus the pure rules behind each tap.
 *
 * What these pin:
 *   - NO labour hours / dollars / cost / margin / Synchrony keys reach the page, even when the quote
 *     payload is laced with them (the tech hands the phone over);
 *   - the total, the discount and the combined-options saving are the SERVER's figures, looked up in
 *     `money.selections` — a tick changes which row is read, nothing is added on the phone;
 *   - one-or-the-other mode is radios, first option ticked, a tap on the chosen one is a no-op;
 *   - "Sign now" issues first only when the shared issue-or-reuse rule says so, and is greyed WITH
 *     its reason otherwise.
 */

import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  ShowCustomerScreen,
  customerOptions,
  runSignNow,
  showCustomerReason,
  signFooter,
  signNowGreyedReason,
} from './ShowCustomerScreen'
import type { QuoteState } from '../../lib/crmSync'
import type { DraftLifecycle } from '../../../../shared/draftLifecycle'
import type { EstimateOptionLetter } from '../../../../shared/estimateOptions'
import type { SelectionPrice, QuoteMoney } from '../../../../shared/quoteMoney'
import { defaultSelection, selectionPrice, toggleSelection } from '../../../../shared/quoteMoney'
import { presentDecision } from '../../../../shared/presentIssue'
import { buildQuoteFinancing, type FinancingPlan } from '../../../../shared/financing'
import { financingOffersFor, monthlyLabel } from '../../../../shared/financingDisplay'
import { DEFAULT_FINANCING_PLANS } from '../../../../src/services/financingPlanDefaults'
import { PlanCard } from '../components/FinancingSheet'

// ─── fixtures ────────────────────────────────────────────────────────────────

const sel = (key: string, over: Partial<SelectionPrice>): SelectionPrice => ({
  key, options: key.split('+') as SelectionPrice['options'], subtotal: 0, trip: 0, comboSaving: 0, base: 0, discount: 0, discountCapped: false, total: 0, ...over,
})

/** Option A $1,000.00, option B $500.00; together the server saves $20 on material and takes 5% off the rest. */
const money = (over: Partial<QuoteMoney> = {}): QuoteMoney => ({
  exclusiveOptions: false,
  range: null,
  discount: {
    type: 'military', percent: 5, label: 'Military discount (5%)', terms: '5% off, capped at $250', pricedOnceComplete: false, rows: [],
  },
  discountedTotal: null,
  discountedRange: null,
  pickable: ['A', 'B'],
  selections: {
    A: sel('A', { subtotal: 1000, trip: 0, base: 1000, discount: 50, total: 950 }),
    B: sel('B', { subtotal: 500, base: 500, discount: 25, total: 475 }),
    'A+B': sel('A+B', { subtotal: 1500, comboSaving: 20, base: 1480, discount: 74, total: 1406 }),
  },
  ...over,
})

const lifecycle = (over: Partial<DraftLifecycle> = {}): DraftLifecycle => ({
  status: 'draft', issued: null, hasUnsavedChanges: false, reviseReason: null, deleteReason: null, copyReason: null, ...over,
})
const issuedLifecycle = (over: Partial<DraftLifecycle> = {}, issued: Partial<NonNullable<DraftLifecycle['issued']>> = {}): DraftLifecycle =>
  lifecycle({
    status: 'finalized',
    issued: { estimateId: 'est-1', number: '2026-1098', revision: 1, status: 'sent', signedAt: null, archived: false, customerUrl: null, ...issued },
    ...over,
  })

const quote = (over: Record<string, unknown> = {}): QuoteState =>
  ({
    draftId: 'd1',
    title: 'Panel upgrade and new circuits',
    jobDescription: 'Replace the 100A panel and add the garage circuits.',
    lifecycle: lifecycle(),
    suggestedLines: [],
    openQuestions: [],
    isChangeOrder: false,
    changeOrderFor: null,
    lines: [
      { id: 'l1', itemId: 'i1', description: 'Replace main panel', quantity: 1, option: 'A', location: 'Garage', note: 'Assessment finding: double-tapped breaker', lineTotal: 1000, gaps: [] },
      { id: 'l2', itemId: 'i2', description: 'Install 20A outlet', quantity: 3, option: 'B', location: null, note: null, lineTotal: 500, gaps: [] },
      { id: 'l3', itemId: 'i3', description: 'AI suggested thing', quantity: 1, option: 'B', state: 'PROPOSED', location: null, note: null, lineTotal: null, gaps: [] },
    ],
    optionSet: {
      options: [
        { option: 'A', label: 'Panel', note: 'The panel itself', lineCount: 1, removable: false },
        { option: 'B', label: null, note: null, lineCount: 2, removable: false },
        { option: 'C', label: null, note: null, lineCount: 0, removable: false },
      ],
      nextOption: 'D',
      lockedReason: null,
    },
    options: [
      { option: 'A', lineCount: 1, subtotal: 1000, complete: true },
      { option: 'B', lineCount: 1, subtotal: 500, complete: true },
    ],
    money: money(),
    total: 1500,
    rateProvisional: false,
    ...over,
  }) as unknown as QuoteState

const render = (q: QuoteState, extra: Partial<Parameters<typeof ShowCustomerScreen>[0]> = {}) =>
  renderToStaticMarkup(
    <ShowCustomerScreen quote={q} issue={async () => ({ estimateId: 'e', number: 'n', unpriced: [] })} issueBlockedReason={null} onBack={() => {}} onSignInPerson={() => {}} {...extra} />,
  )

const totalOf = (html: string) => /aria-label="Total">([^<]*)</.exec(html)?.[1]

// ─── what the customer reads ─────────────────────────────────────────────────

describe('ShowCustomerScreen — the customer view', () => {
  it('shows the title, the scope, each option with its name, description and price, and its lines', () => {
    const html = render(quote())
    expect(html).toContain('Panel upgrade and new circuits')
    expect(html).toContain('Replace the 100A panel and add the garage circuits.')
    expect(html).toContain('Option A')
    expect(html).toContain('Panel') // the option's name
    expect(html).toContain('The panel itself') // its description
    expect(html).toContain('$1000.00')
    expect(html).toContain('$500.00')
    expect(html).toContain('Replace main panel')
    expect(html).toContain('Install 20A outlet')
    expect(html).toContain('× 3') // quantity past 1
    // A line's location is draft-only text: the estimate the customer signs does not print it, so
    // neither does this screen (review finding, 2026-10-08).
    expect(html).not.toContain('Garage')
  })

  it('the option price is looked up in the SAME server table as the total, not the Quote screen\'s own figure', () => {
    const q = quote({
      options: [
        { option: 'A', lineCount: 1, subtotal: 9999.99, complete: true },
        { option: 'B', lineCount: 1, subtotal: 8888.88, complete: true },
      ],
    })
    const html = render(q)
    expect(html).toContain('$1000.00')
    expect(html).toContain('$500.00')
    expect(html).not.toContain('9999.99')
    expect(html).not.toContain('8888.88')
  })

  it('EVERY message addressed to the technician is in the dark strip - none reaches the customer\'s part of the page', () => {
    const tech = (html: string) => /data-testid="tech-strip">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? ''
    const customerPart = (html: string) => html.replace(/<div class="sticky top-0[^>]*data-testid="tech-strip">[\s\S]*?<\/div>/, '')
    // The footer: what pressing Sign now records.
    const first = render(quote())
    expect(tech(first)).toContain('freezes its prices')
    expect(customerPart(first)).not.toContain('freezes its prices')
    // A revision: the customer's link is replaced - tech business.
    const edited = render(quote({ lifecycle: issuedLifecycle({ status: 'draft', hasUnsavedChanges: true }) }))
    expect(tech(edited)).toMatch(/revision 2/)
    expect(customerPart(edited)).not.toMatch(/revision|replaces the customer/)
    // Nothing ticked: the reason Sign now is greyed.
    const none = render(quote(), { initialSelection: [] })
    expect(tech(none)).toContain('Tick at least one option')
    expect(customerPart(none)).not.toContain('Tick at least one option')
    // An unpriced option: the instruction to go price it.
    const unpriced = render(quote({ money: money({ selections: {} }) }))
    expect(tech(unpriced)).toMatch(/go back to the quote and price it/i)
    expect(customerPart(unpriced)).not.toMatch(/go back|price it|CHEAPER|Sign anyway/i)
  })

  it('has the technician\'s way out, "Back to the quote", and nothing else editable but the ticks', () => {
    const html = render(quote())
    expect(html).toContain('Back to the quote')
    expect(html).not.toContain('<input type="number"')
    expect(html).not.toContain('<select')
    expect(html).not.toContain('<textarea')
    expect(html).not.toContain('type="text"')
    // The only inputs are the option ticks.
    expect((html.match(/<input/g) ?? []).length).toBe(2)
  })

  it('does not show an empty option, an AI-proposed line nobody confirmed, or a line note', () => {
    const html = render(quote())
    expect(html).not.toContain('Option C')
    expect(html).not.toContain('AI suggested thing')
    expect(html).not.toContain('double-tapped breaker')
  })

  it('NO labour, cost, margin or Synchrony key reaches the page, even if the payload carries them', () => {
    const laced = quote({
      lines: [
        { id: 'l1', itemId: 'i1', description: 'Replace main panel', quantity: 1, option: 'A', location: null, note: null, lineTotal: 1000, gaps: [],
          laborHours: 7.25, laborDollars: 8123.45, materialCost: 321.99, companyCost: 654.32, margin: 0.4123, synchronyRate: 17.99 },
      ],
      options: [{ option: 'A', lineCount: 1, subtotal: 1000, complete: true, laborDollars: 8123.45, materialSell: 700.01 }],
      laborHours: 7.25,
      materialCost: 321.99,
    })
    const html = render(laced)
    for (const needle of ['7.25', '8123.45', '321.99', '654.32', '0.4123', '17.99', '700.01']) expect(html).not.toContain(needle)
    for (const word of [/labou?r/i, /\bcost\b/i, /margin/i, /synchrony/i, /\bprofit\b/i, /\bhours?\b/i, /\bhr\b/i]) expect(html).not.toMatch(word)
  })

  it('customerOptions copies named fields only (a key added to the payload later cannot leak)', () => {
    const [a] = customerOptions(
      quote({
        lines: [{ id: 'l1', itemId: 'i1', description: 'Replace main panel', quantity: 1, option: 'A', location: null, note: 'x', lineTotal: 1000, gaps: [], laborHours: 9, materialCost: 4 }],
        options: [{ option: 'A', lineCount: 1, subtotal: 1000, complete: true, laborDollars: 5 }],
      }),
    )
    expect(Object.keys(a).sort()).toEqual(['description', 'lines', 'name', 'option', 'price'])
    expect(Object.keys(a.lines[0]).sort()).toEqual(['description', 'quantity'])
  })
})

// ─── ticks, total, discount: all from the server's table ─────────────────────

describe('ShowCustomerScreen — ticks and the total', () => {
  it('starts with everything ticked and reads the combined row of the server\'s table', () => {
    const html = render(quote())
    expect((html.match(/checked=""/g) ?? []).length).toBe(2)
    expect(html).toContain('Options A + B')
    expect(totalOf(html)).toBe('$1406.00') // selections["A+B"].total — not 1000 + 500
    expect(html).toContain('multi-option discount −$20.00')
    expect(html).toContain('Military discount (5%) −$74.00')
  })

  it('unticking an option reads the other row: A alone is the server\'s $950.00 with its own discount', () => {
    const html = render(quote(), { initialSelection: ['A'] })
    expect(html).toContain('Option A')
    expect(totalOf(html)).toBe('$950.00')
    expect(html).toContain('Military discount (5%) −$50.00')
    expect(html).not.toContain('multi-option discount')
    expect((html.match(/checked=""/g) ?? []).length).toBe(1)
    expect(totalOf(render(quote(), { initialSelection: ['B'] }))).toBe('$475.00')
  })

  it('nothing ticked shows "Nothing selected" and no total, never $0.00', () => {
    const html = render(quote(), { initialSelection: [] })
    expect(html).toContain('Nothing selected')
    expect(totalOf(html)).toBe('—')
    expect(html).not.toContain('$0.00')
  })

  it('a ticked option with an unpriced line gives no total and says why', () => {
    const q = quote({
      money: money({ selections: { B: sel('B', { subtotal: 500, base: 500, discount: 25, total: 475 }) } }),
      options: [
        { option: 'A', lineCount: 1, subtotal: null, complete: false },
        { option: 'B', lineCount: 1, subtotal: 500, complete: true },
      ],
    })
    const html = render(q)
    expect(html).toContain('not priced yet')
    expect(totalOf(html)).toBe('—')
    // The customer is told neutrally; the instruction to go price it is the technician's, in the strip.
    expect(html).toContain('There is no total to show for this yet.')
    expect(html).toMatch(/data-testid="tech-strip"[\s\S]*go back to the quote and price it/i)
    // Sign now is off while there is no number to sign.
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Sign now</)
  })

  it('shows the trip once, from the server\'s figure', () => {
    const q = quote({ money: money({ selections: { A: sel('A', { subtotal: 1000, trip: 85, base: 1085, total: 1085 }), B: sel('B', { subtotal: 500, trip: 85, base: 585, total: 585 }), 'A+B': sel('A+B', { subtotal: 1500, trip: 85, base: 1585, total: 1585 }) }, discount: null }) })
    const html = render(q)
    expect(html).toContain('includes $85.00 trip and job setup')
    expect(totalOf(html)).toBe('$1585.00')
    expect(html).not.toContain('Military')
  })
})

describe('one-or-the-other mode', () => {
  const exclusive = () => quote({ money: money({ exclusiveOptions: true }) })

  it('renders radios, starts on the FIRST option only, and shows that option\'s row', () => {
    const html = render(exclusive())
    expect(html).toContain('type="radio"')
    expect(html).not.toContain('type="checkbox"')
    expect((html.match(/checked=""/g) ?? []).length).toBe(1)
    expect(html).toContain('Pick the ONE option you want')
    expect(totalOf(html)).toBe('$950.00')
  })

  it('picking the other option reads its row', () => {
    expect(totalOf(render(exclusive(), { initialSelection: ['B'] }))).toBe('$475.00')
  })

  it('without the mode there are checkboxes', () => {
    const html = render(quote())
    expect(html).toContain('type="checkbox"')
    expect(html).not.toContain('type="radio"')
  })
})

describe('toggleSelection — what a tap does (shared)', () => {
  const add = { exclusiveOptions: false, pickable: ['A', 'B', 'C'] as EstimateOptionLetter[] }
  const one = { exclusiveOptions: true, pickable: ['A', 'B', 'C'] as EstimateOptionLetter[] }

  it('add-on mode flips the option and keeps letter order', () => {
    expect(toggleSelection(add, ['A', 'B', 'C'], 'B')).toEqual(['A', 'C'])
    expect(toggleSelection(add, ['A', 'C'], 'B')).toEqual(['A', 'B', 'C'])
    expect(toggleSelection(add, ['A'], 'A')).toEqual([]) // may untick everything
  })

  it('one-or-the-other behaves like a radio: a pick replaces, a tap on the chosen one is a no-op', () => {
    expect(toggleSelection(one, ['A'], 'C')).toEqual(['C'])
    expect(toggleSelection(one, ['C'], 'C')).toEqual(['C'])
  })

  it('an option that holds no work is ignored', () => {
    expect(toggleSelection(add, ['A'], 'H')).toEqual(['A'])
    expect(toggleSelection(one, ['B'], 'H')).toEqual(['B'])
  })

  it('with a single option "one-or-the-other" is not a choice at all: it stays an ordinary tick', () => {
    const lone = { exclusiveOptions: true, pickable: ['A'] as EstimateOptionLetter[] }
    expect(toggleSelection(lone, ['A'], 'A')).toEqual([])
  })

  it('every tick maps to the table the server sent, never to a sum', () => {
    const m = money()
    expect(selectionPrice(m, toggleSelection(m, defaultSelection(m), 'B'))?.total).toBe(950)
    expect(selectionPrice(m, defaultSelection(m))?.total).toBe(1406)
  })
})

// ─── Show the customer button's gate ─────────────────────────────────────────

describe('showCustomerReason — greyed with the reason', () => {
  it('is live when something is priced, before AND after issue', () => {
    expect(showCustomerReason(quote())).toBeNull()
    expect(showCustomerReason(quote({ lifecycle: issuedLifecycle() }))).toBeNull()
    expect(showCustomerReason(quote({ lifecycle: issuedLifecycle({}, { signedAt: '2026-10-08T12:00:00Z' }) }))).toBeNull()
  })
  it('says why when there is nothing to show', () => {
    expect(showCustomerReason(null)).toMatch(/loading/)
    expect(showCustomerReason(quote({ lines: [] }))).toMatch(/Add some work/)
    expect(showCustomerReason(quote({ money: money({ pickable: [] }) }))).toMatch(/waiting on you/)
    expect(showCustomerReason(quote({ money: money({ selections: {} }) }))).toMatch(/Nothing is priced yet/)
  })
})

// ─── Sign now ────────────────────────────────────────────────────────────────

describe('Sign now — greyed with its reason', () => {
  const live = (over: Partial<Parameters<typeof signNowGreyedReason>[0]> = {}) =>
    signNowGreyedReason({ decision: presentDecision(lifecycle()), ticked: ['A'], issueBlockedReason: null, canSign: true, ...over })

  it('is live for a fresh quote with something ticked', () => {
    expect(live()).toBeNull()
  })
  it('nothing ticked', () => expect(live({ ticked: [] })).toMatch(/Tick at least one option/))
  it('already signed: nothing to sign', () => {
    expect(live({ decision: presentDecision(issuedLifecycle({}, { signedAt: '2026-10-08T12:00:00Z' })) })).toMatch(/already signed/)
  })
  it('lost: the "reopen it first" words', () => {
    expect(live({ decision: presentDecision(issuedLifecycle({ reviseReason: 'Estimate 2026-1098 is marked lost — reopen it before changing or issuing it again.' }, { status: 'lost' })) })).toMatch(/reopen it/)
  })
  it('AI proposals / open questions block an issue, in the server\'s words — but not a reuse', () => {
    const why = '2 AI-suggested lines are waiting to be confirmed or rejected.'
    expect(live({ issueBlockedReason: why })).toBe(why)
    expect(live({ issueBlockedReason: why, decision: presentDecision(issuedLifecycle()) })).toBeNull()
  })
  it('no signing screen in this build: greyed with that said, not hidden', () => {
    expect(live({ canSign: false })).toMatch(/not available yet/)
    const html = render(quote(), { onSignInPerson: undefined })
    expect(html).toContain('Sign now')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Sign now</)
    expect(html).toContain('Signing on this phone is not available yet.')
  })
  it('the button is live and the footer says what pressing records', () => {
    const html = render(quote())
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Sign now</)
    expect(html).toContain('records the estimate and freezes its prices')
  })
})

describe('signFooter', () => {
  it('words each decision', () => {
    expect(signFooter(presentDecision(lifecycle()))).toMatch(/freezes its prices/)
    expect(signFooter(presentDecision(issuedLifecycle({ status: 'draft', hasUnsavedChanges: true })))).toMatch(/revision 2 \(same number\)/)
    expect(signFooter(presentDecision(issuedLifecycle()))).toMatch(/nothing has changed since/)
  })
})

describe('runSignNow — issue first only when the shared rule says so', () => {
  const issue = () => vi.fn(async () => ({ estimateId: 'new-est', number: '2026-2000', unpriced: [] as string[] }))

  it('nothing recorded yet: issues once, then hands off with the ticked options', async () => {
    const f = issue()
    const r = await runSignNow({ decision: presentDecision(lifecycle()), selectedOptions: ['A', 'B'], issue: f })
    expect(f).toHaveBeenCalledTimes(1)
    expect(r).toEqual({ handoff: { estimateId: 'new-est', number: '2026-2000', selectedOptions: ['A', 'B'] } })
  })

  it('edited since it was issued: issues again (a revision)', async () => {
    const f = issue()
    await runSignNow({ decision: presentDecision(issuedLifecycle({ status: 'draft', hasUnsavedChanges: true })), selectedOptions: ['A'], issue: f })
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('issued and unchanged: NOT issued again — the estimate that exists is used, whatever number of presses', async () => {
    const f = issue()
    const d = presentDecision(issuedLifecycle())
    const r = await runSignNow({ decision: d, selectedOptions: ['A'], issue: f })
    await runSignNow({ decision: d, selectedOptions: ['A'], issue: f })
    expect(f).not.toHaveBeenCalled()
    expect(r).toEqual({ handoff: { estimateId: 'est-1', number: '2026-1098', selectedOptions: ['A'] } })
  })

  it('lines that froze at $0: returns the warning and does NOT hand off', async () => {
    const f = vi.fn(async () => ({ estimateId: 'e', number: '2026-2001', unpriced: ['item-9 — no material price'] }))
    const r = await runSignNow({ decision: presentDecision(lifecycle()), selectedOptions: ['A'], issue: f })
    expect(r).toEqual({ unpriced: ['item-9 — no material price'], estimateNumber: '2026-2001' })
  })

  it('a lost estimate is refused with its reason, nothing is issued', async () => {
    const f = issue()
    await expect(
      runSignNow({ decision: presentDecision(issuedLifecycle({ reviseReason: 'marked lost — reopen it first' }, { status: 'lost' })), selectedOptions: ['A'], issue: f }),
    ).rejects.toThrow(/lost|reopen/)
    expect(f).not.toHaveBeenCalled()
  })

  it('the server\'s refusal passes through for the screen to print', async () => {
    const err = Object.assign(new Error('refused'), { body: { reasons: ['Item 4 has no price'] } })
    await expect(runSignNow({ decision: presentDecision(lifecycle()), selectedOptions: ['A'], issue: async () => { throw err } })).rejects.toBe(err)
  })
})

// ─── financing (Phase 5 unit B, 2026-10-08) ──────────────────────────────────

/*
  "or from $X/mo with financing" under the total, and the four Synchrony plan cards behind it. The phone
  looks the ticked selection up in the server's `money.financing` and prints it - the same words and
  lookups as the CRM and the customer's page (shared/financingDisplay.ts). The field suite renders to
  static markup (no DOM), so the closed screen is read as the customer sees it at first, and the cards
  are rendered through the same component the open sheet uses.
*/
describe('ShowCustomerScreen — financing under the total', () => {
  const PLANS = DEFAULT_FINANCING_PLANS as FinancingPlan[]
  const FIN = buildQuoteFinancing(PLANS, { A: 950, B: 475, 'A+B': 1406 })!
  const RATE_TOKEN = /(?<![\d.])(6\.1|7\.25|7\.1|10\.6)(?![\d])/
  const fromOf = (key: string) => `or from $${FIN.bySelection[key].fromMonthly}/mo with financing`

  it('shows the headline for what is ticked, below the total, as a button', () => {
    const html = render(quote({ money: money({ financing: FIN }) }))
    expect(html).toContain(fromOf('A+B'))
    expect(html.indexOf('aria-label="Total"')).toBeLessThan(html.indexOf(fromOf('A+B')))
    // It is a button (one tap opens the cards) - not just text.
    const at = html.indexOf(`>${fromOf('A+B')}</button>`)
    expect(at).toBeGreaterThan(0)
    expect(html.slice(html.lastIndexOf('<button', at), at)).toContain('aria-haspopup="dialog"')
  })

  it('follows the tick: one option ticked looks that selection up', () => {
    const html = render(quote({ money: money({ financing: FIN }) }), { initialSelection: ['A'] })
    expect(html).toContain(fromOf('A'))
    expect(html).not.toContain(fromOf('A+B'))
  })

  it('shows no line when no plan is on offer, nothing is ticked, or the selection has no figures - never "$0/mo"', () => {
    expect(render(quote())).not.toContain('with financing')
    expect(render(quote({ money: money({ financing: FIN }) }), { initialSelection: [] })).not.toContain('with financing')
    expect(render(quote({ money: money({ financing: { ...FIN, bySelection: {} } }) }))).not.toContain('with financing')
  })

  it('the plan card: Synchrony\'s label, term, deposit / fee / financed and its OWN disclosure verbatim', () => {
    for (const offer of financingOffersFor(FIN, ['A'])!.offers) {
      const html = renderToStaticMarkup(<PlanCard offer={offer} />)
      const plan = PLANS.find((p) => p.planNumber === offer.planNumber)!
      expect(html).toContain(`Plan ${offer.planNumber}`)
      expect(html).toContain(monthlyLabel(offer.type))
      expect(html).toContain(`$${offer.monthly}/mo`)
      expect(html).toContain('Deposit (one third, paid up front)')
      expect(html).toContain(`Financing fee \u2014 Plan ${offer.planNumber}`)
      expect(html).toContain('Amount financed')
      // The markup HTML-escapes apostrophes and such; compare against the escaped form React writes.
      for (const part of [plan.disclosure.explanation, plan.disclosure.important, plan.disclosure.terms]) {
        expect(html).toContain(part.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;'))
      }
    }
  })

  it('the cards come in Kyle\'s order and no rate or total-with-interest appears anywhere on the screen', () => {
    const offers = financingOffersFor(FIN, ['A'])!.offers
    expect(offers.map((o) => o.planNumber)).toEqual(['965', '964', '920', '924'])
    const html = render(quote({ money: money({ financing: FIN }) })) + offers.map((o) => renderToStaticMarkup(<PlanCard offer={o} />)).join('')
    expect(html).not.toMatch(/discount ?rate/i)
    expect(html).not.toMatch(RATE_TOKEN)
    expect(html).not.toMatch(/total payments? with interest/i)
  })

  it('opening the cards needs no signing and issues nothing: the headline is not "Sign now"', () => {
    const html = render(quote({ money: money({ financing: FIN }) }))
    expect(html).toContain('Sign now')
    expect(html.match(/with financing/g)).toHaveLength(1)
  })
})
