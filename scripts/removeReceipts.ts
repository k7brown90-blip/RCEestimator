/**
 * Remove duplicate receipts from a job and re-roll its material (Kyle,
 * 2026-09-08, "do both": Daughdrill 2026-1057 carried six copies of one
 * $381.90 SiteOne receipt after the office-upload door failed to re-roll and
 * he kept re-uploading).
 *
 *   railway ssh "node dist/scripts/removeReceipts.js --job <visitId> --ids 9f1f94,4bc26d"
 *   railway ssh "node dist/scripts/removeReceipts.js --job <visitId> --ids 9f1f94,4bc26d --apply"
 *
 * Ids may be the 6-character suffixes the audit prints; each must match exactly
 * one receipt ON THAT JOB or the run refuses. Dry run unless --apply. Goes
 * through the same writer every receipt door uses.
 */

import { PrismaClient } from "@prisma/client";
import { rerollJobMaterialCost } from "../src/services/receiptCosting";

const prisma = new PrismaClient();
const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const APPLY = argv.includes("--apply");

async function main(): Promise<void> {
  const jobId = arg("--job");
  const ids = (arg("--ids") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!jobId || ids.length === 0) {
    console.error("usage: --job <visitId> --ids <id|suffix>[,...] [--apply]");
    process.exitCode = 2;
    return;
  }
  const onJob = await prisma.receipt.findMany({
    where: { jobId },
    select: { id: true, source: true, status: true, category: true, amount: true, vendor: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  console.log(`Job ${jobId.slice(-6)}: ${onJob.length} receipt(s) on it.`);
  for (const r of onJob) {
    console.log(`  ${r.id.slice(-6)} ${r.createdAt.toISOString().slice(0, 16)} ${r.source.padEnd(8)} ${r.status.padEnd(14)} ${r.category.padEnd(9)} $${r.amount.toFixed(2)}  ${r.vendor ?? "(no vendor)"}`);
  }

  const targets: typeof onJob = [];
  for (const wanted of ids) {
    const matches = onJob.filter((r) => r.id === wanted || r.id.endsWith(wanted));
    if (matches.length !== 1) {
      console.error(`Refusing: "${wanted}" matches ${matches.length} receipt(s) on this job.`);
      process.exitCode = 1;
      return;
    }
    targets.push(matches[0]);
  }
  const remaining = onJob.filter((r) => !targets.some((t) => t.id === r.id));
  console.log(`\n${APPLY ? "REMOVING" : "Would remove"} ${targets.length}:`);
  for (const t of targets) console.log(`  ${t.id.slice(-6)} ${t.status} $${t.amount.toFixed(2)} ${t.vendor ?? ""}`);
  console.log(`Keeping ${remaining.length}:`);
  for (const r of remaining) console.log(`  ${r.id.slice(-6)} ${r.status} $${r.amount.toFixed(2)} ${r.vendor ?? ""}`);

  if (!APPLY) {
    console.log("\nDry run — add --apply to write.");
    return;
  }
  await prisma.receipt.deleteMany({ where: { id: { in: targets.map((t) => t.id) } } });
  const total = await rerollJobMaterialCost(jobId);
  console.log(`\nRemoved ${targets.length}. Job ${jobId.slice(-6)} actualMaterialCost re-rolled to $${total.toFixed(2)}.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
