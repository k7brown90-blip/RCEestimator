import { describe, expect, it } from 'vitest'
import { scoreInspection } from './scoring'
import type { Inspection, ItemResult } from './types'

// Weights used below (from src/data/weights.ts):
// D1 severe=45 / moderate=30 / minor=12 (no grade -> max 45) · C4=30 · H1=24 · E1=24
// C2=30 · C6=30 · D3=30 · E2=24 · F3=16

function item(partial: Partial<ItemResult> & { itemId: string }): ItemResult {
  return { result: 'PASS', measured: {}, photoIds: [], ...partial }
}

function buildInspection(items: ItemResult[]): Inspection {
  return {
    id: 'inspection-1',
    propertyId: 'property-1',
    jurisdictionId: 'murfreesboro',
    technician: 'tech',
    date: '2026-07-25',
    items,
    score: 0,
    itemsAssessed: 0,
    criticalFindings: [],
    contractorReviewed: false,
    status: 'draft',
  }
}

const baseItems = (): ItemResult[] => [
  item({ itemId: 'D1' }),
  item({ itemId: 'C4' }),
  item({ itemId: 'H1' }),
  item({ itemId: 'E1' }),
]

describe('scoreInspection', () => {
  it('returns 100 for a clean inspection', () => {
    const result = scoreInspection(buildInspection(baseItems()))
    expect(result.score).toBe(100)
    expect(result.itemsAssessed).toBe(4)
    expect(result.criticalFindings).toEqual([])
  })

  it('deducts 0.35×W for a MONITOR finding', () => {
    // max = 45+30+24+24 = 123; deduction = 0.35×30 = 10.5
    // 100 × (1 − 10.5/123) = 91.46 → 91
    const result = scoreInspection(buildInspection([
      item({ itemId: 'D1' }),
      item({ itemId: 'C4', result: 'MONITOR' }),
      item({ itemId: 'H1' }),
      item({ itemId: 'E1' }),
    ]))

    expect(result.score).toBe(91)
    expect(result.criticalFindings).toEqual([])
  })

  it('deducts 0.15×W for BELOW_STANDARD and excludes N/A from the denominator', () => {
    // applicable = D1, C4, E1 → max = 45+30+24 = 99; deduction = 0.15×30 = 4.5
    // 100 × (1 − 4.5/99) = 95.45 → 95
    const result = scoreInspection(buildInspection([
      item({ itemId: 'D1' }),
      item({ itemId: 'C4', result: 'BELOW_STANDARD' }),
      item({ itemId: 'H1', result: 'NA' }),
      item({ itemId: 'E1' }),
    ]))

    expect(result.itemsAssessed).toBe(3)
    expect(result.score).toBe(95)
    expect(result.criticalFindings).toEqual([])
  })

  it('fires the banner and caps at 69 for a life-safety ACTION (E1 GFCI absent)', () => {
    // max = 123; deduction = 24 → raw = 100 × (1 − 24/123) = 80.49 → 80 → capped 69
    const result = scoreInspection(buildInspection([
      item({ itemId: 'D1' }),
      item({ itemId: 'C4' }),
      item({ itemId: 'H1' }),
      item({ itemId: 'E1', result: 'ACTION' }),
    ]))

    expect(result.criticalFindings).toEqual(['E1'])
    expect(result.score).toBe(69)
  })

  it('caps a D1-severe ACTION at 69 even when the raw score is higher', () => {
    // max = 45+30+24+24+30+30+30+24+16 = 253; deduction = 45
    // raw = 100 × (1 − 45/253) = 82.21 → 82 → capped 69
    const result = scoreInspection(buildInspection([
      item({ itemId: 'D1', result: 'ACTION', gradedState: 'severe' }),
      item({ itemId: 'C4' }),
      item({ itemId: 'H1' }),
      item({ itemId: 'E1' }),
      item({ itemId: 'C2' }),
      item({ itemId: 'C6' }),
      item({ itemId: 'D3' }),
      item({ itemId: 'E2' }),
      item({ itemId: 'F3' }),
    ]))

    expect(result.criticalFindings).toEqual(['D1'])
    expect(result.score).toBe(69)
  })

  it('selects the graded weight — a D1 moderate ACTION is not banner-listed', () => {
    // D1 moderate W=30 → max = 30+30+24+24 = 108; deduction = 30
    // raw = 100 × (1 − 30/108) = 72.22 → 72, no banner (banner is severe-only for D1)
    const result = scoreInspection(buildInspection([
      item({ itemId: 'D1', result: 'ACTION', gradedState: 'moderate' }),
      item({ itemId: 'C4' }),
      item({ itemId: 'H1' }),
      item({ itemId: 'E1' }),
    ]))

    expect(result.criticalFindings).toEqual([])
    expect(result.score).toBe(72)
  })

  it('lists every critical finding; the cap does not stack lower', () => {
    // max = 123; deduction = 45 + 24 = 69 → raw = 100 × (1 − 69/123) = 43.9 → 44
    // Both criticals listed; score stays 44 (cap is a ceiling, not a floor).
    const result = scoreInspection(buildInspection([
      item({ itemId: 'D1', result: 'ACTION', gradedState: 'severe' }),
      item({ itemId: 'C4' }),
      item({ itemId: 'H1' }),
      item({ itemId: 'E1', result: 'ACTION' }),
    ]))

    expect(result.criticalFindings).toEqual(['D1', 'E1'])
    expect(result.score).toBe(44)
  })

  it('is deterministic — identical input yields identical output', () => {
    const inspection = buildInspection([
      item({ itemId: 'D1', result: 'ACTION', gradedState: 'severe' }),
      item({ itemId: 'C4', result: 'ACTION' }),
      item({ itemId: 'H1', result: 'MONITOR' }),
      item({ itemId: 'E1' }),
    ])

    const first = scoreInspection(inspection)
    for (let i = 0; i < 100; i += 1) {
      expect(scoreInspection(inspection)).toEqual(first)
    }
  })
})
