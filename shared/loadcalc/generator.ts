/**
 * Generator sizing recommendation (P031, Kyle 2026-08-27; Generac amendment
 * 2026-08-28).
 *
 * Consumes the Article 220 engine's own input and result — one fact, one home;
 * this module never re-derives a service load. Two tiers:
 *
 *   Tier A — whole-home, three schemes, each labeled with its NEC 2017 basis:
 *     ATS full-load        702.4(B)(2)(a)
 *     ATS + load mgmt      702.4(B)(2)(b) — Generac shed-slot caps enforced
 *     Interlock / manual   702.4(B)(1) — no code-minimum size
 *
 *   Tier B — partial "essential loads", Kyle's ratified scope exactly:
 *     larger of heating vs cooling (220.60, fuel-aware), both small-appliance
 *     circuits + refrigerator + microwave, water heater nameplate, cooking via
 *     Table 220.55 demand. Lighting and general-use circuits are EXCLUDED by
 *     ruling and must appear under "Not covered".
 *
 * Sizing selects the smallest Generac Guardian model whose FUEL-MATCHED
 * published rating (NG rating for NG homes, LP for LP) carries the requirement
 * after site derates — never an NG number computed from the LP one. Every
 * constant lives in generatorData.ts as editable data carrying its source
 * revision. Every output carries the preliminary-sizing disclaimer.
 */

import {
  calculateLoad,
  cookingDemandVA,
  resolveVA,
  roundAmps,
  type LoadCalcInput,
  type LoadCalcResult,
  type LoadItem,
} from './loadcalc'
import {
  ALTITUDE_DERATE_PER_1000FT,
  DEFAULT_ALTITUDE_STEPS,
  FUEL_SUPPLY_SCOPE_LINE,
  GENERAC_DATA_REVISION,
  GENERAC_GUARDIAN_MODELS,
  GENERAC_SURGE_PUBLISHED,
  GENERATOR_DISCLAIMER,
  HEAT_KIT_SHED_VERIFY,
  LRA_PER_TON_ESTIMATE,
  MICROWAVE_DEFAULT_VA,
  PARTIAL_COLLAPSE_RATIO,
  PRICE_BOOK_SLOTS,
  REFRIGERATOR_DEFAULT_VA,
  SHED_CANDIDATE_TYPES,
  SMALL_APPLIANCE_CIRCUITS_VA,
  SMART_SWITCH_AC_SLOTS,
  SMM_MAX_MODULES,
  SMM_MODULES,
  SOFT_START_LRA_FACTOR,
  STRIP_HEAT_THRESHOLD_KW,
  SURGE_VERIFY_FLAG_TEXT,
  TEMP_DERATE_PER_10F_ABOVE_60,
  type GeneracModel,
} from './generatorData'

// ── Types ────────────────────────────────────────────────────────────────────

export type GeneratorFuel = 'NG' | 'LP'

export interface SiteConditions {
  /** 1,000-ft altitude steps. DEFAULT 1 for Middle TN; tech-overridable. */
  altitudeSteps?: number
  /** Design ambient °F; derate applies above 60 °F. Absent = no temp derate. */
  ambientF?: number
}

export interface GeneratorInput {
  calcInput: LoadCalcInput
  calcResult: LoadCalcResult
  fuel: GeneratorFuel
  /** Soft-start kit assumed on the largest compressor — relaxes the surge check
   * and adds a scope line. */
  softStart: boolean
  site?: SiteConditions
  /**
   * 220.87 demand-basis amps when qualifying demand records exist
   * (existingDemandAmps). Preferred over the calculation for the full-load
   * scheme per 702.4(B)(2)(a); the output states which basis was used.
   */
  demandBasisAmps?: number
}

export interface GeneratorFlag {
  id: string
  severity: 'hard' | 'advisory'
  message: string
}

export interface ModelSizing {
  /** Selected Guardian model; null → liquid-cooled (Protector) class. */
  model: GeneracModel | null
  /** The fuel-matched published rating of that model, kW. */
  ratedKW: number | null
  /** Rating after site derates — what the unit delivers at this site, kW. */
  siteDeratedKW: number | null
  liquidCooled: boolean
}

export interface SchemeResult extends ModelSizing {
  scheme: 'ats_full_load' | 'ats_load_management' | 'interlock_manual'
  title: string
  necBasis: string
  /** Which numbers fed the size: '220.87 demand data' | 'Article 220 calculation' | 'essential-loads selection'. */
  loadBasis: string
  requiredKW: number | null // null for interlock — 702.4(B)(1) sets no minimum
  requiredAmps: number | null
  /** Labels of the loads assumed on shed devices (load-management scheme only). */
  shedLoads?: string[]
  /** Price-book package references, one line per component (unit, switch, SMMs). */
  priceBookRefs: string[]
  notes: string[]
}

export interface CoveredLine {
  label: string
  va: number
  rule: string
}

export interface PartialTierResult extends ModelSizing {
  requiredKW: number
  requiredAmps: number
  covered: CoveredLine[]
  /** Always includes lighting & general-use circuits — Kyle's ruling, stated, never silent. */
  notCovered: string[]
  /** Present-but-excluded loads with the reason (tankless, EVSE, gas appliances). */
  excludedWithReason: string[]
  priceBookRefs: string[]
}

export interface SurgeCheck {
  status: 'ok' | 'pending' | 'none'
  largestMotorLabel: string | null
  startKVA: number | null
  estimatedFromTons: boolean
  softStartApplied: boolean
  message: string
}

export interface GeneratorRecommendation {
  wholeHome: SchemeResult[]
  /** Null when a hard disqualifier forces whole-home/liquid-cooled guidance. */
  partial: PartialTierResult | null
  flags: GeneratorFlag[]
  surge: SurgeCheck
  fuel: GeneratorFuel
  /** Site derate factor applied to every published rating (1 = none). */
  siteDerateFactor: number
  /** Scope-sheet lines carried on every recommendation (fuel supply, soft start). */
  scopeLines: string[]
  /** Source revision of the model table — displayed so stale data is visible. */
  dataRevision: string
  disclaimer: string
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const kwOf = (va: number) => Math.round((va / 1000) * 100) / 100
const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * Site derate factor per Generac published figures (amendment rule 3).
 * Three decimals, NOT two: one altitude step is −3.5 %, and rounding the
 * factor itself turned 0.965 into 0.97 — an untraceable 3 % that survived
 * into a customer document until Kyle's review caught it (2026-08-29).
 */
export function siteDerateFactor(site?: SiteConditions): number {
  const altSteps = site?.altitudeSteps ?? DEFAULT_ALTITUDE_STEPS
  const tempSteps = site?.ambientF !== undefined ? Math.max(0, (site.ambientF - 60) / 10) : 0
  const factor = 1 - altSteps * ALTITUDE_DERATE_PER_1000FT - tempSteps * TEMP_DERATE_PER_10F_ABOVE_60
  return Math.max(0, Math.round(factor * 1000) / 1000)
}

const fuelKW = (model: GeneracModel, fuel: GeneratorFuel) =>
  (fuel === 'NG' ? model.ngWatts : model.lpWatts) / 1000

/**
 * Smallest Guardian model whose FUEL-MATCHED published rating carries the
 * requirement after site derates. No interpolation, no invented sizes; above
 * the table → liquid-cooled class (amendment rule 1).
 */
export function sizeToModel(requiredKW: number, fuel: GeneratorFuel, derate: number): ModelSizing {
  for (const model of GENERAC_GUARDIAN_MODELS) {
    const rated = fuelKW(model, fuel)
    if (rated * derate >= requiredKW - 1e-9) {
      return { model, ratedKW: rated, siteDeratedKW: round2(rated * derate), liquidCooled: false }
    }
  }
  return { model: null, ratedKW: null, siteDeratedKW: null, liquidCooled: true }
}

const isElectric = (item: LoadItem) => (item.fuel ?? 'electric') === 'electric'

/** Total resistance strip kW: electric spaceHeat plus heat-pump supplemental. */
function stripHeatKW(loads: LoadItem[]): number {
  const spaceHeat = loads
    .filter((l) => l.type === 'spaceHeat' && isElectric(l))
    .reduce((s, l) => s + resolveVA(l), 0)
  const hpSupp = loads
    .filter((l) => l.type === 'heatPump')
    .reduce((s, l) => s + (l.heatPump?.supplementalVA ?? 0), 0)
  return kwOf(spaceHeat + hpSupp)
}

/**
 * Largest-motor surge demand. LRA off the plate wins; tonnage estimates it
 * (editable A/ton constant); neither present on any compressor → pending flag.
 */
function surgeCheck(loads: LoadItem[], softStart: boolean): SurgeCheck {
  const motors = loads.filter((l) => l.type === 'cooling' || l.type === 'heatPump')
  if (motors.length === 0) {
    return {
      status: 'none', largestMotorLabel: null, startKVA: null,
      estimatedFromTons: false, softStartApplied: false,
      message: 'No compressor loads in the inventory — no motor-start check applies.',
    }
  }
  let best: { label: string; lra: number; estimated: boolean } | null = null
  for (const m of motors) {
    const lra = m.lockedRotorAmps ?? (m.tons !== undefined ? m.tons * LRA_PER_TON_ESTIMATE : undefined)
    if (lra === undefined) continue
    if (!best || lra > best.lra) best = { label: m.label, lra, estimated: m.lockedRotorAmps === undefined }
  }
  if (!best) {
    return {
      status: 'pending', largestMotorLabel: motors[0].label, startKVA: null,
      estimatedFromTons: false, softStartApplied: false,
      message: 'Surge check pending — provide condenser LRA or tonnage.',
    }
  }
  const factor = softStart ? SOFT_START_LRA_FACTOR : 1
  const startKVA = round2((best.lra * factor * 240) / 1000)
  return {
    status: 'ok',
    largestMotorLabel: best.label,
    startKVA,
    estimatedFromTons: best.estimated,
    softStartApplied: softStart,
    message: softStart
      ? `Largest motor ${best.label}: ${startKVA} kVA start with soft-start kit applied.`
      : `Largest motor ${best.label}: ${startKVA} kVA locked-rotor start.`,
  }
}

/**
 * Surge note for one sized selection. Generac publishes motor-starting
 * sparsely (amendment rule 4): a model with published surge gets a real
 * comparison; an unpublished one must emit the verify-with-dealer line rather
 * than pass silently.
 */
function surgeNoteFor(sizing: ModelSizing, surge: SurgeCheck): string | null {
  if (surge.status !== 'ok' || surge.startKVA === null) return null
  if (sizing.model === null) return null // liquid-cooled — dealer sizing covers it
  const published = GENERAC_SURGE_PUBLISHED[sizing.model.generatorModel]
  if (!published) return SURGE_VERIFY_FLAG_TEXT
  if (published.kva >= surge.startKVA) return null
  return (
    `Motor start ${surge.startKVA} kVA exceeds this model's published ` +
    `${published.kva} kVA motor-starting capability` +
    (surge.softStartApplied ? '.' : ' — a soft-start kit or the next size resolves it.')
  )
}

// ── Tier B — partial home, Kyle's ratified scope exactly ─────────────────────

interface PartialBuild {
  covered: CoveredLine[]
  excludedWithReason: string[]
  totalVA: number
}

function buildPartialLoads(loads: LoadItem[]): PartialBuild {
  const covered: CoveredLine[] = []
  const excluded: string[] = []

  // Larger of heating vs cooling — 220.60 noncoincident. Fuel-aware heating:
  // gas heat backs up as its blower (the item's own VA as entered); heat pump
  // includes strip kW; electric resistance counts in full.
  const heatVA = loads.reduce((sum, l) => {
    if (l.type === 'spaceHeat') return sum + resolveVA(l) // gas item VA = blower
    if (l.type === 'heatPump' && l.heatPump) return sum + l.heatPump.compressorVA + l.heatPump.supplementalVA
    return sum
  }, 0)
  const coolVA = loads.reduce((sum, l) => {
    if (l.type === 'cooling') return sum + resolveVA(l)
    if (l.type === 'heatPump' && l.heatPump) return sum + l.heatPump.compressorVA
    return sum
  }, 0)
  if (heatVA > 0 || coolVA > 0) {
    const winner = heatVA >= coolVA ? 'heating' : 'cooling'
    covered.push({
      label: `Heating or cooling, whichever is larger (${winner} governs)`,
      va: Math.max(heatVA, coolVA),
      rule: '220.60 — noncoincident loads; only the larger can run',
    })
  }

  // Kitchen: both small-appliance circuits, refrigerator, microwave.
  covered.push({
    label: 'Kitchen small-appliance circuits (both)',
    va: SMALL_APPLIANCE_CIRCUITS_VA,
    rule: '220.52(A) — two circuits at 1,500 VA',
  })
  const fridge = loads.find((l) => l.applianceKind === 'refrigerator')
  covered.push({
    label: fridge ? fridge.label : 'Refrigerator (typical)',
    va: fridge ? resolveVA(fridge) : REFRIGERATOR_DEFAULT_VA,
    rule: 'named essential load',
  })
  const microwave = loads.find((l) => l.applianceKind === 'microwave')
  covered.push({
    label: microwave ? microwave.label : 'Microwave (typical)',
    va: microwave ? resolveVA(microwave) : MICROWAVE_DEFAULT_VA,
    rule: 'named essential load',
  })

  // Water heater at nameplate. Electric tankless is a hard disqualifier for
  // this tier (18–36 kW continuous — outside the air-cooled class); gas units
  // aren't an electric load and are excluded with the reason stated.
  for (const wh of loads.filter((l) => l.type === 'waterHeaterTank' || l.type === 'waterHeaterTankless')) {
    if (!isElectric(wh)) {
      excluded.push(`${wh.label} — ${wh.fuel} fired; negligible electrical load`)
      continue
    }
    if (wh.type === 'waterHeaterTankless') {
      excluded.push(
        `${wh.label} — electric tankless water heaters draw ${kwOf(resolveVA(wh))} kW continuously, ` +
        'beyond the air-cooled standby class; not covered in the essential-loads tier',
      )
      continue
    }
    covered.push({ label: wh.label, va: resolveVA(wh), rule: '702 selected load at nameplate' })
  }

  // Cooking via Table 220.55 demand, electric appliances only.
  const cooking = loads.filter(
    (l) => (l.type === 'range' || l.type === 'oven' || l.type === 'cooktop') && isElectric(l),
  )
  if (cooking.length > 0) {
    covered.push({
      label: cooking.map((c) => c.label).join(', '),
      va: cookingDemandVA(cooking),
      rule: 'Table 220.55 Column C demand',
    })
  }
  for (const gasCook of loads.filter(
    (l) => (l.type === 'range' || l.type === 'oven' || l.type === 'cooktop') && !isElectric(l),
  )) {
    excluded.push(`${gasCook.label} — ${gasCook.fuel} fired; negligible electrical load`)
  }

  // EVSE never counts in the partial tier (P031 hard rule).
  for (const evse of loads.filter((l) => l.type === 'evse')) {
    excluded.push(`${evse.label} — EV charging is never carried on the essential-loads tier`)
  }

  return {
    covered,
    excludedWithReason: excluded,
    totalVA: covered.reduce((s, c) => s + c.va, 0),
  }
}

// ── Load-management shed slots (amendment rule 2, Generac hardware caps) ────

interface ShedPlan {
  /** Items actually assumed shed, within hardware capacity. */
  shed: LoadItem[]
  /** Shed candidates that did NOT fit the hardware — they stay in the managed load. */
  overflow: LoadItem[]
  /** Smart Management Modules assumed: one per non-A/C shed load, plus one per shed heat-strip kit. */
  smmCount: number
  /** How many of those SMMs are budgeted for heat-strip kits (needs field verification). */
  stripKitSmmCount: number
}

function planShedding(loads: LoadItem[]): ShedPlan {
  const candidates = loads.filter((l) => SHED_CANDIDATE_TYPES.includes(l.type))
  const acLoads = candidates.filter((l) => l.type === 'cooling' || l.type === 'heatPump')
  const others = candidates.filter((l) => l.type !== 'cooling' && l.type !== 'heatPump')
  // The 200A smart switch natively manages up to 4 A/C COMPRESSOR loads;
  // everything else needs an SMM, and there are at most 8 of those. A shed
  // heat pump's resistance kit is NOT a compressor — its shedding budgets an
  // SMM of its own, flagged for field verification (Kyle's review 2026-08-29).
  const shedAC = acLoads.slice(0, SMART_SWITCH_AC_SLOTS)
  const stripKitSmmCount = shedAC.filter(
    (l) => l.type === 'heatPump' && (l.heatPump?.supplementalVA ?? 0) > 0,
  ).length
  const smmForOthers = Math.max(0, SMM_MAX_MODULES - stripKitSmmCount)
  const shedOther = others.slice(0, smmForOthers)
  return {
    shed: [...shedAC, ...shedOther],
    overflow: [...acLoads.slice(SMART_SWITCH_AC_SLOTS), ...others.slice(smmForOthers)],
    smmCount: shedOther.length + stripKitSmmCount,
    stripKitSmmCount,
  }
}

/** One SMM reference per assumed module (amendment: each must emit a line). */
function smmRefs(smmCount: number): string[] {
  // Module size is picked at install per circuit ampacity; the reference emits
  // the 50 A part as the default line item, one per assumed module.
  return Array.from({ length: smmCount }, (_, i) => `${PRICE_BOOK_SLOTS.smm50} — ${SMM_MODULES.amp50} #${i + 1}`)
}

function generatorRefs(sizing: ModelSizing): string[] {
  if (sizing.model === null) return [PRICE_BOOK_SLOTS.liquidCooled]
  return [
    PRICE_BOOK_SLOTS.generator(sizing.model.generatorModel),
    PRICE_BOOK_SLOTS.switchPackage(sizing.model.switchPackage),
  ]
}

// ── The recommendation ───────────────────────────────────────────────────────

export function recommendGenerator(input: GeneratorInput): GeneratorRecommendation {
  const { calcInput, calcResult, fuel, softStart } = input
  const derate = siteDerateFactor(input.site)
  const flags: GeneratorFlag[] = []
  const surge = surgeCheck(calcInput.loads, softStart)
  if (surge.status === 'pending') {
    flags.push({ id: 'surge_pending', severity: 'advisory', message: surge.message })
  }

  // ── Hard disqualifiers ──
  const tankless = calcInput.loads.filter((l) => l.type === 'waterHeaterTankless' && isElectric(l))
  for (const t of tankless) {
    flags.push({
      id: 'tankless_electric',
      severity: 'hard',
      message:
        `${t.label} (${kwOf(resolveVA(t))} kW): electric tankless water heating exceeds the ` +
        'air-cooled standby class. Excluded from the essential-loads tier; whole-home service ' +
        'requires load management or liquid-cooled equipment.',
    })
  }
  const stripsKW = stripHeatKW(calcInput.loads)
  // >= so the threshold itself trips the flag (P031 test spec: 10 kW strips →
  // threshold flag) — a boundary can only over-warn, never under-warn.
  const stripsOverThreshold = stripsKW >= STRIP_HEAT_THRESHOLD_KW
  if (stripsOverThreshold) {
    flags.push({
      id: 'strip_heat_over_threshold',
      severity: 'hard',
      message:
        `${stripsKW} kW of resistance strip heat meets or exceeds the ${STRIP_HEAT_THRESHOLD_KW} kW ` +
        'threshold for an essential-loads tier — recommend whole-home sizing with load ' +
        'management, or liquid-cooled equipment.',
    })
  }

  // ── Tier B first — the interlock scheme presents it as guidance ──
  const partialBuild = buildPartialLoads(calcInput.loads)
  const partialAmps = roundAmps(partialBuild.totalVA / 240)
  const partialKW = kwOf(partialBuild.totalVA)
  const partialSizing = sizeToModel(partialKW, fuel, derate)

  // Guardrail (Kyle's review, 2026-08-29): on an all-electric house the
  // "essentials" ARE the house, and the essentials tier — summed at full value
  // — can exceed the demand-factored 220.82 whole-home number. Printing both
  // reads as "part of my house costs more than all of it," so at ≥ the
  // collapse ratio the tier is suppressed with the reason stated.
  const fullBasisAmpsEarly = input.demandBasisAmps ?? calcResult.governingAmps
  const fullKWEarly = kwOf(fullBasisAmpsEarly * 240)
  const partialSavesNothing =
    fullKWEarly > 0 && partialKW >= PARTIAL_COLLAPSE_RATIO * fullKWEarly
  if (partialSavesNothing && !stripsOverThreshold) {
    flags.push({
      id: 'partial_no_savings',
      severity: 'advisory',
      message:
        `The essential-loads tier calculates to ${partialKW} kW — ` +
        `${Math.round((partialKW / fullKWEarly) * 100)}% of the ${fullKWEarly} kW whole-home load. ` +
        'A partial backup saves nothing here; recommend whole-home sizing (with load management where it fits).',
    })
  }

  const partial: PartialTierResult | null = stripsOverThreshold || partialSavesNothing
    ? null
    : {
        ...partialSizing,
        requiredKW: partialKW,
        requiredAmps: partialAmps,
        covered: partialBuild.covered,
        // Kyle's ruling (2026-08-27): lighting and general-use circuits are
        // excluded from the essential tier, and the customer document says so
        // explicitly — never silently.
        notCovered: [
          'Lighting and general-use receptacle circuits',
          'Clothes dryer and laundry beyond the essential circuits',
          ...(calcInput.loads.some((l) => l.type === 'evse') ? ['EV charging'] : []),
        ],
        excludedWithReason: partialBuild.excludedWithReason,
        priceBookRefs: partialSizing.model !== null
          ? [PRICE_BOOK_SLOTS.generator(partialSizing.model.generatorModel), PRICE_BOOK_SLOTS.interlock]
          : [PRICE_BOOK_SLOTS.liquidCooled],
      }

  // ── Tier A — three whole-home schemes ──
  // Scheme 1: ATS, full-load sized — 702.4(B)(2)(a). Prefer 220.87 demand data.
  const fullBasisAmps = fullBasisAmpsEarly
  const fullBasis = input.demandBasisAmps !== undefined
    ? '220.87 demand data (recorded maximum demand)'
    : `Article 220 calculation (${calcResult.methodUsed} method)`
  const fullKW = fullKWEarly
  const fullSizing = sizeToModel(fullKW, fuel, derate)
  const fullNotes: string[] = []
  const fullSurgeNote = surgeNoteFor(fullSizing, surge)
  if (fullSurgeNote) fullNotes.push(fullSurgeNote)

  // Scheme 2: ATS + load management — 702.4(B)(2)(b). The managed load is the
  // same Article 220 engine run on the inventory minus the shed loads — no
  // second load model. Shedding respects Generac hardware caps: 4 native A/C
  // slots on the 200A smart switch, 8 further 240 V loads via SMMs.
  const shedPlan = planShedding(calcInput.loads)
  const shedIds = new Set(shedPlan.shed.map((l) => l.id))
  const managedResult: LoadCalcResult = calculateLoad({
    ...calcInput,
    loads: calcInput.loads.filter((l) => !shedIds.has(l.id)),
    futureLoads: [],
  })
  const managedKW = kwOf(managedResult.governingAmps * 240)
  const managedSizing = sizeToModel(managedKW, fuel, derate)
  const managedNotes: string[] = [
    shedPlan.shed.length > 0
      ? `Assumes shed devices on: ${shedPlan.shed.map((l) => l.label).join('; ')}.`
      : 'No shed candidates in the inventory — identical to full-load sizing.',
  ]
  if (shedPlan.smmCount > 0) {
    managedNotes.push(
      `${shedPlan.smmCount} Smart Management Module${shedPlan.smmCount > 1 ? 's' : ''} assumed ` +
      `(200A smart switch manages up to ${SMART_SWITCH_AC_SLOTS} A/C compressor loads natively; up to ${SMM_MAX_MODULES} SMMs).`,
    )
  }
  if (shedPlan.stripKitSmmCount > 0) {
    managedNotes.push(HEAT_KIT_SHED_VERIFY)
  }
  if (shedPlan.overflow.length > 0) {
    managedNotes.push(
      `Beyond hardware capacity — stays in the managed load: ${shedPlan.overflow.map((l) => l.label).join('; ')}.`,
    )
  }
  // Legal isn't the same as livable (Kyle's review, 2026-08-29): 702.4(B)(2)(b)
  // is satisfied by any size that carries the managed base, but when the
  // largest shed load exceeds the headroom above that base, it will rarely or
  // never run in an outage — say so, and name the size that carries it.
  if (shedPlan.shed.length > 0 && managedSizing.siteDeratedKW !== null) {
    const largestShed = shedPlan.shed.reduce(
      (best, l) => {
        const kw = kwOf(l.type === 'heatPump' && l.heatPump
          ? l.heatPump.compressorVA + l.heatPump.supplementalVA
          : resolveVA(l))
        return kw > best.kw ? { label: l.label, kw } : best
      },
      { label: '', kw: 0 },
    )
    const headroomKW = round2(managedSizing.siteDeratedKW - managedKW)
    if (largestShed.kw > headroomKW) {
      const stepUp = sizeToModel(managedKW + largestShed.kw, fuel, derate)
      managedNotes.push(
        `Managed loads run only as capacity allows: ~${headroomKW} kW of headroom above the base load, ` +
        `but the largest shed load (${largestShed.label}, ${largestShed.kw} kW) exceeds it — ` +
        `expect it to run rarely or never during an outage. ` +
        (stepUp.model !== null
          ? `For it to run under load management, the Guardian ${stepUp.model.classLabel} kW (model ${stepUp.model.generatorModel}) carries base plus that load.`
          : 'Carrying base plus that load requires the liquid-cooled class.'),
      )
    }
  }
  const managedSurgeNote = surgeNoteFor(managedSizing, surge)
  if (managedSurgeNote) managedNotes.push(managedSurgeNote)

  // Scheme 3: interlock / manual transfer — 702.4(B)(1): the user selects the
  // load; there is no code-minimum size. The essential-loads tier is offered as
  // the guidance number.
  const interlockNotes = [
    'Manual transfer: the homeowner chooses what runs; code sets no minimum size (702.4(B)(1)).',
    partial !== null
      ? `Guidance: the essential-loads tier below (${partialKW} kW calculated) is the working target.`
      : 'Essential-loads tier suppressed — see flags for the reason.',
  ]
  const scopeLines: string[] = [FUEL_SUPPLY_SCOPE_LINE]
  if (softStart) {
    const softStartLine = 'Scope includes a compressor soft-start kit.'
    scopeLines.push(softStartLine)
    fullNotes.push(softStartLine)
    managedNotes.push(softStartLine)
  }

  const wholeHome: SchemeResult[] = [
    {
      scheme: 'ats_full_load',
      title: 'Automatic transfer, sized for the full calculated load',
      necBasis: 'NEC 2017 702.4(B)(2)(a)',
      loadBasis: fullBasis,
      requiredKW: fullKW,
      requiredAmps: fullBasisAmps,
      ...fullSizing,
      priceBookRefs: [
        ...generatorRefs(fullSizing),
        ...(softStart ? [PRICE_BOOK_SLOTS.softStartKit] : []),
      ],
      notes: fullNotes,
    },
    {
      scheme: 'ats_load_management',
      title: 'Automatic transfer with load management',
      necBasis: 'NEC 2017 702.4(B)(2)(b)',
      loadBasis: `Article 220 calculation with shed loads removed (${managedResult.methodUsed} method)`,
      requiredKW: managedKW,
      requiredAmps: managedResult.governingAmps,
      ...managedSizing,
      shedLoads: shedPlan.shed.map((l) => l.label),
      priceBookRefs: [
        ...generatorRefs(managedSizing),
        ...smmRefs(shedPlan.smmCount),
        ...(softStart ? [PRICE_BOOK_SLOTS.softStartKit] : []),
      ],
      notes: managedNotes,
    },
    {
      scheme: 'interlock_manual',
      title: 'Interlock / manual transfer',
      necBasis: 'NEC 2017 702.4(B)(1)',
      loadBasis: 'essential-loads selection (guidance only)',
      requiredKW: null,
      requiredAmps: null,
      model: partial?.model ?? null,
      ratedKW: partial?.ratedKW ?? null,
      siteDeratedKW: partial?.siteDeratedKW ?? null,
      liquidCooled: partial?.liquidCooled ?? false,
      priceBookRefs: partial?.priceBookRefs ?? [PRICE_BOOK_SLOTS.liquidCooled],
      notes: interlockNotes,
    },
  ]

  return {
    wholeHome,
    partial,
    flags,
    surge,
    fuel,
    siteDerateFactor: derate,
    scopeLines,
    dataRevision: GENERAC_DATA_REVISION,
    disclaimer: GENERATOR_DISCLAIMER,
  }
}
