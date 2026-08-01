/**
 * Reads the SystemEvent log — the audit path for diagnosing production.
 *
 * Usage (against production):
 *   railway run npx tsx scripts/readSystemEvents.ts [options]
 *
 * Options:
 *   --level error|warn|info   only this level
 *   --source twilio           only this source (express | twilio | feedback | ...)
 *   --since 24h|7d|30m        how far back (default 24h)
 *   --search "text"           message substring match (case-insensitive)
 *   --limit 50                max rows (default 50, newest first)
 *   --details                 print full detailsJson (stack traces etc.)
 *
 * Examples:
 *   railway run npx tsx scripts/readSystemEvents.ts --level error --since 7d
 *   railway run npx tsx scripts/readSystemEvents.ts --source feedback --details
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

async function main() {
  const level = arg("level");
  const source = arg("source");
  const since = parseSince(arg("since") ?? "24h");
  const search = arg("search");
  const limit = Math.min(Number(arg("limit") ?? 50), 500);
  const showDetails = flag("details");

  const events = await prisma.systemEvent.findMany({
    where: {
      createdAt: { gte: since },
      ...(level ? { level } : {}),
      ...(source ? { source } : {}),
      ...(search ? { message: { contains: search, mode: "insensitive" } } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  if (events.length === 0) {
    console.log("No matching events.");
    return;
  }

  console.log(`${events.length} event(s), newest first:\n`);
  for (const e of events) {
    const ts = e.createdAt.toLocaleString("en-US", { timeZone: "America/Chicago" });
    const levelTag = e.level.toUpperCase().padEnd(5);
    console.log(`${ts} CT  ${levelTag} [${e.source}]${e.route ? ` ${e.route}` : ""}`);
    console.log(`  ${e.message}`);
    if (showDetails && e.detailsJson) {
      try {
        console.log(`  ${JSON.stringify(JSON.parse(e.detailsJson), null, 2).split("\n").join("\n  ")}`);
      } catch {
        console.log(`  ${e.detailsJson}`);
      }
    }
    console.log();
  }

  // Quick summary by source for orientation
  const bySource = new Map<string, number>();
  for (const e of events) bySource.set(`${e.level}/${e.source}`, (bySource.get(`${e.level}/${e.source}`) ?? 0) + 1);
  console.log("Summary:", [...bySource.entries()].map(([k, v]) => `${k}: ${v}`).join(", "));
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
