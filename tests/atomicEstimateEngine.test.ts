/**
 * Tests for the atomic-first estimate engine (Phase 2.0).
 *
 * Not the verification bar — "use is validation" and the bar is Kyle pricing a real job. What
 * these pin are the places where a reasonable-looking implementation is silently wrong and the
 * wrongness would survive a demo on today's data:
 *   - the E/C/M divisor (a 100x labour error that still looks like a real number)
 *   - blank labour and blank price as gaps rather than zeros
 *   - difficulty READ from the published column, never scaled from Normal
 *   - the measured-length guard that stops removing cable becoming a discount
 */

import { describe, expect, it } from "vitest";
import {
  computeEstimate,
  finalizeEstimate,
  impliesConductors,
  isContinuousLength,
  laborHoursFor,
  laborValueFor,
  rowTypeSells,
  suggestCompanionLines,
  type DraftLineInput,
  type EngineAtomic,
} from "../src/services/atomicEstimateEngine";
import type { RateConfig } from "../src/services/priceBookPricing";

const RC: RateConfig = {
  billedLaborRate: 201.34,
  inspectionCoordination: 1,
  inspectionFolded: 0,
  utilityStandby: 1,
  permitFee: null,
  jobFixedCost: 200,
  activeSupplier: "HD",
  markupTiers: { tier1: 5, tier2: 3.5, tier3: 2.5, tier4: 1.8, tier5: 1.4 },
};

function atomic(over: Partial<EngineAtomic> & { itemId: string }): EngineAtomic {
  return {
    description: over.itemId,
    unit: "ea",
    rowType: "MATERIAL + LABOR",
    laborNormal: null,
    laborDifficult: null,
    laborVeryDifficult: null,
    laborUnitBasis: "E",
    laborUnitDivisor: 1,
    laborUnitBasisRaw: "E",
    costBasisUsed: null,
    sellPricePerUnit: null,
    necaUnitBasis: null,
    ...over,
  };
}

const line = (over: Partial<DraftLineInput> & { itemId: string }): DraftLineInput => ({
  quantity: 1,
  quantitySource: "COUNT",
  difficulty: "NORMAL",
  ...over,
});

describe("NECA unit basis — the 100x error", () => {
  // C004: 1-1/4 in. EMT, published 6.2 per hundred feet. The live job measured 50 ft and the
  // workbook recorded 3.10 hr. Under E that same row is 310 hr.
  const c004 = atomic({
    itemId: "C004",
    unit: "ea",
    laborNormal: 6.2,
    laborUnitBasis: "C",
    laborUnitDivisor: 100,
  });

  it("C (per hundred) reproduces the recorded 3.10 hr for 50 ft", () => {
    expect(laborHoursFor(c004, 50, "NORMAL")).toBeCloseTo(3.1, 10);
  });

  it("M (per thousand) reproduces N004's recorded 1.20 hr for 30 ft", () => {
    const n004 = atomic({ itemId: "N004", unit: "ft", laborNormal: 40, laborUnitBasis: "M", laborUnitDivisor: 1000 });
    expect(laborHoursFor(n004, 30, "NORMAL")).toBeCloseTo(1.2, 10);
  });

  it("E (per each) reproduces A008's recorded 0.94 hr", () => {
    const a008 = atomic({ itemId: "A008", laborNormal: 0.94, laborUnitBasis: "E", laborUnitDivisor: 1 });
    expect(laborHoursFor(a008, 1, "NORMAL")).toBeCloseTo(0.94, 10);
  });

  it("BLOCKS when the basis is unverified — never defaults to E", () => {
    const blocked = atomic({
      itemId: "A018",
      laborNormal: 2.2,
      laborUnitBasis: null,
      laborUnitDivisor: null,
      laborUnitBasisRaw: "UNVERIFIED — source text states no unit basis. DO NOT ASSUME.",
    });
    expect(laborHoursFor(blocked, 1, "NORMAL")).toBeNull();
  });

  it("surfaces the unverified basis as a routed gap, not a zero", () => {
    const blocked = atomic({
      itemId: "A018",
      rowType: "LABOR ONLY",
      laborNormal: 2.2,
      laborUnitBasis: null,
      laborUnitDivisor: null,
      laborUnitBasisRaw: "UNVERIFIED",
    });
    const est = computeEstimate([line({ itemId: "A018" })], new Map([["A018", blocked]]), RC, "HD");
    expect(est.laborHours).toBe(0); // contributes nothing...
    const gap = est.gaps.find((g) => g.kind === "NO_LABOUR_UNIT_BASIS");
    expect(gap).toBeDefined(); // ...but is loudly reported
    expect(gap!.routesTo).toBe("price-book-0400");
    expect(est.completenessSummary).toContain("INCOMPLETE");
  });
});

describe("difficulty is read from the published column, not scaled", () => {
  // A008's published triple is 0.94 / 1.18 / 1.41. A x1.25 multiplier would give 1.175, not
  // 1.18 — the 2026-08-11 audit found 20 of 59 rows where the ratio does not hold.
  const a008 = atomic({
    itemId: "A008",
    laborNormal: 0.94,
    laborDifficult: 1.18,
    laborVeryDifficult: 1.41,
  });

  it("returns the published figure for each difficulty", () => {
    expect(laborValueFor(a008, "NORMAL")).toBe(0.94);
    expect(laborValueFor(a008, "DIFFICULT")).toBe(1.18);
    expect(laborValueFor(a008, "VERY_DIFFICULT")).toBe(1.41);
  });

  it("does NOT equal Normal x 1.25 — proving it is read, not computed", () => {
    expect(laborValueFor(a008, "DIFFICULT")).not.toBeCloseTo(0.94 * 1.25, 6);
  });

  it("blocks when the chosen difficulty column is blank (the CF003/N010 class)", () => {
    const partial = atomic({ itemId: "N010", laborNormal: 0.0133, laborDifficult: null, laborVeryDifficult: null });
    expect(laborHoursFor(partial, 10, "NORMAL")).toBeCloseTo(0.133, 10);
    expect(laborHoursFor(partial, 10, "DIFFICULT")).toBeNull();
  });

  it("difficulty is per line, so two lines of the same atomic can differ", () => {
    const est = computeEstimate(
      [line({ itemId: "A008" }), line({ itemId: "A008", difficulty: "VERY_DIFFICULT" })],
      new Map([["A008", a008]]),
      RC,
      "HD"
    );
    expect(est.lines[0].laborHours).toBeCloseTo(0.94, 10);
    expect(est.lines[1].laborHours).toBeCloseTo(1.41, 10);
  });
});

describe("no price at the selected supplier", () => {
  it("reports a gap routed to sourcing and contributes no material money", () => {
    const unpriced = atomic({ itemId: "C004", laborNormal: 6.2, laborUnitBasis: "C", laborUnitDivisor: 100, costBasisUsed: null });
    const est = computeEstimate(
      [line({ itemId: "C004", quantity: 50, quantitySource: "MEASURED_LENGTH" })],
      new Map([["C004", unpriced]]),
      RC,
      "HD"
    );
    expect(est.materialSell).toBe(0);
    const gap = est.gaps.find((g) => g.kind === "NO_PRICE_AT_SUPPLIER");
    expect(gap).toBeDefined();
    expect(gap!.routesTo).toBe("sourcing-0303");
    expect(gap!.message).toContain("no fallback");
    // Labour still computes — an unpriced part does not erase the hours to install it.
    expect(est.laborHours).toBeCloseTo(3.1, 10);
  });

  it("does not raise a price gap on a LABOR ONLY row", () => {
    const labourOnly = atomic({ itemId: "A018", rowType: "LABOR ONLY", laborNormal: 2.2, costBasisUsed: null });
    const est = computeEstimate([line({ itemId: "A018" })], new Map([["A018", labourOnly]]), RC, "HD");
    expect(est.gaps.some((g) => g.kind === "NO_PRICE_AT_SUPPLIER")).toBe(false);
  });

  /*
    Kyle, 2026-08-17: DG001 (a diagnostic hour) would not finalize. Two separate causes, and this
    is the one that was purely a bug: `Row Type` reads **LABOR PRODUCT** on all ten standalone
    sellable services, the test was `!== "LABOR ONLY"`, and a different string meant the engine
    demanded a Home Depot price for an hour of troubleshooting.
  */
  it("does not raise a price gap on a LABOR PRODUCT row", () => {
    const diagnostic = atomic({
      itemId: "DG001",
      rowType: "LABOR PRODUCT",
      unit: "hr",
      laborNormal: 1,
      costBasisUsed: null,
      sellPricePerUnit: null,
    });
    const est = computeEstimate([line({ itemId: "DG001" })], new Map([["DG001", diagnostic]]), RC, "HD");
    expect(est.gaps.some((g) => g.kind === "NO_PRICE_AT_SUPPLIER")).toBe(false);
    // And it still prices the hour it does sell.
    expect(est.laborHours).toBeCloseTo(1, 10);
  });

  it("still raises a price gap on the parenthesised MATERIAL + LABOR variants", () => {
    const pending = atomic({
      itemId: "GB001",
      rowType: "MATERIAL + LABOR (both values PENDING - see Labor Status and Notes)",
      laborNormal: 1,
      costBasisUsed: null,
    });
    const est = computeEstimate([line({ itemId: "GB001" })], new Map([["GB001", pending]]), RC, "HD");
    expect(est.gaps.some((g) => g.kind === "NO_PRICE_AT_SUPPLIER")).toBe(true);
  });

  it("classifies every Row Type the production catalog actually carries", () => {
    // The nine distinct values in production on 2026-08-17, plus blank.
    expect(rowTypeSells("MATERIAL + LABOR")).toEqual({ material: true, labour: true });
    expect(rowTypeSells("LABOR ONLY")).toEqual({ material: false, labour: true });
    expect(rowTypeSells("MATERIAL ONLY")).toEqual({ material: true, labour: false });
    expect(rowTypeSells("LABOR PRODUCT")).toEqual({ material: false, labour: true });
    expect(rowTypeSells("MATERIAL + LABOR (labour value PENDING KYLE - see Labor Status)"))
      .toEqual({ material: true, labour: true });
    // Unrecognised vocabulary stays permissive — checked for both, never silently skipped.
    expect(rowTypeSells("REFERENCE ONLY")).toEqual({ material: true, labour: true });
    expect(rowTypeSells("DECLARATION")).toEqual({ material: true, labour: true });
    expect(rowTypeSells(null)).toEqual({ material: true, labour: true });
  });
});

describe("computed lines carry their own line id", () => {
  /*
    The review screen joined computed rows to draft rows on `itemId`. A draft may legitimately
    carry the same atomic twice — Kyle's 2026-08-16 draft has two N001 lines of 100 ft — and that
    join rendered the first row's hours and dollars against both of them.
  */
  it("passes the input id through so duplicate itemIds stay distinguishable", () => {
    const a = atomic({ itemId: "N001", laborNormal: 2, costBasisUsed: 1, sellPricePerUnit: 2 });
    const est = computeEstimate(
      [
        { id: "line-1", itemId: "N001", quantity: 100, quantitySource: "COUNT", difficulty: "NORMAL" },
        { id: "line-2", itemId: "N001", quantity: 5, quantitySource: "COUNT", difficulty: "NORMAL" },
      ],
      new Map([["N001", a]]),
      RC,
      "HD"
    );
    expect(est.lines.map((l) => l.id)).toEqual(["line-1", "line-2"]);
    expect(est.lines[0].laborHours).not.toBe(est.lines[1].laborHours);
  });

  it("leaves id undefined when the caller supplied none", () => {
    const a = atomic({ itemId: "R001", laborNormal: 1, costBasisUsed: 1, sellPricePerUnit: 2 });
    const est = computeEstimate([line({ itemId: "R001" })], new Map([["R001", a]]), RC, "HD");
    expect(est.lines[0].id).toBeUndefined();
  });
});

describe("measured-length guard — removing cable must not become a discount", () => {
  const emt = atomic({
    itemId: "C004",
    description: "EMT Conduit, 1 1/4-inch, 10-ft stick",
    laborNormal: 6.2,
    laborUnitBasis: "C",
    laborUnitDivisor: 100,
    costBasisUsed: 12,
    sellPricePerUnit: 30,
  });
  const wire = atomic({
    itemId: "TH008",
    description: "THHN #2 AWG, per ft",
    unit: "ft",
    laborNormal: 17,
    laborUnitBasis: "M",
    laborUnitDivisor: 1000,
    costBasisUsed: 1,
    sellPricePerUnit: 2,
  });
  const atomics = new Map([
    ["C004", emt],
    ["TH008", wire],
  ]);

  it("identifies raceway and continuous-length product", () => {
    expect(impliesConductors(emt)).toBe(true);
    expect(isContinuousLength(wire)).toBe(true);
    expect(isContinuousLength(emt)).toBe(false);
  });

  it("REFUSES to finalize raceway with no conductor line", () => {
    const est = computeEstimate([line({ itemId: "C004", quantity: 5 })], atomics, RC, "HD");
    const res = finalizeEstimate(est, atomics, { context: "internal" });
    expect(res.finalized).toBe(false);
    if (!res.finalized) expect(res.reasons.join(" ")).toContain("NO WIRE ON THIS ESTIMATE");
  });

  it("names the missing WORK, not the mechanism that detected it", () => {
    /*
      Kyle hit this refusal on 2026-08-20 and read it as a quantity bug:

        "It did not allow me to proceed because it is not calculating my qty of 2 as 20 feet of
         conduit."

      It had nothing to do with his quantity. The estimate had conduit and no wire, and the
      message opened "MEASURED LINES MISSING" — naming the mechanism the rule uses to notice,
      rather than the thing that is absent. He went looking for a units bug that did not exist.

      A refusal is read by someone mid-job who wants to send a price, so it has to name the
      missing work immediately and rule out the wrong reading explicitly.
    */
    const est = computeEstimate([line({ itemId: "C004", quantity: 5 })], atomics, RC, "HD");
    const res = finalizeEstimate(est, atomics, { context: "internal" });
    expect(res.finalized).toBe(false);
    if (res.finalized) return;
    const text = res.reasons.join(" ");
    expect(text).toContain("NO WIRE");
    expect(text).toMatch(/not about the quantity/i);
    // The old wording, which sent him hunting in the wrong place.
    expect(text).not.toContain("MEASURED LINES MISSING");
  });

  it("allows it once a measured conductor line is present", () => {
    const est = computeEstimate(
      [
        line({ itemId: "C004", quantity: 5 }),
        line({ itemId: "TH008", quantity: 100, quantitySource: "MEASURED_LENGTH" }),
      ],
      atomics,
      RC,
      "HD"
    );
    const res = finalizeEstimate(est, atomics, { context: "internal" });
    expect(res.finalized).toBe(true);
  });

  it("flags a continuous-length atomic quantified by COUNT instead of MEASURED_LENGTH", () => {
    const est = computeEstimate([line({ itemId: "TH008", quantity: 100 })], atomics, RC, "HD");
    expect(est.gaps.some((g) => g.kind === "MEASURED_LENGTH_MISSING")).toBe(true);
  });
});

describe("finalize gate", () => {
  const clean = atomic({
    itemId: "A008",
    laborNormal: 0.94,
    costBasisUsed: 86.68,
    sellPricePerUnit: 156.02,
  });
  const atomics = new Map([["A008", clean]]);

  it("blocks a customer price at a provisional rate but computes internally", () => {
    const est = computeEstimate([line({ itemId: "A008" })], atomics, RC, "HD");
    const cust = finalizeEstimate(est, atomics, { context: "customer", rateProvisional: true });
    expect(cust.finalized).toBe(false);
    if (!cust.finalized) expect(cust.reasons.join(" ")).toContain("PROVISIONAL RATE");

    const internal = finalizeEstimate(est, atomics, { context: "internal", rateProvisional: true });
    expect(internal.finalized).toBe(true);
    if (internal.finalized) expect(internal.warnings.join(" ")).toContain("PROVISIONAL");
  });

  it("computes the total as labour + material sell + job fixed cost", () => {
    const est = computeEstimate([line({ itemId: "A008" })], atomics, RC, "HD");
    expect(est.laborDollars).toBeCloseTo(0.94 * 201.34, 8);
    expect(est.materialSell).toBeCloseTo(156.02, 8);
    expect(est.subtotal).toBeCloseTo(0.94 * 201.34 + 156.02, 8);
    expect(est.total).toBeCloseTo(0.94 * 201.34 + 156.02 + 200, 8);
  });

  it("refuses an empty estimate", () => {
    const est = computeEstimate([], new Map(), RC, "HD");
    const res = finalizeEstimate(est, new Map(), { context: "internal" });
    expect(res.finalized).toBe(false);
  });

  it("refuses an atomic that is not in the catalog rather than skipping it", () => {
    const est = computeEstimate([line({ itemId: "SER-4C-1AL" })], new Map(), RC, "HD");
    expect(est.gaps.some((g) => g.kind === "ATOMIC_NOT_FOUND")).toBe(true);
    const res = finalizeEstimate(est, new Map(), { context: "internal" });
    expect(res.finalized).toBe(false);
  });

  it("requires a note on a MANUAL quantity", () => {
    const est = computeEstimate(
      [line({ itemId: "A008", quantitySource: "MANUAL" })],
      atomics,
      RC,
      "HD"
    );
    expect(est.gaps.some((g) => g.kind === "MANUAL_QUANTITY_WITHOUT_NOTE")).toBe(true);
  });
});

describe("composition rules seam", () => {
  it("reports unavailable rather than an empty suggestion list", () => {
    const seam = suggestCompanionLines([]);
    expect(seam.available).toBe(false);
    expect(seam.suggestions).toHaveLength(0);
    expect(seam.reason).toContain("not implemented");
  });
});
