/**
 * "Create assembly" (2026-09-12 barcode/materials plan, Unit 1).
 *
 * An assembly is a PriceBookAtomic row (rowType "ASSEMBLY") with a PriceBookItemComponent list —
 * see src/services/priceBookAssembly.ts for why. These tests pin down the two ways that design
 * could quietly go wrong:
 *   1. Summing component companyPRICE (already marked up) instead of companyCOST would
 *      double-mark-up every assembly, invisibly.
 *   2. Summing a null-labour component as zero would produce a confident wrong number instead
 *      of the INCOMPLETE the schema calls for ("a finding, not a zero").
 * Plus nesting rejection, both inventory/supplier-cost guards, an explicit override surviving a
 * component change, and material-list aggregation across multiple lines.
 */

import { afterAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { prisma } from "../src/lib/prisma";
import {
  aggregateMaterialList,
  assertNotAssembly,
  computeComponentRollup,
  createAssembly,
  effectiveLaborTier,
  getAssemblyDetail,
  isAssemblyRowType,
  setAssemblyComponents,
  setLaborOverride,
  type ComponentAtomicFacts,
} from "../src/services/priceBookAssembly";
import { applyMovement } from "../src/services/inventory";

const newId = () => crypto.randomUUID().slice(0, 8).toUpperCase();

// A minimal, already-priced-and-laboured material row, matching the in-app editor's own
// convention (laborUnitBasis "E", divisor 1 — hours are per-unit, already resolved).
function materialAtomic(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    itemId: `TM-${newId()}`,
    description: "test material",
    category: "Test",
    rowType: "MATERIAL + LABOR",
    source: "in-app",
    companyCost: 10,
    laborNormal: 0.25,
    laborDifficult: 0.35,
    laborVeryDifficult: 0.5,
    laborUnitBasis: "E",
    laborUnitDivisor: 1,
    ...overrides,
  };
}

const createdItemIds: string[] = [];
async function makeAtomic(overrides: Partial<Record<string, unknown>> = {}) {
  const data = materialAtomic(overrides);
  const row = await prisma.priceBookAtomic.create({ data: data as never });
  createdItemIds.push(row.itemId);
  return row;
}

afterAll(async () => {
  // Children first (Restrict FK), then parents.
  await prisma.priceBookItemComponent.deleteMany({ where: { parentItemId: { in: createdItemIds } } });
  await prisma.priceBookEdit.deleteMany({ where: { itemId: { in: createdItemIds } } });
  await prisma.priceBookAtomic.deleteMany({ where: { itemId: { in: createdItemIds } } });
});

describe("computeComponentRollup — the trap: companyCost, never companyPrice", () => {
  it("sums companyCost x quantity, ignoring companyPrice entirely", () => {
    const facts = new Map<string, ComponentAtomicFacts>([
      ["A", { itemId: "A", description: null, rowType: "MATERIAL + LABOR", companyCost: 10, laborNormal: 0.25, laborDifficult: null, laborVeryDifficult: null, laborUnitDivisor: 1 }],
      ["B", { itemId: "B", description: null, rowType: "MATERIAL + LABOR", companyCost: 4, laborNormal: 0.1, laborDifficult: null, laborVeryDifficult: null, laborUnitDivisor: 1 }],
    ]);
    // Give A and B a companyPrice-shaped field too, to prove the rollup never reads it even if
    // present on the object (a caller passing the full atomic row, companyPrice and all).
    (facts.get("A") as unknown as Record<string, unknown>).companyPrice = 999;
    (facts.get("B") as unknown as Record<string, unknown>).companyPrice = 999;

    const rollup = computeComponentRollup(
      [{ childItemId: "A", quantity: 3 }, { childItemId: "B", quantity: 2 }],
      facts,
    );
    // 10*3 + 4*2 = 38. If this summed companyPrice (999) instead, it would be nowhere close.
    expect(rollup.companyCost).toBe(38);
    expect(rollup.costComplete).toBe(true);
  });

  it("labour sums per tier independently: normal to normal, difficult to difficult", () => {
    const facts = new Map<string, ComponentAtomicFacts>([
      ["A", { itemId: "A", description: null, rowType: "MATERIAL + LABOR", companyCost: 1, laborNormal: 0.25, laborDifficult: 0.4, laborVeryDifficult: 0.6, laborUnitDivisor: 1 }],
      ["B", { itemId: "B", description: null, rowType: "MATERIAL + LABOR", companyCost: 1, laborNormal: 0.1, laborDifficult: 0.2, laborVeryDifficult: 0.3, laborUnitDivisor: 1 }],
    ]);
    const rollup = computeComponentRollup(
      [{ childItemId: "A", quantity: 2 }, { childItemId: "B", quantity: 1 }],
      facts,
    );
    // normal: 0.25*2 + 0.1*1 = 0.6 ; difficult: 0.4*2 + 0.2*1 = 1.0 ; very-difficult: 0.6*2+0.3 = 1.5
    expect(rollup.labor.laborNormal.value).toBeCloseTo(0.6, 6);
    expect(rollup.labor.laborDifficult.value).toBeCloseTo(1.0, 6);
    expect(rollup.labor.laborVeryDifficult.value).toBeCloseTo(1.5, 6);
    expect(rollup.labor.laborNormal.complete).toBe(true);
  });

  it("a null-labour component is NOT summed as zero — the tier reads INCOMPLETE", () => {
    const facts = new Map<string, ComponentAtomicFacts>([
      ["A", { itemId: "A", description: null, rowType: "MATERIAL + LABOR", companyCost: 1, laborNormal: 0.25, laborDifficult: null, laborVeryDifficult: null, laborUnitDivisor: 1 }],
      // B publishes no normal-labour figure at all — NECA-blank, per the schema's own framing.
      ["B", { itemId: "B", description: null, rowType: "MATERIAL + LABOR", companyCost: 1, laborNormal: null, laborDifficult: null, laborVeryDifficult: null, laborUnitDivisor: 1 }],
    ]);
    const rollup = computeComponentRollup(
      [{ childItemId: "A", quantity: 1 }, { childItemId: "B", quantity: 1 }],
      facts,
    );
    expect(rollup.labor.laborNormal.complete).toBe(false);
    expect(rollup.labor.laborNormal.value).toBeNull(); // never a confident 0.25
    expect(rollup.labor.laborNormal.missingItemIds).toEqual(["B"]);
  });

  it("a component with a null unit-basis divisor also blocks its tier (E vs C is a 100x error)", () => {
    const facts = new Map<string, ComponentAtomicFacts>([
      ["A", { itemId: "A", description: null, rowType: "MATERIAL + LABOR", companyCost: 1, laborNormal: 0.25, laborDifficult: null, laborVeryDifficult: null, laborUnitDivisor: null }],
    ]);
    const rollup = computeComponentRollup([{ childItemId: "A", quantity: 1 }], facts);
    expect(rollup.labor.laborNormal.value).toBeNull();
    expect(rollup.labor.laborNormal.complete).toBe(false);
  });

  it("an unpriced component (null companyCost) makes the whole cost incomplete, not a partial sum treated as final", () => {
    const facts = new Map<string, ComponentAtomicFacts>([
      ["A", { itemId: "A", description: null, rowType: "MATERIAL + LABOR", companyCost: 10, laborNormal: 0.1, laborDifficult: null, laborVeryDifficult: null, laborUnitDivisor: 1 }],
      ["B", { itemId: "B", description: null, rowType: "MATERIAL + LABOR", companyCost: null, laborNormal: 0.1, laborDifficult: null, laborVeryDifficult: null, laborUnitDivisor: 1 }],
    ]);
    const rollup = computeComponentRollup(
      [{ childItemId: "A", quantity: 1 }, { childItemId: "B", quantity: 1 }],
      facts,
    );
    expect(rollup.companyCost).toBeNull();
    expect(rollup.costComplete).toBe(false);
    expect(rollup.unpricedComponentItemIds).toEqual(["B"]);
  });
});

describe("effectiveLaborTier — override stored explicitly, drift surfaced", () => {
  it("not overridden: follows the live component sum", () => {
    const eff = effectiveLaborTier(0.6, false, 0.6);
    expect(eff.overridden).toBe(false);
    expect(eff.value).toBe(0.6);
    expect(eff.driftFromComputed).toBeNull();
  });

  it("overridden and matching the sum: still reports overridden (never inferred from equality)", () => {
    const eff = effectiveLaborTier(0.6, true, 0.6);
    expect(eff.overridden).toBe(true);
    expect(eff.value).toBe(0.6);
    expect(eff.driftFromComputed).toBeNull(); // no drift to report, but the flag itself is explicit
  });

  it("overridden and now stale: surfaces the drift", () => {
    const eff = effectiveLaborTier(7, true, 6.4);
    expect(eff.overridden).toBe(true);
    expect(eff.value).toBe(7); // Kyle's number wins
    expect(eff.driftFromComputed).toBeCloseTo(0.6, 6);
  });
});

describe("aggregateMaterialList — one shopping list across assembly and plain lines", () => {
  it("expands an assembly line by its components x line quantity, and sums a plain material line across lines", () => {
    // "EV Charger x1" (an assembly of breaker + wire) plus "50 Amp Circuit THHN x3" (plain wire)
    // — Kyle's own example — must sum the wire across both.
    const componentsByParent = new Map([
      ["EV-CHARGER", [{ childItemId: "BREAKER-50A", quantity: 1 }, { childItemId: "THHN-WIRE", quantity: 20 }]],
    ]);
    const entries = aggregateMaterialList(
      [
        { itemId: "EV-CHARGER", quantity: 1 },
        { itemId: "THHN-WIRE", quantity: 3 }, // plain material line, not an assembly
      ],
      componentsByParent,
    );
    const byId = Object.fromEntries(entries.map((e) => [e.itemId, e.quantity]));
    expect(byId["BREAKER-50A"]).toBe(1);
    expect(byId["THHN-WIRE"]).toBe(20 * 1 + 3); // 20 from the assembly + 3 from the plain line
  });

  it("aggregates across MULTIPLE assembly lines with quantities", () => {
    const componentsByParent = new Map([
      ["ASM-A", [{ childItemId: "SCREW", quantity: 4 }]],
      ["ASM-B", [{ childItemId: "SCREW", quantity: 2 }, { childItemId: "BOX", quantity: 1 }]],
    ]);
    const entries = aggregateMaterialList(
      [
        { itemId: "ASM-A", quantity: 2 }, // 4 screws x 2 = 8
        { itemId: "ASM-B", quantity: 3 }, // 2 screws x 3 = 6 screws, 1 box x 3 = 3 boxes
      ],
      componentsByParent,
    );
    const byId = Object.fromEntries(entries.map((e) => [e.itemId, e.quantity]));
    expect(byId["SCREW"]).toBe(8 + 6);
    expect(byId["BOX"]).toBe(3);
  });
});

describe("createAssembly / setAssemblyComponents — integration against the test database", () => {
  it("creates an ASSEMBLY row whose cost and labour are derived from components, never typed", async () => {
    const a = await makeAtomic({ companyCost: 10, laborNormal: 0.25, laborDifficult: 0.4, laborVeryDifficult: 0.6 });
    const b = await makeAtomic({ companyCost: 4, laborNormal: 0.1, laborDifficult: 0.2, laborVeryDifficult: 0.3 });

    const result = await createAssembly(
      prisma,
      {
        description: "Test EV Charger Assembly",
        category: "Test",
        idPrefix: "TASM",
        components: [
          { childItemId: a.itemId, quantity: 3 },
          { childItemId: b.itemId, quantity: 2 },
        ],
      },
      "test",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const atomic = result.atomic as Record<string, unknown>;
    createdItemIds.push(atomic.itemId as string);

    expect(atomic.rowType).toBe("ASSEMBLY");
    expect(atomic.companyCost).toBe(10 * 3 + 4 * 2); // 38 — companyCost, not companyPrice
    expect(atomic.laborNormal).toBeCloseTo(0.25 * 3 + 0.1 * 2, 6);
    expect(atomic.laborNormalOverridden).toBe(false);
    expect(isAssemblyRowType(atomic.rowType as string)).toBe(true);
  });

  it("rejects a component whose rowType is ASSEMBLY — no nesting", async () => {
    const material = await makeAtomic();
    const inner = await createAssembly(prisma, {
      description: "Inner assembly", category: "Test", idPrefix: "TASM",
      components: [{ childItemId: material.itemId, quantity: 1 }],
    }, "test");
    expect(inner.ok).toBe(true);
    if (!inner.ok) return;
    const innerId = (inner.atomic as Record<string, unknown>).itemId as string;
    createdItemIds.push(innerId);

    const outer = await createAssembly(prisma, {
      description: "Outer assembly (should fail)", category: "Test", idPrefix: "TASM",
      components: [{ childItemId: innerId, quantity: 1 }],
    }, "test");
    expect(outer.ok).toBe(false);
    if (outer.ok) return;
    expect(outer.reason).toMatch(/itself an assembly/i);
  });

  it("a component with no labour makes the assembly read INCOMPLETE, not a confident zero", async () => {
    const noLabor = await makeAtomic({ laborNormal: null, laborUnitBasis: null, laborUnitDivisor: null });
    const result = await createAssembly(prisma, {
      description: "Assembly with an unlaboured component", category: "Test", idPrefix: "TASM",
      components: [{ childItemId: noLabor.itemId, quantity: 1 }],
    }, "test");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const atomic = result.atomic as Record<string, unknown>;
    createdItemIds.push(atomic.itemId as string);
    expect(atomic.laborNormal).toBeNull(); // not 0
  });

  it("an explicit override survives a component change; a non-overridden tier keeps following components", async () => {
    const comp = await makeAtomic({ laborNormal: 1, laborDifficult: 1, laborVeryDifficult: 1 });
    const created = await createAssembly(prisma, {
      description: "Overridable assembly", category: "Test", idPrefix: "TASM",
      components: [{ childItemId: comp.itemId, quantity: 1 }],
      laborOverrides: { laborNormal: 7 }, // Kyle's number; components alone would give 1
    }, "test");
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const itemId = (created.atomic as Record<string, unknown>).itemId as string;
    createdItemIds.push(itemId);
    expect((created.atomic as Record<string, unknown>).laborNormal).toBe(7);
    expect((created.atomic as Record<string, unknown>).laborNormalOverridden).toBe(true);
    // laborDifficult was never overridden — auto from the one component at qty 1 => 1
    expect((created.atomic as Record<string, unknown>).laborDifficult).toBe(1);

    // Now change the component's own labour — the override must NOT move, but the
    // non-overridden tier (difficult) must follow the correction.
    await prisma.priceBookAtomic.update({ where: { itemId: comp.itemId }, data: { laborNormal: 3.2, laborDifficult: 2 } });
    const updateResult = await setAssemblyComponents(
      prisma, itemId, [{ childItemId: comp.itemId, quantity: 1 }], "test",
    );
    expect(updateResult.ok).toBe(true);
    if (!updateResult.ok) return;
    const updatedAtomic = updateResult.atomic as Record<string, unknown>;
    expect(updatedAtomic.laborNormal).toBe(7); // override untouched by the component correction
    expect(updatedAtomic.laborNormalOverridden).toBe(true);
    expect(updatedAtomic.laborDifficult).toBe(2); // non-overridden tier followed the component

    // The drift is now visible in the detail view: Kyle set 7, components now total 3.2.
    const detail = await getAssemblyDetail(prisma, itemId);
    expect(detail?.labor.laborNormal.overridden).toBe(true);
    expect(detail?.labor.laborNormal.value).toBe(7);
    expect(detail?.labor.laborNormal.driftFromComputed).toBeCloseTo(7 - 3.2, 6);

    // Clearing the override reverts to the live component sum.
    const cleared = await setLaborOverride(prisma, itemId, "laborNormal", null, "test");
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    expect((cleared.atomic as Record<string, unknown>).laborNormal).toBe(3.2);
    expect((cleared.atomic as Record<string, unknown>).laborNormalOverridden).toBe(false);
  });
});

describe("guards — an assembly is not a purchasable thing", () => {
  it("assertNotAssembly throws for an assembly itemId and passes through a real material", async () => {
    const material = await makeAtomic();
    const assembly = await createAssembly(prisma, {
      description: "Guard-test assembly", category: "Test", idPrefix: "TASM",
      components: [{ childItemId: material.itemId, quantity: 1 }],
    }, "test");
    expect(assembly.ok).toBe(true);
    if (!assembly.ok) return;
    const assemblyId = (assembly.atomic as Record<string, unknown>).itemId as string;
    createdItemIds.push(assemblyId);

    await expect(assertNotAssembly(prisma, assemblyId, "appear in inventory")).rejects.toThrow(/assembly/i);
    await expect(assertNotAssembly(prisma, material.itemId, "appear in inventory")).resolves.toBeUndefined();
  });

  it("StockLevel guard: applyMovement refuses a purchase_in against an assembly itemId", async () => {
    const material = await makeAtomic();
    const assembly = await createAssembly(prisma, {
      description: "Inventory-guard assembly", category: "Test", idPrefix: "TASM",
      components: [{ childItemId: material.itemId, quantity: 1 }],
    }, "test");
    expect(assembly.ok).toBe(true);
    if (!assembly.ok) return;
    const assemblyId = (assembly.atomic as Record<string, unknown>).itemId as string;
    createdItemIds.push(assemblyId);

    await expect(
      prisma.$transaction((tx) =>
        applyMovement(tx, {
          kind: "purchase_in",
          itemId: assemblyId,
          name: "should be refused",
          qty: 1,
          unitCost: 5,
          toLocationKey: "warehouse",
          actor: "test",
        }),
      ),
    ).rejects.toThrow(/assembly/i);
  });
});
