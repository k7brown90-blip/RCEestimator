// NEC Article 220 residential load calculation engine.
// Source of truth: docs/RedCedar_Load_Calculation_Spec.md; all tables and demand
// factors verified against the 2017 NEC text in the project (2017-NEC-Code-2.txt).
// Pure and deterministic — no randomness, no Date.now(), no I/O. Same inventory →
// same calculated load, every time.
//
// Scope: computes the SERVICE LOAD only. No branch-circuit or conductor sizing
// (the 310.15(B)(7) 83 % rule is a boundary note, not part of this number).

// ── Types (spec §6) ─────────────────────────────────────────────────────────

export type LoadType =
  | 'generalLighting' | 'smallAppliance' | 'laundry'
  | 'fixedAppliance' | 'range' | 'oven' | 'cooktop' | 'dryer'
  | 'waterHeaterTank' | 'waterHeaterTankless'
  | 'spaceHeat' | 'cooling' | 'heatPump'
  | 'motor' | 'poolPump' | 'poolHeater' | 'poolBlower' | 'spaSelfContained'
  | 'evse' | 'arcWelder' | 'resistanceWelder'
  | 'elevatorLift' | 'snowMeltDeice' | 'exteriorCircuit' | 'other'
  // Engine addition beyond the spec's list: explicit guard type so the required
  // bathroom circuit (210.11(C)(3)) is logged in the inventory but adds 0 VA.
  | 'bathroomCircuit'

export interface LoadItem {
  id: string
  type: LoadType
  label: string
  nameplateVA?: number
  nameplateKW?: number // kVA = kW for ranges/dryers (220.54/220.55) — treated as kVA
  amps?: number
  volts?: number
  continuous?: boolean // continuous load → 125 % in the 230.42 capacity check only
  separatelyControlledUnits?: number // spaceHeat
  heatPump?: { compressorVA: number; supplementalVA: number; lockout: boolean }
  dutyCyclePct?: number // welders → Table 630.11(A) / 630.31(A)(2)
  welderClass?: 'arc' | 'resistance'
  motorGenerator?: boolean // arc welders: Table 630.11(A) has separate motor-generator column
  onLaundryCircuit?: boolean // dryer: laundry 1500 VA covers it — no separate line (count-once)
  nameplateRead?: boolean // true = read off the plate; anything else = assumed
}

export type CalcMethod =
  | 'optional' | 'standard' | 'existingDwelling'
  | 'multifamily220_84' | 'twoDwelling220_85' | 'nonDwelling' // Phase 2 methods

export type OccupancyProfile =
  | 'dwellingSingleFamily' // Phase 1
  | 'dwellingMultifamily' | 'hotelMotel' | 'commercialGeneral' // Phase 2

export interface LoadCalcInput {
  mode: 'tech' | 'engineer' // front-end only; does NOT change the math
  occupancy: OccupancyProfile
  methodOverride?: CalcMethod
  serviceAmps: number
  serviceVoltage: 240
  floorAreaSqFt: number // adaptable conditioned area per 220.82(B)(1)/220.12 —
  // outside dimensions, EXCLUDING open porches, garages, unused/unfinished
  // spaces not adaptable for future use (input-side rule)
  loads: LoadItem[]
  futureLoads?: LoadItem[]
}

export interface BreakdownLine {
  label: string
  type: LoadType
  rawVA: number
  appliedVA: number
  rule: string
}

export interface FutureLoadFinding {
  label: string
  nameplateAmps: number
  continuous: boolean
  addedAmps: number // ×1.25 only if continuous (230.42)
  fitsCode: boolean
  fitsConservative: boolean
  verdict: string
  mitigation?: string
}

export interface LoadCalcResult {
  optionalVA: number
  optionalAmps: number
  standardVA: number
  standardAmps: number
  governingAmps: number
  neutralVA: number
  neutralAmps: number
  methodUsed: CalcMethod
  serviceAmps: number
  spareAmps: number // serviceAmps − governingAmps (code-literal 230.42 basis, HEADLINE)
  loadPct: number // governingAmps ÷ serviceAmps × 100 — against the FULL rating
  usableAmps80: number // serviceAmps × 0.80 — labeled conservative reference ONLY;
  // never drives a verdict or a recommendation
  futureLoadFindings: FutureLoadFinding[]
  breakdown: BreakdownLine[]
  assumedValues: string[]
}

// ── Tables (data, verified against the 2017 NEC text) ───────────────────────

// Table 220.42 — Lighting Load Demand Factors, dwelling units. Full three tiers
// implemented even though the third never fires on a dwelling: occupancy is a
// Phase 2 parameter and the core must not bake in a dwelling-shaped subset.
export const TABLE_220_42_DWELLING: { upToVA: number; factor: number }[] = [
  { upToVA: 3000, factor: 1.0 },
  { upToVA: 120000, factor: 0.35 },
  { upToVA: Infinity, factor: 0.25 },
]

export function applyTable220_42(bucketVA: number): number {
  let remaining = bucketVA
  let previousCeiling = 0
  let result = 0
  for (const tier of TABLE_220_42_DWELLING) {
    const span = Math.min(remaining, tier.upToVA - previousCeiling)
    if (span <= 0) break
    result += span * tier.factor
    remaining -= span
    previousCeiling = tier.upToVA
  }
  return result
}

// Table 220.55 Column C — maximum demand in kW, by number of cooking appliances
// (not over 12 kW each). Counts 26–40: 15 kW + 1 kW per appliance;
// 41+: 25 kW + ¾ kW per appliance.
const TABLE_220_55_COL_C: number[] = [
  // index 1..25
  0, 8, 11, 14, 17, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34,
  35, 36, 37, 38, 39, 40,
]

export function colCDemandKW(count: number): number {
  if (count <= 0) return 0
  if (count <= 25) return TABLE_220_55_COL_C[count]
  if (count <= 40) return 15 + 1 * count
  return 25 + 0.75 * count
}

// Table 220.54 — dryer demand factors by count.
export function dryerTable220_54Pct(count: number): number {
  if (count <= 4) return 100
  if (count === 5) return 85
  if (count === 6) return 75
  if (count === 7) return 65
  if (count === 8) return 60
  if (count === 9) return 55
  if (count === 10) return 50
  if (count === 11) return 47
  if (count <= 23) return 47 - (count - 11)
  if (count <= 42) return 35 - 0.5 * (count - 23)
  return 25
}

// Table 630.11(A) — duty-cycle multipliers for arc welders.
const TABLE_630_11_A: { duty: number; nonMotor: number; motorGen: number }[] = [
  { duty: 100, nonMotor: 1.0, motorGen: 1.0 },
  { duty: 90, nonMotor: 0.95, motorGen: 0.96 },
  { duty: 80, nonMotor: 0.89, motorGen: 0.91 },
  { duty: 70, nonMotor: 0.84, motorGen: 0.86 },
  { duty: 60, nonMotor: 0.78, motorGen: 0.81 },
  { duty: 50, nonMotor: 0.71, motorGen: 0.75 },
  { duty: 40, nonMotor: 0.63, motorGen: 0.69 },
  { duty: 30, nonMotor: 0.55, motorGen: 0.62 },
  { duty: 20, nonMotor: 0.45, motorGen: 0.55 }, // "20 or less"
]

export function arcWelderMultiplier(dutyCyclePct: number, motorGenerator = false): number {
  for (const row of TABLE_630_11_A) {
    if (dutyCyclePct >= row.duty) return motorGenerator ? row.motorGen : row.nonMotor
  }
  const floor = TABLE_630_11_A[TABLE_630_11_A.length - 1]
  return motorGenerator ? floor.motorGen : floor.nonMotor
}

// Table 630.31(A)(2) — duty-cycle multipliers for resistance welders.
const TABLE_630_31_A_2: { duty: number; multiplier: number }[] = [
  { duty: 50, multiplier: 0.71 },
  { duty: 40, multiplier: 0.63 },
  { duty: 30, multiplier: 0.55 },
  { duty: 25, multiplier: 0.5 },
  { duty: 20, multiplier: 0.45 },
  { duty: 15, multiplier: 0.39 },
  { duty: 10, multiplier: 0.32 },
  { duty: 7.5, multiplier: 0.27 },
  { duty: 5, multiplier: 0.22 }, // "5 or less"
]

export function resistanceWelderMultiplier(dutyCyclePct: number): number {
  for (const row of TABLE_630_31_A_2) {
    if (dutyCyclePct >= row.duty) return row.multiplier
  }
  return TABLE_630_31_A_2[TABLE_630_31_A_2.length - 1].multiplier
}

// 220.61(B)(2) — the portion of the neutral load over 200 A may be taken at 70 %
// (single-phase 3-wire). 200 A × 240 V = 48,000 VA. NOTE: 220.61(C) prohibits this
// reduction on line-to-neutral-only and nonlinear portions, which this module does
// not itemize — // VERIFY on any real job whose neutral exceeds 200 A.
export function applyNeutral200ARule(neutralVA: number, volts = 240): number {
  const thresholdVA = 200 * volts
  if (neutralVA <= thresholdVA) return neutralVA
  return thresholdVA + 0.7 * (neutralVA - thresholdVA)
}

// ── Rounding (220.5(B): fractions < 0.5 dropped, ≥ 0.5 kept → round half up) ─

export function roundAmps(amps: number): number {
  return Math.floor(amps + 0.5)
}

// ── VA resolution per load ──────────────────────────────────────────────────

const DEFAULT_CONTINUOUS: ReadonlySet<LoadType> = new Set([
  'evse', 'waterHeaterTankless', 'snowMeltDeice',
])

export function isContinuous(item: LoadItem): boolean {
  return item.continuous ?? DEFAULT_CONTINUOUS.has(item.type)
}

/**
 * Nameplate VA for a load. kVA = kW (explicitly permitted for ranges/dryers,
 * 220.54/220.55; applied uniformly as the entry convention). Amps-based loads
 * resolve at their entered volts — Annex D itself is inconsistent here (D2(a)
 * computes 6 A × 230 V; D2(b) computes 42 A × 240 V), so the fixture carries
 * whatever the record shows and the engine does not second-guess it.
 * Welders resolve through their duty-cycle multiplier (630.11(A)/630.31(A)(2)).
 */
export function resolveVA(item: LoadItem): number {
  if (item.type === 'heatPump' && item.heatPump) {
    // Handled by the HVAC selections; nameplate here is compressor + supplemental.
    return item.heatPump.compressorVA + item.heatPump.supplementalVA
  }
  let base = item.nameplateVA ?? (item.nameplateKW !== undefined ? item.nameplateKW * 1000 : undefined)
  if (base === undefined && item.amps !== undefined) {
    base = item.amps * (item.volts ?? 240)
  }
  if (base === undefined) return 0
  if (item.type === 'arcWelder') {
    return base * arcWelderMultiplier(item.dutyCyclePct ?? 100, item.motorGenerator ?? false)
  }
  if (item.type === 'resistanceWelder') {
    return base * resistanceWelderMultiplier(item.dutyCyclePct ?? 50)
  }
  return base
}

// ── Type routing ─────────────────────────────────────────────────────────────

const COOKING_TYPES: ReadonlySet<LoadType> = new Set(['range', 'oven', 'cooktop'])

// Fastened-in-place appliances for 220.53 (Standard). Water heaters — tank AND
// tankless — are in this group and eligible for the 75 % factor when 4+; a
// tankless unit is NOT demand-exempt. The difference is magnitude, not method
// (220.82(B)(3)d / 220.53; spec §5 + checklist rule 8).
const FIXED_APPLIANCE_TYPES: ReadonlySet<LoadType> = new Set([
  'fixedAppliance', 'waterHeaterTank', 'waterHeaterTankless', 'spaSelfContained', 'poolHeater',
])

// Motor-treated loads (430.24 largest-motor candidates alongside hermetic
// compressors per 440.6). Elevators/lifts: single residential unit gets no
// feeder demand reduction (620.14) → 100 % nameplate here.
const MOTOR_TYPES: ReadonlySet<LoadType> = new Set([
  'motor', 'poolPump', 'poolBlower', 'elevatorLift',
])

// Everything else that enters at 100 % nameplate in the Standard method.
const OTHER_100_PCT_TYPES: ReadonlySet<LoadType> = new Set([
  'evse', 'arcWelder', 'resistanceWelder', 'snowMeltDeice', 'exteriorCircuit', 'other',
  'generalLighting',
])

const HVAC_TYPES: ReadonlySet<LoadType> = new Set(['spaceHeat', 'cooling', 'heatPump'])

// Code-fixed circuit values — never nameplate-tracked.
const CODE_FIXED_TYPES: ReadonlySet<LoadType> = new Set([
  'smallAppliance', 'laundry', 'bathroomCircuit',
])

/** A dryer flagged onLaundryCircuit is covered by the laundry 1500 VA (count-once). */
function activeDryers(loads: LoadItem[]): LoadItem[] {
  return loads.filter((l) => l.type === 'dryer' && !l.onLaundryCircuit)
}

// ── Shared building blocks ───────────────────────────────────────────────────

interface CircuitCounts {
  smallAppliance: number
  laundry: number
}

/** 220.52 minimums: 2 small-appliance + 1 laundry, even if fewer are entered. */
function circuitCounts(loads: LoadItem[]): CircuitCounts {
  const sa = loads.filter((l) => l.type === 'smallAppliance').length
  const la = loads.filter((l) => l.type === 'laundry').length
  return { smallAppliance: Math.max(2, sa), laundry: Math.max(1, la) }
}

function lightingVA(input: LoadCalcInput): number {
  const extra = input.loads
    .filter((l) => l.type === 'generalLighting')
    .reduce((sum, l) => sum + resolveVA(l), 0)
  return 3 * input.floorAreaSqFt + extra
}

/**
 * Cooking demand per Table 220.55 Column C + Notes 1, 2, 4 (Standard method).
 * Column C is the deterministic default ("to be used in all cases except as
 * otherwise permitted in Note 3" — Note 3's Column A/B path is permissive, not
 * required, so the engine does not fork on it; an engineer-mode A/B option is a
 * Phase 2 front-end concern).
 * Note 4: one counter-mounted cooking unit + up to two wall ovens are treated as
 * one range (nameplates summed) when no standalone range is present.
 */
export function cookingDemandVA(cookingItems: LoadItem[]): number {
  if (cookingItems.length === 0) return 0
  const kwOf = (l: LoadItem) => resolveVA(l) / 1000

  const ranges = cookingItems.filter((l) => l.type === 'range')
  const ovens = cookingItems.filter((l) => l.type === 'oven')
  const cooktops = cookingItems.filter((l) => l.type === 'cooktop')

  let units: number[] // equivalent-range ratings in kW
  if (ranges.length === 0 && cooktops.length === 1 && ovens.length <= 2) {
    // Note 4: combine into one equivalent range.
    units = [kwOf(cooktops[0]) + ovens.reduce((s, o) => s + kwOf(o), 0)]
  } else {
    units = cookingItems.map(kwOf)
  }

  const count = units.length
  const maxKW = Math.max(...units)
  const baseKW = colCDemandKW(count)

  if (maxKW <= 12) return baseKW * 1000

  // Note 1 (all same rating >12–27 kW) / Note 2 (unequal, use 12 kW minimum,
  // average, then the Note 1 escalation): +5 % per kW or major fraction over 12.
  const avgKW = units.reduce((s, kw) => s + Math.max(kw, 12), 0) / count
  const over = avgKW - 12
  const increments = Math.floor(over) + (over - Math.floor(over) >= 0.5 ? 1 : 0)
  return baseKW * (1 + 0.05 * increments) * 1000
}

/** 220.54: each dryer at max(5000, nameplate); Table 220.54 factor on the total. */
export function dryerDemandVA(dryers: LoadItem[]): number {
  if (dryers.length === 0) return 0
  const total = dryers.reduce((sum, d) => sum + Math.max(5000, resolveVA(d)), 0)
  return total * (dryerTable220_54Pct(dryers.length) / 100)
}

interface HvacStandard {
  heatVA: number
  coolVA: number
  winner: 'heat' | 'cool' | 'none'
  winnerVA: number
  compressorCandidates: number[] // VA of compressors on the winning side (440.6)
}

/** Standard method: heat vs A/C noncoincident — larger only (220.60). */
function hvacStandard(loads: LoadItem[]): HvacStandard {
  const heatItems = loads.filter((l) => l.type === 'spaceHeat')
  const coolItems = loads.filter((l) => l.type === 'cooling')
  const hpItems = loads.filter((l) => l.type === 'heatPump')

  // Heat pump under Part III: compressor + supplemental at 100 % (if lockout
  // prevents simultaneous operation, the larger of the two — noncoincident).
  const hpVA = hpItems.reduce((sum, l) => {
    const hp = l.heatPump ?? { compressorVA: resolveVA(l), supplementalVA: 0, lockout: false }
    return sum + (hp.lockout ? Math.max(hp.compressorVA, hp.supplementalVA) : hp.compressorVA + hp.supplementalVA)
  }, 0)

  const heatVA = heatItems.reduce((s, l) => s + resolveVA(l), 0) + hpVA
  const coolVA = coolItems.reduce((s, l) => s + resolveVA(l), 0)

  if (heatVA === 0 && coolVA === 0) {
    return { heatVA, coolVA, winner: 'none', winnerVA: 0, compressorCandidates: [] }
  }
  if (heatVA >= coolVA) {
    return {
      heatVA, coolVA, winner: 'heat', winnerVA: heatVA,
      compressorCandidates: hpItems.map((l) => l.heatPump?.compressorVA ?? 0),
    }
  }
  return {
    heatVA, coolVA, winner: 'cool', winnerVA: coolVA,
    compressorCandidates: coolItems.map((l) => resolveVA(l)),
  }
}

/** Optional method 220.82(C): the largest of the six selections. */
function hvacOptionalVA(loads: LoadItem[]): { va: number; selection: string } {
  const coolVA = loads.filter((l) => l.type === 'cooling').reduce((s, l) => s + resolveVA(l), 0)

  const hpItems = loads.filter((l) => l.type === 'heatPump')
  const hpNoSupp = hpItems
    .filter((l) => (l.heatPump?.supplementalVA ?? 0) === 0)
    .reduce((s, l) => s + (l.heatPump?.compressorVA ?? resolveVA(l)), 0)
  const hpWithSupp = hpItems
    .filter((l) => (l.heatPump?.supplementalVA ?? 0) > 0)
    .reduce((s, l) => {
      const hp = l.heatPump!
      return s + (hp.lockout ? 0 : hp.compressorVA) + 0.65 * hp.supplementalVA
    }, 0)

  const heatItems = loads.filter((l) => l.type === 'spaceHeat')
  const heatVA = heatItems.reduce((s, l) => s + resolveVA(l), 0)
  const heatUnits = heatItems.reduce((s, l) => s + (l.separatelyControlledUnits ?? 1), 0)
  const heatSelection = heatUnits >= 4 ? heatVA * 0.4 : heatVA * 0.65
  const heatRule = heatUnits >= 4 ? '220.82(C)(5) 40%' : '220.82(C)(4) 65%'

  // Selection 6 (electric thermal storage, continuous at full nameplate) is not
  // modeled as a distinct LoadType in Phase 1 // VERIFY if encountered.
  const selections: { va: number; label: string }[] = [
    { va: coolVA, label: '220.82(C)(1) A/C 100%' },
    { va: hpNoSupp, label: '220.82(C)(2) heat pump 100%' },
    { va: hpWithSupp, label: '220.82(C)(3) compressor + 65% supplemental' },
    { va: heatSelection, label: heatRule },
  ]
  const best = selections.reduce((a, b) => (b.va > a.va ? b : a))
  return { va: best.va, selection: best.label }
}

// ── Optional Method (220.82) ────────────────────────────────────────────────

interface MethodResult {
  totalVA: number
  breakdown: BreakdownLine[]
}

function calcOptional(input: LoadCalcInput): MethodResult {
  const breakdown: BreakdownLine[] = []
  const counts = circuitCounts(input.loads)
  const lighting = lightingVA(input)

  let general = 0
  const push = (label: string, type: LoadType, rawVA: number, appliedVA: number, rule: string) => {
    breakdown.push({ label, type, rawVA, appliedVA, rule })
    general += appliedVA
  }

  push(`General lighting & receptacles (${input.floorAreaSqFt} ft² × 3 VA)`, 'generalLighting', lighting, lighting, '220.82(B)(1)')
  push(`Small-appliance circuits × ${counts.smallAppliance}`, 'smallAppliance', counts.smallAppliance * 1500, counts.smallAppliance * 1500, '220.82(B)(2)')
  push(`Laundry circuit(s) × ${counts.laundry}`, 'laundry', counts.laundry * 1500, counts.laundry * 1500, '220.82(B)(2)')

  for (const item of input.loads) {
    if (HVAC_TYPES.has(item.type) || CODE_FIXED_TYPES.has(item.type) || item.type === 'generalLighting') continue
    if (item.type === 'dryer' && item.onLaundryCircuit) {
      breakdown.push({ label: item.label, type: item.type, rawVA: resolveVA(item), appliedVA: 0, rule: 'on laundry circuit — covered by 1500 VA laundry line (count-once, 220.82(B)(3)c)' })
      continue
    }
    const va = resolveVA(item)
    const ruleByType: Partial<Record<LoadType, string>> = {
      range: '220.82(B)(3)b nameplate', oven: '220.82(B)(3)b nameplate', cooktop: '220.82(B)(3)b nameplate',
      dryer: '220.82(B)(3)c nameplate',
      waterHeaterTank: '220.82(B)(3)d nameplate', waterHeaterTankless: '220.82(B)(3)d nameplate (tankless = water heater; magnitude, not method)',
      motor: '220.82(B)(4) nameplate', poolPump: '220.82(B)(4) nameplate', poolBlower: '220.82(B)(4) nameplate',
      arcWelder: '220.82(B)(3)a via Table 630.11(A) duty-cycle', resistanceWelder: '220.82(B)(3)a via Table 630.31(A)(2) duty-cycle',
    }
    push(item.label, item.type, va, va, ruleByType[item.type] ?? '220.82(B)(3)a nameplate')
  }

  const staged = Math.min(general, 10000) + 0.4 * Math.max(0, general - 10000)
  breakdown.push({
    label: 'Demand factor: first 10 kVA @ 100%, remainder @ 40%',
    type: 'other', rawVA: general, appliedVA: staged, rule: '220.82(B)',
  })

  const hvac = hvacOptionalVA(input.loads)
  breakdown.push({ label: 'Heating/air-conditioning (largest selection)', type: 'spaceHeat', rawVA: hvac.va, appliedVA: hvac.va, rule: hvac.selection })

  return { totalVA: staged + hvac.va, breakdown }
}

// ── Standard Method (Part III) ──────────────────────────────────────────────

function calcStandard(input: LoadCalcInput): MethodResult {
  const breakdown: BreakdownLine[] = []
  const counts = circuitCounts(input.loads)
  const lighting = lightingVA(input)

  const bucketRaw = lighting + (counts.smallAppliance + counts.laundry) * 1500
  const bucket = applyTable220_42(bucketRaw)
  breakdown.push({
    label: `General lighting ${lighting} + small-appliance ${counts.smallAppliance * 1500} + laundry ${counts.laundry * 1500}, Table 220.42 staged`,
    type: 'generalLighting', rawVA: bucketRaw, appliedVA: bucket,
    rule: 'Table 220.42 (first 3000 @ 100%, 3001–120,000 @ 35%, remainder @ 25%)',
  })
  let total = bucket

  const cooking = input.loads.filter((l) => COOKING_TYPES.has(l.type))
  if (cooking.length > 0) {
    const raw = cooking.reduce((s, l) => s + resolveVA(l), 0)
    const demand = cookingDemandVA(cooking)
    breakdown.push({ label: `Cooking appliances × ${cooking.length}`, type: 'range', rawVA: raw, appliedVA: demand, rule: 'Table 220.55 Col C + Notes 1–4' })
    total += demand
  }

  const dryers = activeDryers(input.loads)
  if (dryers.length > 0) {
    const raw = dryers.reduce((s, d) => s + resolveVA(d), 0)
    const demand = dryerDemandVA(dryers)
    breakdown.push({ label: `Clothes dryer(s) × ${dryers.length}`, type: 'dryer', rawVA: raw, appliedVA: demand, rule: '220.54 (larger of 5000 VA or nameplate; Table 220.54)' })
    total += demand
  }
  const dryerOnLaundry = input.loads.filter((l) => l.type === 'dryer' && l.onLaundryCircuit)
  for (const d of dryerOnLaundry) {
    breakdown.push({ label: d.label, type: 'dryer', rawVA: resolveVA(d), appliedVA: 0, rule: 'on laundry circuit — covered by 1500 VA laundry line (count-once)' })
  }

  const fixed = input.loads.filter((l) => FIXED_APPLIANCE_TYPES.has(l.type))
  if (fixed.length > 0) {
    const raw = fixed.reduce((s, l) => s + resolveVA(l), 0)
    const factor = fixed.length >= 4 ? 0.75 : 1
    breakdown.push({
      label: `Fastened-in-place appliances × ${fixed.length} (incl. water heaters)`,
      type: 'fixedAppliance', rawVA: raw, appliedVA: raw * factor,
      rule: fixed.length >= 4 ? '220.53 (4+ appliances @ 75%)' : '220.53 (<4 appliances @ 100%)',
    })
    total += raw * factor
  }

  const hvac = hvacStandard(input.loads)
  if (hvac.winner !== 'none') {
    breakdown.push({
      label: `Heating vs A/C noncoincident — ${hvac.winner === 'heat' ? 'heat' : 'A/C'} governs (heat ${hvac.heatVA} VA vs A/C ${hvac.coolVA} VA)`,
      type: hvac.winner === 'heat' ? 'spaceHeat' : 'cooling',
      rawVA: hvac.winnerVA, appliedVA: hvac.winnerVA,
      rule: hvac.winner === 'heat' ? '220.51 (100%) / 220.60' : '220.60 (larger only)',
    })
    total += hvac.winnerVA
  }

  const motors = input.loads.filter((l) => MOTOR_TYPES.has(l.type))
  const motorVA = motors.reduce((s, l) => s + resolveVA(l), 0)
  if (motorVA > 0) {
    breakdown.push({ label: `Motors × ${motors.length}`, type: 'motor', rawVA: motorVA, appliedVA: motorVA, rule: '430.24 (nameplate, 430.6(A))' })
    total += motorVA
  }

  const others = input.loads.filter((l) => OTHER_100_PCT_TYPES.has(l.type) && l.type !== 'generalLighting')
  for (const item of others) {
    const va = resolveVA(item)
    const rule =
      item.type === 'evse' ? '625.42 (continuous, 100% nameplate in the 220 load)'
      : item.type === 'arcWelder' ? '630.11 × Table 630.11(A) duty-cycle'
      : item.type === 'resistanceWelder' ? '630.31 × Table 630.31(A)(2) duty-cycle'
      : item.type === 'snowMeltDeice' ? 'Art. 426/427 (100% continuous)'
      : '100% nameplate'
    breakdown.push({ label: item.label, type: item.type, rawVA: va, appliedVA: va, rule })
    total += va
  }

  // Largest motor +25 % adder, ONCE (430.24). Candidates: motor-type loads plus
  // hermetic compressors (440.6) on the WINNING noncoincident side — a compressor
  // dropped by 220.60 is not in the load and gets no adder.
  const candidates = [...motors.map((l) => resolveVA(l)), ...hvac.compressorCandidates]
  const largest = candidates.length > 0 ? Math.max(...candidates) : 0
  if (largest > 0) {
    breakdown.push({ label: 'Largest motor +25% adder (once)', type: 'motor', rawVA: largest, appliedVA: 0.25 * largest, rule: '430.24' })
    total += 0.25 * largest
  }

  // Bathroom branch circuit: required (210.11(C)(3)) but adds 0 to the calculation.
  for (const b of input.loads.filter((l) => l.type === 'bathroomCircuit')) {
    breakdown.push({ label: b.label, type: 'bathroomCircuit', rawVA: 0, appliedVA: 0, rule: '210.11(C)(3) — required circuit, no load line' })
  }

  return { totalVA: total, breakdown }
}

// ── Neutral (220.61) — always computed on the Part III demand basis ─────────

function calcNeutralVA(input: LoadCalcInput): number {
  const counts = circuitCounts(input.loads)
  const bucketRaw = lightingVA(input) + (counts.smallAppliance + counts.laundry) * 1500
  let neutral = applyTable220_42(bucketRaw) // line-to-neutral, 100 %

  // Cooking and dryers at 70 % of their Part III demand (220.61(B)(1)).
  neutral += 0.7 * cookingDemandVA(input.loads.filter((l) => COOKING_TYPES.has(l.type)))
  neutral += 0.7 * dryerDemandVA(activeDryers(input.loads))

  // Other loads: line-to-neutral (≤120 V) at 100 %; straight-240 V loads have no
  // neutral connection and contribute 0.
  const is120 = (l: LoadItem) => (l.volts ?? 240) <= 120

  const fixed120 = input.loads.filter((l) => FIXED_APPLIANCE_TYPES.has(l.type) && is120(l))
  const fixedAll = input.loads.filter((l) => FIXED_APPLIANCE_TYPES.has(l.type))
  const fixedFactor = fixedAll.length >= 4 ? 0.75 : 1
  neutral += fixedFactor * fixed120.reduce((s, l) => s + resolveVA(l), 0)

  // HVAC: only the winning noncoincident side, and only its 120 V portion.
  const hvac = hvacStandard(input.loads)
  if (hvac.winner === 'heat') {
    neutral += input.loads.filter((l) => l.type === 'spaceHeat' && is120(l)).reduce((s, l) => s + resolveVA(l), 0)
  } else if (hvac.winner === 'cool') {
    neutral += input.loads.filter((l) => l.type === 'cooling' && is120(l)).reduce((s, l) => s + resolveVA(l), 0)
  }

  const misc120 = input.loads.filter(
    (l) => (MOTOR_TYPES.has(l.type) || OTHER_100_PCT_TYPES.has(l.type)) && l.type !== 'generalLighting' && is120(l),
  )
  neutral += misc120.reduce((s, l) => s + resolveVA(l), 0)
  // Largest-motor 25 % adder on the neutral: not applied in Phase 1 // VERIFY
  // (Annex D1(b) shows it can appear on the neutral when the motor is 120 V).

  return applyNeutral200ARule(neutral, input.serviceVoltage)
}

// ── Existing Dwelling Method (220.83) ───────────────────────────────────────

/**
 * 220.83 — is the existing service sufficient for existing + new loads?
 * (A) no new A/C or space heat: first 8 kVA @ 100 %, remainder @ 40 %.
 * (B) new A/C or space heat: larger of A/C or space heat @ 100 %, plus first
 *     8 kVA of all other load @ 100 %, remainder @ 40 %.
 * Load list per 220.83: lighting 3 VA/ft², 1500 VA per small-appliance & laundry
 * circuit, nameplate of fastened appliances / ranges / dryers / water heaters.
 */
export function existingDwellingAmps(
  input: LoadCalcInput,
  newLoads: LoadItem[] = [],
): { variant: 'A' | 'B'; totalVA: number; amps: number; fits: boolean } {
  const all = [...input.loads, ...newLoads]
  const addingHvac = newLoads.some((l) => HVAC_TYPES.has(l.type))
  const counts = circuitCounts(all)

  const hvacAll = hvacStandard(all)
  const otherVA =
    lightingVA(input) +
    (counts.smallAppliance + counts.laundry) * 1500 +
    all
      .filter((l) => !HVAC_TYPES.has(l.type) && !CODE_FIXED_TYPES.has(l.type) && l.type !== 'generalLighting')
      .filter((l) => !(l.type === 'dryer' && l.onLaundryCircuit))
      .reduce((s, l) => s + resolveVA(l), 0)

  let totalVA: number
  let variant: 'A' | 'B'
  if (addingHvac) {
    variant = 'B'
    // Larger of A/C or space heating (not both) @ 100 % + staged other load.
    totalVA = hvacAll.winnerVA + Math.min(otherVA, 8000) + 0.4 * Math.max(0, otherVA - 8000)
  } else {
    variant = 'A'
    // Existing HVAC rides in the staged pile per 220.83(A)'s inclusive list.
    const pile = otherVA + hvacAll.winnerVA
    totalVA = Math.min(pile, 8000) + 0.4 * Math.max(0, pile - 8000)
  }

  const amps = roundAmps(totalVA / input.serviceVoltage)
  return { variant, totalVA, amps, fits: amps <= input.serviceAmps }
}

// ── Capacity & future loads (code-literal 230.42 basis, spec §5a) ───────────

function futureFindings(
  input: LoadCalcInput,
  governingAmps: number,
  usableAmps80: number,
): FutureLoadFinding[] {
  return (input.futureLoads ?? []).map((item) => {
    const nameplateAmps = resolveVA(item) / input.serviceVoltage
    const continuous = isContinuous(item)
    // 230.42(A)(1): noncontinuous @ 100 % + continuous @ 125 % — the 125 % attaches
    // ONLY to the continuous portion. No blanket 80 % derate, ever.
    const addedAmps = continuous ? 1.25 * nameplateAmps : nameplateAmps
    const projected = governingAmps + addedAmps
    const fitsCode = projected <= input.serviceAmps
    const fitsConservative = projected <= usableAmps80

    let mitigation: string | undefined
    if (!fitsCode) {
      if (item.type === 'evse') {
        mitigation =
          'An automatic energy management system (EVEMS, 625.42) can limit the load counted on the service — a code-recognized alternative to a service upgrade.'
      } else if (continuous) {
        mitigation =
          'Automatic load management (Art. 750) may cap the counted load — evaluate before recommending a service upsize.'
      }
    }

    return {
      label: item.label,
      nameplateAmps,
      continuous,
      addedAmps,
      fitsCode,
      fitsConservative,
      verdict: fitsCode
        ? `capacity available (per 230.42): ${governingAmps} A + ${addedAmps.toFixed(1)} A (${continuous ? '×1.25 continuous' : '100%'}) = ${projected.toFixed(1)} A on a ${input.serviceAmps} A service`
        : `service upsize (or load management) required: ${governingAmps} A + ${addedAmps.toFixed(1)} A (${continuous ? '×1.25 continuous' : '100%'}) = ${projected.toFixed(1)} A exceeds the ${input.serviceAmps} A service`,
      mitigation,
    }
  })
}

// ── Entry point ──────────────────────────────────────────────────────────────

export function calculateLoad(input: LoadCalcInput): LoadCalcResult {
  if (input.occupancy !== 'dwellingSingleFamily') {
    // Phase 2 profiles slot in here — the parameter exists so nothing dwelling-
    // shaped is baked into callers.
    throw new Error(`Occupancy profile '${input.occupancy}' is not implemented in Phase 1.`)
  }
  if (
    input.methodOverride === 'multifamily220_84' ||
    input.methodOverride === 'twoDwelling220_85' ||
    input.methodOverride === 'nonDwelling'
  ) {
    throw new Error(`Method '${input.methodOverride}' is not implemented in Phase 1.`)
  }

  const optional = calcOptional(input)
  const standard = calcStandard(input)

  // 220.82(A) guard: Optional requires a 120/240 V or 208Y/120 V 3-wire service
  // with ampacity ≥ 100. Below that (or on override) the Standard method governs.
  const optionalQualifies = input.serviceAmps >= 100 && input.serviceVoltage === 240
  const methodUsed: CalcMethod =
    input.methodOverride ?? (optionalQualifies ? 'optional' : 'standard')

  const optionalAmps = roundAmps(optional.totalVA / input.serviceVoltage)
  const standardAmps = roundAmps(standard.totalVA / input.serviceVoltage)

  let governingAmps: number
  if (methodUsed === 'optional') {
    governingAmps = optionalAmps
  } else if (methodUsed === 'existingDwelling') {
    governingAmps = existingDwellingAmps(input).amps
  } else {
    governingAmps = standardAmps
  }

  const neutralVA = calcNeutralVA(input)
  const usableAmps80 = input.serviceAmps * 0.8

  const assumedValues = input.loads
    .filter((l) => !CODE_FIXED_TYPES.has(l.type) && l.nameplateRead !== true)
    .map((l) => l.label)

  return {
    optionalVA: optional.totalVA,
    optionalAmps,
    standardVA: standard.totalVA,
    standardAmps,
    governingAmps,
    neutralVA,
    neutralAmps: roundAmps(neutralVA / input.serviceVoltage),
    methodUsed,
    serviceAmps: input.serviceAmps,
    spareAmps: input.serviceAmps - governingAmps,
    loadPct: Math.round((governingAmps / input.serviceAmps) * 1000) / 10,
    usableAmps80,
    futureLoadFindings: futureFindings(input, governingAmps, usableAmps80),
    breakdown: methodUsed === 'optional' ? optional.breakdown : standard.breakdown,
    assumedValues,
  }
}
