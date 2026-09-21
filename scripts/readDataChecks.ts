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
 *   4. Live card charges with no P.O., by kind — only MATERIALS must be on a P.O.
 *   5. With --cards: every card row with its Stripe ids and raw v2 status fields.
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

  // 4. Card charges that count as money but sit on no P.O. (Kyle, 2026-09-21: "each card spend is
  //    still linked to a PO"). routeCardSpend links or drafts a P.O. for MATERIALS charges only;
  //    the count per kind shows what the rule leaves unlinked. Ignored charges are not money.
  const unlinked = await prisma.cardSpend.findMany({
    where: { purchaseOrderId: null, status: { not: "ignored" } },
    select: { id: true, kind: true, amount: true, merchantName: true, occurredAt: true },
    orderBy: { occurredAt: "desc" },
  });
  const totalLive = await prisma.cardSpend.count({ where: { status: { not: "ignored" } } });
  console.log(`4. Live card charges with no P.O.: ${unlinked.length} of ${totalLive}`);
  const byKind = new Map<string, { n: number; sum: number }>();
  for (const c of unlinked) {
    const k = byKind.get(c.kind) ?? { n: 0, sum: 0 };
    byKind.set(c.kind, { n: k.n + 1, sum: k.sum + c.amount });
  }
  for (const [kind, k] of byKind) console.log(`   ${kind}: ${k.n} charge(s), $${k.sum.toFixed(2)}`);
  for (const c of unlinked.slice(0, 40)) {
    console.log(`   ${c.occurredAt.toISOString().slice(0, 10)}  ${c.kind.padEnd(11)} $${c.amount.toFixed(2).padStart(9)}  ${c.merchantName}  id=${c.id}`);
  }
  if (unlinked.length > 40) console.log(`   ... ${unlinked.length - 40} more`);

  // 5. --cards: every card row with the Stripe identifiers, to find what a double-imported charge
  //    looks like (Kyle, 2026-09-21: RaceTrac, Smyrna, the permit, biBERK and Sunbelt were each ONE
  //    charge but sit on the ledger twice). Read-only; prints the v2 row's own status fields.
  if (process.argv.includes("--cards")) {
    const rows = await prisma.cardSpend.findMany({ orderBy: { occurredAt: "asc" } });
    console.log(`5. All card rows (${rows.length}):`);
    for (const r of rows) {
      let raw: Record<string, unknown> = {};
      try { raw = r.rawJson ? JSON.parse(r.rawJson) : {}; } catch { /* unparseable rawJson is reported as {} */ }
      const flow = raw.flow as Record<string, unknown> | undefined;
      console.log([
        `   ${r.occurredAt.toISOString()}`, `$${r.amount.toFixed(2)}`, r.merchantName, `kind=${r.kind}`, `status=${r.status}`,
        `settlement=${r.settlement}`, `po=${r.purchaseOrderId ?? "-"}`, `txn=${r.stripeTransactionId}`, `auth=${r.stripeAuthorizationId ?? "-"}`,
        `raw.status=${String(raw.status ?? "-")}`, `raw.flow=${flow ? JSON.stringify(flow) : "-"}`,
        `raw.transitions=${raw.status_transitions ? JSON.stringify(raw.status_transitions) : "-"}`,
        `raw.counterparty=${raw.counterparty ? JSON.stringify(raw.counterparty) : "-"}`, `created=${r.createdAt.toISOString()}`,
      ].join("  "));
    }
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
