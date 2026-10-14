/**
 * The field Quote screen's estimate-level controls (2026-10-08, one-estimating-system plan, Phase 2,
 * unit A): "Adding into", "One-or-the-other options" + "Copy lines", and the totals with the
 * "Discount" block. Rendered to static markup (the field suite runs in node with no DOM) and read the
 * way a tech reads the screen: what is on it, what is greyed, and what the reason says.
 *
 * Every figure below is a number the SERVER sent in `quote.money`; the components print it. A test
 * that fed them a discount of $13.50 and saw "$13.50" is the point — they do no arithmetic.
 */

import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { AddingIntoBar, OptionModeAndCopy, QuoteTotals } from './QuoteSettings'
import { COPY_SAME_REASON, copiedNotice, copyEmptyReason, customPercentLooksValid } from '../../lib/quoteOptions'
import type { QuoteState } from '../../lib/crmSync'
import type { DraftOptionEntry, EstimateOptionLetter } from '../../../../shared/estimateOptions'
import type { QuoteMoney, SelectionPrice } from '../../../../shared/quoteMoney'
import { buildQuoteFinancing, type FinancingPlan } from '../../../../shared/financing'
import { DEFAULT_FINANCING_PLANS } from '../../../../src/services/financingPlanDefaults'

const entry = (option: EstimateOptionLetter, lineCount = 0, label: string | null = null): DraftOptionEntry => ({
  option, label, note: null, lineCount, removable: !['A', 'B', 'C'].includes(option),
})

const SIGNED = 'Estimate 2026-1098 from this draft is SIGNED. A signed agreement is never edited — raise a change order instead.'

const noMoney: QuoteMoney = { exclusiveOptions: false, range: null, discount: null, discountedTotal: null, discountedRange: null, pickable: ['A'], selections: {} }

const military: QuoteMoney = {
  ...noMoney,
  discount: {
    type: 'military', percent: 5, label: 'Military discount (5%)', terms: '5% off, capped at $250', pricedOnceComplete: false,
    rows: [{ label: 'Option A', base: 270, comboSaving: 0, amount: 13.5, capped: false, after: 256.5 }],
  },
  discountedTotal: 256.5,
}

const noop = async () => {}

describe('AddingIntoBar', () => {
  const options = [entry('A', 1), entry('B'), entry('C'), entry('D', 0, 'Whole-house rewire')]

  it('labels the row "Adding into", has a thumb-sized button per option, and marks the active one', () => {
    const html = renderToStaticMarkup(<AddingIntoBar options={options} active="D" onSelect={() => {}} lockedReason={null} />)
    expect(html).toContain('Adding into')
    for (const o of ['A', 'B', 'C', 'D']) expect(html).toContain(`Option ${o}`)
    expect(html).toMatch(/aria-pressed="true"[^>]*>Option D</)
    expect(html).toMatch(/aria-pressed="false"[^>]*>Option A</)
    expect(html).toContain('min-h-[2.5rem]')
    // The active option's name and meaning, so the tech sees where the next item goes.
    expect(html).toContain('Whole-house rewire')
  })

  it('a SIGNED quote greys every option button and the reason is each one\'s tooltip', () => {
    const html = renderToStaticMarkup(<AddingIntoBar options={options} active="A" onSelect={() => {}} lockedReason={SIGNED} />)
    expect((html.match(/disabled=""/g) ?? []).length).toBe(options.length)
    expect(html).toContain(`title="${SIGNED}"`)
  })
})

describe('OptionModeAndCopy', () => {
  const quote = (over: Partial<Pick<QuoteState, 'optionSet' | 'money'>> = {}): Pick<QuoteState, 'optionSet' | 'money'> => ({
    optionSet: { options: [entry('A', 2), entry('B'), entry('C')], nextOption: 'D', lockedReason: null },
    money: noMoney,
    ...over,
  })
  const render = (q = quote(), lockedReason: string | null = null, busy = false) =>
    renderToStaticMarkup(<OptionModeAndCopy quote={q} busy={busy} lockedReason={lockedReason} onSetMode={noop} onCopy={async () => ({ copied: 0 })} />)

  it("carries the CRM's words: the checkbox and 'Copy lines'", () => {
    const html = render()
    expect(html).toContain('One-or-the-other options')
    expect(html).toContain('customer picks exactly ONE')
    expect(html).toContain('Copy lines')
    expect(html).toContain('aria-label="Copy from option"')
    expect(html).toContain('aria-label="Copy into option"')
  })

  it('the checkbox shows the mode the server sent', () => {
    expect(render(quote({ money: { ...noMoney, exclusiveOptions: true } }))).toMatch(/type="checkbox"[^>]*checked=""/)
    expect(render()).not.toMatch(/type="checkbox"[^>]*checked=""/)
  })

  it('A -> B with lines in A: Copy lines is live and says what it will do', () => {
    const html = render()
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Copy lines/)
    expect(html).toContain('Copy every line of Option A into Option B')
  })

  it('greyed WITH its reason on the page when the source option is empty', () => {
    const html = render(quote({ optionSet: { options: [entry('A'), entry('B', 1), entry('C')], nextOption: 'D', lockedReason: null } }))
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Copy lines/)
    expect(html).toContain(`${copyEmptyReason('A')}.`)
  })

  it('a SIGNED quote greys the checkbox, both boxes and Copy lines; the reason is the tooltip', () => {
    const html = render(quote(), SIGNED)
    expect((html.match(/disabled=""/g) ?? []).length).toBe(4)
    expect(html).toContain(`title="${SIGNED}"`)
  })

  it('the wording helpers match what the office prints', () => {
    expect(copiedNotice(3, 'A', 'B')).toBe('Copied 3 line(s) from Option A into Option B.')
    expect(COPY_SAME_REASON).toMatch(/two different options/)
  })
})

describe('QuoteTotals', () => {
  const render = (q: Pick<QuoteState, 'total' | 'money'>, lockedReason: string | null = null) =>
    renderToStaticMarkup(<QuoteTotals quote={q} busy={false} lockedReason={lockedReason} onSetDiscount={noop} />)

  it('shows ONE grand total and no per-option rows (the headings carry those)', () => {
    const html = render({ total: 270, money: noMoney })
    expect(html).toContain('Total')
    expect(html).toContain('$270.00')
    expect(html).not.toContain('Total (all options)')
    expect(html).not.toMatch(/Option [A-H] ·/)
  })

  it("has the office's discount controls: Military 5%, Senior 5%, Custom %, Apply", () => {
    const html = render({ total: 270, money: noMoney })
    expect(html).toContain('Discount')
    expect(html).toContain('Military 5%')
    expect(html).toContain('Senior 5%')
    expect(html).toContain('placeholder="Custom %"')
    expect(html).toContain('Apply')
    // Nothing to clear yet.
    expect(html).not.toContain('Clear')
  })

  it('prints the SERVER\'s discount dollars and the amount after it, and offers Clear', () => {
    const html = render({ total: 270, money: military })
    expect(html).toContain('Military discount (5%)')
    expect(html).toContain('−$13.50')
    expect(html).toContain('After discount')
    expect(html).toContain('$256.50')
    expect(html).toContain('5% off, capped at $250')
    expect(html).toContain('Clear')
    expect(html).toMatch(/aria-pressed="true"[^>]*>Military 5%</)
  })

  it('says when the cap bit', () => {
    const capped: QuoteMoney = {
      ...military,
      discount: { ...military.discount!, rows: [{ label: 'whole job', base: 7200, comboSaving: 0, amount: 250, capped: true, after: 6950 }] },
      discountedTotal: 6950,
    }
    const html = render({ total: 7200, money: capped })
    expect(html).toContain('(capped)')
    expect(html).toContain('−$250.00')
    expect(html).toContain('$6950.00')
  })

  it('one-or-the-other: the headline is the server\'s min-max range, with the discount per option', () => {
    const exclusive: QuoteMoney = {
      exclusiveOptions: true,
      pickable: ['A', 'B'],
      range: { min: 70, max: 210 },
      discount: {
        type: 'custom', percent: 10, label: 'Discount (10%)', terms: '10% off, no cap', pricedOnceComplete: false,
        rows: [
          { label: 'Option A', base: 270, comboSaving: 0, amount: 27, capped: false, after: 243 },
          { label: 'Option B', base: 410, comboSaving: 0, amount: 41, capped: false, after: 369 },
        ],
      },
      discountedTotal: null,
      discountedRange: { min: 243, max: 369 },
      selections: {},
    }
    const html = render({ total: 480, money: exclusive })
    expect(html).toContain('Total — customer picks one')
    expect(html).toContain('$70.00–$210.00')
    expect(html).not.toContain('$480.00') // the grand sum of choices is the wrong number to headline
    expect(html).toContain('Discount (10%) · Option A')
    expect(html).toContain('→ $243.00')
    expect(html).toContain('$243.00–$369.00')
  })

  it('an unpriced selection says the discount waits instead of showing a guess', () => {
    const waiting: QuoteMoney = { ...military, discount: { ...military.discount!, rows: [], pricedOnceComplete: true }, discountedTotal: null }
    const html = render({ total: null, money: waiting })
    expect(html).toContain('The discount prices once every line is confirmed.')
    expect(html).not.toContain('After discount')
  })

  it('a SIGNED quote greys every discount control; the reason is the tooltip, not hidden controls', () => {
    const html = render({ total: 270, money: military }, SIGNED)
    expect(html).toContain('Military 5%')
    expect(html).toContain('Senior 5%')
    expect(html).toContain('Clear')
    // Military, Senior, the % box, Apply, Clear.
    expect((html.match(/disabled=""/g) ?? []).length).toBe(5)
    expect(html).toContain(`title="${SIGNED}"`)
  })

  it('has no money arithmetic of its own: it prints whatever amount it is handed', () => {
    // A discount the server says is $1.23 on a base it says is $999 is printed as sent.
    const odd: QuoteMoney = {
      ...military,
      discount: { ...military.discount!, rows: [{ label: 'Option A', base: 999, comboSaving: 0, amount: 1.23, capped: false, after: 5.55 }] },
      discountedTotal: 5.55,
    }
    const html = render({ total: 999, money: odd })
    expect(html).toContain('−$1.23')
    expect(html).toContain('$5.55')
  })

  it('the Apply button only needs a percentage that looks right; the server still enforces 0 < p <= 50', () => {
    expect(customPercentLooksValid('7.5')).toBe(true)
    expect(customPercentLooksValid('50')).toBe(true)
    for (const bad of ['', ' ', '0', '-3', '50.5', 'abc']) expect(customPercentLooksValid(bad)).toBe(false)
  })
})

// ─── Phase 7 U5 (2026-10-10): the totals with no signal ──────────────────────────────────────────

describe('QuoteTotals with no signal (priceSource)', () => {
  const render = (q: Pick<QuoteState, 'total' | 'money'>, extra: Partial<Parameters<typeof QuoteTotals>[0]> = {}) =>
    renderToStaticMarkup(<QuoteTotals quote={q} busy={false} lockedReason={null} onSetDiscount={noop} {...extra} />)

  it("'none': no figure, \"Priced when signal returns\" in its place, and financing waits for issue", () => {
    const html = render({ total: null, money: { ...noMoney, discount: { ...military.discount!, rows: [], pricedOnceComplete: true }, discountedTotal: null } }, { priceSource: 'none' })
    expect(html).toContain('Priced when signal returns')
    expect(html).toContain('Financing shown once the estimate is issued')
    expect(html).not.toContain('incomplete')
    expect(html).not.toContain('or from $')
    // The discount's dollars are not made up: its row says it is priced when signal returns, not "once every line is confirmed".
    expect(html).toContain('Military discount (5%): priced when signal returns')
    expect(html).not.toContain('once every line is confirmed')
  })

  it("'preview': the headline reads Preview total with when the prices were saved on this phone", () => {
    const html = render({ total: 270, money: military }, { priceSource: 'preview', priceSheetAt: '2026-10-09T13:02:00.000Z' })
    expect(html).toContain('Preview total')
    expect(html).toContain('$270.00')
    expect(html).toContain('Preview — prices saved on this phone at ')
    expect(html).toContain('The final price is set when the estimate is issued with signal.')
    expect(html).toContain('Financing shown once the estimate is issued')
    expect(html).toContain('−$13.50')
  })

  it("a discount change waiting on the phone shows as pressed — not the office's old programme — and says it is waiting", () => {
    const html = render({ total: null, money: { ...military, discountedTotal: null } }, { priceSource: 'none', pendingDiscount: { type: 'senior', percent: null } })
    expect(html).toMatch(/aria-pressed="true"[^>]*>Senior 5%</)
    expect(html).toMatch(/aria-pressed="false"[^>]*>Military 5%</)
    expect(html).toContain('Discount change waiting to reach the office')
    // A waiting Clear: nothing pressed, and no Clear button to press again.
    const cleared = render({ total: null, money: { ...military, discountedTotal: null } }, { priceSource: 'none', pendingDiscount: { type: null, percent: null } })
    expect(cleared).not.toMatch(/aria-pressed="true"/)
    expect(cleared).not.toContain('>Clear<')
  })

  it("the default ('server') is exactly what it was", () => {
    const html = render({ total: 270, money: military })
    expect(html).toContain('$270.00')
    expect(html).not.toContain('Preview')
    expect(html).not.toContain('Priced when signal returns')
  })
})

describe('OptionModeAndCopy with no signal', () => {
  it('"Copy lines" is greyed WITH the reason while the one-or-the-other box stays live (it queues like any edit)', () => {
    const q = { optionSet: { options: [entry('A', 2), entry('B'), entry('C')], nextOption: 'D' as const, lockedReason: null }, money: noMoney }
    const html = renderToStaticMarkup(
      <OptionModeAndCopy quote={q} busy={false} lockedReason={null} onSetMode={noop} onCopy={async () => ({ copied: 0 })} copyBlockedReason="Needs signal — copying lines is decided at the office" />,
    )
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*title="Needs signal — copying lines is decided at the office"/)
    expect(html).toContain('Needs signal — copying lines is decided at the office.')
    expect(html).toMatch(/<input type="checkbox"[^>]*>/)
    expect(html).not.toMatch(/<input type="checkbox"[^>]*disabled=""/)
  })
})

describe('QuoteTotals - "or from $X/mo with financing" (review finding, 2026-10-08)', () => {
  const render = (q: Pick<QuoteState, 'total' | 'money'>) =>
    renderToStaticMarkup(<QuoteTotals quote={q} busy={false} lockedReason={null} onSetDiscount={noop} />)
  const price = (key: string, total: number, discount = 0): SelectionPrice => ({
    key, options: key.split('+') as SelectionPrice['options'], subtotal: total + discount, trip: 0, comboSaving: 0,
    base: total + discount, discount, discountCapped: false, total,
  })
  const plans = DEFAULT_FINANCING_PLANS as FinancingPlan[]

  it("the tech's totals carry the same line the office's totals bar does, from the server's figures", () => {
    const financing = buildQuoteFinancing(plans, { A: 9000 })!
    const html = render({
      total: 9000,
      money: { ...noMoney, pickable: ['A'], selections: { A: price('A', 9000) }, financing },
    })
    expect(html).toContain('or from $109/mo with financing')
    expect(html).toContain('aria-haspopup="dialog"')
  })

  it('shows no line when no plan is on offer - never "$0/mo"', () => {
    const html = render({ total: 9000, money: { ...noMoney, pickable: ['A'], selections: { A: price('A', 9000) } } })
    expect(html).not.toContain('with financing')
  })

  it('one-or-the-other: the headline is the cheapest alternative', () => {
    const financing = buildQuoteFinancing(plans, { A: 9000, B: 3000 })!
    const html = render({
      total: 12000,
      money: {
        ...noMoney, exclusiveOptions: true, pickable: ['A', 'B'],
        selections: { A: price('A', 9000), B: price('B', 3000) }, financing,
      },
    })
    expect(html).toContain(`or from $${financing.bySelection.B.fromMonthly}/mo with financing`)
  })
})
