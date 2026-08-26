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
    expect(isCriticalFinding(item({ itemId: 'GES', result: 'FAIL' }))).toBe(true)
    expect(isCriticalFinding(item({ itemId: 'WIRE', result: 'FAIL' }))).toBe(true)
  })

  it('does not fire on a banner-listed item that only needs monitoring', () => {
    // The banner blocks delivery — a MONITOR is not a stop-work.
    expect(isCriticalFinding(item({ itemId: 'GES', result: 'MONITOR' }))).toBe(false)
    expect(isCriticalFinding(item({ itemId: 'GES', result: 'BELOW_STANDARD' }))).toBe(false)
    expect(isCriticalFinding(item({ itemId: 'GES', result: 'PASS' }))).toBe(false)
  })

  it('does not fire on a FAIL of an item that is not banner-listed', () => {
    expect(isCriticalFinding(item({ itemId: 'WH', result: 'FAIL' }))).toBe(false)
  })

  it('treats a sub-panel instance exactly like its base item', () => {
    // `SUB:garage` inherits SUB's banner listing (2026-08-26 consolidation).
    expect(isCriticalFinding(item({ itemId: 'SUB:garage', result: 'FAIL' }))).toBe(true)
    expect(isCriticalFinding(item({ itemId: 'SUB:garage', result: 'MONITOR' }))).toBe(false)
  })
})

describe('summarizeFindings', () => {
  it('counts each result state', () => {
    const summary = summarizeFindings(inspection([
      item({ itemId: 'GES', result: 'FAIL' }),
      item({ itemId: 'MAIN', result: 'FAIL' }),
      item({ itemId: 'HVAC', result: 'MONITOR' }),
      item({ itemId: 'SPD', result: 'BELOW_STANDARD' }),
      item({ itemId: 'WIRE', result: 'PASS' }),
      item({ itemId: 'SUB', result: 'NA' }),
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
      item({ itemId: 'GES', result: 'FAIL' }),
      item({ itemId: 'WIRE', result: 'FAIL' }),
      item({ itemId: 'WH', result: 'FAIL' }),
    ]))
    expect(summary.criticalFindings.sort()).toEqual(['GES', 'WIRE'])
  })

  it('counts N/A as assessed — the technician looked and logged it', () => {
    const summary = summarizeFindings(inspection([item({ itemId: 'SUB', result: 'NA' })]))
    expect(summary.itemsAssessed).toBe(1)
    expect(summary.naCount).toBe(1)
  })

  it('distinguishes never-opened items from N/A', () => {
    const visible = checklist.filter((def) => ['GES', 'SUB', 'SPD'].includes(def.id))
    const summary = summarizeFindings(
      inspection([item({ itemId: 'SUB', result: 'NA' })]),
      visible,
    )
    expect(summary.naCount).toBe(1)
    expect(summary.notAssessedCount).toBe(2) // GES and SPD never opened
  })

  it('reports zero not-assessed when the visible list is fully covered', () => {
    const visible = checklist.filter((def) => def.id === 'GES')
    const summary = summarizeFindings(inspection([item({ itemId: 'GES' })]), visible)
    expect(summary.notAssessedCount).toBe(0)
  })

  it('returns an empty summary for an inspection with nothing recorded', () => {
    const summary = summarizeFindings(inspection([]))
    expect(summary.itemsAssessed).toBe(0)
    expect(summary.failCount).toBe(0)
    expect(summary.criticalFindings).toEqual([])
  })
})
