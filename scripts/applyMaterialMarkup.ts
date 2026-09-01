/**
 * One material markup for every cost band, and the book re-priced to it.
 *
 * Kyle, 2026-09-01: "This is a massive upcharge on material and is breaking my
 * estimates. I want to simplify this move the material upcharge to a selection
 * check box next to the discounts. Market standard is 30% we are charging more
 * than double for this and it is completely destroying my estimates."
 *
 * The book's material has been priced by five tiers keyed off an item's cost
 * (×5 under $1, ×3.5 under $10, ×2.5 under $50, ×1.8 under $200, ×1.4 above) —
 * which is how a $3,203.81 bill of goods came to be charged at $9,893.79. This
 * script sets every tier to the same multiplier (1.30 = the 30% standard) so
 * that:
 *
 *   - supplier-priced rows sell at cost × 1.30 from the next compute (the
 *     engine reads the tiers live), and
 *   - every flat-priced row's marked-up material and sell columns are
 *     recomputed through the book's own formula (computePricing):
 *       companyPrice = cost × 1.30;  sell_d = hours_d × rate + companyPrice
 *     with a PriceBookEdit row per changed column.
 *
 * The job-level material cap (gate 2) keeps its bands, except that the $3,000+
 * ceiling of 1.25× would silently cut a 30% markup to 25% on big wire jobs —
 * it is raised to the multiplier so the one rate holds everywhere. The other
 * bands (3.5×/2.5×/1.5×) sit above 1.30× and never bind.
 *
 * Every estimate applies it -- Kyle, 2026-09-01: "We do not need the check box if
 * you integrate the markup on the back end." Issued estimates are frozen and
 * untouched.
 *
 *   node dist/scripts/applyMaterialMarkup.js                    dry run at 1.30
 *   node dist/scripts/applyMaterialMarkup.js --multiplier 1.3 --apply
 */

import { PrismaClient } from "@prisma/client";
import { loadBilledLaborRate } from "../src/services/laborRate";
import { computePricing } from "../src/services/priceBookCatalog";
import type { MarkupTiers } from "../src/services/priceBookPricing";

const prisma = new PrismaClient();
const EDITED_BY = "claude:material-markup-30-2026-09-01";
const TIER_KEYS = ["markupTier1", "markupTier2", "markupTier3", "markupTier4", "markupTier5"] as const;
const FIELDS = ["markupTier", "companyPrice", "sellNormal", "sellDifficult", "sellVeryDifficult"] as const;
type Field = (typeof FIELDS)[number];

const money = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `$${n.toFixed(2)}`);
const same = (a: unknown, b: unknown) =>
  typeof a === "number" && typeof b === "number" ? Math.abs(a - b) < 0.0051 : String(a ?? "") === String(b ?? "");

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const mult = Number(arg("multiplier") ?? 1.3);
  if (!Number.isFinite(mult) || mult < 1 || mult > 3) throw new Error(`Bad --multiplier ${arg("multiplier")}`);

  const rows = await prisma.priceBookRateConfig.findMany();
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const oldTiers: MarkupTiers = {
    tier1: byKey.get("markupTier1")?.numberValue ?? 0,
    tier2: byKey.get("markupTier2")?.numberValue ?? 0,
    tier3: byKey.get("markupTier3")?.numberValue ?? 0,
    tier4: byKey.get("markupTier4")?.numberValue ?? 0,
    tier5: byKey.get("markupTier5")?.numberValue ?? 0,
  };
  const newTiers: MarkupTiers = { tier1: mult, tier2: mult, tier3: mult, tier4: mult, tier5: mult };
  const band4 = byKey.get("jobBand4Ceiling")?.numberValue ?? null;
  const rate = await loadBilledLaborRate(prisma);

  console.log(apply ? "APPLYING material markup change" : "DRY RUN — no writes (pass --apply to write)");
  console.log(`Markup tiers: ${Object.values(oldTiers).map((t) => `×${t}`).join(" / ")}  →  ×${mult} in every band (${Math.round((mult - 1) * 100)}%)`);
  console.log(`Job-level cap, $3,000+ band ceiling: ${band4 === null ? "unset" : `×${band4}`}${band4 !== null && band4 < mult ? `  → ×${mult} (so the flat markup is never cut on big jobs)` : "  (unchanged)"}`);
  console.log(`Billed labour rate for the sell columns: $${rate}/hr`);
  console.log("");

  const atomics = await prisma.priceBookAtomic.findMany({ orderBy: { itemId: "asc" } });
  const withCost = atomics.filter((a) => a.companyCost !== null && !(a.rowType ?? "").toUpperCase().includes("LABOR ONLY"));
  console.log(`${atomics.length} rows in the book; ${withCost.length} carry a material cost and are re-priced; the rest (labour-only, no cost) are untouched.`);

  // Consistency: does the stored material equal cost × the OLD tier today? Information only —
  // the new rule replaces the tiers wholesale — but a row that disagrees is worth a look.
  let drift = 0;
  const plans: Array<{ itemId: string; description: string | null; audits: Array<{ field: Field; oldValue: unknown; newValue: unknown }> }> = [];
  let materialBefore = 0, materialAfter = 0;
  for (const a of withCost) {
    const input = { rowType: a.rowType, companyCost: a.companyCost, laborNormal: a.laborNormal, laborDifficult: a.laborDifficult, laborVeryDifficult: a.laborVeryDifficult };
    const atOld = computePricing(input, oldTiers, rate);
    if (!same(atOld.companyPrice, a.companyPrice)) drift += 1;
    const next = computePricing(input, newTiers, rate);
    const audits = FIELDS.filter((f) => !same((a as Record<string, unknown>)[f], (next as unknown as Record<string, unknown>)[f]))
      .map((f) => ({ field: f, oldValue: (a as Record<string, unknown>)[f] ?? null, newValue: (next as unknown as Record<string, unknown>)[f] ?? null }));
    if (a.companyPrice !== null) materialBefore += a.companyPrice;
    if (next.companyPrice !== null) materialAfter += next.companyPrice;
    if (audits.length > 0) plans.push({ itemId: a.itemId, description: a.description, audits });
  }
  console.log(`${drift} row(s) whose stored material did not equal cost × old tier (info).`);
  console.log(`${plans.length} row(s) change. Summed marked-up material across the book: ${money(materialBefore)} → ${money(materialAfter)}.`);
  console.log("Sample (first 14 and last 6):");
  const show = (p: (typeof plans)[number]) => {
    const cell = (f: Field) => {
      const x = p.audits.find((q) => q.field === f);
      return x ? `${money(x.oldValue as number | null)}→${money(x.newValue as number | null)}` : "·";
    };
    console.log(`   ${p.itemId.padEnd(48)} ${(p.description ?? "").slice(0, 34).padEnd(34)} mat ${cell("companyPrice")}  N ${cell("sellNormal")}  D ${cell("sellDifficult")}`);
  };
  plans.slice(0, 14).forEach(show);
  if (plans.length > 20) console.log("   …");
  plans.slice(Math.max(14, plans.length - 6)).forEach(show);
  console.log("");

  if (!apply) {
    console.log("Dry run complete.");
    return;
  }

  for (const key of TIER_KEYS) {
    const row = byKey.get(key);
    if (row) await prisma.priceBookRateConfig.update({ where: { key }, data: { numberValue: mult } });
    else await prisma.priceBookRateConfig.create({ data: { key, label: key, workbookRow: 0, numberValue: mult } });
  }
  if (band4 !== null && band4 < mult) {
    await prisma.priceBookRateConfig.update({ where: { key: "jobBand4Ceiling" }, data: { numberValue: mult } });
  }
  console.log(`Rate Config: every markup tier = ${mult}${band4 !== null && band4 < mult ? `; jobBand4Ceiling = ${mult}` : ""}`);

  let written = 0;
  for (const p of plans) {
    const data: Record<string, unknown> = {};
    for (const x of p.audits) data[x.field] = x.newValue;
    await prisma.$transaction(async (tx) => {
      await tx.priceBookAtomic.update({ where: { itemId: p.itemId }, data });
      await tx.priceBookEdit.createMany({
        data: p.audits.map((x) => ({
          itemId: p.itemId,
          field: x.field,
          oldValue: x.oldValue === null ? null : String(x.oldValue),
          newValue: x.newValue === null ? null : String(x.newValue),
          editedBy: EDITED_BY,
          note: `Material markup: tiered (×${oldTiers.tier1}/${oldTiers.tier2}/${oldTiers.tier3}/${oldTiers.tier4}/${oldTiers.tier5} by cost) → ×${mult} for every item (${Math.round((mult - 1) * 100)}% market standard). material = cost × ${mult}; sell = hours × $${rate} + material.`,
        })),
      });
    });
    written += 1;
  }
  console.log(`${written} row(s) re-priced; every changed column is in PriceBookEdit as ${EDITED_BY}.`);
  console.log("Done.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
