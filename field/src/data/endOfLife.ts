import type { MeasuredValue } from '../domain/types'

/**
 * Equipment with a published service life, and the field that dates it.
 *
 * This is what makes a MONITOR actionable rather than a shrug: "worth watching"
 * is a note, "the manufacturer rates this for 30 years and it was installed in
 * 1994" is a date the office can schedule against. The ledger stores the expiry
 * year and the follow-up sweep raises a lead as it approaches.
 *
 * Only equipment with a real published life belongs here. Guessing an expiry
 * date and then dunning a customer about it is worse than saying nothing.
 */
export interface EndOfLifeRule {
  /** Field holding the install / manufacture year. */
  fieldId: string
  /** Published service life in years. */
  years: number
  /** Where the figure comes from — printed with the recommendation. */
  basis: string
}

export const END_OF_LIFE_RULES: Record<string, EndOfLifeRule> = {
  H1: {
    fieldId: 'oldest_year',
    years: 10,
    basis: 'NFPA 72 sets a 10-year replacement life for smoke alarms.',
  },
  H2: {
    fieldId: 'install_year',
    years: 30,
    basis: 'Panelboards are generally rated for a ~30-year service life.',
  },
}

/** The year this item is expected to reach end of life, if it can be dated. */
export function expectedEolYear(
  itemId: string,
  measured: Record<string, MeasuredValue>,
): number | undefined {
  const rule = END_OF_LIFE_RULES[itemId]
  if (!rule) return undefined
  const year = Number(measured[rule.fieldId])
  if (!Number.isFinite(year) || year < 1900 || year > 2200) return undefined
  return Math.round(year) + rule.years
}
