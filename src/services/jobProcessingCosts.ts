/**
 * Processing costs per job — Synchrony's cut and Stripe's card processing fees (Kyle, 2026-10-09,
 * ruling 6 of the one-estimating-system plan: "Job card, account summary and job profitability
 * subtract Synchrony's cut AND card processing fees, so job profit agrees with the P&L and the
 * commission card").
 *
 * Until this existed the job card added the financing fee to revenue but never subtracted what
 * Synchrony kept, and had never subtracted Stripe's fees at all; the P&L and the commission basis
 * both did. One job, three different profits.
 *
 * ONE ATTRIBUTION, FOUR READERS. This is the only place a payment's processing cost is tied to a
 * job: GET /jobs, the account summary, /financials/job-profitability (through rollupJobCosts) and
 * the commission basis (timeTracking.commissionBasisForJob) all call processingCostsForJobs. A
 * payment belongs to a job through its invoice — the job's signed ROOT estimate plus the live
 * signed change orders on it (services/invoiceGroup.ts), the same group paymentSummary sums — or,
 * for a row with no invoice, through its visitId.
 *
 *   - SYNCHRONY'S CUT: the figure captured on the Synchrony payment at recording
 *     (Payment.financingCut, services/financingFee.ts). Live rows only — a voided one is no money.
 *   - CARD PROCESSING FEES: read off each card payment's own balance transaction
 *     (treasury.stripeFeeForSession — the same figure the P&L's Stripe-fees line reads), cached per
 *     session. A fee Stripe cannot give yet (not settled, key without read scope, Stripe not
 *     configured) is PENDING with the reason — shown as such, never $0 (rule 6). A refunded card
 *     payment keeps its fee: Stripe does not return its fee on a refund, so the cost stands.
 */

import { prisma } from "../lib/prisma";
import { LIVE_SIGNED_CHANGE_ORDER } from "./invoiceGroup";
import { stripeFeeForSession } from "./treasury";

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface SynchronyCutRow {
  paymentId: string;
  /** What Synchrony kept, dollars. */
  amount: number;
  planNumber: string | null;
}

export interface CardFeeRow {
  paymentId: string;
  /** Stripe's processing fee, dollars. */
  fee: number;
  /** The card payment the fee was taken from. */
  paymentAmount: number;
  kind: string;
  paidAt: Date | null;
  /** The payment was later refunded (in part or in full) — the fee still stands. */
  refunded: boolean;
}

export interface CardFeePending {
  paymentId: string;
  /** The card payment whose fee could not be read, dollars. */
  amount: number;
  reason: string;
}

export interface JobProcessingCosts {
  /** Σ synchronyRows. */
  synchronyCut: number;
  synchronyRows: SynchronyCutRow[];
  /** Σ cardFeeRows — the fees that COULD be read. */
  cardFees: number;
  cardFeeRows: CardFeeRow[];
  /** Card payments whose fee is not known yet, each with why. Non-empty means cardFees is incomplete. */
  cardFeesPending: CardFeePending[];
}

export function emptyProcessingCosts(): JobProcessingCosts {
  return { synchronyCut: 0, synchronyRows: [], cardFees: 0, cardFeeRows: [], cardFeesPending: [] };
}

export interface ProcessingCostsInput {
  visitId: string;
  /** The job's signed ROOT invoice (IssuedEstimate id), when it has one. Change orders are found here. */
  rootEstimateId?: string | null;
}

/** Stripe reads run a few at a time: the per-session cache makes the second load free. */
const FEE_READ_CONCURRENCY = 6;

/**
 * Per job, in ONE grouped payment query (never one per job) plus one cached Stripe read per card
 * payment the first time it is seen. A job with no payments is present with zeros.
 */
export async function processingCostsForJobs(jobs: ProcessingCostsInput[]): Promise<Map<string, JobProcessingCosts>> {
  const out = new Map<string, JobProcessingCosts>();
  const visitIds = [...new Set(jobs.map((j) => j.visitId).filter(Boolean))];
  for (const id of visitIds) out.set(id, emptyProcessingCosts());
  if (visitIds.length === 0) return out;

  // invoice document id → the jobs it belongs to (a root and its live signed change orders).
  const jobsByEstimate = new Map<string, string[]>();
  const add = (estimateId: string, visitId: string) => {
    const list = jobsByEstimate.get(estimateId) ?? [];
    if (!list.includes(visitId)) list.push(visitId);
    jobsByEstimate.set(estimateId, list);
  };
  const rootIds = [...new Set(jobs.map((j) => j.rootEstimateId).filter((id): id is string => Boolean(id)))];
  for (const j of jobs) if (j.rootEstimateId) add(j.rootEstimateId, j.visitId);
  if (rootIds.length > 0) {
    const changeOrders = await prisma.issuedEstimate.findMany({
      where: { changeOrderForId: { in: rootIds }, ...LIVE_SIGNED_CHANGE_ORDER },
      select: { id: true, changeOrderForId: true },
    });
    for (const co of changeOrders) {
      for (const j of jobs) if (j.rootEstimateId && j.rootEstimateId === co.changeOrderForId) add(co.id, j.visitId);
    }
  }

  const payments = await prisma.payment.findMany({
    where: {
      voidedAt: null,
      // "paid" and "refunded": a refunded card payment still cost its Stripe fee.
      status: { in: ["paid", "refunded"] },
      OR: [{ estimateId: { in: [...jobsByEstimate.keys()] } }, { visitId: { in: visitIds } }],
    },
    select: {
      id: true, amount: true, kind: true, method: true, status: true, paidAt: true, createdAt: true,
      estimateId: true, visitId: true, stripeSessionId: true, financingCut: true, financingPlanNumber: true, refundedAmount: true,
    },
    orderBy: [{ paidAt: "asc" }, { createdAt: "asc" }],
  });

  // Which job(s) each payment is on: the invoice first, else the visit it was recorded against.
  const targetsOf = (p: { estimateId: string | null; visitId: string | null }): string[] => {
    const viaInvoice = p.estimateId ? jobsByEstimate.get(p.estimateId) : undefined;
    if (viaInvoice && viaInvoice.length > 0) return viaInvoice;
    return p.visitId && out.has(p.visitId) ? [p.visitId] : [];
  };

  const cardPayments = payments.filter((p) => p.method === "stripe");
  const feeBySession = new Map<string, Awaited<ReturnType<typeof stripeFeeForSession>>>();
  const sessions = [...new Set(cardPayments.map((p) => p.stripeSessionId).filter((s): s is string => Boolean(s)))];
  for (let i = 0; i < sessions.length; i += FEE_READ_CONCURRENCY) {
    const slice = sessions.slice(i, i + FEE_READ_CONCURRENCY);
    const reads = await Promise.all(slice.map((s) => stripeFeeForSession(s)));
    slice.forEach((s, idx) => feeBySession.set(s, reads[idx]));
  }

  for (const p of payments) {
    for (const visitId of targetsOf(p)) {
      const row = out.get(visitId)!;
      if (p.method === "synchrony") {
        // Synchrony's cut lives only on a live, paid Synchrony row (recordSynchronyPayment).
        if (p.status === "paid" && (p.financingCut ?? 0) > 0) {
          row.synchronyRows.push({ paymentId: p.id, amount: p.financingCut!, planNumber: p.financingPlanNumber });
        }
      } else if (p.method === "stripe") {
        if (!p.stripeSessionId) {
          row.cardFeesPending.push({ paymentId: p.id, amount: p.amount, reason: "This card payment has no Stripe session on it, so its processing fee cannot be looked up." });
          continue;
        }
        const read = feeBySession.get(p.stripeSessionId)!;
        if (!read.ok) {
          row.cardFeesPending.push({ paymentId: p.id, amount: p.amount, reason: read.reason });
          continue;
        }
        row.cardFeeRows.push({
          paymentId: p.id, fee: read.fee, paymentAmount: p.amount, kind: p.kind, paidAt: p.paidAt,
          refunded: p.status === "refunded" || (p.refundedAmount ?? 0) > 0,
        });
      }
    }
  }
  for (const row of out.values()) {
    row.synchronyCut = round2(row.synchronyRows.reduce((s, r) => s + r.amount, 0));
    row.cardFees = round2(row.cardFeeRows.reduce((s, r) => s + r.fee, 0));
  }
  return out;
}
