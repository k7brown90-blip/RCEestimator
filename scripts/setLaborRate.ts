/**
 * Commit a new billed labour rate across the whole book.
 *
 * Kyle, 2026-09-01: "I want to drop the labor rate to $100 an hour. This is a
 * better market rate for this area and I want to commit to it now."
 *
 * The rate is one number that lives in three places, and they have to move
 * together or the book contradicts itself:
 *
 *   1. Rate Config `billedLaborRate` — what the engine bills supplier-priced
 *      labour at, and how it splits a flat-priced row into its internal
 *      labour + material halves (labour = hours × rate; material = the rest).
 *   2. Every flat-priced row's sell columns — sell_d = hours_d × rate + material,
 *      the book's own formula (priceBookCatalog.sellsAtRate). Material is not
 *      touched: cost, tier and marked-up material stay exactly as they are.
 *      Each changed column is a PriceBookEdit row, so any price a customer
 *      asks about still has its story.
 *   3. Open drafts' rate snapshot (status "draft") — informational, kept honest
 *      so the builder does not show a stale $150 beside prices built at $100.
 *
 * Issued estimates are frozen and untouched: a sent price stays sent.
 *
 * Safety: the dry run recomputes every row at the CURRENT rate first and lists
 * any row whose stored sells do not match the formula — those are hand-set or
 * broken numbers this script must not silently paper over. --apply refuses
 * while any exist unless --force is also given.
 *
 *   node dist/scripts/setLaborRate.js                 dry run at RULED_BILLED_RATE
 *   node dist/scripts/setLaborRate.js --rate 100      dry run at an explicit rate
 *   node dist/scripts/setLaborRate.js --rate 100 --apply
 */

import { PrismaClient } from "@prisma/client";
import { RULED_BILLED_RATE } from "../src/services/laborRate";
import { sellsAtRate } from "../src/services/priceBookCatalog";

const prisma = new PrismaClient();
const EDITED_BY = "claude:labor-rate-2026-09-01";
const SELL_FIELDS = ["sellNormal", "sellDifficult", "sellVeryDifficult"] as const;
type SellField = (typeof SELL_FIELDS)[number];

const money = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `$${n.toFixed(2)}`);
const same = (a: number | null, b: number | null) =>
  (a === null && b === null) || (a !== null && b !== null && Math.abs(a - b) < 0.005);

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const force = process.argv.includes("--force");
  const newRate = Number(arg("rate") ?? RULED_BILLED_RATE);
  if (!Number.isFinite(newRate) || newRate <= 0) throw new Error(`Bad --rate ${arg("rate")}`);

  const cell = await prisma.priceBookRateConfig.findUnique({ where: { key: "billedLaborRate" } });
  const oldRate = cell?.numberValue ?? null;
  console.log(apply ? "APPLYING labour rate change" : "DRY RUN — no writes (pass --apply to write)");
  console.log(`Rate Config billedLaborRate: ${oldRate === null ? "blank" : `$${oldRate}/hr`} → $${newRate}/hr`);
  console.log(`Ruling in code (RULED_BILLED_RATE): $${RULED_BILLED_RATE}/hr${newRate !== RULED_BILLED_RATE ? "  !! differs from --rate; estimates will read PROVISIONAL" : ""}`);
  console.log("");

  const rows = await prisma.priceBookAtomic.findMany({ orderBy: { itemId: "asc" } });
  const flat = rows.filter((r) => SELL_FIELDS.some((f) => r[f] !== null));
  console.log(`${rows.length} rows in the book, ${flat.length} flat-priced (carry sell columns), ${rows.length - flat.length} supplier-priced (engine bills at the Rate Config cell).`);

  // ── Step 1: does every stored sell equal the formula at the OLD rate? ──
  const mismatches: Array<{ itemId: string; field: SellField; stored: number | null; formula: number | null }> = [];
  if (oldRate !== null) {
    for (const r of flat) {
      const atOld = sellsAtRate(r, oldRate);
      for (const f of SELL_FIELDS) if (!same(r[f], atOld[f])) mismatches.push({ itemId: r.itemId, field: f, stored: r[f], formula: atOld[f] });
    }
  }
  if (mismatches.length > 0) {
    console.log(`!! ${mismatches.length} sell column(s) on ${new Set(mismatches.map((m) => m.itemId)).size} row(s) do NOT equal hours × $${oldRate} + material today:`);
    for (const m of mismatches.slice(0, 40)) console.log(`   ${m.itemId.padEnd(48)} ${m.field.padEnd(18)} stored ${money(m.stored)}  formula ${money(m.formula)}`);
    if (mismatches.length > 40) console.log(`   … ${mismatches.length - 40} more`);
    console.log("   These would be overwritten by the formula at the new rate. Review before --apply (--force to proceed).");
    console.log("");
  } else if (oldRate !== null) {
    console.log(`Every flat row's sells equal hours × $${oldRate} + material today — the book is consistent with the formula.`);
    console.log("");
  }

  // ── Step 2: the changes ──
  const changes: Array<{ itemId: string; description: string | null; audits: Array<{ field: SellField; oldValue: number | null; newValue: number | null }> }> = [];
  for (const r of flat) {
    const next = sellsAtRate(r, newRate);
    const audits = SELL_FIELDS.filter((f) => !same(r[f], next[f])).map((f) => ({ field: f, oldValue: r[f], newValue: next[f] }));
    if (audits.length > 0) changes.push({ itemId: r.itemId, description: r.description, audits });
  }
  console.log(`${changes.length} row(s) change; ${flat.length - changes.length} flat row(s) are unchanged (material-only rows, or no hours).`);
  console.log("Sample (first 15 and last 5):");
  const show = (c: (typeof changes)[number]) => {
    const cell = (f: SellField) => {
      const a = c.audits.find((x) => x.field === f);
      return a ? `${money(a.oldValue)}→${money(a.newValue)}` : "·";
    };
    console.log(`   ${c.itemId.padEnd(48)} ${(c.description ?? "").slice(0, 40).padEnd(40)} N ${cell("sellNormal")}  D ${cell("sellDifficult")}  VD ${cell("sellVeryDifficult")}`);
  };
  changes.slice(0, 15).forEach(show);
  if (changes.length > 20) console.log("   …");
  changes.slice(Math.max(15, changes.length - 5)).forEach(show);
  console.log("");

  const openDrafts = await prisma.priceBookDraftEstimate.count({ where: { status: "draft" } });
  console.log(`${openDrafts} open draft(s) will have their rate snapshot set to $${newRate}/hr (issued estimates untouched).`);
  console.log("");

  if (!apply) {
    console.log("Dry run complete.");
    return;
  }
  if (mismatches.length > 0 && !force) {
    console.log("REFUSING to apply: stored sells that do not match the formula exist (see above). Pass --force to overwrite them.");
    process.exitCode = 2;
    return;
  }

  // ── Step 3: write, audited ──
  if (cell) {
    await prisma.priceBookRateConfig.update({ where: { key: "billedLaborRate" }, data: { numberValue: newRate } });
  } else {
    await prisma.priceBookRateConfig.create({
      data: { key: "billedLaborRate", label: "Billed labor rate ($/hr)", workbookRow: 2, numberValue: newRate },
    });
  }
  console.log(`Rate Config billedLaborRate = ${newRate}`);

  let written = 0;
  for (const c of changes) {
    const data: Partial<Record<SellField, number | null>> = {};
    for (const a of c.audits) data[a.field] = a.newValue;
    await prisma.$transaction(async (tx) => {
      await tx.priceBookAtomic.update({ where: { itemId: c.itemId }, data });
      await tx.priceBookEdit.createMany({
        data: c.audits.map((a) => ({
          itemId: c.itemId,
          field: a.field,
          oldValue: a.oldValue === null ? null : String(a.oldValue),
          newValue: a.newValue === null ? null : String(a.newValue),
          editedBy: EDITED_BY,
          note: `Billed labour rate $${oldRate ?? "?"} → $${newRate}/hr (sell = hours × rate + material; material unchanged).`,
        })),
      });
    });
    written += 1;
  }
  console.log(`${written} row(s) updated; every changed column is in PriceBookEdit as ${EDITED_BY}.`);

  const drafts = await prisma.priceBookDraftEstimate.updateMany({
    where: { status: "draft" },
    data: { billedLaborRate: newRate, rateProvisional: newRate !== RULED_BILLED_RATE, provisionalReason: null },
  });
  console.log(`${drafts.count} open draft(s) re-snapshotted at $${newRate}/hr.`);
  console.log("Done.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
