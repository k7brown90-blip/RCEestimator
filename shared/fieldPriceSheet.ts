/**
 * The customer-price sheet the phone keeps for a labelled Preview with no signal (2026-10-09,
 * one-estimating-system plan, Phase 7 unit U3; Kyle, 2026-10-13: ALL THREE difficulties).
 *
 * Kyle, 2026-09-22: "They would have to be able to do estimates ... without service." With no
 * signal the phone cannot ask the office for a price, so the server BUILDS this sheet ahead of
 * time by running its own estimating engine once per catalog item PER DIFFICULTY, at quantity 1,
 * at the active supplier — the same `computeEstimate` the office's Estimate Intake and the online
 * Quote screen price through. Each row carries that ONE customer figure at each of Normal,
 * Difficult and Very difficult, or null with a reason for that difficulty. The phone multiplies the
 * figure at the LINE'S OWN difficulty by the quantity (shared/quotePreview.ts — the engine's own
 * flat-row rule) and labels the result Preview. Nobody signs a preview: the firm number is set
 * when the estimate is issued with signal.
 *
 * Kyle, 2026-10-13 (supersedes the 2026-10-09 "Normal only" ruling): "We need to just bite the
 * bullet and make it work with all difficulties so there is no question that it will transfer
 * smoothly." So a Difficult line previews at its Difficult price — never at a Normal "ceiling",
 * never with a discount standing in for the difficulty, and never "priced when signal returns"
 * merely for not being Normal.
 *
 * WHAT THIS SHEET NEVER CARRIES (constants.md "Field app"; pinned by the PHONE_SHEET_ROW_KEYS test
 * in tests/fieldPriceSheet.test.ts): labour hours or dollars, a labour unit basis, the billed
 * labour rate, any cost or cost basis, the per-unit sell figure of a NECA row, supplier prices,
 * markup tiers, the job material band schedule, or any Synchrony rate. A row is three customer
 * prices and nothing that would let the labour be worked back out of them beyond what Kyle
 * accepted when he ruled for all three (plan §8 risk 3).
 *
 * Plain interfaces only — no TS enum, no constructor parameter properties — so the field tsconfig
 * (erasableSyntaxOnly) accepts this file as-is.
 */

/** The difficulties the sheet prices — every one the engine knows (Kyle, 2026-10-13). */
export const SHEET_DIFFICULTIES = ["NORMAL", "DIFFICULT", "VERY_DIFFICULT"] as const;
export type SheetDifficulty = (typeof SHEET_DIFFICULTIES)[number];

export function isSheetDifficulty(value: string): value is SheetDifficulty {
  return (SHEET_DIFFICULTIES as readonly string[]).includes(value);
}

export interface PhoneSheetRow {
  itemId: string;
  /**
   * The customer price for ONE unit at each difficulty, in dollars to the cent — exactly
   * `laborDollars + materialSell` as the engine priced one unit at that difficulty. Null = the
   * engine could not price it there (see `gap`), and the phone shows "Priced when signal returns"
   * for a line at that difficulty. A row commonly has Normal priced and Difficult null: the book
   * publishes no Difficult column for it, and the engine never scales Normal up.
   */
  price: Record<SheetDifficulty, number | null>;
  /**
   * Why the price at that difficulty is null, in words a customer may read — NEVER the engine's
   * own gap message, which can name a labour value (NO_LABOUR_UNIT_BASIS does). Null when priced.
   */
  gap: Record<SheetDifficulty, string | null>;
  /**
   * True when a line of this item previews EXACTLY what issuing will freeze: the row is flat-priced
   * (Kyle's own sell columns, where the engine reads the price rather than building it) and it is
   * not continuous-length material (wire, cable, conduit), which the job-level material cap and the
   * combined-options check can only LOWER once the quote is priced as a job. False = the preview
   * "may come down once issued". The same at every difficulty: it is a property of the row.
   */
  exactOffline: boolean;
}

export interface PhonePriceSheet {
  /** Opaque to the phone: stored, sent back, compared by nobody but the server. */
  version: string;
  /** Server time the sheet was cut. The phone labels its copy "Prices saved on this phone at <time>". */
  generatedAt: string;
  /** The supplier every row was priced at. A quote at another supplier cannot be previewed from this sheet. */
  supplierId: string;
  /**
   * The trip / fixed job cost charged once per job — whatever Rate Config `jobFixedCost` is on the
   * server when the sheet is cut (Kyle, 2026-10-09: NO trip charge on estimates — production carries
   * $0; this is never a figure the code makes up).
   */
  tripCharge: number;
  /**
   * True when the office's billed rate is blank or differs from Kyle's standing ruling
   * (loadRateContext). The phone then previews NOTHING from this sheet: every line reads "Priced
   * when signal returns" until the office has looked at the rate.
   */
  rateProvisional: boolean;
  /** Every live (non-retired) item, ordered by itemId. */
  rows: PhoneSheetRow[];
}

/** The answer when the phone's copy is already current: nothing to download. */
export interface PhonePriceSheetUnchanged {
  unchanged: true;
  version: string;
}

export type PhonePriceSheetResponse = PhonePriceSheet | PhonePriceSheetUnchanged;

/** The exact key set of a row, sorted — what the server's key-set test and the phone's reader both pin. */
export const PHONE_SHEET_ROW_KEYS = ["exactOffline", "gap", "itemId", "price"] as const;

/**
 * True when a row is in THIS shape — a price and a gap at every one of the three difficulties. A
 * sheet saved on a phone by an earlier build (Normal only, 2026-10-09) fails this, and the phone
 * treats that sheet as gone rather than reading a difficulty it does not carry.
 */
export function isCurrentSheetRow(row: unknown): row is PhoneSheetRow {
  if (!row || typeof row !== "object") return false;
  const r = row as Record<string, unknown>;
  if (typeof r.itemId !== "string" || typeof r.exactOffline !== "boolean") return false;
  const price = r.price as Record<string, unknown> | null | undefined;
  const gap = r.gap as Record<string, unknown> | null | undefined;
  if (!price || typeof price !== "object" || !gap || typeof gap !== "object") return false;
  for (const d of SHEET_DIFFICULTIES) {
    if (!(d in price) || (price[d] !== null && typeof price[d] !== "number")) return false;
    if (!(d in gap) || (gap[d] !== null && typeof gap[d] !== "string")) return false;
  }
  return true;
}
