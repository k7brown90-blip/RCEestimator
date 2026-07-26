import { checklist } from '../data/checklist'
import { scoreInspection, type ScoreResult } from './scoring'
import type {
  ChecklistItemDef,
  Inspection,
  InspectionLoadCalc,
  ItemResult,
  JurisdictionProfile,
  ResultState,
} from './types'

export type Band = 'Excellent' | 'Good / Serviceable' | 'Needs attention' | 'Priority'

export function bandFor(score: number, hasCritical: boolean): Band {
  if (hasCritical) return score < 60 ? 'Priority' : 'Needs attention'
  if (score >= 90) return 'Excellent'
  if (score >= 75) return 'Good / Serviceable'
  if (score >= 60) return 'Needs attention'
  return 'Priority'
}

// Five glance roll-ups (Blueprint report-assembly rules / spec §10).
export const rollupGroups: { id: string; label: string; itemIds: string[] }[] = [
  { id: 'service-panel', label: 'Service & Panel', itemIds: ['A1', 'A2', 'A3', 'B1', 'B2', 'D2', 'D3', 'D4', 'H2'] },
  { id: 'grounding-bonding', label: 'Grounding & Bonding', itemIds: ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7'] },
  { id: 'branch-circuits', label: 'Branch Circuits', itemIds: ['D1', 'E1', 'E2', 'E3'] },
  { id: 'devices-wiring', label: 'Devices & Wiring', itemIds: ['F1', 'F2', 'F3'] },
  { id: 'life-safety', label: 'Life Safety', itemIds: ['G1', 'G2', 'G3', 'H1', 'I1'] },
]

const severityOrder: ResultState[] = ['NA', 'PASS', 'BELOW_STANDARD', 'MONITOR', 'ACTION']

export function worstResult(results: ResultState[]): ResultState {
  let worst: ResultState = 'NA'
  for (const result of results) {
    if (severityOrder.indexOf(result) > severityOrder.indexOf(worst)) {
      worst = result
    }
  }
  return worst
}

const plainResultText: Record<ResultState, string> = {
  PASS: 'meets requirements',
  MONITOR: 'worth monitoring',
  ACTION: 'requires corrective action',
  BELOW_STANDARD: "meets code but is below Red Cedar's enhanced standard",
  NA: 'not applicable to this property',
}

function contextTokens(profile: JurisdictionProfile, result: ItemResult): Record<string, string> {
  const is2023 = profile.necEdition === '2023'
  return {
    plain_result: plainResultText[result.result],
    edition_note: is2023
      ? 'Under the 2023 NEC adopted here, GFCI scope is expanded to nearly all 125–250 V receptacles in listed areas.'
      : 'The 2017 NEC scope applies in this jurisdiction.',
    tn_amendment_note: is2023
      ? ''
      : 'TN amendment: AFCI optional in baths, laundry, garages, unfinished basements.',
    required_or_optional: profile.requiredOverrides[result.itemId] ?? (is2023 ? 'required' : 'optional'),
    spd_code_stance: is2023
      ? 'Required by 230.67 under the 2023 NEC adopted here.'
      : 'Not required under the 2017 NEC adopted here.',
    spd_requirement_line: is2023
      ? 'Required in this jurisdiction under 230.67.'
      : 'Not required in this jurisdiction — adding one is optional protection.',
  }
}

export function mergePlaceholders(
  template: string,
  measured: Record<string, string | number>,
  context: Record<string, string>,
): string {
  return template.replace(/\{(\w+)\}/g, (_match, token: string) => {
    if (token in measured && String(measured[token]).length > 0) {
      return String(measured[token])
    }
    if (token in context && context[token].length > 0) {
      return context[token]
    }
    return '—'
  })
}

export interface ReportItem {
  def: ChecklistItemDef
  result: ItemResult
  whatWeCheck: string
  whyCodeCares: string
  whatWeFound: string
  whyItMatters: string
  citations: string[]
}

export interface RollupStatus {
  id: string
  label: string
  status: ResultState
}

export interface ReportModel {
  score: ScoreResult
  band: Band
  rollups: RollupStatus[]
  items: ReportItem[]
  honestyLine: string
  loadCalc?: InspectionLoadCalc
}

export const honestyLine =
  'This score reflects severity, likelihood, and how hidden each issue is — weighted from national fire/shock data, not our opinion.'

export function buildReport(inspection: Inspection, profile: JurisdictionProfile): ReportModel {
  const score = scoreInspection(inspection)
  const resultById = new Map(inspection.items.map((item) => [item.itemId, item]))

  const items: ReportItem[] = []
  for (const def of checklist) {
    const result = resultById.get(def.id)
    if (!result) continue
    const context = contextTokens(profile, result)
    const citations = profile.citationOverrides[def.id] ?? def.citations
    items.push({
      def,
      result,
      whatWeCheck: mergePlaceholders(def.reasoning.whatWeCheck, result.measured, context),
      whyCodeCares: mergePlaceholders(def.reasoning.whyCodeCares, result.measured, context),
      whatWeFound: mergePlaceholders(def.reasoning.whatWeFound, result.measured, context),
      whyItMatters: mergePlaceholders(def.reasoning.whyItMatters, result.measured, context),
      citations,
    })
  }

  const rollups: RollupStatus[] = rollupGroups.map((group) => {
    const children = group.itemIds
      .map((id) => resultById.get(id))
      .filter((r): r is ItemResult => r !== undefined)
    return {
      id: group.id,
      label: group.label,
      status: worstResult(children.map((r) => r.result)),
    }
  })

  return {
    score,
    band: bandFor(score.score, score.criticalFindings.length > 0),
    rollups,
    items,
    honestyLine,
    loadCalc: inspection.loadCalc,
  }
}
