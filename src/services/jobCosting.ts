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
   * Where materialCost came from: "po" — the money on the P.O.s tagged to this
   * job (Kyle, 2026-09-19); "none" — no P.O. on the job carries any money.
   */
  materialSource: MaterialSource;
}

export type MaterialSource = "po" | "none";

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * THE MATERIAL RULE (Kyle, 2026-09-19, "the P.O. is the money"): THE CHARGE IS
 * THE MONEY, THE RECEIPT IS PROOF. A job's material cost is the money on the
 * P.O.s tagged to it —
 *
 *   card    — Σ non-ignored CardSpend rows on those P.O.s (refunds negative), and
 *   typed   — Σ PurchaseOrder.offCardAmount, the amount Kyle typed when a
 *             purchase was not on the card (cash, check, personal card).
 *
 * Not receipts (Receipt.amount feeds nothing financial), not the signed
 * estimate (an estimate stays an estimate), not stock consumption (the
 * inventory ledger says what is on the truck; it no longer decides job cost —
 * a restock P.O. with no job is overhead until a P.O. names a job). P.O. status
 * does not gate the money: a charge on a cancelled P.O. still happened; the only
 * way a charge stops counting is status "ignored" with a reason.
 *
 * Kind still matters: only MATERIAL money is material. A permit or inspection
 * charge on the job's P.O. is a job FEE (services/timeTracking.ts, the
 * commission math) and must not be counted here too; fuel and maintenance are
 * truck overhead; tools never enter job cost (a tool P.O.'s typed amount is
 * overhead as well).
 *
 * Before 2026-09-19 this was four rungs (stock, receipts, estimate, none) and a
 * penny-and-three-day matcher decided which of receipt and charge to count —
 * the 9/17 Home Depot split ($651.73 + $114.01 against one $765.74 receipt)
 * counted both. The migration of that day moved every receipt-rung figure onto
 * a P.O. so no closed job's number went to zero.
 */
export function resolveMaterialCost(poMaterial: number | null): { materialCost: number; materialSource: MaterialSource } {
  if (poMaterial != null) return { materialCost: round2(poMaterial), materialSource: "po" };
  return { materialCost: 0, materialSource: "none" };
}

/** CardSpend kinds that are material money. "other" is an unkinded supplier swipe until Kyle re-kinds it. */
export const MATERIAL_SPEND_KINDS = ["materials", "other"] as const;

/** What a job's P.O.s carry, from the money itself. */
export interface PoMaterial {
  /** Σ non-ignored card charges on the job's P.O.s (a refund subtracts). */
  card: number;
  /** Σ typed not-on-card amounts on the job's P.O.s. */
  typed: number;
  /** card + typed — the figure the P&L charges. */
  net: number;
  /** P.O.s tagged to the job that carry any money. */
  poCount: number;
}

/**
 * The money rung, per job, in ONE grouped query — never one query per job. A
 * job appears in the map only when a P.O. tagged to it carries money (a charge
 * or a typed amount); jobs with none are absent → the rung does not fire.
 */
export async function poMaterialByJob(visitIds: string[]): Promise<Map<string, PoMaterial>> {
  const out = new Map<string, PoMaterial>();
  const ids = [...new Set(visitIds.filter(Boolean))];
  if (ids.length === 0) return out;
  const orders = await prisma.purchaseOrder.findMany({
    where: { jobId: { in: ids } },
    select: {
      jobId: true,
      purpose: true,
      offCardAmount: true,
      cardSpends: { where: { status: { not: "ignored" }, kind: { in: [...MATERIAL_SPEND_KINDS] } }, select: { amount: true } },
    },
  });
  for (const po of orders) {
    if (!po.jobId) continue;
    const card = po.cardSpends.reduce((s, c) => s + c.amount, 0);
    const typed = po.purpose === "tool" ? null : po.offCardAmount;
    if (po.cardSpends.length === 0 && typed == null) continue;
    const row = out.get(po.jobId) ?? { card: 0, typed: 0, net: 0, poCount: 0 };
    row.card += card;
    row.typed += typed ?? 0;
    row.poCount += 1;
    out.set(po.jobId, row);
  }
  for (const row of out.values()) {
    row.card = round2(row.card);
    row.typed = round2(row.typed);
    row.net = round2(row.card + row.typed);
  }
  return out;
}

/**
 * What a job has drawn from truck stock, from the ledger. INVENTORY, NOT COST
 * since 2026-09-19: the materials panel shows it so the truck count can be
 * trusted, but nothing adds it to the job's material figure.
 */
export interface StockMaterial {
  consumed: number;
  returned: number;
  /** consumed − returned. */
  net: number;
  /** Ledger rows behind it (consume, return, and corrections to either). */
  movementCount: number;
}

/**
 * Per job, in ONE grouped query. A job appears in the map only when it has at
 * least one consume/return row (a correction referencing one of those rows
 * counts too: Kyle, "corrections are new ledger rows referencing the original").
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
      // +delta takes MORE off the truck; on a return (to a truck) a +delta puts
      // more back.
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
  /**
   * Other visits whose costs roll onto this job (the P&L chain) — their P.O.s
   * count here. The signed estimate's quote visit is added automatically (see
   * materialCostForJobs), so callers only pass what they already know.
   */
  chainVisitIds?: string[];
}

export interface MaterialCostResult {
  materialCost: number;
  materialSource: MaterialSource;
  /** The money rung's figure, or null when no P.O. on the job carries money. */
  poMaterial: number | null;
  po: PoMaterial | null;
}

/**
 * The one helper every money surface calls (GET /jobs, the account summary,
 * /financials/job-profitability, the commission basis, the materials panel):
 * the grouped money query per job. Feed the `poMaterial` it returns into
 * rollupJobCosts so the card and the report can never disagree.
 *
 * The chain (Kyle, 2026-09-02): a P.O. opened on the appointment a job was
 * quoted on belongs to the sold job. The signed estimate names both visits
 * (visitId = where it was quoted, jobVisitId = the sold job), so every job
 * here also reads the P.O.s on its quote visit — without each caller having to
 * know the chain.
 */
export async function materialCostForJobs(jobs: MaterialCostInput[]): Promise<Map<string, MaterialCostResult>> {
  const jobIds = [...new Set(jobs.map((j) => j.visitId).filter(Boolean))];
  const quoteVisits = jobIds.length
    ? await prisma.issuedEstimate.findMany({
      where: { jobVisitId: { in: jobIds }, visitId: { not: null }, signedAt: { not: null }, voidedAt: null, status: { not: "void" } },
      select: { visitId: true, jobVisitId: true },
    })
    : [];
  const quoteByJob = new Map<string, string[]>();
  for (const link of quoteVisits) {
    if (!link.visitId || !link.jobVisitId || link.visitId === link.jobVisitId) continue;
    quoteByJob.set(link.jobVisitId, [...(quoteByJob.get(link.jobVisitId) ?? []), link.visitId]);
  }
  const chainOf = (job: MaterialCostInput) => [...new Set([job.visitId, ...(job.chainVisitIds ?? []), ...(quoteByJob.get(job.visitId) ?? [])])];
  const allIds = jobs.flatMap(chainOf);
  const poByVisit = await poMaterialByJob(allIds);
  const out = new Map<string, MaterialCostResult>();
  for (const job of jobs) {
    const parts = chainOf(job)
      .map((id) => poByVisit.get(id))
      .filter((p): p is PoMaterial => Boolean(p));
    const po: PoMaterial | null = parts.length === 0
      ? null
      : {
        card: round2(parts.reduce((s, p) => s + p.card, 0)),
        typed: round2(parts.reduce((s, p) => s + p.typed, 0)),
        net: round2(parts.reduce((s, p) => s + p.net, 0)),
        poCount: parts.reduce((s, p) => s + p.poCount, 0),
      };
    const poMaterial = po ? po.net : null;
    out.set(job.visitId, { ...resolveMaterialCost(poMaterial), poMaterial, po });
  }
  return out;
}

/** The Visit fields the rollup actually reads — keeps callers from over-selecting. */
export interface CostableVisit {
  estimatedCost: number | null;
  laborHours: number | null;
  overheadAllocation: number | null;
  revenue: number | null;
}

/**
 * A job's cost chain (Kyle, 2026-09-02: "no cost revenue or profit" — the P&L
 * merge). Hours clocked on the ORIGINAL appointment visit belong to the sold
 * job that came out of it. The chain is defined by the issued estimate, which
 * names both visits (visitId = where it was quoted, jobVisitId = the sold job).
 * Costs sum onto the job; the child visit's card reports that its costs rolled
 * up, and lifetime totals count everything once. (Material rides the chain
 * inside materialCostForJobs, from the P.O.s, so it is not merged here.)
 */
export function mergeCostableChain(job: CostableVisit, children: CostableVisit[]): CostableVisit {
  return {
    estimatedCost: job.estimatedCost,
    revenue: job.revenue,
    laborHours: (job.laborHours ?? 0) + children.reduce((s, c) => s + (c.laborHours ?? 0), 0),
    overheadAllocation:
      (job.overheadAllocation ?? 0) + children.reduce((s, c) => s + (c.overheadAllocation ?? 0), 0),
  };
}

/** The child's own card after a merge: costs live on the job now. */
export const ROLLED_UP_COSTS: CostableVisit = {
  estimatedCost: null, laborHours: 0, overheadAllocation: 0, revenue: null,
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
   * The money rung (Kyle, 2026-09-19): card charges + typed not-on-card amounts
   * on the P.O.s tagged to this job, from materialCostForJobs(). Null when no
   * P.O. on the job carries money — the card then reads $0, "none".
   */
  poMaterial: number | null = null,
): JobCosts {
  const revenue = visit.revenue ?? acceptedOptionTotal ?? null;
  const { materialCost, materialSource } = resolveMaterialCost(poMaterial);
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
 *
 * DISPLAY ONLY since 2026-09-19: "the job material estimate stays an estimate
 * and never counts toward job cost." The materials panel shows it beside the
 * real figure; nothing adds it to any cost.
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
