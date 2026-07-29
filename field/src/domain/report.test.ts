import { describe, expect, it } from 'vitest'
import { checklist } from '../data/checklist'
import { NOT_ASSESSED, buildReport, mergePlaceholders, worstResult } from './report'
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
    scope: 'full',
    itemsAssessed: items.length,
    criticalFindings: [],
    contractorReviewed: false,
    status: 'draft',
  }
}

describe('worstResult', () => {
  it('orders FAIL > MONITOR > BELOW_STANDARD > PASS > NA', () => {
    expect(worstResult(['PASS', 'MONITOR', 'FAIL'])).toBe('FAIL')
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
  it('merges measured values into whatWeFound', () => {
    const report = buildReport(
      inspection([
        item({
          itemId: 'C1',
          measured: { electrode_types: ['rod'], ground_ohms: 18, rod_count: 2, supp_state: 'present' },
        }),
      ]),
      profile2017,
    )
    const c1 = report.items.find((r) => r.def.id === 'C1')
    expect(c1?.whatWeFound).toContain('Measured 18 Ω to earth (25 Ω limit) across 2 rod(s)')
  })

  it('renders coded option values as the prose label, not the stored token', () => {
    // Stored values are machine tokens. A customer report that reads
    // "connection irrev_crimp" is not a document anyone would pay for.
    const report = buildReport(
      inspection([
        item({
          itemId: 'C1',
          measured: { electrode_types: ['rod', 'ufer'], gec_size: '6cu', gec_conn: 'irrev_crimp' },
        }),
      ]),
      profile2017,
    )
    const found = report.items.find((r) => r.def.id === 'C1')?.whatWeFound ?? ''
    expect(found).toContain('driven rod(s), a concrete-encased (Ufer) electrode')
    expect(found).toContain('GEC #6 Cu')
    expect(found).toContain('connection an irreversible crimp')
    expect(found).not.toContain('irrev_crimp')
  })

  it('resolves a {ITEM.field} token from the item that actually recorded it', () => {
    // C1 cites the service rating, which is recorded on A2. Without the
    // cross-item tier the report reads "for a — A service".
    const report = buildReport(
      inspection([
        item({ itemId: 'A2', measured: { service_amps: 200, calc_load: 141 } }),
        item({ itemId: 'C1', measured: { gec_size: '4cu' } }),
      ]),
      profile2017,
    )
    expect(report.items.find((r) => r.def.id === 'C1')?.whatWeFound).toContain(
      'GEC #4 Cu for a 200 A service',
    )
  })

  it('falls back to an em dash when the cited item was never assessed', () => {
    const report = buildReport(inspection([item({ itemId: 'C1' })]), profile2017)
    expect(report.items[0].whatWeFound).toContain('for a — A service')
  })

  it('interpolates formula outputs, which live on computed rather than measured', () => {
    const report = buildReport(
      inspection([
        item({
          itemId: 'G3',
          measured: { leg_a: 42, leg_b: 30 },
          computed: { imbalance_pct: 29, neutral_amps: 12 },
        }),
      ]),
      profile2017,
    )
    const found = report.items[0].whatWeFound
    expect(found).toContain('(29% imbalance)')
    expect(found).toContain('calculated neutral current 12 A')
  })

  it('sets each roll-up to the worst result among its assessed children', () => {
    const report = buildReport(
      inspection([
        item({ itemId: 'C1' }),
        item({ itemId: 'C4', result: 'FAIL', resolutionNote: 'Add bar-to-bar bonding conductor' }),
        item({ itemId: 'F1', result: 'MONITOR' }),
      ]),
      profile2017,
    )

    expect(report.rollups.find((r) => r.id === 'grounding-bonding')?.status).toBe('FAIL')
    expect(report.rollups.find((r) => r.id === 'branch-protection')?.status).toBe('MONITOR')
  })

  it('reports a roll-up with nothing assessed as NOT_ASSESSED, not as passing', () => {
    // A section nobody looked at must never read as a clean bill of health.
    const report = buildReport(inspection([item({ itemId: 'C4' })]), profile2017)
    expect(report.rollups.find((r) => r.id === 'disconnects-safety')?.status).toBe(NOT_ASSESSED)
  })

  it('raises the critical banner for a banner-listed FAIL', () => {
    const report = buildReport(
      inspection([item({ itemId: 'C4', result: 'FAIL' })]),
      profile2017,
    )
    expect(report.summary.criticalFindings).toEqual(['C4'])
  })

  it('does not raise the banner for a FAIL on an item that is not banner-listed', () => {
    const report = buildReport(
      inspection([item({ itemId: 'D4', result: 'FAIL' })]),
      profile2017,
    )
    expect(report.summary.criticalFindings).toEqual([])
  })

  it('sorts items into the sections the report renders in order', () => {
    const report = buildReport(
      inspection([
        item({ itemId: 'C4', result: 'FAIL' }),
        item({ itemId: 'F1', result: 'MONITOR' }),
        item({ itemId: 'E3', result: 'BELOW_STANDARD' }),
        item({ itemId: 'H1', result: 'PASS' }),
        item({ itemId: 'C5', result: 'NA' }),
      ]),
      profile2017,
    )

    expect(report.sections.fail.map((i) => i.def.id)).toEqual(['C4'])
    expect(report.sections.monitor.map((i) => i.def.id)).toEqual(['F1'])
    expect(report.sections.belowStandard.map((i) => i.def.id)).toEqual(['E3'])
    expect(report.sections.pass.map((i) => i.def.id)).toEqual(['H1'])
    expect(report.sections.na.map((i) => i.def.id)).toEqual(['C5'])
  })

  it('counts findings without producing a headline score', () => {
    const report = buildReport(
      inspection([
        item({ itemId: 'C4', result: 'FAIL' }),
        item({ itemId: 'C6', result: 'FAIL' }),
        item({ itemId: 'F1', result: 'MONITOR' }),
        item({ itemId: 'H1', result: 'PASS' }),
      ]),
      profile2017,
    )

    expect(report.summary.failCount).toBe(2)
    expect(report.summary.monitorCount).toBe(1)
    expect(report.summary.passCount).toBe(1)
    expect(report).not.toHaveProperty('score')
    expect(report).not.toHaveProperty('band')
  })

  it('lists visible items the technician never opened', () => {
    const visible = checklist.filter((def) => ['C4', 'C6', 'H1'].includes(def.id))
    const report = buildReport(inspection([item({ itemId: 'C4' })]), profile2017, visible)

    expect(report.notAssessed.map((i) => i.id).sort()).toEqual(['C6', 'H1'])
    expect(report.summary.notAssessedCount).toBe(2)
  })

  it('treats N/A as assessed — the technician looked and recorded it', () => {
    const visible = checklist.filter((def) => ['C5', 'C6'].includes(def.id))
    const report = buildReport(
      inspection([item({ itemId: 'C5', result: 'NA' })]),
      profile2017,
      visible,
    )
    expect(report.summary.naCount).toBe(1)
    expect(report.summary.notAssessedCount).toBe(1) // only C6
  })

  it('reads a record written before ACTION was renamed FAIL', () => {
    const legacy = inspection([
      { itemId: 'C4', result: 'ACTION' as unknown as ItemResult['result'], measured: {}, photoIds: [] },
    ])
    const report = buildReport(legacy, profile2017)
    // The stored state is normalised on the way in, so the banner still fires.
    expect(report.sections.fail.map((i) => i.def.id)).toEqual(['C4'])
  })

  it('carries the resolution note through to the fail section', () => {
    const report = buildReport(
      inspection([
        item({ itemId: 'E1', result: 'FAIL', resolutionNote: 'Install GFCI at the washer' }),
      ]),
      profile2017,
    )
    expect(report.sections.fail[0].result.resolutionNote).toBe('Install GFCI at the washer')
  })

  it('preserves the scope so the report can say which pass it covers', () => {
    const phase1: Inspection = { ...inspection([item({ itemId: 'C4' })]), scope: 'phase1' }
    expect(buildReport(phase1, profile2017).scope).toBe('phase1')
  })
})
