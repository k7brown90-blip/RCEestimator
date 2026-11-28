/**
 * The field Quote screen's AI proposals and "Walk the job" (2026-10-08,
 * one-estimating-system plan, Phase 2, unit D). Rendered to static markup (the field suite runs in
 * node with no DOM) and read the way a tech reads the screen: what is on it, what is greyed, and what
 * the reason says.
 */

import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import * as Suggestions from './QuoteSuggestions'
import { AiBuildSummary, SuggestedLinesPanel, WalkthroughList, WalkthroughRowCard } from './QuoteSuggestions'
import type { FieldWalkthroughRow, NotPlacedScope, QuoteSuggestedLine } from '../../../../shared/suggestedLines'

const SIGNED = 'Estimate 2026-1098 from this draft is SIGNED. A signed agreement is never edited — raise a change order instead.'

const suggestion = (over: Partial<QuoteSuggestedLine> = {}): QuoteSuggestedLine => ({
  id: 's1', itemId: 'A016', description: '20A GFCI receptacle', quantity: 4, difficulty: 'NORMAL', option: 'A',
  reasoning: 'The walkthrough lists four outdoor outlets.', proposedBy: 'ai:gpt-5.1', ...over,
})

const noop = async () => {}

describe('SuggestedLinesPanel — "AI proposals"', () => {
  const render = (lines: QuoteSuggestedLine[], lockedReason: string | null = null, busy = false, allowNegative = false) =>
    renderToStaticMarkup(
      <SuggestedLinesPanel lines={lines} busy={busy} lockedReason={lockedReason} allowNegative={allowNegative} onConfirm={noop} onReject={noop} />,
    )

  it('renders nothing when nothing is waiting', () => {
    expect(render([])).toBe('')
  })

  it("carries the office's words: the heading, the item, who proposed it, where it goes and WHY", () => {
    const html = render([suggestion(), suggestion({ id: 's2', description: '4-square box', reasoning: null, proposedBy: null })])
    expect(html).toContain('AI proposals — 2 waiting on you')
    expect(html).toContain('Nothing counts, and nothing is priced, until you confirm it.')
    expect(html).toContain('20A GFCI receptacle')
    expect(html).toContain('proposed by ai:gpt-5.1')
    expect(html).toContain('goes in Option A')
    // The model's reasoning sits next to the decision.
    expect(html).toContain('The walkthrough lists four outdoor outlets.')
  })

  it('each card has Confirm and Reject, a quantity box and a difficulty choice — thumb-sized', () => {
    const html = render([suggestion()])
    expect(html).toContain('>Confirm<')
    expect(html).toContain('>Reject<')
    expect(html).toContain('value="4"')
    expect(html).toContain('Very difficult')
    expect(html).toContain('min-h-[2.75rem]')
  })

  it('shows no money: a suggestion is not priced', () => {
    expect(render([suggestion()])).not.toMatch(/\$\d/)
  })

  it('a SIGNED quote greys Confirm, Reject, quantity and difficulty, each carrying the reason — greyed, not hidden', () => {
    const html = render([suggestion()], SIGNED)
    expect((html.match(/disabled=""/g) ?? []).length).toBe(4)
    expect((html.match(new RegExp(`title="${SIGNED}"`, 'g')) ?? []).length).toBe(4)
    expect(html).toContain('>Confirm<')
    expect(html).toContain('>Reject<')
  })

  it('a call in flight greys the buttons without claiming the quote is signed', () => {
    const html = render([suggestion()], null, true)
    expect((html.match(/disabled=""/g) ?? []).length).toBe(4)
    expect(html).not.toContain('SIGNED')
  })
})

// Kyle, 2026-11-28 ("I already confirmed the line item once. this is a redundant and repetative process
// that wastes time."): the phone has no "Open questions" panel. Nothing here can render one, and what
// the model could not place is one note under the AI result.
describe('no "Open questions" on the Quote screen', () => {
  it('the panel is gone from the module', () => {
    expect((Suggestions as Record<string, unknown>).OpenQuestionsPanel).toBeUndefined()
  })

  it('the Quote screen reads no question list and mounts no questions panel', () => {
    const screen = readFileSync(path.join(__dirname, 'QuoteScreen.tsx'), 'utf8')
    const code = screen.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l)).join('\n')
    expect(code).not.toMatch(/openQuestions|OpenQuestionsPanel|resolveQuoteQuestion/)
  })
})

describe('AiBuildSummary - what "Build the draft (AI)" answers with', () => {
  const render = (over: Partial<{ proposed: number; notPlaced: NotPlacedScope[]; rejected: number }> = {}) =>
    renderToStaticMarkup(<AiBuildSummary summary={{ proposed: 2, notPlaced: [], rejected: 0, ...over }} />)

  it("reads 'N line(s) proposed' and no question count, with no note when everything was placed", () => {
    const html = render()
    expect(html).toContain('2 line(s) proposed')
    expect(html).not.toMatch(/question/i)
    expect(html).not.toContain("Couldn&#x27;t place")
    expect(html).not.toContain("Couldn't place")
  })

  it("lists what it could not place as ONE note to read - nothing to answer", () => {
    const html = render({ notPlaced: [{ text: 'weird outdoor plug by the pool', reason: 'nothing in the price book fits' }, { text: 'a 4-inch junction box', reason: '' }] })
    expect(html.replace(/&#x27;/g, "'")).toContain("Couldn't place: weird outdoor plug by the pool (nothing in the price book fits); a 4-inch junction box - add them by hand if needed.")
    expect(html).not.toMatch(/question/i)
    expect(html).not.toContain('<input')
    expect(html).not.toContain('Resolve')
  })
})

describe('WalkthroughList — "Walk the job — list what you need"', () => {
  const render = (lockedReason: string | null = null) =>
    renderToStaticMarkup(
      <WalkthroughList lockedReason={lockedReason} busy={false} addInto="B" onPropose={async () => ({ path: 'basic', proposed: [], notPlaced: [], rejected: [] })} onMatch={async () => []} onAdd={async () => true} />,
    )

  it('is one labelled button until opened', () => {
    const html = render()
    expect(html).toContain('Walk the job — list what you need')
    expect(html).not.toContain('<textarea')
    expect(html).not.toMatch(/disabled=""/)
  })

  it('a SIGNED quote greys it with the reason — greyed, not hidden', () => {
    const html = render(SIGNED)
    expect(html).toContain('Walk the job — list what you need')
    expect(html).toMatch(/<button[^>]*disabled=""/)
    expect(html).toContain(`title="${SIGNED}"`)
  })
})

describe('WalkthroughRowCard — a typed line and what the basic match found', () => {
  const row = (over: Partial<FieldWalkthroughRow> = {}): FieldWalkthroughRow => ({
    raw: '50 ft 12/2 romex', parsedQuantity: 50, searchTerm: '12/2 romex', status: 'AMBIGUOUS', matchedOn: 'name', unknownWords: [],
    candidates: [
      { itemId: 'W1', description: 'NM-B 12/2 w/Grd — per ft', unit: 'ft', isContinuousLength: true, hasLabourUnitBasis: true, hasPriceAtActiveSupplier: true },
      { itemId: 'W2', description: 'NM-B 12/2 coil', unit: 'ea', isContinuousLength: false, hasLabourUnitBasis: true, hasPriceAtActiveSupplier: true },
    ], ...over,
  })
  const render = (r: FieldWalkthroughRow, busy = false) =>
    renderToStaticMarkup(<WalkthroughRowCard row={r} busy={busy} addInto="C" onAdd={async () => true} />)

  it('shows what was typed, what it matched on, the status and a "+ Add to quote" per candidate in the book\'s own words', () => {
    const html = render(row())
    expect(html).toContain('50 ft 12/2 romex')
    expect(html).toContain('matched on “12/2 romex”')
    expect(html).toContain('you wrote 50 — set the quantity on the line')
    expect(html).toContain('AMBIGUOUS')
    expect(html).toContain('NM-B 12/2 w/Grd — per ft')
    expect((html.match(/\+ Add to quote/g) ?? []).length).toBe(2)
    // Names where it will land.
    expect(html).toContain('Adds one to Option C')
  })

  it('an unmatched row names the word the book does not know and offers no add button', () => {
    const html = render(row({ status: 'UNMATCHED', candidates: [], unknownWords: ['canless'], parsedQuantity: null }))
    expect(html).toContain('UNMATCHED')
    expect(html).toContain('“canless” is not in your price book')
    expect(html).not.toContain('+ Add to quote')
  })

  it('shows no hours, cost or price', () => {
    expect(render(row())).not.toMatch(/\$\d|hours|labou?r|cost/i)
  })

  it('a call in flight greys the add buttons', () => {
    expect((render(row(), true).match(/disabled=""/g) ?? []).length).toBe(2)
  })
})
