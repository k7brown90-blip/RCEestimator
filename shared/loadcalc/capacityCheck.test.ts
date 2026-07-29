import { describe, expect, it } from 'vitest'
import {
  capacityCheck220_83,
  existingDemandAmps,
  existingDwellingAmps,
  type DemandRecord,
  type LoadCalcInput,
  type LoadItem,
} from './loadcalc'

/**
 * 220.83 is the calculation this business runs constantly: an existing house,
 * a customer who wants to add something, and one question — does the service
 * take it? 220.87 is the exception behind it, and these tests hold the line
 * between them.
 */

const load = (partial: Partial<LoadItem> & { id: string; type: LoadItem['type']; label: string }): LoadItem => ({
  ...partial,
} as LoadItem)

/** A plain 1970s ranch on a 100 A service. */
const existingHome = (serviceAmps = 100): LoadCalcInput => ({
  mode: 'tech',
  occupancy: 'dwellingSingleFamily',
  serviceAmps,
  serviceVoltage: 240,
  floorAreaSqFt: 1500,
  loads: [
    load({ id: 'sa1', type: 'smallAppliance', label: 'Small appliance 1' }),
    load({ id: 'sa2', type: 'smallAppliance', label: 'Small appliance 2' }),
    load({ id: 'la', type: 'laundry', label: 'Laundry' }),
    load({ id: 'range', type: 'range', label: 'Range', nameplateKW: 12, nameplateRead: true }),
    load({ id: 'dryer', type: 'dryer', label: 'Dryer', nameplateKW: 5, nameplateRead: true }),
    load({ id: 'wh', type: 'waterHeaterTank', label: 'Water heater', nameplateKW: 4.5, nameplateRead: true }),
    load({ id: 'ac', type: 'cooling', label: 'Central A/C', nameplateVA: 5760, nameplateRead: true }),
  ],
})

const evse = load({
  id: 'evse', type: 'evse', label: '48 A EVSE', amps: 48, volts: 240, nameplateRead: true,
})

describe('capacityCheck220_83', () => {
  it('answers the question the customer actually asked', () => {
    const check = capacityCheck220_83(existingHome(200), [evse])
    expect(check.method).toBe('220.83')
    expect(check.serviceAmps).toBe(200)
    expect(check.spareAmps).toBe(200 - check.amps)
    expect(check.fits).toBe(check.amps <= 200)
  })

  it('counts the new load — the whole point of running it', () => {
    // The bug this replaced computed variant A with an empty new-load list, so
    // adding a 48 A EVSE changed nothing at all.
    const without = capacityCheck220_83(existingHome(200), [])
    const withEvse = capacityCheck220_83(existingHome(200), [evse])
    expect(withEvse.totalVA).toBeGreaterThan(without.totalVA)
  })

  it('switches to (B) when the new load is air conditioning or space heat', () => {
    const heatPump = load({
      id: 'hp', type: 'heatPump', label: 'New heat pump',
      heatPump: { compressorVA: 5000, supplementalVA: 10000, lockout: true },
      nameplateRead: true,
    })
    expect(capacityCheck220_83(existingHome(200), [evse]).variant).toBe('A')
    expect(capacityCheck220_83(existingHome(200), [heatPump]).variant).toBe('B')
  })

  it('cites the variant it actually used', () => {
    expect(capacityCheck220_83(existingHome(), []).citation).toContain('220.83(A)')
    const heat = load({ id: 'h', type: 'spaceHeat', label: 'New baseboard', nameplateKW: 10, nameplateRead: true })
    expect(capacityCheck220_83(existingHome(), [heat]).citation).toContain('220.83(B)')
  })

  it('values new general lighting instead of silently zeroing it', () => {
    // lightingVA read only input.loads, so an addition's lighting contributed
    // nothing — the calculation understated every remodel.
    const addition = load({
      id: 'add', type: 'generalLighting', label: 'Addition lighting', nameplateVA: 1800, nameplateRead: true,
    })
    const without = capacityCheck220_83(existingHome(200), [])
    const withAddition = capacityCheck220_83(existingHome(200), [addition])
    expect(withAddition.totalVA).toBeGreaterThan(without.totalVA)
  })

  it('explains itself — every applied VA appears in the breakdown', () => {
    const check = capacityCheck220_83(existingHome(200), [evse])
    expect(check.breakdown.length).toBeGreaterThan(3)
    // The staging line carries the final figure, so the reader can follow the
    // arithmetic from connected load to calculated load.
    const staged = check.breakdown[check.breakdown.length - 1]
    expect(staged.appliedVA).toBe(check.totalVA)
  })

  it('names the loads that were guessed rather than read off a plate', () => {
    const guessed = existingHome(200)
    guessed.loads = guessed.loads.map((l) =>
      l.id === 'wh' ? { ...l, nameplateRead: false } : l,
    )
    const check = capacityCheck220_83(guessed, [])
    expect(check.assumedValues).toContain('Water heater')
    expect(check.assumedValues).not.toContain('Range')
  })

  it('is deterministic — no ids, no clock, no I/O', () => {
    // loadcalc.test.ts asserts this for calculateLoad; the same contract has to
    // hold here, or the persistence layer starts writing non-reproducible rows.
    const first = capacityCheck220_83(existingHome(200), [evse])
    for (let i = 0; i < 25; i += 1) {
      expect(capacityCheck220_83(existingHome(200), [evse])).toEqual(first)
    }
  })

  it('keeps existingDwellingAmps callable without new loads, as calculateLoad does', () => {
    const result = existingDwellingAmps(existingHome())
    expect(result.variant).toBe('A')
    expect(result.amps).toBeGreaterThan(0)
    expect(Array.isArray(result.breakdown)).toBe(true)
  })
})

describe('existingDemandAmps (220.87)', () => {
  const twelveMonths: DemandRecord = {
    source: 'utility_12mo',
    measuredMaxDemandVA: 14400,
    monthsOfData: 12,
    intervalMinutes: 15,
  }

  it('takes 125% of the measured demand plus the new load at nameplate', () => {
    const check = existingDemandAmps(twelveMonths, [evse], 100, 240)
    expect(check.existingDemandVA).toBe(18000) // 14 400 × 1.25
    expect(check.newLoadVA).toBe(11520) // 48 A × 240 V
    expect(check.totalVA).toBe(29520)
    expect(check.amps).toBe(123)
    expect(check.fits).toBe(false)
  })

  it('qualifies on a complete 12-month record', () => {
    const check = existingDemandAmps(twelveMonths, [], 200, 240)
    expect(check.qualifies).toBe(true)
    expect(check.disqualifications).toEqual([])
  })

  it('refuses short utility data', () => {
    const check = existingDemandAmps({ ...twelveMonths, monthsOfData: 9 }, [], 200, 240)
    expect(check.qualifies).toBe(false)
    expect(check.disqualifications[0]).toContain('12 consecutive months')
  })

  it('refuses a recording shorter than 30 days', () => {
    const check = existingDemandAmps(
      { source: 'recorded_30day', measuredMaxDemandVA: 12000, recordedDays: 21, intervalMinutes: 15 },
      [], 200, 240,
    )
    expect(check.qualifies).toBe(false)
    expect(check.disqualifications[0]).toContain('30-day')
  })

  it('refuses the wrong demand interval', () => {
    const check = existingDemandAmps({ ...twelveMonths, intervalMinutes: 60 }, [], 200, 240)
    expect(check.qualifies).toBe(false)
    expect(check.disqualifications.some((d) => d.includes('15-minute'))).toBe(true)
  })

  it('states seasonal and occupancy limits without blocking on them', () => {
    // These are judgement calls, not code failures. The engine says them; an
    // electrician decides.
    const check = existingDemandAmps(
      { ...twelveMonths, source: 'recorded_30day', recordedDays: 30, windowStart: '2026-10-03', windowEnd: '2026-11-02' },
      [], 200, 240,
    )
    expect(check.qualifies).toBe(true)
    expect(check.limitations.some((l) => l.includes('occupancy'))).toBe(true)
    expect(check.limitations.some((l) => l.includes('2026-10-03'))).toBe(true)
  })

  it('is deterministic', () => {
    const first = existingDemandAmps(twelveMonths, [evse], 100, 240)
    for (let i = 0; i < 25; i += 1) {
      expect(existingDemandAmps(twelveMonths, [evse], 100, 240)).toEqual(first)
    }
  })
})
