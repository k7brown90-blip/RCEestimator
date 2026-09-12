/**
 * The material database (2026-09-12, barcode/materials plan Unit 2).
 *
 * Three layers, not two: a Material (purchasable product, no labour) is separate from a
 * PriceBookAtomic (the estimating unit, carries labour) and from an ASSEMBLY (never purchasable).
 * These tests pin down the things most likely to go quietly wrong:
 *   1. Both pack-size conversions (cost per unit, and stock quantity — packs are not units).
 *   2. Derived completion in each distinct failure mode — never a stored flag.
 *   3. (supplier, sku) uniqueness allowing the same digits under two suppliers, while a true
 *      duplicate (same supplier, same sku) is rejected — the schema's actual risk (see plan
 *      risk register #4: a SKU unique on sku alone silently merges two different products).
 *   4. Global upc uniqueness.
 *   5. Link and promote — the two ways to complete a material.
 *   6. The assembly guard carried from Unit 1: neither link nor promote may target/produce an
 *      ASSEMBLY row.
 */

import { afterAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { prisma } from "../src/lib/prisma";
import {
  createMaterial, getMaterialCompletion, linkMaterial, materialCompletion, perUnitCostFromPack,
  promoteMaterial, stockQtyFromPacks, updateMaterial,
} from "../src/services/materials";
import { createAssembly } from "../src/services/priceBookAssembly";

const newId = () => crypto.randomUUID().slice(0, 8).toUpperCase();

const createdItemIds: string[] = [];
const createdMaterialIds: string[] = [];

async function makeAtomic(overrides: Partial<Record<string, unknown>> = {}) {
  const data = {
    itemId: `TMAT-${newId()}`,
    description: "test atomic",
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
  const row = await prisma.priceBookAtomic.create({ data: data as never });
  createdItemIds.push(row.itemId);
  return row;
}

async function makeMaterial(overrides: Partial<Record<string, unknown>> = {}) {
  const result = await createMaterial(prisma, {
    description: "test material",
    ...overrides,
  } as never);
  if (!result.ok) throw new Error(result.reason);
  createdMaterialIds.push(result.material.id);
  return result.material;
}

afterAll(async () => {
  await prisma.material.deleteMany({ where: { id: { in: createdMaterialIds } } });
  await prisma.priceBookItemComponent.deleteMany({ where: { parentItemId: { in: createdItemIds } } });
  await prisma.priceBookEdit.deleteMany({ where: { itemId: { in: createdItemIds } } });
  await prisma.priceBookAtomic.deleteMany({ where: { itemId: { in: createdItemIds } } });
});

describe("pack-size conversions", () => {
  it("perUnitCostFromPack: package price / packQty, rounded to the cent", () => {
    expect(perUnitCostFromPack(11.97, 10)).toBeCloseTo(1.2, 6);
    expect(perUnitCostFromPack(100, 3)).toBeCloseTo(33.33, 2);
  });

  it("perUnitCostFromPack refuses a non-positive packQty rather than dividing", () => {
    expect(() => perUnitCostFromPack(10, 0)).toThrow(/packQty/);
    expect(() => perUnitCostFromPack(10, -1)).toThrow(/packQty/);
  });

  it("stockQtyFromPacks: buying packs raises stock by packQty x packsPurchased, not by packsPurchased alone", () => {
    // Kyle's own example: a pack of 10 raises qtyOnHand by 10, not 1.
    expect(stockQtyFromPacks(10, 1)).toBe(10);
    expect(stockQtyFromPacks(10, 3)).toBe(30);
    expect(stockQtyFromPacks(1, 5)).toBe(5); // a "pack of 1" still behaves correctly
  });

  it("stockQtyFromPacks refuses non-positive inputs", () => {
    expect(() => stockQtyFromPacks(0, 1)).toThrow(/packQty/);
    expect(() => stockQtyFromPacks(10, 0)).toThrow(/packsPurchased/);
  });
});

describe("derived completion — never a stored flag", () => {
  it("assigned: linked to an atomic with labour on at least one tier, and has a cost", () => {
    const c = materialCompletion(
      { itemId: "X", lastCost: 1.2 },
      { laborNormal: 0.25, laborDifficult: null, laborVeryDifficult: null },
    );
    expect(c).toEqual({ assigned: true, missing: [] });
  });

  it("failure mode: no_link — no itemId at all", () => {
    const c = materialCompletion({ itemId: null, lastCost: 1.2 }, null);
    expect(c.assigned).toBe(false);
    expect(c.missing).toEqual(["no_link"]);
  });

  it("failure mode: no_labor — linked, but the atomic carries no labour on any tier", () => {
    const c = materialCompletion(
      { itemId: "X", lastCost: 1.2 },
      { laborNormal: null, laborDifficult: null, laborVeryDifficult: null },
    );
    expect(c.assigned).toBe(false);
    expect(c.missing).toEqual(["no_labor"]);
  });

  it("failure mode: no_cost — linked with labour, but the material itself has no cost", () => {
    const c = materialCompletion(
      { itemId: "X", lastCost: null },
      { laborNormal: 0.25, laborDifficult: null, laborVeryDifficult: null },
    );
    expect(c.assigned).toBe(false);
    expect(c.missing).toEqual(["no_cost"]);
  });

  it("both failure modes can stack: no link AND no cost", () => {
    const c = materialCompletion({ itemId: null, lastCost: null }, null);
    expect(c.assigned).toBe(false);
    expect(c.missing).toEqual(["no_link", "no_cost"]);
  });

  it("getMaterialCompletion reads the linked atomic's labour live, from the database", async () => {
    const atomic = await makeAtomic({ laborNormal: null, laborDifficult: null, laborVeryDifficult: null });
    const material = await makeMaterial({ lastCost: 5, itemId: atomic.itemId });
    const before = await getMaterialCompletion(prisma, material);
    expect(before.missing).toEqual(["no_labor"]);

    // Editing the atomic's labour later must flip completion without touching the material row —
    // this IS the "derived, never stored" property under test.
    await prisma.priceBookAtomic.update({ where: { itemId: atomic.itemId }, data: { laborNormal: 0.25 } });
    const after = await getMaterialCompletion(prisma, material);
    expect(after).toEqual({ assigned: true, missing: [] });
  });
});

describe("(supplier, sku) uniqueness — never sku alone", () => {
  it("the same SKU digits are allowed under two different suppliers", async () => {
    const sku = `SKU-${newId()}`;
    const a = await createMaterial(prisma, { sku, supplier: "Home Depot" });
    const b = await createMaterial(prisma, { sku, supplier: "SiteOne" });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (a.ok) createdMaterialIds.push(a.material.id);
    if (b.ok) createdMaterialIds.push(b.material.id);
  });

  it("a true duplicate — same supplier, same sku — is rejected", async () => {
    const sku = `SKU-${newId()}`;
    const first = await createMaterial(prisma, { sku, supplier: "Home Depot" });
    expect(first.ok).toBe(true);
    if (first.ok) createdMaterialIds.push(first.material.id);

    const dup = await createMaterial(prisma, { sku, supplier: "Home Depot" });
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.reason).toMatch(/sku/i);
  });
});

describe("global upc uniqueness", () => {
  it("rejects a second material with the same UPC regardless of supplier", async () => {
    const upc = `${Math.floor(Math.random() * 1e12)}`;
    const first = await createMaterial(prisma, { upc, supplier: "Home Depot" });
    expect(first.ok).toBe(true);
    if (first.ok) createdMaterialIds.push(first.material.id);

    const dup = await createMaterial(prisma, { upc, supplier: "Lowes" });
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.reason).toMatch(/upc/i);
  });
});

describe("link — join an existing price book item", () => {
  it("links a material to an atomic that already carries labour", async () => {
    const atomic = await makeAtomic();
    const material = await makeMaterial({ lastCost: 12, packQty: 10 });
    const result = await linkMaterial(prisma, material.id, atomic.itemId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.material.itemId).toBe(atomic.itemId);
    const completion = await getMaterialCompletion(prisma, result.material);
    expect(completion).toEqual({ assigned: true, missing: [] });
  });

  it("refuses to link to an unknown itemId", async () => {
    const material = await makeMaterial({ lastCost: 5 });
    const result = await linkMaterial(prisma, material.id, "NO-SUCH-ITEM");
    expect(result.ok).toBe(false);
  });
});

describe("promote — create a new price book item for a material with no counterpart", () => {
  it("creates a new atomic via createAtomic and links the material to it, deriving cost from the pack", async () => {
    const material = await makeMaterial({ lastCost: 11.97, packQty: 10, description: "Leviton 5320-W 10-pack" });
    const result = await promoteMaterial(prisma, material.id, {
      description: "Duplex receptacle", category: "Test", idPrefix: "TPRM", rowType: "MATERIAL + LABOR",
      laborNormal: 0.25,
    }, "test");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    createdItemIds.push((result.atomic as { itemId: string }).itemId);

    expect(result.material.itemId).toBe((result.atomic as { itemId: string }).itemId);
    // 11.97 / 10 = 1.197 -> rounded to the cent, comparable to the book's per-each companyCost.
    expect((result.atomic as { companyCost: number }).companyCost).toBeCloseTo(1.2, 2);

    const completion = await getMaterialCompletion(prisma, result.material);
    expect(completion).toEqual({ assigned: true, missing: [] });
  });

  it("refuses to promote a material that is already linked", async () => {
    const atomic = await makeAtomic();
    const material = await makeMaterial({ lastCost: 5, itemId: atomic.itemId });
    const result = await promoteMaterial(prisma, material.id, {
      description: "should fail", category: "Test", idPrefix: "TPRM", rowType: "MATERIAL + LABOR",
    }, "test");
    expect(result.ok).toBe(false);
  });

  it("promote can never produce an assembly row — createAtomic refuses rowType ASSEMBLY", async () => {
    const material = await makeMaterial({ lastCost: 5 });
    const result = await promoteMaterial(prisma, material.id, {
      description: "should fail", category: "Test", idPrefix: "TPRM", rowType: "ASSEMBLY",
    }, "test");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/ASSEMBLY/);
    // The material must not have been linked to anything by the failed attempt.
    const reloaded = await prisma.material.findUnique({ where: { id: material.id } });
    expect(reloaded?.itemId).toBeNull();
  });
});

describe("guard carried from Unit 1 — an assembly is never a purchasable thing", () => {
  it("createMaterial refuses to create a material pre-linked to an assembly itemId", async () => {
    const component = await makeAtomic();
    const assembly = await createAssembly(prisma, {
      description: "Guard-test assembly", category: "Test", idPrefix: "TMASM",
      components: [{ childItemId: component.itemId, quantity: 1 }],
    }, "test");
    expect(assembly.ok).toBe(true);
    if (!assembly.ok) return;
    const assemblyId = (assembly.atomic as Record<string, unknown>).itemId as string;
    createdItemIds.push(assemblyId);

    const result = await createMaterial(prisma, { description: "should fail", itemId: assemblyId });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/assembly/i);
  });

  it("linkMaterial refuses to link an existing material to an assembly itemId", async () => {
    const component = await makeAtomic();
    const assembly = await createAssembly(prisma, {
      description: "Guard-test assembly 2", category: "Test", idPrefix: "TMASM",
      components: [{ childItemId: component.itemId, quantity: 1 }],
    }, "test");
    expect(assembly.ok).toBe(true);
    if (!assembly.ok) return;
    const assemblyId = (assembly.atomic as Record<string, unknown>).itemId as string;
    createdItemIds.push(assemblyId);

    const material = await makeMaterial({ lastCost: 5 });
    const result = await linkMaterial(prisma, material.id, assemblyId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/assembly/i);
  });

  it("updateMaterial refuses to patch itemId to an assembly", async () => {
    const component = await makeAtomic();
    const assembly = await createAssembly(prisma, {
      description: "Guard-test assembly 3", category: "Test", idPrefix: "TMASM",
      components: [{ childItemId: component.itemId, quantity: 1 }],
    }, "test");
    expect(assembly.ok).toBe(true);
    if (!assembly.ok) return;
    const assemblyId = (assembly.atomic as Record<string, unknown>).itemId as string;
    createdItemIds.push(assemblyId);

    const material = await makeMaterial({ lastCost: 5 });
    const result = await updateMaterial(prisma, material.id, { itemId: assemblyId });
    expect(result.ok).toBe(false);
  });
});
