/**
 * Backfill for the cancelled-PO carve-out (Kyle, 2026-09-11, receiptCosting.ts:33-46).
 *
 * A receipt on a CANCELLED PO counts as job cost again — that PO landed
 * nothing, so the money never became stock. The READ (`receiptMaterialCost`)
 * has always honoured this, but nothing recomputed the STORED
 * `Visit.actualMaterialCost` when a PO transitioned to cancelled:
 * `rerollJobsMaterialCost` was only called from attach/detach, never from a
 * status transition. Unit 3 (2026-09-14) closes that gap going forward in
 * `transitionPurchaseOrder` (services/purchaseOrders.ts). This script re-rolls
 * the jobs that were already left stale by cancellations that happened before
 * the fix — nine POs cancelled 2026-09-14, including PO-2026-0012's $381.90
 * SiteOne receipt on the Daughdrill job, which was reading the ESTIMATE rung
 * instead of RECEIPTS.
 *
 * `rerollJobMaterialCost` recomputes `Visit.actualMaterialCost` from scratch
 * through the one writer (services/receiptCosting.ts), so this is idempotent —
 * running it twice, or against a job that was never affected, changes nothing.
 *
 *   railway ssh -s RCEestimator "node dist/scripts/backfillCancelledPoMaterialCost.js"           # dry run (default)
 *   railway ssh -s RCEestimator "node dist/scripts/backfillCancelledPoMaterialCost.js --apply"   # write
 */

import { PrismaClient } from "@prisma/client";
import { rerollJobMaterialCost } from "../src/services/receiptCosting";

const prisma = new PrismaClient();
const APPLY = process.argv.slice(2).includes("--apply");

const money = (n: number | null) => (n == null ? "null" : `$${n.toFixed(2)}`);
const round2 = (n: number) => Math.round(n * 100) / 100;

async function main(): Promise<void> {
  const receipts = await prisma.receipt.findMany({
    where: {
      jobId: { not: null },
      category: "materials",
      status: "confirmed",
      purchaseOrder: { status: "cancelled" },
    },
    select: {
      jobId: true,
      amount: true,
      vendor: true,
      purchaseOrder: { select: { number: true } },
    },
  });

  const jobIds = [...new Set(receipts.map((r) => r.jobId!).filter(Boolean))];
  if (jobIds.length === 0) {
    console.log("No confirmed materials receipts on a cancelled PO. Nothing to re-roll.");
    return;
  }

  const visits = await prisma.visit.findMany({
    where: { id: { in: jobIds } },
    select: { id: true, status: true, jobType: true, purpose: true, actualMaterialCost: true, customer: { select: { name: true } } },
  });
  const byJob = new Map(visits.map((v) => [v.id, v]));

  // Every confirmed materials receipt with no PO or a cancelled PO, per job —
  // this mirrors receiptMaterialCost's full condition (not just the cancelled
  // carve-out) so the "to" figure printed here is the real post-reroll value.
  const allCounted = await prisma.receipt.findMany({
    where: {
      jobId: { in: jobIds },
      category: "materials",
      status: "confirmed",
      OR: [{ purchaseOrderId: null }, { purchaseOrder: { status: "cancelled" } }],
    },
    select: { jobId: true, amount: true },
  });
  const toByJob = new Map<string, number>();
  for (const r of allCounted) {
    toByJob.set(r.jobId!, round2((toByJob.get(r.jobId!) ?? 0) + r.amount));
  }

  console.log(`${jobIds.length} job(s) carry a confirmed materials receipt on a cancelled PO.\n`);

  let changing = 0;
  for (const jobId of jobIds) {
    const visit = byJob.get(jobId);
    if (!visit) {
      console.log(`  ${jobId.slice(-6)} (MISSING visit — skipped)`);
      continue;
    }
    const from = visit.actualMaterialCost;
    const to = toByJob.get(jobId) ?? 0;
    const changes = Math.abs((from ?? 0) - to) > 0.005;
    if (changes) changing += 1;
    const mark = changes ? "→ " : "  ";
    console.log(
      `${mark}${jobId.slice(-6)} ${visit.customer.name.padEnd(22)} ${(visit.jobType ?? visit.purpose ?? jobId).slice(0, 28).padEnd(28)} ${visit.status.padEnd(11)} actualMat ${money(from)} → ${money(to)}${changes ? "" : "  (unchanged)"}`,
    );
    for (const r of receipts.filter((rc) => rc.jobId === jobId)) {
      console.log(`         receipt $${r.amount.toFixed(2).padStart(9)}  ${r.vendor ?? "(no vendor)"}  on ${r.purchaseOrder?.number ?? "PO"} (cancelled) → job cost again`);
    }
  }

  if (changing === 0) {
    console.log("\nNothing to re-stamp.");
    return;
  }
  if (!APPLY) {
    console.log(`\nDry run — ${changing} job(s) would be re-stamped. Add --apply to write.`);
    return;
  }
  const written: string[] = [];
  for (const jobId of jobIds) {
    const visit = byJob.get(jobId);
    if (!visit) continue;
    const from = visit.actualMaterialCost;
    const to = toByJob.get(jobId) ?? 0;
    if (Math.abs((from ?? 0) - to) <= 0.005) continue;
    await rerollJobMaterialCost(jobId);
    written.push(jobId);
  }
  console.log(`\nRe-stamped ${written.length} job(s): ${written.map((id) => id.slice(-6)).join(", ")}.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
