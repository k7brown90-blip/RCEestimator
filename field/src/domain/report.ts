import { checklist } from '../data/checklist'
import { RETIRED_ITEM_TITLES, mergeLegacyGroundingItems, normalizeResultState } from './compat'
import { summarizeFindings, type FindingsSummary } from './findings'
import type {
  ChecklistItemDef,
  Inspection,
  InspectionLoadCalc,
  InspectionScope,
  ItemResult,
  JurisdictionProfile,
  MeasuredValue,
  ResultState,
} from './types'

/**
 * The report model.
 *
 * Ordered the way the owner reads it: section status at the top, then the items
 * that need correcting with their resolutions, then what to monitor, then what
 * passed. No headline number — the score it replaced answered a question nobody
 * was asking.
 */

/** A visible item the technician never opened — not the same as "N/A". */
export const NOT_ASSESSED = 'NOT_ASSESSED' as const
export type RollupStatusValue = ResultState | typeof NOT_ASSESSED

// Since the 2026-08-26 consolidation the glance IS the walk: one roll-up per
// row (sub-panel instances included), in checklist order. "Should the customer
// report's At a glance mirror these same rows?" — Kyle: "Yes — same rows
// everywhere."

const severityOrder: ResultState[] = ['NA', 'PASS', 'BELOW_STANDARD', 'MONITOR', 'FAIL']

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
  FAIL: 'requires corrective action',
  BELOW_STANDARD: "meets code but is below Red Cedar's enhanced standard",
  NA: 'not applicable to this property',
}

export const ROLLUP_LABEL: Record<RollupStatusValue, string> = {
  PASS: 'PASS',
  MONITOR: 'MONITOR',
  FAIL: 'NEEDS CORRECTION',
  BELOW_STANDARD: 'BELOW STANDARD',
  NA: 'NOT APPLICABLE',
  [NOT_ASSESSED]: 'NOT ASSESSED',
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
      ? 'Required at the service from the 2020 NEC onward (230.67, min 10 kA).'
      : 'Not required under the 2017 NEC adopted here.',
    spd_requirement_line: is2023
      ? 'Required in this jurisdiction under 230.67.'
      : "Not required in this jurisdiction — Red Cedar recommends one at every panel regardless.",
  }
}

/**
 * Render one measured value for prose.
 *
 * Multi-selects read as a list; booleans as yes/no; a table renders as its row
 * count, because the templates that reference one supply the noun themselves
 * ("{branch_rows} branch circuit(s) measured"). Anything is better than
 * "[object Object]" in a customer report.
 */
export function formatMeasured(value: MeasuredValue | undefined): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  if (Array.isArray(value)) {
    if (value.length === 0) return ''
    if (typeof value[0] === 'object') return String(value.length)
    return (value as string[]).join(', ')
  }
  return String(value)
}

/**
 * Everything an item's own templates can interpolate, rendered for prose.
 *
 * Two things happen here. Coded option values become the sentence fragment the
 * checklist author wrote — stored values are machine tokens ('irrev_crimp') and
 * a customer report has to read "an irreversible crimp". And formula outputs are
 * folded in, because they live on `ItemResult.computed`, not in `measured`, so
 * G3's {imbalance_pct} would otherwise render as an em dash on every report.
 */
export function renderMeasuredForProse(
  def: ChecklistItemDef,
  measured: Record<string, MeasuredValue>,
  computed: Record<string, number> = {},
): Record<string, MeasuredValue> {
  const rendered: Record<string, MeasuredValue> = { ...measured, ...computed }

  for (const field of def.inputFields) {
    const raw = measured[field.id]
    if (raw === undefined || !field.options) continue
    const label = (value: MeasuredValue): string => {
      const match = field.options?.find((option) => option.value === String(value))
      return match?.reportLabel ?? match?.label ?? String(value)
    }
    rendered[field.id] = Array.isArray(raw)
      ? (raw as MeasuredValue[]).map(label)
      : label(raw)
  }

  return rendered
}

/**
 * Fill {tokens} from three tiers, in order: this item's own readings, another
 * item's via `{ITEM.field}`, then report context. The cross-item tier mirrors the
 * `ITEM.field` convention `ItemCardScreen.resolveInput` already uses for
 * formulas, so C1 can cite the service rating recorded on A2 without the
 * technician typing it twice — and without the report quietly printing a dash
 * where a number belongs.
 */
export function mergePlaceholders(
  template: string,
  measured: Record<string, MeasuredValue>,
  context: Record<string, string>,
  crossItem: Record<string, MeasuredValue> = {},
): string {
  return template.replace(/\{([\w.]+)\}/g, (_match, token: string) => {
    const own = formatMeasured(measured[token])
    if (own.length > 0) return own
    const cross = formatMeasured(crossItem[token])
    if (cross.length > 0) return cross
    if (context[token]) return context[token]
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
  status: RollupStatusValue
}

export interface ReportSections {
  fail: ReportItem[]
  monitor: ReportItem[]
  belowStandard: ReportItem[]
  pass: ReportItem[]
  na: ReportItem[]
}

export interface ReportModel {
  summary: FindingsSummary
  scope: InspectionScope
  rollups: RollupStatus[]
  sections: ReportSections
  /** Every assessed item in checklist order, for the technical appendix. */
  items: ReportItem[]
  notAssessed: { id: string; title: string; section: string }[]
  loadCalc?: InspectionLoadCalc
}

/** Placeholder def for a retired item, so an old report can still name it. */
function retiredDef(itemId: string): ChecklistItemDef {
  return {
    id: itemId,
    section: 'Retired check',
    title: RETIRED_ITEM_TITLES[itemId] ?? itemId,
    citations: [],
    jurisdictionDependent: false,
    bannerListed: false,
    lifeSafetyClass: false,
    naAllowed: false,
    phase: 1,
    group: 'retired',
    appliesTo: ['service_exterior'],
    repeatable: false,
    inputFields: [],
    reasoning: {
      whatWeCheck: 'This check has since been folded into another item.',
      whyCodeCares: '—',
      whatWeFound: '—',
      whyItMatters: '—',
    },
  }
}

export function buildReport(
  inspection: Inspection,
  profile: JurisdictionProfile,
  visibleItems: ChecklistItemDef[] = checklist,
): ReportModel {
  // Normalise anything written by an earlier version before rendering: first the
  // renamed result states, then the retired items. Order matters — merging reads
  // result states to pick the worst of a group.
  const liveItemIds = new Set(checklist.map((def) => def.id))
  const normalizedItems = mergeLegacyGroundingItems(
    inspection.items.map((item) => ({
      ...item,
      result: normalizeResultState(item.result) as ResultState,
    })),
    liveItemIds,
  )
  const normalized: Inspection = { ...inspection, items: normalizedItems }
  const summary = summarizeFindings(normalized, visibleItems)
  const resultById = new Map(normalizedItems.map((item) => [item.itemId, item]))

  // visibleItems first so sub-panel instance defs (`SUB:<slug>`) resolve; the
  // static checklist backstops items assessed under a def no longer visible.
  const defById = new Map([...checklist, ...visibleItems].map((def) => [def.id, def]))
  const items: ReportItem[] = []

  // Render every item's readings once, then expose them all under `ITEM.field`
  // so any template can reference a value recorded elsewhere in the walk.
  const prose = new Map<string, Record<string, MeasuredValue>>()
  const crossItem: Record<string, MeasuredValue> = {}
  for (const item of normalizedItems) {
    const def = defById.get(item.itemId) ?? retiredDef(item.itemId)
    const rendered = renderMeasuredForProse(def, item.measured, item.computed)
    prose.set(item.itemId, rendered)
    for (const [fieldId, value] of Object.entries(rendered)) {
      crossItem[`${item.itemId}.${fieldId}`] = value
    }
  }

  for (const item of normalizedItems) {
    const def = defById.get(item.itemId) ?? retiredDef(item.itemId)
    const context = contextTokens(profile, item)
    const citations = profile.citationOverrides[def.id] ?? def.citations
    const measured = prose.get(item.itemId) ?? item.measured
    items.push({
      def,
      result: item,
      whatWeCheck: mergePlaceholders(def.reasoning.whatWeCheck, measured, context, crossItem),
      whyCodeCares: mergePlaceholders(def.reasoning.whyCodeCares, measured, context, crossItem),
      whatWeFound: mergePlaceholders(def.reasoning.whatWeFound, measured, context, crossItem),
      whyItMatters: mergePlaceholders(def.reasoning.whyItMatters, measured, context, crossItem),
      citations,
    })
  }

  // Walk order, so the appendix reads the way the inspection was walked —
  // visibleItems carries the sub-panel instances in their on-screen positions.
  const walkOrder = visibleItems.length > 0 ? visibleItems : checklist
  const order = new Map(walkOrder.map((def, index) => [def.id, index]))
  items.sort((a, b) => (order.get(a.def.id) ?? 999) - (order.get(b.def.id) ?? 999))

  const sections: ReportSections = {
    fail: items.filter((i) => i.result.result === 'FAIL'),
    monitor: items.filter((i) => i.result.result === 'MONITOR'),
    belowStandard: items.filter((i) => i.result.result === 'BELOW_STANDARD'),
    pass: items.filter((i) => i.result.result === 'PASS'),
    na: items.filter((i) => i.result.result === 'NA'),
  }

  // One roll-up per row: the glance mirrors the walk exactly.
  const rollups: RollupStatus[] = walkOrder.map((def) => {
    const assessed = resultById.get(def.id)
    return {
      id: def.id,
      label: def.title,
      status: assessed === undefined ? NOT_ASSESSED : assessed.result,
    }
  })

  const notAssessed = visibleItems
    .filter((def) => !resultById.has(def.id))
    .map((def) => ({ id: def.id, title: def.title, section: def.section }))

  return {
    summary,
    scope: inspection.scope,
    rollups,
    sections,
    items,
    notAssessed,
    loadCalc: inspection.loadCalc,
  }
}
