/**
 * Pull Stripe Issuing card transactions into CardSpend (Kyle, 2026-09-09:
 * "photo verifies, card proves"). Runs inside the container:
 *
 *   railway ssh "node dist/scripts/syncCardSpend.js --days 30 [--dry]"
 *
 * --dry lists what would be ingested without writing. Ingest is idempotent
 * (upsert by transaction id), so re-running is safe. Until the restricted key
 * has Issuing read scope this prints the permission error and exits 0.
 */

import { PrismaClient } from "@prisma/client";
import { syncIssuingTransactions } from "../src/services/cardSpend";

const prisma = new PrismaClient();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const days = Number(arg("--days") ?? 30);
  const dry = process.argv.includes("--dry");
  console.log(`Card spend sync — last ${days} day(s)${dry ? " (DRY RUN — nothing written)" : ""} — ${new Date().toISOString()}`);

  const result = await syncIssuingTransactions(days, { dry });
  if (!result.available) {
    console.log(`  ! Issuing not readable: ${result.reason}`);
    return;
  }
  for (const t of result.transactions) {
    console.log(`  ${t.occurredAt.toISOString().slice(0, 16).replace("T", " ")}  ${t.id}  ${t.card}  ${t.merchant}  ${t.category ?? "—"}  $${t.amount.toFixed(2)}`);
  }
  if (dry) console.log(`\n${result.seen} transaction(s) would be ingested.`);
  else console.log(`\n${result.seen} seen · ${result.created} new · ${result.updated} refreshed.`);

  const unrouted = await prisma.cardSpend.count({ where: { truckId: null } });
  if (unrouted > 0) console.log(`  ! ${unrouted} spend row(s) are on a card no truck claims — map the card on the Trucks page.`);
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
