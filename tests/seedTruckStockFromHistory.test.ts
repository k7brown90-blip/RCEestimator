/**
 * Opening truck stock from history (Kyle, 2026-09-10).
 *
 * "Fill the truck stock off of what has been spent and recorded in the
 * receipts so I can fill in the gaps." Receipt lines match the price book by
 * name or fall to adhoc; unit mismatches are flagged, never subtracted; used >
 * bought floors at 0; --apply writes one count per key through the inventory
 * service and skips a level that already holds stock.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { prisma } from "../src/lib/prisma";
import { truckLocationKey } from "../src/services/inventory";
import {
  applyProposal, buildProposal, chooseTruck, loadBook, loadPurchases, loadUsage, matchBookItem, scoreMatch,
  SEED_REASON, type BookItem, type Purchase, type Usage,
} from "../src/services/stockSeed";

const newId = () => crypto.randomUUID().replaceAll("-", "");

const WIRE12 = "STK-WIRE12";
const WIRE14 = "STK-WIRE14";
const BOX = "STK-BOX";
const GFCI = "STK-GFCI";
const ITEM_IDS = [WIRE12, WIRE14, BOX, GFCI];

const bookRows: BookItem[] = [
  { itemId: WIRE12, description: "12/2 NM-B w/ground copper, 250 ft roll", unit: "ft", purchaseUnit: "roll", purchasePackQty: 250, purchasePrice: 89, costBasisUsed: null },
  { itemId: WIRE14, description: "14/2 NM-B w/ground copper, 250 ft roll", unit: "ft", purchaseUnit: "roll", purchasePackQty: 250, purchasePrice: 62, costBasisUsed: null },
  { itemId: BOX, description: "4x4 square box 1-1/2 deep steel", unit: "ea", purchaseUnit: "ea", purchasePackQty: null, purchasePrice: 1.1, costBasisUsed: null },
  { itemId: GFCI, description: "20A GFCI receptacle white", unit: "ea", purchaseUnit: "ea", purchasePackQty: null, purchasePrice: 14.5, costBasisUsed: null },
];
const byId = new Map(bookRows.map((b) => [b.itemId, b]));

let truckId: string;
let truckKey: string;
let customerId: string;
let receiptId: string;

async function cleanFixtures() {
  await prisma.stockMovement.deleteMany({ where: { itemId: { in: [...ITEM_IDS, "adhoc:gatorade-32oz"] } } });
  await prisma.stockLevel.deleteMany({ where: { itemId: { in: [...ITEM_IDS, "adhoc:gatorade-32oz"] } } });
  await prisma.receipt.deleteMany({ where: { vendor: { startsWith: "STK-test" } } });
  await prisma.issuedEstimate.deleteMany({ where: { number: { startsWith: "0000-STK" } } });
  await prisma.priceBookDraftEstimate.deleteMany({ where: { title: "stock-seed draft" } });
  if (customerId) {
    await prisma.visit.deleteMany({ where: { customerId } });
    await prisma.property.deleteMany({ where: { customerId } });
    await prisma.customer.delete({ where: { id: customerId } }).catch(() => {});
  }
  await prisma.priceBookAtomic.deleteMany({ where: { itemId: { in: ITEM_IDS } } });
  await prisma.truck.deleteMany({ where: { name: "STK Seed Truck" } });
}

beforeAll(async () => {
  await cleanFixtures();
  const truck = await prisma.truck.create({ data: { name: "STK Seed Truck" } });
  truckId = truck.id;
  truckKey = truckLocationKey(truckId);
  for (const b of bookRows) {
    await prisma.priceBookAtomic.create({ data: { itemId: b.itemId, description: b.description, unit: b.unit, purchaseUnit: b.purchaseUnit, purchasePackQty: b.purchasePackQty, purchasePrice: b.purchasePrice } });
  }
  const customer = await prisma.customer.create({ data: { name: "Stock Seed Co", phone: "+16155508888" } });
  customerId = customer.id;
  const property = await prisma.property.create({ data: { customerId, name: "Seed House", addressLine1: "9 Seed Rd", city: "Franklin", state: "TN", postalCode: "37064" } });
  const job = await prisma.visit.create({
    data: { customerId, propertyId: property.id, mode: "onsite", purpose: "STK Job", jobType: "STK Job", status: "completed", visitDate: new Date(), completedAt: new Date() },
  });
  const openJob = await prisma.visit.create({
    data: { customerId, propertyId: property.id, mode: "onsite", purpose: "STK Open", jobType: "STK Open", status: "in_progress", visitDate: new Date() },
  });
  // One receipt with two lines: a roll of 12/2 (unit "roll" — the estimate uses ft) and ten boxes.
  const receipt = await prisma.receipt.create({
    data: {
      id: newId(), category: "materials", vendor: "STK-test Home Depot", amount: 104, status: "confirmed", source: "manual",
      lineItems: JSON.stringify([
        { name: "12/2 NM-B 250ft", qty: 1, unit: "roll", unitCost: 89 },
        { name: "4x4 square box", qty: 10, unit: "ea", unitCost: 1.5 },
      ]),
    },
  });
  receiptId = receipt.id;
  const draft = await prisma.priceBookDraftEstimate.create({ data: { title: "stock-seed draft", supplierId: "STK-SUP" } });
  const est = (number: string, jobVisitId: string, lines: Array<{ itemId: string; description: string; quantity: number; option?: "A" | "B"; materialCost: number }>) =>
    prisma.issuedEstimate.create({
      data: {
        number, token: `stk-token-${newId()}`, status: "signed", draftId: draft.id, customerId, serviceAddressId: property.id, jobVisitId,
        customerName: "Stock Seed Co", serviceAddress: "9 Seed Rd, Franklin", title: number, workSubtotal: 500, total: 500,
        selectedOptions: ["A"], signedAt: new Date(), signedChannel: "email",
        lines: {
          create: lines.map((l, i) => ({
            itemId: l.itemId, description: l.description, quantity: l.quantity, unitPrice: 2, lineTotal: 2 * l.quantity,
            sortOrder: i, option: l.option ?? "A", materialCost: l.materialCost, materialSell: l.materialCost * 1.3,
          })),
        },
      },
    });
  // Signed, on a completed job: 60 ft of 12/2 (option A), 4 boxes (A), and an option-B line that is NOT taken.
  await est("0000-STK-A", job.id, [
    { itemId: WIRE12, description: "12/2 NM-B", quantity: 60, materialCost: 21.6 },
    { itemId: BOX, description: "4-square box", quantity: 4, materialCost: 4.4 },
    { itemId: BOX, description: "4-square box (option B)", quantity: 50, option: "B", materialCost: 55 },
  ]);
  // Signed but the job is still in progress — must not count as used.
  await est("0000-STK-B", openJob.id, [{ itemId: BOX, description: "4-square box", quantity: 100, materialCost: 110 }]);
});

afterAll(async () => {
  await cleanFixtures();
});

describe("name matching", () => {
  it("'12/2 NM-B 250ft' picks the 12/2 item, never the 14/2 one, and a poor match falls to adhoc", () => {
    const hit = matchBookItem("12/2 NM-B 250ft", bookRows);
    expect(hit?.item.itemId).toBe(WIRE12);
    expect(hit!.score).toBeGreaterThanOrEqual(0.5);
    expect(scoreMatch("12/2 NM-B 250ft", bookRows[1].description!)).toBe(0); // 14/2 is a spec conflict
    expect(matchBookItem("12-2 romex 250'", bookRows)?.item.itemId).toBe(WIRE12); // dash form of the size
    expect(matchBookItem("Gatorade 32oz", bookRows)).toBeNull();
    expect(matchBookItem("20A GFCI", bookRows)?.item.itemId).toBe(GFCI);
    expect(matchBookItem("15A GFCI receptacle white", bookRows)).toBeNull(); // amperage conflict
  });
});

describe("proposal arithmetic", () => {
  const purchase = (key: string, qty: number, unit: string | null, unitCost: number | null, receiptId = "r1"): Purchase =>
    ({ key, name: key, qty, unit, unitCost, costSource: unitCost != null ? "receipt" : "none", receiptId, match: { kind: "itemId", score: 1 } });
  const usage = (key: string, qty: number, unit: string | null): Usage => ({ key, name: key, qty, unit, estimateNumber: "0000-X" });

  it("unit mismatch is flagged and not subtracted", () => {
    const [row] = buildProposal([purchase(WIRE12, 1, "roll", 89)], [usage(WIRE12, 60, "ft")], byId);
    expect(row.proposedQty).toBe(1);
    expect(row.boughtUnit).toBe("roll");
    expect(row.usedUnit).toBe("ft");
    expect(row.flags.some((f) => f.startsWith("unit mismatch"))).toBe(true);
    expect(row.flags.join(" ")).toContain("1 roll = 250 ft");
    expect(row.unitCost).toBe(89);
    expect(row.value).toBe(89);
  });

  it("used more than bought floors at 0 with the flag; matching units subtract; cost is the weighted average", () => {
    const rows = buildProposal(
      [purchase(BOX, 10, "ea", 1.5, "r1"), purchase(BOX, 10, "each", 2.5, "r2"), purchase(GFCI, 2, "ea", 14)],
      [usage(BOX, 25, "ea"), usage(GFCI, 1, "ea")],
      byId,
    );
    const box = rows.find((r) => r.key === BOX)!;
    expect(box.boughtQty).toBe(20);
    expect(box.usedQty).toBe(25);
    expect(box.proposedQty).toBe(0);
    expect(box.flags).toContain("used more than bought — earlier purchases not recorded");
    expect(box.unitCost).toBe(2);
    expect(box.receiptIds).toEqual(["r1", "r2"]);
    const gfci = rows.find((r) => r.key === GFCI)!;
    expect(gfci.proposedQty).toBe(1);
    expect(gfci.value).toBe(14);
    expect(gfci.flags).toEqual([]);
  });

  it("no purchase cost falls back to the book price; an adhoc key with no cost is flagged", () => {
    const rows = buildProposal([purchase(GFCI, 3, "ea", null), purchase("adhoc:mystery", 2, null, null)], [], byId);
    expect(rows.find((r) => r.key === GFCI)!.unitCost).toBe(14.5);
    expect(rows.find((r) => r.key === GFCI)!.costSource).toBe("book");
    const adhoc = rows.find((r) => r.key === "adhoc:mystery")!;
    expect(adhoc.unitCost).toBe(0);
    expect(adhoc.costSource).toBe("none");
    expect(adhoc.flags).toContain("no cost");
    expect(adhoc.flags).toContain("not in price book (adhoc)");
    expect(adhoc.isBook).toBe(false);
  });
});

describe("against the database", () => {
  it("loads the receipt lines and the completed job's taken lines, and picks the named truck", async () => {
    const { book, byId: liveById } = await loadBook();
    const { purchases } = await loadPurchases(book, liveById);
    const mine = purchases.filter((p) => p.receiptId === receiptId);
    expect(mine).toHaveLength(2);
    expect(mine.find((p) => p.key === WIRE12)?.match.kind).toBe("name");
    expect(mine.find((p) => p.key === BOX)?.unitCost).toBe(1.5);

    const { usages } = await loadUsage(liveById);
    const mineUsed = usages.filter((u) => u.estimateNumber.startsWith("0000-STK"));
    expect(mineUsed.map((u) => [u.key, u.qty, u.unit])).toEqual([[WIRE12, 60, "ft"], [BOX, 4, "ea"]]);

    expect((await chooseTruck("STK Seed Truck"))?.id).toBe(truckId);
    expect((await chooseTruck(truckId))?.how).toBe("--truck");
    expect(await chooseTruck("no such truck")).toBeNull();
  });

  it("apply writes one count per key once; a second run skips levels that already hold stock", async () => {
    const { book, byId: liveById } = await loadBook();
    const { purchases } = await loadPurchases(book, liveById);
    const { usages } = await loadUsage(liveById);
    const rows = buildProposal(
      purchases.filter((p) => p.receiptId === receiptId),
      usages.filter((u) => u.estimateNumber.startsWith("0000-STK")),
      liveById,
    );
    const wire = rows.find((r) => r.key === WIRE12)!;
    const box = rows.find((r) => r.key === BOX)!;
    expect(wire.proposedQty).toBe(1); // roll vs ft — not subtracted
    expect(box.proposedQty).toBe(6); // 10 bought − 4 used (the option-B 50 and the open job's 100 are not used)

    const first = await applyProposal(truckId, rows);
    expect(first.written.map((w) => [w.key, w.qty, w.unitCost])).toEqual([[BOX, 6, 1.5], [WIRE12, 1, 89]]);
    expect(first.skipped).toEqual([]);
    const boxLevel = await prisma.stockLevel.findUnique({ where: { locationKey_itemId: { locationKey: truckKey, itemId: BOX } } });
    expect(boxLevel!.qtyOnHand).toBe(6);
    expect(boxLevel!.avgUnitCost).toBe(1.5);
    expect(boxLevel!.unit).toBe("ea");
    const wireLevel = await prisma.stockLevel.findUnique({ where: { locationKey_itemId: { locationKey: truckKey, itemId: WIRE12 } } });
    expect(wireLevel!.qtyOnHand).toBe(1);
    expect(wireLevel!.avgUnitCost).toBe(89);
    const movements = await prisma.stockMovement.findMany({ where: { toLocationKey: truckKey, kind: "count" } });
    expect(movements).toHaveLength(2);
    // Kyle, 2026-09-10: the reason says where the cost came from — both fixture lines carried a receipt price.
    expect(movements.every((m) => m.actor === "system" && m.reason === `${SEED_REASON} — cost from receipt line`)).toBe(true);

    const second = await applyProposal(truckId, rows);
    expect(second.written).toEqual([]);
    expect(second.skipped.map((s) => [s.key, s.qtyOnHand])).toEqual([[BOX, 6], [WIRE12, 1]]);
    expect(await prisma.stockMovement.count({ where: { toLocationKey: truckKey, kind: "count" } })).toBe(2);
    expect((await prisma.stockLevel.findUnique({ where: { locationKey_itemId: { locationKey: truckKey, itemId: BOX } } }))!.qtyOnHand).toBe(6);
  });
});
