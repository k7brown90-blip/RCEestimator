/**
 * Tests for the price-book pricing engine.
 *
 * These are NOT the verification bar — workbook parity is, and it is run by
 * scripts/price-book/priceBookParity.ts against the live file. Kyle's rule:
 * "passing tests is not evidence of success... it is evidence of not-obviously-broken."
 *
 * What they DO pin is the handful of behaviours where a plausible-looking
 * implementation is silently wrong and would still pass parity on today's data:
 * blank-is-not-zero, the structural quarantine, and the two-character LEFT() test.
 * Each case cites the workbook cell or the finding it comes from.
 */

import { describe, expect, it } from "vitest";
import {
  agreesToTheCent,
  computeAssembly,
  computeJobAdderHours,
  computeQuotableKey,
  computeUnitCost,
  evaluateLiteralArithmetic,
  markupTierFor,
  quoteAssembly,
  resolveCostBasis,
  sellPriceFor,
  type MarkupTiers,
  type RateConfig,
  type SupplierPriceRow,
} from "../src/services/priceBookPricing";

const TIERS: MarkupTiers = { tier1: 5, tier2: 3.5, tier3: 2.5, tier4: 1.8, tier5: 1.4 };

const RC: RateConfig = {
  billedLaborRate: 201.34,
  inspectionCoordination: 1,
  inspectionFolded: 0,
  utilityStandby: 1,
  permitFee: null,
  jobFixedCost: 200,
  activeSupplier: "HD",
  markupTiers: TIERS,
};

describe("computeUnitCost — Supplier Prices!F", () => {
  it("divides by 100 for /c and 1000 for /m", () => {
    expect(computeUnitCost(30, "/c", 1)).toBeCloseTo(0.3, 10);
    expect(computeUnitCost(450, "/m", 1)).toBeCloseTo(0.45, 10);
  });

  it("divides by pack qty otherwise — the 3-pack case (A006, $44.49/3)", () => {
    expect(computeUnitCost(44.49, "ea", 3)).toBeCloseTo(14.83, 10);
  });

  it("returns null, not 0, for a blank price", () => {
    expect(computeUnitCost(null, "ea", 1)).toBeNull();
  });
});

describe("the quarantine is structural", () => {
  const prices: SupplierPriceRow[] = [
    { itemId: "A016", supplierId: "HD", unitCost: 339.4, quotable: "YES", quotableKey: "A016|HD" },
    // The real quarantined row: E002 at HDSUPPLY. Priced, and unreachable.
    { itemId: "E002", supplierId: "HDSUPPLY", unitCost: 0.88, quotable: "NO", quotableKey: null },
    // Employer account — Mr. Electric's, never RCE's.
    { itemId: "X001", supplierId: "INLINE-MBORO", unitCost: 12.0, quotable: "NEVER", quotableKey: null },
  ];

  it("resolves a quotable price at the active supplier", () => {
    expect(resolveCostBasis("A016", "HD", prices).costBasis).toBe(339.4);
  });

  it("cannot reach a non-quotable price even though the row carries a real number", () => {
    expect(resolveCostBasis("E002", "HDSUPPLY", prices).costBasis).toBeNull();
    expect(resolveCostBasis("X001", "INLINE-MBORO", prices).costBasis).toBeNull();
  });

  it("NEVER falls back to another supplier — Kyle 2026-08-08", () => {
    // A016 is priced at HD. With LOWES active, the answer is "no price", not HD's.
    expect(resolveCostBasis("A016", "LOWES", prices).costBasis).toBeNull();
  });

  it("blanks the quotable key for anything not YES", () => {
    expect(computeQuotableKey("A016", "HD", "YES")).toBe("A016|HD");
    expect(computeQuotableKey("E002", "HDSUPPLY", "NO")).toBeNull();
    expect(computeQuotableKey("X001", "INLINE-MBORO", "NEVER")).toBeNull();
  });
});

describe("markup tiers — Atomics!W / Atomics!X", () => {
  it("bands on the workbook's boundaries", () => {
    expect(markupTierFor(0.5)).toBe("T1");
    expect(markupTierFor(1)).toBe("T2");
    expect(markupTierFor(9.99)).toBe("T2");
    expect(markupTierFor(10)).toBe("T3");
    expect(markupTierFor(49.99)).toBe("T3");
    expect(markupTierFor(50)).toBe("T4");
    expect(markupTierFor(199.99)).toBe("T4");
    expect(markupTierFor(200)).toBe("T5");
  });

  it("reports 'awaiting cost' and a NULL sell price for a blank basis — never $0.00", () => {
    expect(markupTierFor(null)).toBe("awaiting cost");
    expect(sellPriceFor(null, TIERS)).toBeNull();
  });

  it("reproduces A016: $339.40 cost at T5 -> $475.16 sell", () => {
    expect(sellPriceFor(339.4, TIERS)).toBeCloseTo(475.16, 8);
  });
});

describe("computeJobAdderHours — Assemblies!P", () => {
  const base = { assemblyId: "T", superseded: false, totalLaborNormal: 1 };

  it('adds nothing when the cell starts "NO" — the live wording is a whole sentence', () => {
    const hrs = computeJobAdderHours(
      {
        ...base,
        permitRequiredRaw: "NO - MANUALLY ADDED BY USER WHEN REQUIRED (Kyle 2026-08-06)",
        utilityStandbyRaw: "NO - MANUALLY ADDED BY USER WHEN REQUIRED (Kyle 2026-08-06)",
        heightAccessAdderHours: 0,
      },
      RC
    );
    expect(hrs).toBe(0);
  });

  it("turns the adder ON for anything not starting NO", () => {
    const hrs = computeJobAdderHours(
      { ...base, permitRequiredRaw: "YES", utilityStandbyRaw: "YES", heightAccessAdderHours: 0 },
      RC
    );
    // inspection (1 + 0) + standby (1) = 2 hr — Rate Config B135 names this block the
    // single largest source of overpricing, so the test pins it.
    expect(hrs).toBe(2);
  });

  it("treats a blank height adder as 0 via N() coercion", () => {
    const hrs = computeJobAdderHours(
      { ...base, permitRequiredRaw: "NO", utilityStandbyRaw: "NO", heightAccessAdderHours: null },
      RC
    );
    expect(hrs).toBe(0);
  });
});

describe("computeAssembly — the unpriced component must not read as free", () => {
  const atomicCost = new Map([
    ["A016", { costBasis: 339.4, sellPerUnit: 475.16 }],
    ["E002", { costBasis: null, sellPerUnit: null }],
  ]);

  const assembly = {
    assemblyId: "AS-TEST",
    status: "Draft",
    superseded: false,
    totalLaborNormal: 4,
    permitRequiredRaw: "NO - MANUALLY ADDED",
    utilityStandbyRaw: "NO - MANUALLY ADDED",
    heightAccessAdderHours: 0,
  };

  it("reproduces AS-001 exactly: 4 hr, one A016, $1,280.52", () => {
    const c = computeAssembly(assembly, [{ itemId: "A016", quantity: 1 }], atomicCost, RC);
    expect(c.laborDollars).toBeCloseTo(805.36, 8);
    expect(c.materialSell).toBeCloseTo(475.16, 8);
    expect(c.totalFlatRate).toBeCloseTo(1280.52, 8);
    expect(c.totalWithFixedCost).toBeCloseTo(1480.52, 8);
    expect(c.materialComplete).toBe("COMPLETE");
  });

  it("counts an unpriced component and says INCOMPLETE in the workbook's own wording", () => {
    const c = computeAssembly(
      assembly,
      [{ itemId: "A016", quantity: 1 }, { itemId: "E002", quantity: 2 }],
      atomicCost,
      RC
    );
    expect(c.componentsUnpriced).toBe(1);
    expect(c.materialComplete).toBe("INCOMPLETE - 1 of 2 unpriced");
    // The unpriced line contributes zero money — matching the workbook — which is
    // exactly why the COUNTER and not the total is what says the number is incomplete.
    expect(c.materialSell).toBeCloseTo(475.16, 8);
  });
});

describe("the quote gate refuses with a reason, never a $0 line", () => {
  const atomicCost = new Map([["E002", { costBasis: null, sellPerUnit: null }]]);
  const assembly = {
    assemblyId: "AS-003",
    status: "Draft",
    superseded: false,
    totalLaborNormal: 0.24,
    permitRequiredRaw: "NO",
    utilityStandbyRaw: "NO",
    heightAccessAdderHours: 0,
  };

  it("refuses an assembly whose only component is unpriced, and names it", () => {
    const c = computeAssembly(assembly, [{ itemId: "E002", quantity: 2 }], atomicCost, {
      ...RC,
      billedLaborRate: 150,
    });
    const r = quoteAssembly(assembly, c, { context: "customer" });
    expect(r.quotable).toBe(false);
    if (!r.quotable) {
      expect(r.reasons.join(" ")).toContain("E002");
      expect(r.reasons.join(" ")).toContain("INCOMPLETE");
    }
  });

  it("refuses a SUPERSEDED row outright", () => {
    const superseded = { ...assembly, assemblyId: "AS-024", superseded: true, status: "SUPERSEDED 2026-08-06 - DO NOT QUOTE" };
    const c = computeAssembly(superseded, [], atomicCost, { ...RC, billedLaborRate: 150 });
    const r = quoteAssembly(superseded, c, { context: "customer" });
    expect(r.quotable).toBe(false);
    if (!r.quotable) expect(r.reasons.join(" ")).toContain("SUPERSEDED");
  });

  it("blocks a customer price at a provisional rate but allows internal computation", () => {
    const ok = { ...assembly, assemblyId: "AS-001", totalLaborNormal: 4 };
    const cost = new Map([["A016", { costBasis: 339.4, sellPerUnit: 475.16 }]]);
    const c = computeAssembly(ok, [{ itemId: "A016", quantity: 1 }], cost, RC);

    const customer = quoteAssembly(ok, c, { context: "customer", rateProvisional: true });
    expect(customer.quotable).toBe(false);

    const internal = quoteAssembly(ok, c, { context: "internal", rateProvisional: true });
    expect(internal.quotable).toBe(true);
    if (internal.quotable) expect(internal.warnings.join(" ")).toContain("PROVISIONAL");
  });
});

describe("evaluateLiteralArithmetic — the independent labour check", () => {
  it("evaluates the real AS-004 formula", () => {
    // =4*0.25+4*0.05+(4/100)*30+(4/100)*10
    expect(evaluateLiteralArithmetic("=4*0.25+4*0.05+(4/100)*30+(4/100)*10")).toBeCloseTo(2.8, 10);
  });

  it("evaluates AS-006's mixed parenthesised form", () => {
    expect(
      evaluateLiteralArithmetic("=(30/100)+(15/100)+(30/100)+(10/100)+(15/100)*4.5+2*0.04+2*0.08")
    ).toBeCloseTo(1.765, 10);
  });

  it("REFUSES anything containing a cell reference rather than guessing", () => {
    expect(evaluateLiteralArithmetic("=1*N(Atomics!K176)")).toBeNull();
    expect(evaluateLiteralArithmetic("=SUM(A1:A5)")).toBeNull();
  });

  it("refuses malformed input instead of returning a partial answer", () => {
    expect(evaluateLiteralArithmetic("=4*")).toBeNull();
    expect(evaluateLiteralArithmetic("=(4+2")).toBeNull();
    expect(evaluateLiteralArithmetic("=4/0")).toBeNull();
    expect(evaluateLiteralArithmetic(null)).toBeNull();
  });
});

describe("agreesToTheCent", () => {
  it("accepts float noise under a cent and rejects a real cent of difference", () => {
    expect(agreesToTheCent(1280.5200000001, 1280.52)).toBe(true);
    expect(agreesToTheCent(1280.52, 1280.53)).toBe(false);
  });

  it("treats null as matching only null — a missing number is not zero", () => {
    expect(agreesToTheCent(null, null)).toBe(true);
    expect(agreesToTheCent(null, 0)).toBe(false);
  });
});
