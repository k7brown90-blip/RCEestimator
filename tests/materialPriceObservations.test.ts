/**
 * Observed prices, 90-day working set (2026-09-12, barcode/materials plan Unit 4).
 *
 * Pins down the things most likely to go quietly wrong:
 *   1. Pack-size normalisation — a package price becomes a per-unit unitCost (reusing
 *      services/materials.ts perUnitCostFromPack, never reimplementing the arithmetic).
 *   2. Barcode/sku observations outrank name_fuzzy for the same item, per Unit 5's ranking
 *      requirement — they are never averaged together with a name guess.
 *   3. Retention: a hard 90-day delete, nothing older survives, nothing newer is touched.
 *   4. A SKU match is REFUSED when the receipt's vendor does not match the material's own
 *      supplier — a mis-OCR'd SKU must not silently attach a price to the wrong product.
 *   5. A receipt parsed without a `sku` (the pre-Unit-4 shape) still produces an observation
 *      through the existing name-matching path.
 */

import { afterAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { prisma } from "../src/lib/prisma";
import { createMaterial } from "../src/services/materials";
import {
  deleteExpiredObservations,
  matchReceiptLineToMaterial,
  observedUnitCost,
  recordObservationsForReceipt,
  summarizeObservationsByMaterial,
} from "../src/services/materialPriceObservations";

const newId = () => crypto.randomUUID().slice(0, 8).toUpperCase();

const createdMaterialIds: string[] = [];
const createdReceiptIds: string[] = [];

async function makeMaterial(overrides: Partial<Record<string, unknown>> = {}) {
  const result = await createMaterial(prisma, { description: "test material", ...overrides } as never);
  if (!result.ok) throw new Error(result.reason);
  createdMaterialIds.push(result.material.id);
  return result.material;
}

afterAll(async () => {
  await prisma.materialPriceObservation.deleteMany({ where: { materialId: { in: createdMaterialIds } } });
  await prisma.receipt.deleteMany({ where: { id: { in: createdReceiptIds } } });
  await prisma.material.deleteMany({ where: { id: { in: createdMaterialIds } } });
});

describe("pack-size normalisation", () => {
  it("a package price becomes a per-unit unitCost via perUnitCostFromPack", () => {
    // Kyle's own example: an 11.97 10-pack becomes 1.20 per unit.
    expect(observedUnitCost(11.97, 10)).toBeCloseTo(1.2, 2);
  });

  it("a material with no known pack size is treated as already priced per unit", () => {
    expect(observedUnitCost(4.5, null)).toBe(4.5);
    expect(observedUnitCost(4.5, undefined)).toBe(4.5);
    expect(observedUnitCost(4.5, 0)).toBe(4.5); // non-positive packQty is not a real pack size
  });
});

describe("barcode/sku observations outrank name_fuzzy for the same item", () => {
  it("averages only the highest-ranked matchMethod present, ignoring the rest", () => {
    const summaries = summarizeObservationsByMaterial([
      { materialId: "M1", itemId: "ITEM-1", supplier: "Home Depot", unitCost: 1.2, matchMethod: "name_fuzzy" },
      { materialId: "M1", itemId: "ITEM-1", supplier: "Home Depot", unitCost: 1.5, matchMethod: "name_fuzzy" },
      { materialId: "M1", itemId: "ITEM-1", supplier: "Home Depot", unitCost: 2.0, matchMethod: "sku" },
    ]);
    expect(summaries).toHaveLength(1);
    // Only the sku row counts — a $1,197-for-$11.97 style name-fuzzy misfire must not drag it.
    expect(summaries[0].avgUnitCost).toBe(2.0);
    expect(summaries[0].matchMethod).toBe("sku");
    expect(summaries[0].count).toBe(1);
  });

  it("barcode and sku rank equally — either can be the winning group", () => {
    const summaries = summarizeObservationsByMaterial([
      { materialId: "M2", itemId: "ITEM-2", supplier: "Home Depot", unitCost: 3.0, matchMethod: "barcode" },
      { materialId: "M2", itemId: "ITEM-2", supplier: "Home Depot", unitCost: 0.5, matchMethod: "name_fuzzy" },
    ]);
    expect(summaries[0].avgUnitCost).toBe(3.0);
    expect(summaries[0].matchMethod).toBe("barcode");
  });

  it("manual entries rank above everything, including sku", () => {
    const summaries = summarizeObservationsByMaterial([
      { materialId: "M3", itemId: "ITEM-3", supplier: "Home Depot", unitCost: 9.0, matchMethod: "manual" },
      { materialId: "M3", itemId: "ITEM-3", supplier: "Home Depot", unitCost: 2.0, matchMethod: "sku" },
    ]);
    expect(summaries[0].avgUnitCost).toBe(9.0);
    expect(summaries[0].matchMethod).toBe("manual");
  });
});

describe("SKU matching — evidence, not gospel", () => {
  it("accepts a sku match when the vendor matches the material's supplier and the description is consistent", async () => {
    const sku = `SKU-${newId()}`;
    const material = await makeMaterial({ sku, supplier: "Home Depot", description: "Leviton 5320-W Duplex Receptacle 10-pack" });
    const match = await matchReceiptLineToMaterial(prisma, { name: "Leviton 5320-W Duplex Receptacle", sku }, "Home Depot");
    expect(match?.matchMethod).toBe("sku");
    expect(match?.material.id).toBe(material.id);
  });

  it("REFUSES a sku match when the receipt's vendor does not match the material's supplier", async () => {
    const sku = `SKU-${newId()}`;
    await makeMaterial({ sku, supplier: "Home Depot", description: `Only Home Depot Carries This Exact Widget ${newId()}` });
    // Same sku digits, but the receipt says a different vendor. Description also shares nothing
    // with any material's description, so the name-fuzzy fallback must not paper over the refusal.
    const match = await matchReceiptLineToMaterial(prisma, { name: `Unrelated purchase ${newId()}`, sku }, "SiteOne");
    expect(match).toBeNull();
  });

  it("falls back to name matching when the sku is present but unknown", async () => {
    const description = `12-2 NM-B Romex 250ft ${newId()}`;
    const material = await makeMaterial({ description });
    const match = await matchReceiptLineToMaterial(prisma, { name: description, sku: "NO-SUCH-SKU" }, "Home Depot");
    expect(match?.matchMethod).toBe("name_fuzzy");
    expect(match?.material.id).toBe(material.id);
  });
});

describe("recordObservationsForReceipt", () => {
  async function makeReceipt(lineItems: unknown[], vendor = "Home Depot") {
    const receipt = await prisma.receipt.create({
      data: {
        id: `test-receipt-${newId()}`,
        category: "materials",
        vendor,
        amount: 1,
        status: "confirmed",
        source: "manual",
        lineItems: JSON.stringify(lineItems),
        receivedAt: new Date(),
      },
    });
    createdReceiptIds.push(receipt.id);
    return receipt;
  }

  it("a package price becomes a per-unit unitCost on the stored observation", async () => {
    const sku = `SKU-${newId()}`;
    const description = `Leviton 5320-W Duplex Receptacle 10-pack ${newId()}`;
    const material = await makeMaterial({ sku, supplier: "Home Depot", description, packQty: 10 });
    const receipt = await makeReceipt([{ name: description, qty: 1, unit: "pk", unitCost: 11.97, sku }]);

    const result = await recordObservationsForReceipt(prisma, receipt);
    expect(result.created).toBe(1);

    const obs = await prisma.materialPriceObservation.findMany({ where: { receiptId: receipt.id } });
    expect(obs).toHaveLength(1);
    expect(obs[0].materialId).toBe(material.id);
    expect(obs[0].matchMethod).toBe("sku");
    expect(obs[0].source).toBe("receipt_line");
    expect(obs[0].unitCost).toBeCloseTo(1.2, 2); // 11.97 / 10, not the raw package price
  });

  it("a receipt parsed without a sku (the pre-Unit-4 shape) still produces an observation via the existing name path", async () => {
    const description = `12-2 NM-B Romex 250ft ${newId()}`;
    const material = await makeMaterial({ description });
    // No `sku` key at all on the line — exactly what every receipt parsed before this change looks like.
    const receipt = await makeReceipt([{ name: description, qty: 1, unit: "roll", unitCost: 89.0 }]);

    const result = await recordObservationsForReceipt(prisma, receipt);
    expect(result.created).toBe(1);

    const obs = await prisma.materialPriceObservation.findMany({ where: { receiptId: receipt.id } });
    expect(obs).toHaveLength(1);
    expect(obs[0].materialId).toBe(material.id);
    expect(obs[0].matchMethod).toBe("name_fuzzy");
    expect(obs[0].unitCost).toBe(89.0); // no pack size on this material — used as-is
  });

  it("is idempotent — re-ingesting the same receipt replaces rather than duplicates its rows", async () => {
    const description = `12-2 NM-B Romex 250ft reingest ${newId()}`;
    await makeMaterial({ description });
    const receipt = await makeReceipt([{ name: description, qty: 1, unit: "roll", unitCost: 89.0 }]);

    await recordObservationsForReceipt(prisma, receipt);
    await recordObservationsForReceipt(prisma, receipt);
    const obs = await prisma.materialPriceObservation.findMany({ where: { receiptId: receipt.id } });
    expect(obs).toHaveLength(1);
  });

  it("skips a line with no readable unit cost and a line that matches no material", async () => {
    const receipt = await makeReceipt([
      { name: "unpriced thing", qty: 1, unit: "ea", unitCost: null },
      { name: `nothing matches this ${newId()}`, qty: 1, unit: "ea", unitCost: 5 },
    ]);
    const result = await recordObservationsForReceipt(prisma, receipt);
    expect(result.created).toBe(0);
  });
});

describe("retention — a hard 90-day delete, no rollup", () => {
  it("deletes rows older than 90 days and keeps newer ones", async () => {
    const material = await makeMaterial({ description: `retention test ${newId()}` });
    const now = new Date("2026-09-12T12:00:00Z");
    const old = await prisma.materialPriceObservation.create({
      data: {
        materialId: material.id, itemId: null, supplier: "Home Depot",
        observedAt: new Date(now.getTime() - 100 * 86_400_000), // 100 days old — expired
        qty: 1, unitCost: 1, source: "manual", matchMethod: "manual",
      },
    });
    const recent = await prisma.materialPriceObservation.create({
      data: {
        materialId: material.id, itemId: null, supplier: "Home Depot",
        observedAt: new Date(now.getTime() - 10 * 86_400_000), // 10 days old — kept
        qty: 1, unitCost: 1, source: "manual", matchMethod: "manual",
      },
    });

    const result = await deleteExpiredObservations(prisma, { now });
    expect(result.deleted).toBeGreaterThanOrEqual(1);

    const remainingOld = await prisma.materialPriceObservation.findUnique({ where: { id: old.id } });
    const remainingRecent = await prisma.materialPriceObservation.findUnique({ where: { id: recent.id } });
    expect(remainingOld).toBeNull();
    expect(remainingRecent).not.toBeNull();
  });
});
