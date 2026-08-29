/**
 * Generator sizing data — every constant the P031 engine consumes, in one
 * module (P031 rule: "All constants … live in one data module, not scattered
 * literals"). Values marked DEFAULT are pending Kyle's review; they ship as
 * editable data on purpose.
 *
 * P031 Amendment (Kyle, 2026-08-28): the product line is Generac Guardian
 * (air-cooled). The generic kW tiers are replaced by the published model table
 * below; sizing matches the FUEL-MATCHED rating — never an NG number computed
 * from the LP one.
 */

// ── Generac Guardian air-cooled model table (Appendix A seed data) ──────────

export interface GeneracModel {
  /** Marketing class, LP/NG kW — e.g. "22/19.5". */
  classLabel: string
  /** Generator model number. */
  generatorModel: string
  /** Paired transfer-switch package model. */
  switchPackage: string
  /** Published continuous rating on propane, watts. */
  lpWatts: number
  /** Published continuous rating on natural gas, watts — a separate published
   * number, NOT derived from LP (amendment rule 1). */
  ngWatts: number
  /** Published amps at 240 V, LP / NG. */
  lpAmps240: number
  ngAmps240: number
}

/**
 * DATA VINTAGE (amendment rule 6): source documents are Generac 2022 revisions.
 * The tech UI displays this so stale data is visible; nothing from this table
 * may be hard-coded outside this module.
 */
export const GENERAC_DATA_REVISION =
  'Generac brochure 201902144 Rev 08/22; spec sheets Rev L / Rev F (2022)'

/** Ascending by rating. Sizing selects the smallest fuel-matched fit. */
export const GENERAC_GUARDIAN_MODELS: GeneracModel[] = [
  { classLabel: '10/9', generatorModel: '7171', switchPackage: '7172 (100A select-circuit)', lpWatts: 10000, ngWatts: 9000, lpAmps240: 41.7, ngAmps240: 37.5 },
  { classLabel: '14/14', generatorModel: '7223', switchPackage: '7225', lpWatts: 14000, ngWatts: 14000, lpAmps240: 58.3, ngAmps240: 58.3 },
  { classLabel: '16/16', generatorModel: '7035/36/37', switchPackage: '7037 (200A smart switch)', lpWatts: 16000, ngWatts: 16000, lpAmps240: 66.7, ngAmps240: 66.7 },
  { classLabel: '18/17', generatorModel: '7226', switchPackage: '7228', lpWatts: 18000, ngWatts: 17000, lpAmps240: 75.0, ngAmps240: 70.8 },
  { classLabel: '20/18', generatorModel: '7038/39', switchPackage: '7039', lpWatts: 20000, ngWatts: 18000, lpAmps240: 83.3, ngAmps240: 75.0 },
  { classLabel: '22/19.5', generatorModel: '7042', switchPackage: '7043', lpWatts: 22000, ngWatts: 19500, lpAmps240: 91.7, ngAmps240: 81.3 },
  { classLabel: '24/21', generatorModel: '7209', switchPackage: '7210', lpWatts: 24000, ngWatts: 21000, lpAmps240: 100, ngAmps240: 87.5 },
  { classLabel: '26/22.5', generatorModel: '7290', switchPackage: '7291', lpWatts: 26000, ngWatts: 22500, lpAmps240: 108.3, ngAmps240: 93.8 },
]

/** Above 26 kW air-cooled (amendment rule 1) — verbatim output text. */
export const LIQUID_COOLED_TEXT =
  'Generac liquid-cooled (Protector) class — manual selection with dealer sizing tool.'

/**
 * When the essential-loads tier calculates to at least this fraction of the
 * whole-home load, the tier is suppressed as saving nothing — an all-electric
 * house's "essentials" ARE the house (heat, range, water heater), and printing
 * "partial: 29.7 kW / whole home: 29.0 kW" side by side is incoherent (Kyle's
 * review, 2026-08-29: "backing up part of my house costs more than all of
 * it"). The two methods differ — 220.82 demand-factors the whole house down,
 * the partial tier sums essentials at full value — so near the boundary the
 * comparison misleads. DEFAULT 0.85; editable.
 */
export const PARTIAL_COLLAPSE_RATIO = 0.85

/**
 * Emitted when a shed heat pump carries a strip kit: the shed system is built
 * for A/C units (Kyle, 2026-08-29), so the compressor sheds and the strips
 * stay in the base load the generator must carry.
 */
export const STRIPS_STAY_IN_BASE_NOTE =
  'Heat-strip kit stays in the managed base load — the shed system manages A/C compressor loads; resistance heat is never assumed sheddable, so heat keeps running.'

// ── Load-management hardware caps (amendment rule 2, Generac published) ─────

/** The 200A service-rated smart switch natively manages up to 4 A/C loads. */
export const SMART_SWITCH_AC_SLOTS = 4
/** Up to 8 additional 240 V loads via Smart Management Modules. */
export const SMM_MAX_MODULES = 8
/** SMM module references, emitted per assumed module in the package reference. */
export const SMM_MODULES = {
  amp50: 'G007000-0 (50A SMM)',
  amp100: 'G007006-0 (100A SMM)',
} as const

// ── Site derates (amendment rule 3, Generac published) ──────────────────────

/** −3.5 % per 1,000 ft altitude. */
export const ALTITUDE_DERATE_PER_1000FT = 0.035
/** −1 % per 10 °F above 60 °F. */
export const TEMP_DERATE_PER_10F_ABOVE_60 = 0.01
/** DEFAULT one 1,000-ft altitude step for Middle TN; tech-overridable. */
export const DEFAULT_ALTITUDE_STEPS = 1

// ── Surge data (amendment rule 4) ───────────────────────────────────────────

/**
 * Generac publishes motor-starting sparsely. Where a model has no published
 * surge capability the check EMITS the verify-with-dealer flag rather than
 * passing silently. Keyed by generatorModel.
 */
export const GENERAC_SURGE_PUBLISHED: Record<string, { lra: number; kva: number }> = {
  '7290': { lra: 230, kva: 55.2 }, // 26 kW
}

export const SURGE_VERIFY_FLAG_TEXT =
  'Motor-starting capability for this model is not published — verify with the Generac sizing tool / dealer.'

// ── Fuel-supply scope flags (amendment rule 5) ──────────────────────────────

/** Emitted on EVERY recommendation; the piping calc itself stays out of scope. */
export const FUEL_SUPPLY_SCOPE_LINE =
  'Verify gas meter and fuel-pipe sizing for full-load draw — NG full-load runs ' +
  '~127–333 ft³/hr by model at 3.5–7 in WC inlet (LP 10–12 in WC).'

// ── Partial-tier and check constants (unchanged by the amendment) ───────────

/**
 * DEFAULT shed-candidate list for the load-management scheme (702.4(B)(2)(b)):
 * the big deferrable 240 V loads. Editable data; the output names what it shed.
 *
 * NO HEATING TYPES (Kyle, 2026-08-29: "The load shed system is built
 * specifically for A/C units"). A/C compressor loads ride the smart switch's
 * native management; water heater / cooking / dryer / EVSE ride SMMs per the
 * P031 amendment. Resistance heat is NEVER assumed sheddable — a shed heat
 * pump sheds its COMPRESSOR only, and its strip kit stays in the managed base
 * load the generator carries (which is also what keeps the house warm).
 */
export const SHED_CANDIDATE_TYPES: readonly string[] = [
  'cooling', 'heatPump', // compressor loads — native smart-switch management
  'waterHeaterTank', 'waterHeaterTankless',
  'range', 'oven', 'cooktop',
  'dryer',
  'evse',
]

/**
 * Resistance strip heat at or above this many kW forces whole-home /
 * liquid-cooled guidance instead of a partial-tier answer. DEFAULT 10 kW.
 */
export const STRIP_HEAT_THRESHOLD_KW = 10

/** 220.52 — two small-appliance circuits at 1500 VA each, Kyle's kitchen floor. */
export const SMALL_APPLIANCE_CIRCUITS_VA = 3000

/**
 * DEFAULT nameplates used when the inventory has no tagged item to read
 * (refrigerators ride the small-appliance circuits in Article 220, so one is
 * often not entered as a line item). Editable data.
 *
 * DELIBERATE CONSERVATISM (stands per Kyle's review, 2026-08-29): counting the
 * fridge and microwave on top of both SA circuits may double-count ~2.3 kVA
 * when they live on those circuits — over-sizing an essential tier, never
 * under-sizing it.
 */
export const REFRIGERATOR_DEFAULT_VA = 800
export const MICROWAVE_DEFAULT_VA = 1500

/**
 * Locked-rotor amps per ton, used ONLY when the plate's LRA wasn't captured but
 * tonnage was. DEFAULT 30 A/ton at 240 V — deliberately on the high side so an
 * estimate can only over-warn, never under-warn.
 */
export const LRA_PER_TON_ESTIMATE = 30

/**
 * A soft-start kit typically cuts compressor inrush to a fraction of LRA.
 * DEFAULT 0.4 (vendors quote 60–70 % reduction; 0.4 is the conservative end).
 */
export const SOFT_START_LRA_FACTOR = 0.4

/**
 * Electric tankless water heaters run 18–36 kW continuous — outside the
 * air-cooled class entirely. Hard disqualifier for the partial tier (P031).
 */
export const TANKLESS_ELECTRIC_MIN_KW = 18

/**
 * Price-book slot references (P031: "by slot ID only — do not invent prices").
 * These resolve against the price book when the import lane lands; until then
 * the UI says so instead of showing blanks. Amendment: slots are Generac
 * model-keyed, and each assumed SMM emits its own line.
 */
export const PRICE_BOOK_SLOTS = {
  generator: (generatorModel: string) => `GEN-GENERAC-${generatorModel.replace(/\//g, '_')}`,
  switchPackage: (switchPackage: string) => `GEN-SWITCH-${switchPackage.split(' ')[0]}`,
  smm50: 'GEN-SMM-G007000-0',
  smm100: 'GEN-SMM-G007006-0',
  interlock: 'GEN-INTERLOCK-KIT',
  liquidCooled: 'GEN-LC-MANUAL',
  softStartKit: 'GEN-SOFTSTART-KIT',
} as const

/** Every output carries this, verbatim (P031: never present as guaranteed adequacy). */
export const GENERATOR_DISCLAIMER =
  'Preliminary sizing for planning and pricing. Final selection per manufacturer sizing tool and site conditions.'
