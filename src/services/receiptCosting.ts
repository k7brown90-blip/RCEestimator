/**
 * Receipt → job material cost, one writer.
 *
 * Kyle, 2026-09-08: "The uploaded receipts are not processing correctly. I just
 * finished Jason Daughdrill's job and the uploaded receipt did not calculate
 * over the estimated cost." Four receipts had been uploaded from the CRM,
 * confirmed on arrival, and the job's actualMaterialCost still read 0 — the
 * office upload door never re-rolled the total. Two other doors (the Make
 * webhook and the admin review PATCH) each carried their own copy of the sum.
 *
 * Every door that creates, edits, confirms or deletes a receipt now calls this
 * and nothing else stamps Visit.actualMaterialCost. Confirmed material
 * receipts only (ruled 2026-09-06), summed to the cent.
 *
 * Kyle, 2026-09-09 (Build 4, the costing switch): "on future jobs I can label
 * some stock as truckstock and it won't double count the cost." A receipt that
 * is attached to a PURCHASE ORDER is inventory value — its material landed on
 * a truck or in the warehouse and the job pays by CONSUMING it (the stock rung
 * in services/jobCosting.ts). So only receipts with purchaseOrderId null count
 * here. That is what stops the double count: the roll's receipt rides the PO,
 * the job is charged when the roll is consumed. Jobs closed before this build
 * have no PO on their receipts and keep their figures exactly.
 */

import { prisma } from "../lib/prisma";

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The receipt rung's figure for a job, without writing it. */
export async function receiptMaterialCost(jobId: string): Promise<number> {
  const rows = await prisma.receipt.findMany({
    where: { jobId, category: "materials", status: "confirmed", purchaseOrderId: null },
    select: { amount: true },
  });
  return round2(rows.reduce((sum, r) => sum + r.amount, 0));
}

export async function rerollJobMaterialCost(jobId: string): Promise<number> {
  const total = await receiptMaterialCost(jobId);
  // The visit may be gone (test teardown, a deleted job) — a missing row is not an error here.
  await prisma.visit.update({ where: { id: jobId }, data: { actualMaterialCost: total } }).catch(() => {});
  return total;
}

/** Re-roll every job a receipt touched — the old job and the new one when it moved. */
export async function rerollJobsMaterialCost(jobIds: Array<string | null | undefined>): Promise<void> {
  const unique = [...new Set(jobIds.filter((id): id is string => Boolean(id)))];
  for (const jobId of unique) await rerollJobMaterialCost(jobId);
}

// ─── The Build 4 backfill (scripts/backfillMaterialRule.ts) ──────────────────

export interface ReceiptRerollPlan {
  jobId: string;
  customer: string;
  jobLabel: string;
  status: string;
  /** What is stamped on the visit today. */
  from: number | null;
  /** Confirmed materials receipts with no PO. */
  to: number;
  /** Receipts on a PO — counted before this build, inventory value now. */
  excluded: Array<{ receiptId: string; amount: number; vendor: string | null; purchaseOrderNumber: string }>;
  changes: boolean;
}

/**
 * Every job that carries a receipt or a stamped actualMaterialCost, with what
 * the receipt rung says now. Read-only; the script prints it (dry run) and
 * `applyReceiptReroll` writes only the rows that change.
 */
export async function planReceiptReroll(): Promise<ReceiptRerollPlan[]> {
  const receipts = await prisma.receipt.findMany({
    where: { jobId: { not: null } },
    select: {
      id: true, jobId: true, amount: true, vendor: true, category: true, status: true,
      purchaseOrderId: true, purchaseOrder: { select: { number: true } },
    },
  });
  const jobIds = new Set(receipts.map((r) => r.jobId!).filter(Boolean));
  const stamped = await prisma.visit.findMany({
    where: { OR: [{ id: { in: [...jobIds] } }, { actualMaterialCost: { gt: 0 } }] },
    select: { id: true, status: true, jobType: true, purpose: true, actualMaterialCost: true, customer: { select: { name: true } } },
  });
  const plans: ReceiptRerollPlan[] = [];
  for (const visit of stamped) {
    const mine = receipts.filter((r) => r.jobId === visit.id && r.category === "materials" && r.status === "confirmed");
    const counted = mine.filter((r) => !r.purchaseOrderId);
    const excluded = mine.filter((r) => r.purchaseOrderId);
    const to = round2(counted.reduce((s, r) => s + r.amount, 0));
    const from = visit.actualMaterialCost;
    plans.push({
      jobId: visit.id,
      customer: visit.customer.name,
      jobLabel: visit.jobType ?? visit.purpose ?? visit.id,
      status: visit.status,
      from,
      to,
      excluded: excluded.map((r) => ({ receiptId: r.id, amount: r.amount, vendor: r.vendor, purchaseOrderNumber: r.purchaseOrder?.number ?? "PO" })),
      changes: Math.abs((from ?? 0) - to) > 0.005,
    });
  }
  return plans.sort((a, b) => a.customer.localeCompare(b.customer));
}

/** Writes the rows that change, through the one writer. Returns the job ids re-stamped. */
export async function applyReceiptReroll(plans: ReceiptRerollPlan[]): Promise<string[]> {
  const written: string[] = [];
  for (const plan of plans) {
    if (!plan.changes) continue;
    await rerollJobMaterialCost(plan.jobId);
    written.push(plan.jobId);
  }
  return written;
}
