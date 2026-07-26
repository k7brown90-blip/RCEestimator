import { describe, expect, it } from 'vitest'
import { bandFor, buildReport, mergePlaceholders, worstResult } from './report'
import type { Inspection, ItemResult, JurisdictionProfile } from './types'

const profile2017: JurisdictionProfile = {
  id: 'murfreesboro',
  label: 'Murfreesboro',
  necEdition: '2017',
  surgeRequired: false,
  metroAmendments: false,
  citationOverrides: {},
  requiredOverrides: { E3: 'optional' },
}

function item(partial: Partial<ItemResult> & { itemId: string }): ItemResult {
  return { result: 'PASS', measured: {}, photoIds: [], ...partial }
}

function inspection(items: ItemResult[]): Inspection {
  return {
    id: 'i1',
    propertyId: 'p1',
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

describe('bandFor', () => {
  it('maps the published bands', () => {
    expect(bandFor(95, false)).toBe('Excellent')
    expect(bandFor(90, false)).toBe('Excellent')
    expect(bandFor(89, false)).toBe('Good / Serviceable')
    expect(bandFor(75, false)).toBe('Good / Serviceable')
    expect(bandFor(74, false)).toBe('Needs attention')
    expect(bandFor(60, false)).toBe('Needs attention')
    expect(bandFor(59, false)).toBe('Priority')
  })

  it('never reads better than Needs attention with a critical finding', () => {
    expect(bandFor(69, true)).toBe('Needs attention')
    expect(bandFor(40, true)).toBe('Priority')
  })
})

describe('worstResult', () => {
  it('orders ACTION > MONITOR > BELOW_STANDARD > PASS > NA', () => {
    expect(worstResult(['PASS', 'MONITOR', 'ACTION'])).toBe('ACTION')
    expect(worstResult(['PASS', 'BELOW_STANDARD'])).toBe('BELOW_STANDARD')
    expect(worstResult(['NA', 'PASS'])).toBe('PASS')
    expect(worstResult(['NA'])).toBe('NA')
  })
})

describe('mergePlaceholders', () => {
  it('prefers measured values, falls back to context, then em dash', () => {
    const merged = mergePlaceholders(
      'Reading {ground_ohms} Ω; {plain_result}; missing {unknown}.',
      { ground_ohms: 18 },
      { plain_result: 'meets requirements' },
    )
    expect(merged).toBe('Reading 18 Ω; meets requirements; missing —.')
  })
})

describe('buildReport', () => {
  it('merges measured values into whatWeFound and sets roll-up colors by worst child', () => {
    const report = buildReport(
      inspection([
        item({ itemId: 'C2', measured: { ground_ohms: 18, rod_count: 2, supp_state: 'present' } }),
        item({ itemId: 'C4', result: 'ACTION' }),
        item({ itemId: 'F1', result: 'MONITOR' }),
        item({ itemId: 'H1' }),
      ]),
      profile2017,
    )

    const c2 = report.items.find((r) => r.def.id === 'C2')
    expect(c2?.whatWeFound).toContain('18 Ω (limit 25 Ω), 2 rod(s), supplemental present')

    const grounding = report.rollups.find((r) => r.id === 'grounding-bonding')
    expect(grounding?.status).toBe('ACTION')
    const devices = report.rollups.find((r) => r.id === 'devices-wiring')
    expect(devices?.status).toBe('MONITOR')

    // C4 ACTION is banner-listed → critical + capped band
    expect(report.score.criticalFindings).toEqual(['C4'])
    expect(report.score.score).toBeLessThanOrEqual(69)
  })

  it('states the honesty line', () => {
    const report = buildReport(inspection([item({ itemId: 'H1' })]), profile2017)
    expect(report.honestyLine).toContain('severity, likelihood')
  })
})
