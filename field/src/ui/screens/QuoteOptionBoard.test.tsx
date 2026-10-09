/**
 * The field Quote screen's option board (2026-10-08, one-estimating-system plan, Phase 1 unit 1c).
 *
 * The field suite runs in node with no DOM and no pointer, so these render the board to static
 * markup and read what a tech would SEE: the headings, the subtotals from the payload, the empty
 * added option, "+ Add Option D", "Remove Option D", and the reason printed at the limit. Dragging
 * itself is exercised through the shared move rules (shared/lineOrder, tested with the CRM) — a
 * real thumb on a real phone is not covered here.
 */

import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { QuoteOptionBoard } from './QuoteOptionBoard'
import { EMPTY_OPTION_TEXT, removeOptionConfirm, TOUCH_HOLD_MS } from '../../lib/quoteOptions'
import type { QuoteLine, QuoteState } from '../../lib/crmSync'
import { ALL_OPTIONS, type DraftOptionEntry, type EstimateOptionLetter } from '../../../../shared/estimateOptions'

const entry = (option: EstimateOptionLetter, lineCount = 0, label: string | null = null): DraftOptionEntry => ({
  option, label, note: null, lineCount, removable: !['A', 'B', 'C'].includes(option),
})

const line = (id: string, option: EstimateOptionLetter, description: string, lineTotal: number): QuoteLine => ({
  id, itemId: `item-${id}`, description, quantity: 1, quantitySource: 'MANUAL', difficulty: 'NORMAL',
  option, note: null, location: null, lineTotal, gaps: [],
})

type BoardQuote = Pick<QuoteState, 'lines' | 'optionSet' | 'options'>

function quote(over: Partial<BoardQuote> = {}): BoardQuote {
  return {
    lines: [line('l1', 'A', 'Replace panel', 1200), line('l2', 'B', 'Add GFCI', 150)],
    optionSet: { options: [entry('A', 1), entry('B', 1), entry('C')], nextOption: 'D', lockedReason: null },
    options: [
      { option: 'A', lineCount: 1, subtotal: 1200, complete: true },
      { option: 'B', lineCount: 1, subtotal: 150, complete: true },
    ],
    ...over,
  }
}

const noop = async () => {}
function render(q: BoardQuote, busy = false) {
  return renderToStaticMarkup(
    <QuoteOptionBoard
      quote={q}
      busy={busy}
      renderLine={(l) => <div>{l.description}</div>}
      onAddOption={noop}
      onRemoveOption={noop}
      onSaveOrder={noop}
      onSaveMeta={noop}
    />,
  )
}

describe('QuoteOptionBoard', () => {
  it("groups lines under a heading per option with the payload's subtotal and line count", () => {
    const html = render(quote())
    const a = html.indexOf('aria-label="Option A lines"')
    const b = html.indexOf('aria-label="Option B lines"')
    const c = html.indexOf('aria-label="Option C lines"')
    expect(a).toBeGreaterThan(-1)
    expect(a).toBeLessThan(b)
    expect(b).toBeLessThan(c)
    // Replace panel sits inside A's section, Add GFCI inside B's.
    expect(html.indexOf('Replace panel')).toBeGreaterThan(a)
    expect(html.indexOf('Replace panel')).toBeLessThan(b)
    expect(html.indexOf('Add GFCI')).toBeGreaterThan(b)
    expect(html.indexOf('Add GFCI')).toBeLessThan(c)
    expect(html).toContain('$1200.00')
    expect(html).toContain('$150.00')
    expect(html).toContain('1 line')
  })

  it('an A/B/C quote shows no Remove button and offers "+ Add Option D"', () => {
    const html = render(quote())
    expect(html).toContain('+ Add Option D')
    expect(html).not.toContain('Remove Option')
    expect(html).not.toContain('Eight options is the limit')
  })

  it('an added option with no lines still shows a heading, the empty words, and "Remove Option D"', () => {
    const html = render(quote({ optionSet: { options: [entry('A', 1), entry('B', 1), entry('C'), entry('D')], nextOption: 'E', lockedReason: null } }))
    expect(html).toContain('aria-label="Option D lines"')
    expect(html).toContain(EMPTY_OPTION_TEXT)
    expect(html).toContain('Remove Option D')
    expect(html).toContain('+ Add Option E')
    // The truck has no Review screen to name it in: the field's own wording, never the CRM's.
    expect(html).toContain('tap the name to describe this option')
    expect(html).not.toContain('in Review')
    // ... and the name really is a button to tap (Phase 2).
    expect(html).toContain('aria-label="Name Option D"')
  })

  it('a named option shows the name beside its letter', () => {
    const html = render(quote({ optionSet: { options: [entry('A', 1), entry('B', 1), entry('C'), entry('D', 0, 'Whole-house rewire')], nextOption: 'E', lockedReason: null } }))
    expect(html).toContain('Whole-house rewire')
  })

  it('an incomplete option says so instead of showing a partial price', () => {
    const html = render(quote({
      options: [
        { option: 'A', lineCount: 1, subtotal: null, complete: false },
        { option: 'B', lineCount: 1, subtotal: 150, complete: true },
      ],
    }))
    expect(html).toContain('incomplete')
  })

  it('at the limit the add button is greyed and the reason is printed on the page', () => {
    const all = ALL_OPTIONS.map((o) => entry(o))
    const html = render(quote({ optionSet: { options: all, nextOption: null, lockedReason: null } }))
    expect(html).toContain('Eight options is the limit.')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[^<]*\+ Add Option<\/button>/)
    for (const o of ['D', 'E', 'F', 'G', 'H']) expect(html).toContain(`Remove Option ${o}`)
  })

  it('every line has a drag handle that says how to use it; busy greys it with a reason', () => {
    const live = render(quote())
    expect(live).toContain('Press and hold, then drag to reorder or move to another option')
    const busy = render(quote(), true)
    expect(busy).toContain('Wait for the current change to finish')
    expect(busy).not.toContain('Press and hold, then drag to reorder or move')
  })

  it('a named option shows its description under the heading and offers to RENAME it', () => {
    const o = { ...entry('D', 0, 'Whole-house rewire'), note: 'Every room, new panel' }
    const html = render(quote({ optionSet: { options: [entry('A', 1), entry('B', 1), entry('C'), o], nextOption: 'E', lockedReason: null } }))
    expect(html).toContain('Every room, new panel')
    expect(html).toContain('aria-label="Rename Option D"')
    expect(html).toContain('aria-label="Name Option A"')
  })

  it('a SIGNED quote greys Add, Remove, every handle and the naming buttons, with the reason as their tooltip', () => {
    const reason = 'Estimate 2026-1098 from this draft is SIGNED. A signed agreement is never edited — raise a change order instead.'
    const html = render(quote({
      optionSet: { options: [entry('A', 1), entry('B', 1), entry('C'), entry('D')], nextOption: 'E', lockedReason: reason },
    }))
    // The sentence is printed ONCE, at the top of the screen (QuoteScreen), not repeated by the board;
    // here it rides on each greyed control as its tooltip.
    expect(html).toContain(`title="${reason}"`)
    expect(html).not.toContain(`>${reason}</p>`)
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Name Option A"/)
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[^<]*\+ Add Option E<\/button>/)
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>\s*Remove Option D<\/button>/)
    expect(html).not.toContain('Press and hold, then drag to reorder or move')
    expect(html).not.toContain('Press and hold a line')
  })

  it('an AI-suggested line has no handle here: the option points at "AI proposals", where it is decided', () => {
    const proposed = { ...line('p1', 'A', 'Suggested EV circuit', 0), state: 'PROPOSED' as const, lineTotal: null }
    const html = render(quote({ lines: [line('l1', 'A', 'Replace panel', 1200), proposed] }))
    // The suggestion itself is not a row on the board (Confirm / Edit & confirm / Reject live in the
    // "AI proposals" section, QuoteSuggestions); the option only says one is waiting on the tech.
    expect(html).not.toContain('Suggested EV circuit')
    expect(html).toContain('1 AI-suggested line is waiting on you for this option')
    expect(html).toContain('AI proposals')
    expect(html).not.toContain('waiting for the office')
    // One handle: the confirmed line. The suggestion is not draggable and is not counted as a line.
    expect(html.split('aria-label="Press and hold, then drag').length - 1).toBe(1)
    expect(html).toContain('1 line<')
  })

  it("the confirm wording matches the CRM's, singular and plural", () => {
    expect(removeOptionConfirm('D', 3)).toBe('Option D has 3 lines — remove them too?')
    expect(removeOptionConfirm('E', 1)).toBe('Option E has 1 line — remove them too?')
  })

  it('touch needs a press-and-hold so scrolling never starts a drag', () => {
    expect(TOUCH_HOLD_MS).toBeGreaterThanOrEqual(200)
  })
})
