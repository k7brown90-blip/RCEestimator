import type {
  FieldThreshold,
  InputFieldDef,
  MeasuredRow,
  MeasuredValue,
  ResultState,
} from './types'

/**
 * Rules for a single input field: is it required right now, does its value
 * satisfy a threshold, and what verdict does that imply.
 *
 * Kept out of the React component so the rules can be tested without rendering
 * anything, and so the report can re-derive the same answers.
 */

export function isBlank(value: MeasuredValue | undefined): boolean {
  if (value === undefined || value === null) return true
  if (typeof value === 'boolean') return false
  if (Array.isArray(value)) return value.length === 0
  return String(value).trim().length === 0
}

/**
 * Whether a field must be filled given what else has been entered.
 * `requiredWhen` exists so an item can ask for rod count only when a rod is
 * actually present, rather than demanding N/A answers.
 */
export function isFieldRequired(
  field: InputFieldDef,
  measured: Record<string, MeasuredValue>,
): boolean {
  if (field.required) return true
  if (!field.requiredWhen) return false

  const trigger = measured[field.requiredWhen.fieldId]
  if (trigger === undefined) return false

  if (field.requiredWhen.equals !== undefined) {
    return String(trigger) === field.requiredWhen.equals
  }
  if (field.requiredWhen.includes !== undefined) {
    if (!Array.isArray(trigger)) return false
    const needle = field.requiredWhen.includes
    return (trigger as unknown[]).some((entry) => entry === needle)
  }
  return false
}

/** Computed fields are derived, so they're never the technician's to fill. */
const isEnterable = (field: InputFieldDef) => field.type !== 'computed'

/** Field ids that must be filled before this item can be saved. */
export function missingRequiredFields(
  fields: InputFieldDef[],
  measured: Record<string, MeasuredValue>,
): string[] {
  return fields
    .filter(isEnterable)
    .filter((field) => isFieldRequired(field, measured) && isBlank(measured[field.id]))
    .map((field) => field.id)
}

/** Rows in a table field missing a required column value. */
export function missingRequiredCells(field: InputFieldDef, rows: MeasuredRow[]): number[] {
  if (field.type !== 'table' || !field.columns) return []
  const required = field.columns.filter((column) => column.required && isEnterable(column))
  return rows.reduce<number[]>((missing, row, index) => {
    if (required.some((column) => isBlank(row[column.id]))) missing.push(index)
    return missing
  }, [])
}

function matchesThreshold(threshold: FieldThreshold, value: MeasuredValue): boolean {
  const { when } = threshold
  if (when.eq !== undefined) return String(value) === String(when.eq)

  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return false

  if (when.lt !== undefined && !(numeric < when.lt)) return false
  if (when.lte !== undefined && !(numeric <= when.lte)) return false
  if (when.gt !== undefined && !(numeric > when.gt)) return false
  if (when.gte !== undefined && !(numeric >= when.gte)) return false
  // A `when` with no comparators would otherwise match everything.
  return when.lt !== undefined || when.lte !== undefined
    || when.gt !== undefined || when.gte !== undefined
}

/**
 * First matching threshold wins, so definitions read top-to-bottom as
 * "worst case first" and a later, looser rule can't override a specific one.
 */
export function evaluateThreshold(
  field: InputFieldDef,
  value: MeasuredValue | undefined,
): FieldThreshold | null {
  if (!field.thresholds || isBlank(value)) return null
  return field.thresholds.find((threshold) => matchesThreshold(threshold, value!)) ?? null
}

const SEVERITY_ORDER: ResultState[] = ['NA', 'PASS', 'BELOW_STANDARD', 'MONITOR', 'FAIL']

/** The worst verdict implied by any threshold-bearing field on this item. */
export function suggestedVerdict(
  fields: InputFieldDef[],
  measured: Record<string, MeasuredValue>,
): { verdict: ResultState; reasons: string[] } | null {
  const hits = fields
    .map((field) => evaluateThreshold(field, measured[field.id]))
    .filter((threshold): threshold is FieldThreshold => threshold !== null)

  if (hits.length === 0) return null

  let verdict: ResultState = 'PASS'
  for (const hit of hits) {
    if (SEVERITY_ORDER.indexOf(hit.verdict) > SEVERITY_ORDER.indexOf(verdict)) {
      verdict = hit.verdict
    }
  }
  const reasons = hits
    .filter((hit) => hit.verdict === verdict && hit.message)
    .map((hit) => hit.message as string)

  return { verdict, reasons }
}

/**
 * Overriding a suggested verdict downward needs a written reason; overriding it
 * upward doesn't. An electrician who sees something the numbers don't should
 * always be free to escalate — talking themselves down is what needs a record.
 */
export function requiresOverrideReason(
  suggested: ResultState | undefined,
  chosen: ResultState,
): boolean {
  if (!suggested || suggested === chosen) return false
  if (chosen === 'NA') return false
  return SEVERITY_ORDER.indexOf(chosen) < SEVERITY_ORDER.indexOf(suggested)
}
