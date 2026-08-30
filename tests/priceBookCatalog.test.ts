/**
 * The in-app editor's pricing must be the workbook's pricing — these tests pin
 * computePricing to the formulas the import parity-asserted:
 *   companyPrice = round(companyCost × tier multiplier, 2)
 *   sell_d       = round(laborHours_d × $150 + companyPrice, 2)
 * with LABOR ONLY carrying no material and MATERIAL ONLY carrying no labour line.
 */

import { describe, expect, it } from "vitest";
import { computePricing } from "../src/services/priceBookCatalog";
import type { MarkupTiers } from "../src/services/priceBookPricing";

// Representative tier multipliers — the real ones live in PriceBookRateConfig;
// the formula, not the figures, is under test here.
const TIERS: MarkupTiers = { tier1: 3, tier2: 2.5, tier3: 2, tier4: 1.75, tier5: 1.5 };

describe("computePricing — workbook parity", () => {
  it("material + labor: markup on cost, then hours × 150 + material", () => {
    const p = computePricing(
      { rowType: "MATERIAL + LABOR", companyCost: 20, laborNormal: 1, laborDifficult: 1.5, laborVeryDifficult: 2 },
      TIERS,
    );
    // $20 cost → tier 3 ($10.00–$49.99) → ×2 = $40 material
    expect(p.markupTier).toBe("T3");
    expect(p.companyPrice).toBe(40);
    expect(p.sellNormal).toBe(190); // 1.0 × 150 + 40
    expect(p.sellDifficult).toBe(265); // 1.5 × 150 + 40
    expect(p.sellVeryDifficult).toBe(340); // 2.0 × 150 + 40
  });

  it("labor only: cost is ignored, material contributes $0, not a guess", () => {
    const p = computePricing(
      { rowType: "LABOR ONLY", companyCost: 999, laborNormal: 2, laborDifficult: 3, laborVeryDifficult: 4 },
      TIERS,
    );
    expect(p.companyPrice).toBeNull();
    expect(p.sellNormal).toBe(300);
    expect(p.sellDifficult).toBe(450);
    expect(p.sellVeryDifficult).toBe(600);
  });

  it("material only: every sell column is the marked-up material, no labour line", () => {
    const p = computePricing(
      { rowType: "MATERIAL ONLY", companyCost: 100, laborNormal: null, laborDifficult: null, laborVeryDifficult: null },
      TIERS,
    );
    // $100 → tier 4 ($50.00–$199.99) → ×1.75
    expect(p.markupTier).toBe("T4");
    expect(p.companyPrice).toBe(175);
    expect(p.sellNormal).toBe(175);
    expect(p.sellDifficult).toBe(175);
    expect(p.sellVeryDifficult).toBe(175);
  });

  it("missing hours stay null — a blank is never priced as zero", () => {
    const p = computePricing(
      { rowType: "MATERIAL + LABOR", companyCost: 5, laborNormal: 0.5, laborDifficult: null, laborVeryDifficult: null },
      TIERS,
    );
    // $5 → tier 2 ($1.00–$9.99) → ×2.5 = $12.50
    expect(p.companyPrice).toBe(12.5);
    expect(p.sellNormal).toBe(87.5); // 0.5 × 150 + 12.50
    expect(p.sellDifficult).toBeNull();
    expect(p.sellVeryDifficult).toBeNull();
  });

  it("rounds to cents exactly once, at each formula's output", () => {
    const p = computePricing(
      { rowType: "MATERIAL + LABOR", companyCost: 0.99, laborNormal: 0.33, laborDifficult: null, laborVeryDifficult: null },
      TIERS,
    );
    // $0.99 → tier 1 (under $1.00) → ×3 = $2.97
    expect(p.markupTier).toBe("T1");
    expect(p.companyPrice).toBe(2.97);
    expect(p.sellNormal).toBe(52.47); // 0.33 × 150 = 49.50 + 2.97
  });
});
