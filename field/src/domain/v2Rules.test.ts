/**
 * Client-side mirror of the protocol v2 hard rules. Must stay behaviorally
 * identical to the server's enforcement (app/src/services/protocolV2Ingest.ts)
 * — if these drift, inspections get stuck in the sync queue with a 422.
 */

import { describe, expect, it } from 'vitest'
import { checkCapture, checkItem, checkMeasurement, isLineSideEnergized, measurementTypesFor } from './v2Rules'
import { emptyV2Capture, type V2Enclosure, type V2Item } from './v2Types'

const SERVICE: V2Enclosure = { locationKey: 'svc', enclosureType: 'service_equipment', serviceSideEnergized: true }
const SUBPANEL: V2Enclosure = { locationKey: 'sub', enclosureType: 'subpanel', serviceSideEnergized: false }

const item = (over: Partial<V2Item>): V2Item => ({
  clientId: 'c1',
  componentType: 'lug',
  locationKey: 'sub',
  classification: 'pass',
  measurements: [],
  busVisual: null,
  ...over,
})

describe('§3.3 is per termination, not per enclosure', () => {
  it('defaults line-side component types to energized in a hot service enclosure', () => {
    expect(isLineSideEnergized({ componentType: 'lug' }, SERVICE)).toBe(true)
    expect(isLineSideEnergized({ componentType: 'service_entrance' }, SERVICE)).toBe(true)
  })

  it('a branch breaker in the same energized enclosure is load-side — torqueable', () => {
    expect(isLineSideEnergized({ componentType: 'breaker' }, SERVICE)).toBe(false)
    expect(measurementTypesFor('breaker', false)).toContain('torque')
  })

  it("the tech's explicit flag wins in both directions", () => {
    // Marked energized by hand — even in a de-energizable subpanel.
    expect(isLineSideEnergized({ componentType: 'lug', serviceSideEnergized: true }, SUBPANEL)).toBe(true)
    // Explicitly cleared — the qualified person says this one CAN be shut off.
    expect(isLineSideEnergized({ componentType: 'lug', serviceSideEnergized: false }, SERVICE)).toBe(false)
  })

  it('torque is refused only while the termination is energized', () => {
    const torque = { measurementType: 'torque' as const, measuredValue: 250, unit: 'in_lb' }
    expect(checkMeasurement(torque, true)?.rule).toBe('service_side_energized')
    expect(checkMeasurement(torque, false)).toBeNull()
  })

  it('never offers torque for an energized termination, always for a de-energized one', () => {
    expect(measurementTypesFor('lug', true)).not.toContain('torque')
    expect(measurementTypesFor('lug', false)).toContain('torque')
  })
})

describe('measurement rules mirror', () => {
  it('requires companion current on thermal readings', () => {
    const thermal = {
      measurementType: 'stab_thermal_delta_t' as const,
      measuredValue: 2,
      unit: 'C',
      comparativeReferenceItemId: 'neighbor',
    }
    expect(checkMeasurement(thermal, false)?.rule).toBe('companion_current_required')
    expect(checkMeasurement({ ...thermal, loadAmperageAtReading: 12 }, false)).toBeNull()
  })

  it('requires the comparative reference on delta-T readings', () => {
    const thermal = {
      measurementType: 'thermal_delta_t' as const,
      measuredValue: 2,
      unit: 'C',
      loadAmperageAtReading: 12,
    }
    expect(checkMeasurement(thermal, false)?.rule).toBe('comparative_reference_required')
  })
})

describe('item and capture checks', () => {
  it('bus components require the structured visual rubric', () => {
    const stab = item({ componentType: 'bus_stab' })
    expect(checkItem(stab, [SUBPANEL]).some((v) => v.rule === 'bus_visual_required')).toBe(true)
    const withRubric = item({
      componentType: 'bus_stab',
      busVisual: {
        corrosionLocation: 'bar_flat_non_contact',
        platingStatus: 'intact',
        materialLoss: 'none',
        arcSignature: 'none',
        adjacentPolymer: 'unaffected',
        heatTintMetal: 'none',
      },
    })
    expect(checkItem(withRubric, [SUBPANEL])).toHaveLength(0)
  })

  it('rule 6: a failed sample below 100% blocks the capture', () => {
    const capture = {
      ...emptyV2Capture(),
      samplingRecords: [
        { category: 'torque' as const, totalCount: 20, testedCount: 12, basis: '25%', expandedDueToFail: true },
      ],
    }
    expect(checkCapture(capture).some((v) => v.rule === 'sampling_expansion_incomplete')).toBe(true)
    capture.samplingRecords[0].testedCount = 20
    expect(checkCapture(capture)).toHaveLength(0)
  })
})
