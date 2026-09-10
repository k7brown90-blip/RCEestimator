/**
 * Job costing — the single source of truth for per-job P&L.
 *
 * Extracted from the inline rollup in GET /jobs so that endpoint and
 * GET /accounts/:id/summary can never disagree about what a job earned or cost.
 * Anything that reports money about a Visit goes through rollupJobCosts().
 */

import { prisma } from "../lib/prisma";

/** Fallback when the owner hasn't set a rate in company settings. */
export const DEFAULT_LABOR_RATE = 75;

export interface JobCosts {
  estimatedCost: number | null;
  materialCost: number;
  laborHours: number;
  laborRate: number;
  laborCost: number;
  overhead: number;
  totalCost: number;
  revenue: number | null;
  grossProfit: number | null;
  /** Whole percent, or null when there's no revenue to divide by. */
  margin: number | null;
  /**
   * Where materialCost came from (Kyle, 2026-09-08: the account page must say
   * whether a job's material is receipts or still the estimate's frozen figure;
   * 2026-09-09, Build 4: "stock" — consumed from a truck at its moving average).
   */
  materialSource: MaterialSource;
}

export type MaterialSource = "stock" | "receipts" | "estimate" | "none";

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * THE MATERIAL RULE (Kyle, 2026-09-09, Build 4 — "on future jobs I can label
 * some stock as truckstock and it won't double count the cost"). One place,
 * four rungs, first that fires wins:
 *
 *   1. stock     — the job has consume/return StockMovements: Σ consume − Σ return
 *                  at the truck's moving-average cost. The ledger is the truth;
 *                  nothing is stored on the visit for this.
 *   2. receipts  — Visit.actualMaterialCost > 0: confirmed materials receipts
 *                  that are NOT on a PO (services/receiptCosting.ts). A receipt on
 *                  a PO is inventory value, not job cost — the job pays by consuming.
 *   3. estimate  — the signed estimate's frozen taken-scope material.
 *   4. none      — nothing recorded anywhere.
 *
 * Legacy jobs closed before this build have no movements, so rung 2 keeps their
 * receipt figures exactly as they were (Daughdrill $381.90, Womack $406.74).
 */
export function resolveMaterialCost(
  stockMaterial: number | null,
  actualMaterialCost: number | null,
  estimatedMaterialCost: number | null,
): { materialCost: number; materialSource: MaterialSource } {
  if (stockMaterial != null) return { materialCost: round2(stockMaterial), materialSource: "stock" };
  // A POSITIVE typed actual wins. Production data shows the receipt/PO sync
  // stamps actualMaterialCost=0 on jobs with no receipts, so 0 means "nothing
  // recorded", not "cost nothing" - the signed estimate's frozen material is
  // the honest figure there too (Kyle's 2026-09-03 audit: six signed jobs all
  // blocked on actualMat=0).
  if (actualMaterialCost != null && actualMaterialCost > 0) return { materialCost: actualMaterialCost, materialSource: "receipts" };
  if (estimatedMaterialCost != null) return { materialCost: estimatedMaterialCost, materialSource: "estimate" };
  return { materialCost: actualMaterialCost ?? 0, materialSource: "none" };
}

/** What a job has drawn from truck stock, from the ledger. */
export interface StockMaterial {
  consumed: number;
  returned: number;
  /** consumed − returned, the figure the P&L charges. */
  net: number;
  /** Ledger rows behind it (consume, return, and corrections to either). */
  movementCount: number;
}

/**
 * The stock rung, per job, in ONE grouped query — never one query per job.
 * A job appears in the map only when it has at least one consume/return row
 * (a correction referencing one of those rows counts too: Kyle, "corrections
 * are new ledger rows referencing the original", so a corrected consume charges
 * the corrected quantity). Jobs with no rows are absent → the rung does not fire.
 */
export async function stockMaterialByJob(visitIds: string[]): Promise<Map<string, StockMaterial>> {
  const out = new Map<string, StockMaterial>();
  const ids = [...new Set(visitIds.filter(Boolean))];
  if (ids.length === 0) return out;
  const rows = await prisma.stockMovement.findMany({
    where: { jobId: { in: ids }, kind: { in: ["consume", "return", "correction"] } },
    select: { id: true, jobId: true, kind: true, qty: true, delta: true, unitCost: true, correctsId: true },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const r of rows) {
    if (!r.jobId) continue;
    let signedCost: number;
    if (r.kind === "consume") signedCost = r.qty * (r.unitCost ?? 0);
    else if (r.kind === "return") signedCost = -(r.qty * (r.unitCost ?? 0));
    else {
      // A correction adjusts the row it references. Its delta reads from the
      // receiving side (services/inventory.ts): on a consume (from a truck) a
      // +delta takes MORE off the truck → more charged; on a return (to a truck)
      // a +delta puts more back → more credited.
      const original = r.correctsId ? byId.get(r.correctsId) : undefined;
      if (!original || (original.kind !== "consume" && original.kind !== "return")) continue;
      const cost = r.unitCost ?? original.unitCost ?? 0;
      signedCost = (r.delta ?? 0) * cost * (original.kind === "consume" ? 1 : -1);
    }
    const row = out.get(r.jobId) ?? { consumed: 0, returned: 0, net: 0, movementCount: 0 };
    if (signedCost >= 0) row.consumed += signedCost; else row.returned += -signedCost;
    row.movementCount += 1;
    out.set(r.jobId, row);
  }
  for (const row of out.values()) {
    row.consumed = round2(row.consumed);
    row.returned = round2(row.returned);
    row.net = round2(row.consumed - row.returned);
  }
  return out;
}

export interface MaterialCostInput {
  visitId: string;
  /** Other visits whose costs roll onto this job (the P&L chain) — their movements count here. */
  chainVisitIds?: string[];
  actualMaterialCost: number | null;
  estimatedMaterialCost: number | null;
}

export interface MaterialCostResult {
  materialCost: number;
  materialSource: MaterialSource;
  /** The stock rung's figure, or null when the job has no consume/return rows. */
  stockMaterial: number | null;
  stock: StockMaterial | null;
}

/**
 * The one helper every money surface calls (GET /jobs, the account summary,
 * /financials/job-profitability): the grouped stock query plus the fallbacks,
 * per job. Feed the `stockMaterial` it returns into rollupJobCosts so the card
 * and the report can never disagree.
 */
export async function materialCostForJobs(jobs: MaterialCostInput[]): Promise<Map<string, MaterialCostResult>> {
  const allIds = jobs.flatMap((j) => [j.visitId, ...(j.chainVisitIds ?? [])]);
  const stockByVisit = await stockMaterialByJob(allIds);
  const out = new Map<string, MaterialCostResult>();
  for (const job of jobs) {
    const parts = [job.visitId, ...(job.chainVisitIds ?? [])]
      .map((id) => stockByVisit.get(id))
      .filter((s): s is StockMaterial => Boolean(s));
    const stock: StockMaterial | null = parts.length === 0
      ? null
      : {
        consumed: round2(parts.reduce((s, p) => s + p.consumed, 0)),
        returned: round2(parts.reduce((s, p) => s + p.returned, 0)),
        net: round2(parts.reduce((s, p) => s + p.net, 0)),
        movementCount: parts.reduce((s, p) => s + p.movementCount, 0),
      };
    const stockMaterial = stock ? stock.net : null;
    out.set(job.visitId, { ...resolveMaterialCost(stockMaterial, job.actualMaterialCost, job.estimatedMaterialCost), stockMaterial, stock });
  }
  return out;
}

/** The Visit fields the rollup actually reads — keeps callers from over-selecting. */
export interface CostableVisit {
  estimatedCost: number | null;
  actualMaterialCost: number | null;
  laborHours: number | null;
  overheadAllocation: number | null;
  revenue: number | null;
}

/**
 * A job's cost chain (Kyle, 2026-09-02: "no cost revenue or profit" — the P&L
 * merge). Hours clocked and materials bought on the ORIGINAL appointment visit
 * belong to the sold job that came out of it. The chain is defined by the
 * issued estimate, which names both visits (visitId = where it was quoted,
 * jobVisitId = the sold job). Costs sum onto the job; the child visit's card
 * reports that its costs rolled up, and lifetime totals count everything once.
 */
export function mergeCostableChain(job: CostableVisit, children: CostableVisit[]): CostableVisit {
  return {
    estimatedCost: job.estimatedCost,
    revenue: job.revenue,
    // Nullness is information: "no actuals recorded anywhere on the chain" must
    // survive the merge so the estimate-material fallback below can fire. A
    // chain where nobody typed a cost is null, not $0.
    actualMaterialCost:
      job.actualMaterialCost === null && children.every((c) => c.actualMaterialCost === null)
        ? null
        : (job.actualMaterialCost ?? 0) + children.reduce((s, c) => s + (c.actualMaterialCost ?? 0), 0),
    laborHours: (job.laborHours ?? 0) + children.reduce((s, c) => s + (c.laborHours ?? 0), 0),
    overheadAllocation:
      (job.overheadAllocation ?? 0) + children.reduce((s, c) => s + (c.overheadAllocation ?? 0), 0),
  };
}

/** The child's own card after a merge: costs live on the job now. */
export const ROLLED_UP_COSTS: CostableVisit = {
  estimatedCost: null, actualMaterialCost: 0, laborHours: 0, overheadAllocation: 0, revenue: null,
};

/**
 * Revenue precedence: an explicitly recorded Visit.revenue always wins, because
 * that's the number someone typed after the job closed. Falling back to the
 * accepted estimate option keeps in-flight jobs showing an expected value.
 */
export function rollupJobCosts(
  visit: CostableVisit,
  acceptedOptionTotal: number | null,
  laborRate: number = DEFAULT_LABOR_RATE,
  /**
   * Material cost frozen on the signed estimate's taken lines (Kyle,
   * 2026-09-03: "completed jobs have not calculated the material costs that
   * are on the invoice/estimates"). Typed actuals always win; this fills the
   * gap when nobody recorded actuals on a job sold through an issued estimate.
   */
  estimatedMaterialCost: number | null = null,
  /**
   * The stock rung (Kyle, 2026-09-09, Build 4): consume − return from the ledger,
   * from materialCostForJobs(). Null when the job has drawn nothing from a truck,
   * and then the receipt and estimate rungs apply exactly as before.
   */
  stockMaterial: number | null = null,
): JobCosts {
  const revenue = visit.revenue ?? acceptedOptionTotal ?? null;
  const { materialCost, materialSource } = resolveMaterialCost(stockMaterial, visit.actualMaterialCost, estimatedMaterialCost);
  const laborHours = visit.laborHours ?? 0;
  const laborCost = laborHours * laborRate;
  const overhead = visit.overheadAllocation ?? 0;
  const totalCost = materialCost + laborCost + overhead;

  return {
    estimatedCost: visit.estimatedCost,
    materialCost,
    laborHours,
    laborRate,
    laborCost,
    overhead,
    totalCost,
    revenue,
    grossProfit: revenue != null ? revenue - totalCost : null,
    margin:
      revenue != null && revenue > 0
        ? Math.round(((revenue - totalCost) / revenue) * 100)
        : null,
    materialSource,
  };
}

/**
 * Read the shop labor rate from CompanySetting.companyProfile.
 * Tolerant by design: a malformed or missing setting must not break the Jobs
 * tab, so anything unparseable falls through to the default.
 */
export async function getLaborRate(): Promise<number> {
  const row = await prisma.companySetting.findUnique({ where: { key: "companyProfile" } });
  if (!row) return DEFAULT_LABOR_RATE;
  try {
    const profile = JSON.parse(row.valueJson) as { laborRate?: unknown };
    const rate = Number(profile?.laborRate);
    return Number.isFinite(rate) && rate > 0 ? rate : DEFAULT_LABOR_RATE;
  } catch {
    return DEFAULT_LABOR_RATE;
  }
}

/** Sum a set of job rollups into account-level lifetime totals. */
export function sumJobCosts(costs: JobCosts[]): {
  lifetimeRevenue: number;
  lifetimeCost: number;
  lifetimeProfit: number;
  lifetimeMargin: number | null;
} {
  const lifetimeRevenue = costs.reduce((sum, c) => sum + (c.revenue ?? 0), 0);
  const lifetimeCost = costs.reduce((sum, c) => sum + c.totalCost, 0);
  const lifetimeProfit = lifetimeRevenue - lifetimeCost;
  return {
    lifetimeRevenue,
    lifetimeCost,
    lifetimeProfit,
    lifetimeMargin:
      lifetimeRevenue > 0 ? Math.round((lifetimeProfit / lifetimeRevenue) * 100) : null,
  };
}

/**
 * Material cost of a signed issued estimate at TAKEN scope — the same lines
 * the invoice bills (selected options; every line when no selection was made).
 * Null when no line carries a cost, so callers can tell "unknown" from $0.
 */
export function estimateMaterialCost(est: {
  selectedOptions: string[];
  lines: Array<{ option: string; materialCost: number | null }>;
}): number | null {
  const taken = new Set(est.selectedOptions.map(String));
  const lines = taken.size > 0 ? est.lines.filter((l) => taken.has(String(l.option))) : est.lines;
  const costs = lines.map((l) => l.materialCost).filter((v): v is number => v != null);
  if (costs.length === 0) return null;
  return Math.round(costs.reduce((s, v) => s + v, 0) * 100) / 100;
}

/**
 * Pick the total to credit a job with from its estimate options: the accepted
 * option if one exists, otherwise the highest-priced option on the table.
 */
export function estimateOptionTotal(
  options: { accepted: boolean; totalCost: number }[],
): { acceptedTotal: number | null; displayTotal: number | null } {
  const accepted = options.find((o) => o.accepted) ?? null;
  let highest: { totalCost: number } | null = null;
  for (const option of options) {
    if (!highest || option.totalCost > highest.totalCost) highest = option;
  }
  return {
    acceptedTotal: accepted?.totalCost ?? null,
    displayTotal: accepted?.totalCost ?? highest?.totalCost ?? null,
  };
}
