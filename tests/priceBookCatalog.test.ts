/**
 * The in-app editor's pricing must be the workbook's pricing — these tests pin
 * computePricing to the formulas the import parity-asserted:
 *   companyPrice = round(companyCost × tier multiplier, 2)
 *   sell_d       = round(laborHours_d × $150 + companyPrice, 2)
 * with LABOR ONLY carrying no material and MATERIAL ONLY carrying no labour line.
 */

import { describe, expect, it } from "vitest";
import { computePricing, createAtomic, updateAtomic } from "../src/services/priceBookCatalog";
import type { MarkupTiers } from "../src/services/priceBookPricing";
import { laborHoursFor } from "../src/services/atomicEstimateEngine";

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

  it("in-app items carry a labor unit basis the engine can read", async () => {
    // Kyle's GENERAL LABOR item (2026-08-30): created in the editor with per-unit
    // hours but no laborUnitBasis/divisor, so laborHoursFor blocked (by design —
    // the E-vs-C guard) and the whole $100 sell was classified as material.
    let created: Record<string, unknown> | null = null;
    const prisma = {
      priceBookAtomic: {
        findUnique: () => Promise.resolve(null),
        findMany: () => Promise.resolve([]),
        create: (args: { data: Record<string, unknown> }) => { created = args.data; return Promise.resolve(args.data); },
      },
      priceBookEdit: { create: () => Promise.resolve({}), createMany: () => Promise.resolve({}) },
      priceBookRateConfig: {
        findMany: () => Promise.resolve([1, 2, 3, 4, 5].map((n) => ({ key: `markupTier${n}`, numberValue: n }))),
      },
      $transaction: (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
    } as never;

    const result = await createAtomic(
      prisma,
      { description: "General labor", category: "LABOR", rowType: "LABOR ONLY", laborNormal: 0.00664 },
      "test",
    );
    expect(result.ok).toBe(true);
    expect(created!["laborUnitBasis"]).toBe("E");
    expect(created!["laborUnitDivisor"]).toBe(1);

    // The engine must resolve hours from the created row: qty 100 × 0.00664 / 1.
    const hours = laborHoursFor(
      { ...(created as object), unit: null, costBasisUsed: null, sellPricePerUnit: null, necaUnitBasis: null } as never,
      100,
      "NORMAL",
    );
    expect(hours).toBeCloseTo(0.664, 10);
  });

  it("editing hours on a basis-less row heals the unit basis", async () => {
    const existing = {
      itemId: "GENERAL LABOR", description: "General labor", category: "LABOR", subCategory: null,
      unitLabel: null, notes: null, sector: null, rowType: "LABOR ONLY",
      companyCost: null, laborNormal: 0.006, laborDifficult: null, laborVeryDifficult: null,
      laborUnitBasis: null, laborUnitDivisor: null,
      markupTier: "T1", companyPrice: null, sellNormal: 0.9, sellDifficult: null, sellVeryDifficult: null,
    };
    let updated: Record<string, unknown> | null = null;
    const prisma = {
      priceBookAtomic: {
        findUnique: () => Promise.resolve(existing),
        update: (args: { data: Record<string, unknown> }) => { updated = args.data; return Promise.resolve({ ...existing, ...args.data }); },
      },
      priceBookEdit: { create: () => Promise.resolve({}), createMany: () => Promise.resolve({}) },
      priceBookRateConfig: {
        findMany: () => Promise.resolve([1, 2, 3, 4, 5].map((n) => ({ key: `markupTier${n}`, numberValue: n }))),
      },
      $transaction: (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
    } as never;

    const result = await updateAtomic(prisma, "GENERAL LABOR", { laborNormal: 0.00664 }, "test");
    expect(result.ok).toBe(true);
    expect(updated!["laborUnitBasis"]).toBe("E");
    expect(updated!["laborUnitDivisor"]).toBe(1);
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
