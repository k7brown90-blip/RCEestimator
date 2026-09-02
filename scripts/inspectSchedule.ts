/**
 * Read the "Needs scheduling" rail's actual contents, with provenance (Kyle,
 * 2026-09-02: "the 'jobs need scheduling' on the calendar are not jobs at all"
 * and "Mabel signed and payed the deposit and there is no way to schedule
 * her"). For each unscheduled estimate/contracted visit: who, status, purpose,
 * created when, and the latest issued estimate hanging off it (number, signed,
 * job link) — enough to tell a sold job from a stale pipeline row.
 *
 * --create-missing-jobs --apply: the backfill for Mabel's class of bug — every
 * SIGNED, non-void estimate with no jobVisitId gets its job created through
 * the same createJobFromSignedEstimate the in-person path uses. Dry-run
 * without --apply.
 */

import { PrismaClient } from "@prisma/client";
import { createJobFromSignedEstimate } from "../src/services/accountSpine";

const prisma = new PrismaClient();
const d = (x: Date | null | undefined) => (x ? x.toISOString().slice(0, 16).replace("T", " ") : "—");

async function main(): Promise<void> {
  const createMissing = process.argv.includes("--create-missing-jobs");
  const apply = process.argv.includes("--apply");

  console.log("── The Needs-scheduling rail (scheduledStart null, status estimate|contracted) ──");
  const rail = await prisma.visit.findMany({
    where: { scheduledStart: null, status: { in: ["estimate", "contracted"] } },
    include: {
      customer: { select: { name: true } },
      property: { select: { addressLine1: true, city: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  for (const v of rail) {
    const linked = await prisma.issuedEstimate.findFirst({
      where: { OR: [{ jobVisitId: v.id }, { visitId: v.id }] },
      orderBy: { createdAt: "desc" },
      select: { number: true, signedAt: true, status: true },
    });
    console.log(
      `  ${v.customer.name.padEnd(22)} ${v.status.padEnd(10)} created ${d(v.createdAt)}  purpose "${(v.purpose ?? "").slice(0, 40)}"` +
      `  jobType ${v.jobType ?? "—"}  visit ${v.id}`,
    );
    console.log(
      `      issued estimate ${linked ? `${linked.number} signed=${d(linked.signedAt)} ${linked.status}` : "NONE — no issued estimate touches this visit"}`,
    );
  }

  console.log("\n── Signed estimates with NO job (Mabel's class) ──");
  const orphans = await prisma.issuedEstimate.findMany({
    where: { signedAt: { not: null }, status: { not: "void" }, jobVisitId: null, supersededBy: null },
    select: { id: true, number: true, signedAt: true, signerName: true, customerId: true, total: true },
    orderBy: { signedAt: "desc" },
  });
  if (orphans.length === 0) console.log("  none — every signed estimate has its job.");
  for (const e of orphans) {
    console.log(`  ${e.number}  signed ${d(e.signedAt)} by ${e.signerName ?? "?"}  total $${e.total.toFixed(2)}`);
    if (createMissing && apply) {
      const r = await createJobFromSignedEstimate(prisma, e.id, { actor: "claude:schedule-backfill-2026-09-02" });
      console.log(r.ok ? `    → job created: visit ${r.visitId}${r.created ? "" : " (already existed)"}` : `    !! refused: ${r.reason}`);
    } else if (createMissing) {
      console.log("    (dry run — --apply creates the job)");
    }
  }
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
