import type { LoadCalcInput, LoadCalcResult } from './loadcalc'

/**
 * PASS / MONITOR / FAIL are the technician's three everyday calls.
 * BELOW_STANDARD is code-compliant but under Red Cedar's own bar — used where
 * there's no violation to cite but the work still isn't what we'd install.
 * NA is an explicit, logged "doesn't apply here", not a skipped item.
 */
export type ResultState =
  | 'PASS'
  | 'MONITOR'
  | 'FAIL'
  | 'NA'
  | 'BELOW_STANDARD'

export type GradedState = 'severe' | 'moderate' | 'minor'

export type InputFieldType =
  | 'text'
  | 'number'
  | 'select'
  | 'multiselect'
  | 'boolean'
  | 'computed'
  | 'table'

export type FieldUnit = 'V' | 'A' | 'Ω' | 'in' | 'ft' | '%' | 'yr' | 'AWG' | 'kA' | '°C'

export interface FieldOption {
  value: string
  /** Button text in the field. */
  label: string
  /** Sentence-fragment form for the report, e.g. "showing corrosion". */
  reportLabel?: string
}

/**
 * Turns a reading into a verdict, so the technician sees what the number means
 * before choosing a result rather than judging it from memory.
 */
export interface FieldThreshold {
  when: { lt?: number; lte?: number; gt?: number; gte?: number; eq?: string | number }
  verdict: ResultState
  message?: string
}

export type FormulaId =
  | 'neutral_current'
  | 'leg_imbalance_pct'
  | 'branch_drop_delta'
  | 'age_from_install_year'

export interface InputFieldDef {
  id: string
  label: string
  type: InputFieldType
  unit?: FieldUnit
  placeholder?: string
  helpText?: string
  /** select | multiselect */
  options?: FieldOption[]
  /** number */
  min?: number
  max?: number
  step?: number
  required?: boolean
  /** Required only when another field holds a particular value. */
  requiredWhen?: { fieldId: string; equals?: string; includes?: string }
  /** computed */
  formula?: FormulaId
  /** Field ids feeding the formula. `ITEM.field` reads across items. */
  formulaInputs?: string[]
  thresholds?: FieldThreshold[]
  /** table — one level only, no nesting. */
  columns?: InputFieldDef[]
  minRows?: number
  maxRows?: number
}

/**
 * Where an inspection point is assessed.
 *
 * The checklist isn't a flat list of one-off checks — the same item recurs
 * wherever it applies. Every panel has its own directory, its own terminations,
 * its own voltages; grounding electrodes and the water bond exist once, at the
 * service. Phase 1 is a single `service_exterior` location; Phase 2 adds
 * interior panels and subpanels.
 */
export type LocationKind = 'service_exterior' | 'panel' | 'interior_general'

export type PanelRole = 'meter_main' | 'main' | 'sub' | 'disconnect_only'

export interface InspectionLocation {
  id: string
  kind: LocationKind
  /** "Service / exterior", "Subpanel — basement". */
  label: string
  panelRole?: PanelRole
  /** What this panel feeds: "entire house", "HVAC only". */
  feeds?: string
  phase: InspectionPhase
}

export type InspectionPhase = 1 | 2

export interface ChecklistItemDef {
  id: string
  section: string
  title: string
  citations: string[]
  jurisdictionDependent: boolean
  bannerListed: boolean
  lifeSafetyClass: boolean
  graded?: GradedState[]
  naAllowed: boolean
  /** Which pass this item belongs to. */
  phase: InspectionPhase
  /** Sub-grouping within a phase, e.g. 'panel-measurements'. */
  group: string
  /** Location kinds this item can be assessed at. */
  appliesTo: LocationKind[]
  /** True when the item recurs once per location (per panel, typically). */
  repeatable: boolean
  /** FAIL also requires the numeric readings, not just a photo. */
  measurementRequired?: boolean
  /** Item ids that must be recorded first — their readings feed this one. */
  dependsOn?: string[]
  inputFields: InputFieldDef[]
  reasoning: {
    whatWeCheck: string
    whyCodeCares: string
    whatWeFound: string
    whyItMatters: string
  }
}

export interface WeightDef {
  itemId: string
  gradedState?: GradedState
  S: number
  L: number
  C: number | null
  W: number
}

export interface JurisdictionProfile {
  id: string
  label: string
  necEdition: '2017' | '2023'
  surgeRequired: boolean
  metroAmendments: boolean
  citationOverrides: Record<string, string[]>
  requiredOverrides: Record<string, 'required' | 'optional'>
}

/** Link back to the CRM job this inspection belongs to. */
export interface CrmLink {
  visitId: string
  propertyId: string
  customerId: string
  customerName?: string
}

/**
 * How the jurisdiction was determined, resolved server-side.
 * `default` means nobody actually decided — the app says so rather than
 * silently applying a code edition.
 */
export type JurisdictionSource = 'property' | 'territory' | 'city' | 'default'

export interface Property {
  id: string
  address: string
  jurisdictionId: string
  jurisdictionSource: JurisdictionSource
  createdAt: string
  /**
   * Every inspection belongs to a CRM job. Free-typed addresses are gone —
   * an inspection with no job has nowhere to be filed and never reached the
   * office.
   */
  crm: CrmLink
  /**
   * Pre-v4 local property created before CRM linkage was required. Kept so its
   * photo evidence isn't orphaned, but excluded from the assignment picker.
   */
  legacy?: true
}

/**
 * A job assigned to this technician, as served by the CRM. This is the only way
 * to start an inspection — the address, the account and the jurisdiction all
 * come from the office, never from typing.
 */
export interface CrmAssignment {
  assignmentId: string
  assignmentStatus: string
  role: string
  visitId: string
  visitStatus: string
  jobType: string | null
  purpose: string
  scheduledStart: string | null
  scheduledEnd: string | null
  estimatedDurationDays: number | null
  customerId: string
  customerName: string
  customerPhone: string | null
  propertyId: string
  propertyName: string
  address: {
    line1: string
    line2: string | null
    city: string
    state: string
    postalCode: string
    formatted: string
  }
  jurisdictionId: string
  jurisdictionSource: JurisdictionSource
  lastInspectionDate: string | null
  /**
   * Outstanding ledger rows at this address. Optional so a PWA newer than the
   * server it's talking to still renders the queue.
   */
  openFindingCount?: number
  declinedFindingCount?: number
}

export type MeasuredScalar = string | number | boolean
/** One row of a `table` field, keyed by column id. */
export type MeasuredRow = Record<string, MeasuredScalar>
export type MeasuredValue = MeasuredScalar | string[] | MeasuredRow[]

export interface ItemResult {
  itemId: string
  /**
   * Which location this reading was taken at. Phase 1 has a single location, but
   * carrying it from the start means Phase 2's per-panel repeats are a data
   * change rather than another schema migration.
   */
  locationId?: string
  result: ResultState
  gradedState?: GradedState
  measured: Record<string, MeasuredValue>
  /**
   * Formula outputs, persisted rather than recomputed at render time: the report
   * has to reproduce what the technician saw, and editing an upstream reading
   * later would otherwise silently rewrite history.
   */
  computed?: Record<string, number>
  /** Verdicts derived from thresholds, per field id. */
  autoVerdicts?: Record<string, ResultState>
  /** Per-row verdicts for a table field, keyed by field id. */
  rowVerdicts?: Record<string, ResultState[]>
  photoIds: string[]
  /** Free observations. Optional at any result. */
  note?: string
  /** What it'll take to correct this. Required on FAIL. */
  resolutionNote?: string
  /** Required when the technician overrides an auto-verdict downward. */
  overrideReason?: string
}

/** The stored, reproducible NEC Article 220 calculation attached to a record. */
export interface InspectionLoadCalc {
  input: LoadCalcInput
  result: LoadCalcResult
}

/** Which pass of the inspection this record covers. */
export type InspectionScope = 'full' | 'phase1'

export interface Inspection {
  id: string
  propertyId: string
  jurisdictionId: string
  technician: string
  date: string
  items: ItemResult[]
  scope: InspectionScope
  itemsAssessed: number
  criticalFindings: string[]
  contractorReviewed: boolean
  status: 'draft' | 'complete'
  loadCalc?: InspectionLoadCalc
}
