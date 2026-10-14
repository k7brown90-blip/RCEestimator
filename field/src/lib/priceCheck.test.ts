/**
 * "Check the prices" (Phase 7 U6, 2026-10-10): the office's answer beside what this phone showed.
 * Equality only, both numbers printed, no difference ever worked out; gaps, retired items and a
 * provisional rate called out by name.
 */

import { describe, expect, it } from 'vitest'
import { OFFICE_RATE_PROVISIONAL, priceCheck } from './priceCheck'
import type { ShownFigures } from '../db/database'
import type { QuoteLine } from './crmSync'

const line = (over: Partial<QuoteLine> & Pick<QuoteLine, 'id' | 'description'>): QuoteLine => ({
  itemId: 'X', quantity: 1, quantitySource: 'COUNT', difficulty: 'NORMAL', option: 'A', note: null, location: null, lineTotal: null, gaps: [], ...over,
})

const shown = (over: Partial<ShownFigures> = {}): ShownFigures => ({
  at: '2026-10-10T12:00:00.000Z',
  source: 'preview',
  lines: [{ id: 'l1', description: 'Single-pole switch', total: 241 }, { id: 'l2', description: 'Duplex receptacle', total: 80 }, { id: 'l3', description: '14/2 NM-B', total: null }],
  options: [{ option: 'A', subtotal: 321 }, { option: 'B', subtotal: null }],
  total: null,
  ...over,
})

const office = (lines: QuoteLine[], over: Partial<Parameters<typeof priceCheck>[1]> = {}) => ({
  lines,
  options: [{ option: 'A' as const, lineCount: 2, subtotal: 321, complete: true }],
  total: 321,
  rateProvisional: false,
  ...over,
})

describe('priceCheck', () => {
  it('nothing to flag when every figure matches', () => {
    const r = priceCheck(shown({ total: 321 }), office([line({ id: 'l1', description: 'Single-pole switch', lineTotal: 241 }), line({ id: 'l2', description: 'Duplex receptacle', lineTotal: 80 })]))
    expect(r).toEqual({ rows: [], clean: true, comparedWith: 'preview' })
  })

  it('a line the phone showed no figure for is "priced for the first time" with the office\'s figure; one with a different figure prints both', () => {
    const r = priceCheck(
      shown(),
      office([
        line({ id: 'l1', description: 'Single-pole switch', lineTotal: 250 }),
        line({ id: 'l2', description: 'Duplex receptacle', lineTotal: 80 }),
        line({ id: 'l3', description: '14/2 NM-B', lineTotal: 96 }),
        line({ id: 'l4', description: 'Added at the office', lineTotal: 12 }),
      ]),
    )
    expect(r.rows).toEqual([
      { kind: 'changed', words: 'Single-pole switch: this phone showed $241.00, the office says $250.00', shown: 241, office: 250 },
      { kind: 'first', words: '14/2 NM-B: priced for the first time — $96.00', shown: null, office: 96 },
      { kind: 'first', words: 'Added at the office: priced for the first time — $12.00', shown: null, office: 12 },
    ])
    expect(r.clean).toBe(false)
  })

  it('never works out a difference: both figures are printed and no third number appears', () => {
    const r = priceCheck(shown({ total: 500 }), office([line({ id: 'l1', description: 'Single-pole switch', lineTotal: 250 })], { total: 530, options: [{ option: 'A', lineCount: 1, subtotal: 250, complete: true }] }))
    const text = r.rows.map((x) => x.words).join('\n')
    expect(text).toContain('$241.00')
    expect(text).toContain('$250.00')
    expect(text).toContain('Option A: this phone showed $321.00, the office says $250.00')
    expect(text).toContain('Total: this phone showed $500.00, the office says $530.00')
    // The differences would be $9.00, $71.00 and $30.00 — none is on the page as a figure of its own.
    for (const difference of [/(?<![\d.])9\.00/, /(?<![\d.])71\.00/, /(?<![\d.])30\.00/, /−/, /-\$/]) expect(text).not.toMatch(difference)
  })

  it('gaps (freezes at $0), a retired item, and a provisional rate are each called out by name', () => {
    const r = priceCheck(
      shown(),
      office(
        [
          line({ id: 'l1', description: 'Single-pole switch', lineTotal: 241 }),
          line({ id: 'l2', description: 'Duplex receptacle', lineTotal: null, gaps: ['No price at the active supplier'] }),
          line({ id: 'l5', description: 'Old breaker', lineTotal: 40, retired: true }),
        ],
        { rateProvisional: true },
      ),
    )
    expect(r.rows.map((x) => x.kind)).toEqual(['gap', 'retired', 'first', 'rate'])
    expect(r.rows[0].words).toBe("Duplex receptacle: no price in the office's book — No price at the active supplier. It freezes at $0 if issued as it stands.")
    expect(r.rows[1].words).toBe('Old breaker: no longer offered in the price book (the office still prices it)')
    expect(r.rows[3].words).toBe(OFFICE_RATE_PROVISIONAL)
  })

  it('an AI-proposed line is not compared (the office does not price it); an option or total the phone showed no figure for is not flagged', () => {
    const r = priceCheck(
      shown(),
      office([line({ id: 'l1', description: 'Single-pole switch', lineTotal: 241 }), line({ id: 'p1', description: 'AI idea', state: 'PROPOSED', lineTotal: null })], {
        options: [{ option: 'A', lineCount: 1, subtotal: 321, complete: true }, { option: 'B', lineCount: 1, subtotal: 96, complete: true }],
        total: 417,
      }),
    )
    expect(r.rows).toEqual([])
  })

  it('with no note at all, every priced line is "priced for the first time" and the report says what it compared with', () => {
    const r = priceCheck(null, office([line({ id: 'l1', description: 'Single-pole switch', lineTotal: 241 })]))
    expect(r.rows.map((x) => x.kind)).toEqual(['first'])
    expect(r.comparedWith).toBeNull()
    expect(priceCheck(shown({ source: 'none' }), office([])).comparedWith).toBe('none')
  })
})
