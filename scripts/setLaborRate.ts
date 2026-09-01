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
 * Safety: before writing anything, every flat row is recomputed at the CURRENT
 * rate and compared with what is stored. The 2026-09-01 dry run against the
 * real book showed three shapes that are not "hours × rate + material":
 *
 *   PENNY      The retired sheet stored material unrounded (e.g. $25.975) and
 *              summed before rounding; the import kept the sheet's cents. Off
 *              by ≤ $0.01. Informational — the rewrite rounds to cents.
 *   RATE-AS-MATERIAL
 *              The sheet's `=B*F` rows (Diagnostics, Circuit tracing,
 *              Demolition): labour-only work whose "material" column holds the
 *              hourly rate itself, so cost is null, companyPrice == the old
 *              rate and sell == hours × rate exactly. Left alone, the plain
 *              formula would bill $100 + $150 "material" = $250 for an hour of
 *              troubleshooting. These are converted to LABOR ONLY (companyPrice
 *              null) and sell at hours × rate, which is what they always meant.
 *   PER-DOLLAR Kyle's in-app GENERAL LABOR unit: 1/150 hr per unit so that one
 *              unit is $1.00 and he types dollars as the quantity. Kept at
 *              $1.00/unit by setting the hours to 1/newRate — the unit is a
 *              dollar, not a fraction of an hour.
 *   OTHER      Anything else — a hand-set or broken number this script must not
 *              silently overwrite. Listed in full; --apply refuses while any
 *              exist unless --force is also given.
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
const HOUR_FIELDS = ["laborNormal", "laborDifficult", "laborVeryDifficult"] as const;
type SellField = (typeof SELL_FIELDS)[number];
type HourField = (typeof HOUR_FIELDS)[number];
type Field = SellField | HourField | "rowType" | "companyPrice";

const PENNY = 0.011;
const round2 = (n: number) => Math.round(n * 100) / 100;
const money = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `$${n.toFixed(2)}`);
const near = (a: number | null, b: number | null, tol: number) =>
  (a === null && b === null) || (a !== null && b !== null && Math.abs(a - b) <= tol);

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

interface Row {
  itemId: string;
  description: string | null;
  source: string | null;
  rowType: string | null;
  companyCost: number | null;
  companyPrice: number | null;
  laborNormal: number | null;
  laborDifficult: number | null;
  laborVeryDifficult: number | null;
  sellNormal: number | null;
  sellDifficult: number | null;
  sellVeryDifficult: number | null;
}
type Shape = "FORMULA" | "PENNY" | "RATE-AS-MATERIAL" | "PER-DOLLAR" | "OTHER";
interface Audit { field: Field; oldValue: string | number | null; newValue: string | number | null }
interface Plan { row: Row; shape: Shape; audits: Audit[]; detail: string }

/** Which of the known shapes a stored row is, judged against the formula at the OLD rate. */
function classify(r: Row, oldRate: number | null): { shape: Shape; detail: string } {
  if (oldRate === null) return { shape: "OTHER", detail: "no current rate to check against" };
  const atOld = sellsAtRate(r, oldRate);
  const diffs = SELL_FIELDS.map((f) => (r[f] === null || atOld[f] === null ? (r[f] === atOld[f] ? 0 : Infinity) : Math.abs((r[f] as number) - (atOld[f] as number))));
  const worst = Math.max(...diffs);
  if (worst <= 0.0051) return { shape: "FORMULA", detail: "" };
  if (worst <= PENNY) return { shape: "PENNY", detail: `off by ≤ $0.01 (sheet summed before rounding)` };

  const type = (r.rowType ?? "").toUpperCase();
  const rateAsMaterial =
    r.companyCost === null &&
    r.companyPrice !== null && near(r.companyPrice, oldRate, 0.0051) &&
    !type.includes("LABOR ONLY") && !type.includes("MATERIAL ONLY") &&
    SELL_FIELDS.every((f, i) => r[f] === null ? r[HOUR_FIELDS[i]] === null : r[HOUR_FIELDS[i]] !== null && near(r[f], round2((r[HOUR_FIELDS[i]] as number) * oldRate), PENNY));
  if (rateAsMaterial) return { shape: "RATE-AS-MATERIAL", detail: `companyPrice ${money(r.companyPrice)} is the old rate; sells = hours × rate exactly` };

  const perDollar =
    type.includes("LABOR ONLY") &&
    HOUR_FIELDS.every((f) => r[f] !== null && Math.abs((r[f] as number) * oldRate - 1) < 0.001) &&
    SELL_FIELDS.every((f) => near(r[f], 1, 0.0051));
  if (perDollar) return { shape: "PER-DOLLAR", detail: `hours = 1/${oldRate} so one unit is $1.00` };

  return { shape: "OTHER", detail: `stored ${SELL_FIELDS.map((f) => money(r[f])).join("/")} vs formula ${SELL_FIELDS.map((f) => money(atOld[f])).join("/")}` };
}

function plan(r: Row, shape: Shape, oldRate: number | null, newRate: number): Audit[] {
  const audits: Audit[] = [];
  const setSells = (next: Record<SellField, number | null>) => {
    for (const f of SELL_FIELDS) if (!near(r[f], next[f], 0.0001)) audits.push({ field: f, oldValue: r[f], newValue: next[f] });
  };
  switch (shape) {
    case "RATE-AS-MATERIAL": {
      audits.push({ field: "rowType", oldValue: r.rowType, newValue: "LABOR ONLY" });
      audits.push({ field: "companyPrice", oldValue: r.companyPrice, newValue: null });
      setSells(sellsAtRate({ ...r, rowType: "LABOR ONLY", companyPrice: null }, newRate));
      return audits;
    }
    case "PER-DOLLAR": {
      const hours = Number((1 / newRate).toFixed(7));
      for (const f of HOUR_FIELDS) audits.push({ field: f, oldValue: r[f], newValue: hours });
      // 1/newRate × newRate is $1.00 by construction; write it as such rather than trust float dust.
      setSells({ sellNormal: 1, sellDifficult: 1, sellVeryDifficult: 1 });
      return audits;
    }
    case "FORMULA":
    case "PENNY":
    case "OTHER": {
      setSells(sellsAtRate(r, newRate));
      return audits;
    }
  }
  void oldRate;
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

  const rows = (await prisma.priceBookAtomic.findMany({ orderBy: { itemId: "asc" } })) as unknown as Row[];
  const flat = rows.filter((r) => SELL_FIELDS.some((f) => r[f] !== null));
  console.log(`${rows.length} rows in the book, ${flat.length} flat-priced (carry sell columns), ${rows.length - flat.length} supplier-priced (engine bills at the Rate Config cell).`);
  console.log("");

  const plans: Plan[] = flat.map((row) => {
    const { shape, detail } = classify(row, oldRate);
    return { row, shape, detail, audits: plan(row, shape, oldRate, newRate) };
  });
  const by = (s: Shape) => plans.filter((p) => p.shape === s);

  console.log(`Shapes found against hours × $${oldRate} + material:`);
  console.log(`   FORMULA           ${by("FORMULA").length} row(s) — match to the cent`);
  console.log(`   PENNY             ${by("PENNY").length} row(s) — off by ≤ $0.01, rewritten rounded to cents`);
  for (const p of by("PENNY").slice(0, 5)) console.log(`      e.g. ${p.row.itemId.padEnd(56)} ${SELL_FIELDS.map((f) => money(p.row[f])).join("/")}`);
  console.log(`   RATE-AS-MATERIAL  ${by("RATE-AS-MATERIAL").length} row(s) — converted to LABOR ONLY, sell = hours × rate`);
  for (const p of by("RATE-AS-MATERIAL")) console.log(`      ${p.row.itemId.padEnd(56)} ${(p.row.description ?? "").slice(0, 36).padEnd(36)} ${SELL_FIELDS.map((f) => money(p.row[f])).join("/")} → ${SELL_FIELDS.map((f) => money(p.audits.find((a) => a.field === f)?.newValue as number ?? p.row[f])).join("/")}`);
  console.log(`   PER-DOLLAR        ${by("PER-DOLLAR").length} row(s) — hours set to 1/${newRate} so one unit stays $1.00`);
  for (const p of by("PER-DOLLAR")) console.log(`      ${p.row.itemId.padEnd(56)} hours ${p.row.laborNormal} → ${p.audits.find((a) => a.field === "laborNormal")?.newValue}`);
  console.log(`   OTHER             ${by("OTHER").length} row(s) — do not match any known shape`);
  for (const p of by("OTHER")) console.log(`      ${p.row.itemId.padEnd(56)} ${(p.row.description ?? "").slice(0, 36).padEnd(36)} ${p.detail}`);
  console.log("");

  const changing = plans.filter((p) => p.audits.length > 0);
  console.log(`${changing.length} row(s) change; ${plans.length - changing.length} flat row(s) are unchanged (material-only rows, or no hours).`);
  console.log("Sample (first 12 and last 5):");
  const show = (p: Plan) => {
    const cell = (f: SellField) => {
      const a = p.audits.find((x) => x.field === f);
      return a ? `${money(a.oldValue as number | null)}→${money(a.newValue as number | null)}` : "·";
    };
    console.log(`   ${p.row.itemId.padEnd(48)} ${(p.row.description ?? "").slice(0, 36).padEnd(36)} N ${cell("sellNormal")}  D ${cell("sellDifficult")}  VD ${cell("sellVeryDifficult")}`);
  };
  changing.slice(0, 12).forEach(show);
  if (changing.length > 17) console.log("   …");
  changing.slice(Math.max(12, changing.length - 5)).forEach(show);
  console.log("");

  const openDrafts = await prisma.priceBookDraftEstimate.count({ where: { status: "draft" } });
  console.log(`${openDrafts} open draft(s) will have their rate snapshot set to $${newRate}/hr (issued estimates untouched).`);
  console.log("");

  if (!apply) {
    console.log("Dry run complete.");
    return;
  }
  if (by("OTHER").length > 0 && !force) {
    console.log("REFUSING to apply: rows of an unknown shape exist (OTHER above). Pass --force to overwrite them with the formula.");
    process.exitCode = 2;
    return;
  }

  // ── Write, audited ──
  if (cell) {
    await prisma.priceBookRateConfig.update({ where: { key: "billedLaborRate" }, data: { numberValue: newRate } });
  } else {
    await prisma.priceBookRateConfig.create({
      data: { key: "billedLaborRate", label: "Billed labor rate ($/hr)", workbookRow: 2, numberValue: newRate },
    });
  }
  console.log(`Rate Config billedLaborRate = ${newRate}`);

  const noteFor = (shape: Shape) => {
    const base = `Billed labour rate $${oldRate ?? "?"} → $${newRate}/hr (sell = hours × rate + material; material unchanged).`;
    switch (shape) {
      case "RATE-AS-MATERIAL": return `${base} This row was the sheet's =B*F shape — labour-only with the hourly rate in its material column — converted to LABOR ONLY so it bills hours × rate.`;
      case "PER-DOLLAR": return `${base} Per-dollar labour unit: hours set to 1/${newRate} so one unit stays $1.00.`;
      case "PENNY": return `${base} Stored value was the sheet's unrounded figure; now rounded to cents.`;
      default: return base;
    }
  };

  let written = 0;
  for (const p of changing) {
    const data: Record<string, unknown> = {};
    for (const a of p.audits) data[a.field] = a.newValue;
    await prisma.$transaction(async (tx) => {
      await tx.priceBookAtomic.update({ where: { itemId: p.row.itemId }, data });
      await tx.priceBookEdit.createMany({
        data: p.audits.map((a) => ({
          itemId: p.row.itemId,
          field: a.field,
          oldValue: a.oldValue === null ? null : String(a.oldValue),
          newValue: a.newValue === null ? null : String(a.newValue),
          editedBy: EDITED_BY,
          note: noteFor(p.shape),
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
