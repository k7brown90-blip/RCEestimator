/**
 * "Check the prices" — what changed between the figures this phone showed and the office's answer
 * (Phase 7 unit U6, 2026-10-10, one-estimating-system plan, design §3 "After sync").
 *
 * When edits queued with no signal land, the office prices them from its own book, and the tech
 * has to look before issuing (the preview was never the price — design §3). This lists, in words:
 *   - each line priced for the first time (it showed no figure on the phone);
 *   - each line, option or headline where the office's figure DIFFERS from the figure the phone
 *     last showed — both numbers printed, compared for EQUALITY ONLY, no difference worked out
 *     (U6 trap: "The panel compares two figures for equality only. It does no money arithmetic");
 *   - each line with gaps (it freezes at $0 if issued — issuedEstimateService);
 *   - each line whose item is now retired ("no longer offered" — the office still prices it);
 *   - a provisional office rate.
 *
 * Pure: two values in, rows out. The phone's half (`ShownFigures`) is taken by lib/quoteSync.ts
 * right before the office's answer replaces the saved copy; the office's half is that answer.
 */

import type { ShownFigures } from '../db/database'
import type { QuoteLine, QuoteState } from './crmSync'

export type PriceCheckKind = 'first' | 'changed' | 'gap' | 'retired' | 'option' | 'total' | 'rate'

export interface PriceCheckRow {
  kind: PriceCheckKind
  /** The sentence the tech reads. Both figures are in it when there are two. */
  words: string
  /** The figure this phone showed, when the row is about one; null = it showed none. */
  shown?: number | null
  /** The office's figure, when the row is about one. */
  office?: number | null
}

export interface PriceCheckReport {
  rows: PriceCheckRow[]
  /** Nothing to flag: every figure the office sent matches what this phone showed. */
  clean: boolean
  /** Where the phone's figures came from as shown — 'preview' (the saved sheet), 'none', the office's own — or null with no note. */
  comparedWith: ShownFigures['source'] | null
}

const money = (n: number) => `$${n.toFixed(2)}`

/** The words for a line's office figure beside the phone's. Equality only; nothing is subtracted. */
function bothFigures(what: string, shown: number, office: number): string {
  return `${what}: this phone showed ${money(shown)}, the office says ${money(office)}`
}

export const OFFICE_RATE_PROVISIONAL = "The office's labour rate is provisional — the office has to settle it before this can be issued"

/**
 * The office's answer (`office`, the saved copy's payload) beside the note of what the phone
 * showed (`shown`; null when there is none — every priced line is then "priced for the first
 * time", because the phone showed nothing it can vouch for).
 */
export function priceCheck(shown: ShownFigures | null | undefined, office: Pick<QuoteState, 'lines' | 'options' | 'total' | 'rateProvisional'>): PriceCheckReport {
  const rows: PriceCheckRow[] = []
  const shownLines = new Map((shown?.lines ?? []).map((l) => [l.id, l]))
  const shownOptions = new Map((shown?.options ?? []).map((o) => [o.option, o]))

  const confirmed = office.lines.filter((l: QuoteLine) => l.state !== 'PROPOSED')
  for (const line of confirmed) {
    if (line.gaps.length > 0) {
      rows.push({
        kind: 'gap',
        words: `${line.description}: no price in the office's book — ${line.gaps.join('; ')}. It freezes at $0 if issued as it stands.`,
        office: line.lineTotal,
      })
    }
    if (line.retired) {
      rows.push({ kind: 'retired', words: `${line.description}: no longer offered in the price book (the office still prices it)`, office: line.lineTotal })
    }
    if (line.lineTotal === null) continue
    const was = shownLines.get(line.id)
    if (!was || was.total === null) {
      rows.push({ kind: 'first', words: `${line.description}: priced for the first time — ${money(line.lineTotal)}`, shown: null, office: line.lineTotal })
    } else if (was.total !== line.lineTotal) {
      rows.push({ kind: 'changed', words: bothFigures(line.description, was.total, line.lineTotal), shown: was.total, office: line.lineTotal })
    }
  }

  for (const option of office.options) {
    const was = shownOptions.get(option.option)
    if (!was || was.subtotal === null || option.subtotal === null) continue
    if (was.subtotal !== option.subtotal) {
      rows.push({ kind: 'option', words: bothFigures(`Option ${option.option}`, was.subtotal, option.subtotal), shown: was.subtotal, office: option.subtotal })
    }
  }

  if (shown && shown.total !== null && office.total !== null && shown.total !== office.total) {
    rows.push({ kind: 'total', words: bothFigures('Total', shown.total, office.total), shown: shown.total, office: office.total })
  }

  if (office.rateProvisional) rows.push({ kind: 'rate', words: OFFICE_RATE_PROVISIONAL })

  return { rows, clean: rows.length === 0, comparedWith: shown?.source ?? null }
}
