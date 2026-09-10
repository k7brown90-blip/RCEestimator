/**
 * Seed a truck's opening stock from history (Kyle, 2026-09-10).
 *
 * "Can you scan past receipts and purchases and completed jobs to populate the
 * truck stock on there now and I will fill in everything that is not there."
 *
 * Bought = every confirmed materials receipt's parsed line items, matched to
 * the price book by name (or kept as adhoc:<slug>). Used = the taken material
 * lines of signed, non-void estimates whose job is completed. Proposed on-hand
 * = bought − used, floored at 0, valued at the weighted purchase cost. Units
 * that disagree are NOT subtracted — flagged for Kyle instead.
 *
 *   railway ssh "node dist/scripts/seedTruckStockFromHistory.js"                          # dry run (default)
 *   railway ssh "node dist/scripts/seedTruckStockFromHistory.js --truck <id|name> --apply" # write
 *
 * --apply writes ONE "count" per key with a proposed on-hand > 0 through the
 * inventory service's count path (actor "system"). A level already holding
 * stock on that truck is skipped, so running twice cannot double up.
 */

import { prisma } from "../src/lib/prisma";
import { applyProposal, buildProposal, chooseTruck, loadBook, loadPurchases, loadUsage, SEED_REASON, type ProposalRow } from "../src/services/stockSeed";

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const APPLY = argv.includes("--apply");

const num = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));
const money = (n: number) => `$${n.toFixed(2)}`;
const pad = (s: string, w: number) => (s.length >= w ? s : s + " ".repeat(w - s.length));
const lpad = (s: string, w: number) => (s.length >= w ? s : " ".repeat(w - s.length) + s);

function printRow(r: ProposalRow): void {
  const bought = r.boughtQty > 0 ? `${num(r.boughtQty)} ${r.boughtUnit ?? ""}`.trim() : "-";
  const used = r.usedQty > 0 ? `${num(r.usedQty)} ${r.usedUnit ?? ""}`.trim() : "-";
  console.log(
    `${pad(r.key, 28)} | ${pad(r.name.slice(0, 40), 40)} | ${lpad(bought, 12)} | ${lpad(used, 12)} | ${lpad(num(r.proposedQty), 9)} | ${lpad(money(r.unitCost), 9)} | ${lpad(money(r.value), 10)} | ${pad(r.flags.join("; "), 60)} | ${r.receiptIds.map((id) => id.slice(-6)).join(",")}`,
  );
}

async function main(): Promise<void> {
  const truck = await chooseTruck(arg("--truck"));
  if (!truck) {
    console.error(arg("--truck") ? `No active truck matches "${arg("--truck")}".` : "No active truck exists.");
    process.exitCode = 2;
    return;
  }
  console.log(`Truck: ${truck.name} (${truck.id.slice(-6)}) — ${truck.how}\n`);

  const { book, byId } = await loadBook();
  const { purchases, notes, receiptCount } = await loadPurchases(book, byId);
  const { usages, estimateCount } = await loadUsage(byId);

  console.log(`Bought: ${receiptCount} confirmed materials receipt(s) → ${purchases.length} line(s)`);
  for (const p of purchases) {
    const how = p.match.kind === "itemId" ? "itemId" : p.match.kind === "name" ? `name match ${p.match.score.toFixed(2)}` : "adhoc (no match ≥ 0.50)";
    console.log(`  ${p.receiptId.slice(-6)}  ${pad(`${num(p.qty)} ${p.unit ?? ""}`.trim(), 10)} ${pad(p.name.slice(0, 44), 44)} → ${pad(p.key, 28)} ${how}${p.unitCost != null ? `  @ ${money(p.unitCost)}` : "  (no cost)"}`);
  }
  for (const n of notes) console.log(`  note: ${n}`);
  console.log(`\nUsed: ${estimateCount} signed estimate(s) on completed jobs → ${usages.length} material line(s)`);
  for (const u of usages) console.log(`  ${pad(u.estimateNumber, 14)} ${pad(`${num(u.qty)} ${u.unit ?? ""}`.trim(), 10)} ${u.name.slice(0, 44)} (${u.key})`);

  const rows = buildProposal(purchases, usages, byId);
  console.log(`\n${pad("key", 28)} | ${pad("name", 40)} | ${lpad("bought", 12)} | ${lpad("used", 12)} | ${lpad("proposed", 9)} | ${lpad("unit cost", 9)} | ${lpad("value", 10)} | ${pad("flags", 60)} | receipts`);
  console.log("-".repeat(200));
  for (const r of rows) printRow(r);

  const bookRows = rows.filter((r) => r.isBook).length;
  const flagged = rows.filter((r) => r.flags.length > 0).length;
  const toWrite = rows.filter((r) => r.proposedQty > 0);
  const totalValue = rows.reduce((s, r) => s + r.value, 0);
  console.log(`\n${rows.length} key(s): ${bookRows} price-book, ${rows.length - bookRows} adhoc; ${flagged} flagged; ${toWrite.length} with a proposed on-hand > 0; proposed value ${money(totalValue)}.`);

  if (toWrite.length === 0) {
    console.log("Nothing to count.");
    return;
  }
  if (!APPLY) {
    console.log(`\nDry run — ${toWrite.length} count(s) would be written to ${truck.name}. Add --apply to write.`);
    return;
  }
  const result = await applyProposal(truck.id, rows);
  for (const s of result.skipped) console.log(`  ${pad(s.key, 28)} already counted (${num(s.qtyOnHand)} on hand), skipped`);
  for (const w of result.written) console.log(`  ${pad(w.key, 28)} count ${num(w.qty)} @ ${money(w.unitCost)}  movement ${w.movementId.slice(-6)}`);
  console.log(`\nWrote ${result.written.length} count(s) to ${truck.name}, skipped ${result.skipped.length}. Reason: "${SEED_REASON}".`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
