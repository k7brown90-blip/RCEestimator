import type { LoadCalcInput, LoadCalcResult } from './loadcalc'

/**
 * The checklist definition types (ResultState, InputFieldDef, ChecklistItemDef,
 * …) now live in `app/shared/checklist/types.ts` so the server's report
 * generator can render the same narratives the app shows on site. Re-exported
 * here so the app's existing imports keep working.
 */
import type {
  GradedState,
  InspectionPhase,
  LocationKind,
  PanelRole,
  ResultState,
} from '../../../shared/checklist/types'
export type {
  ChecklistItemDef,
  FieldOption,
  FieldThreshold,
  FieldUnit,
  FormulaId,
  GradedState,
  InputFieldDef,
  InputFieldType,
  InspectionPhase,
  LocationKind,
  PanelRole,
  ResultState,
} from '../../../shared/checklist/types'

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
  /** P031 generator sizing recommendation, when the technician produced one. */
  generator?: {
    recommendation: import('./generator').GeneratorRecommendation
    fuel: 'NG' | 'LP'
    softStart: boolean
    /** 1,000-ft altitude steps used for the site derate (DEFAULT 1, Middle TN). */
    altitudeSteps: number
    /** Propose-only: the customer one-pager renders on an estimate only when this is set AND a human issues it. */
    includeInEstimate: boolean
  }
}

/** Which pass of the inspection this record covers. */
export type InspectionScope = 'full' | 'phase1'

/**
 * A technician's note on one checklist section (group), matching the notes line
 * per section on the paper field record. Internal by default — `includeOnReport`
 * is the promotion toggle, and only a promoted note reaches the customer's
 * document. (Kyle, 2026-08-24.)
 */
export interface SectionNote {
  group: string
  note: string
  includeOnReport: boolean
}

/**
 * The on-site customer acknowledgment — the digital version of the paper form's
 * signature box. Findings were reviewed with the customer; they signed on the
 * technician's device. Declined items are separate records (finding
 * declinations), not part of this signature.
 */
export interface CustomerAcknowledgment {
  signerName: string
  /** data-URL PNG drawn on the signature pad. */
  signatureImage: string
  acknowledgedAt: string
}

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
  /** Protocol v2 structured capture — enclosures, components, measurements. */
  v2?: import('./v2Types').V2Capture
  /** Per-section notes; absent on records made before 2026-08-24. */
  sectionNotes?: SectionNote[]
  /** Signed on site, or `ackSkippedReason` says why not — absence of both just means an old record. */
  acknowledgment?: CustomerAcknowledgment
  ackSkippedReason?: string
}
