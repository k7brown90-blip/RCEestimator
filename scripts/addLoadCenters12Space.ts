/**
 * Add the 12-space outdoor load centers the book was missing (Kyle,
 * 2026-09-01: "I just don't have a 100 amp 12 space in the price book. We
 * should add that in now." — the shop panel on 2026-1039 needs a back-fed
 * 60 A main plus seven poles of circuits, which a 4-space cannot hold).
 *
 * Two rows, because the two ways to build that panel are different SKUs:
 *   - 100 A, 12/24, OUTDOOR, MAIN BREAKER (Homeline HOM1224M100PRB class) —
 *     the breaker is the building disconnect; no hold-down or SUSE question.
 *   - 125 A, 12/24, OUTDOOR, MAIN LUG (Homeline HOM1224L125PRB class) — for the
 *     back-fed-breaker design. Homeline's outdoor 12-space main-lug is rated
 *     125 A; there is no stocked 100 A version, so this is the main-lug option.
 *
 * Labor: NECA MLU 2019-20 p.265, "Panelboard Empty Enclosure - Interior and
 * Cover Mounting Labor - Surface Mounted", 16-circuit row (the smallest
 * listed; a 12-space panel): 100 A = 2.00 / 2.50 / 3.00, 125 A = 2.20 / 2.75 /
 * 3.30. Cost = plain mean of the retailer / supply-house quotes read
 * 2026-09-01, all listed in the notes (Kyle's multi-source rule).
 *
 * Writes through createAtomic (audit row per item); upper-cased id check so a
 * re-run cannot duplicate. Dry-run by default; --apply writes.
 */

import { PrismaClient } from "@prisma/client";
import { createAtomic, type CreateAtomicInput } from "../src/services/priceBookCatalog";

const prisma = new PrismaClient();
const EDITED_BY = "claude:catalog-add-2026-09-01";
const CATEGORY = "LOAD CENTERS / PANELS (Square D Homeline)";

interface Quote { source: string; price: number }
const round2 = (n: number) => Math.round(n * 100) / 100;
const mean = (qs: Quote[]) => round2(qs.reduce((s, q) => s + q.price, 0) / qs.length);
const money = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `$${n.toFixed(2)}`);
const quoteNote = (qs: Quote[]) =>
  `Cost = average of ${qs.length} quotes read 2026-09-01: ${qs.map((q) => `${q.source} ${money(q.price)}`).join("; ")}.`;

const MB_QUOTES: Quote[] = [
  { source: "Home Depot — Square D HOM1224M100PRB", price: 147.11 },
  { source: "Blackhawk Supply — HOM1224M100PRB", price: 139.15 },
  { source: "Keep Supply — HOM1224M100PRB", price: 133.43 },
  { source: "RSP Supply — HOM1224M100PRB", price: 163.24 },
  { source: "Walmart — HOM1224M100PRB", price: 177.10 },
  { source: "Standard Electric Supply — HOM1224M100PRB (list)", price: 275.77 },
];
const ML_QUOTES: Quote[] = [
  { source: "Ace Hardware — Square D HOM1224L125PRB", price: 109.99 },
  { source: "Kellogg Supply — HOM1224L125PRB", price: 114.99 },
  { source: "Capital Electric Supply — HOM1224L125PRB", price: 123.08 },
  { source: "Cooper Electric — HOM1224L125PRB (list)", price: 300.24 },
];

const ITEMS: CreateAtomicInput[] = [
  {
    itemId: "load-center-100a-12-space-24-circuit-outdoor-main-breaker",
    description: "Load Center, 100A, 12-Space/24-Circuit, OUTDOOR, Main Breaker",
    category: CATEGORY, unitLabel: "each", rowType: "MATERIAL + LABOR",
    companyCost: mean(MB_QUOTES),
    laborNormal: 2.0, laborDifficult: 2.5, laborVeryDifficult: 3.0,
    notes:
      `${quoteNote(MB_QUOTES)} Median of the six is ~$155; Standard Electric's list price pulls the average up. ` +
      `Labor: NECA MLU 2019-20 p.265, panelboard enclosure surface-mounted 100 A, 16-circuit row 2.00/2.50/3.00. ` +
      `NEMA 3R, plug-on neutral; main breaker serves as the building disconnect (no back-fed hold-down needed).`,
  },
  {
    itemId: "load-center-125a-12-space-24-circuit-outdoor-main-lug",
    description: "Load Center, 125A, 12-Space/24-Circuit, OUTDOOR, Main Lug",
    category: CATEGORY, unitLabel: "each", rowType: "MATERIAL + LABOR",
    companyCost: mean(ML_QUOTES),
    laborNormal: 2.2, laborDifficult: 2.75, laborVeryDifficult: 3.3,
    notes:
      `${quoteNote(ML_QUOTES)} Median of the four is ~$119; Cooper's list price pulls the average up. ` +
      `Labor: NECA MLU 2019-20 p.265, panelboard enclosure surface-mounted 125 A, 16-circuit row 2.20/2.75/3.30. ` +
      `NEMA 3R main-lug — the back-fed-breaker option (needs the hold-down kit, 408.36(D)); Homeline's outdoor 12-space main-lug is 125 A-rated, no 100 A version is stocked.`,
  },
];

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  console.log(apply ? "ADDING load centers" : "DRY RUN — no writes (pass --apply to write)");
  console.log("");
  let created = 0;
  for (const item of ITEMS) {
    const storedId = item.itemId!.toUpperCase(); // createAtomic upper-cases the id it stores
    const existing = await prisma.priceBookAtomic.findUnique({ where: { itemId: storedId }, select: { itemId: true } });
    console.log(`${item.description}  [${storedId}]`);
    console.log(`   cost ${money(item.companyCost)} · hours N/D/VD ${item.laborNormal} / ${item.laborDifficult} / ${item.laborVeryDifficult}`);
    if (existing) {
      console.log("   already in the book — skipped");
      console.log("");
      continue;
    }
    if (apply) {
      const result = await createAtomic(prisma, item, EDITED_BY);
      if (!result.ok) {
        console.log(`   !! refused: ${result.reason}`);
      } else {
        const a = result.atomic as { markupTier: string | null; companyPrice: number | null; sellNormal: number | null; sellDifficult: number | null; sellVeryDifficult: number | null };
        console.log(`   created — tier ${a.markupTier ?? "—"}, material w/ markup ${money(a.companyPrice)}, sell N/D/VD ${money(a.sellNormal)} / ${money(a.sellDifficult)} / ${money(a.sellVeryDifficult)}`);
        created += 1;
      }
    }
    console.log("");
  }
  console.log(apply ? `Done — ${created} item(s) created by ${EDITED_BY}.` : "Dry run complete.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
