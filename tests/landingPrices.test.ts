/**
 * PO landing prices come from the receipt (Kyle, 2026-09-10: "The pricing on
 * the P.O.'s does not seem to be applied correctly from the receipts, same
 * with the breakers above, they are not the same price."; Kyle, 2026-09-11:
 * "Pricing is not matching up on these P.O.'s.").
 *
 * The 2026-09-11 ruling, which these tests hold to:
 *   1. "The receipt total is the truth. It matches the card swipe to the cent."
 *      The photo's line prices are only WEIGHTS — a landing's total always
 *      equals the sum of the attached receipts' amounts.
 *   2. "Sales tax is spread across the lines", so a landed unit cost is what
 *      was actually paid, tax included. Never left as a remainder.
 *   3. Land is held when the two do not agree (tolerance $0.01); "Land anyway"
 *      takes a one-line reason that lands on the event and every movement.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import crypto from "node:crypto";
import { prisma } from "../src/lib/prisma";
import type { ParsedReceipt } from "../src/services/receiptVision";

process.env.GOOGLE_CLIENT_ID = "test_id";
process.env.GOOGLE_CLIENT_SECRET = "test_secret";
process.env.GOOGLE_REFRESH_TOKEN = "test_token";
delete process.env.OPENAI_API_KEY;
delete process.env.STRIPE_SECRET_KEY;

// The photo reader is mocked — no OpenAI call ever leaves a test.
const vision = vi.hoisted(() => ({ result: null as ParsedReceipt | null }));
vi.mock("../src/services/receiptVision", () => ({
  parseReceiptImage: vi.fn(async () => vision.result),
  plausiblePurchaseDate: (value: unknown) => (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null),
}));

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
  it("two breakers on one receipt each land at THEIR receipt line's price plus its tax share", async () => {
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
    // Weights 109.94 and 47.50 → the $170 swipe splits 118.71 / 51.29, tax included.
    expect(d.lines.map((l: { unitCostDefault: number; costSource: string }) => [l.unitCostDefault, l.costSource])).toEqual([[59.355, "receipt-line"], [51.29, "receipt-line"]]);
    expect(d.lines[0].matchedReceiptLine).toMatchObject({ receiptId: receipt.id, name: "SQ D 20A GFCI breaker", qty: 2, unitCost: 54.97 });
    expect(d.lines[1].matchedReceiptLine).toMatchObject({ name: "SQ D 20A AFCI breaker", unitCost: 47.5 });
    expect(d.matchedTotal).toBe(157.44);
    // Kyle, 2026-09-11: the $12.56 past the printed lines is SALES TAX — spread, never left over.
    expect(d.taxTotal).toBe(12.56);
    expect(d.lines.map((l: { taxShare: number }) => l.taxShare)).toEqual([8.77, 3.79]);
    expect(d.linesTotal).toBe(170);
    expect(d.balanced).toBe(true);
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
      ["purchase_in", truckKey, GFCI, 2, 59.355],
      ["purchase_in", truckKey, AFCI, 1, 51.29],
    ]);
    const gfci = await prisma.stockLevel.findUniqueOrThrow({ where: { locationKey_itemId: { locationKey: truckKey, itemId: GFCI } } });
    expect(gfci.avgUnitCost).toBe(59.355);
  });

  it("a receipt with a total and no line prices splits by qty × book price, and says so", async () => {
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
    // Both lines matched a receipt line, but neither carries a price: the book prices become the weights.
    expect(d.matchedTotal).toBe(0);
    // No line on this receipt carries a price, so nothing can be called tax.
    expect(d.taxTotal).toBe(0);
    expect(d.lines.every((l: { costSource: string; matchedReceiptLine: unknown }) => l.costSource === "book" && l.matchedReceiptLine !== null)).toBe(true);
    // weights 100 × 0.72 = 72 and 2 × 21.32 = 42.64 → 114.64; $75.37 of the $120 goes to the wire.
    expect(d.lines[0].unitCostDefault).toBe(r4((120 * 72) / 114.64 / 100));
    expect(d.lines[1].unitCostDefault).toBe(22.315); // the last line absorbs the rounding
    expect(d.linesTotal).toBe(120);
    expect(d.balanced).toBe(true);
  });

  it("matched price, typed cost and book price are three weights on one receipt; an off-PO receipt line is flagged and can be added", async () => {
    const po = await createPurchaseOrder({
      supplier: "Home Depot", openedBy: "owner", actor: "test", truckId,
      lines: [
        { itemId: GFCI, name: "20A GFCI breaker", qty: 2, unit: "ea" },
        { itemId: WIRE, name: "12-2 NM-B", qty: 100, unit: "ft" },
        { name: "Staples, box", qty: 1, unit: "box", unitCost: 6.5 },
      ],
    });
    // 159.50 swiped; the photo printed 2 × 25 (GFCI) + 3 (Gatorade, NOT on the PO) = 53, so 106.50 is tax.
    const receipt = await receiptWith(159.5, [
      { name: "20A GFCI breaker", qty: 2, unit: "ea", unitCost: 25 },
      { name: "Gatorade 32oz", qty: 1, unit: "ea", unitCost: 3 },
    ]);
    await attach(po.id, receipt.id);
    let d = await defaultsOf(po.id);
    // Weights 50 (its receipt line), 72 (book: 100 ft × 0.72) and 6.50 (typed) → 128.50.
    expect(d.lines.map((l: { unitCostDefault: number; costSource: string }) => [l.unitCostDefault, l.costSource])).toEqual([
      [31.03, "receipt-line"],
      [0.8937, "book"],
      [8.07, "po-line"],
    ]);
    expect(d.matchedTotal).toBe(50);
    // $53 of the $159.50 is priced on the photo; the rest is unread, not tax.
    expect(d.taxTotal).toBe(106.5);
    expect(d.linesTotal).toBe(159.5);
    expect(d.receiptLines[0].unmatched).toHaveLength(1);
    expect(d.receiptLines[0].unmatched[0]).toMatchObject({ name: "Gatorade 32oz", qty: 1, unitCost: 3, matchedLineId: null });

    // "not on this PO — add as a line?" → the office add-line route; it then matches and takes its weight from the receipt.
    const add = await request(app).post(`/purchase-orders/${po.id}/lines`).send({ name: "Gatorade 32oz", qty: 1, unit: "ea", unitCost: 3, reason: "added from the receipt at landing" });
    expect(add.status).toBe(201);
    d = await defaultsOf(po.id);
    expect(d.lines).toHaveLength(4);
    expect(d.lines[3]).toMatchObject({ name: "Gatorade 32oz", unitCostDefault: 3.64, costSource: "receipt-line" });
    expect(d.receiptLines[0].unmatched).toEqual([]);
    expect(d.lines[1]).toMatchObject({ unitCostDefault: 0.8733, costSource: "book" });
    expect(d.linesTotal).toBe(159.5);
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
    // The receipt is the truth: all $30 splits by weight — book 21.32, typed 4, and "Mystery" on qty alone.
    // Nothing parsed off this receipt, so there is no tax figure to report.
    expect(d.taxTotal).toBe(0);
    expect(d.lines.map((l: { unitCostDefault: number; costSource: string }) => [l.unitCostDefault, l.costSource])).toEqual([
      [24.3, "book"],
      [4.56, "po-line"],
      [1.14, "even"],
    ]);
    expect(d.linesTotal).toBe(30);
    expect(d.balanced).toBe(true);
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

/**
 * The seven picks (Kyle, 2026-09-11). Each case below is a PO he opened in
 * production and read back wrong.
 */
describe("the receipt total is the truth", () => {
  it("PO-2026-0003: 'Down Rod' matches 'DOWNROD', the unpriced fan still lands, and the total is exactly the receipt", async () => {
    const po = await createPurchaseOrder({
      supplier: "Home Depot", openedBy: "owner", actor: "test", truckId,
      lines: [{ name: "Down Rod", qty: 1, unit: "ea" }, { name: '54" Fan', qty: 1, unit: "ea" }],
    });
    // The real receipt: two downrods priced, the fan with no price, $13.16 of sales tax.
    const receipt = await receiptWith(148.14, [
      { name: "DOWNROD", qty: 1, unit: "ea", unitCost: 35.98 },
      { name: '48" MATTE BLACK EXTENSION DOWNROD', qty: 1, unit: "ea", unitCost: 99 },
      { name: "BENNING 52IN LED CEILING FAN", qty: 1, unit: "ea", unitCost: null },
    ]);
    await attach(po.id, receipt.id);
    const d = await defaultsOf(po.id);

    // "Down Rod" and "DOWNROD" share no word token — squashing the spaces makes them one part,
    // and BOTH downrod lines sit under the one PO line (many receipt lines, one PO line).
    expect(d.lines[0].matchedReceiptLines.map((rl: { name: string }) => rl.name)).toEqual(["DOWNROD", '48" MATTE BLACK EXTENSION DOWNROD']);
    expect(d.lines[0].costSource).toBe("receipt-line");
    expect(d.lines[0].weight).toBe(134.98);
    expect(d.lines[1].costSource).toBe("even");
    // The $13.16 of tax is spread, not left over — it used to be the ONLY thing prorated ($6.58 a line).
    expect(d.taxTotal).toBe(13.16);
    expect(d.lines.map((l: { taxShare: number }) => l.taxShare)).toEqual([13.06, 0.1]);
    expect(d.lines.map((l: { unitCostDefault: number }) => l.unitCostDefault)).toEqual([147.05, 1.09]);
    expect(d.linesTotal).toBe(148.14);
    expect(d.balanced).toBe(true);

    const land = await request(app).post(`/purchase-orders/${po.id}/land`).send({
      lines: d.lines.map((l: { lineId: string; qtyLandedDefault: number; unitCostDefault: number }) => ({ lineId: l.lineId, qtyLanded: l.qtyLandedDefault, unitCost: l.unitCostDefault })),
    });
    expect(land.status).toBe(200);
    const moves = await prisma.stockMovement.findMany({ where: { purchaseOrderId: po.id }, orderBy: { unitCost: "desc" } });
    expect(moves.map((m) => m.unitCost)).toEqual([147.05, 1.09]);
  });

  it("PO-2026-0004: parsed prices summing ABOVE the receipt still land at exactly the receipt, never $0", async () => {
    const po = await createPurchaseOrder({
      supplier: "Home Depot", openedBy: "owner", actor: "test", truckId,
      lines: [{ name: "Fan wire extension and heat shrink", qty: 1, unit: "ea" }],
    });
    // The photo reader misread the prices: 2.90 + 18.10 + 8.50 = 29.50 on a $12.51 receipt.
    const receipt = await receiptWith(12.51, [
      { name: "TUBING", qty: 1, unit: "ea", unitCost: 2.9 },
      { name: "HS TUBING", qty: 1, unit: "ea", unitCost: 18.1 },
      { name: "18-4 CABLE", qty: 1, unit: "ea", unitCost: 8.5 },
    ]);
    await attach(po.id, receipt.id);
    const d = await defaultsOf(po.id);
    // Nothing to spread — the printed lines already exceed what was paid; the total still rules.
    expect(d.taxTotal).toBe(0);
    expect(d.lines[0].unitCostDefault).toBe(12.51);
    expect(d.linesTotal).toBe(12.51);
    expect(d.balanced).toBe(true);

    const land = await request(app).post(`/purchase-orders/${po.id}/land`).send({
      lines: [{ lineId: d.lines[0].lineId, qtyLanded: d.lines[0].qtyLandedDefault, unitCost: d.lines[0].unitCostDefault }],
    });
    expect(land.status).toBe(200);
    const mv = await prisma.stockMovement.findFirstOrThrow({ where: { purchaseOrderId: po.id } });
    expect(mv.unitCost).toBe(12.51);
  });

  it("a PO with no lines offers the receipt's own, and once added the landing equals the receipt", async () => {
    const po = await createPurchaseOrder({ supplier: "Lowes", openedBy: "owner", actor: "test", truckId, lines: [] });
    const receipt = await receiptWith(46.8, [
      { name: "Wire connectors", qty: 1, unit: "box", unitCost: 12 },
      { name: "Single gang old work box", qty: 4, unit: "ea", unitCost: 7.5 },
    ]);
    await attach(po.id, receipt.id);
    let d = await defaultsOf(po.id);
    expect(d.lines).toEqual([]);
    expect(d.linesTotal).toBe(0);
    expect(d.balanced).toBe(false);
    expect(d.suggestedLines).toEqual([
      { receiptId: receipt.id, name: "Wire connectors", qty: 1, unit: "box", unitCost: 12 },
      { receiptId: receipt.id, name: "Single gang old work box", qty: 4, unit: "ea", unitCost: 7.5 },
    ]);

    for (const s of d.suggestedLines) {
      const add = await request(app).post(`/purchase-orders/${po.id}/lines`).send({ ...s, reason: "added from the receipt at landing" });
      expect(add.status).toBe(201);
    }
    d = await defaultsOf(po.id);
    expect(d.suggestedLines).toEqual([]);
    expect(d.lines.map((l: { unitCostDefault: number }) => l.unitCostDefault)).toEqual([13.37, 8.3575]);
    expect(d.linesTotal).toBe(46.8);
    expect(d.balanced).toBe(true);
    const land = await request(app).post(`/purchase-orders/${po.id}/land`).send({
      lines: d.lines.map((l: { lineId: string; qtyLandedDefault: number; unitCostDefault: number }) => ({ lineId: l.lineId, qtyLanded: l.qtyLandedDefault, unitCost: l.unitCostDefault })),
    });
    expect(land.status).toBe(200);
  });

  it("landing is refused when the lines do not add up to the receipt, and takes a reason to land anyway", async () => {
    const po = await createPurchaseOrder({
      supplier: "NES", openedBy: "owner", actor: "test", truckId,
      lines: [{ itemId: GFCI, name: "20A GFCI breaker", qty: 2, unit: "ea" }],
    });
    const receipt = await receiptWith(100, [{ name: "20A GFCI breaker", qty: 2, unit: "ea", unitCost: 45 }]);
    await attach(po.id, receipt.id);
    const d = await defaultsOf(po.id);
    expect(d.lines[0].unitCostDefault).toBe(50); // $100 ÷ 2, the $10 of tax included
    const lineId = d.lines[0].lineId;

    const refused = await request(app).post(`/purchase-orders/${po.id}/land`).send({ lines: [{ lineId, qtyLanded: 2, unitCost: 45 }] });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/receipt is the truth/);
    expect((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } })).landedAt).toBeNull();

    const landed = await request(app).post(`/purchase-orders/${po.id}/land`).send({
      lines: [{ lineId, qtyLanded: 2, unitCost: 45 }],
      override: { reason: "one breaker went back, credit pending" },
    });
    expect(landed.status).toBe(200);
    const after = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id }, include: { events: true } });
    const event = after.events.find((e) => e.kind === "landed");
    expect(event?.reason).toMatch(/Landed anyway: one breaker went back/);
    const mv = await prisma.stockMovement.findFirstOrThrow({ where: { purchaseOrderId: po.id } });
    expect(mv.reason).toMatch(/Landed anyway/);
  });

  it("the office uploads the receipt photo straight onto the PO; the reader fills the amount and the lines", async () => {
    const po = await createPurchaseOrder({
      supplier: "Home Depot", openedBy: "owner", actor: "test", truckId,
      lines: [{ itemId: GFCI, name: "20A GFCI breaker", qty: 1, unit: "ea" }],
    });
    vision.result = {
      vendor: VENDOR,
      total: 24.99,
      purchaseDate: null,
      category: "materials",
      lineItems: [{ name: "20A GFCI breaker", qty: 1, unit: "ea", unitCost: 22.5 }],
    };
    const receiptId = newId();
    const res = await request(app)
      .put(`/purchase-orders/${po.id}/receipts/${receiptId}`)
      .set("Content-Type", "image/jpeg")
      .send(Buffer.from([0xff, 0xd8, 0xff, 0xdb]));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: receiptId, purchaseOrderId: po.id, amount: 24.99, parsed: true, lineCount: 1 });

    const receipt = await prisma.receipt.findUniqueOrThrow({ where: { id: receiptId } });
    expect(receipt.purchaseOrderId).toBe(po.id);
    expect(receipt.status).toBe("confirmed");
    expect(receipt.category).toBe("materials");
    expect(receipt.source).toBe("manual");
    expect(receipt.imageMime).toBe("image/jpeg");
    // "photo verification of the receipt" — an open PO moves to purchased on the attach.
    expect((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } })).status).toBe("purchased");

    const d = await defaultsOf(po.id);
    expect(d.receiptTotal).toBe(24.99);
    expect(d.hasReceiptPhoto).toBe(true);
    expect(d.lines[0].unitCostDefault).toBe(24.99);
    expect(d.balanced).toBe(true);
    vision.result = null;
  });
});
