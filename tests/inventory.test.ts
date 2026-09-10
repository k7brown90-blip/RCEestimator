/**
 * Inventory ledger and tool register (Kyle, 2026-09-09, Build 3).
 *
 * "We need an inventory tab that tracks what is on the truck and what is at
 * the warehouse." The ledger is append-only; StockLevel is written only by
 * applyMovement; cost is a moving average per item per location; a PO lands
 * on its truck or in the warehouse and closes; tools move between locations
 * with a trail. Nothing here charges a job — job costing is unchanged.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import crypto from "node:crypto";
import { prisma } from "../src/lib/prisma";

process.env.GOOGLE_CLIENT_ID = "test_id";
process.env.GOOGLE_CLIENT_SECRET = "test_secret";
process.env.GOOGLE_REFRESH_TOKEN = "test_token";
delete process.env.OPENAI_API_KEY;
delete process.env.STRIPE_SECRET_KEY;

vi.mock("../src/services/twilio", () => ({
  sendSms: vi.fn().mockResolvedValue({ sid: "SM_mock" }),
  KYLE_PHONE: "+19706661626",
  isFromKyle: vi.fn().mockReturnValue(false),
  fetchTwilioMedia: vi.fn().mockResolvedValue(null),
}));
vi.mock("googleapis", () => {
  class MockOAuth2 {
    setCredentials() {}
  }
  return {
    google: {
      auth: { OAuth2: MockOAuth2 },
      calendar: () => ({
        freebusy: { query: vi.fn().mockResolvedValue({ data: { calendars: { primary: { busy: [] } } } }) },
        events: { list: vi.fn().mockResolvedValue({ data: { items: [] } }) },
      }),
    },
  };
});

import { app } from "../src/app";
import { createPurchaseOrder, defaultTruckId, transitionPurchaseOrder } from "../src/services/purchaseOrders";
import { WAREHOUSE_KEY, applyMovement, countStock, landPurchaseOrder, transferStock, truckLocationKey } from "../src/services/inventory";

const newId = () => crypto.randomUUID().replaceAll("-", "");
const r4 = (n: number) => Math.round(n * 10000) / 10000;

const WIRE = "INVT-WIRE";
const BOX = "INVT-BOX";

let truckId: string;
let truck2Id: string;
let truckKey: string;
let technicianId: string;
let techToken: string;

async function wipeInventory() {
  await prisma.stockMovement.deleteMany();
  await prisma.stockLevel.deleteMany();
  await prisma.toolMovement.deleteMany();
  await prisma.tool.deleteMany();
  await prisma.stockRequest.deleteMany();
  await prisma.receipt.updateMany({ where: { purchaseOrderId: { not: null } }, data: { purchaseOrderId: null } });
  await prisma.receipt.deleteMany({ where: { vendor: { startsWith: "INV-test" } } });
  await prisma.purchaseOrder.deleteMany();
  await prisma.purchaseOrderCounter.deleteMany();
}

beforeAll(async () => {
  await wipeInventory();
  truckId = await defaultTruckId();
  truckKey = truckLocationKey(truckId);
  const t2 = await prisma.truck.create({ data: { name: "INV Truck 2" } });
  truck2Id = t2.id;
  const tech = await prisma.technician.create({ data: { name: "INV Test Tech", accessToken: `inv-test-${newId()}` } });
  technicianId = tech.id;
  techToken = tech.accessToken;
  await prisma.truck.update({ where: { id: truckId }, data: { technicianId } });
  await prisma.priceBookAtomic.deleteMany({ where: { itemId: { in: [WIRE, BOX] } } });
  await prisma.priceBookAtomic.create({ data: { itemId: WIRE, description: "INV 12-2 NM-B", unit: "ft", purchasePrice: 0.72 } });
  await prisma.priceBookAtomic.create({ data: { itemId: BOX, description: "INV 4-square box", unit: "ea", costBasisUsed: 1.1 } });
});

afterAll(async () => {
  await wipeInventory();
  await prisma.priceBookAtomic.deleteMany({ where: { itemId: { in: [WIRE, BOX] } } });
  await prisma.truck.update({ where: { id: truckId }, data: { technicianId: null } });
  await prisma.truck.delete({ where: { id: truck2Id } });
  await prisma.technician.delete({ where: { id: technicianId } });
});

const level = (locationKey: string, itemId: string) =>
  prisma.stockLevel.findUnique({ where: { locationKey_itemId: { locationKey, itemId } } });

describe("moving average", () => {
  it("250 ft @0.72 then 100 ft @0.90 into the same truck → 350 @0.7714", async () => {
    await applyMovement(prisma, { kind: "purchase_in", itemId: WIRE, name: "12-2 NM-B", unit: "ft", qty: 250, unitCost: 0.72, toLocationKey: truckKey, actor: "test" });
    await applyMovement(prisma, { kind: "purchase_in", itemId: WIRE, name: "12-2 NM-B", unit: "ft", qty: 100, unitCost: 0.9, toLocationKey: truckKey, actor: "test" });
    const l = await level(truckKey, WIRE);
    expect(l!.qtyOnHand).toBe(350);
    expect(r4(l!.avgUnitCost)).toBe(0.7714);
  });

  it("a transfer moves at the warehouse avg and merges into the truck avg", async () => {
    // Opening warehouse stock: a count valued at a supplied cost.
    await countStock({ locationKey: WAREHOUSE_KEY, lines: [{ itemId: WIRE, qty: 500, unitCost: 0.6 }], reason: "Opening count", actor: "test" });
    const mv = await transferStock({ itemId: WIRE, qty: 50, toLocationKey: truckKey, actor: "test", reason: "Restock" });
    expect(mv.kind).toBe("transfer");
    expect(mv.unitCost).toBe(0.6);
    expect(mv.fromLocationKey).toBe(WAREHOUSE_KEY);
    expect(mv.toLocationKey).toBe(truckKey);
    const wh = await level(WAREHOUSE_KEY, WIRE);
    expect(wh!.qtyOnHand).toBe(450);
    expect(wh!.avgUnitCost).toBe(0.6);
    const tr = await level(truckKey, WIRE);
    expect(tr!.qtyOnHand).toBe(400);
    // (350 × 0.771428… + 50 × 0.60) / 400 = 0.75
    expect(r4(tr!.avgUnitCost)).toBe(0.75);
  });

  it("a count on a new level with no cost takes the book's last purchase price", async () => {
    await countStock({ locationKey: WAREHOUSE_KEY, lines: [{ itemId: BOX, qty: 20 }], reason: "Opening count", actor: "test" });
    const l = await level(WAREHOUSE_KEY, BOX);
    expect(l!.qtyOnHand).toBe(20);
    expect(l!.avgUnitCost).toBe(1.1);
    expect(l!.name).toBe("INV 4-square box");
  });
});

describe("landing a PO", () => {
  it("a purchased truck_stock PO with two lines lands: two purchase_in movements, levels, PO closed, trail written", async () => {
    const po = await createPurchaseOrder({
      supplier: "Home Depot", openedBy: "owner", actor: "test", truckId,
      lines: [{ itemId: WIRE, name: "12-2 NM-B", qty: 250, unit: "ft" }, { name: "Staples, box", qty: 2, unit: "box" }],
    });
    // Open → 409 "purchase first".
    const early = await request(app).post(`/purchase-orders/${po.id}/land`).send({ lines: [] });
    expect(early.status).toBe(409);
    expect(early.body.error).toMatch(/purchase first/);

    await transitionPurchaseOrder(po.id, "purchased", { actor: "test" });
    const defaults = await request(app).get(`/purchase-orders/${po.id}/landing`);
    expect(defaults.status).toBe(200);
    expect(defaults.body.blocker).toBeNull();
    expect(defaults.body.destinationKey).toBe(truckKey);
    expect(defaults.body.lines).toHaveLength(2);
    expect(defaults.body.lines[0].qtyLandedDefault).toBe(250);
    expect(defaults.body.lines[0].unitCostDefault).toBe(0.72); // the book
    expect(defaults.body.lines[0].costSource).toBe("book");
    expect(defaults.body.lines[1].costSource).toBe("none");

    const before = await level(truckKey, WIRE);
    const land = await request(app).post(`/purchase-orders/${po.id}/land`).send({
      lines: defaults.body.lines.map((l: { lineId: string; qtyLandedDefault: number }, i: number) => ({ lineId: l.lineId, qtyLanded: l.qtyLandedDefault, unitCost: i === 0 ? 0.8 : 6.5 })),
    });
    expect(land.status).toBe(200);
    expect(land.body.status).toBe("closed");
    expect(land.body.landedAt).not.toBeNull();

    const moves = await prisma.stockMovement.findMany({ where: { purchaseOrderId: po.id } });
    expect(moves).toHaveLength(2);
    expect(moves.every((m) => m.kind === "purchase_in" && m.toLocationKey === truckKey)).toBe(true);
    const wire = await level(truckKey, WIRE);
    expect(wire!.qtyOnHand).toBe(before!.qtyOnHand + 250);
    const staples = await prisma.stockLevel.findFirst({ where: { locationKey: truckKey, itemId: "adhoc:staples-box" } });
    expect(staples!.qtyOnHand).toBe(2);
    expect(staples!.avgUnitCost).toBe(6.5);

    const after = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id }, include: { lines: true, events: { orderBy: { at: "asc" } } } });
    expect(after.status).toBe("closed");
    expect(after.landedAt).not.toBeNull();
    expect(after.verifiedAt).not.toBeNull();
    expect(after.closedAt).not.toBeNull();
    expect(after.lines.every((l) => l.landedAt !== null && l.qtyLanded === l.qty)).toBe(true);
    const kinds = after.events.map((e) => `${e.kind}${e.reason ? `:${e.reason}` : ""}`);
    expect(kinds).toEqual(["created", "status", "status:landed", "landed"]);

    // Landing twice → 409.
    const again = await request(app).post(`/purchase-orders/${po.id}/land`).send({ lines: [] });
    expect(again.status).toBe(409);
    expect(again.body.error).toMatch(/already landed/);
  });

  it("defaults prorate a receipt total across lines by qty × book price", async () => {
    const po = await createPurchaseOrder({
      supplier: "NES", openedBy: "owner", actor: "test", truckId,
      lines: [{ itemId: WIRE, name: "12-2 NM-B", qty: 100, unit: "ft" }, { itemId: BOX, name: "4-square", qty: 10, unit: "ea" }],
    });
    const receipt = await prisma.receipt.create({
      data: { id: newId(), category: "materials", vendor: "INV-test NES", amount: 90, status: "confirmed", source: "manual" },
    });
    const attach = await request(app).post(`/purchase-orders/${po.id}/receipts/${receipt.id}`).send({});
    expect(attach.status).toBe(200);
    const defaults = await request(app).get(`/purchase-orders/${po.id}/landing`);
    expect(defaults.status).toBe(200);
    expect(defaults.body.receiptTotal).toBe(90);
    // weights 100×0.72 = 72 and 10×1.10 = 11 → 83
    // Kyle, 2026-09-10: no parsed lines on this receipt, so the whole total prorates — and says so.
    expect(defaults.body.lines[0].costSource).toBe("receipt-prorated");
    expect(defaults.body.remainder).toBe(90);
    expect(defaults.body.lines[0].unitCostDefault).toBe(r4((90 * 72) / 83 / 100));
    expect(defaults.body.lines[1].unitCostDefault).toBe(r4((90 * 11) / 83 / 10));
  });

  it("a tool PO with qty 2 lands as two Tool rows on the destination", async () => {
    const po = await createPurchaseOrder({
      supplier: "Harbor Freight", purpose: "tool", openedBy: "owner", actor: "test", truckId,
      lines: [{ name: "Cordless drill", qty: 2, unit: "ea", partNumber: "DCD771" }],
    });
    await transitionPurchaseOrder(po.id, "purchased", { actor: "test" });
    const lineId = (await prisma.purchaseOrderLine.findFirstOrThrow({ where: { purchaseOrderId: po.id } })).id;
    const result = await landPurchaseOrder(po.id, [{ lineId, qtyLanded: 2, unitCost: 129 }], "test");
    expect(result.purchaseOrder.status).toBe("closed");
    const tools = await prisma.tool.findMany({ where: { purchaseOrderId: po.id } });
    expect(tools).toHaveLength(2);
    expect(tools.every((t) => t.locationKey === truckKey && t.cost === 129 && t.name === "Cordless drill")).toBe(true);
    expect(await prisma.stockMovement.count({ where: { purchaseOrderId: po.id } })).toBe(0);
  });

  it("an after-the-fact PO with no receipt photo cannot land", async () => {
    const po = await createPurchaseOrder({
      supplier: "Lowes", openedBy: "system", actor: "test", truckId, afterTheFact: true,
      lines: [{ name: "Wire nuts", qty: 1, unit: "box" }],
    });
    await transitionPurchaseOrder(po.id, "purchased", { actor: "test" });
    const defaults = await request(app).get(`/purchase-orders/${po.id}/landing`);
    expect(defaults.body.blocker).toMatch(/after the fact/);
    const lineId = (await prisma.purchaseOrderLine.findFirstOrThrow({ where: { purchaseOrderId: po.id } })).id;
    const land = await request(app).post(`/purchase-orders/${po.id}/land`).send({ lines: [{ lineId, qtyLanded: 1, unitCost: 4 }] });
    expect(land.status).toBe(409);
    expect(land.body.error).toMatch(/receipt photo/);
    expect((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } })).status).toBe("purchased");
  });

  it("a warehouse PO lands in the warehouse; the tech route lands too", async () => {
    const po = await createPurchaseOrder({
      supplier: "ASD", purpose: "warehouse", openedBy: "owner", actor: "test",
      lines: [{ itemId: BOX, name: "4-square", qty: 30, unit: "ea" }],
    });
    await transitionPurchaseOrder(po.id, "purchased", { actor: "test" });
    const defaults = await request(app).get(`/health-record/purchase-orders/${po.id}/landing`).set("Authorization", `Bearer ${techToken}`);
    expect(defaults.status).toBe(200);
    expect(defaults.body.data.destinationKey).toBe(WAREHOUSE_KEY);
    const before = (await level(WAREHOUSE_KEY, BOX))!.qtyOnHand;
    const land = await request(app)
      .post(`/health-record/purchase-orders/${po.id}/land`)
      .set("Authorization", `Bearer ${techToken}`)
      .send({ lines: [{ lineId: defaults.body.data.lines[0].lineId, qtyLanded: 30, unitCost: 1.2 }] });
    expect(land.status).toBe(200);
    expect(land.body.data.status).toBe("closed");
    expect((await level(WAREHOUSE_KEY, BOX))!.qtyOnHand).toBe(before + 30);
    const mv = await prisma.stockMovement.findFirstOrThrow({ where: { purchaseOrderId: po.id } });
    expect(mv.actor).toBe("tech:INV Test Tech");
  });
});

describe("transfers", () => {
  it("the service refuses a truck → truck transfer (from is always the warehouse)", async () => {
    await expect(transferStock({ itemId: WIRE, qty: 10, fromLocationKey: truckKey, toLocationKey: truckLocationKey(truck2Id), actor: "test" }))
      .rejects.toMatchObject({ statusCode: 409 });
    await expect(applyMovement(prisma, { kind: "transfer", itemId: WIRE, name: "x", qty: 10, fromLocationKey: truckKey, toLocationKey: truckLocationKey(truck2Id), actor: "test" }))
      .rejects.toMatchObject({ statusCode: 409 });
  });

  it("refuses when the warehouse is short (409) and moves when it is not", async () => {
    const wh = (await level(WAREHOUSE_KEY, WIRE))!.qtyOnHand;
    const short = await request(app).post("/inventory/transfer").send({ itemId: WIRE, qty: wh + 1, toTruckId: truck2Id, reason: "Too much" });
    expect(short.status).toBe(409);
    expect(short.body.error).toMatch(/negative/);
    const ok = await request(app).post("/inventory/transfer").send({ itemId: WIRE, qty: 25, toTruckId: truck2Id, reason: "Stocking truck 2" });
    expect(ok.status).toBe(201);
    expect(ok.body.kind).toBe("transfer");
    expect((await level(WAREHOUSE_KEY, WIRE))!.qtyOnHand).toBe(wh - 25);
    const t2 = await level(truckLocationKey(truck2Id), WIRE);
    expect(t2!.qtyOnHand).toBe(25);
    expect(t2!.avgUnitCost).toBe(0.6);
  });
});

describe("counts and corrections", () => {
  it("a count sets on-hand and records the delta; avg is untouched", async () => {
    const before = (await level(truckLocationKey(truck2Id), WIRE))!;
    const res = await request(app).post("/inventory/count").send({
      locationKey: truckLocationKey(truck2Id), reason: "Friday count", lines: [{ itemId: WIRE, qty: 22 }],
    });
    expect(res.status).toBe(201);
    expect(res.body[0].kind).toBe("count");
    expect(res.body[0].qty).toBe(22);
    expect(res.body[0].delta).toBe(22 - before.qtyOnHand);
    const after = (await level(truckLocationKey(truck2Id), WIRE))!;
    expect(after.qtyOnHand).toBe(22);
    expect(after.avgUnitCost).toBe(before.avgUnitCost);
    const noReason = await request(app).post("/inventory/count").send({ locationKey: truckLocationKey(truck2Id), lines: [{ itemId: WIRE, qty: 22 }] });
    expect(noReason.status).toBe(400);
  });

  it("a correction with a reason adjusts the level and references the original; without a reason → 400", async () => {
    const original = await prisma.stockMovement.findFirstOrThrow({ where: { kind: "transfer", toLocationKey: truckLocationKey(truck2Id) } });
    const noReason = await request(app).post("/inventory/correction").send({ correctsId: original.id, delta: -5 });
    expect(noReason.status).toBe(400);
    const whBefore = (await level(WAREHOUSE_KEY, WIRE))!.qtyOnHand;
    const trBefore = (await level(truckLocationKey(truck2Id), WIRE))!.qtyOnHand;
    // The transfer was keyed as 25 but 20 actually went: −5 on the truck, +5 back at the warehouse.
    const fixed = await request(app).post("/inventory/correction").send({ correctsId: original.id, delta: -5, reason: "Only 20 ft moved" });
    expect(fixed.status).toBe(201);
    expect(fixed.body.kind).toBe("correction");
    expect(fixed.body.correctsId).toBe(original.id);
    expect(fixed.body.delta).toBe(-5);
    expect(fixed.body.reason).toBe("Only 20 ft moved");
    expect((await level(WAREHOUSE_KEY, WIRE))!.qtyOnHand).toBe(whBefore + 5);
    expect((await level(truckLocationKey(truck2Id), WIRE))!.qtyOnHand).toBe(trBefore - 5);
    // The ledger is append-only: the original is untouched.
    const still = await prisma.stockMovement.findUniqueOrThrow({ where: { id: original.id } });
    expect(still.qty).toBe(25);
    const history = await request(app).get(`/inventory/movements?itemId=${WIRE}&locationKey=${encodeURIComponent(truckLocationKey(truck2Id))}`);
    expect(history.status).toBe(200);
    expect(history.body.map((m: { kind: string }) => m.kind)).toEqual(["correction", "count", "transfer"]);
  });
});

describe("restock requests", () => {
  it("a tech asks; fulfilling performs the warehouse → truck transfer; declining needs a reason", async () => {
    const asked = await request(app)
      .post("/health-record/stock-requests")
      .set("Authorization", `Bearer ${techToken}`)
      .send({ itemId: BOX, name: "4-square box", qty: 5, unit: "ea", note: "Down to two" });
    expect(asked.status).toBe(201);
    expect(asked.body.data.truckId).toBe(truckId);
    expect(asked.body.data.status).toBe("open");
    const id = asked.body.data.id as string;

    const mine = await request(app).get("/health-record/my-truck").set("Authorization", `Bearer ${techToken}`);
    expect(mine.status).toBe(200);
    expect(mine.body.data.truck.id).toBe(truckId);
    expect(mine.body.data.openRequests.map((r: { id: string }) => r.id)).toContain(id);
    expect(mine.body.data.levels.some((l: { itemId: string }) => l.itemId === WIRE)).toBe(true);

    const overview = await request(app).get("/inventory");
    expect(overview.body.openRequests.map((r: { id: string }) => r.id)).toContain(id);

    const whBefore = (await level(WAREHOUSE_KEY, BOX))!.qtyOnHand;
    const fulfilled = await request(app).post(`/inventory/requests/${id}/fulfill`).send({});
    expect(fulfilled.status).toBe(200);
    expect(fulfilled.body.request.status).toBe("fulfilled");
    expect(fulfilled.body.movement.kind).toBe("transfer");
    expect((await level(WAREHOUSE_KEY, BOX))!.qtyOnHand).toBe(whBefore - 5);
    expect((await level(truckKey, BOX))!.qtyOnHand).toBe(5);

    // A second ask, bigger than the warehouse holds → 409; then declined with a reason.
    const big = await request(app)
      .post("/health-record/stock-requests")
      .set("Authorization", `Bearer ${techToken}`)
      .send({ itemId: BOX, name: "4-square box", qty: 10000 });
    const shortId = big.body.data.id as string;
    const short = await request(app).post(`/inventory/requests/${shortId}/fulfill`).send({});
    expect(short.status).toBe(409);
    expect((await prisma.stockRequest.findUniqueOrThrow({ where: { id: shortId } })).status).toBe("open");
    const noReason = await request(app).post(`/inventory/requests/${shortId}/decline`).send({});
    expect(noReason.status).toBe(400);
    const declined = await request(app).post(`/inventory/requests/${shortId}/decline`).send({ reason: "Order it on a PO" });
    expect(declined.status).toBe(200);
    expect(declined.body.status).toBe("declined");
  });
});

describe("tools", () => {
  it("a move writes a ToolMovement and updates locationKey; the tech route moves it to their truck", async () => {
    const created = await request(app).post("/tools").send({ name: "Hilti hammer drill", serial: "HD-1", cost: 450, locationKey: WAREHOUSE_KEY });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    expect(created.body.locationKey).toBe(WAREHOUSE_KEY);

    const moved = await request(app).post(`/tools/${id}/move`).send({ toLocationKey: truckLocationKey(truck2Id), reason: "Panel job" });
    expect(moved.status).toBe(200);
    expect(moved.body.tool.locationKey).toBe(truckLocationKey(truck2Id));
    expect(moved.body.movement.fromLocationKey).toBe(WAREHOUSE_KEY);

    const sameSpot = await request(app).post(`/tools/${id}/move`).send({ toLocationKey: truckLocationKey(truck2Id) });
    expect(sameSpot.status).toBe(409);

    const techMove = await request(app).post(`/health-record/tools/${id}/move`).set("Authorization", `Bearer ${techToken}`).send({ toLocationKey: truckKey });
    expect(techMove.status).toBe(200);
    expect(techMove.body.data.tool.locationKey).toBe(truckKey);
    expect(techMove.body.data.movement.actor).toBe("tech:INV Test Tech");

    const detail = await request(app).get(`/tools/${id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.movements).toHaveLength(2);

    const mine = await request(app).get("/health-record/my-truck").set("Authorization", `Bearer ${techToken}`);
    expect(mine.body.data.tools.map((t: { id: string }) => t.id)).toContain(id);

    const noReason = await request(app).patch(`/tools/${id}`).send({ condition: "needs_repair" });
    expect(noReason.status).toBe(400);
    const edited = await request(app).patch(`/tools/${id}`).send({ condition: "needs_repair", reason: "Chuck slipping" });
    expect(edited.status).toBe(200);
    expect(edited.body.condition).toBe("needs_repair");
  });
});

describe("the rollup", () => {
  it("/inventory shows warehouse + truck values and low-stock flags; /trucks carries stockValue and toolCount", async () => {
    const wireLevel = (await level(truckKey, WIRE))!;
    const par = await request(app).patch(`/inventory/levels/${wireLevel.id}`).send({ parLevel: wireLevel.qtyOnHand + 100 });
    expect(par.status).toBe(200);
    expect(par.body.low).toBe(true);

    const res = await request(app).get("/inventory");
    expect(res.status).toBe(200);
    const whLevels = await prisma.stockLevel.findMany({ where: { locationKey: WAREHOUSE_KEY } });
    const whValue = Math.round(whLevels.reduce((s, l) => s + l.qtyOnHand * l.avgUnitCost, 0) * 100) / 100;
    expect(res.body.warehouse.value).toBe(whValue);
    expect(res.body.warehouse.levels.length).toBe(whLevels.length);
    const t1 = res.body.trucks.find((t: { truck: { id: string } }) => t.truck.id === truckId);
    expect(t1.value).toBeGreaterThan(0);
    expect(t1.lowStock.map((l: { itemId: string }) => l.itemId)).toEqual([WIRE]);
    expect(res.body.unlandedPos.every((p: { status: string }) => p.status === "purchased" || p.status === "verified")).toBe(true);
    // Still waiting to land: the after-the-fact PO and the receipt-prorated one (purchased by its receipt, never landed). Closed ones are not listed.
    expect(res.body.unlandedPos.length).toBe(2);

    const trucks = await request(app).get("/trucks");
    expect(trucks.status).toBe(200);
    const row = trucks.body.trucks.find((t: { id: string }) => t.id === truckId);
    expect(row.stockValue).toBe(t1.value);
    expect(row.toolCount).toBe(3); // the two drills that landed + the hammer drill the tech moved over

    const items = await request(app).get("/inventory/items?q=INVT-");
    expect(items.status).toBe(200);
    expect(items.body.map((i: { itemId: string }) => i.itemId).sort()).toEqual([BOX, WIRE]);
    expect(items.body.find((i: { itemId: string }) => i.itemId === WIRE).lastCost).toBe(0.72);
  });
});
