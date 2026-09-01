/**
 * Add AC (BX) cable, steel 4-inch square boxes and industrial covers to the
 * price book (Kyle, 2026-09-01: "We need A/C cable added to the price book as
 * well along with the metal 4 square boxes and industrial covers." — the gap
 * that had him marking nail-on boxes VERY_DIFFICULT to cover the metal box
 * and cover he was actually installing).
 *
 * Labor units are the NECA Manual of Labor Units 2019-2020, cited per row:
 *   - AC cable: p.138 "600 Volt AC Cable with Aluminum or Steel Armor -
 *     Copper", per M ft (Normal / Difficult / Very Difficult). NECA lists no
 *     #14 AC; the #14 rows use the adjacent MC table's #14-2-G / #14-3-G units
 *     (same page) and say so in their notes.
 *   - 4-inch square boxes: p.179 "4-inch Square Boxes" 30 / 35 / 40 per C.
 *   - Covers: p.179 "Box Covers - All Types" 17.5 / 22 / 27.5 per C.
 *
 * Costs are REAL retail prices captured 2026-09-01 with the source in each
 * row's notes. Where no single-unit price could be verified the cost is left
 * NULL — the editor shows "awaiting cost" and the sell is labor-only until
 * Kyle enters it. Nothing here is estimated.
 *
 * Writes through createAtomic (audit row per item). Idempotent: an itemId that
 * already exists is reported and skipped. Dry-run by default; --apply writes.
 *
 *   railway ssh "node dist/scripts/addAcCableAndSquareBoxes.js"          # preview
 *   railway ssh "node dist/scripts/addAcCableAndSquareBoxes.js --apply"  # write
 */

import { PrismaClient } from "@prisma/client";
import { createAtomic, type CreateAtomicInput } from "../src/services/priceBookCatalog";

const prisma = new PrismaClient();
const EDITED_BY = "claude:catalog-add-2026-09-01";
const PRICED = "priced 2026-09-01";
const NECA_AC = "Labor: NECA MLU 2019-20 p.138, 600 V AC cable w/ armor, copper";
const NECA_MC14 = "Labor: NECA MLU 2019-20 p.138 — no #14 AC row published; MC #14";
const NECA_BOX = "Labor: NECA MLU 2019-20 p.179, 4-inch Square Boxes 30/35/40 per C";
const NECA_COVER = "Labor: NECA MLU 2019-20 p.179, Box Covers - All Types 17.5/22/27.5 per C";
const NO_COST = "COST NOT SET — enter company cost before quoting.";

const ITEMS: CreateAtomicInput[] = [
  // ── AC (BX) cable, per foot ──────────────────────────────────────────────
  {
    itemId: "ac-cable-14-2-w-grd", description: "AC Cable (BX) 14/2 w/Grd", category: "AC CABLE (per foot)", subCategory: "AC/BX Armored Cable",
    unitLabel: "ft", rowType: "MATERIAL + LABOR", companyCost: 0.89,
    laborNormal: 0.025, laborDifficult: 0.03125, laborVeryDifficult: 0.03906,
    notes: `Cost: Home Depot Southwire Armorlite 14/2 x 250 ft #61029301 $223.00 = $0.89/ft (${PRICED}). ${NECA_MC14}-2-G solid 25/31.25/39.06 per M ft.`,
  },
  {
    itemId: "ac-cable-14-3-w-grd", description: "AC Cable (BX) 14/3 w/Grd", category: "AC CABLE (per foot)", subCategory: "AC/BX Armored Cable",
    unitLabel: "ft", rowType: "MATERIAL + LABOR", companyCost: null,
    laborNormal: 0.027, laborDifficult: 0.03375, laborVeryDifficult: 0.04219,
    notes: `${NO_COST} No 250-ft single-unit price verified 2026-09-01 (Lowe's Duraclad 14/3 #55278501 exists — read the shelf price). ${NECA_MC14}-3-G solid 27/33.75/42.19 per M ft.`,
  },
  {
    itemId: "ac-cable-12-2-w-grd", description: "AC Cable (BX) 12/2 w/Grd", category: "AC CABLE (per foot)", subCategory: "AC/BX Armored Cable",
    unitLabel: "ft", rowType: "MATERIAL + LABOR", companyCost: 0.88,
    laborNormal: 0.0265, laborDifficult: 0.03313, laborVeryDifficult: 0.04141,
    notes: `Cost: Home Depot Southwire Armorlite 12/2 x 250 ft #61023101 $220.42 = $0.88/ft (${PRICED}). ${NECA_AC} #12-2-G solid 26.5/33.13/41.41 per M ft.`,
  },
  {
    itemId: "ac-cable-12-3-w-grd", description: "AC Cable (BX) 12/3 w/Grd", category: "AC CABLE (per foot)", subCategory: "AC/BX Armored Cable",
    unitLabel: "ft", rowType: "MATERIAL + LABOR", companyCost: 1.26,
    laborNormal: 0.0285, laborDifficult: 0.03563, laborVeryDifficult: 0.04453,
    notes: `Cost: Home Depot Southwire Armorlite 12/3 x 250 ft #61023201 $314.83 = $1.26/ft (${PRICED}; Duraclad steel 12/3 #55275001 was $299 = $1.20/ft). ${NECA_AC} #12-3-G solid 28.5/35.63/44.53 per M ft.`,
  },
  {
    itemId: "ac-cable-10-2-w-grd", description: "AC Cable (BX) 10/2 w/Grd", category: "AC CABLE (per foot)", subCategory: "AC/BX Armored Cable",
    unitLabel: "ft", rowType: "MATERIAL + LABOR", companyCost: 1.70,
    laborNormal: 0.0295, laborDifficult: 0.03688, laborVeryDifficult: 0.04609,
    notes: `Cost: Home Depot AFC Cable Systems 10/2 x 125 ft BX/AC-90 #1407N32 $211.95 = $1.70/ft (${PRICED}; 125-ft coil — a 250-ft coil will run lower per foot). ${NECA_AC} #10-2-G solid 29.5/36.88/46.09 per M ft.`,
  },
  {
    itemId: "ac-cable-10-3-w-grd", description: "AC Cable (BX) 10/3 w/Grd", category: "AC CABLE (per foot)", subCategory: "AC/BX Armored Cable",
    unitLabel: "ft", rowType: "MATERIAL + LABOR", companyCost: null,
    laborNormal: 0.0325, laborDifficult: 0.04063, laborVeryDifficult: 0.05078,
    notes: `${NO_COST} No AC 10/3 retail price verified 2026-09-01 (Lowe's carries MC 10/3 #68584201; AC 10/3 may be a special order). ${NECA_AC} #10-3-G solid 32.5/40.63/50.78 per M ft.`,
  },
  // ── Steel 4-inch square boxes, per each ──────────────────────────────────
  {
    itemId: "steel-4-square-box-1-1-2-deep", description: "4-inch Square Box, Steel, 1-1/2-inch Deep (21 cu in)", category: "METAL BOXES & COVERS", subCategory: "4-inch Square",
    unitLabel: "each", rowType: "MATERIAL + LABOR", companyCost: null,
    laborNormal: 0.30, laborDifficult: 0.35, laborVeryDifficult: 0.40,
    notes: `${NO_COST} RACO 8190 (HD #100538643) — single-unit price not retrievable online 2026-09-01. ${NECA_BOX}.`,
  },
  {
    itemId: "steel-4-square-box-2-1-8-deep", description: "4-inch Square Box, Steel, 2-1/8-inch Deep (30.3 cu in)", category: "METAL BOXES & COVERS", subCategory: "4-inch Square",
    unitLabel: "each", rowType: "MATERIAL + LABOR", companyCost: null,
    laborNormal: 0.30, laborDifficult: 0.35, laborVeryDifficult: 0.40,
    notes: `${NO_COST} Southwire 52171-1 (HD #324536089) / Steel City 52171 — single-unit price not retrievable online 2026-09-01. ${NECA_BOX}.`,
  },
  // ── Industrial (raised) covers and blank, per each ───────────────────────
  {
    itemId: "steel-4-square-industrial-cover-1-gang", description: "4-inch Square Industrial Raised Cover, 1-Gang, 1/2-inch Raise", category: "METAL BOXES & COVERS", subCategory: "4-inch Square Covers",
    unitLabel: "each", rowType: "MATERIAL + LABOR", companyCost: 1.56,
    laborNormal: 0.175, laborDifficult: 0.22, laborVeryDifficult: 0.275,
    notes: `Cost: Home Depot RACO 8772 1-gang 1/2-in raised cover $1.56 each (${PRICED}). ${NECA_COVER}.`,
  },
  {
    itemId: "steel-4-square-industrial-cover-2-gang", description: "4-inch Square Industrial Raised Cover, 2-Gang, 1/2-inch Raise", category: "METAL BOXES & COVERS", subCategory: "4-inch Square Covers",
    unitLabel: "each", rowType: "MATERIAL + LABOR", companyCost: null,
    laborNormal: 0.175, laborDifficult: 0.22, laborVeryDifficult: 0.275,
    notes: `${NO_COST} RACO 807 (1/2-in) / 8769 (5/8-in) — single-unit price not retrievable online 2026-09-01. ${NECA_COVER}.`,
  },
  {
    itemId: "steel-4-square-blank-cover", description: "4-inch Square Flat Blank Cover, Steel", category: "METAL BOXES & COVERS", subCategory: "4-inch Square Covers",
    unitLabel: "each", rowType: "MATERIAL + LABOR", companyCost: 0.48,
    laborNormal: 0.175, laborDifficult: 0.22, laborVeryDifficult: 0.275,
    notes: `Cost: Home Depot RACO 8752 flat blank cover, 50-pack $24.17 = $0.48 each (${PRICED}; singles run ~$1.50). ${NECA_COVER}.`,
  },
];

const money = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `$${n.toFixed(2)}`);

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  console.log(apply ? "ADDING catalog items" : "DRY RUN — no writes (pass --apply to write)");
  console.log("");
  let created = 0;
  for (const item of ITEMS) {
    const existing = await prisma.priceBookAtomic.findUnique({ where: { itemId: item.itemId! }, select: { itemId: true } });
    console.log(`${item.description}  [${item.itemId}]`);
    console.log(`   ${item.category} · per ${item.unitLabel} · cost ${money(item.companyCost)} · hours N/D/VD ${item.laborNormal} / ${item.laborDifficult} / ${item.laborVeryDifficult}`);
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
