/**
 * PO landing prices come from the receipt (Kyle, 2026-09-10: "The pricing on
 * the P.O.'s does not seem to be applied correctly from the receipts, same
 * with the breakers above, they are not the same price."; Kyle, 2026-09-11:
 * "Pricing is not matching up on these P.O.'s.").
 *
 * SUPERSEDED 2026-09-23 (Kyle correcting the 2026-09-11 design): "Stripe is the
 * source of truth… The receipt is just proof of purchase… There might be other
 * charges on there of misc items that do not get consumed on the job. So
 * perfectly balancing the receipt to the job purchase is always going to
 * fail… The receipt being read and reported is not about money tracking. It
 * is about building the price book." Landing is inventory, not money:
 *   1. A line matched to its own receipt line(s) prices at THAT line's own
 *      total ÷ qty, plus its own share of the receipt's tax — tax apportioned
 *      only across lines that matched, never onto a line with no receipt line
 *      of its own.
 *   2. No receipt line → the typed P.O. cost, exactly as typed. No typed cost
 *      → the book's purchase price, exactly as it reads. Neither exists →
 *      cost 0, source "none": a human has to type one.
 *   3. Landing is NEVER refused because the lines do not add up to the
 *      receipt total — a receipt legitimately carries items never on this
 *      P.O. and never consumed on the job, so that will not always balance,
 *      and is not asked to. `balanced` is display-only.
 * The first test below ("two breakers…") is the PIN: when every line matches,
 * this arithmetic was already correct before 2026-09-23 and must read exactly
 * the same after.
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

  it("a receipt with a total and no line prices leaves both lines at their own book price, unscaled", async () => {
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
    // Both lines matched a receipt line, but neither carries a price, so hitTotal is 0 for
    // each and the book price is used — as is, never scaled to the receipt (Kyle, 2026-09-23).
    expect(d.matchedTotal).toBe(0);
    // No line on this receipt carries a price, so nothing can be called tax.
    expect(d.taxTotal).toBe(0);
    expect(d.lines.every((l: { costSource: string; matchedReceiptLine: unknown }) => l.costSource === "book" && l.matchedReceiptLine !== null)).toBe(true);
    expect(d.lines[0].unitCostDefault).toBe(0.72);
    expect(d.lines[1].unitCostDefault).toBe(21.32);
    // 100 × 0.72 + 2 × 21.32 = 114.64 — not the $120 receipt, and that is not a defect: the
    // receipt is proof, not a total the lines must add up to.
    expect(d.linesTotal).toBe(114.64);
    expect(d.balanced).toBe(false);
  });

  it("a matched line, a book-priced line and a typed-cost line each land at their own cost; an off-PO receipt line is flagged and can be added", async () => {
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
    // GFCI matched its own receipt line ($50) and is the ONLY matched line, so it takes ALL
    // of the tax: (50 + 106.50) / 2 = 78.25. WIRE and Staples have no receipt line of their
    // own, so they land at the book price and the typed cost, exactly as they read — never
    // scaled by the receipt (Kyle, 2026-09-23).
    expect(d.lines.map((l: { unitCostDefault: number; costSource: string }) => [l.unitCostDefault, l.costSource])).toEqual([
      [78.25, "receipt-line"],
      [0.72, "book"],
      [6.5, "po-line"],
    ]);
    expect(d.matchedTotal).toBe(50);
    // $53 of the $159.50 is priced on the photo; the rest is unread, not tax.
    expect(d.taxTotal).toBe(106.5);
    expect(d.lines.map((l: { taxShare: number }) => l.taxShare)).toEqual([106.5, 0, 0]);
    // 78.25×2 + 0.72×100 + 6.50×1 = 235.00 — nowhere near the $159.50 receipt, and that is
    // not a defect: a receipt legitimately carries items never on this P.O.
    expect(d.linesTotal).toBe(235);
    expect(d.balanced).toBe(false);
    expect(d.receiptLines[0].unmatched).toHaveLength(1);
    expect(d.receiptLines[0].unmatched[0]).toMatchObject({ name: "Gatorade 32oz", qty: 1, unitCost: 3, matchedLineId: null });

    // "not on this PO — add as a line?" → the office add-line route; it then matches and
    // prices from its OWN receipt line, and re-splits the tax across both matched lines now.
    const add = await request(app).post(`/purchase-orders/${po.id}/lines`).send({ name: "Gatorade 32oz", qty: 1, unit: "ea", unitCost: 3, reason: "added from the receipt at landing" });
    expect(add.status).toBe(201);
    d = await defaultsOf(po.id);
    expect(d.lines).toHaveLength(4);
    // matchedTotal is now 53 (50 + 3); GFCI's tax share drops to 106.5×50/53, Gatorade takes 106.5×3/53.
    expect(d.lines[3]).toMatchObject({ name: "Gatorade 32oz", unitCostDefault: 9.03, costSource: "receipt-line" });
    expect(d.receiptLines[0].unmatched).toEqual([]);
    expect(d.lines[0]).toMatchObject({ unitCostDefault: 75.235, costSource: "receipt-line" });
    // WIRE and Staples are untouched by the Gatorade match — they never shared in the tax.
    expect(d.lines[1]).toMatchObject({ unitCostDefault: 0.72, costSource: "book" });
    expect(d.lines[2]).toMatchObject({ unitCostDefault: 6.5, costSource: "po-line" });
    expect(d.linesTotal).toBe(238);
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
    // Kyle, 2026-09-23: an unreadable receipt fabricates NOTHING. With no parsed lines there
    // is nothing to match and nothing to call tax, so every line stays exactly where it was —
    // book, typed, or none — untouched by the $30 the receipt carries.
    expect(d.taxTotal).toBe(0);
    expect(d.lines.map((l: { unitCostDefault: number; costSource: string }) => [l.unitCostDefault, l.costSource])).toEqual([
      [21.32, "book"],
      [4, "po-line"],
      [0, "none"],
    ]);
    expect(d.linesTotal).toBe(25.32);
    expect(d.balanced).toBe(false);
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
 * The seven picks (Kyle, 2026-09-11), re-read under the 2026-09-23 correction:
 * each case below is a PO he opened in production, and the fix is no longer to
 * force the lines to add up to the receipt — it is to price each line from its
 * OWN receipt line, or leave it for a human when it has none.
 */
describe("each line prices at its own receipt line, never a share of the receipt", () => {
  it("PO-2026-0003: 'Down Rod' matches 'DOWNROD' and prices at its own two receipt lines plus all the tax; the fan matched no price of its own and gets none", async () => {
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
    // The fan's receipt line matched by name but carried no price, so it contributes nothing
    // to the tax base and has no typed cost or book price of its own — "none" (Kyle,
    // 2026-09-23: never an even split; a human has to type this one).
    expect(d.lines[1].costSource).toBe("none");
    expect(d.lines[1].unitCostDefault).toBe(0);
    // The Down Rod line is the ONLY line with a receipt line of its own, so it takes ALL
    // $13.16 of the tax — none of it lands on the fan.
    expect(d.taxTotal).toBe(13.16);
    expect(d.lines.map((l: { taxShare: number }) => l.taxShare)).toEqual([13.16, 0]);
    expect(d.lines.map((l: { unitCostDefault: number }) => l.unitCostDefault)).toEqual([148.14, 0]);
    expect(d.linesTotal).toBe(148.14);
    expect(d.balanced).toBe(true);

    const land = await request(app).post(`/purchase-orders/${po.id}/land`).send({
      lines: d.lines.map((l: { lineId: string; qtyLandedDefault: number; unitCostDefault: number }) => ({ lineId: l.lineId, qtyLanded: l.qtyLandedDefault, unitCost: l.unitCostDefault })),
    });
    expect(land.status).toBe(200);
    const moves = await prisma.stockMovement.findMany({ where: { purchaseOrderId: po.id }, orderBy: { unitCost: "desc" } });
    expect(moves.map((m) => m.unitCost)).toEqual([148.14, 0]);
  });

  it("PO-2026-0004: three receipt lines that share no word with the PO line's name leave it unmatched and unpriced — never forced to the swipe, never fabricated", async () => {
    const po = await createPurchaseOrder({
      supplier: "Home Depot", openedBy: "owner", actor: "test", truckId,
      lines: [{ name: "Fan wire extension and heat shrink", qty: 1, unit: "ea" }],
    });
    // The photo reader read the prices as 2.90 + 18.10 + 8.50 = 29.50 on a $12.51 receipt, and
    // none of "TUBING" / "HS TUBING" / "18-4 CABLE" shares a word with "Fan wire extension and
    // heat shrink", so nothing matches. Under the old (2026-09-11) design this ad-hoc, unmatched
    // line was the PO's ONLY line, so the "even" rung forced it to land at the whole receipt
    // total (12.51) regardless — the fabrication this plan removes.
    const receipt = await receiptWith(12.51, [
      { name: "TUBING", qty: 1, unit: "ea", unitCost: 2.9 },
      { name: "HS TUBING", qty: 1, unit: "ea", unitCost: 18.1 },
      { name: "18-4 CABLE", qty: 1, unit: "ea", unitCost: 8.5 },
    ]);
    await attach(po.id, receipt.id);
    const d = await defaultsOf(po.id);
    // Nothing matched, so there is nothing to call tax either.
    expect(d.taxTotal).toBe(0);
    expect(d.receiptLines[0].unmatched).toHaveLength(3);
    // Kyle, 2026-09-23: no receipt line, no typed cost, no book price (it is ad-hoc) — "none".
    // A human has to type a cost; it is never guessed from the receipt's total.
    expect(d.lines[0].costSource).toBe("none");
    expect(d.lines[0].unitCostDefault).toBe(0);
    expect(d.linesTotal).toBe(0);
    // $0 vs the $12.51 receipt — informational only, and it does not block landing.
    expect(d.balanced).toBe(false);

    const land = await request(app).post(`/purchase-orders/${po.id}/land`).send({
      lines: [{ lineId: d.lines[0].lineId, qtyLanded: d.lines[0].qtyLandedDefault, unitCost: 6 }],
    });
    expect(land.status).toBe(200);
    const mv = await prisma.stockMovement.findFirstOrThrow({ where: { purchaseOrderId: po.id } });
    expect(mv.unitCost).toBe(6);
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

  it("Kyle's real case: a receipt carrying an item never on the P.O. still lands the P.O.'s own line at its own cost, and landing is never refused", async () => {
    const po = await createPurchaseOrder({
      supplier: "NES", openedBy: "owner", actor: "test", truckId,
      lines: [{ itemId: GFCI, name: "20A GFCI breaker", qty: 2, unit: "ea" }],
    });
    // The card swiped $100: $90 for the two breakers this P.O. bought, $10 for a bungee cord
    // that never went on the truck and was never consumed on a job (Kyle, 2026-09-23: "There
    // might be other charges on there of misc items that do not get consumed on the job").
    const receipt = await receiptWith(100, [
      { name: "20A GFCI breaker", qty: 2, unit: "ea", unitCost: 45 },
      { name: "Bungee cords", qty: 1, unit: "ea", unitCost: 10 },
    ]);
    await attach(po.id, receipt.id);
    const d = await defaultsOf(po.id);
    // The breaker prices at its own receipt line (90 ÷ 2 = 45). The printed lines already sum
    // to the receipt (90 + 10 = 100), so there is no tax gap at all — no line gets a tax share.
    expect(d.lines[0].costSource).toBe("receipt-line");
    expect(d.lines[0].unitCostDefault).toBe(45);
    expect(d.taxTotal).toBe(0);
    expect(d.linesTotal).toBe(90);
    // The receipt totals $100; the P.O.'s own line lands at $90. That is not a defect — the
    // bungee cord was never this P.O.'s to land — and it is never refused for it.
    expect(d.balanced).toBe(false);
    expect(d.receiptLines[0].unmatched).toHaveLength(1);
    expect(d.receiptLines[0].unmatched[0]).toMatchObject({ name: "Bungee cords", qty: 1, unitCost: 10, matchedLineId: null });

    const lineId = d.lines[0].lineId;
    const land = await request(app).post(`/purchase-orders/${po.id}/land`).send({ lines: [{ lineId, qtyLanded: 2, unitCost: d.lines[0].unitCostDefault }] });
    expect(land.status).toBe(200);
    const after = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } });
    expect(after.landedAt).not.toBeNull();
    const mv = await prisma.stockMovement.findFirstOrThrow({ where: { purchaseOrderId: po.id } });
    expect(mv.unitCost).toBe(45);
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

  // Legacy purchase close-out, Unit 4 (2026-09-14): a Vision year mis-parse
  // (2022 instead of 2026) hid a $324.33 receipt from the P&L entirely and kept
  // its card transaction from ever matching. plausiblePurchaseDate/resolvePurchaseDate
  // in receiptVision.ts reject an implausible date; these tests cover the two write
  // sites' response to that rejection.
  it("a normal in-range purchase date is written untouched, and the receipt stays confirmed", async () => {
    const po = await createPurchaseOrder({
      supplier: "Home Depot", openedBy: "owner", actor: "test", truckId,
      lines: [{ itemId: GFCI, name: "20A GFCI breaker", qty: 1, unit: "ea" }],
    });
    vision.result = {
      vendor: VENDOR,
      total: 24.99,
      purchaseDate: "2026-09-08",
      purchaseDateRejected: false,
      category: "materials",
      lineItems: [{ name: "20A GFCI breaker", qty: 1, unit: "ea", unitCost: 22.5 }],
    };
    const receiptId = newId();
    const res = await request(app)
      .put(`/purchase-orders/${po.id}/receipts/${receiptId}`)
      .set("Content-Type", "image/jpeg")
      .send(Buffer.from([0xff, 0xd8, 0xff, 0xdb]));
    expect(res.status).toBe(201);

    const receipt = await prisma.receipt.findUniqueOrThrow({ where: { id: receiptId } });
    expect(receipt.status).toBe("confirmed");
    expect(receipt.receivedAt.toISOString().slice(0, 10)).toBe("2026-09-08");
    vision.result = null;
  });

  it("a rejected purchase date falls back to the upload time, flags the receipt for review, and keeps the amount and photo", async () => {
    const po = await createPurchaseOrder({
      supplier: "Home Depot", openedBy: "owner", actor: "test", truckId,
      lines: [{ itemId: GFCI, name: "20A GFCI breaker", qty: 1, unit: "ea" }],
    });
    // The exact shape of the 2022-09-08 Tran mis-parse: Vision found a date,
    // resolvePurchaseDate() rejected it, so purchaseDate is null but the rejection
    // flag is set — the signal a plain "no date read" wouldn't carry.
    vision.result = {
      vendor: VENDOR,
      total: 324.33,
      purchaseDate: null,
      purchaseDateRejected: true,
      category: "materials",
      lineItems: [{ name: "20A GFCI breaker", qty: 1, unit: "ea", unitCost: 22.5 }],
    };
    const receiptId = newId();
    const before = new Date();
    const res = await request(app)
      .put(`/purchase-orders/${po.id}/receipts/${receiptId}`)
      .set("Content-Type", "image/jpeg")
      .send(Buffer.from([0xff, 0xd8, 0xff, 0xdb]));
    expect(res.status).toBe(201);
    // The amount and photo are never discarded just because the date was untrustworthy.
    expect(res.body).toMatchObject({ id: receiptId, purchaseOrderId: po.id, amount: 324.33 });

    const receipt = await prisma.receipt.findUniqueOrThrow({ where: { id: receiptId } });
    expect(receipt.status).toBe("pending_review");
    expect(receipt.amount).toBe(324.33);
    expect(receipt.imageMime).toBe("image/jpeg");
    expect(receipt.imageData).not.toBeNull();
    // receivedAt falls back to the upload time (Prisma's default now()), not the rejected date.
    expect(receipt.receivedAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
    vision.result = null;
  });
});
