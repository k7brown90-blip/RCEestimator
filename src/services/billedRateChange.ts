/**
 * Change the billed labour rate across the whole book — the ONE implementation.
 *
 * Kyle, 2026-10-27: "I want to be able to edit the chosen hourly rate in the app. This way we do not
 * need to code everytime we need to update." Then: "I want it to stay $100 for now. I just want the
 * ability to edit it so I can update the price book with our hourly rate when needed."
 *
 * This is the core of scripts/setLaborRate.ts (Kyle, 2026-09-01: "I want to drop the labor rate to
 * $100 an hour"), moved here so the Settings screen and the script call the same code. Nothing in
 * this file chooses a rate: the rate is whatever Kyle types, and nothing here runs on its own.
 *
 * The rate is one number that lives in three places, and they move together or the book
 * contradicts itself:
 *
 *   1. Rate Config `billedLaborRate` — what the engine bills supplier-priced labour at, and how it
 *      splits a flat-priced row into its internal labour + material halves.
 *   2. Every priced row's sell columns — sell_d = hours_d × rate + material, the book's own
 *      formula (priceBookCatalog.sellsAtRate). Material is not touched: cost, tier and marked-up
 *      material stay exactly as they are. Each changed column is a PriceBookEdit row, so any price a
 *      customer asks about still has its story.
 *   3. Open drafts' rate snapshot (status "draft") — informational, kept honest so the builder does
 *      not show a stale rate beside prices built at the new one.
 *
 * Issued estimates (IssuedEstimate / IssuedEstimateLine) are frozen and never read or written here:
 * a sent price stays sent.
 *
 * Safety: before writing anything, every row is recomputed at the CURRENT rate and compared with
 * what is stored. The 2026-09-01 dry run against the real book showed these shapes:
 *
 *   FORMULA    Matches hours × rate + material to the cent.
 *   PENNY      The retired sheet stored material unrounded (e.g. $25.975) and summed before
 *              rounding; the import kept the sheet's cents. Off by ≤ $0.01. Rewritten rounded.
 *   RATE-AS-MATERIAL
 *              The sheet's `=B*F` rows (Diagnostics, Circuit tracing, Demolition): labour-only work
 *              whose "material" column holds the hourly rate itself, so cost is null, companyPrice
 *              == the old rate and sell == hours × rate exactly. Left alone, the plain formula would
 *              bill the new rate + the old rate as "material". These were converted to LABOR ONLY
 *              (companyPrice null) on 2026-09-01; a row still in this shape is converted now. A row
 *              already converted is plain FORMULA — it is never converted twice.
 *   PER-DOLLAR Kyle's in-app GENERAL LABOR unit: 1/rate hr per unit so that one unit is $1.00 and he
 *              types dollars as the quantity. Kept at $1.00/unit by setting the hours to 1/newRate.
 *   OTHER      Anything else — a hand-set or broken number that must not be silently overwritten.
 *              On the screen these rows are LEFT UNTOUCHED and listed with the reason; the rest of
 *              the book still changes. (The CLI keeps its old rule: --apply refuses while any exist
 *              unless --force, which is `includeOther`.)
 *
 * ASSEMBLY rows (rowType ASSEMBLY) carry sell columns written by the same formula
 * (priceBookAssembly -> computePricing -> sellsAtRate, with the assembly's own stored companyPrice
 * and hours). They are repriced here through that same formula when they match it, and left alone
 * and listed (OTHER) when they do not. The old script skipped them and told the operator to re-save
 * each one by hand; with no operator at a terminal that would leave their prices stale at the old
 * rate with nothing on screen to say so.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { sellsAtRate } from "./priceBookCatalog";
import { isAssemblyRowType } from "./priceBookAssembly";

type Db = PrismaClient | Prisma.TransactionClient;

export const MAX_BILLED_RATE = 1000;

const SELL_FIELDS = ["sellNormal", "sellDifficult", "sellVeryDifficult"] as const;
const HOUR_FIELDS = ["laborNormal", "laborDifficult", "laborVeryDifficult"] as const;
type SellField = (typeof SELL_FIELDS)[number];
type Field = SellField | (typeof HOUR_FIELDS)[number] | "rowType" | "companyPrice";

const PENNY = 0.011;
const round2 = (n: number) => Math.round(n * 100) / 100;
const money = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `$${n.toFixed(2)}`);
const near = (a: number | null, b: number | null, tol: number) =>
  (a === null && b === null) || (a !== null && b !== null && Math.abs(a - b) <= tol);

/** Why a typed rate is not acceptable, or null. Used by the routes (as a zod refinement) and the script. */
export function billedRateProblem(rate: unknown): string | null {
  if (typeof rate !== "number" || !Number.isFinite(rate)) return "Enter the rate as a number, e.g. 100 or 112.50.";
  if (rate <= 0) return "The billed rate must be more than $0.";
  if (rate > MAX_BILLED_RATE) return `The billed rate cannot be more than $${MAX_BILLED_RATE.toLocaleString("en-US")} an hour.`;
  if (Math.abs(round2(rate) - rate) > 1e-9) return "Use dollars and cents only (two decimal places at most).";
  return null;
}

function assertRate(rate: number): void {
  const problem = billedRateProblem(rate);
  if (problem) throw new Error(problem);
}

interface Row {
  itemId: string;
  description: string | null;
  source: string | null;
  rowType: string | null;
  companyCost: number | null;
  companyPrice: number | null;
  laborNormal: number | null;
  laborDifficult: number | null;
  laborVeryDifficult: number | null;
  sellNormal: number | null;
  sellDifficult: number | null;
  sellVeryDifficult: number | null;
}

export type BilledRateShape = "FORMULA" | "PENNY" | "RATE-AS-MATERIAL" | "PER-DOLLAR" | "OTHER";
interface Audit { field: Field; oldValue: string | number | null; newValue: string | number | null }
interface Plan { row: Row; shape: BilledRateShape; assembly: boolean; audits: Audit[]; detail: string }

/** Which of the known shapes a stored row is, judged against the formula at the OLD rate. */
function classify(r: Row, oldRate: number | null): { shape: BilledRateShape; detail: string } {
  if (oldRate === null) return { shape: "OTHER", detail: "the price book has no current hourly rate to check this row against" };
  const type = (r.rowType ?? "").toUpperCase();

  // Checked FIRST: a per-dollar unit also satisfies the plain formula at the old rate
  // (1/150 hr × $150 = $1.00), and the formula at the new rate would quietly turn it into $0.67.
  const perDollar =
    type.includes("LABOR ONLY") &&
    HOUR_FIELDS.every((f) => r[f] !== null && Math.abs((r[f] as number) * oldRate - 1) < 0.001) &&
    SELL_FIELDS.every((f) => near(r[f], 1, 0.0051));
  if (perDollar) return { shape: "PER-DOLLAR", detail: `hours = 1/${oldRate} so one unit is $1.00` };

  const atOld = sellsAtRate(r, oldRate);
  const diffs = SELL_FIELDS.map((f) => (r[f] === null || atOld[f] === null ? (r[f] === atOld[f] ? 0 : Infinity) : Math.abs((r[f] as number) - (atOld[f] as number))));
  const worst = Math.max(...diffs);
  if (worst <= 0.0051) return { shape: "FORMULA", detail: "" };
  if (worst <= PENNY) return { shape: "PENNY", detail: "off by ≤ $0.01 (sheet summed before rounding)" };

  const rateAsMaterial =
    r.companyCost === null &&
    r.companyPrice !== null && near(r.companyPrice, oldRate, 0.0051) &&
    !type.includes("LABOR ONLY") && !type.includes("MATERIAL ONLY") &&
    SELL_FIELDS.every((f, i) => r[f] === null ? r[HOUR_FIELDS[i]] === null : r[HOUR_FIELDS[i]] !== null && near(r[f], round2((r[HOUR_FIELDS[i]] as number) * oldRate), PENNY));
  if (rateAsMaterial) return { shape: "RATE-AS-MATERIAL", detail: `companyPrice ${money(r.companyPrice)} is the old rate; sells = hours × rate exactly` };

  return {
    shape: "OTHER",
    detail: `stored sells ${SELL_FIELDS.map((f) => money(r[f])).join(" / ")} do not match hours × $${oldRate} + material (${SELL_FIELDS.map((f) => money(atOld[f])).join(" / ")}); it looks hand-set`,
  };
}

function auditsFor(r: Row, shape: BilledRateShape, newRate: number): Audit[] {
  const audits: Audit[] = [];
  const setSells = (next: Record<SellField, number | null>) => {
    for (const f of SELL_FIELDS) if (!near(r[f], next[f], 0.0001)) audits.push({ field: f, oldValue: r[f], newValue: next[f] });
  };
  switch (shape) {
    case "RATE-AS-MATERIAL": {
      audits.push({ field: "rowType", oldValue: r.rowType, newValue: "LABOR ONLY" });
      audits.push({ field: "companyPrice", oldValue: r.companyPrice, newValue: null });
      setSells(sellsAtRate({ ...r, rowType: "LABOR ONLY", companyPrice: null }, newRate));
      return audits;
    }
    case "PER-DOLLAR": {
      const hours = Number((1 / newRate).toFixed(7));
      for (const f of HOUR_FIELDS) if (!near(r[f], hours, 1e-9)) audits.push({ field: f, oldValue: r[f], newValue: hours });
      // 1/newRate × newRate is $1.00 by construction; write it as such rather than trust float dust.
      setSells({ sellNormal: 1, sellDifficult: 1, sellVeryDifficult: 1 });
      return audits;
    }
    case "FORMULA":
    case "PENNY":
    case "OTHER": {
      setSells(sellsAtRate(r, newRate));
      return audits;
    }
  }
}

async function currentRateOf(db: Db): Promise<{ rate: number | null; exists: boolean }> {
  const cell = await db.priceBookRateConfig.findUnique({ where: { key: "billedLaborRate" } });
  return { rate: cell?.numberValue ?? null, exists: !!cell };
}

/** Every row, judged against the current rate, and what each would become at `newRate`. */
async function buildPlans(db: Db, oldRate: number | null, newRate: number, includeOther: boolean): Promise<{ plans: Plan[]; rowsInBook: number }> {
  const rows = (await db.priceBookAtomic.findMany({
    orderBy: { itemId: "asc" },
    select: {
      itemId: true, description: true, source: true, rowType: true, companyCost: true, companyPrice: true,
      laborNormal: true, laborDifficult: true, laborVeryDifficult: true,
      sellNormal: true, sellDifficult: true, sellVeryDifficult: true,
    },
  })) as Row[];

  const plans: Plan[] = [];
  for (const row of rows) {
    if (!SELL_FIELDS.some((f) => row[f] !== null)) continue; // supplier-priced: the engine bills at the cell, nothing stored to move
    const assembly = isAssemblyRowType(row.rowType);
    let { shape, detail } = classify(row, oldRate);
    // An assembly is only ever the plain formula: the labour-only conversions belong to the sheet's
    // own rows. Anything else about it is not understood, so it is left alone and listed.
    if (assembly && (shape === "PER-DOLLAR" || shape === "RATE-AS-MATERIAL")) {
      shape = "OTHER";
      detail = "an assembly whose sells do not follow the plain hours × rate + material formula";
    }
    const untouched = shape === "OTHER" && !includeOther;
    plans.push({ row, shape, assembly, detail, audits: untouched ? [] : auditsFor(row, shape, newRate) });
  }
  return { plans, rowsInBook: rows.length };
}

// ─── Preview (read-only) ─────────────────────────────────────────────────────────────────────

export interface BilledRateSample {
  itemId: string;
  description: string | null;
  /** Each tier: null when that tier's price does not change. */
  normal: { from: number | null; to: number | null } | null;
  difficult: { from: number | null; to: number | null } | null;
  veryDifficult: { from: number | null; to: number | null } | null;
}

export interface BilledRateUntouched {
  itemId: string;
  description: string | null;
  why: string;
}

export interface BilledRatePreview {
  /** The rate in the price book now; null when the cell is blank. */
  currentRate: number | null;
  newRate: number;
  rowsInBook: number;
  /** Rows whose sell prices (or, for a per-dollar unit, hours) change. */
  repriceCount: number;
  /** Rows carrying sell prices that need no change (e.g. material-only rows). */
  unchangedCount: number;
  /** How many of the repriced rows are assemblies. */
  assemblyCount: number;
  /** Rows that are converted to labour-only / kept at $1.00 a unit, with their ids. */
  convertedRows: { itemId: string; description: string | null; kind: "RATE-AS-MATERIAL" | "PER-DOLLAR" }[];
  samples: BilledRateSample[];
  /** Rows the change will NOT touch (hand-set or unexplained prices), and why. Capped at 100. */
  untouched: BilledRateUntouched[];
  untouchedCount: number;
  openDrafts: number;
}

const SAMPLE_COUNT = 8;
const UNTOUCHED_LIST_CAP = 100;

function describePlans(plans: Plan[], includeOther: boolean) {
  const changing = plans.filter((p) => p.audits.length > 0);
  const untouched = plans.filter((p) => p.shape === "OTHER" && !includeOther);
  const cellOf = (p: Plan, f: SellField) => {
    const a = p.audits.find((x) => x.field === f);
    return a ? { from: a.oldValue as number | null, to: a.newValue as number | null } : null;
  };
  // Evenly spaced through the book rather than the first few — the first few are all one category.
  const picks = changing.length <= SAMPLE_COUNT
    ? changing
    : Array.from({ length: SAMPLE_COUNT }, (_, i) => changing[Math.floor((i * (changing.length - 1)) / (SAMPLE_COUNT - 1))]);
  const samples: BilledRateSample[] = picks.map((p) => ({
    itemId: p.row.itemId,
    description: p.row.description,
    normal: cellOf(p, "sellNormal"),
    difficult: cellOf(p, "sellDifficult"),
    veryDifficult: cellOf(p, "sellVeryDifficult"),
  }));
  return { changing, untouched, samples };
}

/** Read-only. Writes nothing, anywhere. */
export async function previewBilledRate(prisma: PrismaClient, rate: number, opts: { includeOther?: boolean } = {}): Promise<BilledRatePreview> {
  assertRate(rate);
  const includeOther = opts.includeOther === true;
  const { rate: currentRate } = await currentRateOf(prisma);
  const { plans, rowsInBook } = await buildPlans(prisma, currentRate, rate, includeOther);
  const { changing, untouched, samples } = describePlans(plans, includeOther);
  const openDrafts = await prisma.priceBookDraftEstimate.count({ where: { status: "draft" } });
  return {
    currentRate,
    newRate: rate,
    rowsInBook,
    repriceCount: changing.length,
    unchangedCount: plans.length - changing.length - untouched.length,
    assemblyCount: changing.filter((p) => p.assembly).length,
    convertedRows: plans
      .filter((p) => p.shape === "RATE-AS-MATERIAL" || p.shape === "PER-DOLLAR")
      .map((p) => ({ itemId: p.row.itemId, description: p.row.description, kind: p.shape as "RATE-AS-MATERIAL" | "PER-DOLLAR" })),
    samples,
    untouched: untouched.slice(0, UNTOUCHED_LIST_CAP).map((p) => ({ itemId: p.row.itemId, description: p.row.description, why: p.detail })),
    untouchedCount: untouched.length,
    openDrafts,
  };
}

// ─── Apply (one transaction) ─────────────────────────────────────────────────────────────────

export interface BilledRateApplied {
  previousRate: number | null;
  newRate: number;
  rowsUpdated: number;
  /** PriceBookEdit rows written (one per changed column). */
  editsWritten: number;
  /** Rows left exactly as they were because their prices are hand-set or unexplained. */
  untouched: BilledRateUntouched[];
  untouchedCount: number;
  draftsResnapshotted: number;
}

function noteFor(shape: BilledRateShape, oldRate: number | null, newRate: number): string {
  const base = `Billed labour rate $${oldRate ?? "?"} → $${newRate}/hr (sell = hours × rate + material; material unchanged).`;
  switch (shape) {
    case "RATE-AS-MATERIAL": return `${base} This row was the sheet's =B*F shape — labour-only with the hourly rate in its material column — converted to LABOR ONLY so it bills hours × rate.`;
    case "PER-DOLLAR": return `${base} Per-dollar labour unit: hours set to 1/${newRate} so one unit stays $1.00.`;
    case "PENNY": return `${base} Stored value was the sheet's unrounded figure; now rounded to cents.`;
    default: return base;
  }
}

/**
 * Write the new rate everywhere it lives, in ONE transaction: if anything fails, nothing moved and
 * the cell, the sells and the draft snapshots still agree with each other.
 */
export async function applyBilledRate(
  prisma: PrismaClient,
  rate: number,
  editedBy: string,
  opts: { includeOther?: boolean } = {},
): Promise<BilledRateApplied> {
  assertRate(rate);
  const includeOther = opts.includeOther === true;

  return prisma.$transaction(
    async (tx) => {
      // Re-read inside the transaction so the plan is judged against the rate that is really there now.
      const { rate: oldRate, exists } = await currentRateOf(tx);
      const { plans } = await buildPlans(tx, oldRate, rate, includeOther);
      const { changing, untouched } = describePlans(plans, includeOther);

      if (exists) {
        await tx.priceBookRateConfig.update({ where: { key: "billedLaborRate" }, data: { numberValue: rate } });
      } else {
        await tx.priceBookRateConfig.create({
          data: { key: "billedLaborRate", label: "Billed labor rate ($/hr)", workbookRow: 2, numberValue: rate },
        });
      }

      const edits: Prisma.PriceBookEditCreateManyInput[] = [];
      for (const p of changing) {
        const data: Record<string, unknown> = {};
        for (const a of p.audits) data[a.field] = a.newValue;
        await tx.priceBookAtomic.update({ where: { itemId: p.row.itemId }, data });
        const note = noteFor(p.shape, oldRate, rate);
        for (const a of p.audits) {
          edits.push({
            itemId: p.row.itemId,
            field: a.field,
            oldValue: a.oldValue === null ? null : String(a.oldValue),
            newValue: a.newValue === null ? null : String(a.newValue),
            editedBy,
            note,
          });
        }
      }
      if (edits.length > 0) await tx.priceBookEdit.createMany({ data: edits });

      // Open drafts only; a finalized draft keeps the rate it was finalized at. The snapshot is
      // informational — the rate Kyle saves IS the ruling, so nothing here is "provisional".
      const drafts = await tx.priceBookDraftEstimate.updateMany({
        where: { status: "draft" },
        data: { billedLaborRate: rate, rateProvisional: false, provisionalReason: null },
      });

      return {
        previousRate: oldRate,
        newRate: rate,
        rowsUpdated: changing.length,
        editsWritten: edits.length,
        untouched: untouched.slice(0, UNTOUCHED_LIST_CAP).map((p) => ({ itemId: p.row.itemId, description: p.row.description, why: p.detail })),
        untouchedCount: untouched.length,
        draftsResnapshotted: drafts.count,
      };
    },
    { timeout: 120_000, maxWait: 15_000 },
  );
}
