/**
 * Reads what every job's material cost is under "the P.O. is the money"
 * (Kyle, 2026-09-19) — the job-by-job check that no closed job's figure went
 * to zero when the receipt rung retired. Read-only: this script performs no
 * writes.
 *
 * For every P.O. tagged to a job it prints the job, the P.O., its live card
 * charges, its typed not-on-card amount, and the job's total through the same
 * helper the job page uses (services/jobCosting.ts materialCostForJobs). It
 * then lists the legacy P.O.s the 2026-09-19 migration created or re-tagged
 * (PurchaseOrderEvent kind "migrated"), so Daughdrill $381.90, Womack $406.74
 * and the rest can be read off against what the job page showed before.
 *
 * Usage (against production):
 *   railway ssh -s RCEestimator "node dist/scripts/readJobMaterialCosts.js [--all]"
 *
 *   --all   also print jobs whose P.O.s carry no money (source "none")
 */

import { PrismaClient } from "@prisma/client";
import { materialCostForJobs } from "../src/services/jobCosting";

const prisma = new PrismaClient();
const money = (n: number | null | undefined) => (n == null ? "—" : `$${n.toFixed(2)}`);
const ALL = process.argv.includes("--all");

async function main() {
  const orders = await prisma.purchaseOrder.findMany({
    where: { jobId: { not: null } },
    orderBy: { number: "asc" },
    select: {
      id: true, number: true, status: true, supplier: true, purpose: true, jobId: true, afterTheFact: true,
      offCardAmount: true, offCardMethod: true, offCardAt: true, notes: true,
      job: { select: { id: true, jobType: true, purpose: true, status: true, customer: { select: { name: true, isTestAccount: true } } } },
      cardSpends: { select: { amount: true, kind: true, status: true, merchantName: true, occurredAt: true } },
      _count: { select: { receipts: true } },
    },
  });
  const jobIds = [...new Set(orders.map((o) => o.jobId!))];
  const costs = await materialCostForJobs(jobIds.map((visitId) => ({ visitId })));

  const byJob = new Map<string, typeof orders>();
  for (const o of orders) byJob.set(o.jobId!, [...(byJob.get(o.jobId!) ?? []), o]);

  console.log(`${jobIds.length} job(s) carry a P.O.; figures are what the job page shows now.\n`);
  for (const jobId of jobIds) {
    const mine = byJob.get(jobId)!;
    const job = mine[0].job!;
    const cost = costs.get(jobId)!;
    if (cost.materialSource === "none" && !ALL) continue;
    console.log(
      `${jobId.slice(-6)}  ${(job.customer.name + (job.customer.isTestAccount ? " [TEST]" : "")).padEnd(26)} ${(job.jobType ?? job.purpose ?? "job").slice(0, 26).padEnd(26)} ${job.status.padEnd(11)} ` +
        `material ${money(cost.materialCost)} (${cost.materialSource}${cost.po ? `: card ${money(cost.po.card)} + typed ${money(cost.po.typed)} on ${cost.po.poCount} P.O.` : ""})`,
    );
    for (const o of mine) {
      const live = o.cardSpends.filter((c) => c.status !== "ignored");
      console.log(
        `         ${o.number} ${o.status.padEnd(9)} ${o.supplier.slice(0, 24).padEnd(24)} ${o.purpose.padEnd(11)}` +
          ` charges ${live.length === 0 ? "none" : live.map((c) => `${money(c.amount)}${c.kind !== "materials" ? ` (${c.kind})` : ""}`).join(" + ")}` +
          `${o.offCardAmount != null ? `  typed ${money(o.offCardAmount)} (${o.offCardMethod ?? "not on card"}${o.offCardAt ? ` ${o.offCardAt.toISOString().slice(0, 10)}` : ""})` : ""}` +
          `  receipts ${o._count.receipts}${o.afterTheFact ? "  after-the-fact" : ""}`,
      );
    }
  }

  const migrated = await prisma.purchaseOrderEvent.findMany({
    where: { kind: "migrated" },
    orderBy: { at: "asc" },
    select: { reason: true, after: true, purchaseOrder: { select: { number: true, status: true, jobId: true, offCardAmount: true } } },
  });
  console.log(`\n${migrated.length} P.O.(s) touched by the 2026-09-19 money migration:`);
  for (const m of migrated) {
    let detail: Record<string, unknown> = {};
    try { detail = m.after ? JSON.parse(m.after) : {}; } catch { /* leave empty */ }
    console.log(
      `  ${m.purchaseOrder.number} ${m.purchaseOrder.status.padEnd(9)} job=${String(detail.jobId ?? m.purchaseOrder.jobId ?? "none").slice(-6)}` +
        `  receipt ${money(detail.amount as number)}${m.purchaseOrder.offCardAmount != null ? `  typed ${money(m.purchaseOrder.offCardAmount)}` : "  (charge is the money)"}  — ${m.reason}`,
    );
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
