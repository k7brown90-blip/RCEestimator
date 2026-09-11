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
import { syncCardSpend } from "../src/services/cardSpend";

const prisma = new PrismaClient();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const days = Number(arg("--days") ?? 30);
  const dry = process.argv.includes("--dry");
  console.log(`Card spend sync — last ${days} day(s)${dry ? " (DRY RUN — nothing written)" : ""} — ${new Date().toISOString()}`);

  const result = await syncCardSpend(days, { dry });
  const feed = result.feeds.financialAccounts;
  console.log(`  financial accounts: ${feed.available ? `${feed.seen} seen · ${feed.created} new · ${feed.updated} refreshed · ${feed.voided} voided` : `not readable — ${feed.reason}`}`);
  const issuing = result.feeds.issuing;
  console.log(`  issuing: ${issuing == null ? "skipped (not enabled on this account)" : issuing.available ? `${issuing.seen} seen · ${issuing.created} new` : `not readable — ${issuing.reason}`}`);
  if (!result.available) return;
  for (const t of result.transactions) {
    console.log(`  ${t.occurredAt.toISOString().slice(0, 16).replace("T", " ")}  ${t.id.slice(0, 14)}…  ${t.card.slice(0, 14)}…  ${t.merchant}  ${t.category ?? "—"}  $${t.amount.toFixed(2)}${t.settlement && t.settlement !== "posted" ? `  (${t.settlement})` : ""}`);
  }
  if (dry) console.log(`\n${result.seen} transaction(s) would be ingested.`);
  else console.log(`\n${result.seen} seen · ${result.created} new · ${result.updated} refreshed · ${result.voided} voided.`);

  const unrouted = await prisma.cardSpend.count({ where: { truckId: null } });
  if (unrouted > 0) console.log(`  ! ${unrouted} spend row(s) are on a card no truck claims — map the card on the Trucks page.`);
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
