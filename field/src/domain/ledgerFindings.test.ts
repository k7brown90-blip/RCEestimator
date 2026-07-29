import { describe, expect, it } from 'vitest'
import { buildLedgerFindings, trackFor } from './ledgerFindings'
import { buildReport } from './report'
import type { Inspection, ItemResult, JurisdictionProfile } from './types'

const profile2017: JurisdictionProfile = {
  id: 'murfreesboro',
  label: 'Murfreesboro',
  necEdition: '2017',
  surgeRequired: false,
  metroAmendments: false,
  citationOverrides: {},
  requiredOverrides: {},
}

const profile2023: JurisdictionProfile = {
  ...profile2017,
  id: 'franklin',
  label: 'Franklin',
  necEdition: '2023',
  surgeRequired: true,
  citationOverrides: { E1: ['210.8(A) as expanded in the 2023 NEC'] },
}

const item = (partial: Partial<ItemResult> & { itemId: string }): ItemResult => ({
  result: 'PASS',
  measured: {},
  photoIds: [],
  ...partial,
})

const inspection = (items: ItemResult[]): Inspection => ({
  id: 'i1',
  propertyId: 'p1',
  jurisdictionId: 'murfreesboro',
  technician: 'tech',
  date: '2026-08-01',
  items,
  scope: 'phase1',
  itemsAssessed: items.length,
  criticalFindings: [],
  contractorReviewed: false,
  status: 'complete',
})

const findingsFor = (items: ItemResult[], profile = profile2017) =>
  buildLedgerFindings(buildReport(inspection(items), profile))

describe('trackFor', () => {
  it('splits code defects from planned work', () => {
    // One system corrects violations and hazards; the other offers upgrades.
    // Collapsing them would let a sales follow-up wear a violation's language.
    expect(trackFor('FAIL')).toBe('defect')
    expect(trackFor('MONITOR')).toBe('upgrade')
    expect(trackFor('BELOW_STANDARD')).toBe('upgrade')
  })
})

describe('buildLedgerFindings', () => {
  it('ledgers only what needs following up', () => {
    const findings = findingsFor([
      item({ itemId: 'C4', result: 'FAIL', resolutionNote: 'Bar-to-bar conductor' }),
      item({ itemId: 'H2', result: 'MONITOR' }),
      item({ itemId: 'C7', result: 'BELOW_STANDARD' }),
      item({ itemId: 'C6', result: 'PASS' }),
      item({ itemId: 'D5', result: 'NA' }),
    ])
    expect(findings.map((f) => f.itemId).sort()).toEqual(['C4', 'C7', 'H2'])
  })

  it('never sends PASS as a finding', () => {
    // A later PASS is evidence the office weighs, not a finding. Shipping it as
    // one would invite something downstream to treat it as a cure.
    expect(findingsFor([item({ itemId: 'C4', result: 'PASS' })])).toEqual([])
  })

  it('carries the title and citations, because the server has no checklist', () => {
    const [finding] = findingsFor([item({ itemId: 'C4', result: 'FAIL' })])
    expect(finding.title).toContain('Main bonding jumper')
    expect(finding.citations.length).toBeGreaterThan(0)
    expect(finding.section).toContain('Grounding')
  })

  it("snapshots the jurisdiction's citation override, not the checklist default", () => {
    // A finding documented under the 2023 scope must recite the 2023 scope
    // forever, whatever the county adopts next.
    const [finding] = findingsFor([item({ itemId: 'E1', result: 'FAIL' })], profile2023)
    expect(finding.citations).toEqual(['210.8(A) as expanded in the 2023 NEC'])
  })

  it('marks a banner-listed FAIL critical and an ordinary one not', () => {
    const [critical] = findingsFor([item({ itemId: 'C4', result: 'FAIL' })])
    const [ordinary] = findingsFor([item({ itemId: 'D4', result: 'FAIL' })])
    expect(critical.critical).toBe(true)
    expect(ordinary.critical).toBe(false)
  })

  it('carries the rendered finding text, with the readings already merged in', () => {
    const [finding] = findingsFor([
      item({
        itemId: 'H2',
        result: 'MONITOR',
        measured: { install_year: 1994, make_model: 'Square D QO', condition: 'surface_rust' },
        computed: { age: 32 },
      }),
    ])
    expect(finding.findingText).toContain('1994')
    expect(finding.findingText).toContain('32')
    // Option values render as prose, never as their stored token.
    expect(finding.findingText).toContain('showing surface rust')
    expect(finding.findingText).not.toContain('surface_rust')
  })

  it('dates end of life on the upgrade track from the equipment year', () => {
    const [finding] = findingsFor([
      item({ itemId: 'H2', result: 'MONITOR', measured: { install_year: 1994 } }),
    ])
    expect(finding.track).toBe('upgrade')
    expect(finding.expectedEolYear).toBe(2024) // 1994 + 30-year rated life
  })

  it('leaves end of life off a defect', () => {
    const [finding] = findingsFor([
      item({ itemId: 'H2', result: 'FAIL', measured: { install_year: 1994 } }),
    ])
    expect(finding.track).toBe('defect')
    expect(finding.expectedEolYear).toBeUndefined()
  })

  it('gives an unlocated finding the server-side default key', () => {
    // Postgres treats NULLs as distinct in a unique index, so a blank key would
    // silently duplicate every Phase 1 row.
    const [finding] = findingsFor([item({ itemId: 'C4', result: 'FAIL' })])
    expect(finding.locationKey).toBe('_default')
    expect(finding.locationId).toBeUndefined()
  })

  it('keeps the location when one was recorded', () => {
    const [finding] = findingsFor([
      item({ itemId: 'D2', result: 'FAIL', locationId: 'sub-garage' }),
    ])
    expect(finding.locationKey).toBe('sub-garage')
    expect(finding.locationId).toBe('sub-garage')
  })

  it('carries the resolution and photo evidence a FAIL is required to have', () => {
    const [finding] = findingsFor([
      item({
        itemId: 'C4',
        result: 'FAIL',
        resolutionNote: 'Install #6 Cu bar to bar.',
        photoIds: ['photo-1', 'photo-2'],
        note: 'Bars were separated by a previous installer.',
      }),
    ])
    expect(finding.resolutionNote).toBe('Install #6 Cu bar to bar.')
    expect(finding.photoIds).toEqual(['photo-1', 'photo-2'])
    expect(finding.note).toContain('previous installer')
  })
})
