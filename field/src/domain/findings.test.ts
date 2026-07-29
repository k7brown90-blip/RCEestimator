import { describe, expect, it } from 'vitest'
import { checklist } from '../data/checklist'
import { isCriticalFinding, summarizeFindings } from './findings'
import type { Inspection, ItemResult } from './types'

function item(partial: Partial<ItemResult> & { itemId: string }): ItemResult {
  return { result: 'PASS', measured: {}, photoIds: [], ...partial }
}

function inspection(items: ItemResult[]): Inspection {
  return {
    id: 'i1',
    propertyId: 'p1',
    jurisdictionId: 'murfreesboro',
    technician: 'tech',
    date: '2026-07-26',
    items,
    scope: 'full',
    itemsAssessed: items.length,
    criticalFindings: [],
    contractorReviewed: false,
    status: 'draft',
  }
}

describe('isCriticalFinding', () => {
  it('fires on a FAIL of a banner-listed item', () => {
    expect(isCriticalFinding(item({ itemId: 'C4', result: 'FAIL' }))).toBe(true)
    expect(isCriticalFinding(item({ itemId: 'E1', result: 'FAIL' }))).toBe(true)
  })

  it('does not fire on a banner-listed item that only needs monitoring', () => {
    // The banner blocks delivery — a MONITOR is not a stop-work.
    expect(isCriticalFinding(item({ itemId: 'C4', result: 'MONITOR' }))).toBe(false)
    expect(isCriticalFinding(item({ itemId: 'C4', result: 'BELOW_STANDARD' }))).toBe(false)
    expect(isCriticalFinding(item({ itemId: 'C4', result: 'PASS' }))).toBe(false)
  })

  it('does not fire on a FAIL of an item that is not banner-listed', () => {
    expect(isCriticalFinding(item({ itemId: 'D4', result: 'FAIL' }))).toBe(false)
  })

  it('fires on D1 only at the severe grade', () => {
    // A loose lug is a real finding; a glowing connection is a stop-work.
    expect(isCriticalFinding(item({ itemId: 'D1', result: 'FAIL', gradedState: 'severe' }))).toBe(true)
    expect(isCriticalFinding(item({ itemId: 'D1', result: 'FAIL', gradedState: 'moderate' }))).toBe(false)
    expect(isCriticalFinding(item({ itemId: 'D1', result: 'FAIL', gradedState: 'minor' }))).toBe(false)
  })

  it('does not fire on a graded item with no grade chosen', () => {
    expect(isCriticalFinding(item({ itemId: 'D1', result: 'FAIL' }))).toBe(false)
  })
})

describe('summarizeFindings', () => {
  it('counts each result state', () => {
    const summary = summarizeFindings(inspection([
      item({ itemId: 'C4', result: 'FAIL' }),
      item({ itemId: 'C6', result: 'FAIL' }),
      item({ itemId: 'F1', result: 'MONITOR' }),
      item({ itemId: 'E3', result: 'BELOW_STANDARD' }),
      item({ itemId: 'H1', result: 'PASS' }),
      item({ itemId: 'C5', result: 'NA' }),
    ]))

    expect(summary.failCount).toBe(2)
    expect(summary.monitorCount).toBe(1)
    expect(summary.belowStandardCount).toBe(1)
    expect(summary.passCount).toBe(1)
    expect(summary.naCount).toBe(1)
    expect(summary.itemsAssessed).toBe(6)
  })

  it('collects every critical finding, not just the first', () => {
    const summary = summarizeFindings(inspection([
      item({ itemId: 'C4', result: 'FAIL' }),
      item({ itemId: 'E1', result: 'FAIL' }),
      item({ itemId: 'D4', result: 'FAIL' }),
    ]))
    expect(summary.criticalFindings.sort()).toEqual(['C4', 'E1'])
  })

  it('counts N/A as assessed — the technician looked and logged it', () => {
    const summary = summarizeFindings(inspection([item({ itemId: 'C5', result: 'NA' })]))
    expect(summary.itemsAssessed).toBe(1)
    expect(summary.naCount).toBe(1)
  })

  it('distinguishes never-opened items from N/A', () => {
    const visible = checklist.filter((def) => ['C4', 'C5', 'C6'].includes(def.id))
    const summary = summarizeFindings(
      inspection([item({ itemId: 'C5', result: 'NA' })]),
      visible,
    )
    expect(summary.naCount).toBe(1)
    expect(summary.notAssessedCount).toBe(2) // C4 and C6 never opened
  })

  it('reports zero not-assessed when the visible list is fully covered', () => {
    const visible = checklist.filter((def) => def.id === 'C4')
    const summary = summarizeFindings(inspection([item({ itemId: 'C4' })]), visible)
    expect(summary.notAssessedCount).toBe(0)
  })

  it('returns an empty summary for an inspection with nothing recorded', () => {
    const summary = summarizeFindings(inspection([]))
    expect(summary.itemsAssessed).toBe(0)
    expect(summary.failCount).toBe(0)
    expect(summary.criticalFindings).toEqual([])
  })
})
