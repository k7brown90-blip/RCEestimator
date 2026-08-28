import { describe, expect, it } from 'vitest'
import { calculateLoad, type LoadCalcInput, type LoadItem } from './loadcalc'
import { recommendGenerator, siteDerateFactor, sizeToModel, type GeneratorInput } from './generator'
import {
  GENERAC_DATA_REVISION,
  GENERAC_GUARDIAN_MODELS,
  GENERATOR_DISCLAIMER,
  SURGE_VERIFY_FLAG_TEXT,
} from './generatorData'

let nextId = 0
function load(partial: Partial<LoadItem> & { type: LoadItem['type']; label: string }): LoadItem {
  nextId += 1
  return { id: `g${nextId}`, ...partial }
}

function input(partial: Partial<LoadCalcInput>): LoadCalcInput {
  return {
    mode: 'tech',
    occupancy: 'dwellingSingleFamily',
    serviceAmps: 200,
    serviceVoltage: 240,
    floorAreaSqFt: 2000,
    loads: [],
    ...partial,
  }
}

/** Site pinned flat unless a test is about the site derate itself. */
function recommend(calcInput: LoadCalcInput, overrides: Partial<GeneratorInput> = {}) {
  return recommendGenerator({
    calcInput,
    calcResult: calculateLoad(calcInput),
    fuel: 'LP',
    softStart: false,
    site: { altitudeSteps: 0 },
    ...overrides,
  })
}

describe('sizeToModel — fuel-matched Generac selection (amendment rule 1)', () => {
  it('AMENDMENT ACCEPTANCE: 20 kW required on NG steps past the 22/19.5 to the 24/21', () => {
    // The 7042's NG rating is 19,500 W — it FAILS a 20 kW NG requirement even
    // though its LP class number (22) reads big enough. The engine must pick
    // the fuel-matched rating and land on the 7209 (24 LP / 21 NG).
    const sizing = sizeToModel(20, 'NG', 1)
    expect(sizing.model?.generatorModel).toBe('7209')
    expect(sizing.model?.classLabel).toBe('24/21')
    expect(sizing.ratedKW).toBe(21)
    // And the same 20 kW on LP is carried by the 20/18 class (7038/39).
    expect(sizeToModel(20, 'LP', 1).model?.generatorModel).toBe('7038/39')
  })

  it('sizes to the boundary model at an exact fuel-matched boundary', () => {
    expect(sizeToModel(10, 'LP', 1).model?.generatorModel).toBe('7171') // 10 kW LP exact
    expect(sizeToModel(9, 'NG', 1).model?.generatorModel).toBe('7171') // 9 kW NG exact
    expect(sizeToModel(22.5, 'NG', 1).model?.generatorModel).toBe('7290') // top NG exact
  })

  it('steps up just past a fuel-matched boundary — never interpolates', () => {
    expect(sizeToModel(9.01, 'NG', 1).model?.generatorModel).toBe('7223')
    expect(sizeToModel(10.01, 'LP', 1).model?.generatorModel).toBe('7223')
  })

  it('goes liquid-cooled (Protector) above the largest air-cooled rating', () => {
    const ng = sizeToModel(22.51, 'NG', 1)
    expect(ng.model).toBeNull()
    expect(ng.liquidCooled).toBe(true)
    expect(sizeToModel(26.01, 'LP', 1).liquidCooled).toBe(true)
  })

  it('applies the site derate before comparing', () => {
    // 9.65 kW required; 10 kW LP unit at −3.5 % altitude delivers 9.65 — exact fit.
    expect(sizeToModel(9.65, 'LP', 0.965).model?.generatorModel).toBe('7171')
    // A hair more and it steps up.
    expect(sizeToModel(9.66, 'LP', 0.965).model?.generatorModel).toBe('7223')
  })
})

describe('site derate (amendment rule 3)', () => {
  it('defaults to one 1,000-ft altitude step for Middle TN', () => {
    expect(siteDerateFactor(undefined)).toBe(0.97) // 1 − 0.035, rounded to 2
  })

  it('is overridable and compounds altitude with temperature above 60 °F', () => {
    expect(siteDerateFactor({ altitudeSteps: 0 })).toBe(1)
    expect(siteDerateFactor({ altitudeSteps: 2, ambientF: 90 })).toBe(0.9) // 1 − 0.07 − 0.03
  })

  it('the default site derate reaches the recommendation', () => {
    const rec = recommendGenerator({
      calcInput: input({ loads: [] }),
      calcResult: calculateLoad(input({ loads: [] })),
      fuel: 'NG',
      softStart: false,
      // no site given — Middle TN default applies
    })
    expect(rec.siteDerateFactor).toBe(0.97)
  })
})

describe('partial tier — Kyle\'s ratified scope', () => {
  it('gas-heat home: heating branch is blower only, partial tier stays small', () => {
    const calcInput = input({
      loads: [
        load({ type: 'spaceHeat', label: 'Gas furnace', fuel: 'gas', nameplateVA: 800 }), // blower
        load({ type: 'cooling', label: 'A/C condenser', amps: 17, volts: 240, tons: 2.5 }),
        load({ type: 'waterHeaterTank', label: 'Water heater', fuel: 'gas', nameplateKW: 0.5 }),
        load({ type: 'range', label: 'Gas range', fuel: 'gas', nameplateKW: 0.4 }),
      ],
    })
    const rec = recommend(calcInput)
    expect(rec.partial).not.toBeNull()
    const partial = rec.partial!
    // Cooling (4080 VA) beats the gas blower (800 VA) under 220.60.
    const hvac = partial.covered.find((c) => c.rule.includes('220.60'))!
    expect(hvac.va).toBe(17 * 240)
    expect(hvac.label).toContain('cooling governs')
    // Gas WH and gas range are excluded with reasons, not counted.
    expect(partial.excludedWithReason.join(' ')).toContain('gas fired')
    // 4080 + 3000 SA + 800 fridge + 1500 microwave = 9380 VA → the 10 kW LP unit.
    expect(partial.requiredKW).toBeCloseTo(9.38, 2)
    expect(partial.model?.generatorModel).toBe('7171')
  })

  it('excludes lighting and general-use circuits explicitly — never silently', () => {
    const rec = recommend(input({ loads: [] }))
    expect(rec.partial!.notCovered).toContain('Lighting and general-use receptacle circuits')
  })

  it('220.60: heating governs when electric heat beats cooling', () => {
    const calcInput = input({
      loads: [
        load({ type: 'spaceHeat', label: 'Electric furnace', nameplateKW: 9.9, separatelyControlledUnits: 1 }),
        load({ type: 'cooling', label: 'A/C', amps: 17, volts: 240 }),
      ],
    })
    const hvac = recommend(calcInput).partial!.covered.find((c) => c.rule.includes('220.60'))!
    expect(hvac.label).toContain('heating governs')
    expect(hvac.va).toBe(9900)
  })

  it('uses tagged refrigerator/microwave nameplates over the defaults', () => {
    const calcInput = input({
      loads: [
        load({ type: 'fixedAppliance', label: 'Refrigerator', applianceKind: 'refrigerator', nameplateVA: 1200, volts: 120 }),
        load({ type: 'fixedAppliance', label: 'Microwave', applianceKind: 'microwave', nameplateVA: 1800, volts: 120 }),
      ],
    })
    const partial = recommend(calcInput).partial!
    expect(partial.covered.find((c) => c.label === 'Refrigerator')!.va).toBe(1200)
    expect(partial.covered.find((c) => c.label === 'Microwave')!.va).toBe(1800)
  })

  it('applies Table 220.55 demand to cooking, not nameplate', () => {
    const calcInput = input({
      loads: [load({ type: 'range', label: 'Range', nameplateKW: 12 })],
    })
    const cooking = recommend(calcInput).partial!.covered.find((c) => c.rule.includes('220.55'))!
    expect(cooking.va).toBe(8000) // one range ≤12 kW → 8 kW Column C
  })
})

describe('disqualifiers and flags', () => {
  it('electric tankless WH: hard flag, excluded from partial with explanation', () => {
    const calcInput = input({
      loads: [load({ type: 'waterHeaterTankless', label: 'Tankless WH', nameplateKW: 24 })],
    })
    const rec = recommend(calcInput)
    expect(rec.flags.some((f) => f.id === 'tankless_electric' && f.severity === 'hard')).toBe(true)
    expect(rec.partial).not.toBeNull() // tankless excludes ITSELF, not the tier
    expect(rec.partial!.excludedWithReason.join(' ')).toContain('tankless')
    expect(rec.partial!.covered.some((c) => c.label === 'Tankless WH')).toBe(false)
  })

  it('heat pump + 10 kW strips: strips dominate heating and trip the threshold flag', () => {
    const calcInput = input({
      loads: [
        load({
          type: 'heatPump', label: 'Heat pump',
          heatPump: { compressorVA: 4800, supplementalVA: 10000, lockout: false },
        }),
      ],
    })
    const rec = recommend(calcInput)
    expect(rec.flags.some((f) => f.id === 'strip_heat_over_threshold' && f.severity === 'hard')).toBe(true)
    // Threshold forces whole-home / liquid-cooled guidance — partial suppressed.
    expect(rec.partial).toBeNull()
    const interlock = rec.wholeHome.find((s) => s.scheme === 'interlock_manual')!
    expect(interlock.notes.join(' ')).toContain('suppressed')
  })

  it('strips below the threshold do not trip the flag', () => {
    const calcInput = input({
      loads: [
        load({
          type: 'heatPump', label: 'Heat pump',
          heatPump: { compressorVA: 4800, supplementalVA: 7000, lockout: false },
        }),
      ],
    })
    expect(recommend(calcInput).flags.some((f) => f.id === 'strip_heat_over_threshold')).toBe(false)
  })

  it('surge flag when no compressor carries LRA or tonnage', () => {
    const calcInput = input({
      loads: [load({ type: 'cooling', label: 'A/C', amps: 17, volts: 240 })],
    })
    const rec = recommend(calcInput)
    expect(rec.surge.status).toBe('pending')
    expect(rec.surge.message).toContain('provide condenser LRA or tonnage')
    expect(rec.flags.some((f) => f.id === 'surge_pending')).toBe(true)
  })

  it('unpublished model surge data emits the verify-with-dealer flag, never a silent pass (amendment rule 4)', () => {
    const calcInput = input({
      loads: [load({ type: 'cooling', label: 'A/C', amps: 11, volts: 240, lockedRotorAmps: 54 })],
    })
    // Partial sizes to a small model with no published motor-starting data.
    const full = recommend(calcInput).wholeHome.find((s) => s.scheme === 'ats_full_load')!
    expect(full.notes).toContain(SURGE_VERIFY_FLAG_TEXT)
  })

  it('soft start relaxes the surge number and adds the scope line', () => {
    const calcInput = input({
      loads: [load({ type: 'cooling', label: 'A/C', amps: 17, volts: 240, lockedRotorAmps: 100 })],
    })
    const hard = recommend(calcInput)
    const soft = recommend(calcInput, { softStart: true })
    expect(hard.surge.startKVA).toBeCloseTo(24, 1) // 100 A × 240 V
    expect(soft.surge.startKVA).toBeCloseTo(9.6, 1) // × 0.4
    expect(soft.scopeLines.join(' ')).toContain('soft-start kit')
  })
})

describe('whole-home schemes', () => {
  const allElectric = input({
    floorAreaSqFt: 2718,
    loads: [
      load({ type: 'range', label: 'Range', nameplateKW: 12 }),
      load({ type: 'dryer', label: 'Dryer', nameplateKW: 5 }),
      load({ type: 'waterHeaterTank', label: 'Water heater', nameplateKW: 4.5 }),
      load({
        type: 'heatPump', label: 'Heat pump',
        heatPump: { compressorVA: 4920, supplementalVA: 7000, lockout: false },
        lockedRotorAmps: 84,
      }),
      load({ type: 'cooling', label: 'Second A/C', amps: 11, volts: 240, lockedRotorAmps: 54 }),
      load({ type: 'evse', label: 'EV charger (40 A)', nameplateKW: 9.6 }),
    ],
  })

  it('all three schemes are present with their NEC bases', () => {
    const rec = recommend(allElectric)
    expect(rec.wholeHome.map((s) => s.scheme)).toEqual([
      'ats_full_load', 'ats_load_management', 'interlock_manual',
    ])
    expect(rec.wholeHome[0].necBasis).toContain('702.4(B)(2)(a)')
    expect(rec.wholeHome[1].necBasis).toContain('702.4(B)(2)(b)')
    expect(rec.wholeHome[2].necBasis).toContain('702.4(B)(1)')
  })

  it('full-load scheme uses the Article 220 result and states that basis', () => {
    const calcResult = calculateLoad(allElectric)
    const full = recommend(allElectric).wholeHome[0]
    expect(full.requiredAmps).toBe(calcResult.governingAmps)
    expect(full.loadBasis).toContain('Article 220 calculation')
  })

  it('prefers the 220.87 demand-data basis when demand records exist', () => {
    const full = recommend(allElectric, { demandBasisAmps: 62 }).wholeHome[0]
    expect(full.requiredAmps).toBe(62)
    expect(full.loadBasis).toContain('220.87 demand data')
    expect(full.requiredKW).toBeCloseTo(14.88, 2)
    // 14.88 kW on LP → the 16/16 class (7035/36/37).
    expect(full.model?.generatorModel).toBe('7035/36/37')
  })

  it('load management names every shed load within hardware caps, A/C loads first', () => {
    const rec = recommend(allElectric)
    const managed = rec.wholeHome[1]
    // 2 A/C loads (≤4 native slots) + 4 other 240 V loads (≤8 SMMs).
    expect(managed.shedLoads).toEqual([
      'Heat pump', 'Second A/C', 'Range', 'Dryer', 'Water heater', 'EV charger (40 A)',
    ])
    expect(managed.notes.join(' ')).toContain('Assumes shed devices on')
    // One SMM line per non-A/C shed load in the package reference (amendment rule 2).
    expect(managed.priceBookRefs.filter((r) => r.includes('SMM')).length).toBe(4)
    // Managed load (lighting/SA/laundry only here) sizes well below full load.
    const full = rec.wholeHome[0]
    expect(managed.requiredKW!).toBeLessThan(full.requiredKW!)
  })

  it('never assumes more shed slots than 4 A/C + 8 SMM (amendment rule 2)', () => {
    const crowded = input({
      loads: [
        ...Array.from({ length: 6 }, (_, i) =>
          load({ type: 'cooling', label: `A/C ${i + 1}`, amps: 11, volts: 240 })),
        ...Array.from({ length: 10 }, (_, i) =>
          load({ type: 'fixedAppliance', label: `Fixed ${i + 1}`, nameplateKW: 1 })),
        ...Array.from({ length: 10 }, (_, i) =>
          load({ type: 'waterHeaterTank', label: `WH ${i + 1}`, nameplateKW: 4.5 })),
      ],
    })
    const managed = recommend(crowded).wholeHome[1]
    const acShed = managed.shedLoads!.filter((l) => l.startsWith('A/C')).length
    const otherShed = managed.shedLoads!.length - acShed
    expect(acShed).toBe(4)
    expect(otherShed).toBe(8)
    expect(managed.notes.join(' ')).toContain('stays in the managed load')
  })

  it('EVSE is excluded from the partial tier and listed as not covered', () => {
    const partial = recommend(allElectric).partial!
    expect(partial.covered.some((c) => c.label.includes('EV'))).toBe(false)
    expect(partial.excludedWithReason.join(' ')).toContain('EV charging')
    expect(partial.notCovered).toContain('EV charging')
  })

  it('interlock scheme sets no code-minimum size', () => {
    const interlock = recommend(allElectric).wholeHome[2]
    expect(interlock.requiredKW).toBeNull()
    expect(interlock.necBasis).toContain('702.4(B)(1)')
  })
})

describe('output hygiene', () => {
  it('every recommendation carries the preliminary disclaimer verbatim', () => {
    expect(recommend(input({ loads: [] })).disclaimer).toBe(GENERATOR_DISCLAIMER)
  })

  it('every recommendation carries the fuel-supply scope line (amendment rule 5)', () => {
    const rec = recommend(input({ loads: [] }))
    expect(rec.scopeLines.join(' ')).toContain('verify gas meter and fuel-pipe sizing'.replace('verify', 'Verify'))
  })

  it('every recommendation carries the data vintage (amendment rule 6)', () => {
    expect(recommend(input({ loads: [] })).dataRevision).toBe(GENERAC_DATA_REVISION)
  })

  it('the model table is ascending on both fuel ratings — sizing assumes it', () => {
    for (let i = 1; i < GENERAC_GUARDIAN_MODELS.length; i += 1) {
      expect(GENERAC_GUARDIAN_MODELS[i].lpWatts).toBeGreaterThanOrEqual(GENERAC_GUARDIAN_MODELS[i - 1].lpWatts)
      expect(GENERAC_GUARDIAN_MODELS[i].ngWatts).toBeGreaterThanOrEqual(GENERAC_GUARDIAN_MODELS[i - 1].ngWatts)
    }
  })
})
