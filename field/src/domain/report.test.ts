import { describe, expect, it } from 'vitest'
import { checklist, subPanelInstanceDef } from '../data/checklist'
import { NOT_ASSESSED, buildReport, mergePlaceholders, worstResult } from './report'
import type { Inspection, ItemResult, JurisdictionProfile } from './types'

const profile2017: JurisdictionProfile = {
  id: 'murfreesboro',
  label: 'Murfreesboro',
  necEdition: '2017',
  surgeRequired: false,
  metroAmendments: false,
  citationOverrides: {},
  requiredOverrides: { SPD: 'optional' },
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
        item({ itemId: 'LOAD', measured: { service_amps: 200, calc_load: 141 } }),
      ]),
      profile2017,
    )
    const load = report.items.find((r) => r.def.id === 'LOAD')
    expect(load?.whatWeFound).toContain('Calculated demand 141 A on a 200 A service')
  })

  it('renders coded option values as the prose label, not the stored token', () => {
    // Stored values are machine tokens. A customer report that reads
    // "meter base exterior corrosion_active" is not a document anyone would pay for.
    const report = buildReport(
      inspection([
        item({
          itemId: 'METER',
          measured: { mast_cond: 'secure', weatherhead: 'intact', meter_ext_cond: 'corrosion_active' },
        }),
      ]),
      profile2017,
    )
    const found = report.items.find((r) => r.def.id === 'METER')?.whatWeFound ?? ''
    expect(found).toContain('meter base exterior showing active corrosion')
    expect(found).not.toContain('corrosion_active')
  })

  it('falls back to an em dash when a cited reading was never taken', () => {
    const report = buildReport(inspection([item({ itemId: 'LOAD' })]), profile2017)
    expect(report.items[0].whatWeFound).toContain('— A')
  })

  it('mirrors the walk in the roll-ups — one per row, in order', () => {
    const report = buildReport(
      inspection([
        item({ itemId: 'GES', result: 'FAIL', resolutionNote: 'Add bar-to-bar bonding conductor' }),
        item({ itemId: 'HVAC', result: 'MONITOR' }),
      ]),
      profile2017,
    )

    expect(report.rollups.map((r) => r.id)).toEqual(checklist.map((def) => def.id))
    expect(report.rollups.find((r) => r.id === 'GES')?.status).toBe('FAIL')
    expect(report.rollups.find((r) => r.id === 'HVAC')?.status).toBe('MONITOR')
    expect(report.rollups.find((r) => r.id === 'GES')?.label).toBe('Grounding Electrode System')
  })

  it('reports an unassessed row as NOT_ASSESSED, not as passing', () => {
    // A row nobody looked at must never read as a clean bill of health.
    const report = buildReport(inspection([item({ itemId: 'GES' })]), profile2017)
    expect(report.rollups.find((r) => r.id === 'WH')?.status).toBe(NOT_ASSESSED)
  })

  it('rolls up an added sub-panel as its own row with its own title', () => {
    const garage = subPanelInstanceDef('Garage')
    const visible = [...checklist.slice(0, 4), garage, ...checklist.slice(4)]
    const report = buildReport(
      inspection([item({ itemId: garage.id, result: 'FAIL', locationId: 'Garage', resolutionNote: 'Separate neutrals' })]),
      profile2017,
      visible,
    )
    const row = report.rollups.find((r) => r.id === garage.id)
    expect(row?.status).toBe('FAIL')
    expect(row?.label).toBe('Interior Panel / Sub-Panel — Garage')
    // The instance resolves its def — the finding renders with the SUB reasoning.
    expect(report.sections.fail[0].def.title).toBe('Interior Panel / Sub-Panel — Garage')
  })

  it('raises the critical banner for a banner-listed FAIL', () => {
    const report = buildReport(
      inspection([item({ itemId: 'GES', result: 'FAIL' })]),
      profile2017,
    )
    expect(report.summary.criticalFindings).toEqual(['GES'])
  })

  it('does not raise the banner for a FAIL on an item that is not banner-listed', () => {
    const report = buildReport(
      inspection([item({ itemId: 'WH', result: 'FAIL' })]),
      profile2017,
    )
    expect(report.summary.criticalFindings).toEqual([])
  })

  it('sorts items into the sections the report renders in order', () => {
    const report = buildReport(
      inspection([
        item({ itemId: 'GES', result: 'FAIL' }),
        item({ itemId: 'HVAC', result: 'MONITOR' }),
        item({ itemId: 'SPD', result: 'BELOW_STANDARD' }),
        item({ itemId: 'WIRE', result: 'PASS' }),
        item({ itemId: 'SUB', result: 'NA' }),
      ]),
      profile2017,
    )

    expect(report.sections.fail.map((i) => i.def.id)).toEqual(['GES'])
    expect(report.sections.monitor.map((i) => i.def.id)).toEqual(['HVAC'])
    expect(report.sections.belowStandard.map((i) => i.def.id)).toEqual(['SPD'])
    expect(report.sections.pass.map((i) => i.def.id)).toEqual(['WIRE'])
    expect(report.sections.na.map((i) => i.def.id)).toEqual(['SUB'])
  })

  it('counts findings without producing a headline score', () => {
    const report = buildReport(
      inspection([
        item({ itemId: 'GES', result: 'FAIL' }),
        item({ itemId: 'MAIN', result: 'FAIL' }),
        item({ itemId: 'HVAC', result: 'MONITOR' }),
        item({ itemId: 'WIRE', result: 'PASS' }),
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
    const visible = checklist.filter((def) => ['GES', 'SPD', 'WIRE'].includes(def.id))
    const report = buildReport(inspection([item({ itemId: 'GES' })]), profile2017, visible)

    expect(report.notAssessed.map((i) => i.id).sort()).toEqual(['SPD', 'WIRE'])
    expect(report.summary.notAssessedCount).toBe(2)
  })

  it('treats N/A as assessed — the technician looked and recorded it', () => {
    const visible = checklist.filter((def) => ['SUB', 'SPD'].includes(def.id))
    const report = buildReport(
      inspection([item({ itemId: 'SUB', result: 'NA' })]),
      profile2017,
      visible,
    )
    expect(report.summary.naCount).toBe(1)
    expect(report.summary.notAssessedCount).toBe(1) // only SPD
  })

  it('reads a record written before ACTION was renamed FAIL', () => {
    const legacy = inspection([
      { itemId: 'GES', result: 'ACTION' as unknown as ItemResult['result'], measured: {}, photoIds: [] },
    ])
    const report = buildReport(legacy, profile2017)
    // The stored state is normalised on the way in, so the banner still fires.
    expect(report.sections.fail.map((i) => i.def.id)).toEqual(['GES'])
  })

  it('still names a retired pre-consolidation item on an old record', () => {
    const report = buildReport(
      inspection([item({ itemId: 'C4', result: 'FAIL' })]),
      profile2017,
    )
    expect(report.sections.fail[0].def.title).toBe('Main bonding jumper & EGC-bar bonding at the service')
  })

  it('carries the resolution note through to the fail section', () => {
    const report = buildReport(
      inspection([
        item({ itemId: 'WIRE', result: 'FAIL', resolutionNote: 'Install GFCI at the washer' }),
      ]),
      profile2017,
    )
    expect(report.sections.fail[0].result.resolutionNote).toBe('Install GFCI at the washer')
  })

  it('preserves the scope so the report can say which pass it covers', () => {
    const phase1: Inspection = { ...inspection([item({ itemId: 'GES' })]), scope: 'phase1' }
    expect(buildReport(phase1, profile2017).scope).toBe('phase1')
  })
})
