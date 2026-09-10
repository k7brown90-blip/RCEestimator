/**
 * Backfill for THE MATERIAL RULE (Kyle, 2026-09-09, Build 4 — the costing switch).
 *
 * "On future jobs I can label some stock as truckstock and it won't double
 * count the cost." A receipt attached to a PO is inventory value — its material
 * landed on a truck or in the warehouse and the job pays by consuming it. Before
 * this build every confirmed materials receipt was stamped onto
 * Visit.actualMaterialCost, PO or not, so a job with a landed PO could be
 * charged twice once it consumed the roll. This re-stamps every job through the
 * one writer (services/receiptCosting.ts), which now counts receipts with NO PO
 * only.
 *
 * Legacy jobs closed before this build keep their figures exactly: their
 * receipts have no PO (Daughdrill $381.90, Womack $406.74 — untouched). Only a
 * job whose receipt rides a PO changes, and the dry run lists each one.
 *
 *   railway ssh "node dist/scripts/backfillMaterialRule.js"           # dry run (default)
 *   railway ssh "node dist/scripts/backfillMaterialRule.js --apply"   # write
 */

import { PrismaClient } from "@prisma/client";
import { applyReceiptReroll, planReceiptReroll } from "../src/services/receiptCosting";

const prisma = new PrismaClient();
const APPLY = process.argv.slice(2).includes("--apply");

const money = (n: number | null) => (n == null ? "null" : `$${n.toFixed(2)}`);

async function main(): Promise<void> {
  const plans = await planReceiptReroll();
  const changing = plans.filter((p) => p.changes);
  console.log(`${plans.length} job(s) carry receipts or a stamped material cost; ${changing.length} change under the rule.\n`);

  for (const p of plans) {
    const mark = p.changes ? "→ " : "  ";
    console.log(`${mark}${p.jobId.slice(-6)} ${p.customer.padEnd(22)} ${p.jobLabel.slice(0, 28).padEnd(28)} ${p.status.padEnd(11)} actualMat ${money(p.from)} → ${money(p.to)}${p.changes ? "" : "  (unchanged)"}`);
    for (const r of p.excluded) {
      console.log(`         receipt ${r.receiptId.slice(-6)} $${r.amount.toFixed(2).padStart(9)}  ${r.vendor ?? "(no vendor)"}  on ${r.purchaseOrderNumber} → inventory value, not job cost`);
    }
  }

  if (changing.length === 0) {
    console.log("\nNothing to re-stamp.");
    return;
  }
  if (!APPLY) {
    console.log(`\nDry run — ${changing.length} job(s) would be re-stamped. Add --apply to write.`);
    return;
  }
  const written = await applyReceiptReroll(plans);
  console.log(`\nRe-stamped ${written.length} job(s): ${written.map((id) => id.slice(-6)).join(", ")}.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
