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
 * Revenue precedence: an explicitly recorded Visit.revenue always wins, because
 * that's the number someone typed after the job closed. Falling back to the
 * accepted estimate option keeps in-flight jobs showing an expected value.
 */
export function rollupJobCosts(
  visit: CostableVisit,
  acceptedOptionTotal: number | null,
  laborRate: number = DEFAULT_LABOR_RATE,
): JobCosts {
  const revenue = visit.revenue ?? acceptedOptionTotal ?? null;
  const materialCost = visit.actualMaterialCost ?? 0;
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
