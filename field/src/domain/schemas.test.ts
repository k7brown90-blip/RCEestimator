import { describe, expect, it } from 'vitest'
import { calculateLoad, type LoadCalcInput } from './loadcalc'
import { inspectionLoadCalcSchema, inspectionSchema } from './schemas'
import type { Inspection } from './types'

const loadCalcInput: LoadCalcInput = {
  mode: 'tech',
  occupancy: 'dwellingSingleFamily',
  serviceAmps: 200,
  serviceVoltage: 240,
  floorAreaSqFt: 2400,
  loads: [
    { id: 'l1', type: 'range', label: '12-kW range', nameplateKW: 12, volts: 240, nameplateRead: true },
    { id: 'l2', type: 'dryer', label: '5.5-kW dryer', nameplateKW: 5.5, volts: 240, nameplateRead: false },
    {
      id: 'l3', type: 'heatPump', label: 'heat pump',
      heatPump: { compressorVA: 7680, supplementalVA: 10000, lockout: false }, volts: 240,
    },
    { id: 'l4', type: 'arcWelder', label: 'welder', nameplateVA: 9600, dutyCyclePct: 20, volts: 240 },
  ],
  futureLoads: [{ id: 'f1', type: 'evse', label: 'EV charger', nameplateVA: 9600, volts: 240 }],
}

describe('load-calc persistence schemas', () => {
  it('validates a real engine result round-trip (input + result)', () => {
    const record = { input: loadCalcInput, result: calculateLoad(loadCalcInput) }
    expect(() => inspectionLoadCalcSchema.parse(record)).not.toThrow()
    // Parse output preserves the numbers exactly (no coercion drift):
    const parsed = inspectionLoadCalcSchema.parse(record)
    expect(parsed.result.governingAmps).toBe(record.result.governingAmps)
    expect(parsed.result.breakdown.length).toBe(record.result.breakdown.length)
  })

  it('validates an inspection with an attached load calc', () => {
    const inspection: Inspection = {
      id: 'i1',
      propertyId: 'p1',
      jurisdictionId: 'murfreesboro',
      technician: 'tech',
      date: '2026-07-25',
      items: [
        {
          itemId: 'A2',
          result: 'PASS',
          measured: { service_amps: 200, calc_load: 109 },
          photoIds: [],
        },
      ],
      score: 100,
      itemsAssessed: 1,
      criticalFindings: [],
      contractorReviewed: false,
      status: 'draft',
      loadCalc: { input: loadCalcInput, result: calculateLoad(loadCalcInput) },
    }
    expect(() => inspectionSchema.parse(inspection)).not.toThrow()
  })

  it('still validates an inspection without a load calc (optional field)', () => {
    const inspection: Inspection = {
      id: 'i2',
      propertyId: 'p1',
      jurisdictionId: 'murfreesboro',
      technician: 'tech',
      date: '2026-07-25',
      items: [],
      score: 100,
      itemsAssessed: 0,
      criticalFindings: [],
      contractorReviewed: false,
      status: 'draft',
    }
    expect(() => inspectionSchema.parse(inspection)).not.toThrow()
  })

  it('rejects malformed records (wrong voltage, unknown load type)', () => {
    expect(() =>
      inspectionLoadCalcSchema.parse({
        input: { ...loadCalcInput, serviceVoltage: 208 },
        result: calculateLoad(loadCalcInput),
      }),
    ).toThrow()
    expect(() =>
      inspectionLoadCalcSchema.parse({
        input: {
          ...loadCalcInput,
          loads: [{ id: 'x', type: 'flumCapacitor', label: 'bad' }],
        },
        result: calculateLoad(loadCalcInput),
      }),
    ).toThrow()
  })
})
