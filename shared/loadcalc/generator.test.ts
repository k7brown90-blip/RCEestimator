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
  it('defaults to one 1,000-ft altitude step for Middle TN — the FULL 3.5%, never rounded to 3%', () => {
    // Kyle's review (2026-08-29) caught 14 × 0.97 = 13.58 on a customer
    // document — round2 on the factor had turned 0.965 into an untraceable
    // 0.97. The factor keeps three decimals now: 14 × 0.965 = 13.51.
    expect(siteDerateFactor(undefined)).toBe(0.965)
    expect(sizeToModel(13.5, 'LP', siteDerateFactor(undefined)).siteDeratedKW).toBe(13.51)
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
    expect(rec.siteDerateFactor).toBe(0.965)
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
        // Ballast: EVSE raises the whole-home load but never enters the
        // partial tier, keeping this fixture under the collapse guardrail so
        // the 220.60 selection itself is what's under test.
        load({ type: 'evse', label: 'EV charger', nameplateKW: 9.6 }),
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
      loads: [
        load({ type: 'range', label: 'Range', nameplateKW: 12 }),
        // Ballast — see the 220.60 test: keeps the tier under the collapse
        // guardrail without touching the cooking demand under test.
        load({ type: 'evse', label: 'EV charger', nameplateKW: 9.6 }),
      ],
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

  it('SACM first for compressors, SMMs for the rest, strips on the verify path (Appendix B)', () => {
    const rec = recommend(allElectric)
    const managed = rec.wholeHome[1]
    const plan = managed.managementPlan!
    // Compressors take the free SACM slots on the earliest priorities.
    expect(plan.managed[0].label).toBe('Heat pump')
    expect(plan.managed[0].mechanism).toContain('SACM')
    expect(plan.managed[0].priority).toBe(1)
    expect(plan.managed[0].bomSlot).toBeNull() // zero marginal hardware
    expect(plan.managed[1].mechanism).toContain('SACM')
    // Rule 4: strips may ride the compressor's interrupted t-stat call —
    // never silently assumed; the dedicated SMM is planned WITH the verify flag.
    const strips = plan.managed.find((r) => r.label.includes('strip kit'))!
    expect(strips.mechanism).toContain('field-verify')
    expect(strips.bomSlot).toContain('SMM')
    expect(strips.flags.join(' ')).toContain('aux-heat staging')
    // Appliances ride SMMs (range at exactly 50 A resistive fits the 50A module).
    const range = plan.managed.find((r) => r.label === 'Range')!
    expect(range.mechanism).toContain('50A SMM')
    // 5 billable SMM lines: strips, range, dryer, WH, EVSE. Nothing refused.
    expect(managed.priceBookRefs.filter((r) => r.includes('SMM')).length).toBe(5)
    expect(plan.refused).toEqual([])
    // Everything validly managed leaves the base: lighting/SA/laundry only.
    expect(managed.requiredKW).toBeCloseTo(11.04, 1)
    expect(managed.model?.generatorModel).toBe('7223')
    expect(managed.notes.join(' ')).toContain('Recovery')
  })

  it('warns when the largest managed load exceeds the headroom, naming the step-up', () => {
    // 14 kW unit − 11.04 base ≈ 3 kW headroom; the range (12 kW) exceeds it.
    const managed = recommend(allElectric).wholeHome[1]
    const note = managed.notes.join(' ')
    expect(note).toContain('rarely or never')
    expect(note).toContain('Range')
    expect(note).toContain('7209') // base + range = 23.04 kW → 24/21 on LP
  })

  it('5th compressor falls to an SMM with the rating check; over-ratings are refused — no phantom shedding', () => {
    const five = input({
      loads: [
        ...Array.from({ length: 4 }, (_, i) =>
          load({ type: 'cooling', label: `A/C ${i + 1}`, amps: 17, volts: 240, lockedRotorAmps: 100 })),
        load({ type: 'cooling', label: 'A/C 5 (small)', amps: 17, volts: 240, lockedRotorAmps: 100 }),
        load({ type: 'cooling', label: 'A/C 6 (5-ton)', amps: 26, volts: 240, lockedRotorAmps: 230 }),
      ],
    })
    const plan = recommend(five).wholeHome[1].managementPlan!
    // 5th compressor: no SACM slot left → 50A SMM, within 40 A / 180 LRA.
    const fifth = plan.managed.find((r) => r.label === 'A/C 5 (small)')!
    expect(fifth.mechanism).toContain('50A SMM')
    expect(fifth.bomSlot).toContain('SMM')
    // 6th (5-ton, 230 LRA): over the SMM's 180 LRA with no SACM slot → refused,
    // returns to the base load (rule 5 — the tier steps up instead of lying).
    const refused = plan.refused.find((r) => r.label === 'A/C 6 (5-ton)')!
    expect(refused.reason).toContain('no management path')
    expect(plan.managed.some((r) => r.label === 'A/C 6 (5-ton)')).toBe(false)
  })

  it('9th managed load is refused at the combined cap', () => {
    const crowded = input({
      loads: [
        ...Array.from({ length: 4 }, (_, i) =>
          load({ type: 'cooling', label: `A/C ${i + 1}`, amps: 17, volts: 240, lockedRotorAmps: 100 })),
        load({ type: 'waterHeaterTank', label: 'WH', nameplateKW: 4.5 }),
        load({ type: 'dryer', label: 'Dryer', nameplateKW: 5 }),
        load({ type: 'range', label: 'Range', nameplateKW: 12 }),
        load({ type: 'evse', label: 'EVSE', nameplateKW: 9.6 }),
        load({ type: 'poolHeater', label: 'Pool heater', nameplateKW: 11 }),
      ],
    })
    const plan = recommend(crowded).wholeHome[1].managementPlan!
    expect(plan.managed.length).toBe(8)
    expect(plan.refused.length).toBe(1)
    expect(plan.refused[0].label).toBe('Pool heater')
    expect(plan.refused[0].reason).toContain('cap')
  })

  it('a load over 50 A resistive gets the 100A module with the verify flag', () => {
    const big = input({
      loads: [load({ type: 'waterHeaterTankless', label: 'Tankless WH', nameplateKW: 13, fuel: 'electric' })],
    })
    const plan = recommend(big).wholeHome[1].managementPlan!
    const row = plan.managed.find((r) => r.label === 'Tankless WH')!
    expect(row.mechanism).toContain('100A SMM')
    expect(row.flags.join(' ')).toContain('unverified')
  })

  it('collapses the essential tier when it saves nothing vs whole home (Kyle review, 2026-08-29)', () => {
    // This all-electric house's essentials ARE the house: partial 29.72 kW vs
    // ~32.9 kW whole-home (>85%). Printing both reads as "part of my house
    // costs more than all of it" — the tier is suppressed with the reason.
    const rec = recommend(allElectric)
    expect(rec.partial).toBeNull()
    const flag = rec.flags.find((f) => f.id === 'partial_no_savings')
    expect(flag).toBeDefined()
    expect(flag!.message).toContain('saves nothing')
    const interlock = rec.wholeHome.find((s) => s.scheme === 'interlock_manual')!
    expect(interlock.notes.join(' ')).toContain('suppressed')
  })

  it('EVSE is excluded from the partial tier and listed as not covered', () => {
    // A lighter mixed-fuel house, so the tier survives the collapse guardrail
    // and the EVSE rule itself is what's under test.
    const mixedFuel = input({
      loads: [
        load({ type: 'cooling', label: 'A/C', amps: 17, volts: 240 }),
        load({ type: 'range', label: 'Range', nameplateKW: 12 }),
        load({ type: 'evse', label: 'EV charger (40 A)', nameplateKW: 9.6 }),
      ],
    })
    const partial = recommend(mixedFuel).partial!
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

describe('shed selection — the tech chooses what Option 2 may manage (Joe scenario, 2026-08-31)', () => {
  const joe = input({
    loads: [
      load({ id: 'ac', type: 'cooling', label: 'A/C condenser', nameplateVA: 4000, lockedRotorAmps: 60 }),
      load({ id: 'strip', type: 'spaceHeat', label: 'Heat strips', nameplateVA: 9600 }),
      load({ id: 'rg', type: 'range', label: 'Range', nameplateKW: 12 }),
      load({ id: 'wh', type: 'waterHeaterTank', label: 'Water heater', nameplateKW: 4.5 }),
    ],
  })

  it('range-only selection manages the range and nothing else', () => {
    const managed = recommend(joe, { shedSelection: ['rg'] }).wholeHome[1]
    expect(managed.managementPlan!.managed.map((r) => r.label)).toEqual(['Range'])
    expect(managed.managementPlan!.managed[0].mechanism).toContain('50A SMM')
    // The base is the same Article 220 engine run without the range — nothing else left it.
    const baseWithoutRange = calculateLoad({ ...joe, loads: joe.loads.filter((l) => l.id !== 'rg') })
    expect(managed.requiredAmps).toBe(baseWithoutRange.governingAmps)
    // And the reduction is the demand-staged difference, never the 12 kW nameplate.
    const fullAmps = calculateLoad(joe).governingAmps
    expect(fullAmps - managed.requiredAmps!).toBeLessThan(12000 / 240)
    expect(fullAmps - managed.requiredAmps!).toBeGreaterThan(0)
  })

  it('absent selection keeps the original behavior — every valid candidate is managed', () => {
    const managed = recommend(joe).wholeHome[1]
    expect(managed.managementPlan!.managed.length).toBe(4)
  })

  it('the managed scheme carries its base breakdown for the data sheet', () => {
    const managed = recommend(joe, { shedSelection: ['rg'] }).wholeHome[1]
    expect(managed.baseBreakdown!.length).toBeGreaterThan(0)
    expect(managed.baseBreakdown!.some((l) => l.label.includes('Range'))).toBe(false)
  })
})

describe('shed scenarios — the customer-facing load-management menu', () => {
  const house = input({
    loads: [
      load({ id: 'ac2', type: 'cooling', label: 'A/C condenser', nameplateVA: 4000, lockedRotorAmps: 60 }),
      load({ id: 'rg2', type: 'range', label: 'Range', nameplateKW: 12 }),
      load({ id: 'dr2', type: 'dryer', label: 'Dryer', nameplateKW: 5 }),
      load({ id: 'wh2', type: 'waterHeaterTank', label: 'Water heater', nameplateKW: 4.5 }),
    ],
  })

  it('one row per manageable load, sorted by saving, plus the everything floor', () => {
    const rec = recommend(house)
    const labels = rec.shedScenarios.map((s) => s.label)
    expect(labels).toContain('Range')
    expect(labels).toContain('A/C condenser')
    expect(labels[labels.length - 1]).toBe('Every manageable load')
    const reductions = rec.shedScenarios.slice(0, -1).map((s) => s.reductionKW)
    expect([...reductions].sort((a, b) => b - a)).toEqual(reductions)
  })

  it('the range row shows the demand-staged saving, not 12 kW off', () => {
    const rec = recommend(house)
    const range = rec.shedScenarios.find((s) => s.label === 'Range')!
    // 220.82: the range rides the 40% tier — managing it saves 4.8 kW, never 12.
    expect(range.reductionKW).toBeGreaterThan(0)
    expect(range.reductionKW).toBeLessThan(12)
    expect(range.reductionKW).toBeCloseTo(4.8, 1)
  })
})
