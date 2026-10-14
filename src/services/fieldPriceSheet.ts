/**
 * The customer-price sheet for the phone's Preview with no signal (2026-10-09, one-estimating-system
 * plan, Phase 7 unit U3; Kyle, 2026-10-13: all three difficulties).
 *
 * ── ONE ESTIMATING SYSTEM: THE ENGINE PRICES THE SHEET ───────────────────────────────────────────
 *
 * Every figure here comes out of `computeEstimate` — the same call `computeDraft` makes for the
 * office's Estimate Intake and the online Quote screen — run once per live catalog item PER
 * DIFFICULTY with ONE line of quantity 1, at the active supplier, after the same `loadRateContext`
 * and `loadCatalogAtSupplier`. The row's price at a difficulty is that line's
 * `laborDollars + materialSell`, the engine's own customer figure (for a flat-priced row the two
 * halves are defined to sum to Kyle's sell price exactly; atomicEstimateEngine.ts "KYLE'S CATALOG
 * PRICES FLAT"). The difficulty goes INTO the engine as the line's own `difficulty`, exactly as a
 * tech's observation does online — this file never scales Normal, never reads a Difficult column
 * itself, never re-derives a formula. Nothing in this file reads a labour column, a cost, a tier or
 * a band: it is not a second pricer, it is the first one asked three thousand one-line questions.
 *
 * Kyle, 2026-10-13 (supersedes "Normal only"): "We need to just bite the bullet and make it work with
 * all difficulties so there is no question that it will transfer smoothly."
 *
 * Each item is priced in its OWN engine call, never all items as one draft: the job-level material
 * check (gate 2) and the combined-options check (gate 3) read every continuous-length line in an
 * option together, so a thousand items in one call would band them as one enormous job and lower
 * each wire row by the others' footage. One line per call is the only shape where the figure means
 * "one unit of this item on a job by itself".
 *
 * ── WHAT THE PHONE DOES WITH IT ─────────────────────────────────────────────────────────────────
 *
 * `round2(quantity × price[line.difficulty])` — the engine's flat-row rule (`flat = round2(unitSell *
 * quantity)`), in shared/quotePreview.ts. For a flat-priced item that is not wire/cable/conduit,
 * that IS the figure issuing would freeze (`exactOffline`). For continuous-length material it is an
 * upper bound: the material cap at quantity N is at most N times the cap at quantity 1 (the band
 * ceilings fall as cost rises), so the quote "may come down once issued" and never up. A NECA-priced
 * row (labour units × the rate + supplier cost × tier) can sit a cent off through float order at
 * some quantity; such a row is checked against the engine at a handful of quantities here, at each
 * difficulty, and where it fails at a difficulty it is sent with no price there so the phone says
 * "Priced when signal returns" rather than showing a figure that could be a cent wrong — the
 * design's rule (plan §3), not a special case.
 *
 * ── WHAT LEAVES THIS FILE ────────────────────────────────────────────────────────────────────────
 *
 * Three customer prices per row, each or null with words a customer may read. The engine's gap
 * MESSAGES are not forwarded: NO_LABOUR_UNIT_BASIS's names the labour value ("carries a labour value
 * of 6.2"), which is exactly the figure the phone must never hold. Each gap kind maps to a fixed
 * sentence with no number in it (`PHONE_GAP_WORDS`), and the key-set test pins that no other field
 * rides on a row.
 *
 * ── BUILT ONCE, SERVED FROM MEMORY (D3, 2026-10-13) ────────────────────────────────────────────
 *
 * Three engine runs per item (nine-plus for a built row) on every Today load of every phone would
 * be waste: the sheet depends on exactly three tables, so a cheap stamp over them (row counts and
 * the newest `lastSeenAt` of the catalog and Rate Config; the count and value sums of supplier
 * prices, which carry no timestamp) decides whether the sheet in memory still describes the book.
 * The stamp moves on any Prisma write to those tables, the sheet is rebuilt, and `{unchanged}` is
 * answered from the stamp alone. One process, one memo; two phones asking at once share one build.
 */

import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import {
  computeEstimate,
  isContinuousLengthMaterial,
  isFlatPriced,
  type ComputedLine,
  type DraftLineInput,
  type EngineAtomic,
  type LineGapKind,
} from "./atomicEstimateEngine";
import type { RateConfig } from "./priceBookPricing";
import { draftSupplierFor, loadCatalogAtSupplier, loadRateContext, quantitySourceFor } from "./atomicEstimateService";
import {
  SHEET_DIFFICULTIES,
  type PhonePriceSheet,
  type PhonePriceSheetResponse,
  type PhoneSheetRow,
  type SheetDifficulty,
} from "../../shared/fieldPriceSheet";

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Why a row has no price at a difficulty, in words for a phone a customer may hold. Keyed by the
 * engine's gap kind so a new kind cannot be added without choosing its sentence (the type forces
 * it), and no sentence carries a number (tests/fieldPriceSheet.test.ts checks the text for digits).
 * "At this difficulty" because the same row is usually priced at another one.
 */
export const PHONE_GAP_WORDS: Record<LineGapKind, string> = {
  NO_SELL_PRICE_AT_DIFFICULTY: "No price is published for this item at this difficulty — the office prices it",
  NO_LABOUR_VALUE: "No labour figure is published for this item at this difficulty — the office prices it",
  NO_LABOUR_UNIT_BASIS: "This item's labour unit basis is not verified — the office prices it",
  NO_PRICE_AT_SUPPLIER: "No price at the active supplier — the office prices it",
  ATOMIC_NOT_FOUND: "Not in the price book — the office prices it",
  MEASURED_LENGTH_MISSING: "The office prices this item",
  MANUAL_QUANTITY_WITHOUT_NOTE: "The office prices this item",
};

/** When the office's billed rate is blank the engine prices no labour, so no row is priced at all. */
export const NO_RATE_WORDS = "No labour rate is set at the office — priced when signal returns";

/** A built row whose line does not scale from one unit at some checked quantity. */
export const DOES_NOT_SCALE_WORDS = "This item's price does not scale from one unit — the office prices it";

/**
 * The quantities a NECA-priced row is checked at before its one-unit price is trusted to scale.
 * Not a proof for every quantity — a labelled preview that nobody signs does not need one — but a
 * row that fails at any of these is plainly not a "multiply by the quantity" row.
 */
const PARITY_QUANTITIES = [2, 3, 7, 10, 25, 100, 250, 1000] as const;

/** The engine's own customer figure for one priced line — the sum the online payload shows as `lineTotal`. */
function lineCustomerTotal(line: ComputedLine): number {
  return round2((line.laborDollars ?? 0) + (line.materialSell ?? 0));
}

/** Price ONE line of this item at this difficulty through the engine, alone, and hand back the line. */
function engineLine(
  atomic: EngineAtomic,
  quantity: number,
  difficulty: SheetDifficulty,
  atomics: Map<string, EngineAtomic>,
  rc: RateConfig,
  supplierId: string,
): ComputedLine {
  const input: DraftLineInput = {
    itemId: atomic.itemId,
    quantity,
    quantitySource: quantitySourceFor(atomic),
    difficulty,
  };
  return computeEstimate([input], atomics, rc, supplierId).lines[0];
}

/** One difficulty of one row: the engine's figure, or null with its words. */
function priceAt(
  atomic: EngineAtomic,
  difficulty: SheetDifficulty,
  atomics: Map<string, EngineAtomic>,
  rc: RateConfig,
  supplierId: string,
  shape: { flat: boolean; continuous: boolean },
): { price: number | null; gap: string | null } {
  const unpriced = (gap: string) => ({ price: null, gap });
  if (rc.billedLaborRate === null) return unpriced(NO_RATE_WORDS);

  const one = engineLine(atomic, 1, difficulty, atomics, rc, supplierId);
  if (!one.complete) return unpriced(PHONE_GAP_WORDS[one.gaps[0]?.kind ?? "ATOMIC_NOT_FOUND"]);
  if (one.laborDollars === null && one.materialSell === null) return unpriced(PHONE_GAP_WORDS.ATOMIC_NOT_FOUND);
  const price = lineCustomerTotal(one);

  // A row the engine BUILDS (labour units × the rate + supplier cost × tier) rather than reads must
  // scale exactly at the quantities checked, or the phone shows no figure for it at this
  // difficulty. Continuous-length material is not checked: it is labelled "may come down" and is
  // expected to differ at quantity.
  if (!shape.flat && !shape.continuous) {
    for (const q of PARITY_QUANTITIES) {
      const at = engineLine(atomic, q, difficulty, atomics, rc, supplierId);
      if (!at.complete || lineCustomerTotal(at) !== round2(q * price)) return unpriced(DOES_NOT_SCALE_WORDS);
    }
  }
  return { price, gap: null };
}

/**
 * One sheet row: the engine's one-unit figure at each of the three difficulties. Pure given the
 * loaded catalog and Rate Config — exported so the parity test can run it on a fixture catalog
 * without the route.
 */
export function phoneSheetRow(atomic: EngineAtomic, atomics: Map<string, EngineAtomic>, rc: RateConfig, supplierId: string): PhoneSheetRow {
  const flat = isFlatPriced(atomic);
  const continuous = isContinuousLengthMaterial(atomic);
  const price = {} as Record<SheetDifficulty, number | null>;
  const gap = {} as Record<SheetDifficulty, string | null>;
  for (const difficulty of SHEET_DIFFICULTIES) {
    const at = priceAt(atomic, difficulty, atomics, rc, supplierId, { flat, continuous });
    price[difficulty] = at.price;
    gap[difficulty] = at.gap;
  }
  return { itemId: atomic.itemId, price, gap, exactOffline: flat && !continuous };
}

/** The stamp: a hash of everything the phone would store. Any price, trip, supplier or rate change moves it. */
function sheetVersion(sheet: Omit<PhonePriceSheet, "version" | "generatedAt">): string {
  return createHash("sha256").update(JSON.stringify(sheet)).digest("hex").slice(0, 32);
}

// ─── The memo (D3) ───────────────────────────────────────────────────────────────────────────────

/**
 * What the sheet is built from, in one cheap string: if it has not moved, neither has the sheet.
 * Rate Config and the catalog carry `lastSeenAt @updatedAt` (every Prisma write moves it, and the
 * row count catches a delete); supplier prices carry no timestamp, so their count and the sums of
 * their three money columns stand in — an edit to any one price moves a sum.
 */
async function bookStamp(prisma: PrismaClient): Promise<string> {
  const [rate, atomics, prices] = await Promise.all([
    prisma.priceBookRateConfig.aggregate({ _count: { _all: true }, _max: { lastSeenAt: true } }),
    prisma.priceBookAtomic.aggregate({ _count: { _all: true }, _max: { lastSeenAt: true, retiredAt: true } }),
    prisma.priceBookSupplierPrice.aggregate({ _count: { _all: true }, _sum: { unitCost: true, priceAsPrinted: true, packQty: true } }),
  ]);
  return JSON.stringify([
    rate._count._all, rate._max.lastSeenAt?.getTime() ?? 0,
    atomics._count._all, atomics._max.lastSeenAt?.getTime() ?? 0, atomics._max.retiredAt?.getTime() ?? 0,
    prices._count._all, prices._sum.unitCost ?? 0, prices._sum.priceAsPrinted ?? 0, prices._sum.packQty ?? 0,
  ]);
}

let memo: { stamp: string; sheet: Promise<PhonePriceSheet> } | null = null;
let builds = 0;

/** How many times the sheet has actually been built in this process — for the memo test. */
export function priceSheetBuildCount(): number {
  return builds;
}

/** Forget the sheet in memory (tests). The next request builds it again. */
export function resetPriceSheetMemo(): void {
  memo = null;
}

async function buildSheet(prisma: PrismaClient): Promise<PhonePriceSheet> {
  builds += 1;
  const rate = await loadRateContext(prisma);
  const supplierId = draftSupplierFor(rate.rc);
  // Live rows only (no referenced ids): the sheet offers what the picker offers. A retired item on an
  // existing draft is priced by the office when signal returns, as the online payload prices it.
  const atomics = await loadCatalogAtSupplier(prisma, supplierId, rate.rc.markupTiers);
  const rows = [...atomics.values()]
    .sort((a, b) => (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0))
    .map((atomic) => phoneSheetRow(atomic, atomics, rate.rc, supplierId));
  const body = {
    supplierId,
    // Whatever the office's Rate Config says the trip is (production: $0, Kyle 2026-10-09). Never a figure made here.
    tripCharge: rate.rc.jobFixedCost ?? 0,
    rateProvisional: rate.provisional,
    rows,
  };
  return { version: sheetVersion(body), generatedAt: new Date().toISOString(), ...body };
}

/**
 * The whole sheet for the phone: every live item, at the active supplier, at every difficulty. With
 * the version the phone already holds, an unchanged sheet answers `{ unchanged: true }` and sends
 * no rows. The sheet is built only when the book's stamp has moved since the last build; otherwise
 * the one in memory answers (D3). A build that fails is not kept: the next request tries again.
 */
export async function buildPhonePriceSheet(prisma: PrismaClient, haveVersion?: string | null): Promise<PhonePriceSheetResponse> {
  const stamp = await bookStamp(prisma);
  if (!memo || memo.stamp !== stamp) {
    const sheet = buildSheet(prisma);
    const entry = { stamp, sheet };
    memo = entry;
    sheet.catch(() => {
      if (memo === entry) memo = null;
    });
  }
  const sheet = await memo.sheet;
  if (haveVersion && haveVersion === sheet.version) return { unchanged: true, version: sheet.version };
  return sheet;
}
