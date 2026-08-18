/**
 * P030 — Kyle's tab becomes the catalog.
 *
 * Kyle, 2026-08-18: *"I want only my tab (Kyle's Copy) to be the source of truth."*
 *
 * The properties worth pinning are the ones where being wrong is invisible:
 *   1. **A line prices at Kyle's number, exactly** — the engine reads his sell column instead of
 *      rebuilding the arithmetic his sheet already did.
 *   2. **The internal halves reconstruct it**, so job costing keeps hours and material while the
 *      customer-facing collapse still produces his price to the cent.
 *   3. **Difficulty picks the published column** — never a multiplier.
 *   4. **Keys are readable AND stable AND unique**, including the two load centers that differ
 *      only in a suffix 80 characters in.
 *   5. **The importer's gates refuse** rather than importing something plausible-looking.
 */

import { describe, expect, it } from "vitest";
import {
  computeEstimate,
  flatSellFor,
  isFlatPriced,
  resolveCatalogAtSupplier,
  type DraftLineInput,
  type EngineAtomic,
} from "../src/services/atomicEstimateEngine";
import type { RateConfig } from "../src/services/priceBookPricing";
import { checkParity, slugify, unitFromName, type KyleItem } from "../scripts/price-book/kylesTabMapping";

const RC: RateConfig = {
  billedLaborRate: 150,
  inspectionCoordination: 1,
  inspectionFolded: 0,
  utilityStandby: 1,
  permitFee: null,
  jobFixedCost: 200,
  activeSupplier: "HD",
  markupTiers: { tier1: 5, tier2: 3.5, tier3: 2.5, tier4: 1.8, tier5: 1.4 },
};

/** A row shaped like Kyle's: per-unit hours, his cost/price, and his three sell columns. */
function kyleRow(over: Partial<EngineAtomic> & { itemId: string }): EngineAtomic {
  return {
    description: over.itemId,
    unit: "ea",
    rowType: "MATERIAL + LABOR",
    laborNormal: null,
    laborDifficult: null,
    laborVeryDifficult: null,
    laborUnitBasis: "E",
    laborUnitDivisor: 1,
    laborUnitBasisRaw: "E [Kyle's tab]",
    costBasisUsed: null,
    sellPricePerUnit: null,
    necaUnitBasis: null,
    source: "kyles-tab",
    sellNormal: null,
    sellDifficult: null,
    sellVeryDifficult: null,
    ...over,
  };
}

const line = (over: Partial<DraftLineInput> & { itemId: string }): DraftLineInput => ({
  quantity: 1,
  quantitySource: "COUNT",
  difficulty: "NORMAL",
  ...over,
});

// ─── 1 & 2. A line prices at Kyle's number, and the halves reconstruct it ───────

describe("the engine prices from Kyle's sell columns", () => {
  // His real NM-B 14/2 row: 0.045 hr, $4.361 material -> $11.111 at Normal.
  const nm = kyleRow({
    itemId: "nm-b-14-2-w-grd-per-ft",
    unit: "ft",
    laborNormal: 0.045, laborDifficult: 0.0575, laborVeryDifficult: 0.07,
    companyCost: 1.246, companyPrice: 4.361,
    sellNormal: 11.111, sellDifficult: 12.986, sellVeryDifficult: 14.861,
    costBasisUsed: 1.246, sellPricePerUnit: 4.361,
  });

  it("charges qty x his sell price, to the cent", () => {
    const est = computeEstimate(
      [line({ itemId: nm.itemId, quantity: 100, quantitySource: "MEASURED_LENGTH" })],
      new Map([[nm.itemId, nm]]),
      RC,
      "HD"
    );
    const l = est.lines[0];
    expect(l.gaps).toEqual([]);
    expect(l.sellPerUnit).toBe(11.111);
    // 100 ft x $11.111 = $1111.10
    expect((l.laborDollars ?? 0) + (l.materialSell ?? 0)).toBeCloseTo(1111.1, 2);
  });

  it("keeps hours and material internally, summing exactly to his price", () => {
    const est = computeEstimate(
      [line({ itemId: nm.itemId, quantity: 100, quantitySource: "MEASURED_LENGTH" })],
      new Map([[nm.itemId, nm]]),
      RC,
      "HD"
    );
    const l = est.lines[0];
    // Internal, for job costing: 100 x 0.045 = 4.5 hr at $150 = $675.
    expect(l.laborHours).toBeCloseTo(4.5, 6);
    expect(l.laborDollars).toBeCloseTo(675, 2);
    // Material is the remainder, so the two halves rebuild the flat price rather than drifting.
    expect(l.materialSell).toBeCloseTo(1111.1 - 675, 2);
  });

  it("difficulty reads the published column, never a multiplier", () => {
    const atomics = new Map([[nm.itemId, nm]]);
    const at = (d: DraftLineInput["difficulty"]) =>
      computeEstimate([line({ itemId: nm.itemId, difficulty: d })], atomics, RC, "HD").lines[0];

    expect(at("NORMAL").sellPerUnit).toBe(11.111);
    expect(at("DIFFICULT").sellPerUnit).toBe(12.986);
    expect(at("VERY_DIFFICULT").sellPerUnit).toBe(14.861);
    // 12.986 is not 11.111 x 1.25 (13.889) — reading the column and scaling it disagree.
    expect(at("DIFFICULT").sellPerUnit).not.toBeCloseTo(11.111 * 1.25, 2);
  });

  it("Diagnostics is labour-only and still prices: $150 / $225 / $300", () => {
    const diag = kyleRow({
      itemId: "diagnostics-troubleshooting-circuit-tracing-per-hour",
      unit: "hour",
      rowType: "LABOR ONLY",
      laborNormal: 1, laborDifficult: 1.5, laborVeryDifficult: 2,
      companyPrice: null, companyCost: null,
      sellNormal: 150, sellDifficult: 225, sellVeryDifficult: 300,
    });
    const atomics = new Map([[diag.itemId, diag]]);

    for (const [d, expected] of [["NORMAL", 150], ["DIFFICULT", 225], ["VERY_DIFFICULT", 300]] as const) {
      const l = computeEstimate([line({ itemId: diag.itemId, difficulty: d })], atomics, RC, "HD").lines[0];
      expect(l.gaps, `${d} should price cleanly`).toEqual([]);
      expect((l.laborDollars ?? 0) + (l.materialSell ?? 0)).toBeCloseTo(expected, 2);
    }
    // Two hours of troubleshooting at Normal is $300, not $150.
    const two = computeEstimate([line({ itemId: diag.itemId, quantity: 2 })], atomics, RC, "HD").lines[0];
    expect((two.laborDollars ?? 0) + (two.materialSell ?? 0)).toBeCloseTo(300, 2);
  });

  it("Permit Fee is $200 flat at every difficulty", () => {
    const permit = kyleRow({
      itemId: "permit-fee-flat-per-permit",
      rowType: "MATERIAL ONLY",
      laborNormal: 0, laborDifficult: 0, laborVeryDifficult: 0,
      companyCost: 200, companyPrice: 200,
      sellNormal: 200, sellDifficult: 200, sellVeryDifficult: 200,
      costBasisUsed: 200, sellPricePerUnit: 200,
    });
    const atomics = new Map([[permit.itemId, permit]]);
    for (const d of ["NORMAL", "DIFFICULT", "VERY_DIFFICULT"] as const) {
      const l = computeEstimate([line({ itemId: permit.itemId, difficulty: d })], atomics, RC, "HD").lines[0];
      expect(l.gaps).toEqual([]);
      expect((l.laborDollars ?? 0) + (l.materialSell ?? 0)).toBeCloseTo(200, 2);
    }
  });

  it("refuses a difficulty the row does not publish rather than substituting Normal", () => {
    const partial = kyleRow({
      itemId: "half-priced-row",
      laborNormal: 1,
      companyPrice: 10,
      sellNormal: 160,
      sellDifficult: null,
    });
    const est = computeEstimate(
      [line({ itemId: partial.itemId, difficulty: "DIFFICULT" })],
      new Map([[partial.itemId, partial]]),
      RC,
      "HD"
    );
    expect(est.lines[0].gaps.map((g) => g.kind)).toContain("NO_SELL_PRICE_AT_DIFFICULTY");
    expect(est.incompleteLineCount).toBe(1);
  });

  it("does not resolve Kyle's rows at a supplier — his own numbers stand", () => {
    // No supplier price rows exist for his keys. The old path would null the cost and raise
    // NO_PRICE_AT_SUPPLIER on all 226 items.
    const resolved = resolveCatalogAtSupplier([nm], [], "HD", RC.markupTiers);
    const out = resolved.get(nm.itemId)!;
    expect(out.costBasisUsed).toBe(1.246);
    expect(out.sellNormal).toBe(11.111);

    const est = computeEstimate([line({ itemId: nm.itemId })], resolved, RC, "HD");
    expect(est.lines[0].gaps.map((g) => g.kind)).not.toContain("NO_PRICE_AT_SUPPLIER");
  });

  it("leaves the legacy NECA path alone for retired rows still on the two old drafts", () => {
    const legacy: EngineAtomic = {
      itemId: "N001", description: "legacy", unit: "ft", rowType: "MATERIAL + LABOR",
      laborNormal: 6.2, laborDifficult: null, laborVeryDifficult: null,
      laborUnitBasis: "C", laborUnitDivisor: 100, laborUnitBasisRaw: "C",
      costBasisUsed: 12, sellPricePerUnit: 30, necaUnitBasis: null,
    };
    expect(isFlatPriced(legacy)).toBe(false);
    const est = computeEstimate(
      [line({ itemId: "N001", quantity: 50, quantitySource: "MEASURED_LENGTH" })],
      new Map([["N001", legacy]]),
      RC,
      "HD"
    );
    // 50 x 6.2 / 100 = 3.1 hr — the E/C/M divisor still applies where it still means something.
    expect(est.lines[0].laborHours).toBeCloseTo(3.1, 6);
  });

  it("flatSellFor reads exactly the asked-for column", () => {
    expect(flatSellFor(nm, "NORMAL")).toBe(11.111);
    expect(flatSellFor(nm, "DIFFICULT")).toBe(12.986);
    expect(flatSellFor(nm, "VERY_DIFFICULT")).toBe(14.861);
  });
});

// ─── 4. Keys: readable, stable, unique ─────────────────────────────────────────

describe("readable keys derived from Kyle's names", () => {
  it("slugs a name into something a person can read", () => {
    expect(slugify("NM-B 14/2 w/Grd — per ft")).toBe("nm-b-14-2-w-grd-per-ft");
    expect(slugify("Permit Fee — flat, per permit")).toBe("permit-fee-flat-per-permit");
    expect(slugify("Diagnostics / Troubleshooting / Circuit Tracing — per hour"))
      .toBe("diagnostics-troubleshooting-circuit-tracing-per-hour");
  });

  it("is stable — the same name always produces the same key", () => {
    const n = "Load Center, 100A, 20-Space/40-Circuit, Indoor Main Breaker, Plug-On Neutral (Square D HOM2040M100PC) — SURFACE MOUNT";
    expect(slugify(n)).toBe(slugify(n));
  });

  it("keeps two long names distinct when they differ only past the truncation point", () => {
    // The pair that collided at an 80-character cap, caught by the importer's duplicate gate.
    const surface = "Load Center, 100A, 20-Space/40-Circuit, Indoor Main Breaker, Plug-On Neutral (Square D HOM2040M100PC) — SURFACE MOUNT";
    const flush = "Load Center, 100A, 20-Space/40-Circuit, Indoor Main Breaker, Plug-On Neutral (Square D HOM2040M100PC) — RECESSED/FLUSH MOUNT";
    expect(slugify(surface)).not.toBe(slugify(flush));
    // Still readable, still bounded.
    expect(slugify(surface).length).toBeLessThanOrEqual(80);
  });

  it("pulls the unit out of the name, including hyphenated units", () => {
    expect(unitFromName("NM-B 14/2 w/Grd — per ft")).toBe("per ft");
    expect(unitFromName("Diagnostics / Troubleshooting / Circuit Tracing — per hour")).toBe("per hour");
    expect(unitFromName("EMT Conduit, 1/2-inch — per 10-ft stick")).toBe("per 10-ft stick");
  });

  it("stops at the prose Kyle writes after the unit", () => {
    // Real names from his tab — the unit is the first phrase, not the sentence.
    expect(unitFromName("Breaker, 2-Pole — per breaker. Labor = standard breaker + NECA adder"))
      .toBe("per breaker");
    expect(unitFromName("Insulated Grounding Bushing w/ Lug, 1/2-inch — per bushing (2-pack unit cost)."))
      .toBe("per bushing");
    expect(unitFromName("Flexible Steel Conduit (FSC/Greenfield), 1-inch — per ft, priced from 50-ft coil"))
      .toBe("per ft");
  });
});

// ─── 5. The importer's parity gate ─────────────────────────────────────────────

describe("the import refuses rather than importing something plausible", () => {
  const item = (over: Partial<KyleItem>): KyleItem => ({
    key: "k", name: "n", section: "S", unitLabel: null, row: 2,
    laborNormal: null, laborDifficult: null, laborVeryDifficult: null,
    companyCost: null, companyPrice: null,
    sellNormal: null, sellDifficult: null, sellVeryDifficult: null,
    ...over,
  });

  it("passes a row whose sell equals labour x 150 + material", () => {
    const { failures } = checkParity([
      item({ laborNormal: 0.045, companyPrice: 4.361, sellNormal: 11.111 }),
    ]);
    expect(failures).toEqual([]);
  });

  it("passes a LABOUR-ONLY row, where blank material genuinely means zero", () => {
    // Diagnostics buys nothing; the sheet's own sell column confirms 1.0 hr x $150 = $150.
    const { failures } = checkParity([
      item({ laborNormal: 1, laborDifficult: 1.5, companyPrice: null, sellNormal: 150, sellDifficult: 225 }),
    ]);
    expect(failures).toEqual([]);
  });

  it("compares unrounded, so a stored 82.005 is not a half-cent failure", () => {
    // Kyle's sheet stores full floats. Rounding one side manufactures failures out of correct rows.
    const { failures } = checkParity([
      item({ laborNormal: 0.4375, companyPrice: 16.38, sellNormal: 82.005 }),
    ]);
    expect(failures).toEqual([]);
  });

  it("FAILS a row whose sell has drifted from the formula", () => {
    const { failures } = checkParity([
      item({ name: "drifted", laborNormal: 1, companyPrice: 10, sellNormal: 175 }),
    ]);
    expect(failures).toHaveLength(1);
    expect(failures[0].expected).toBe(160);
    expect(failures[0].sell).toBe(175);
  });

  it("FAILS a row carrying labour and material but no sell", () => {
    const { failures } = checkParity([
      item({ name: "no sell", laborNormal: 1, companyPrice: 10, sellNormal: null, sellDifficult: 200 }),
    ]);
    // The Difficult cell has a sell with no labour -> still checked, and Normal's blank sell fails.
    expect(failures.length).toBeGreaterThanOrEqual(1);
  });

  it("skips a difficulty the row simply does not offer", () => {
    const { rows } = checkParity([item({ laborNormal: 1, companyPrice: 10, sellNormal: 160 })]);
    // Only the Normal triple was present, so only it was checked.
    expect(rows).toHaveLength(1);
    expect(rows[0].tag).toBe("N");
  });
});
