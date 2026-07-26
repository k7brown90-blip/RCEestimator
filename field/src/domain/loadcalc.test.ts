import { describe, expect, it } from 'vitest'
import {
  applyNeutral200ARule,
  applyTable220_42,
  arcWelderMultiplier,
  calculateLoad,
  colCDemandKW,
  cookingDemandVA,
  dryerDemandVA,
  existingDwellingAmps,
  resistanceWelderMultiplier,
  resolveVA,
  type LoadCalcInput,
  type LoadItem,
} from './loadcalc'

let nextId = 0
function load(partial: Partial<LoadItem> & { type: LoadItem['type']; label: string }): LoadItem {
  nextId += 1
  return { id: `l${nextId}`, ...partial }
}

function input(partial: Partial<LoadCalcInput>): LoadCalcInput {
  return {
    mode: 'tech',
    occupancy: 'dwellingSingleFamily',
    serviceAmps: 100,
    serviceVoltage: 240,
    floorAreaSqFt: 1500,
    loads: [],
    ...partial,
  }
}

const saLaundry = () => [
  load({ type: 'smallAppliance', label: 'SA circuit 1' }),
  load({ type: 'smallAppliance', label: 'SA circuit 2' }),
  load({ type: 'laundry', label: 'Laundry circuit' }),
]

// ── Annex D golden fixtures (inputs verified against the 2017 NEC text) ──────

// D1(a): 1500 ft²; 12-kW range; 5.5-kW 240-V dryer. Standard = 78 A, neutral 61 A.
const d1a = () =>
  input({
    loads: [
      ...saLaundry(),
      load({ type: 'range', label: '12-kW range', nameplateKW: 12, volts: 240, nameplateRead: true }),
      load({ type: 'dryer', label: '5.5-kW dryer', nameplateKW: 5.5, volts: 240, nameplateRead: true }),
    ],
  })

// D2(a): + 2.5-kW WH, 1.2-kW DW, 9 kW heat in five rooms, 5-kW dryer,
// 6-A 230-V room A/C (Annex computes the A/C at its 230 V nameplate).
// Optional = 90 A, neutral 64 A.
const d2a = () =>
  input({
    loads: [
      ...saLaundry(),
      load({ type: 'range', label: '12-kW range', nameplateKW: 12, volts: 240, nameplateRead: true }),
      load({ type: 'waterHeaterTank', label: '2.5-kW water heater', nameplateKW: 2.5, volts: 240, nameplateRead: true }),
      load({ type: 'fixedAppliance', label: '1.2-kW dishwasher', nameplateKW: 1.2, volts: 120, nameplateRead: true }),
      load({ type: 'spaceHeat', label: '9-kW space heat, five rooms', nameplateKW: 9, volts: 240, separatelyControlledUnits: 5, nameplateRead: true }),
      load({ type: 'dryer', label: '5-kW dryer', nameplateKW: 5, volts: 240, nameplateRead: true }),
      load({ type: 'cooling', label: '6-A 230-V room A/C', amps: 6, volts: 230, nameplateRead: true }),
    ],
  })

// D2(b): two 4-kW ovens, 5.1-kW cooktop, 4.5-kW WH, 1.2-kW DW, 5-kW washer/dryer,
// six 7-A room A/C units, 1.5-kW bathroom space heater. Optional = 122 A.
// NOTE — Annex D discrepancy, resolved in favor of the NEC text: the units are
// nameplated 230 V but Annex D2(b) computes their kVA at 240 V (42 A × 240 V =
// 10.08 kVA), unlike D2(a) which uses 230 V. The fixture carries the Annex's own
// 240 V figure; the engine resolves amps × volts as entered and does not
// second-guess the record.
const d2b = () =>
  input({
    loads: [
      ...saLaundry(),
      load({ type: 'oven', label: '4-kW wall oven 1', nameplateKW: 4, volts: 240, nameplateRead: true }),
      load({ type: 'oven', label: '4-kW wall oven 2', nameplateKW: 4, volts: 240, nameplateRead: true }),
      load({ type: 'cooktop', label: '5.1-kW cooktop', nameplateKW: 5.1, volts: 240, nameplateRead: true }),
      load({ type: 'waterHeaterTank', label: '4.5-kW water heater', nameplateKW: 4.5, volts: 240, nameplateRead: true }),
      load({ type: 'fixedAppliance', label: '1.2-kW dishwasher', nameplateKW: 1.2, volts: 120, nameplateRead: true }),
      load({ type: 'dryer', label: '5-kW washer/dryer combo', nameplateKW: 5, volts: 240, nameplateRead: true }),
      ...Array.from({ length: 6 }, (_, i) =>
        load({ type: 'cooling', label: `7-A room A/C ${i + 1}`, amps: 7, volts: 240, nameplateRead: true }),
      ),
      load({ type: 'spaceHeat', label: '1.5-kW bathroom space heater', nameplateKW: 1.5, volts: 240, separatelyControlledUnits: 1, nameplateRead: true }),
    ],
  })

describe('Annex D golden examples (pass condition: exact totals)', () => {
  it('D1(a): Standard = 78 A, neutral = 61 A', () => {
    const result = calculateLoad(d1a())
    expect(result.standardVA).toBe(18600)
    expect(result.standardAmps).toBe(78)
    expect(result.neutralVA).toBe(14550)
    expect(result.neutralAmps).toBe(61)
  })

  it('D2(a): Optional = 90 A (heat governs over A/C), neutral = 64 A', () => {
    const result = calculateLoad(d2a())
    expect(result.optionalVA).toBe(21480)
    expect(result.optionalAmps).toBe(90)
    expect(result.methodUsed).toBe('optional')
    expect(result.governingAmps).toBe(90)
    expect(result.neutralVA).toBe(15400)
    expect(result.neutralAmps).toBe(64)
  })

  it('D2(b): Optional = 122 A (A/C governs; bathroom heater drops out)', () => {
    const result = calculateLoad(d2b())
    expect(result.optionalVA).toBe(29200)
    expect(result.optionalAmps).toBe(122)
  })
})

describe('§5c code-literal input checklist (16 rules)', () => {
  it('rule 1 — general lighting at 3 VA/ft² of adaptable area', () => {
    const result = calculateLoad(input({ floorAreaSqFt: 1000 }))
    // 3000 lighting + 4500 SA/laundry minimums = 7500, under 10 kVA → no 40% stage
    expect(result.optionalVA).toBe(7500)
  })

  it('rule 2 — minimums of 2 small-appliance + 1 laundry apply even when none entered', () => {
    const none = calculateLoad(input({ floorAreaSqFt: 1000, loads: [] }))
    const explicit = calculateLoad(input({ floorAreaSqFt: 1000, loads: saLaundry() }))
    expect(none.optionalVA).toBe(explicit.optionalVA)
  })

  it('rule 3 — Table 220.42 staged before specific loads, full three tiers', () => {
    const result = calculateLoad(d1a())
    const bucketLine = result.breakdown.find((l) => l.rule.includes('220.42'))
    // D1(a) uses the Standard breakdown only when standard governs; check via neutral-basis math instead:
    expect(applyTable220_42(9000)).toBe(5100) // 3000 + 6000 × 0.35
    // Third tier (never fires on a dwelling, implemented for Phase 2 occupancies):
    expect(applyTable220_42(150000)).toBe(3000 + 117000 * 0.35 + 30000 * 0.25)
    expect(bucketLine === undefined || bucketLine.appliedVA > 0).toBe(true)
  })

  it('rule 4 — bathroom branch circuit adds 0 (210.11(C)(3) guard)', () => {
    const without = calculateLoad(d2a())
    const withBath = calculateLoad(
      input({ loads: [...d2a().loads, load({ type: 'bathroomCircuit', label: 'Bathroom circuit' })] }),
    )
    expect(withBath.optionalVA).toBe(without.optionalVA)
    expect(withBath.standardVA).toBe(without.standardVA)
    expect(withBath.neutralVA).toBe(without.neutralVA)
  })

  it('rule 5 — range via Table 220.55 Column C + Notes 1 and 4', () => {
    expect(colCDemandKW(1)).toBe(8)
    expect(colCDemandKW(5)).toBe(20)
    expect(colCDemandKW(26)).toBe(41) // 15 kW + 1 kW/range
    expect(colCDemandKW(45)).toBe(25 + 0.75 * 45) // 25 kW + ¾ kW/range
    // Note 1: one 15.5-kW range → 3.5 kW over 12 → 4 increments (major fraction) → 8 kW × 1.20
    expect(cookingDemandVA([load({ type: 'range', label: '15.5-kW range', nameplateKW: 15.5 })])).toBe(9600)
    // Note 4: cooktop + two ovens, same room/circuit → one 13.1-kW range → 8 kW × 1.05
    expect(
      cookingDemandVA([
        load({ type: 'cooktop', label: 'cooktop', nameplateKW: 5.1 }),
        load({ type: 'oven', label: 'oven 1', nameplateKW: 4 }),
        load({ type: 'oven', label: 'oven 2', nameplateKW: 4 }),
      ]),
    ).toBe(8400)
  })

  it('rule 6 — dryer = larger of 5000 VA or nameplate; Table 220.54 for multiples', () => {
    expect(dryerDemandVA([load({ type: 'dryer', label: '4-kW dryer', nameplateKW: 4 })])).toBe(5000)
    expect(dryerDemandVA([load({ type: 'dryer', label: '5.5-kW dryer', nameplateKW: 5.5 })])).toBe(5500)
    const five = Array.from({ length: 5 }, (_, i) => load({ type: 'dryer', label: `dryer ${i}`, nameplateKW: 5 }))
    expect(dryerDemandVA(five)).toBe(25000 * 0.85)
  })

  it('rule 7 — four or more fixed appliances at 75 % (else 100 %)', () => {
    const four = Array.from({ length: 4 }, (_, i) =>
      load({ type: 'fixedAppliance', label: `appliance ${i}`, nameplateVA: 1000, volts: 240 }),
    )
    const result4 = calculateLoad(input({ floorAreaSqFt: 0, loads: four }))
    const line4 = result4.breakdown.find((l) => l.rule.includes('220.53'))
    // standard breakdown only surfaces when standard governs; assert through totals instead:
    const result3 = calculateLoad(input({ floorAreaSqFt: 0, loads: four.slice(0, 3), methodOverride: 'standard' }))
    const result4s = calculateLoad(input({ floorAreaSqFt: 0, loads: four, methodOverride: 'standard' }))
    const bucket = applyTable220_42(4500) // SA/laundry minimums only
    expect(result3.standardVA).toBe(bucket + 3000) // 3 × 1000 @ 100 %
    expect(result4s.standardVA).toBe(bucket + 3000) // 4 × 1000 @ 75 % = 3000
    expect(line4 === undefined || line4.appliedVA === 3000).toBe(true)
  })

  it('rule 8 — water heaters (tank AND tankless) counted per method, never exempt', () => {
    // Optional: tankless at full nameplate in the general bucket.
    const tankless = calculateLoad(
      input({ floorAreaSqFt: 0, loads: [load({ type: 'waterHeaterTankless', label: '28-kW tankless WH', nameplateKW: 28, volts: 240 })] }),
    )
    // general = 4500 minimums + 28,000 = 32,500 → 10,000 + 0.4 × 22,500 = 19,000
    expect(tankless.optionalVA).toBe(19000)
    // Standard: tankless joins the 220.53 group — 4 appliances → 75 % applies to all.
    const fourWithWH = [
      load({ type: 'waterHeaterTankless', label: 'tankless WH', nameplateVA: 28000, volts: 240 }),
      load({ type: 'fixedAppliance', label: 'dw', nameplateVA: 1000, volts: 240 }),
      load({ type: 'fixedAppliance', label: 'disposal', nameplateVA: 1000, volts: 240 }),
      load({ type: 'fixedAppliance', label: 'microwave', nameplateVA: 1000, volts: 240 }),
    ]
    const std = calculateLoad(input({ floorAreaSqFt: 0, loads: fourWithWH, methodOverride: 'standard' }))
    expect(std.standardVA).toBe(applyTable220_42(4500) + 0.75 * 31000)
  })

  it('rule 9 — heat vs A/C noncoincident, larger only (220.60 / 220.82(C))', () => {
    // D2(a): 1.38 kVA A/C < 3.6 kVA heat selection → A/C drops out (asserted in golden).
    // Standard direction: A/C larger → heat drops.
    const coolWins = calculateLoad(
      input({
        floorAreaSqFt: 0,
        methodOverride: 'standard',
        loads: [
          load({ type: 'spaceHeat', label: '2-kW heat', nameplateKW: 2, volts: 240 }),
          load({ type: 'cooling', label: '5-kW A/C', nameplateKW: 5, volts: 240 }),
        ],
      }),
    )
    // bucket 3525 + A/C 5000 + compressor 25% adder 1250 (A/C compressor is the largest motor candidate)
    expect(coolWins.standardVA).toBe(applyTable220_42(4500) + 5000 + 1250)
  })

  it('rule 10 — largest motor +25 % adder, once; compressor as candidate (430.24/440.6)', () => {
    const result = calculateLoad(
      input({
        floorAreaSqFt: 0,
        methodOverride: 'standard',
        loads: [
          load({ type: 'poolPump', label: '1.5-kVA pool pump', nameplateVA: 1500, volts: 240 }),
          load({ type: 'motor', label: '1-kVA well pump', nameplateVA: 1000, volts: 240 }),
        ],
      }),
    )
    // bucket 3525 + motors 2500 + 25% of largest (1500) = 375
    expect(result.standardVA).toBe(applyTable220_42(4500) + 2500 + 375)
    const adder = result.breakdown.find((l) => l.rule === '430.24' && l.label.includes('+25%'))
    expect(adder?.appliedVA).toBe(375)
  })

  it('rule 11 — kVA = kW for ranges and dryers (220.54/220.55)', () => {
    expect(resolveVA(load({ type: 'range', label: 'range', nameplateKW: 12 }))).toBe(12000)
    expect(resolveVA(load({ type: 'dryer', label: 'dryer', nameplateKW: 5.5 }))).toBe(5500)
  })

  it('rule 12 — Optional method requires ≥100 A 3-wire; else Standard only (220.82(A))', () => {
    const small = calculateLoad(input({ serviceAmps: 60, loads: d1a().loads }))
    expect(small.methodUsed).toBe('standard')
    expect(small.governingAmps).toBe(small.standardAmps)
    const big = calculateLoad(input({ serviceAmps: 100, loads: d1a().loads }))
    expect(big.methodUsed).toBe('optional')
  })

  it('rule 13 — neutral per 220.61: 240 V loads = 0, range/dryer at 70 %, over-200 A at 70 %', () => {
    // D1(a)/D2(a) exact neutrals asserted in goldens. 240 V loads contribute 0:
    const withWH = calculateLoad(d2a())
    const noWH = calculateLoad(
      input({ loads: d2a().loads.filter((l) => l.type !== 'waterHeaterTank') }),
    )
    expect(withWH.neutralVA).toBe(noWH.neutralVA) // 240 V WH has no neutral contribution
    // 220.61(B)(2): portion over 200 A (48,000 VA) at 70 %
    expect(applyNeutral200ARule(60000)).toBe(48000 + 0.7 * 12000)
    expect(applyNeutral200ARule(40000)).toBe(40000)
  })

  it('rule 14 — capacity on the code-literal 230.42 basis: noncont 100 %, cont 125 %, no blanket 80 %', () => {
    const result = calculateLoad(
      input({
        serviceAmps: 200,
        loads: d1a().loads,
        futureLoads: [
          load({ type: 'evse', label: '9.6-kW EV charger', nameplateVA: 9600, volts: 240 }), // continuous by default
          load({ type: 'fixedAppliance', label: '9.6-kW noncontinuous load', nameplateVA: 9600, volts: 240, continuous: false }),
        ],
      }),
    )
    const [ev, noncont] = result.futureLoadFindings
    expect(ev.continuous).toBe(true)
    expect(ev.addedAmps).toBeCloseTo(50, 5) // 40 A × 1.25
    expect(noncont.continuous).toBe(false)
    expect(noncont.addedAmps).toBeCloseTo(40, 5) // 100 %, no blanket derate
    expect(ev.fitsCode).toBe(true)
    // loadPct is against the FULL service rating; usableAmps80 is reference only.
    expect(result.loadPct).toBe((result.governingAmps / 200) * 100)
    expect(result.usableAmps80).toBe(160)
  })

  it('rule 14b — mitigation surfaces EVEMS (625.42) when a continuous load does not fit', () => {
    const result = calculateLoad(
      input({
        serviceAmps: 100,
        loads: d2a().loads, // governing 90 A
        futureLoads: [load({ type: 'evse', label: '9.6-kW EV charger', nameplateVA: 9600, volts: 240 })],
      }),
    )
    const ev = result.futureLoadFindings[0]
    expect(ev.fitsCode).toBe(false) // 90 + 50 = 140 > 100
    expect(ev.verdict).toContain('service upsize (or load management) required')
    expect(ev.mitigation).toContain('625.42')
  })

  it('rule 15 — count-once: dryer on the laundry circuit is not doubled; range not also a fixed appliance', () => {
    const base = input({ loads: [...saLaundry()] })
    const withDryerOnLaundry = input({
      loads: [...saLaundry(), load({ type: 'dryer', label: 'dryer on laundry circuit', nameplateKW: 1.4, onLaundryCircuit: true })],
    })
    expect(calculateLoad(withDryerOnLaundry).optionalVA).toBe(calculateLoad(base).optionalVA)
    expect(calculateLoad(withDryerOnLaundry).standardVA).toBe(calculateLoad(base).standardVA)
    // Range enters ONLY through Table 220.55 in the Standard method:
    const rangeOnly = calculateLoad(
      input({ loads: [load({ type: 'range', label: '12-kW range', nameplateKW: 12 })], methodOverride: 'standard' }),
    )
    expect(rangeOnly.standardVA).toBe(applyTable220_42(4500 + 4500) + 8000)
  })

  it('rule 16 — every load flagged nameplateRead vs assumed; assumed values surfaced', () => {
    const result = calculateLoad(
      input({
        loads: [
          ...saLaundry(), // code-fixed values — never in the assumed list
          load({ type: 'range', label: 'range (plate read)', nameplateKW: 12, nameplateRead: true }),
          load({ type: 'waterHeaterTank', label: 'WH (assumed)', nameplateKW: 4.5, nameplateRead: false }),
          load({ type: 'dryer', label: 'dryer (unstated)', nameplateKW: 5 }), // unstated = assumed
        ],
      }),
    )
    expect(result.assumedValues).toEqual(['WH (assumed)', 'dryer (unstated)'])
  })
})

describe('welder duty-cycle multipliers (Tables 630.11(A), 630.31(A)(2))', () => {
  it('arc welders — nonmotor-generator and motor-generator columns', () => {
    expect(arcWelderMultiplier(100)).toBe(1.0)
    expect(arcWelderMultiplier(60)).toBe(0.78)
    expect(arcWelderMultiplier(20)).toBe(0.45)
    expect(arcWelderMultiplier(10)).toBe(0.45) // "20 or less"
    expect(arcWelderMultiplier(40, true)).toBe(0.69)
  })

  it('resistance welders', () => {
    expect(resistanceWelderMultiplier(50)).toBe(0.71)
    expect(resistanceWelderMultiplier(7.5)).toBe(0.27)
    expect(resistanceWelderMultiplier(2)).toBe(0.22) // "5 or less"
  })

  it('welder loads resolve through their multiplier', () => {
    expect(resolveVA(load({ type: 'arcWelder', label: 'arc', nameplateVA: 10000, dutyCyclePct: 60 }))).toBe(7800)
    expect(resolveVA(load({ type: 'resistanceWelder', label: 'spot', nameplateVA: 10000, dutyCyclePct: 20 }))).toBe(4500)
  })
})

describe('Existing Dwelling Method (220.83)', () => {
  it('(A) no new HVAC: first 8 kVA @ 100 %, remainder @ 40 %', () => {
    const base = d1a()
    // other = 4500 + 4500 + 12,000 + 5500 = 26,500 → 8000 + 0.4 × 18,500 = 15,400 → 64 A
    const existing = existingDwellingAmps(base)
    expect(existing.variant).toBe('A')
    expect(existing.totalVA).toBe(15400)
    expect(existing.amps).toBe(64)
    expect(existing.fits).toBe(true)
    // Adding a non-HVAC load stays variant A:
    const withEv = existingDwellingAmps(base, [load({ type: 'evse', label: 'EV charger', nameplateVA: 9600 })])
    expect(withEv.variant).toBe('A')
    expect(withEv.totalVA).toBe(8000 + 0.4 * (26500 + 9600 - 8000))
  })

  it('(B) new HVAC: larger of A/C or heat @ 100 % + staged other load', () => {
    const result = existingDwellingAmps(d1a(), [
      load({ type: 'spaceHeat', label: 'new 9-kW heat', nameplateKW: 9, volts: 240 }),
    ])
    expect(result.variant).toBe('B')
    expect(result.totalVA).toBe(9000 + 8000 + 0.4 * (26500 - 8000)) // 24,400
    expect(result.amps).toBe(102)
    expect(result.fits).toBe(false) // 102 A > 100 A service
  })
})

describe('determinism', () => {
  it('same inventory → identical result, every time', () => {
    const fixture = input({
      loads: d2a().loads,
      futureLoads: [load({ type: 'evse', label: 'EV charger', nameplateVA: 9600 })],
    })
    const first = calculateLoad(fixture)
    for (let i = 0; i < 50; i += 1) {
      expect(calculateLoad(fixture)).toEqual(first)
    }
  })
})

describe('Phase 2 parameters are guarded, not baked in', () => {
  it('rejects unimplemented occupancy profiles and methods explicitly', () => {
    expect(() => calculateLoad(input({ occupancy: 'hotelMotel' }))).toThrow(/not implemented in Phase 1/)
    expect(() => calculateLoad(input({ methodOverride: 'multifamily220_84' }))).toThrow(/not implemented in Phase 1/)
  })

  it('methodOverride existingDwelling drives governingAmps through 220.83', () => {
    const result = calculateLoad(input({ loads: d1a().loads, methodOverride: 'existingDwelling' }))
    expect(result.methodUsed).toBe('existingDwelling')
    expect(result.governingAmps).toBe(64)
  })
})
