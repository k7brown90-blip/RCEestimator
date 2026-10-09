/**
 * What the field Quote screen's price-book picker is told about a catalog item, and the section
 * cards it browses by (2026-10-08, one-estimating-system plan, Phase 2 unit C).
 *
 * The CRM's browse (GET /price-book/atomics) and the phone's (GET /health-record/quote-catalog) run
 * on ONE service, browseAtomics in src/services/atomicEstimateService.ts. The CRM's rows carry the
 * workbook's published labour hours and Red Cedar's supplier cost because the office sees both.
 * The phone's do NOT: the technician hands the phone to the customer, so `toFieldCatalogRow` keeps
 * only the words and the yes/no badges. A badge says "this item has no labour hours published"; it
 * never says how many (constants.md "Field app": no labour hours, labour dollars, rates or costs in
 * the field payload).
 *
 * Plain interfaces only — no TS enum, no constructor parameter properties — so the client and field
 * tsconfigs (erasableSyntaxOnly) accept this file as-is.
 */

/** One catalog item as the phone sees it: description, unit, and the same gap badges as the CRM. */
export interface FieldCatalogRow {
  itemId: string;
  description: string | null;
  category: string | null;
  unit: string | null;
  /** A hand-built product (breaker + raceway + wire + labour) sold as ONE line. */
  isAssembly: boolean;
  /** False when the row has hours but nothing to scale them by — "no labour unit basis". */
  hasLabourUnitBasis: boolean;
  /** False when a supplier price is missing — "no price at supplier" (never on a flat-priced row). */
  hasPriceAtActiveSupplier: boolean;
  isFlatPriced: boolean;
  /** Sold by the foot — the quantity is a measured length. */
  isContinuousLength: boolean;
  /** False when all three labour columns are blank — "no labour hours". */
  hasPublishedLabour: boolean;
  sellsMaterial: boolean;
  /** Sold by the hour — the quantity IS hours. */
  isHourlyProduct: boolean;
}

/** A browse card: one of Kyle's price-book sections and how many live items are in it. */
export interface CatalogSection {
  section: string;
  itemCount: number;
}

/** The answer to a search or a section browse. `truncated` is true when more matched than came back. */
export interface FieldCatalogPage {
  atomics: FieldCatalogRow[];
  count: number;
  total: number;
  truncated: boolean;
}

/**
 * The whole live price book in words, for the phone to keep (2026-10-09, one-estimating-system plan,
 * Phase 7 unit U2). With no signal the Quote screen's picker searches and browses THIS copy instead
 * of asking the server. Same rows the online picker shows — `toFieldCatalogRow`, so words and yes/no
 * badges and nothing else (no labour hours, labour unit basis, cost or price) — but all of them, not
 * the picker's 60-row page.
 *
 * `version` is opaque: the phone stores it, sends it back, and compares nothing itself.
 */
export interface FieldCatalogSnapshot {
  version: string;
  /** Server time the snapshot was cut. The phone labels its copy "Price book saved at <time>". */
  generatedAt: string;
  /** Every live (non-retired) item, ordered by itemId. */
  rows: FieldCatalogRow[];
  /** The section cards, the same list and counts as `GET /quote-catalog/sections`. */
  sections: CatalogSection[];
}

/** The answer when the phone's copy is already current: nothing to download. */
export interface FieldCatalogUnchanged {
  unchanged: true;
  version: string;
}

export type FieldCatalogSnapshotResponse = FieldCatalogSnapshot | FieldCatalogUnchanged;

/**
 * Does this row answer a search? The SAME test the server's browseAtomics runs for the online picker
 * (2026-10-09): the text is trimmed, and a row matches when it appears anywhere in the item code or
 * the description, ignoring case. A blank search matches everything, as "no search" does online.
 * A row with no description can still match on its code.
 *
 * Pure — the phone runs this over its saved copy, the test runs it against the real route.
 */
export function matchesCatalogSearch(row: Pick<FieldCatalogRow, "itemId" | "description">, q: string | null | undefined): boolean {
  const needle = (q ?? "").trim().toLowerCase();
  if (!needle) return true;
  return row.itemId.toLowerCase().includes(needle) || (row.description ?? "").toLowerCase().includes(needle);
}

/**
 * Is this row in the named section? browseAtomics filters its `category` column with "contains,
 * ignoring case" — not an exact match — so the picker's section browse is a substring test online,
 * and this is the same one (a section named "Wire" also lists a section named "Wire and cable", online
 * and here alike). A blank section matches everything; a row with no category never matches a named one.
 */
export function inSection(row: Pick<FieldCatalogRow, "category">, section: string | null | undefined): boolean {
  const needle = (section ?? "").trim().toLowerCase();
  if (!needle) return true;
  return (row.category ?? "").toLowerCase().includes(needle);
}
