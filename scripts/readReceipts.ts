/**
 * Reads the Receipt table — the audit path for "I photographed it and it never
 * showed up". Read-only: this script performs no writes.
 *
 * Answers, for a window of time: did the rows arrive at all, what captured
 * them, and are they wired to a PO / job / card spend — which is what separates
 * an upload failure from a fetch-or-display failure.
 *
 * Usage (against production):
 *   railway ssh -s RCEestimator "node dist/scripts/readReceipts.js [options]"
 *
 * Options:
 *   --since 24h|7d|30m        how far back, by receivedAt (default 24h)
 *   --on 2026-09-11           a single calendar day (America/Chicago), instead of --since
 *   --source tech_pwa         only this capture source (tech_pwa | mms | webhook | manual)
 *   --status pending_review   only this review status (pending_review | confirmed)
 *   --vendor "home depot"     vendor substring match (case-insensitive)
 *   --needs-po                only materials receipts with no purchaseOrderId
 *   --limit 50                max rows (default 50, newest first)
 *   --details                 print line items and the image/PO/card wiring per row
 *
 * Examples:
 *   railway ssh -s RCEestimator "node dist/scripts/readReceipts.js --on 2026-09-11 --details"
 *   railway ssh -s RCEestimator "node dist/scripts/readReceipts.js --since 7d --needs-po"
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
    console.error(`Invalid --since value "${raw}" — use forms like 30m, 24h, 7d.`);
    process.exit(1);
  }
  const n = Number(m[1]);
  const unitMs = m[2] === "m" ? 60_000 : m[2] === "h" ? 3_600_000 : 86_400_000;
  return new Date(Date.now() - n * unitMs);
}

/**
 * A calendar day in America/Chicago, which is the only frame Kyle reasons in.
 * CT is UTC-5 (CDT) or UTC-6 (CST), so midnight CT is 05:00Z or 06:00Z. Rather
 * than import a tz library, the window spans both: one hour before the earliest
 * possible midnight through one hour after the latest possible end. It is
 * deliberately an hour loose on each side — a receipt landing just outside the
 * day it was taken is what this script exists to surface, not hide.
 */
function parseDay(raw: string): { from: Date; to: Date } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    console.error(`Invalid --on value "${raw}" — use YYYY-MM-DD.`);
    process.exit(1);
  }
  const cdtMidnight = new Date(`${raw}T05:00:00Z`).getTime();
  return {
    from: new Date(cdtMidnight - 3_600_000),
    to: new Date(cdtMidnight + 26 * 3_600_000),
  };
}

function ct(d: Date): string {
  return d.toLocaleString("en-US", { timeZone: "America/Chicago" });
}

function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

async function main() {
  const on = arg("on");
  const day = on ? parseDay(on) : null;
  const since = parseSince(arg("since") ?? "24h");
  const source = arg("source");
  const status = arg("status");
  const vendor = arg("vendor");
  const needsPo = flag("needs-po");
  const limit = Math.min(Number(arg("limit") ?? 50), 500);
  const showDetails = flag("details");

  const window = day ? { gte: day.from, lt: day.to } : { gte: since };

  const receipts = await prisma.receipt.findMany({
    where: {
      receivedAt: window,
      ...(source ? { source } : {}),
      ...(status ? { status } : {}),
      ...(vendor ? { vendor: { contains: vendor, mode: "insensitive" } } : {}),
      ...(needsPo ? { purchaseOrderId: null, category: "materials" } : {}),
    },
    orderBy: { receivedAt: "desc" },
    take: limit,
    select: {
      id: true,
      receivedAt: true,
      createdAt: true,
      vendor: true,
      amount: true,
      category: true,
      source: true,
      status: true,
      jobId: true,
      purchaseOrderId: true,
      technicianId: true,
      imageMime: true,
      lineItems: true,
      // Bytes are never selected — only whether they are there, via a second
      // narrow query below. Pulling image blobs through here would move
      // megabytes per row for no diagnostic gain.
      purchaseOrder: { select: { number: true, status: true, purpose: true, afterTheFact: true } },
      cardSpend: { select: { id: true, amount: true, occurredAt: true, merchantName: true } },
    },
  });

  const label = on ? `${on} (CT)` : `the last ${arg("since") ?? "24h"}`;
  if (receipts.length === 0) {
    console.log(`No receipts in ${label}${needsPo ? " needing a PO" : ""}.`);
    console.log("\nA zero here with photos taken in the field means the uploads never landed —");
    console.log("the rows are not hiding behind a display bug, because there are no rows.");
    return;
  }

  // Whether the photo bytes are actually present, without transferring them:
  // selecting only `id` keeps the megabytes in the database where they belong.
  const withImage = new Set(
    (
      await prisma.receipt.findMany({
        where: { id: { in: receipts.map((r) => r.id) }, imageData: { not: null } },
        select: { id: true },
      })
    ).map((r) => r.id),
  );

  console.log(`${receipts.length} receipt(s) in ${label}, newest first:\n`);
  for (const r of receipts) {
    const po = r.purchaseOrder
      ? `${r.purchaseOrder.number} (${r.purchaseOrder.status}${r.purchaseOrder.afterTheFact ? ", after the fact" : ""})`
      : "NO PO";
    console.log(
      `${ct(r.receivedAt)} CT  ${money(r.amount).padStart(10)}  ${(r.vendor ?? "unknown vendor").padEnd(24)} ${r.category}/${r.status}`,
    );
    console.log(
      `  source=${r.source}  job=${r.jobId ?? "none"}  po=${po}  photo=${withImage.has(r.id) ? (r.imageMime ?? "yes") : "MISSING"}`,
    );
    if (showDetails) {
      console.log(`  id=${r.id}  uploaded=${ct(r.createdAt)} CT  technician=${r.technicianId ?? "none"}`);
      console.log(
        `  card=${r.cardSpend ? `${money(r.cardSpend.amount)} ${r.cardSpend.merchantName} ${ct(r.cardSpend.occurredAt)} CT` : "unmatched"}`,
      );
      if (r.purchaseOrder) console.log(`  po purpose=${r.purchaseOrder.purpose}`);
      if (r.lineItems) {
        try {
          const lines = JSON.parse(r.lineItems) as { name: string; qty: number | null; unitCost: number | null }[];
          console.log(`  ${lines.length} parsed line(s):`);
          for (const l of lines) console.log(`    ${l.qty ?? "?"} × ${l.name} @ ${l.unitCost ?? "?"}`);
        } catch {
          console.log(`  lineItems unparseable: ${r.lineItems.slice(0, 120)}`);
        }
      } else {
        console.log("  no parsed line items (Vision returned nothing, or values were keyed in by hand)");
      }
    }
    console.log();
  }

  const noPo = receipts.filter((r) => !r.purchaseOrderId).length;
  const noJob = receipts.filter((r) => !r.jobId).length;
  const noPhoto = receipts.filter((r) => !withImage.has(r.id)).length;
  const bySource = new Map<string, number>();
  for (const r of receipts) bySource.set(`${r.source}/${r.status}`, (bySource.get(`${r.source}/${r.status}`) ?? 0) + 1);

  console.log("Summary:", [...bySource.entries()].map(([k, v]) => `${k}: ${v}`).join(", "));
  console.log(`  no PO: ${noPo}   no job: ${noJob}   no photo bytes: ${noPhoto}   total: ${receipts.length}`);
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
