/**
 * NECA labor-unit corrections from the 2026-09-01 price-book audit.
 *
 * Kyle: "The others were populated by the AI and were supposed to be in
 * accordance with the NECA Units. We need to fix these units in the book so I
 * am not pricing high." Audited against the NECA Manual of Labor Units
 * 2019-2020 (the PDF on disk), table by table. THHN, breakers, EMT/PVC
 * fittings, box connectors, service caps and J-boxes already matched the
 * manual exactly. Two families did not:
 *
 *   - NM-B cable w/ ground (p.140, "Type NM and UF with Ground", per M ft):
 *     the book ran 25–50% above the manual on every size.
 *   - Insulated grounding bushings (p.160, "Conduit Grounding Bushings or
 *     Locknuts"): the ¾" and 2" Normal values were stray (0.45 / 0.50 against
 *     0.22 / 0.30) and the Difficult/Very-Difficult columns on ½" and 1" were
 *     more than double their own Normal.
 *
 * Every row goes through updateAtomic — the editor's own writer — so the sells
 * recompute the workbook's way and each change lands in PriceBookEdit with its
 * old and new value. Dry-run by default; `--apply` writes.
 *
 *   railway ssh "node dist/scripts/applyNecaLaborUnits.js"          # preview
 *   railway ssh "node dist/scripts/applyNecaLaborUnits.js --apply"  # write
 */

import { PrismaClient } from "@prisma/client";
import { updateAtomic } from "../src/services/priceBookCatalog";

const prisma = new PrismaClient();
const EDITED_BY = "claude:neca-audit-2026-09-01";

/** [itemId, Normal, Difficult, Very Difficult] — hours per unit (per foot for cable). */
const TARGETS: Array<[string, number, number, number, string]> = [
  // NM-B with ground — NECA p.140, per 1,000 ft ÷ 1000.
  ["nm-b-14-2-w-grd", 0.030, 0.0375, 0.045, "NECA p.140 2/C #14 w/G: 30 / 37.5 / 45 per M ft"],
  ["nm-b-12-2-w-grd", 0.035, 0.04375, 0.0525, "NECA p.140 2/C #12 w/G: 35 / 43.75 / 52.5 per M ft"],
  ["nm-b-10-2-w-grd", 0.040, 0.050, 0.060, "NECA p.140 2/C #10 w/G: 40 / 50 / 60 per M ft"],
  ["nm-b-8-2-w-grd", 0.045, 0.05625, 0.0675, "NECA p.140 2/C #8 w/G: 45 / 56.25 / 67.5 per M ft"],
  ["nm-b-6-2-w-grd", 0.050, 0.0625, 0.075, "NECA p.140 2/C #6 w/G: 50 / 62.5 / 75 per M ft"],
  ["nm-b-14-3-w-grd", 0.035, 0.04375, 0.0525, "NECA p.140 3/C #14 w/G: 35 / 43.75 / 52.5 per M ft"],
  ["nm-b-12-3-w-grd", 0.040, 0.050, 0.060, "NECA p.140 3/C #12 w/G: 40 / 50 / 60 per M ft"],
  ["nm-b-10-3-w-grd", 0.045, 0.05625, 0.0675, "NECA p.140 3/C #10 w/G: 45 / 56.25 / 67.5 per M ft"],
  ["nm-b-8-3-w-grd", 0.050, 0.0625, 0.075, "NECA p.140 3/C #8 w/G: 50 / 62.5 / 75 per M ft"],
  ["nm-b-6-3-w-grd", 0.060, 0.075, 0.090, "NECA p.140 3/C #6 w/G: 60 / 75 / 90 per M ft"],
  // Insulated grounding bushings — NECA p.160, per each.
  ["insulated-grounding-bushing-w-lug-and-lock-ring-1-2-inch", 0.20, 0.25, 0.30, "NECA p.160 grounding bushing 1/2-inch: 0.20 / 0.25 / 0.30"],
  ["insulated-grounding-bushing-w-lug-and-lock-ring-3-4-inch", 0.22, 0.27, 0.33, "NECA p.160 grounding bushing 3/4-inch: 0.22 / 0.27 / 0.33"],
  ["insulated-grounding-bushing-w-lug-and-lock-ring-1-inch", 0.24, 0.29, 0.36, "NECA p.160 grounding bushing 1-inch: 0.24 / 0.29 / 0.36"],
  ["insulated-grounding-bushing-w-lug-and-lock-nut-2-inch", 0.30, 0.37, 0.45, "NECA p.160 grounding bushing 2-inch: 0.30 / 0.37 / 0.45"],
];

const fmt = (n: number | null | undefined) => (n === null || n === undefined ? "—" : String(Math.round(n * 100000) / 100000));
const money = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `$${n.toFixed(2)}`);

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  console.log(apply ? "APPLYING NECA labor-unit corrections" : "DRY RUN — no writes (pass --apply to write)");
  console.log("");
  let changed = 0;
  for (const [itemId, n, d, vd, source] of TARGETS) {
    const before = await prisma.priceBookAtomic.findUnique({
      where: { itemId },
      select: { itemId: true, description: true, laborNormal: true, laborDifficult: true, laborVeryDifficult: true, sellNormal: true, sellDifficult: true, sellVeryDifficult: true, companyCost: true },
    });
    if (!before) {
      console.log(`!! ${itemId}: NOT FOUND — skipped`);
      continue;
    }
    const same = before.laborNormal === n && before.laborDifficult === d && before.laborVeryDifficult === vd;
    console.log(`${before.description}  [${itemId}]`);
    console.log(`   hours  N/D/VD   ${fmt(before.laborNormal)} / ${fmt(before.laborDifficult)} / ${fmt(before.laborVeryDifficult)}  →  ${fmt(n)} / ${fmt(d)} / ${fmt(vd)}${same ? "   (already there)" : ""}`);
    console.log(`   source ${source}`);
    if (same) { console.log(""); continue; }
    if (apply) {
      const result = await updateAtomic(prisma, itemId, { laborNormal: n, laborDifficult: d, laborVeryDifficult: vd }, EDITED_BY);
      if (!result.ok) {
        console.log(`   !! update refused: ${result.reason}`);
      } else {
        const after = result.atomic as { sellNormal: number | null; sellDifficult: number | null; sellVeryDifficult: number | null };
        console.log(`   sell   N/D/VD   ${money(before.sellNormal)} / ${money(before.sellDifficult)} / ${money(before.sellVeryDifficult)}  →  ${money(after.sellNormal)} / ${money(after.sellDifficult)} / ${money(after.sellVeryDifficult)}`);
        changed += 1;
      }
    } else {
      // Preview the sell the editor's formula will produce: hours × $150 + marked-up material.
      const cp = (before as unknown as { companyPrice?: number | null }).companyPrice ?? null;
      const cost = before.companyCost;
      console.log(`   sell now        ${money(before.sellNormal)} / ${money(before.sellDifficult)} / ${money(before.sellVeryDifficult)}   (cost ${money(cost)}${cp !== null ? `, material w/ markup ${money(cp)}` : ""})`);
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
