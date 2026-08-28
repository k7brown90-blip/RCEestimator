/**
 * Checklist definition types, moved here from field/src/domain/types.ts so the
 * server's report generator can render the same narratives the field app shows
 * on site — the whatWeCheck / whatWeFound / whyItMatters text and the
 * reportLabel sentence fragments live on these defs, and a customer document
 * that reworded them independently would drift from the assessment it records.
 * field/src/domain/types.ts re-exports everything here, so field imports are
 * unchanged.
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
