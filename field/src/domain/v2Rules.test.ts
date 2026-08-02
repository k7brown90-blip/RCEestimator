/**
 * Client-side mirror of the protocol v2 hard rules. Must stay behaviorally
 * identical to the server's enforcement (app/src/services/protocolV2Ingest.ts)
 * — if these drift, inspections get stuck in the sync queue with a 422.
 */

import { describe, expect, it } from 'vitest'
import { checkCapture, checkItem, checkMeasurement, measurementTypesFor } from './v2Rules'
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

describe('measurement rules mirror', () => {
  it('refuses torque on a service-side energized enclosure, allows it load-side', () => {
    const torque = { measurementType: 'torque' as const, measuredValue: 250, unit: 'in_lb' }
    expect(checkMeasurement(torque, SERVICE)?.rule).toBe('service_side_energized')
    expect(checkMeasurement(torque, SUBPANEL)).toBeNull()
  })

  it('requires companion current on thermal readings', () => {
    const thermal = {
      measurementType: 'stab_thermal_delta_t' as const,
      measuredValue: 2,
      unit: 'C',
      comparativeReferenceItemId: 'neighbor',
    }
    expect(checkMeasurement(thermal, SUBPANEL)?.rule).toBe('companion_current_required')
    expect(checkMeasurement({ ...thermal, loadAmperageAtReading: 12 }, SUBPANEL)).toBeNull()
  })

  it('requires the comparative reference on delta-T readings', () => {
    const thermal = {
      measurementType: 'thermal_delta_t' as const,
      measuredValue: 2,
      unit: 'C',
      loadAmperageAtReading: 12,
    }
    expect(checkMeasurement(thermal, SUBPANEL)?.rule).toBe('comparative_reference_required')
  })

  it('never offers torque for components on an energized service side', () => {
    expect(measurementTypesFor('lug', SERVICE)).not.toContain('torque')
    expect(measurementTypesFor('lug', SUBPANEL)).toContain('torque')
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
