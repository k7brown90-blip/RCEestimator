/**
 * The sentences "Changes waiting (N)" prints for each queued quote edit (Phase 7 U5, 2026-10-10).
 * Words only: a queued edit carries no money, and no sentence here may print a figure.
 */

import { describe, expect, it } from 'vitest'
import { describeQuoteOp, quoteOpStatusWords, type QuoteOpWordsLookup } from './quoteOpWords'
import type { QuoteOpBody, QuoteOpRecord } from '../db/database'

const lookup: QuoteOpWordsLookup = {
  lineWords: (id) => ({ 'line-1': 'Single-pole switch', 'line-2': 'Duplex receptacle' })[id],
  itemWords: (itemId) => ({ W142: '14/2 NM-B' })[itemId],
}
const op = (body: QuoteOpBody) => ({ body })

describe('describeQuoteOp', () => {
  it('says what each kind of edit did, naming the line as the screen shows it', () => {
    expect(describeQuoteOp(op({ kind: 'start_quote', title: 'Quote — Hollis' }), lookup)).toBe('Started this quote on this phone — "Quote — Hollis"')
    expect(describeQuoteOp(op({ kind: 'add_line', lineId: 'line-2', itemId: 'B002', quantity: 3, option: 'B' }), lookup)).toBe('Added Duplex receptacle ×3 to Option B')
    // A line not on screen yet falls back to the saved book's words, then the item id.
    expect(describeQuoteOp(op({ kind: 'add_line', lineId: 'new', itemId: 'W142', quantity: 40, difficulty: 'DIFFICULT' }), lookup)).toBe('Added 14/2 NM-B ×40 to Option A, Difficult')
    expect(describeQuoteOp(op({ kind: 'add_line', lineId: 'new', itemId: 'Z9', quantity: 1 }))).toBe('Added Z9 ×1 to Option A')
    expect(describeQuoteOp(op({ kind: 'edit_line', lineId: 'line-1', patch: { quantity: 4, option: 'C', location: 'Garage', note: null } }), lookup))
      .toBe('Single-pole switch: quantity → 4, moved to Option C, location → Garage, note cleared')
    expect(describeQuoteOp(op({ kind: 'edit_line', lineId: 'line-1', patch: { difficulty: 'VERY_DIFFICULT' } }), lookup)).toBe('Single-pole switch: difficulty → Very difficult')
    expect(describeQuoteOp(op({ kind: 'edit_line', lineId: 'line-1', patch: { customName: 'Hall switch - Smith' } }), lookup)).toBe('Single-pole switch: name on the estimate → Hall switch - Smith')
    expect(describeQuoteOp(op({ kind: 'edit_line', lineId: 'line-1', patch: { customName: null } }), lookup)).toBe('Single-pole switch: price-book name back')
    expect(describeQuoteOp(op({ kind: 'remove_line', lineId: 'line-2' }), lookup)).toBe('Removed Duplex receptacle')
    expect(describeQuoteOp(op({ kind: 'add_option', option: 'D' }))).toBe('Added Option D')
    expect(describeQuoteOp(op({ kind: 'remove_option', option: 'D', expectedLines: 2 }))).toBe('Removed Option D')
    expect(describeQuoteOp(op({ kind: 'set_option_meta', option: 'D', label: 'Garage circuit', note: 'two outlets' }))).toBe('Named Option D "Garage circuit" — two outlets')
    expect(describeQuoteOp(op({ kind: 'set_option_meta', option: 'D', label: '', note: '' }))).toBe('Took the name off Option D')
    expect(describeQuoteOp(op({ kind: 'set_discount', type: 'military', percent: null }))).toBe('Discount: Military 5%')
    expect(describeQuoteOp(op({ kind: 'set_discount', type: 'custom', percent: 7.5 }))).toBe('Discount: Custom 7.5%')
    expect(describeQuoteOp(op({ kind: 'set_discount', type: null, percent: null }))).toBe('Discount taken off')
    expect(describeQuoteOp(op({ kind: 'set_mode', exclusive: true }))).toBe('One-or-the-other options: on')
    expect(describeQuoteOp(op({ kind: 'set_details', title: 'Panel change', jobDescription: 'Replace the 100A panel' }))).toBe('title → "Panel change", scope of work changed')
    expect(describeQuoteOp(op({ kind: 'set_details', jobDescription: null }))).toBe('scope of work cleared')
    expect(describeQuoteOp(op({ kind: 'line_order', order: [] }))).toBe('Lines reordered or moved between options')
  })

  it('never prints a dollar figure — a queued edit carries none', () => {
    const bodies: QuoteOpBody[] = [
      { kind: 'add_line', lineId: 'x', itemId: 'A016', quantity: 2, option: 'A' },
      { kind: 'edit_line', lineId: 'line-1', patch: { quantity: 9 } },
      { kind: 'set_discount', type: 'custom', percent: 12 },
    ]
    for (const body of bodies) expect(describeQuoteOp(op(body), lookup)).not.toMatch(/\$/)
  })
})

describe('quoteOpStatusWords', () => {
  const row = (over: Partial<QuoteOpRecord>) => ({ status: 'queued' as const, attempts: 0, ...over })
  it('waiting, waiting after a failed try, reached the office, refused with the office\'s words', () => {
    expect(quoteOpStatusWords(row({}))).toBe('Waiting for signal')
    expect(quoteOpStatusWords(row({ attempts: 2, lastError: 'Failed to fetch' }))).toBe('Waiting for signal — last try: Failed to fetch')
    expect(quoteOpStatusWords(row({ attempts: 2, lastError: 'Failed to fetch', lastErrorKind: 'network' }))).toBe('Waiting for signal — last try: Failed to fetch')
    // D7: the office saying "not now", and this phone's own code failing, are each said as what they are — not "waiting for signal".
    expect(quoteOpStatusWords(row({ attempts: 1, lastError: 'CRM request failed (503)', lastErrorKind: 'office' })))
      .toBe('The office could not take it yet — last try: CRM request failed (503). It is tried again on its own.')
    expect(quoteOpStatusWords(row({ attempts: 1, lastError: "Cannot read properties of undefined (reading 'lines')", lastErrorKind: 'phone' })))
      .toBe("Could not be sent from this phone — last try: Cannot read properties of undefined (reading 'lines'). Discard it and make the change again, or update the app.")
    expect(quoteOpStatusWords(row({ status: 'delivered' }))).toBe('Reached the office — waiting for its prices')
    expect(quoteOpStatusWords(row({ status: 'refused', refusal: 'Changed at the office since you last saw it: quantity was 2, now 4' })))
      .toBe('Refused by the office: Changed at the office since you last saw it: quantity was 2, now 4')
  })
})
