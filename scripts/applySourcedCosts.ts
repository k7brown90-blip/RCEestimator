/**
 * Multi-source cost averages for the 2026-09-01 additions (Kyle: "source the
 * price from multiple locations and average that price for each line item").
 *
 * Every quote below was read from a retailer or supply-house listing on
 * 2026-09-01 and normalised to the item's unit (per foot from the coil price
 * and length; per each from single or case pricing). Short coils under 100 ft
 * and MC cable were excluded from AC rows. Averages are the plain mean of the
 * quotes listed — no weighting, no rounding until the final cent — and the
 * quotes themselves are written into the row's notes so any figure can be
 * traced back to where it came from.
 *
 * Writes through updateAtomic (audit row per change; sells recompute the
 * workbook's way). Dry-run by default; --apply writes.
 *
 *   railway ssh "node dist/scripts/applySourcedCosts.js"          # preview
 *   railway ssh "node dist/scripts/applySourcedCosts.js --apply"  # write
 */

import { PrismaClient } from "@prisma/client";
import { updateAtomic } from "../src/services/priceBookCatalog";

const prisma = new PrismaClient();
const EDITED_BY = "claude:cost-sourcing-2026-09-01";

interface Quote { source: string; unitCost: number; basis: string }
interface Target { itemId: string; quotes: Quote[]; caveat?: string }

const TARGETS: Target[] = [
  {
    itemId: "ac-cable-14-2-w-grd",
    quotes: [
      { source: "Home Depot — Southwire Armorlite 61029301", unitCost: 223.00 / 250, basis: "$223.00 / 250 ft" },
      { source: "Home Depot — AFC 1401N42", unitCost: 223.00 / 250, basis: "$223.00 / 250 ft" },
      { source: "Lowe's — Southwire Armorlite 61029301", unitCost: 177.00 / 250, basis: "$177.00 / 250 ft" },
    ],
  },
  {
    itemId: "ac-cable-14-3-w-grd",
    quotes: [
      { source: "Home Depot — AFC 1402N42", unitCost: 305.58 / 250, basis: "$305.58 / 250 ft" },
      { source: "Home Depot — Southwire Duraclad 55278501", unitCost: 325.80 / 250, basis: "$325.80 / 250 ft" },
      { source: "Cooper Electric — AFC 1402N42", unitCost: 1590.38 / 1000, basis: "$1,590.38 / 1,000 ft list" },
    ],
  },
  {
    itemId: "ac-cable-12-2-w-grd",
    quotes: [
      { source: "Home Depot — Southwire Armorlite 61023101", unitCost: 220.42 / 250, basis: "$220.42 / 250 ft" },
      { source: "Lowe's — Southwire Armorlite 61023101", unitCost: 228.00 / 250, basis: "$228.00 / 250 ft" },
      { source: "Lowe's — Southwire Duraclad 55274901", unitCost: 155.80 / 250, basis: "$155.80 / 250 ft" },
      { source: "Hemlock Hardware — Southwire 12/2 AC", unitCost: 199.99 / 250, basis: "$199.99 / 250 ft" },
    ],
  },
  {
    itemId: "ac-cable-12-3-w-grd",
    quotes: [
      { source: "Home Depot — Southwire Armorlite 61023201", unitCost: 314.83 / 250, basis: "$314.83 / 250 ft" },
      { source: "Home Depot — Southwire Duraclad 55275001", unitCost: 306.36 / 250, basis: "$306.36 / 250 ft" },
    ],
    caveat: "Two quotes (both Home Depot, two brands) — Lowe's and Walmart pages could not be read.",
  },
  {
    itemId: "ac-cable-10-2-w-grd",
    quotes: [
      { source: "Home Depot — AFC 1407N32", unitCost: 211.95 / 125, basis: "$211.95 / 125 ft" },
      { source: "Home Depot — Southwire Armorlite 61029805", unitCost: 218.05 / 125, basis: "$218.05 / 125 ft" },
      { source: "Lowe's — Southwire Armorlite 61029805", unitCost: 172.00 / 125, basis: "$172.00 / 125 ft" },
    ],
    caveat: "All three are 125-ft coils — the big-box stores do not stock 250 ft in 10/2 AC.",
  },
  {
    itemId: "ac-cable-10-3-w-grd",
    quotes: [
      { source: "Home Depot — AFC 1408N32", unitCost: 361.80 / 125, basis: "$361.80 / 125 ft" },
    ],
    caveat: "SINGLE SOURCE — the only AC 10/3 retail price readable on 2026-09-01; Lowe's Armorlite 61029903 exists but the page could not be read. Verify at the counter.",
  },
  {
    itemId: "steel-4-square-box-1-1-2-deep",
    quotes: [
      { source: "Hardware World — RACO 8190", unitCost: 2.55, basis: "$2.55 each" },
      { source: "Home Depot — Steel City 52151", unitCost: 2.67, basis: "$2.67 each" },
      { source: "Crown Supply — RACO 190", unitCost: 2.40, basis: "$2.40 each" },
      { source: "NorthEast Electrical — RACO 190", unitCost: 259.88 / 100, basis: "$259.88 / 100" },
      { source: "Cooper Electric — Steel City 52151", unitCost: 420.88 / 100, basis: "$420.88 / 100 list" },
    ],
    caveat: "Cooper's list price is well above the others (median of the five is $2.60).",
  },
  {
    itemId: "steel-4-square-box-2-1-8-deep",
    quotes: [
      { source: "Gross Electric — RACO 232", unitCost: 1.95, basis: "$1.95 each" },
      { source: "North Coast Electric — RACO 232", unitCost: 375.62 / 100, basis: "$375.62 / 100" },
      { source: "Home Depot — Steel City 521711234EW (case of 25)", unitCost: 3.98, basis: "$3.98 each" },
    ],
  },
  {
    itemId: "steel-4-square-industrial-cover-1-gang",
    quotes: [
      { source: "Home Depot — RACO 8772", unitCost: 1.56, basis: "$1.56 each" },
      { source: "McCoy's — RACO 8772", unitCost: 1.89, basis: "$1.89 each" },
      { source: "Shell Lumber — RACO 8772", unitCost: 1.79, basis: "$1.79 each" },
      { source: "Cooper Electric — Steel City 52C13", unitCost: 239.21 / 100, basis: "$239.21 / 100" },
    ],
  },
  {
    itemId: "steel-4-square-industrial-cover-2-gang",
    quotes: [
      { source: "Ace Hardware — RACO 804C", unitCost: 3.59, basis: "$3.59 each" },
      { source: "NorthEast Electrical — RACO 804C", unitCost: 429.29 / 100, basis: "$429.29 / 100" },
      { source: "North Coast Electric — Steel City 52C17", unitCost: 597.22 / 100, basis: "$597.22 / 100" },
    ],
    caveat: "804C is the raised blank exposed-work cover; 52C17 is the 2-device ring — same price class, confirm which you stock.",
  },
  {
    itemId: "steel-4-square-blank-cover",
    quotes: [
      { source: "Home Depot — RACO 8752 (50-pack)", unitCost: 24.17 / 50, basis: "$24.17 / 50" },
      { source: "eBay — RACO 8752", unitCost: 1.00, basis: "$1.00 each" },
      { source: "Hardware & Tools — RACO 8752", unitCost: 1.49, basis: "$1.49 each (sale)" },
      { source: "Max Warehouse — RACO 8752", unitCost: 0.895, basis: "$0.80–0.99 each, midpoint" },
    ],
  },
];

const round2 = (n: number) => Math.round(n * 100) / 100;
const money = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `$${n.toFixed(2)}`);

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  console.log(apply ? "APPLYING multi-source cost averages" : "DRY RUN — no writes (pass --apply to write)");
  console.log("");
  let changed = 0;
  for (const t of TARGETS) {
    // createAtomic upper-cases every itemId it stores (the book's own ID scheme), so the rows
    // added on 2026-09-01 live as AC-CABLE-14-2-W-GRD etc. Match that, or nothing is found.
    const itemId = t.itemId.toUpperCase();
    const before = await prisma.priceBookAtomic.findUnique({
      where: { itemId },
      select: { itemId: true, description: true, unitLabel: true, companyCost: true, notes: true, sellNormal: true, sellDifficult: true, sellVeryDifficult: true, markupTier: true },
    });
    if (!before) {
      console.log(`!! ${itemId}: NOT FOUND — skipped`);
      continue;
    }
    const avg = round2(t.quotes.reduce((s, q) => s + q.unitCost, 0) / t.quotes.length);
    console.log(`${before.description}  [${itemId}]  per ${before.unitLabel}`);
    for (const q of t.quotes) console.log(`   ${money(q.unitCost)}  ${q.source}  (${q.basis})`);
    console.log(`   average of ${t.quotes.length}: ${money(avg)}   (was ${money(before.companyCost)})${t.caveat ? `\n   note: ${t.caveat}` : ""}`);
    const quoteLine =
      `Cost = average of ${t.quotes.length} quote${t.quotes.length === 1 ? "" : "s"} read 2026-09-01: ` +
      t.quotes.map((q) => `${q.source} ${q.basis} = ${money(q.unitCost)}`).join("; ") +
      `.${t.caveat ? ` ${t.caveat}` : ""}`;
    // Keep the labor citation that is already in the notes; replace any earlier cost sentence.
    const priorNotes = (before.notes ?? "")
      .split(/(?<=\.)\s+/)
      .filter((s) => !/^Cost[: ]/.test(s) && !/^COST NOT SET/.test(s) && !/^No .*price/.test(s))
      .join(" ")
      .trim();
    const notes = `${quoteLine}${priorNotes ? ` ${priorNotes}` : ""}`;
    if (apply) {
      const result = await updateAtomic(prisma, itemId, { companyCost: avg, notes }, EDITED_BY);
      if (!result.ok) {
        console.log(`   !! update refused: ${result.reason}`);
      } else {
        const a = result.atomic as { markupTier: string | null; companyPrice: number | null; sellNormal: number | null; sellDifficult: number | null; sellVeryDifficult: number | null };
        console.log(`   → tier ${a.markupTier ?? "—"}, material w/ markup ${money(a.companyPrice)}, sell N/D/VD ${money(a.sellNormal)} / ${money(a.sellDifficult)} / ${money(a.sellVeryDifficult)}`);
        changed += 1;
      }
    }
    console.log("");
  }
  console.log(apply ? `Done — ${changed} item(s) updated; each change is in PriceBookEdit as ${EDITED_BY}.` : "Dry run complete.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
