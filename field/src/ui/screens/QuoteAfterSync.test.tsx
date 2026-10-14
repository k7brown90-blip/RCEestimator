/**
 * The Quote screen after a sync (Phase 7 U6, 2026-10-10): the refusal card, the "office started one
 * first" prompt and the "Check the prices" panel, rendered to static markup (the field suite runs in
 * node with no DOM) and read the way a tech reads the screen. The handlers behind each button are
 * the lib's and are proved in quoteSync.test.ts; here it is what is on the page, with which words,
 * and what is greyed with what reason.
 */

import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  CHECKED_PRICES_LABEL,
  CHECK_PRICES_HEADING,
  CheckPricesPanel,
  NOTHING_TO_FLAG,
  OFFICE_STARTED_FIRST,
  RebasePrompt,
  RefusalBanner,
  addMineLabel,
  rebaseParts,
  refusedHeading,
} from './QuoteAfterSync'
import { REBASE_NEEDS_SIGNAL } from '../../lib/quoteSync'
import { priceCheck } from '../../lib/priceCheck'
import type { QuoteOpRecord } from '../../db/database'

const op = (over: Partial<QuoteOpRecord> & Pick<QuoteOpRecord, 'body'>): QuoteOpRecord => ({
  opId: `op-${over.seq ?? 1}`, draftId: 'd1', visitId: 'v1', seq: 1, kind: over.body.kind, status: 'queued', attempts: 0, queuedAt: '2026-10-10T12:00:00.000Z', ...over,
})
const lookup = { lineWords: (id: string) => (id === 'line-1' ? 'Single-pole switch' : undefined), itemWords: () => undefined }

describe('RefusalBanner — "1 change was refused: <the office\'s words>"', () => {
  const refused = op({ seq: 2, body: { kind: 'edit_line', lineId: 'line-1', patch: { quantity: 4 }, expected: { quantity: 2 } }, status: 'refused', refusal: 'Changed at the office since you last saw it: quantity was 2, now 5' })
  const render = (rows: QuoteOpRecord[], waiting = 3) =>
    renderToStaticMarkup(<RefusalBanner refused={rows} waiting={waiting} lookup={lookup} busy={false} onDiscard={async () => 'gone'} onDiscardAll={async () => 'all gone'} />)

  it('renders nothing with no refusal', () => {
    expect(render([])).toBe('')
  })
  it('says which change and the office\'s own words, with [Discard this change] and [Discard all N waiting changes]', () => {
    const html = render([refused])
    expect(html).toContain('1 change was refused: Single-pole switch: quantity → 4 — Changed at the office since you last saw it: quantity was 2, now 5')
    expect(html).toContain('>Discard this change<')
    expect(html).toContain('>Discard all 3 waiting changes<')
    expect(html).toContain('role="alert"')
    expect(html).not.toMatch(/\$\d/)
  })
  it('"Discard all" counts one change in the singular and is greyed when nothing waits', () => {
    expect(render([refused], 1)).toContain('>Discard all 1 waiting change<')
    const none = render([refused], 0)
    expect(none).toMatch(/<button[^>]*disabled=""[^>]*>Discard all 0 waiting changes</)
  })
  it('refusedHeading: several refusals name the count and the first', () => {
    expect(refusedHeading([refused, { ...refused, opId: 'x' }], lookup)).toMatch(/^2 changes were refused\. First: Single-pole switch/)
    expect(refusedHeading([], lookup)).toBe('')
  })
})

describe('RebasePrompt — "The office already started a quote for this visit"', () => {
  const ops = [
    op({ seq: 1, body: { kind: 'start_quote', title: 'Quote — Hollis' }, status: 'refused', existingDraftId: 'office-draft', refusal: OFFICE_STARTED_FIRST }),
    op({ seq: 2, body: { kind: 'add_line', lineId: 'line-1', itemId: 'A016', quantity: 2, option: 'A' } }),
    op({ seq: 3, body: { kind: 'add_line', lineId: 'line-9', itemId: 'B002', quantity: 1, option: 'B' } }),
    op({ seq: 4, body: { kind: 'add_option', option: 'D' } }),
    op({ seq: 5, body: { kind: 'set_discount', type: 'senior', percent: null } }),
    op({ seq: 6, body: { kind: 'set_details', title: 'Panel change' } }),
  ]
  const render = (rows: QuoteOpRecord[], addBlockedReason: string | null = null) =>
    renderToStaticMarkup(<RebasePrompt ops={rows} lookup={lookup} busy={false} addBlockedReason={addBlockedReason} onAddMine={async () => {}} onKeep={() => {}} onDiscard={async () => {}} />)

  it('rebaseParts: lines, the edits that move, and the settings asked about — the refused start and delivered rows aside', () => {
    const parts = rebaseParts([...ops, op({ seq: 7, body: { kind: 'set_mode', exclusive: true }, status: 'delivered' })])
    expect(parts.lines).toBe(2)
    expect(parts.moves.map((o) => o.seq)).toEqual([2, 3, 4])
    expect(parts.settings.map((o) => o.seq)).toEqual([5, 6])
    expect(addMineLabel(2)).toBe('Add my 2 lines to it')
    expect(addMineLabel(1)).toBe('Add my 1 line to it')
    expect(addMineLabel(0)).toBe('Add my changes to it')
  })
  it('the three buttons, and "Apply mine too?" per setting — unticked, so nothing of the office\'s is overwritten by default', () => {
    const html = render(ops)
    expect(html).toContain(OFFICE_STARTED_FIRST)
    expect(html).toContain('>Add my 2 lines to it<')
    expect(html).toContain('>Keep them on this phone for now<')
    expect(html).toContain('>Discard them<')
    expect(html).toContain('Apply mine too?')
    expect(html).toContain('Discount: Senior 5%')
    expect(html).toContain('title → &quot;Panel change&quot;')
    expect((html.match(/type="checkbox"/g) ?? []).length).toBe(2)
    expect(html).not.toContain('checked=""')
    expect(html).not.toMatch(/<button[^>]*disabled=""/)
    expect(html).toContain('role="alert"')
  })
  it('with no signal "Add my lines to it" is greyed WITH the reason, on the page and in the tooltip; the other two stay live', () => {
    const html = render(ops, REBASE_NEEDS_SIGNAL)
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Add my 2 lines to it</)
    expect(html).toContain(`title="${REBASE_NEEDS_SIGNAL.replace(/'/g, '&#x27;')}"`)
    expect(html).toContain(REBASE_NEEDS_SIGNAL.replace(/'/g, '&#x27;'))
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Keep them/)
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Discard them/)
  })
  it('no settings edits: no "Apply mine too?" fieldset at all', () => {
    const html = render(ops.slice(0, 3))
    expect(html).not.toContain('Apply mine too?')
    expect(html).not.toContain('type="checkbox"')
  })
})

describe('CheckPricesPanel — "Prices from the office\'s book — check before issuing"', () => {
  const office = {
    lines: [
      { id: 'l1', itemId: 'A016', description: 'Single-pole switch', quantity: 4, quantitySource: 'COUNT' as const, difficulty: 'NORMAL' as const, option: 'A' as const, note: null, location: null, lineTotal: 250, gaps: [], retired: false },
      { id: 'l2', itemId: 'B002', description: 'Duplex receptacle', quantity: 1, quantitySource: 'COUNT' as const, difficulty: 'NORMAL' as const, option: 'A' as const, note: null, location: null, lineTotal: 80, gaps: [], retired: true },
    ],
    options: [{ option: 'A' as const, lineCount: 2, subtotal: 330, complete: true }],
    total: 330,
    rateProvisional: false,
  }
  const shown = { at: '2026-10-10T12:00:00.000Z', source: 'preview' as const, lines: [{ id: 'l1', description: 'Single-pole switch', total: 241 }, { id: 'l2', description: 'Duplex receptacle', total: 80 }], options: [{ option: 'A', subtotal: 321 }], total: 321 }
  const render = (report: ReturnType<typeof priceCheck>, shownAt: string | null = shown.at) =>
    renderToStaticMarkup(<CheckPricesPanel report={report} shownAt={shownAt} busy={false} onChecked={async () => {}} />)

  it('the heading, each row with both figures, and the one button that lifts the gate', () => {
    const html = render(priceCheck(shown, office))
    expect(html).toContain(CHECK_PRICES_HEADING.replace(/'/g, '&#x27;'))
    expect(html).toContain('Single-pole switch: this phone showed $241.00, the office says $250.00')
    expect(html).toContain('Duplex receptacle: no longer offered in the price book (the office still prices it)')
    expect(html).toContain('Option A: this phone showed $321.00, the office says $330.00')
    expect(html).toContain('Total: this phone showed $321.00, the office says $330.00')
    expect(html).toContain(`>${CHECKED_PRICES_LABEL.replace(/'/g, '&#x27;')}<`)
    expect(html).toContain('Beside each figure is the Preview this phone showed')
    expect(html).toContain('Issue, Show the customer and Sign now open once you have checked.')
    // No arithmetic: the differences (9.00 on the line, 9.00 on the option and total) are nowhere on the page.
    expect(html).not.toContain('9.00')
    expect(html).not.toContain(NOTHING_TO_FLAG)
  })
  it('nothing to flag still shows the panel and the button — the tech taps once', () => {
    const html = render(priceCheck({ ...shown, lines: [{ id: 'l1', description: 'Single-pole switch', total: 250 }], options: [{ option: 'A', subtotal: 330 }], total: 330 }, { ...office, lines: [office.lines[0]] }))
    expect(html).toContain(NOTHING_TO_FLAG)
    expect(html).toContain(CHECKED_PRICES_LABEL.replace(/'/g, '&#x27;'))
  })
  it('with no note (the phone showed nothing), the words say so and every line is priced for the first time', () => {
    const html = render(priceCheck({ ...shown, source: 'none', lines: [], options: [], total: null }, office), null)
    expect(html).toContain('This phone showed no figure for these lines')
    expect(html).toContain('Single-pole switch: priced for the first time — $250.00')
    expect(html).not.toContain('noted ')
  })
})
