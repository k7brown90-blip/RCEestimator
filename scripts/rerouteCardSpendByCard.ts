/**
 * Move this month's card swipes onto the truck whose card made them (Kyle, 2026-11-15:
 * "The cards are already assigned to the trucks though"). Runs inside the container:
 *
 *   railway ssh -s RCEestimator "node dist/scripts/rerouteCardSpendByCard.js"          (dry — writes nothing)
 *   railway ssh -s RCEestimator "node dist/scripts/rerouteCardSpendByCard.js --apply"  (moves them)
 *
 * THIS SCRIPT IS A WRITER with --apply. Dry by default. The logic lives in
 * src/services/cardSpendReroute.ts; this is only the printing.
 */

import { prisma } from "../src/lib/prisma";
import { rerouteCardSpendByCard, type RerouteLine } from "../src/services/cardSpendReroute";

const chicago = (d: Date) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .format(d).replace(",", "");

function describe(line: RerouteLine): string {
  const head = `  ${chicago(line.occurredAt)}  ${line.merchant}  $${line.amount.toFixed(2)}`;
  const po = line.po ? `   PO ${line.po.number} (truck: ${line.po.truck ?? "none"}, purpose: ${line.po.purpose}, ${line.po.status})` : "";
  if (line.outcome === "moved") {
    const poLine = line.po
      ? `\n      ${line.poAction === "moved" ? `PO ${line.po.number} moves with it: ${line.po.truck ?? "none"} → ${line.toTruck}` : `PO ${line.po.number} stays: ${line.poNote}`} (truck: ${line.po.truck ?? "none"}, purpose: ${line.po.purpose})`
      : "";
    return `${head}\n      ${line.fromTruck ?? "no truck"} → ${line.toTruck}${poLine}`;
  }
  if (line.outcome === "card_unknown") return `${head}\n      card unknown — left where it is (${line.fromTruck ?? "no truck"})${po}\n      reason: ${line.reason}`;
  return `${head}\n      ${line.reason} — left where it is (${line.fromTruck ?? "no truck"})${po}`;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  console.log(`Re-route card spend by card${apply ? " — APPLYING" : " (DRY RUN — nothing written)"} — ${new Date().toISOString()}`);

  const report = await rerouteCardSpendByCard({ apply });
  console.log(`  month: ${report.monthLabel} (America/Chicago) — ${report.lines.length} card swipe(s)\n`);

  const moved = report.lines.filter((l) => l.outcome === "moved");
  const unknown = report.lines.filter((l) => l.outcome === "card_unknown");
  const noTruck = report.lines.filter((l) => l.outcome === "card_on_no_truck");
  console.log(apply ? "MOVED:" : "WOULD MOVE:");
  if (moved.length === 0) console.log("  (none)");
  for (const l of moved) console.log(describe(l));
  if (noTruck.length > 0) {
    console.log("\nCARD ON NO TRUCK (left where it is):");
    for (const l of noTruck) console.log(describe(l));
  }
  if (unknown.length > 0) {
    console.log("\nCARD UNKNOWN (left where it is):");
    for (const l of unknown) console.log(describe(l));
  }

  const c = report.counts;
  console.log(`\n${apply ? "Moved" : "Would move"} ${c.moved} · already right ${c.alreadyRight} · card unknown ${c.cardUnknown} · card on no truck ${c.cardOnNoTruck} · POs ${apply ? "moved" : "that would move"} ${report.posMoved}`);
  if (!apply && c.moved > 0) console.log("Nothing was written. Run again with --apply to move them.");
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
