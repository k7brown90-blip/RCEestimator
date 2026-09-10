/**
 * PO landing prices come from the receipt, line by line (Kyle, 2026-09-10:
 * "The pricing on the P.O.'s does not seem to be applied correctly from the
 * receipts, same with the breakers above, they are not the same price.").
 *
 * A landed line's unit cost, in order: its own receipt line's price; the cost
 * typed on the PO line; the receipt total's remainder prorated over what is
 * left; the book's purchase price; 0 — and every default names its source.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import crypto from "node:crypto";
import { prisma } from "../src/lib/prisma";

process.env.GOOGLE_CLIENT_ID = "test_id";
process.env.GOOGLE_CLIENT_SECRET = "test_secret";
process.env.GOOGLE_REFRESH_TOKEN = "test_token";
delete process.env.OPENAI_API_KEY;

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
import { createPurchaseOrder, defaultTruckId } from "../src/services/purchaseOrders";
import { truckLocationKey } from "../src/services/inventory";

const newId = () => crypto.randomUUID().replaceAll("-", "");
const r4 = (n: number) => Math.round(n * 10000) / 10000;

const GFCI = "LNDP-GFCI";
const AFCI = "LNDP-AFCI";
const WIRE = "LNDP-WIRE";
const VENDOR = "LNDP-test Home Depot";

let truckId: string;
let truckKey: string;
let technicianId: string;
let techToken: string;

async function wipe() {
  await prisma.stockMovement.deleteMany();
  await prisma.stockLevel.deleteMany();
  await prisma.receipt.updateMany({ where: { purchaseOrderId: { not: null } }, data: { purchaseOrderId: null } });
  await prisma.receipt.deleteMany({ where: { vendor: VENDOR } });
  await prisma.purchaseOrder.deleteMany();
  await prisma.purchaseOrderCounter.deleteMany();
}

const receiptWith = (amount: number, lineItems: unknown[] | null) =>
  prisma.receipt.create({
    data: { id: newId(), category: "materials", vendor: VENDOR, amount, status: "confirmed", source: "manual", lineItems: lineItems ? JSON.stringify(lineItems) : null },
  });

const attach = async (poId: string, receiptId: string) => {
  const res = await request(app).post(`/purchase-orders/${poId}/receipts/${receiptId}`).send({});
  expect(res.status).toBe(200);
};

const defaultsOf = async (poId: string) => {
  const res = await request(app).get(`/purchase-orders/${poId}/landing`);
  expect(res.status).toBe(200);
  return res.body;
};

beforeAll(async () => {
  await wipe();
  truckId = await defaultTruckId();
  truckKey = truckLocationKey(truckId);
  const tech = await prisma.technician.create({ data: { name: "LNDP Test Tech", accessToken: `lndp-test-${newId()}` } });
  technicianId = tech.id;
  techToken = tech.accessToken;
  await prisma.priceBookAtomic.deleteMany({ where: { itemId: { in: [GFCI, AFCI, WIRE] } } });
  await prisma.priceBookAtomic.create({ data: { itemId: GFCI, description: "LNDP 20A GFCI breaker", unit: "ea", purchasePrice: 21.32 } });
  await prisma.priceBookAtomic.create({ data: { itemId: AFCI, description: "LNDP 20A AFCI breaker", unit: "ea", purchasePrice: 45 } });
  await prisma.priceBookAtomic.create({ data: { itemId: WIRE, description: "LNDP 12-2 NM-B", unit: "ft", purchasePrice: 0.72 } });
});

afterAll(async () => {
  await wipe();
  await prisma.priceBookAtomic.deleteMany({ where: { itemId: { in: [GFCI, AFCI, WIRE] } } });
  await prisma.technician.delete({ where: { id: technicianId } });
});

describe("landing prices come from the receipt, line by line", () => {
  it("two breakers on one receipt each land at THEIR receipt line's price, not the book's", async () => {
    const po = await createPurchaseOrder({
      supplier: "Home Depot", openedBy: "owner", actor: "test", truckId,
      lines: [{ itemId: GFCI, name: "20A GFCI breaker", qty: 2, unit: "ea" }, { itemId: AFCI, name: "20A AFCI breaker", qty: 1, unit: "ea" }],
    });
    const receipt = await receiptWith(170, [
      { name: "SQ D 20A GFCI breaker", qty: 2, unit: "ea", unitCost: 54.97 },
      { name: "SQ D 20A AFCI breaker", qty: 1, unit: "ea", unitCost: 47.5 },
    ]);
    await attach(po.id, receipt.id);
    const d = await defaultsOf(po.id);
    expect(d.receiptTotal).toBe(170);
    expect(d.lines.map((l: { unitCostDefault: number; costSource: string }) => [l.unitCostDefault, l.costSource])).toEqual([[54.97, "receipt-line"], [47.5, "receipt-line"]]);
    expect(d.lines[0].matchedReceiptLine).toMatchObject({ receiptId: receipt.id, name: "SQ D 20A GFCI breaker", qty: 2, unitCost: 54.97 });
    expect(d.lines[1].matchedReceiptLine).toMatchObject({ name: "SQ D 20A AFCI breaker", unitCost: 47.5 });
    expect(d.matchedTotal).toBe(157.44);
    // The $12.56 the receipt total carries past its lines (tax) lands on nobody — every line is priced.
    expect(d.remainder).toBe(12.56);
    expect(d.receiptLines).toHaveLength(1);
    expect(d.receiptLines[0].vendor).toBe(VENDOR);
    expect(d.receiptLines[0].lines.map((rl: { matchedLineId: string | null }) => rl.matchedLineId)).toEqual([d.lines[0].lineId, d.lines[1].lineId]);
    expect(d.receiptLines[0].unmatched).toEqual([]);

    // Attaching the receipt moved the PO to purchased; landing with the returned defaults writes purchase_in movements at those costs.
    const land = await request(app).post(`/purchase-orders/${po.id}/land`).send({
      lines: d.lines.map((l: { lineId: string; qtyLandedDefault: number; unitCostDefault: number }) => ({ lineId: l.lineId, qtyLanded: l.qtyLandedDefault, unitCost: l.unitCostDefault })),
    });
    expect(land.status).toBe(200);
    const moves = await prisma.stockMovement.findMany({ where: { purchaseOrderId: po.id }, orderBy: { unitCost: "desc" } });
    expect(moves.map((m) => [m.kind, m.toLocationKey, m.itemId, m.qty, m.unitCost])).toEqual([
      ["purchase_in", truckKey, GFCI, 2, 54.97],
      ["purchase_in", truckKey, AFCI, 1, 47.5],
    ]);
    const gfci = await prisma.stockLevel.findUniqueOrThrow({ where: { locationKey_itemId: { locationKey: truckKey, itemId: GFCI } } });
    expect(gfci.avgUnitCost).toBe(54.97);
  });

  it("a receipt with a total and no line prices prorates by qty × book price, and says so", async () => {
    const po = await createPurchaseOrder({
      supplier: "NES", openedBy: "owner", actor: "test", truckId,
      lines: [{ itemId: WIRE, name: "12-2 NM-B", qty: 100, unit: "ft" }, { itemId: GFCI, name: "20A GFCI breaker", qty: 2, unit: "ea" }],
    });
    const receipt = await receiptWith(120, [
      { name: "12/2 romex 100ft", qty: 100, unit: "ft", unitCost: null },
      { name: "20A GFCI breaker", qty: 2, unit: "ea", unitCost: null },
    ]);
    await attach(po.id, receipt.id);
    const d = await defaultsOf(po.id);
    // Both lines matched a receipt line, but neither carries a price: the whole $120 prorates.
    expect(d.matchedTotal).toBe(0);
    expect(d.remainder).toBe(120);
    expect(d.lines.every((l: { costSource: string; matchedReceiptLine: unknown }) => l.costSource === "receipt-prorated" && l.matchedReceiptLine !== null)).toBe(true);
    // weights 100 × 0.72 = 72 and 2 × 21.32 = 42.64 → 114.64
    expect(d.lines[0].unitCostDefault).toBe(r4((120 * 72) / 114.64 / 100));
    expect(d.lines[1].unitCostDefault).toBe(r4((120 * 42.64) / 114.64 / 2));
  });

  it("one line matches its receipt line, a typed cost holds, the remainder prorates onto the rest; an off-PO receipt line is flagged and can be added", async () => {
    const po = await createPurchaseOrder({
      supplier: "Home Depot", openedBy: "owner", actor: "test", truckId,
      lines: [
        { itemId: GFCI, name: "20A GFCI breaker", qty: 2, unit: "ea" },
        { itemId: WIRE, name: "12-2 NM-B", qty: 100, unit: "ft" },
        { name: "Staples, box", qty: 1, unit: "box", unitCost: 6.5 },
      ],
    });
    // 159.50 = 2 × 25 (GFCI, on the receipt) + 3 (Gatorade, NOT on the PO) + 6.50 (staples, typed) + 100 left for the wire.
    const receipt = await receiptWith(159.5, [
      { name: "20A GFCI breaker", qty: 2, unit: "ea", unitCost: 25 },
      { name: "Gatorade 32oz", qty: 1, unit: "ea", unitCost: 3 },
    ]);
    await attach(po.id, receipt.id);
    let d = await defaultsOf(po.id);
    expect(d.lines.map((l: { unitCostDefault: number; costSource: string }) => [l.unitCostDefault, l.costSource])).toEqual([
      [25, "receipt-line"],
      [1, "receipt-prorated"], // $100 remainder over 100 ft
      [6.5, "po-line"],
    ]);
    expect(d.matchedTotal).toBe(50);
    expect(d.remainder).toBe(100);
    expect(d.receiptLines[0].unmatched).toHaveLength(1);
    expect(d.receiptLines[0].unmatched[0]).toMatchObject({ name: "Gatorade 32oz", qty: 1, unitCost: 3, matchedLineId: null });

    // "not on this PO — add as a line?" → the office add-line route; it then matches and prices from the receipt.
    const add = await request(app).post(`/purchase-orders/${po.id}/lines`).send({ name: "Gatorade 32oz", qty: 1, unit: "ea", unitCost: 3, reason: "added from the receipt at landing" });
    expect(add.status).toBe(201);
    d = await defaultsOf(po.id);
    expect(d.lines).toHaveLength(4);
    expect(d.lines[3]).toMatchObject({ name: "Gatorade 32oz", unitCostDefault: 3, costSource: "receipt-line" });
    expect(d.receiptLines[0].unmatched).toEqual([]);
    expect(d.lines[1]).toMatchObject({ unitCostDefault: 1, costSource: "receipt-prorated" });
  });

  it("no receipt at all → the typed cost, else the book, else none; bad receipt JSON is a note, not a crash", async () => {
    const po = await createPurchaseOrder({
      supplier: "Lowes", openedBy: "owner", actor: "test", truckId,
      lines: [{ itemId: GFCI, name: "20A GFCI breaker", qty: 1, unit: "ea" }, { name: "Wire nuts", qty: 1, unit: "box", unitCost: 4 }, { name: "Mystery", qty: 1 }],
    });
    let d = await defaultsOf(po.id);
    expect(d.lines.map((l: { unitCostDefault: number; costSource: string }) => [l.unitCostDefault, l.costSource])).toEqual([[21.32, "book"], [4, "po-line"], [0, "none"]]);
    const bad = await prisma.receipt.create({ data: { id: newId(), category: "materials", vendor: VENDOR, amount: 30, status: "confirmed", source: "manual", lineItems: "{not json" } });
    await attach(po.id, bad.id);
    d = await defaultsOf(po.id);
    expect(d.receiptLines[0].parseError).toMatch(/not valid JSON/);
    expect(d.receiptLines[0].lines).toEqual([]);
    // Typed cost holds; the remaining $26 spreads over the two unpriced lines (equal split — "Mystery" has no book price).
    expect(d.lines[1]).toMatchObject({ unitCostDefault: 4, costSource: "po-line" });
    expect(d.remainder).toBe(26);
    expect(d.lines[0]).toMatchObject({ unitCostDefault: 13, costSource: "receipt-prorated" });
    expect(d.lines[2]).toMatchObject({ unitCostDefault: 13, costSource: "receipt-prorated" });
  });

  it("the tech route adds a PO line from the receipt too", async () => {
    const po = await createPurchaseOrder({ supplier: "Home Depot", openedBy: "owner", actor: "test", truckId, lines: [{ itemId: GFCI, name: "20A GFCI breaker", qty: 1, unit: "ea" }] });
    const add = await request(app)
      .post(`/health-record/purchase-orders/${po.id}/lines`)
      .set("Authorization", `Bearer ${techToken}`)
      .send({ name: "Gatorade 32oz", qty: 1, unit: "ea", unitCost: 3 });
    expect(add.status).toBe(201);
    expect(add.body.data).toMatchObject({ name: "Gatorade 32oz", qty: 1, unitCost: 3 });
    const after = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id }, include: { lines: true, events: true } });
    expect(after.lines).toHaveLength(2);
    expect(after.events.some((e) => e.kind === "line_added" && e.actor === "tech:LNDP Test Tech")).toBe(true);
  });
});
