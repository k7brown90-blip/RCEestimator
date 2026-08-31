/*
  ── THESE ASSERT WARNINGS NOW, NOT REFUSALS (Kyle, 2026-08-20) ──────────────────────────────────

  "These checks are becoming a preventative block. They need removed. Nothing should block me from
   completing the estimate."

  The conditions still have to be DETECTED — that is what these tests are for, and it is why they
  were rewritten rather than deleted. What changed is the consequence: the engine now says so and
  lets the estimate through, and the licensed electrician decides.

  He is right that they had to go. The raceway rule had become unsatisfiable against his own
  catalog and was refusing estimates that were correct, which is the failure mode that teaches an
  operator to stop reading refusals altogether.
*/
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

  it("WARNS about raceway with no conductor line, and lets it through", () => {
    const est = computeEstimate([line({ itemId: "C004", quantity: 5 })], atomics, RC, "HD");
    const res = finalizeEstimate(est, atomics, { context: "internal" });
    expect(res.finalized, "a missing conductor no longer blocks").toBe(true);
    expect(res.warnings.join(" ")).toContain("NO WIRE ON THIS ESTIMATE");
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
    const text = res.warnings.join(" ");
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

  it("warns loudly at a provisional rate, on both surfaces", () => {
    const est = computeEstimate([line({ itemId: "A008" })], atomics, RC, "HD");
    const cust = finalizeEstimate(est, atomics, { context: "customer", rateProvisional: true });
    // No longer blocks. A provisional rate is wrong on EVERY labour line at once, so it is said
    // as loudly as a warning can be said — but Kyle decides.
    expect(cust.finalized).toBe(true);
    expect(cust.warnings.join(" ")).toContain("PROVISIONAL LABOUR RATE");

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

  it("warns about an empty estimate rather than refusing it", () => {
    const est = computeEstimate([], new Map(), RC, "HD");
    const res = finalizeEstimate(est, new Map(), { context: "internal" });
    expect(res.finalized).toBe(true);
    expect(res.warnings.join(" ")).toContain("no lines");
  });

  it("still NOTICES an atomic that is not in the catalog, and says the total is short", () => {
    // The detection is the part that matters and it is unchanged. What changed is that it warns
    // instead of refusing — and the warning says the consequence in money, because a line the
    // engine could not price contributes nothing and the estimate is cheaper than the work.
    const est = computeEstimate([line({ itemId: "SER-4C-1AL" })], new Map(), RC, "HD");
    expect(est.gaps.some((g) => g.kind === "ATOMIC_NOT_FOUND")).toBe(true);
    const res = finalizeEstimate(est, new Map(), { context: "internal" });
    expect(res.finalized).toBe(true);
    const text = res.warnings.join(" ");
    expect(text).toContain("Atomic not in the catalog");
    expect(text).toContain("lower than the work");
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

describe("the job-level material check, through the engine", () => {
  /*
    Kyle, 2026-08-21: "introduce a second check that looks at total material cost and apply it to
    the same tiered system we have."

    The unit tests in materialMarkupCap.test.ts prove the arithmetic. THIS proves it is actually
    wired: that computeEstimate applies it to the lines, that the lines still sum to the total, and
    that labour is untouched.

    Without this, every existing engine test would still pass — none of their fixtures carry enough
    material to reach a ceiling — and the check could sit in the codebase never once running.
  */

  /** A cheap part in volume: the exact shape that drove the blended markup to 3.39x. */
  const bulk = atomic({
    itemId: "BULK",
    unit: "ft",
    laborNormal: 1,
    costBasisUsed: 0.3,
    // Under $1 a unit, so the per-item ladder charges 5x — regardless of buying 2,000 feet.
    sellPricePerUnit: 1.5,
  });

  it("fires on bulk cheap material, which the per-item ladder cannot see", () => {
    const est = computeEstimate(
      [line({ itemId: "BULK", quantity: 2000 })],
      new Map([["BULK", bulk]]),
      RC,
      "HD",
    );

    // $600 of cost. The ladder wanted $3,000 — five times — on a job in the $250–999 band.
    expect(est.materialCost).toBeCloseTo(600, 2);
    const cap = est.materialCaps.A;
    expect(cap.applied).toBe(true);
    expect(cap.uncappedSell).toBeCloseTo(3000, 2);
    expect(cap.ceiling).toBe(2.5);
    expect(est.materialSell).toBeCloseTo(1500, 2);
    expect(cap.reduction).toBeCloseTo(1500, 2);
  });

  it("scales the LINES, so they still sum to the total", () => {
    // The drift this guards: a capped total with uncapped lines under it. Graduation's own
    // reconcile check refuses an estimate whose lines and total disagree, so this would not just
    // look wrong — it would block Kyle from issuing at all.
    const est = computeEstimate(
      [
        line({ itemId: "BULK", quantity: 2000 }),
        line({ itemId: "BULK", id: "second", quantity: 500 }),
      ],
      new Map([["BULK", bulk]]),
      RC,
      "HD",
    );
    const summed = est.lines.reduce((n, l) => n + (l.materialSell ?? 0), 0);
    expect(summed).toBeCloseTo(est.materialSell, 2);
    expect(summed).toBeCloseTo(est.materialCaps.A.cappedSell, 2);
  });

  it("does not touch labour", () => {
    const est = computeEstimate(
      [line({ itemId: "BULK", quantity: 2000 })],
      new Map([["BULK", bulk]]),
      RC,
      "HD",
    );
    // 2,000 units at 1 hr each on an E basis, at the configured rate. The cap has no business here.
    expect(est.laborHours).toBeCloseTo(2000, 2);
    expect(est.laborDollars).toBeCloseTo(2000 * RC.billedLaborRate!, 2);
  });

  it("prices each option as its own job", () => {
    /*
      Deliberate: a customer unticking option B on the presentation screen must not silently
      re-price option A. Here A is small enough to sit under its ceiling while B is not, and A must
      come through untouched.
    */
    const modest = atomic({ itemId: "M", laborNormal: 1, costBasisUsed: 10, sellPricePerUnit: 25 });
    const est = computeEstimate(
      [
        line({ itemId: "M", quantity: 2, option: "A" }),                 // $20 cost at 2.5x — under its ceiling
        line({ itemId: "BULK", id: "b", quantity: 2000, option: "B" }),  // $600 cost at 5x — over its ceiling
      ],
      new Map([["M", modest], ["BULK", bulk]]),
      RC,
      "HD",
    );
    expect(est.materialCaps.A.applied).toBe(false);
    expect(est.materialCaps.B.applied).toBe(true);
    const aLine = est.lines.find((l) => l.option === "A")!;
    expect(aLine.materialSell).toBeCloseTo(50, 2);   // 2 x 25, exactly as the ladder priced it
  });

  it("leaves a small job entirely alone", () => {
    // The dormancy property, at the engine level. Four of Kyle's six real estimates behave this way.
    const modest = atomic({ itemId: "M", laborNormal: 1, costBasisUsed: 10, sellPricePerUnit: 25 });
    const est = computeEstimate([line({ itemId: "M", quantity: 2 })], new Map([["M", modest]]), RC, "HD");
    expect(est.materialCaps.A.applied).toBe(false);
    expect(est.materialSell).toBeCloseTo(50, 2); // 2 x 25, untouched
  });
});

describe("what the job ceiling does to the 5x tier", () => {
  /*
    Found by a test of mine that asserted the wrong thing, which is the only reason it is written
    down here.

    The per-item ladder charges 5x for material under $1 a unit. The job-level ceiling for a job
    with under $250 of material is 3.5x. So a small job made ENTIRELY of sub-dollar parts is capped
    from 5x to 3.5x — the 5x tier can no longer reach a customer as a blended rate, only as one
    line's contribution among others.

    That follows directly from the schedule Kyle chose on 2026-08-21, and it is the same mechanism
    that pulls his 4.53x estimate into line. It is recorded because it is easy to mistake for a bug
    later: the workbook says 5x and the invoice will not.
  */
  const pennies = atomic({ itemId: "P", laborNormal: 1, costBasisUsed: 0.3, sellPricePerUnit: 1.5 });

  it("caps a small all-cheap-parts job at 3.5x, not 5x", () => {
    const est = computeEstimate([line({ itemId: "P", quantity: 100 })], new Map([["P", pennies]]), RC, "HD");
    expect(est.materialCost).toBeCloseTo(30, 2);
    expect(est.materialCaps.A.uncappedSell).toBeCloseTo(150, 2); // what 5x wanted
    expect(est.materialSell).toBeCloseTo(105, 2);                // 30 x 3.5
  });
});

describe("the third gate, through the engine", () => {
  /*
    Kyle, 2026-08-22: "Let's add the final check against the total combined options and treat them
    as a single job." The engine prices every combination so the presentation screen can show the
    saving live — this pins that the map ships and that it reads the POST-gate-2 lines.
  */
  const partA = atomic({ itemId: "PA", laborNormal: 1, costBasisUsed: 30, sellPricePerUnit: 75 });
  const partB = atomic({ itemId: "PB", laborNormal: 1, costBasisUsed: 30, sellPricePerUnit: 75 });

  it("ships a priced entry for every combination the customer could tick", () => {
    // Each option: $600 cost at 2.5x tier = $1,500 sell, exactly its own band ceiling (gate 2
    // silent). Together: $1,200 cost → 1.5x band → the discount exists only in combination.
    const est = computeEstimate(
      [
        line({ itemId: "PA", quantity: 20, option: "A" }),
        line({ itemId: "PB", quantity: 20, option: "B" }),
      ],
      new Map([["PA", partA], ["PB", partB]]),
      RC,
      "HD",
    );
    expect(Object.keys(est.combinationDiscounts).sort()).toEqual(["A", "A+B", "B"]);
    expect(est.combinationDiscounts.A.applied).toBe(false);
    expect(est.combinationDiscounts.B.applied).toBe(false);
    const both = est.combinationDiscounts["A+B"];
    expect(both.applied).toBe(true);
    expect(both.cappedSell).toBeCloseTo(1800, 2);
    expect(both.reduction).toBeCloseTo(1200, 2);
  });

  it("reads the lines AS GATE 2 LEFT THEM, not the raw tier prices", () => {
    // One big option that gate 2 already capped. The single-option "combination" must then show
    // nothing further — if this ever reports a reduction, gate 3 is double-counting gate 2.
    const est = computeEstimate(
      [line({ itemId: "PA", quantity: 40, option: "A" })], // $1,200 cost, tiers want $3,000
      new Map([["PA", partA]]),
      RC,
      "HD",
    );
    expect(est.materialCaps.A.applied).toBe(true); // gate 2 took it to 1.5x = $1,800
    expect(est.combinationDiscounts.A.applied).toBe(false); // gate 3 has nothing left to say
  });
});

describe("flat-priced lines survive the job-level material gates (Kyle, 2026-08-31)", () => {
  // Kyle's book: a $170-cost SMM at tier x1.8 with 1 hr → 306 + 150 = $456, asserted at import.
  const smm = atomic({
    itemId: "SMM", laborNormal: 1, source: "in-app",
    costBasisUsed: 170, sellPricePerUnit: 306, companyCost: 170, companyPrice: 306, sellNormal: 456,
  });
  // A big flat generator line in the same option pushes the blend over the $3,000+ ceiling.
  const gen = atomic({
    itemId: "GEN", laborNormal: 8, source: "in-app",
    costBasisUsed: 5400, sellPricePerUnit: 6750, companyCost: 5400, companyPrice: 6750, sellNormal: 7950,
  });
  // A supplier-priced NECA row (no sell columns) — the ladder the gates were built for.
  const wire = atomic({ itemId: "WIRE", laborNormal: 1, costBasisUsed: 3000, sellPricePerUnit: 4500 });
  const rc = { ...RC, billedLaborRate: 150, jobFixedCost: 0 };

  it("a flat line's estimate price equals its book price whatever else is on the job", () => {
    const out = computeEstimate(
      [line({ itemId: "GEN", option: "B" }), line({ itemId: "SMM", option: "B" })],
      new Map([["GEN", gen], ["SMM", smm]]), rc, "HD",
    );
    const smmLine = out.lines.find((l) => l.itemId === "SMM")!;
    expect(smmLine.flatPriced).toBe(true);
    expect((smmLine.laborDollars ?? 0) + (smmLine.materialSell ?? 0)).toBe(456);
    // An all-flat option has nothing for the gates to do — and says so.
    expect(out.materialCaps.B).toBeUndefined();
    expect(out.combinationDiscounts.B.applied).toBe(false);
  });

  it("supplier-priced lines in the same option are still capped, on their own numbers", () => {
    const out = computeEstimate(
      [line({ itemId: "GEN", option: "A" }), line({ itemId: "WIRE", option: "A" })],
      new Map([["GEN", gen], ["WIRE", wire]]), rc, "HD",
    );
    // $3,000 of supplier material sold at $4,500 = 1.5x, over the $3,000+ band's 1.25x ceiling.
    expect(out.materialCaps.A.applied).toBe(true);
    expect(out.materialCaps.A.materialCost).toBe(3000);
    expect(out.materialCaps.A.cappedSell).toBe(3750);
    const wireLine = out.lines.find((l) => l.itemId === "WIRE")!;
    expect(wireLine.materialSell).toBe(3750);
    // The flat generator did not move.
    const genLine = out.lines.find((l) => l.itemId === "GEN")!;
    expect((genLine.laborDollars ?? 0) + (genLine.materialSell ?? 0)).toBe(7950);
  });
});
