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
): JobCosts {
  const revenue = visit.revenue ?? acceptedOptionTotal ?? null;
  // A POSITIVE typed actual wins. Production data shows the receipt/PO sync
  // stamps actualMaterialCost=0 on jobs with no receipts, so 0 means "nothing
  // recorded", not "cost nothing" - the signed estimate's frozen material is
  // the honest figure there too (Kyle's 2026-09-03 audit: six signed jobs all
  // blocked on actualMat=0).
  const actual = visit.actualMaterialCost;
  const materialCost = actual != null && actual > 0 ? actual : estimatedMaterialCost ?? actual ?? 0;
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
