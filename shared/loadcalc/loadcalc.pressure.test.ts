// Pressure test — three realistic dwellings, every expectation hand-calculated
// independently from the NEC rules before running the engine.
import { describe, expect, it } from 'vitest'
import { calculateLoad, existingDwellingAmps, type LoadCalcInput, type LoadItem } from './loadcalc'

let n = 0
function load(partial: Partial<LoadItem> & { type: LoadItem['type']; label: string }): LoadItem {
  n += 1
  return { id: `p${n}`, nameplateRead: true, ...partial }
}

const base = (partial: Partial<LoadCalcInput>): LoadCalcInput => ({
  mode: 'tech',
  occupancy: 'dwellingSingleFamily',
  serviceAmps: 200,
  serviceVoltage: 240,
  floorAreaSqFt: 2400,
  loads: [],
  ...partial,
})

const circuits = () => [
  load({ type: 'smallAppliance', label: 'SA 1' }),
  load({ type: 'smallAppliance', label: 'SA 2' }),
  load({ type: 'laundry', label: 'Laundry' }),
  load({ type: 'bathroomCircuit', label: 'Bathroom circuit' }),
]

describe('Pressure test 1 — 2005 suburban home, gas heat/WH, 200 A, adding a 48 A EV charger', () => {
  // 2400 ft²; 12-kW range; electric dryer 5.5 kW; DW 1.2 kW, disposal 0.9 kW,
  // microwave 1.5 kW, garage-door opener 0.5 kW (all 120 V); 4-ton A/C 28 A RLA.
  // Gas furnace & gas WH (their electronics/blower ride inside the gas appliance —
  // no electric heat line).
  const home = () =>
    base({
      loads: [
        ...circuits(),
        load({ type: 'range', label: '12-kW range', nameplateKW: 12, volts: 240 }),
        load({ type: 'dryer', label: '5.5-kW dryer', nameplateKW: 5.5, volts: 240 }),
        load({ type: 'fixedAppliance', label: 'dishwasher 1.2 kW', nameplateVA: 1200, volts: 120 }),
        load({ type: 'fixedAppliance', label: 'disposal 0.9 kW', nameplateVA: 900, volts: 120 }),
        load({ type: 'fixedAppliance', label: 'microwave 1.5 kW', nameplateVA: 1500, volts: 120 }),
        load({ type: 'fixedAppliance', label: 'garage door opener 0.5 kW', nameplateVA: 500, volts: 120 }),
        load({ type: 'cooling', label: '4-ton A/C, 28 A RLA', amps: 28, volts: 240 }),
      ],
      futureLoads: [load({ type: 'evse', label: '11.5-kW (48 A) EV charger', nameplateVA: 11500, volts: 240 })],
    })

  it('Optional: 33,300 VA general → 19,320 staged + 6,720 A/C = 26,040 VA → 109 A', () => {
    const r = calculateLoad(home())
    expect(r.optionalVA).toBe(26040)
    expect(r.optionalAmps).toBe(109)
    expect(r.methodUsed).toBe('optional')
    expect(r.spareAmps).toBe(91)
    expect(r.loadPct).toBe(54.5)
  })

  it('Standard: 6,045 bucket + 8,000 range + 5,500 dryer + 3,075 appliances(75%) + 6,720 A/C + 1,680 compressor adder = 31,020 VA → 129 A', () => {
    const r = calculateLoad(home())
    expect(r.standardVA).toBe(31020)
    expect(r.standardAmps).toBe(129)
  })

  it('Neutral: 6,045 + 5,600 range(70%) + 3,850 dryer(70%) + 3,075 (120 V appliances @75%) = 18,570 VA → 77 A', () => {
    const r = calculateLoad(home())
    expect(r.neutralVA).toBe(18570)
    expect(r.neutralAmps).toBe(77)
  })

  it('EV charger verdict: 109 + 59.9 (47.9 A × 1.25 continuous) = 168.9 A — fits per 230.42, would FAIL a blanket-80% shop', () => {
    const r = calculateLoad(home())
    const ev = r.futureLoadFindings[0]
    expect(ev.addedAmps).toBeCloseTo((11500 / 240) * 1.25, 3) // 59.9 A
    expect(ev.fitsCode).toBe(true) // 168.9 ≤ 200 — the defensible answer
    expect(ev.fitsConservative).toBe(false) // 168.9 > 160 — the blanket-80% shop says "upgrade"
    expect(ev.verdict).toContain('capacity available (per 230.42)')
  })
})

describe('Pressure test 2 — 1965 all-electric ranch, 100 A, tankless WH inquiry', () => {
  // 1100 ft²; 8-kW range; 4.5-kW WH; 5.6-kW dryer; 1.2-kW DW (120 V);
  // 10-kW electric furnace (single unit); two 8-A 240-V window A/Cs.
  const home = () =>
    base({
      serviceAmps: 100,
      floorAreaSqFt: 1100,
      loads: [
        ...circuits(),
        load({ type: 'range', label: '8-kW range', nameplateKW: 8, volts: 240 }),
        load({ type: 'waterHeaterTank', label: '4.5-kW water heater', nameplateKW: 4.5, volts: 240 }),
        load({ type: 'dryer', label: '5.6-kW dryer', nameplateKW: 5.6, volts: 240 }),
        load({ type: 'fixedAppliance', label: 'dishwasher 1.2 kW', nameplateVA: 1200, volts: 120 }),
        load({ type: 'spaceHeat', label: '10-kW electric furnace', nameplateKW: 10, volts: 240, separatelyControlledUnits: 1 }),
        load({ type: 'cooling', label: 'window A/C 1 (8 A)', amps: 8, volts: 240 }),
        load({ type: 'cooling', label: 'window A/C 2 (8 A)', amps: 8, volts: 240 }),
      ],
      futureLoads: [load({ type: 'waterHeaterTankless', label: '18-kW tankless water heater', nameplateVA: 18000, volts: 240 })],
    })

  it('Optional: 27,100 general → 16,840 staged + 6,500 heat (65%, <4 units, beats 3,840 A/C) = 23,340 VA → 97 A — a genuinely tight house', () => {
    const r = calculateLoad(home())
    expect(r.optionalVA).toBe(23340)
    expect(r.optionalAmps).toBe(97)
    expect(r.governingAmps).toBe(97) // 100 A service still qualifies for Optional
    expect(r.spareAmps).toBe(3)
    expect(r.loadPct).toBe(97)
  })

  it('Standard: 4,680 bucket + 8,000 range + 5,600 dryer + 5,700 appliances(<4, 100%) + 10,000 heat (beats A/C, no compressor adder) = 33,980 VA → 142 A', () => {
    const r = calculateLoad(home())
    expect(r.standardVA).toBe(33980)
    expect(r.standardAmps).toBe(142)
  })

  it('Neutral: 4,680 + 5,600 range(70%) + 3,920 dryer(70%) + 1,200 DW = 15,400 VA → 64 A (240 V WH/heat contribute 0)', () => {
    const r = calculateLoad(home())
    expect(r.neutralVA).toBe(15400)
    expect(r.neutralAmps).toBe(64)
  })

  it('18-kW tankless: 97 + 93.75 (75 A × 1.25 continuous) = 190.75 A — upsize required, Art. 750 mitigation surfaced', () => {
    const r = calculateLoad(home())
    const tankless = r.futureLoadFindings[0]
    expect(tankless.fitsCode).toBe(false)
    expect(tankless.verdict).toContain('service upsize (or load management) required')
    expect(tankless.mitigation).toContain('750')
  })

  it('cross-check via 220.83(A): existing + tankless = 26,840 VA → 112 A > 100 A — both methods agree the answer is no', () => {
    const existing = existingDwellingAmps(home(), [
      load({ type: 'waterHeaterTankless', label: 'tankless', nameplateVA: 18000, volts: 240 }),
    ])
    expect(existing.variant).toBe('A')
    // other = 3300 + 4500 + 8000 + 4500 + 5600 + 1200 + 18000 = 45,100; + heat 10,000 (winner) = 55,100
    // → 8000 + 0.4 × 47,100 = 26,840
    expect(existing.totalVA).toBe(26840)
    expect(existing.amps).toBe(112)
    expect(existing.fits).toBe(false)
  })
})

describe('Pressure test 3 — 4200 ft² all-electric custom home, 400 A, HP + pool + welder + EVSE', () => {
  // Cooktop 7.4 kW + two 4.8-kW wall ovens; 24-kW tankless WH; 5.4-kW dryer;
  // DW 1.44 kW / disposal 0.9 kW / built-in microwave 1.6 kW (120 V);
  // 5-ton heat pump 32 A RLA (7,680 VA) + 15-kW supplemental, no lockout;
  // pool pump 12 A (2,880 VA) + 11-kW pool heater; 9.6-kVA arc welder @ 20% duty;
  // existing 11.5-kW EVSE. Futures: second EVSE + 8-kW self-contained hot tub.
  const home = () =>
    base({
      serviceAmps: 400,
      floorAreaSqFt: 4200,
      loads: [
        ...circuits(),
        load({ type: 'cooktop', label: '7.4-kW cooktop', nameplateKW: 7.4, volts: 240 }),
        load({ type: 'oven', label: '4.8-kW wall oven 1', nameplateKW: 4.8, volts: 240 }),
        load({ type: 'oven', label: '4.8-kW wall oven 2', nameplateKW: 4.8, volts: 240 }),
        load({ type: 'waterHeaterTankless', label: '24-kW tankless WH', nameplateKW: 24, volts: 240 }),
        load({ type: 'dryer', label: '5.4-kW dryer', nameplateKW: 5.4, volts: 240 }),
        load({ type: 'fixedAppliance', label: 'dishwasher 1.44 kW', nameplateVA: 1440, volts: 120 }),
        load({ type: 'fixedAppliance', label: 'disposal 0.9 kW', nameplateVA: 900, volts: 120 }),
        load({ type: 'fixedAppliance', label: 'built-in microwave 1.6 kW', nameplateVA: 1600, volts: 120 }),
        load({
          type: 'heatPump', label: '5-ton heat pump + 15-kW supplemental',
          heatPump: { compressorVA: 7680, supplementalVA: 15000, lockout: false }, volts: 240,
        }),
        load({ type: 'poolPump', label: 'pool pump 12 A', nameplateVA: 2880, volts: 240 }),
        load({ type: 'poolHeater', label: '11-kW pool heater', nameplateKW: 11, volts: 240 }),
        load({ type: 'arcWelder', label: '9.6-kVA arc welder @ 20% duty', nameplateVA: 9600, dutyCyclePct: 20, volts: 240 }),
        load({ type: 'evse', label: 'existing 11.5-kW EVSE', nameplateVA: 11500, volts: 240 }),
      ],
      futureLoads: [
        load({ type: 'evse', label: 'second 11.5-kW EVSE', nameplateVA: 11500, volts: 240 }),
        load({ type: 'spaSelfContained', label: '8-kW hot tub', nameplateVA: 8000, volts: 240, continuous: false }),
      ],
    })

  it('Optional: 97,140 general (welder at 4,320 via 0.45 duty multiplier) → 44,856 staged + 17,430 HP selection (compressor + 65% supplemental) = 62,286 VA → 260 A', () => {
    const r = calculateLoad(home())
    expect(r.optionalVA).toBe(62286)
    expect(r.optionalAmps).toBe(260)
    expect(r.spareAmps).toBe(140)
    expect(r.loadPct).toBe(65)
  })

  it('Standard: 7,935 bucket + 10,000 cooking (Note 4: 17-kW combo → 8 kW + 25%) + 5,400 dryer + 29,205 appliances (5 incl. tankless & pool heater @ 75%) + 22,680 HP heat side + 2,880 pool pump + 4,320 welder + 11,500 EVSE + 1,920 compressor adder = 95,840 VA → 399 A', () => {
    const r = calculateLoad(home())
    expect(r.standardVA).toBe(95840)
    expect(r.standardAmps).toBe(399)
  })

  it('Neutral: 7,935 + 7,000 cooking(70%) + 3,780 dryer(70%) + 2,955 (120 V appliances @75%) = 21,670 VA → 90 A', () => {
    const r = calculateLoad(home())
    expect(r.neutralVA).toBe(21670)
    expect(r.neutralAmps).toBe(90)
  })

  it('Futures: second EVSE (260 + 59.9 = 319.9 A) and hot tub (260 + 33.3 = 293.3 A) both fit a 400 A service per 230.42', () => {
    const r = calculateLoad(home())
    const [ev2, tub] = r.futureLoadFindings
    expect(ev2.fitsCode).toBe(true)
    expect(ev2.addedAmps).toBeCloseTo(59.896, 2)
    expect(tub.fitsCode).toBe(true)
    expect(tub.addedAmps).toBeCloseTo(33.333, 2)
  })
})
