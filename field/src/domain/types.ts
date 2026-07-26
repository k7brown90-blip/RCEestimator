import type { LoadCalcInput, LoadCalcResult } from './loadcalc'

export type ResultState =
  | 'PASS'
  | 'MONITOR'
  | 'ACTION'
  | 'NA'
  | 'BELOW_STANDARD'

export type GradedState = 'severe' | 'moderate' | 'minor'

export interface InputFieldDef {
  id: string
  label: string
  type: 'text' | 'number' | 'select'
  placeholder?: string
}

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

/** Link back to the CRM when the property came from an admin assignment. */
export interface CrmLink {
  visitId: string
  propertyId: string
  customerId: string
  customerName?: string
}

export interface Property {
  id: string
  address: string
  jurisdictionId: string
  createdAt: string
  crm?: CrmLink
}

export interface ItemResult {
  itemId: string
  result: ResultState
  gradedState?: GradedState
  measured: Record<string, string | number>
  photoIds: string[]
  note?: string
  overrideReason?: string
}

/** The stored, reproducible NEC Article 220 calculation attached to a record. */
export interface InspectionLoadCalc {
  input: LoadCalcInput
  result: LoadCalcResult
}

export interface Inspection {
  id: string
  propertyId: string
  jurisdictionId: string
  technician: string
  date: string
  items: ItemResult[]
  score: number
  itemsAssessed: number
  criticalFindings: string[]
  contractorReviewed: boolean
  status: 'draft' | 'complete'
  loadCalc?: InspectionLoadCalc
}
