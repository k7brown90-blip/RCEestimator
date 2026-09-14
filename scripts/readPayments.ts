/**
 * Reads the Payment table — the audit path for "Stripe took the money and the
 * CRM does not know about it". Read-only: this script performs no writes.
 *
 * The question it exists to answer is ORPHANS. `Payment.estimateId` is a plain
 * column with no foreign key, deliberately, so a payment outlives the estimate
 * it was taken against — provenance survives a deletion. The cost of that is
 * that a payment can end up pointing at an id nothing resolves, and nothing
 * surfaces it: the money is recorded, but no balance counts it, so a job reads
 * as unpaid while Stripe shows it settled.
 *
 * That is exactly what happened on 2026-09-12 (Kyle sent two estimates, the
 * customer paid the deposit on one, and that one was deleted instead of the
 * duplicate). The delete route refuses SIGNED estimates but does not check for
 * payments, and a deposit is paid before signing by design.
 *
 * Usage (against production):
 *   railway ssh -s RCEestimator "node dist/scripts/readPayments.js [options]"
 *
 * Options:
 *   --since 24h|7d|30d      how far back, by createdAt (default 30d)
 *   --orphans               ONLY payments whose estimateId no longer resolves
 *   --amount 33.33          match this amount (within a cent)
 *   --customer "godwin"     customer-name substring, case-insensitive
 *   --status paid           paid | pending | failed | refunded
 *   --limit 100             max rows (default 100, newest first)
 *   --details               print ids, stripe session, note, check number
 *
 * Examples:
 *   railway ssh -s RCEestimator "node dist/scripts/readPayments.js --orphans --since 90d --details"
 *   railway ssh -s RCEestimator "node dist/scripts/readPayments.js --amount 33.33 --details"
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function parseSince(raw: string): Date {
  const m = /^(\d+)(m|h|d)$/.exec(raw);
  if (!m) {
    console.error(`Invalid --since value "${raw}" — use forms like 30m, 24h, 7d, 90d.`);
    process.exit(1);
  }
  const n = Number(m[1]);
  const unitMs = m[2] === "m" ? 60_000 : m[2] === "h" ? 3_600_000 : 86_400_000;
  return new Date(Date.now() - n * unitMs);
}

function ct(d: Date | null): string {
  return d ? d.toLocaleString("en-US", { timeZone: "America/Chicago" }) : "—";
}

const money = (n: number) => `$${n.toFixed(2)}`;

async function main() {
  const since = parseSince(arg("since") ?? "30d");
  const orphansOnly = flag("orphans");
  const amount = arg("amount") ? Number(arg("amount")) : undefined;
  const customer = arg("customer");
  const status = arg("status");
  const limit = Math.min(Number(arg("limit") ?? 100), 500);
  const showDetails = flag("details");

  const payments = await prisma.payment.findMany({
    where: {
      createdAt: { gte: since },
      ...(status ? { status } : {}),
      ...(amount != null ? { amount: { gte: amount - 0.005, lte: amount + 0.005 } } : {}),
      ...(customer ? { customer: { is: { name: { contains: customer, mode: "insensitive" } } } } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true, amount: true, method: true, kind: true, status: true, payer: true,
      estimateId: true, visitId: true, customerId: true, stripeSessionId: true,
      note: true, checkNumber: true, paidAt: true, createdAt: true,
      customer: { select: { name: true } },
    },
  });

  if (payments.length === 0) {
    console.log("No payments match.");
    return;
  }

  // Payment.estimateId has NO foreign key, so resolving it is a manual lookup.
  // A miss here is the whole point of this script: the money is real, the
  // estimate it names is gone, and no balance anywhere counts it.
  const estimateIds = [...new Set(payments.map((p) => p.estimateId).filter((v): v is string => !!v))];
  const found = estimateIds.length === 0 ? [] : await prisma.issuedEstimate.findMany({
    where: { id: { in: estimateIds } },
    select: { id: true, number: true, revision: true, signedAt: true, total: true },
  });
  const byId = new Map(found.map((e) => [e.id, e]));

  const isOrphan = (p: (typeof payments)[number]) => !!p.estimateId && !byId.has(p.estimateId);
  const rows = orphansOnly ? payments.filter(isOrphan) : payments;

  if (rows.length === 0) {
    console.log("No orphaned payments — every payment's estimate still resolves.");
    return;
  }

  console.log(`${rows.length} payment(s), newest first:\n`);
  for (const p of rows) {
    const est = p.estimateId ? byId.get(p.estimateId) : undefined;
    const link = !p.estimateId
      ? "no estimate (unattached)"
      : est
        ? `${est.number} rev ${est.revision}${est.signedAt ? " signed" : " UNSIGNED"} · est total ${money(est.total ?? 0)}`
        : `*** ORPHAN — estimate ${p.estimateId} no longer exists ***`;

    console.log(`${ct(p.paidAt ?? p.createdAt)} CT  ${money(p.amount).padStart(10)}  ${p.method}/${p.kind}/${p.status}  payer=${p.payer}`);
    console.log(`  customer=${p.customer?.name ?? p.customerId ?? "none"}`);
    console.log(`  ${link}`);
    if (showDetails) {
      console.log(`  paymentId=${p.id}`);
      console.log(`  visitId=${p.visitId ?? "none"}  stripeSession=${p.stripeSessionId ?? "none"}`);
      if (p.checkNumber) console.log(`  check #${p.checkNumber}`);
      if (p.note) console.log(`  note: ${p.note}`);
      console.log(`  created=${ct(p.createdAt)} CT`);
    }
    console.log();
  }

  const orphans = payments.filter(isOrphan);
  const orphanTotal = orphans.reduce((s, p) => s + (p.status === "paid" ? p.amount : 0), 0);
  const unattached = payments.filter((p) => !p.estimateId).length;

  console.log("Summary:");
  console.log(`  payments in window: ${payments.length}   shown: ${rows.length}`);
  console.log(`  ORPHANED (estimate deleted): ${orphans.length}   money stranded: ${money(orphanTotal)}`);
  console.log(`  unattached (never had an estimate): ${unattached}`);
  if (orphans.length > 0) {
    console.log("\n  An orphaned PAID payment is money the customer has handed over that no");
    console.log("  balance counts. Re-point its estimateId at the surviving estimate to fix it.");
  }
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
