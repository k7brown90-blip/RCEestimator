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
  type BreakdownLine,
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
  LOAD_MGMT_SOURCE,
  LRA_PER_TON_ESTIMATE,
  MANAGED_LOADS_TOTAL_CAP,
  MANAGED_LOAD_CUSTOMER_WORDING,
  MICROWAVE_DEFAULT_VA,
  PARTIAL_COLLAPSE_RATIO,
  PRICE_BOOK_SLOTS,
  RECOVERY_STAGGER_NOTE,
  REFRIGERATOR_DEFAULT_VA,
  SACM_SLOTS,
  SHED_CANDIDATE_TYPES,
  SMALL_APPLIANCE_CIRCUITS_VA,
  SMM_100A,
  SMM_100A_VERIFY_FLAG,
  SMM_50A,
  SOFT_START_LRA_FACTOR,
  STRIP_HEAT_THRESHOLD_KW,
  STRIP_SACM_VERIFY_FLAG,
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
  /**
   * Item ids the technician chose for load management (Joe Himrick scenario,
   * 2026-08-31: shed just the range). Absent = every valid candidate — the
   * original behavior. Present = only these items are offered to the planner;
   * everything else stays in the base load Option 2 is sized for.
   */
  shedSelection?: string[]
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
  /** Labels of the managed loads (load-management scheme only). */
  shedLoads?: string[]
  /** The full SACM/SMM plan with the installer priority table (Appendix B). */
  managementPlan?: ManagementPlan
  /**
   * Line-by-line Article 220 breakdown of the managed base (load-management
   * scheme only) — printed on the data sheet so "shedding the range" visibly
   * does not subtract its nameplate one-for-one.
   */
  baseBreakdown?: BreakdownLine[]
  /**
   * Where this scheme's requirement sits against the air-cooled ceiling (Kyle,
   * 2026-08-31: "I do not want to get into liquid cooled generators… have a
   * flag that shows once we go over"). The engine never changes the tech's
   * shed selection on its own — over the line it FLAGS and the shed menu shows
   * which loads bring it under. `overByKW` is 0 when it fits.
   */
  airCooled?: { ceilingKW: number; fits: boolean; overByKW: number }
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

/**
 * One row of the customer-facing load-management menu (Kyle, 2026-08-31: "allow
 * us to produce a variety of options to shed to give the customer control over
 * what installation they want"): what managing a given load does to the
 * required generator size — its own full Article 220 run, so the saving shown
 * is the demand-staged truth, never a nameplate subtracted one-for-one.
 */
export interface ShedScenario {
  /** e.g. 'Range', or 'Every manageable load'. */
  label: string
  managedLabels: string[]
  requiredKW: number
  requiredAmps: number
  /** vs the full calculated load (Article 220 basis). */
  reductionKW: number
  /** Whether this row's base lands within air-cooled equipment at this site. */
  fitsAirCooled: boolean
}

export interface GeneratorRecommendation {
  wholeHome: SchemeResult[]
  /** Null when a hard disqualifier forces whole-home guidance. */
  partial: PartialTierResult | null
  /** The load-management menu: one row per manageable load, plus the everything-managed floor. */
  shedScenarios: ShedScenario[]
  /** Largest fuel-matched air-cooled rating after site derates — the line nothing may land above. */
  airCooledCeilingKW: number
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

/**
 * The largest fuel-matched air-cooled rating after site derates — the ceiling
 * every recommendation must land under. Red Cedar does not install liquid-
 * cooled units (Kyle, 2026-08-31); above this line the answer is load management.
 */
export function airCooledCeilingKW(fuel: GeneratorFuel, derate: number): number {
  const top = GENERAC_GUARDIAN_MODELS.reduce((best, m) => Math.max(best, fuelKW(m, fuel)), 0)
  return round2(top * derate)
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

// ── Load management — SACM vs SMM decision tree (P031 Appendix B) ────────────
// Controlling source: Generac 50A SMM manual 10000030493 Rev E. Two
// mechanisms: SACM interrupts a compressor's 24 VAC thermostat circuit (up to
// 4, priorities 1–4, zero hardware); SMMs are standalone 240 V contactors for
// any other load (each a billable BOM line). Combined cap: 8 managed loads.
// Rule 5 is the honesty rule: a load leaves the required-capacity calculation
// ONLY when a valid management path exists — no phantom shedding.

export interface ManagedLoadRow {
  label: string
  /** The inventory item this row manages — lets renderers pair a heat pump's
   * compressor and supplemental rows as stages of one unit instead of
   * printing the appliance name twice (Kyle, 2026-08-31, the Himrick sheet). */
  itemId: string
  /** Which stage of the item this row is; absent for whole-item loads. */
  stage?: 'compressor' | 'supplemental'
  kw: number
  /** 'SACM (thermostat interrupt)' | '50A SMM' | '100A SMM' | the verify-strips variant. */
  mechanism: string
  /** Suggested priority dial, 1–8 — mirrors Generac's panel decal. */
  priority: number
  /** Price-book BOM line; null for SACM (zero marginal hardware). */
  bomSlot: string | null
  flags: string[]
}

export interface RefusedLoadRow {
  label: string
  reason: string
}

export interface ManagementPlan {
  managed: ManagedLoadRow[]
  refused: RefusedLoadRow[]
  /** Item ids removed from the base load (validly managed whole items). */
  managedItemIds: string[]
  /** Strip kits carried in the base load (their compressor is managed, they are not). */
  carriedStrips: LoadItem[]
  recoveryNote: string
}

function planManagement(loads: LoadItem[], shedSelection?: string[]): ManagementPlan {
  // Tech-chosen shed set: when present, only these item ids are offered to the
  // planner; everything else stays in the base. Absent = every valid candidate.
  const selected = shedSelection === undefined ? null : new Set(shedSelection)
  const candidates = loads.filter(
    (l) => SHED_CANDIDATE_TYPES.includes(l.type) && (selected === null || selected.has(l.id)),
  )
  const compressors = candidates.filter((l) => l.type === 'cooling' || l.type === 'heatPump')
  const others = candidates.filter((l) => l.type !== 'cooling' && l.type !== 'heatPump')

  const managed: ManagedLoadRow[] = []
  const refused: RefusedLoadRow[] = []
  const managedItemIds: string[] = []
  const carriedStrips: LoadItem[] = []
  let sacmUsed = 0
  const capReached = () => managed.length >= MANAGED_LOADS_TOTAL_CAP

  const compressorAmps = (l: LoadItem): number =>
    l.type === 'heatPump' && l.heatPump ? l.heatPump.compressorVA / 240 : (l.amps ?? resolveVA(l) / 240)
  const compressorLRA = (l: LoadItem): number | undefined =>
    l.lockedRotorAmps ?? (l.tons !== undefined ? l.tons * LRA_PER_TON_ESTIMATE : undefined)

  // HVAC on the earliest priorities (Generac guidance), appliances after.
  // Track heat pumps whose compressor landed a SACM slot — their strips ride
  // rule 4.
  const sacmHeatPumpsWithStrips: LoadItem[] = []

  for (const comp of compressors) {
    if (capReached()) {
      refused.push({ label: comp.label, reason: '8-managed-load cap reached — stays in the base load.' })
      continue
    }
    if (sacmUsed < SACM_SLOTS) {
      // Rule 1 — standard 24 VAC thermostat assumed (typical residential);
      // rule 2's SMM fallback is what a communicating t-stat would get on site.
      sacmUsed += 1
      managed.push({
        label: comp.label,
        itemId: comp.id,
        stage: comp.type === 'heatPump' ? 'compressor' : undefined,
        kw: kwOf(comp.type === 'heatPump' && comp.heatPump ? comp.heatPump.compressorVA : resolveVA(comp)),
        mechanism: `SACM slot ${sacmUsed} (thermostat interrupt)`,
        priority: managed.length + 1,
        bomSlot: null,
        flags: [],
      })
      managedItemIds.push(comp.id)
      if (comp.type === 'heatPump' && (comp.heatPump?.supplementalVA ?? 0) > 0) {
        sacmHeatPumpsWithStrips.push(comp)
      }
      continue
    }
    // Rule 2 — SMM at the unit, ONLY within 40 A inductive / 3 HP / 180 LRA.
    const amps = compressorAmps(comp)
    const lra = compressorLRA(comp)
    if (amps > SMM_50A.inductiveAmps || (lra !== undefined && lra > SMM_50A.lraMax)) {
      refused.push({
        label: comp.label,
        reason:
          `exceeds the 50A SMM's ${SMM_50A.inductiveAmps} A inductive / ${SMM_50A.lraMax} A LRA rating ` +
          'with no SACM slot free — no management path; stays in the base load.',
      })
      continue
    }
    const flags: string[] = []
    if (lra === undefined) flags.push('LRA not captured — verify ≤ 180 A before assigning the SMM.')
    managed.push({
      label: comp.label,
      itemId: comp.id,
      stage: comp.type === 'heatPump' ? 'compressor' : undefined,
      kw: kwOf(comp.type === 'heatPump' && comp.heatPump ? comp.heatPump.compressorVA : resolveVA(comp)),
      mechanism: `${SMM_50A.label} (${SMM_50A.model}) at the unit`,
      priority: managed.length + 1,
      bomSlot: PRICE_BOOK_SLOTS.smm50,
      flags,
    })
    managedItemIds.push(comp.id)
    if (comp.type === 'heatPump' && (comp.heatPump?.supplementalVA ?? 0) > 0) {
      // Compressor on an SMM interrupts the unit's power path — strips ride it.
      // Nothing extra to plan; the whole item is managed.
    }
  }

  // Rule 4 — strip kits on SACM-managed heat pumps: may ride the compressor's
  // interrupted thermostat call (common on packaged units). Never silently
  // assumed either way: plan the dedicated SMM, flag the verification that
  // lets the installer drop it.
  for (const hp of sacmHeatPumpsWithStrips) {
    const stripVA = hp.heatPump!.supplementalVA
    const stripAmps = stripVA / 240
    if (capReached()) {
      refused.push({
        label: `${hp.label} — supplemental heat`,
        reason: '8-managed-load cap reached — strips stay in the base load.',
      })
      carriedStrips.push(stripCarry(hp))
      continue
    }
    const overFifty = stripAmps > SMM_50A.resistiveAmps
    managed.push({
      label: `${hp.label} — supplemental heat`,
      itemId: hp.id,
      stage: 'supplemental',
      kw: kwOf(stripVA),
      mechanism: overFifty
        ? `SACM (with compressor) or dedicated ${SMM_100A.label} — field-verify`
        : `SACM (with compressor) or dedicated ${SMM_50A.label} — field-verify`,
      priority: managed.length + 1,
      bomSlot: overFifty ? PRICE_BOOK_SLOTS.smm100 : PRICE_BOOK_SLOTS.smm50,
      flags: [STRIP_SACM_VERIFY_FLAG, ...(overFifty ? [SMM_100A_VERIFY_FLAG] : [])],
    })
    // Strips are managed on either path — the base load drops them; the
    // heatPump item is already in managedItemIds via its compressor, so the
    // whole item leaves the base and nothing is carried.
  }

  // Rule 3 — resistance / appliance / EVSE / pool loads on SMMs, sized by
  // resistive amps.
  for (const other of others) {
    if (!isElectric(other)) continue // gas appliances are no electrical load to manage
    if (capReached()) {
      refused.push({ label: other.label, reason: '8-managed-load cap reached — stays in the base load.' })
      continue
    }
    const amps = resolveVA(other) / 240
    const overFifty = amps > SMM_50A.resistiveAmps
    managed.push({
      label: other.label,
      itemId: other.id,
      kw: kwOf(resolveVA(other)),
      mechanism: overFifty ? `${SMM_100A.label} (${SMM_100A.model})` : `${SMM_50A.label} (${SMM_50A.model})`,
      priority: managed.length + 1,
      bomSlot: overFifty ? PRICE_BOOK_SLOTS.smm100 : PRICE_BOOK_SLOTS.smm50,
      flags: overFifty ? [SMM_100A_VERIFY_FLAG] : [],
    })
    managedItemIds.push(other.id)
  }

  return { managed, refused, managedItemIds, carriedStrips, recoveryNote: RECOVERY_STAGGER_NOTE }
}

/** A strip kit that could NOT be managed, carried back into the base load. */
function stripCarry(hp: LoadItem): LoadItem {
  return {
    id: `${hp.id}-strips-carried`,
    type: 'spaceHeat',
    label: `${hp.label} — supplemental heat (stays in base load)`,
    nameplateVA: hp.heatPump!.supplementalVA,
    volts: 240,
    separatelyControlledUnits: 1,
    nameplateRead: hp.nameplateRead,
  }
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
        'requires load management.',
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
        'management.',
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

  // ── The air-cooled ceiling (Kyle, 2026-08-31) ──
  // "I do not want to get into liquid cooled generators. We need to make sure
  // if we have a load that exceeds the air-cooled that we start the load shed
  // recommendations." Nothing below is allowed to answer "bigger unit".
  const ceilingKW = airCooledCeilingKW(fuel, derate)
  if (fullSizing.liquidCooled) {
    fullNotes.push(
      `Exceeds the air-cooled ceiling (${ceilingKW} kW at this site) — load management (Option 2) ` +
      'is the recommendation; Red Cedar does not install liquid-cooled units.',
    )
  }

  // The managed base for any shed set: the same Article 220 engine run on the
  // inventory minus VALIDLY managed loads — no second load model, and no
  // phantom shedding (Appendix B rule 5): a candidate with no SACM slot, over
  // SMM ratings, or past the 8-load cap goes back into the base.
  const baseFor = (ids: string[] | undefined) => {
    const p = planManagement(calcInput.loads, ids)
    const pIds = new Set(p.managedItemIds)
    const res: LoadCalcResult = calculateLoad({
      ...calcInput,
      loads: [...calcInput.loads.filter((l) => !pIds.has(l.id)), ...p.carriedStrips],
      futureLoads: [],
    })
    return { plan: p, result: res, kw: kwOf(res.governingAmps * 240) }
  }

  // Scheme 2: ATS + load management — 702.4(B)(2)(b), on exactly the tech's
  // selection. The engine never adds loads to management on its own (Kyle,
  // 2026-08-31: "take off the automatic additions and have a flag that shows
  // once we go over") — over the ceiling it flags, and the shed menu below is
  // how the tech and the customer decide what else to manage.
  const base = baseFor(input.shedSelection)
  const plan = base.plan
  const managedResult = base.result
  const managedKW = base.kw
  const managedSizing = sizeToModel(managedKW, fuel, derate)
  const airCooledFor = (kw: number) => ({
    ceilingKW,
    fits: kw <= ceilingKW,
    overByKW: kw > ceilingKW ? round2(kw - ceilingKW) : 0,
  })
  const managedAirCooled = airCooledFor(managedKW)
  if (!managedAirCooled.fits) {
    flags.push({
      id: 'exceeds_air_cooled',
      severity: 'hard',
      message:
        `Base load ${managedKW} kW exceeds the air-cooled ceiling of ${ceilingKW} kW at this site by ` +
        `${managedAirCooled.overByKW} kW — extend load management (the shed menu shows what each load ` +
        'brings it down by). Red Cedar does not install liquid-cooled units.',
    })
  }
  const managedNotes: string[] = [
    plan.managed.length > 0
      ? `${plan.managed.length} managed load${plan.managed.length > 1 ? 's' : ''} ` +
        `(${MANAGED_LOADS_TOTAL_CAP}-load cap; SACM = thermostat-interrupt, compressors only, no hardware; each SMM is a BOM line). ` +
        `Source: ${LOAD_MGMT_SOURCE}.`
      : 'No manageable loads in the inventory — identical to full-load sizing.',
  ]
  // The installer priority table (mirrors Generac's panel decal) rides the
  // plan itself; the notes carry refusals and flags.
  for (const row of plan.refused) {
    managedNotes.push(`No management path — ${row.label}: ${row.reason}`)
  }
  for (const row of plan.managed) {
    for (const flag of row.flags) managedNotes.push(`${row.label}: ${flag}`)
  }
  if (plan.managed.some((row) => row.stage === 'supplemental')) {
    managedNotes.push(
      'A heat pump lists two managed rows — its compressor and its supplemental heat — because each ' +
      'stage needs its own management path; the unit is counted once in every load figure.',
    )
  }
  if (!managedAirCooled.fits) {
    managedNotes.push(
      `Over the air-cooled ceiling (${ceilingKW} kW at this site) by ${managedAirCooled.overByKW} kW — ` +
      'add loads to management until the base fits.',
    )
  }
  if (plan.managed.length > 0) {
    managedNotes.push(plan.recoveryNote)
    managedNotes.push(MANAGED_LOAD_CUSTOMER_WORDING)
  }
  // Legal isn't the same as livable (Kyle's review, 2026-08-29): when the
  // largest managed load exceeds the headroom above the base, it will rarely
  // run in an outage — say so, and name the size that carries it.
  if (plan.managed.length > 0 && managedSizing.siteDeratedKW !== null) {
    const largestManaged = plan.managed.reduce(
      (best, row) => (row.kw > best.kw ? { label: row.label, kw: row.kw } : best),
      { label: '', kw: 0 },
    )
    const headroomKW = round2(managedSizing.siteDeratedKW - managedKW)
    if (largestManaged.kw > headroomKW) {
      const stepUp = sizeToModel(managedKW + largestManaged.kw, fuel, derate)
      managedNotes.push(
        `Managed loads run only as capacity allows: ~${headroomKW} kW of headroom above the base load, ` +
        `but the largest managed load (${largestManaged.label}, ${largestManaged.kw} kW) exceeds it — ` +
        `expect it to run rarely or never during an outage. ` +
        (stepUp.model !== null
          ? `For it to run under load management, the Guardian ${stepUp.model.classLabel} kW (model ${stepUp.model.generatorModel}) carries base plus that load.`
          : 'Base plus that load exceeds the air-cooled class — it stays a managed load.'),
      )
    }
  }
  const managedSurgeNote = surgeNoteFor(managedSizing, surge)
  if (managedSurgeNote) managedNotes.push(managedSurgeNote)

  // ── The load-management menu (Kyle, 2026-08-31) — one row per manageable
  // load ("what does managing JUST this one buy me?"), plus the everything-
  // managed floor. Every row is the same Article 220 engine on the remaining
  // inventory; the reduction is measured against the calculated full load.
  const calcFullKW = kwOf(calcResult.governingAmps * 240)
  const scenarioFor = (ids: string[] | undefined, label: string): ShedScenario | null => {
    const b = baseFor(ids)
    if (b.plan.managed.length === 0) return null
    // One name per physical unit — a heat pump's compressor and supplemental
    // rows collapse to the unit's own label, never the appliance name twice
    // (Kyle, 2026-08-31, the Himrick sheet).
    const unitLabels: string[] = []
    for (const row of b.plan.managed) {
      const name = calcInput.loads.find((l) => l.id === row.itemId)?.label ?? row.label
      if (!unitLabels.includes(name)) unitLabels.push(name)
    }
    return {
      label,
      managedLabels: unitLabels,
      requiredKW: b.kw,
      requiredAmps: b.result.governingAmps,
      reductionKW: round2(calcFullKW - b.kw),
      fitsAirCooled: b.kw <= ceilingKW,
    }
  }
  const shedScenarios: ShedScenario[] = []
  for (const cand of calcInput.loads.filter((l) => SHED_CANDIDATE_TYPES.includes(l.type))) {
    const s = scenarioFor([cand.id], cand.label)
    if (s && s.reductionKW > 0) shedScenarios.push(s)
  }
  shedScenarios.sort((a, b) => b.reductionKW - a.reductionKW)
  if (shedScenarios.length > 1) {
    const everything = scenarioFor(undefined, 'Every manageable load')
    if (everything) shedScenarios.push(everything)
  }

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
      airCooled: airCooledFor(fullKW),
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
      shedLoads: plan.managed.map((row) => row.label),
      managementPlan: plan,
      baseBreakdown: managedResult.breakdown,
      airCooled: managedAirCooled,
      priceBookRefs: [
        ...generatorRefs(managedSizing),
        // One line per SMM — dedupe never: each module is billable hardware.
        ...plan.managed.filter((row) => row.bomSlot !== null).map((row) => `${row.bomSlot} — ${row.label}`),
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
    shedScenarios,
    airCooledCeilingKW: ceilingKW,
    flags,
    surge,
    fuel,
    siteDerateFactor: derate,
    scopeLines,
    dataRevision: GENERAC_DATA_REVISION,
    disclaimer: GENERATOR_DISCLAIMER,
  }
}
