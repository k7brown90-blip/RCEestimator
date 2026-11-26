/**
 * Reprice the whole price book when the sales tax rate it is priced at changes - the ONE implementation.
 *
 * Kyle, 2026-11-24: "sell = hours x shop rate + (cost x (1 + tax rate)) x 1.3" - answers "The shop rate in Settings" and
 * "Tax in sell, all items". Kyle, 2026-11-25, on running it: "Automatically on deploy". So there is no preview and no Apply
 * button: this runs by itself
 *   (a) once at server start (src/server.ts) when the book's recorded rate differs from the rate saved in Settings, and
 *   (b) whenever Settings -> Purchasing "Sales tax rate (%)" is saved with a different rate (PUT /crm/settings/purchasing).
 *
 * It rewrites nothing by SQL and has no formula of its own: every row goes through priceBookCatalog.computePricing, the same
 * function the CRM editor, the agent door and the cascade price with (CLAUDE.md "one estimating system").
 *
 * WHAT IT PROMISES
 *  - The rate the book is priced at is recorded in Rate Config cell `bookSalesTaxRate` (a missing cell means the book was priced
 *    with no tax - the state before 2026-11-25). The run does nothing when that equals the saved rate, so it never runs twice for
 *    the same rate.
 *  - It reads the SAVED rate strictly (readSavedSalesTaxRate). Two different things are told apart (Kyle, 2026-11-24: "a company
 *    setting (default 9.75%, editable in Settings)"):
 *      ABSENT - never saved: no Settings -> Purchasing row at all, or a row that has no salesTaxRate in it. Then the default IS the
 *        company's rate: the start-up run takes DEFAULT_SALES_TAX_RATE (9.75%), SAVES it as the purchasing setting inside the same
 *        transaction (merged into whatever else the row holds), and reprices. The Settings screen then shows the saved 9.75%.
 *      UNUSABLE - something was saved that is not a rate: unreadable JSON, a text, a negative, or a percent typed where a fraction
 *        belongs (9.75). Nothing is guessed: the run is skipped with a warning and the row is left exactly as it is.
 *  - ONE transaction under an advisory lock: a second server instance, or a Settings save racing the start-up run, waits for the
 *    first to commit, re-reads the recorded rate and finds nothing to do. The recorded rate is written in the same transaction as
 *    the prices, so a failure leaves the book, the cell and the audit trail all as they were.
 *  - The Settings save itself rides in that same transaction (opts.saveSetting): the saved rate and the book move together or not at
 *    all, so a failed reprice can never leave Settings saying one rate while the book (and every item an editor writes meanwhile)
 *    sits at another.
 *  - Item edits (CRM PATCH, an approved agent proposal, a refresh accept, the assembly cascade) never take the advisory lock, so the run
 *    takes a SHARE ROW EXCLUSIVE table lock on PriceBookAtomic before it reads a single row: an edit already committed is what it reads,
 *    an edit that starts later waits for the commit. Without it the run wrote prices computed from a cost an edit had just replaced.
 *    (Residual: an edit that read the OLD tax rate before a save and writes after the commit lands at the old rate; the window is the
 *    few milliseconds between that edit's read and its write.)
 *  - HAND-PRICED items are left exactly as they are and listed (SystemEvent + the result). The book has no "hand priced" flag; the
 *    marker is the one billedRateChange.ts already uses - the stored price does not follow the book's formula (companyPrice or a sell
 *    column off by more than a cent). "Follows the formula" is judged at every rate a live writer could have priced the row at: the
 *    rate the book is recorded at, the rate now saved (already current), and the 9.75% fallback getSalesTaxRate answers while no rate
 *    is saved. An item edited or created in that gap is therefore repriced, never mislabelled hand-priced. Only a row that matches
 *    none of them is left alone. Nothing is guessed.
 *  - Every changed column is a PriceBookEdit row (editedBy "system:tax-reprice", a note naming the old and new rate).
 *  - Issued estimates and invoices are frozen documents and are never read or written here. Open DRAFT estimates carry no price
 *    (PriceBookDraftLine has no price column - the engine reads the live sell columns), so they follow the new prices by themselves;
 *    the result counts them.
 *  - Items with no cost (labour only) carry no tax and are not touched. Items with no stored sell (priced live at a supplier by the
 *    engine) get their stored cost-with-tax and companyPrice but no sell columns invented.
 *  - Assemblies are repriced from their STORED pre-tax rolled-up cost and stored hours - tax goes on once, to that cost; nothing is
 *    re-rolled and no component's tax-in cost or marked-up price is summed in. They are handled after the plain items.
 *  - Purchase orders and receipts keep adding tax at landing exactly as before (inventory.ts); this does not touch them.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { computePricing, loadMarkupTiers, sellsAtRate, type ComputedPricing } from "./priceBookCatalog";
import { loadBilledLaborRate } from "./laborRate";
import { isAssemblyRowType } from "./priceBookAssembly";
import { DEFAULT_SALES_TAX_RATE, readSavedSalesTaxRate } from "./purchasingSettings";
import { logSystemEvent } from "./systemEvents";
import { parseJsonObject } from "../lib/json";

/** Rate Config cell holding the sales tax rate the stored book is priced at. */
export const BOOK_TAX_CELL = "bookSalesTaxRate";
export const TAX_REPRICE_EDITOR = "system:tax-reprice";

const LOCK_KEY = 4_825_110_001; // arbitrary, fixed: serialises every tax reprice across instances
const PENNY = 0.011; // the tolerance billedRateChange.ts allows for the retired sheet's unrounded figures
const HAND_PRICED_LIST_CAP = 100;

const SELL_FIELDS = ["sellNormal", "sellDifficult", "sellVeryDifficult"] as const;
type SellField = (typeof SELL_FIELDS)[number];

interface Row {
  itemId: string;
  description: string | null;
  rowType: string | null;
  companyCost: number | null;
  companyCostWithTax: number | null;
  companyPrice: number | null;
  markupTier: string | null;
  laborNormal: number | null;
  laborDifficult: number | null;
  laborVeryDifficult: number | null;
  sellNormal: number | null;
  sellDifficult: number | null;
  sellVeryDifficult: number | null;
}

export interface TaxRepriceHandPriced {
  itemId: string;
  description: string | null;
  why: string;
}

export interface TaxRepriceResult {
  /** repriced: the book moved to the saved rate. current: it was already priced at that rate. skipped: an unusable saved rate. */
  status: "repriced" | "current" | "skipped_no_saved_rate";
  /** True when no rate had ever been saved, so the default 9.75% was saved as the setting by this run (Kyle: "default 9.75%"). */
  savedTheDefault?: boolean;
  /** The rate the book was priced at before this run (0 = no tax in it). */
  previousRate: number | null;
  /** The saved rate the book is priced at now (null when skipped). */
  newRate: number | null;
  /** Items whose stored prices changed (assemblies included). */
  itemsRepriced: number;
  assembliesRepriced: number;
  /** PriceBookEdit rows written (one per changed column). */
  editsWritten: number;
  /** Items left exactly as they were because their price does not follow the formula. Capped list + the full count. */
  handPriced: TaxRepriceHandPriced[];
  handPricedCount: number;
  /** Open draft estimates - they carry no price of their own, so they now read the new prices. */
  openDrafts: number;
}

const near = (a: number | null, b: number | null, tol: number) =>
  (a === null && b === null) || (a !== null && b !== null && Math.abs(a - b) <= tol);
const money = (n: number | null) => (n === null ? "-" : `$${n.toFixed(2)}`);
const pct = (r: number) => `${Math.round(r * 100_000) / 1000}%`;

/** The stored prices judged against the formula at the rate the book is recorded as priced at. Null = follows it. */
function handPricedReason(row: Row, computedAtOld: ComputedPricing, rate: number): string | null {
  if (!near(row.companyPrice, computedAtOld.companyPrice, PENNY)) {
    return `its marked-up price ${money(row.companyPrice)} is not its cost x the book's markup (${money(computedAtOld.companyPrice)})`;
  }
  if (SELL_FIELDS.some((f) => row[f] !== null)) {
    const atRate = sellsAtRate(row, rate);
    const off = SELL_FIELDS.filter((f) => !near(row[f], atRate[f], PENNY));
    if (off.length > 0) {
      return `its stored sells ${SELL_FIELDS.map((f) => money(row[f])).join(" / ")} are not hours x $${rate} + material (${SELL_FIELDS.map((f) => money(atRate[f])).join(" / ")})`;
    }
  }
  return null;
}

interface RowPlan {
  row: Row;
  assembly: boolean;
  data: Record<string, number | string | null>;
  audits: Array<{ field: string; oldValue: number | string | null; newValue: number | string | null }>;
}

/**
 * The whole job, inside the caller's transaction. Pure planning + writes; `saved` and `previous` are already decided.
 */
async function repriceRows(tx: Prisma.TransactionClient, previous: number, saved: number): Promise<{ plans: RowPlan[]; handPriced: TaxRepriceHandPriced[] }> {
  const db = tx as unknown as PrismaClient;
  const [tiers, rate] = await Promise.all([loadMarkupTiers(db), loadBilledLaborRate(db)]);
  const rows = (await tx.priceBookAtomic.findMany({
    orderBy: { itemId: "asc" },
    select: {
      itemId: true, description: true, rowType: true, companyCost: true, companyCostWithTax: true, companyPrice: true, markupTier: true,
      laborNormal: true, laborDifficult: true, laborVeryDifficult: true, sellNormal: true, sellDifficult: true, sellVeryDifficult: true,
    },
  })) as Row[];
  // Plain items first, assemblies after them (an assembly is priced from its own stored rolled-up cost, but the order is the stated one).
  const ordered = [...rows.filter((r) => !isAssemblyRowType(r.rowType)), ...rows.filter((r) => isAssemblyRowType(r.rowType))];

  const plans: RowPlan[] = [];
  const handPriced: TaxRepriceHandPriced[] = [];
  for (const row of ordered) {
    const assembly = isAssemblyRowType(row.rowType);
    // No cost to put tax on (labour only, or blank): the tax changes nothing about this row.
    if (row.companyCost === null || (row.rowType ?? "").toUpperCase().includes("LABOR ONLY")) continue;

    const input = {
      rowType: row.rowType, companyCost: row.companyCost,
      laborNormal: row.laborNormal, laborDifficult: row.laborDifficult, laborVeryDifficult: row.laborVeryDifficult,
    };
    // Priced by the formula at ANY rate a live writer used (see the header) -> a formula item. The reason shown is the one at the recorded rate.
    const candidates = [...new Set([previous, saved, DEFAULT_SALES_TAX_RATE])];
    const followsFormula = candidates.some((r) => handPricedReason(row, computePricing(input, tiers, rate, r), rate) === null);
    if (!followsFormula) {
      const why = handPricedReason(row, computePricing(input, tiers, rate, previous), rate)!;
      handPriced.push({ itemId: row.itemId, description: row.description, why });
      continue;
    }

    const next = computePricing(input, tiers, rate, saved);
    const hasSells = SELL_FIELDS.some((f) => row[f] !== null);
    const fields: Array<keyof ComputedPricing> = ["markupTier", "companyCostWithTax", "companyPrice", ...(hasSells ? SELL_FIELDS : [])];
    const data: RowPlan["data"] = {};
    const audits: RowPlan["audits"] = [];
    for (const f of fields) {
      const oldValue = (row as unknown as Record<string, number | string | null>)[f] ?? null;
      const newValue = (next[f as keyof ComputedPricing] as number | string | null) ?? null;
      const same = typeof newValue === "number" && typeof oldValue === "number" ? Math.abs(oldValue - newValue) < 0.0001 : oldValue === newValue;
      if (same) continue;
      data[f] = newValue;
      audits.push({ field: f, oldValue, newValue });
    }
    if (audits.length > 0) plans.push({ row, assembly, data, audits });
  }
  return { plans, handPriced };
}

/**
 * Bring the book to the saved sales tax rate, or report why it did not. Never throws on "nothing to do"; throws on a database failure
 * (the transaction rolled back, the book is exactly as it was) - callers log it and carry on.
 */
export async function repriceBookForTaxRate(
  prisma: PrismaClient,
  opts: {
    trigger: "startup" | "settings-save" | "test";
    /** The Settings -> Purchasing value (JSON text) to save INSIDE the same transaction - the save and the reprice commit together or not at all. */
    saveSetting?: string;
  },
): Promise<TaxRepriceResult> {
  const result = await prisma.$transaction(
    async (tx): Promise<TaxRepriceResult> => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK_KEY})`;
      if (opts.saveSetting !== undefined) {
        await tx.companySetting.upsert({
          where: { key: "purchasing" },
          update: { valueJson: opts.saveSetting },
          create: { key: "purchasing", valueJson: opts.saveSetting },
        });
      }

      const base: TaxRepriceResult = {
        status: "current", previousRate: null, newRate: null, itemsRepriced: 0, assembliesRepriced: 0, editsWritten: 0,
        handPriced: [], handPricedCount: 0, openDrafts: 0,
      };

      // Read AFTER the lock, so a racing run's commit is what this one sees.
      let saved = await readSavedSalesTaxRate(tx);
      let savedTheDefault = false;
      if (saved === null && opts.saveSetting === undefined) {
        // ABSENT (never saved) is not UNUSABLE (saved, but not a rate): only the first gets the default, saved in this very transaction.
        const row = await tx.companySetting.findUnique({ where: { key: "purchasing" } });
        const stored = row ? parseJsonObject<Record<string, unknown>>(row.valueJson) : {};
        const neverSaved = stored !== null && (stored.salesTaxRate === undefined || stored.salesTaxRate === null);
        if (!neverSaved) return { ...base, status: "skipped_no_saved_rate" };
        const valueJson = JSON.stringify({ ...stored, salesTaxRate: DEFAULT_SALES_TAX_RATE });
        await tx.companySetting.upsert({ where: { key: "purchasing" }, update: { valueJson }, create: { key: "purchasing", valueJson } });
        saved = DEFAULT_SALES_TAX_RATE;
        savedTheDefault = true;
      }
      if (saved === null) return { ...base, status: "skipped_no_saved_rate" };
      base.savedTheDefault = savedTheDefault;
      const cell = await tx.priceBookRateConfig.findUnique({ where: { key: BOOK_TAX_CELL } });
      const previous = cell?.numberValue ?? 0;
      if (Math.abs(saved - previous) < 1e-9) return { ...base, previousRate: previous, newRate: saved };

      // Item writers never take the advisory lock: block them (and any insert) until this commits, BEFORE the first row is read, so no
      // item is read, then edited by someone else, then overwritten from the stale read. Plain reads are not blocked.
      await tx.$executeRaw`LOCK TABLE "PriceBookAtomic" IN SHARE ROW EXCLUSIVE MODE`;
      const { plans, handPriced } = await repriceRows(tx, previous, saved);
      const note = `Sales tax ${pct(previous)} -> ${pct(saved)} in sell (sell = hours x shop rate + cost x (1 + tax) x markup; cost stays pre-tax) - ${opts.trigger === "startup" ? "automatic, on deploy" : opts.trigger === "settings-save" ? "automatic, tax rate saved in Settings" : "automatic"}.`;

      let editsWritten = 0;
      let edits: Prisma.PriceBookEditCreateManyInput[] = [];
      const flush = async () => {
        if (edits.length === 0) return;
        await tx.priceBookEdit.createMany({ data: edits });
        editsWritten += edits.length;
        edits = [];
      };
      for (const p of plans) {
        await tx.priceBookAtomic.update({ where: { itemId: p.row.itemId }, data: p.data });
        for (const a of p.audits) {
          edits.push({
            itemId: p.row.itemId, field: a.field,
            oldValue: a.oldValue === null ? null : String(a.oldValue),
            newValue: a.newValue === null ? null : String(a.newValue),
            editedBy: TAX_REPRICE_EDITOR, note,
          });
        }
        if (edits.length >= 1000) await flush();
      }
      await flush();

      // The recorded rate moves in the SAME transaction as the prices - never ahead of them, never behind.
      await tx.priceBookRateConfig.upsert({
        where: { key: BOOK_TAX_CELL },
        create: { key: BOOK_TAX_CELL, label: "Sales tax rate the price book is priced at", workbookRow: 0, numberValue: saved },
        update: { numberValue: saved },
      });

      const openDrafts = await tx.priceBookDraftEstimate.count({ where: { status: "draft" } });
      return {
        status: "repriced", previousRate: previous, newRate: saved, savedTheDefault,
        itemsRepriced: plans.length, assembliesRepriced: plans.filter((p) => p.assembly).length, editsWritten,
        handPriced: handPriced.slice(0, HAND_PRICED_LIST_CAP), handPricedCount: handPriced.length, openDrafts,
      };
    },
    { timeout: 300_000, maxWait: 60_000 },
  );

  if (result.status === "repriced") {
    logSystemEvent(
      "info", "priceBookTaxReprice",
      `Price book repriced for sales tax ${pct(result.previousRate ?? 0)} -> ${pct(result.newRate ?? 0)} (${opts.trigger}): ${result.itemsRepriced} item(s) repriced (${result.assembliesRepriced} assemblies), ${result.handPricedCount} hand-priced item(s) left alone.${result.savedTheDefault ? " No rate had been saved, so the default 9.75% was saved as the Settings -> Purchasing rate." : ""}`,
      { trigger: opts.trigger, itemsRepriced: result.itemsRepriced, editsWritten: result.editsWritten, openDrafts: result.openDrafts, handPricedCount: result.handPricedCount, handPriced: result.handPriced },
    );
  } else if (result.status === "skipped_no_saved_rate") {
    logSystemEvent(
      "warn", "priceBookTaxReprice",
      "Price book NOT repriced: Settings -> Purchasing holds a Sales tax rate that is not usable (unreadable, not a number, or a percent typed where a fraction belongs), so nothing was guessed. Save the rate again in Settings and the book reprices.",
      { trigger: opts.trigger },
    );
  }
  return result;
}
