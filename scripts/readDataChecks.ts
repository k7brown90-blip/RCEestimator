/**
 * Read-only data checks against production (2026-09-21, punch-list fix plan).
 * Performs NO writes: every call below is a find/count.
 *
 * Usage (against production):
 *   railway ssh -s RCEestimator "node dist/scripts/readDataChecks.js"
 *
 * What it answers:
 *   1. PUNCHLIST N1 / plan Q1 — signed estimates whose status is neither "signed" nor "void".
 *      Must be 0: every money and reporting filter is now an allow-list on status "signed"
 *      (PUNCHLIST A9), so any such row is missing from the P&L, the job card and /invoices.
 *   2. PUNCHLIST N2 — stale jobs. Before Batch 1, signing a revision of a signed estimate minted a
 *      second job. The backfill migration voided the replaced revision but left jobs alone; any
 *      replaced revision still pointing at an open job that the live revision does not share is
 *      listed here for Kyle to cancel by hand.
 *   3. Plan Q5 — are there any legacy `Estimate` rows left? Zero means the /estimates/* family
 *      can retire (PUNCHLIST K5).
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main(): Promise<void> {
  // 1. Signed rows off the allow-list.
  const offList = await prisma.issuedEstimate.findMany({
    where: { signedAt: { not: null }, status: { notIn: ["signed", "void"] } },
    select: { id: true, number: true, revision: true, status: true, signedAt: true, voidedAt: true },
    orderBy: { signedAt: "asc" },
  });
  console.log(`1. Signed estimates with status not in (signed, void): ${offList.length}`);
  for (const r of offList) {
    console.log(`   ${r.number} rev ${r.revision}  status=${r.status}  signedAt=${r.signedAt?.toISOString()}  voidedAt=${r.voidedAt?.toISOString() ?? "-"}  id=${r.id}`);
  }

  // 2. Replaced revisions still holding an open job the live revision does not share.
  const replaced = await prisma.issuedEstimate.findMany({
    where: { status: "void", voidReason: { startsWith: "Replaced by signed revision" }, jobVisitId: { not: null } },
    select: { id: true, number: true, revision: true, jobVisitId: true },
  });
  const stale: string[] = [];
  for (const r of replaced) {
    const job = await prisma.visit.findUnique({ where: { id: r.jobVisitId! }, select: { id: true, status: true, visitDate: true } });
    if (!job || job.status === "cancelled" || job.status === "completed") continue;
    const live = await prisma.issuedEstimate.findFirst({
      where: { number: r.number, revision: { gt: r.revision }, signedAt: { not: null }, voidedAt: null, status: "signed" },
      orderBy: { revision: "desc" },
      select: { revision: true, jobVisitId: true },
    });
    if (live?.jobVisitId === job.id) continue; // the live revision took this job over — not stale
    stale.push(`   ${r.number}: rev ${r.revision}'s job ${job.id} (status ${job.status}, date ${job.visitDate?.toISOString().slice(0, 10) ?? "-"}) — live revision ${live ? `rev ${live.revision} is on job ${live.jobVisitId ?? "none"}` : "none found"}`);
  }
  console.log(`2. Stale jobs left by a replaced revision: ${stale.length}`);
  for (const line of stale) console.log(line);

  // 3. Legacy Estimate rows.
  const legacy = await prisma.estimate.count();
  console.log(`3. Legacy Estimate rows: ${legacy}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
