/**
 * The labelled PREVIEW of a quote built with no signal (2026-10-09, one-estimating-system plan,
 * Phase 7 unit U3; Kyle, 2026-10-13: every line previews at its OWN difficulty).
 *
 * Kyle, 2026-09-22: "They would have to be able to do estimates ... without service."
 *
 * ── WHAT A PREVIEW IS, AND IS NOT ────────────────────────────────────────────────────────────────
 *
 * The server's engine priced ONE unit of every live item at EACH difficulty (Normal, Difficult,
 * Very difficult) when it cut the price sheet (src/services/fieldPriceSheet.ts). A preview is the
 * one-unit figure at the line's own difficulty multiplied by the quantity — `round2(quantity × price)`, which is the engine's own flat-row rule — and added up per
 * option, per-line-rounded, exactly as the office's `frozenStyleSubtotal` adds (every line to the
 * cent first, then the sum). The ticked-combination table, the range and the discount rows then
 * come from the SAME shared builder the office's figures come from (`buildMoneyTable`), over the
 * same pure pricer (`priceAllSelections`). This file does no arithmetic of its own beyond the
 * multiply and the per-option sum; it takes no percentage and reads no rate.
 *
 * A preview is NEVER the price. The firm number is set when the estimate is issued with signal
 * (the server re-prices every line from its own book, applies the material cap and the
 * combined-options check, and freezes). Nobody signs a preview. Two things make a line show
 * "Priced when signal returns" instead of a figure:
 *   - the item is not on the sheet, or the sheet has no price for it AT THE LINE'S DIFFICULTY (the
 *     sheet says why — the book publishes no Difficult column for many rows, and the engine never
 *     scales Normal up; Kyle, 2026-10-13: no ceiling price, no discount standing in);
 *   - the whole sheet is unusable for this quote: the office's rate is provisional, or the quote
 *     prices at a different supplier than the sheet was built at.
 * And a priced line of continuous-length material (wire, cable, conduit) carries "may come down
 * once issued": the job-level cap can only lower it.
 *
 * Combined-options savings are NEVER previewed (`comboSavings: {}`): the phone cannot compute
 * gate 3 and must not claim a saving it cannot stand behind. Financing is never previewed either —
 * the Synchrony figures need a rate that never reaches the phone.
 *
 * Pure: no database, no clock, no IndexedDB. Plain interfaces and functions only — no TS enum, no
 * constructor parameter properties — so the field tsconfig (erasableSyntaxOnly) accepts this file.
 */

import type { DiscountProgramme } from "./discountProgramme";
import { isSheetDifficulty, type PhonePriceSheet, type PhoneSheetRow } from "./fieldPriceSheet";
import { buildMoneyTable, priceSelection, type PricingFigures, type QuoteMoney } from "./quoteMoney";

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** The one sentence every unpriced line, option and total reads. */
export const PRICED_WHEN_SIGNAL_RETURNS = "Priced when signal returns";
/** The badge on a previewed line of continuous-length material. */
export const MAY_COME_DOWN = "May come down once issued — wire and conduit are priced as a job";

export const NOT_ON_SHEET_REASON = "Not in the prices saved on this phone — priced when signal returns";
export const RATE_PROVISIONAL_REASON = "The office's labour rate needs checking — priced when signal returns";
export const SUPPLIER_MISMATCH_REASON = "This quote prices at a different supplier than the prices saved on this phone — priced when signal returns";

/**
 * "preview": the figure is what issuing will freeze for this line as it stands.
 * "mayComeDown": a figure, and the office's job-level check can only lower it.
 * "unpriced": no figure — `reason` says why.
 */
export type PreviewLineStatus = "preview" | "mayComeDown" | "unpriced";

/** What the preview needs of a line — words the phone already holds; no figure comes in. */
export interface PreviewLineInput {
  id: string;
  itemId: string;
  quantity: number;
  difficulty: string;
  option: string;
}

export interface PreviewLine {
  id: string;
  option: string;
  /** `round2(quantity × unit price)`, or null when unpriced. */
  total: number | null;
  status: PreviewLineStatus;
  reason: string | null;
}

export interface PreviewOption {
  option: string;
  /** The per-line-rounded sum, or null while any line in the option is unpriced. */
  subtotal: number | null;
  /** Some priced line in this option may come down once issued. */
  mayComeDown: boolean;
  /** Some line in this option has no preview figure. */
  unpriced: boolean;
}

export interface QuotePreview {
  lines: PreviewLine[];
  /** Only the options that hold lines, in letter order. */
  options: PreviewOption[];
  /** What the shared pricer wants: the option subtotals, the sheet's trip, NO combo savings, the programme. */
  figures: PricingFigures;
  /** Set when the whole sheet is unusable for this quote (rate provisional, supplier mismatch); every line is then unpriced with it. */
  quoteReason: string | null;
}

/** One line's preview: the engine's flat-row rule, `round2(quantity × unit price)`. */
export function previewLineTotal(quantity: number, unitPrice: number): number {
  return round2(quantity * unitPrice);
}

function rowsById(sheet: Pick<PhonePriceSheet, "rows">): Map<string, PhoneSheetRow> {
  return new Map(sheet.rows.map((r) => [r.itemId, r]));
}

/**
 * The preview of a quote's lines from the sheet. `draftSupplierId` is the supplier the quote prices
 * at (the office's payload carries it); when known and different from the sheet's, nothing is
 * previewed.
 */
export function previewFigures(
  lines: readonly PreviewLineInput[],
  sheet: PhonePriceSheet,
  programme: DiscountProgramme | null,
  opts: { draftSupplierId?: string | null } = {},
): QuotePreview {
  const quoteReason = sheet.rateProvisional
    ? RATE_PROVISIONAL_REASON
    : opts.draftSupplierId && opts.draftSupplierId !== sheet.supplierId
      ? SUPPLIER_MISMATCH_REASON
      : null;
  const rows = rowsById(sheet);

  const previewed: PreviewLine[] = lines.map((line) => {
    const unpriced = (reason: string): PreviewLine => ({ id: line.id, option: line.option, total: null, status: "unpriced", reason });
    if (quoteReason) return unpriced(quoteReason);
    const row = rows.get(line.itemId);
    if (!row) return unpriced(NOT_ON_SHEET_REASON);
    // The line's OWN difficulty, read off the sheet — never another difficulty's figure in its place.
    if (!isSheetDifficulty(line.difficulty)) return unpriced(NOT_ON_SHEET_REASON);
    const unit = row.price[line.difficulty] ?? null;
    if (unit === null) return unpriced(row.gap?.[line.difficulty] ?? PRICED_WHEN_SIGNAL_RETURNS);
    return {
      id: line.id,
      option: line.option,
      total: previewLineTotal(line.quantity, unit),
      status: row.exactOffline ? "preview" : "mayComeDown",
      reason: row.exactOffline ? null : MAY_COME_DOWN,
    };
  });

  const letters = [...new Set(previewed.map((l) => l.option))].sort();
  const options: PreviewOption[] = letters.map((option) => {
    const inOption = previewed.filter((l) => l.option === option);
    const unpriced = inOption.some((l) => l.status === "unpriced");
    return {
      option,
      // Per-line-rounded, then rounded — the office's frozenStyleSubtotal rule.
      subtotal: unpriced ? null : round2(inOption.reduce((n, l) => n + (l.total ?? 0), 0)),
      mayComeDown: inOption.some((l) => l.status === "mayComeDown"),
      unpriced,
    };
  });

  return {
    lines: previewed,
    options,
    figures: {
      options: options.map((o) => ({ option: o.option, subtotal: o.subtotal })),
      tripCharge: sheet.tripCharge,
      comboSavings: {},
      programme: programme ? { rate: programme.rate, cap: programme.cap } : null,
    },
    quoteReason,
  };
}

/**
 * The money table for a preview — the SAME builder the office's figures use, over the preview's
 * figures. Financing is null, always: it is shown once the estimate is issued.
 */
export function previewMoney(preview: QuotePreview, exclusiveOptions: boolean, programme: DiscountProgramme | null): QuoteMoney {
  const money = buildMoneyTable(preview.figures, exclusiveOptions, programme);
  money.financing = null;
  return money;
}

/**
 * The headline the Quote screen shows before any discount — the office's `total` is every option
 * plus the trip; here it is the whole-job selection's `base` from the shared pricer (a lookup, not
 * a sum), or null while any option is unpriced or there are no lines.
 */
export function previewTotal(preview: QuotePreview): number | null {
  return priceSelection(preview.figures, preview.options.map((o) => o.option))?.base ?? null;
}
