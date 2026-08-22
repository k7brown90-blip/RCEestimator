/**
 * The second check on material markup — the one that reads the size of the job.
 *
 * Kyle, 2026-08-21: *"We have to plan the best way for the material mark ups work against total
 * material cost so it stays within a reasonable range."* and *"I think we keep the main tiers but
 * introduce a second check that looks at total material cost."*
 *
 * ── WHY THIS FILE IS PARANOID ──────────────────────────────────────────────────────────────────
 *
 * It changes what a customer is charged, on every estimate, silently by design. The per-item tiers
 * have a workbook Kyle can read and check against; this has only code. So the properties that make
 * it safe are asserted directly rather than inferred from a worked example:
 *
 *   it only ever caps, it never touches labour, and the lines always sum to the capped figure.
 *
 * The real figures below are from his six issued estimates, read out of production on 2026-08-21.
 */

import { describe, expect, it } from "vitest";
import { allSelectionCaps, bandFor, capMaterial, comboKey, JOB_MATERIAL_BANDS, selectionCap } from "../src/services/materialMarkupCap";

describe("which band a job lands in", () => {
  it("reads the ladder off the JOB's material cost, not one item's price", () => {
    expect(bandFor(46.27).ceiling).toBe(3.5); // 2026-1023
    expect(bandFor(542.22).ceiling).toBe(2.5); // the basement remodel in progress
    expect(bandFor(1500).ceiling).toBe(1.5);
    expect(bandFor(3000).ceiling).toBe(1.25);
    expect(bandFor(25000).ceiling).toBe(1.25);
  });

  it("puts a boundary in exactly one band", () => {
    // 250 is the top of the first band exclusive, so it belongs to the second.
    expect(bandFor(249.99).ceiling).toBe(3.5);
    expect(bandFor(250).ceiling).toBe(2.5);
    expect(bandFor(999.99).ceiling).toBe(2.5);
    expect(bandFor(1000).ceiling).toBe(1.5);
  });

  it("has no gap and never falls through", () => {
    // A schedule with a hole in it would return undefined and price material at NaN.
    for (const cost of [0, 0.01, 1, 249, 250, 999, 1000, 2999, 3000, 1e6]) {
      const band = bandFor(cost);
      expect(band, `no band for ${cost}`).toBeDefined();
      expect(band.ceiling).toBeGreaterThan(0);
    }
    expect(JOB_MATERIAL_BANDS[JOB_MATERIAL_BANDS.length - 1].upTo).toBeNull();
  });
});

describe("what the check does to Kyle's real estimates", () => {
  /*
    Four of six must not move. That is the whole design: the check sits dormant on work that was
    already priced sensibly, and only speaks up when something is out of range.
  */
  const untouched: Array<[string, number, number]> = [
    ["2026-1023", 46.27, 135.47],
    ["2026-1022", 239.82, 599.55],
    ["2026-1021", 53.29, 151.19],
    ["2026-1017", 137.76, 349.44],
  ];

  for (const [name, cost, sell] of untouched) {
    it(`leaves ${name} alone`, () => {
      const r = capMaterial(cost, sell);
      expect(r.applied).toBe(false);
      expect(r.cappedSell).toBe(sell);
      expect(r.reduction).toBe(0);
    });
  }

  it("catches 2026-1019, which was running at 4.53x", () => {
    const r = capMaterial(168.02, 760.87);
    expect(r.applied).toBe(true);
    expect(r.blended).toBeCloseTo(4.53, 2);
    expect(r.ceiling).toBe(3.5);
    expect(r.cappedSell).toBe(588.07); // 168.02 × 3.5
    expect(r.reduction).toBe(172.8);
  });

  it("catches the basement remodel, which was running at 3.05x", () => {
    const r = capMaterial(542.22, 1656.05);
    expect(r.applied).toBe(true);
    expect(r.ceiling).toBe(2.5);
    expect(r.cappedSell).toBe(1355.55); // 542.22 × 2.5
    expect(r.reduction).toBe(300.5);
  });
});

describe("the properties that make it safe", () => {
  it("NEVER raises a price", () => {
    // The failure that would matter most: a "cap" that quietly marks material UP because a job
    // fell into a generous band. Swept across the whole range rather than spot-checked.
    for (let cost = 1; cost <= 5000; cost += 37) {
      for (const multiple of [0.5, 1, 1.2, 2, 3.5, 5, 9]) {
        const sell = cost * multiple;
        const r = capMaterial(cost, sell);
        expect(r.cappedSell, `cost ${cost} at ${multiple}x was raised`).toBeLessThanOrEqual(
          Math.round(sell * 100) / 100 + 0.001,
        );
      }
    }
  });

  it("brings anything it touches to exactly the ceiling, and no further", () => {
    for (let cost = 10; cost <= 5000; cost += 91) {
      const r = capMaterial(cost, cost * 9); // wildly over every band
      expect(r.applied).toBe(true);
      expect(r.cappedSell).toBeCloseTo(cost * r.ceiling, 2);
    }
  });

  it("does nothing when there is no recorded cost, rather than pricing at zero", () => {
    // A line whose cost the engine could not determine already reports itself incomplete. Treating
    // a missing cost as $0 here would mark the material down to nothing on the quiet.
    const r = capMaterial(0, 500);
    expect(r.applied).toBe(false);
    expect(r.cappedSell).toBe(500);
  });

  it("does nothing when there is no material to charge for", () => {
    const r = capMaterial(0, 0);
    expect(r.applied).toBe(false);
    expect(r.cappedSell).toBe(0);
    expect(Number.isFinite(r.blended)).toBe(true); // not NaN from dividing by zero
  });

  it("reports its working even when it changes nothing", () => {
    // Kyle has to be able to see the ceiling that governed, not only the ones that bit.
    const r = capMaterial(100, 200);
    expect(r.applied).toBe(false);
    expect(r.ceiling).toBe(3.5);
    expect(r.bandLabel).toBe("under $250");
    expect(r.blended).toBeCloseTo(2, 5);
  });
});

describe("the third gate — the combined selection as one job", () => {
  /*
    Kyle, 2026-08-22: *"If the customer chooses one, two, or three options the savings add up and
    help push the sale of more work simply by lowing the cost of material. I win because I lose
    nothing on labor and can get the material all same day."*

    The lever only works if these hold: a single option NEVER gets a further cut (its sell already
    meets its own band), and the discount appears exactly when combining reaches a deeper band.
  */

  // Two options, each $600 cost sold at its own band ceiling ($250–999 → 2.5x = $1,500).
  const lines = [
    { option: "A", materialCost: 600, materialSell: 1500 },
    { option: "B", materialCost: 600, materialSell: 1500 },
  ];

  it("gives a single option nothing further — gate 2 already priced it", () => {
    const r = selectionCap(lines, new Set(["A"]));
    expect(r.applied).toBe(false);
    expect(r.reduction).toBe(0);
  });

  it("discounts the combination that crosses into a deeper band", () => {
    // Together: $1,200 cost → $1,000–2,999 band → 1.5x ceiling = $1,800 against $3,000 charged.
    const r = selectionCap(lines, new Set(["A", "B"]));
    expect(r.applied).toBe(true);
    expect(r.ceiling).toBe(1.5);
    expect(r.cappedSell).toBe(1800);
    expect(r.reduction).toBe(1200);
  });

  it("never charges a combination more than the sum of its parts", () => {
    // The property that makes it safe to advertise: adding an option can only lower the blended
    // rate, never raise the bill above the parts. Swept, not spot-checked.
    for (const [cA, cB] of [[50, 900], [200, 200], [999, 2500], [10, 5000], [300, 750]]) {
      const ls = [
        { option: "A", materialCost: cA, materialSell: capMaterial(cA, cA * 5).cappedSell },
        { option: "B", materialCost: cB, materialSell: capMaterial(cB, cB * 5).cappedSell },
      ];
      const parts = ls[0].materialSell + ls[1].materialSell;
      const both = selectionCap(ls, new Set(["A", "B"]));
      expect(both.cappedSell, `A=${cA} B=${cB}`).toBeLessThanOrEqual(parts + 0.001);
    }
  });

  it("prices Kyle's live Home Additions draft the way he saw it", () => {
    // From production on 2026-08-22: A $39.31 cost charged $137.59, B $502.91 charged $1,257.28
    // (post-gate-2). Combined $542.22 in the $250–999 band → 2.5x = $1,355.55 vs $1,394.87.
    const draft = [
      { option: "A", materialCost: 39.31, materialSell: 137.59 },
      { option: "B", materialCost: 502.91, materialSell: 1257.28 },
    ];
    const r = selectionCap(draft, new Set(["A", "B"]));
    expect(r.applied).toBe(true);
    expect(r.cappedSell).toBeCloseTo(1355.55, 2);
    expect(r.reduction).toBeCloseTo(39.32, 2);
  });

  it("enumerates every combination once, under a canonical key", () => {
    const all = allSelectionCaps([
      { option: "A", materialCost: 100, materialSell: 300 },
      { option: "B", materialCost: 100, materialSell: 300 },
      { option: "C", materialCost: 100, materialSell: 300 },
    ]);
    expect(Object.keys(all).sort()).toEqual(["A", "A+B", "A+B+C", "A+C", "B", "B+C", "C"]);
    expect(comboKey(["C", "A"])).toBe("A+C"); // order the caller uses cannot mint a second key
  });
});
