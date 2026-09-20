/**
 * A job-tagged PO lands on its job (Kyle, 2026-09-15) — and since 2026-09-19
 * THE P.O. IS THE MONEY.
 *
 * "All items on a P.O. should land automatically on the job it was bought for.
 * Left over material gets counted to the truck or warehouse once the job is
 * marked complete." landPurchaseOrder lands and, in the SAME transaction,
 * consumes every landed line from that location toward the job, so the truck
 * nets back to where it stood. That is the INVENTORY side and it is unchanged.
 * The COST side (Kyle, 2026-09-19): the job's material is the money on the
 * P.O. — its card charges and typed not-on-card amount — not the landed
 * lines, not the consume. A P.O. with no money charges nothing yet.
 *
 * What these tests hold to:
 *   - a PO with no job is a restock and behaves exactly as before;
 *   - a tool PO never charges a job, tagged or not — its money is overhead;
 *   - Decision C: a PO tagged to the visit an estimate was quoted on charges
 *     the SOLD job (materialCostForJobs follows the signed estimate on its
 *     own); an unsold quote keeps the charge on its own visit;
 *   - all or nothing: a job that may not touch inventory (a test account)
 *     refuses the whole landing, and nothing lands;
 *   - a location already below zero does not block the landing.
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
import { WAREHOUSE_KEY, applyMovement, landPurchaseOrder, truckLocationKey } from "../src/services/inventory";
import { materialCostForJobs } from "../src/services/jobCosting";

const newId = () => crypto.randomUUID().replaceAll("-", "");
const r2 = (n: number) => Math.round(n * 100) / 100;

const WIRE = "PLJ-WIRE";
const BOX = "PLJ-BOX";
const BREAKER = "PLJ-BREAKER";

let truckId: string;
let truckKey: string;
let customerId: string;
let testCustomerId: string;
let propertyId: string;
let job: string;
let restockNeighbour: string;
let quoteVisit: string;
let soldJob: string;
let unsoldQuote: string;
let toolJob: string;
let negativeJob: string;
let testJob: string;

async function wipeInventory() {
  await prisma.cardSpend.deleteMany({ where: { stripeCardId: "card_plj" } });
  await prisma.stockMovement.deleteMany();
  await prisma.stockLevel.deleteMany();
  await prisma.toolMovement.deleteMany();
  await prisma.tool.deleteMany();
  await prisma.receipt.updateMany({ where: { purchaseOrderId: { not: null } }, data: { purchaseOrderId: null } });
  await prisma.purchaseOrder.deleteMany();
  await prisma.purchaseOrderCounter.deleteMany();
}

async function cleanFixtures() {
  await prisma.issuedEstimate.deleteMany({ where: { number: { startsWith: "0000-PLJ" } } });
  await prisma.priceBookDraftEstimate.deleteMany({ where: { title: "po-lands-on-job draft" } });
  for (const id of [customerId, testCustomerId]) {
    if (!id) continue;
    await prisma.visit.deleteMany({ where: { customerId: id } });
    await prisma.property.deleteMany({ where: { customerId: id } });
    await prisma.customer.delete({ where: { id } }).catch(() => {});
  }
}

const level = (locationKey: string, itemId: string) =>
  prisma.stockLevel.findUnique({ where: { locationKey_itemId: { locationKey, itemId } } });

/** Every ledger row a landing wrote, in a deterministic order (they all share one `at`): by item, then purchase_in before consume. */
const movementsOn = async (purchaseOrderId: string) =>
  (await prisma.stockMovement.findMany({ where: { purchaseOrderId } }))
    .sort((a, b) => a.itemId.localeCompare(b.itemId) || (a.kind === b.kind ? 0 : a.kind === "purchase_in" ? -1 : 1));

const landedEvent = async (purchaseOrderId: string) => {
  const ev = await prisma.purchaseOrderEvent.findFirstOrThrow({ where: { purchaseOrderId, kind: "landed" } });
  return JSON.parse(ev.after ?? "{}") as {
    chargedJob?: { jobId: string; poJobId: string; viaEstimate: string | null };
    lines: Array<{ lineId: string; itemId: string; qtyLanded: number; unitCost: number; movementId?: string; consumeMovementId?: string; chargedUnitCost?: number | null }>;
  };
};

/** A purchased PO, ready to land, with its line ids in order. */
async function purchasedPo(input: Parameters<typeof createPurchaseOrder>[0]) {
  const po = await createPurchaseOrder(input);
  await transitionPurchaseOrder(po.id, "purchased", { actor: "test" });
  const lines = await prisma.purchaseOrderLine.findMany({ where: { purchaseOrderId: po.id }, orderBy: { sortOrder: "asc" } });
  return { po, lines };
}

const costOf = async (visitId: string, chainVisitIds: string[] = []) =>
  (await materialCostForJobs([{ visitId, chainVisitIds }])).get(visitId)!;

/** THE MONEY on a PO: a card charge of this kind. */
async function chargeOn(purchaseOrderId: string, amount: number, kind = "materials") {
  await prisma.cardSpend.create({
    data: { stripeTransactionId: `plj_${newId()}`, stripeCardId: "card_plj", kind, amount, merchantName: "PLJ store", purchaseOrderId, occurredAt: new Date() },
  });
}

beforeAll(async () => {
  await wipeInventory();
  truckId = await defaultTruckId();
  truckKey = truckLocationKey(truckId);
  await prisma.priceBookAtomic.deleteMany({ where: { itemId: { in: [WIRE, BOX, BREAKER] } } });
  await prisma.priceBookAtomic.create({ data: { itemId: WIRE, description: "PLJ 12-2 NM-B", unit: "ft", purchasePrice: 0.72 } });
  await prisma.priceBookAtomic.create({ data: { itemId: BOX, description: "PLJ 4-square box", unit: "ea", purchasePrice: 1.1 } });
  await prisma.priceBookAtomic.create({ data: { itemId: BREAKER, description: "PLJ 20A breaker", unit: "ea", purchasePrice: 9.5 } });

  const customer = await prisma.customer.create({ data: { name: "PO Lands On Job Co", phone: "+16155508888" } });
  customerId = customer.id;
  const property = await prisma.property.create({
    data: { customerId, name: "Landing House", addressLine1: "9 Landing Ln", city: "Franklin", state: "TN", postalCode: "37064" },
  });
  propertyId = property.id;
  const mk = async (jobType: string, at: { customerId: string; propertyId: string } = { customerId, propertyId }, status = "in_progress") =>
    (await prisma.visit.create({
      data: { ...at, mode: "onsite", purpose: jobType, jobType, status, visitDate: new Date() },
    })).id;
  job = await mk("PLJ tagged job");
  restockNeighbour = await mk("PLJ neighbour");
  quoteVisit = await mk("PLJ estimate appointment", undefined, "estimate");
  soldJob = await mk("PLJ sold job");
  unsoldQuote = await mk("PLJ unsold estimate", undefined, "estimate");
  toolJob = await mk("PLJ tool job");
  negativeJob = await mk("PLJ negative job");

  // Kyle, 2026-09-12: a test account's jobs never touch inventory.
  const testCustomer = await prisma.customer.create({ data: { name: "PLJ Test Account", phone: "+16155508889", isTestAccount: true } });
  testCustomerId = testCustomer.id;
  const testProperty = await prisma.property.create({
    data: { customerId: testCustomerId, name: "Test House", addressLine1: "1 Nowhere Rd", city: "Franklin", state: "TN", postalCode: "37064" },
  });
  testJob = await mk("PLJ test job", { customerId: testCustomerId, propertyId: testProperty.id });

  // The quote → job chain: the estimate was quoted on quoteVisit and signed into soldJob.
  const draft = await prisma.priceBookDraftEstimate.create({ data: { title: "po-lands-on-job draft", supplierId: "PLJ-SUP" } });
  await prisma.issuedEstimate.create({
    data: {
      number: "0000-PLJ-SOLD", token: `plj-token-${newId()}`, status: "signed", draftId: draft.id,
      customerId, serviceAddressId: propertyId, visitId: quoteVisit, jobVisitId: soldJob,
      customerName: "PO Lands On Job Co", serviceAddress: "9 Landing Ln, Franklin", title: "PLJ sold",
      workSubtotal: 1500, total: 1500, selectedOptions: ["A"], signedAt: new Date(), signedChannel: "email",
    },
  });
  // An unsold quote: issued, never signed, no job behind it.
  await prisma.issuedEstimate.create({
    data: {
      number: "0000-PLJ-OPEN", token: `plj-token-${newId()}`, status: "sent", draftId: draft.id,
      customerId, serviceAddressId: propertyId, visitId: unsoldQuote,
      customerName: "PO Lands On Job Co", serviceAddress: "9 Landing Ln, Franklin", title: "PLJ unsold",
      workSubtotal: 900, total: 900, selectedOptions: ["A"],
    },
  });
});

afterAll(async () => {
  await wipeInventory();
  await cleanFixtures();
  await prisma.priceBookAtomic.deleteMany({ where: { itemId: { in: [WIRE, BOX, BREAKER] } } });
});

describe("a job-tagged PO charges its job as it lands", () => {
  it("lands, then consumes every line toward the job in one go; the truck nets back and the stock rung carries the job", async () => {
    // The truck already holds 10 boxes at $1.00 — the moving average is the point of landing first.
    await applyMovement(prisma, { kind: "count", itemId: BOX, name: "4-square box", unit: "ea", qty: 10, unitCost: 1, toLocationKey: truckKey, actor: "test" });
    expect(await level(truckKey, WIRE)).toBeNull();

    const { po, lines } = await purchasedPo({
      supplier: "Home Depot", openedBy: "owner", actor: "test", truckId, jobId: job,
      lines: [
        { itemId: WIRE, name: "12-2 NM-B", qty: 100, unit: "ft" },
        { itemId: BOX, name: "4-square box", qty: 10, unit: "ea" },
        { itemId: BREAKER, name: "20A breaker", qty: 2, unit: "ea" },
      ],
    });
    // The money: the card rang up $95.00 for this trip.
    await chargeOn(po.id, 95);
    const result = await landPurchaseOrder(po.id, [
      { lineId: lines[0].id, qtyLanded: 100, unitCost: 0.8 },
      { lineId: lines[1].id, qtyLanded: 10, unitCost: 2 },
      { lineId: lines[2].id, qtyLanded: 0, unitCost: 9.5 }, // short-shipped: nothing landed
    ], "owner", "Copeland parts");

    // The truck is back where it stood: no wire, the same ten boxes.
    expect((await level(truckKey, WIRE))!.qtyOnHand).toBe(0);
    const box = (await level(truckKey, BOX))!;
    expect(box.qtyOnHand).toBe(10);
    // 10 @ 1.00 + 10 @ 2.00 → 20 @ 1.50; the ten consumed leave ten at the blended $1.50.
    expect(box.avgUnitCost).toBe(1.5);
    expect(await level(truckKey, BREAKER)).toBeNull();

    // Two purchase_in + two consume, all on this PO, all at the same instant.
    const mvs = await movementsOn(po.id);
    expect(mvs.map((m) => [m.kind, m.itemId, m.qty, m.unitCost, m.jobId])).toEqual([
      ["purchase_in", BOX, 10, 2, null],
      ["consume", BOX, 10, 1.5, job],
      ["purchase_in", WIRE, 100, 0.8, null],
      ["consume", WIRE, 100, 0.8, job],
    ]);
    expect(new Set(mvs.map((m) => m.at.getTime())).size).toBe(1);
    const consumes = mvs.filter((m) => m.kind === "consume");
    const consumeOf = (itemId: string) => consumes.find((m) => m.itemId === itemId)!;
    expect(consumes.every((m) => m.fromLocationKey === truckKey && m.actor === "owner")).toBe(true);
    expect(consumes.every((m) => m.reason === `Bought for the job on ${po.number} — charged as it landed · Copeland parts`)).toBe(true);
    expect(consumeOf(WIRE).purchaseOrderLineId).toBe(lines[0].id);
    expect(consumeOf(BOX).purchaseOrderLineId).toBe(lines[1].id);

    // The job's cost is the PO's money — the $95.00 charge — not the landed lines.
    const cost = await costOf(job);
    expect(cost).toMatchObject({ materialSource: "po", materialCost: 95, po: { card: 95, typed: 0, net: 95, poCount: 1 } });

    // The trail: the landed event says which job, and each line names its consume.
    expect(result.chargedJob).toEqual({ poJobId: job, jobId: job, viaEstimate: null });
    const ev = await landedEvent(po.id);
    expect(ev.chargedJob).toEqual({ poJobId: job, jobId: job, viaEstimate: null });
    expect(ev.lines.map((l) => [l.itemId, l.consumeMovementId ?? null, l.chargedUnitCost ?? null])).toEqual([
      [WIRE, consumeOf(WIRE).id, 0.8],
      [BOX, consumeOf(BOX).id, 1.5],
      [BREAKER, null, null],
    ]);
    expect((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } })).status).toBe("closed");

    // The job's materials panel shows the two automatic lines (inventory) beside the money.
    const view = await request(app).get(`/jobs/${job}/materials`);
    expect(view.status).toBe(200);
    expect(view.body.materialSource).toBe("po");
    expect(view.body.materialCost).toBe(95);
    expect(view.body.stock).toEqual({ consumed: 95, returned: 0, net: 95, movementCount: 2 });
    expect(view.body.lines.map((l: { kind: string; cost: number }) => [l.kind, l.cost]).sort((a: [string, number], b: [string, number]) => a[1] - b[1])).toEqual([["consume", 15], ["consume", 80]]);
  });

  it("a PO with no job is a restock: it lands and stays on the truck, nothing is consumed", async () => {
    const before = (await level(truckKey, BOX))!.qtyOnHand;
    const { po, lines } = await purchasedPo({
      supplier: "Home Depot", openedBy: "owner", actor: "test", truckId,
      lines: [{ itemId: BOX, name: "4-square box", qty: 20, unit: "ea" }],
    });
    const result = await landPurchaseOrder(po.id, [{ lineId: lines[0].id, qtyLanded: 20, unitCost: 1.5 }], "owner");
    expect((await level(truckKey, BOX))!.qtyOnHand).toBe(before + 20);
    const mvs = await movementsOn(po.id);
    expect(mvs.map((m) => m.kind)).toEqual(["purchase_in"]);
    expect(result.chargedJob).toBeNull();
    expect((await landedEvent(po.id)).chargedJob).toBeUndefined();
    expect(await prisma.stockMovement.count({ where: { kind: "consume", jobId: restockNeighbour } })).toBe(0);
  });

  it("a tool PO with a job creates tools and charges nothing — its money is overhead, not job material", async () => {
    const { po, lines } = await purchasedPo({
      supplier: "Harbor Freight", purpose: "tool", openedBy: "owner", actor: "test", truckId, jobId: toolJob,
      lines: [{ name: "Cordless drill", qty: 1, unit: "ea" }],
    });
    await chargeOn(po.id, 129, "tool");
    await prisma.purchaseOrder.update({ where: { id: po.id }, data: { offCardAmount: 20, offCardMethod: "cash", offCardAt: new Date() } });
    const result = await landPurchaseOrder(po.id, [{ lineId: lines[0].id, qtyLanded: 1, unitCost: 129 }], "owner");
    expect(await prisma.tool.count({ where: { purchaseOrderId: po.id, locationKey: truckKey } })).toBe(1);
    expect(await movementsOn(po.id)).toEqual([]);
    expect(result.chargedJob).toBeNull();
    expect(await costOf(toolJob)).toMatchObject({ materialSource: "none", materialCost: 0 });
  });

  it("a warehouse PO with a job lands in the warehouse and charges the job from there", async () => {
    const { po, lines } = await purchasedPo({
      supplier: "ASD", purpose: "warehouse", openedBy: "owner", actor: "test", jobId: restockNeighbour,
      lines: [{ itemId: BREAKER, name: "20A breaker", qty: 4, unit: "ea" }],
    });
    await chargeOn(po.id, 40);
    await landPurchaseOrder(po.id, [{ lineId: lines[0].id, qtyLanded: 4, unitCost: 10 }], "owner");
    expect((await level(WAREHOUSE_KEY, BREAKER))!.qtyOnHand).toBe(0);
    const mvs = await movementsOn(po.id);
    expect(mvs.map((m) => [m.kind, m.toLocationKey, m.fromLocationKey, m.jobId])).toEqual([
      ["purchase_in", WAREHOUSE_KEY, null, null],
      ["consume", null, WAREHOUSE_KEY, restockNeighbour],
    ]);
    expect(await costOf(restockNeighbour)).toMatchObject({ materialSource: "po", materialCost: 40 });
  });
});

describe("Decision C — a PO tagged to the quote follows the signed estimate to the job", () => {
  it("charges the SOLD job, not the appointment it was quoted on", async () => {
    const { po, lines } = await purchasedPo({
      supplier: "NES", openedBy: "tech", actor: "test", truckId, jobId: quoteVisit,
      lines: [{ itemId: WIRE, name: "12-2 NM-B", qty: 50, unit: "ft" }],
    });
    await chargeOn(po.id, 45);
    const result = await landPurchaseOrder(po.id, [{ lineId: lines[0].id, qtyLanded: 50, unitCost: 0.9 }], "tech:PLJ");
    expect(result.chargedJob).toEqual({ poJobId: quoteVisit, jobId: soldJob, viaEstimate: "0000-PLJ-SOLD" });
    const consume = (await movementsOn(po.id)).find((m) => m.kind === "consume")!;
    expect(consume.jobId).toBe(soldJob);
    expect(consume.reason).toBe(`Bought for the job on ${po.number} — charged as it landed · via 0000-PLJ-SOLD`);
    expect((await level(truckKey, WIRE))!.qtyOnHand).toBe(0);

    // The sold job costs on its own id — materialCostForJobs follows the signed
    // estimate back to the quote visit's P.O.s — which is what
    // /financials/job-profitability relies on.
    expect(await costOf(soldJob)).toMatchObject({ materialSource: "po", materialCost: 45 });
    expect(await costOf(quoteVisit)).toMatchObject({ materialSource: "po", materialCost: 45 });
    expect((await landedEvent(po.id)).chargedJob).toEqual({ poJobId: quoteVisit, jobId: soldJob, viaEstimate: "0000-PLJ-SOLD" });
  });

  it("an unsold quote keeps the charge on its own visit, where the cost chain will find it if it sells", async () => {
    const { po, lines } = await purchasedPo({
      supplier: "NES", openedBy: "owner", actor: "test", truckId, jobId: unsoldQuote,
      lines: [{ itemId: BREAKER, name: "20A breaker", qty: 1, unit: "ea" }],
    });
    await chargeOn(po.id, 12);
    const result = await landPurchaseOrder(po.id, [{ lineId: lines[0].id, qtyLanded: 1, unitCost: 12 }], "owner");
    expect(result.chargedJob).toEqual({ poJobId: unsoldQuote, jobId: unsoldQuote, viaEstimate: null });
    expect((await movementsOn(po.id)).find((m) => m.kind === "consume")!.jobId).toBe(unsoldQuote);
    expect(await costOf(unsoldQuote)).toMatchObject({ materialSource: "po", materialCost: 12 });
    // Once it sells, the job reads the quote visit's P.O.s through its chain (GET /jobs, the account summary).
    expect(await costOf(soldJob, [unsoldQuote])).toMatchObject({ materialSource: "po", materialCost: r2(45 + 12) });
  });
});

describe("all or nothing", () => {
  it("a test-account job refuses the whole landing — nothing lands, the PO stays purchased", async () => {
    const { po, lines } = await purchasedPo({
      supplier: "Home Depot", openedBy: "owner", actor: "test", truckId, jobId: testJob,
      lines: [{ itemId: WIRE, name: "12-2 NM-B", qty: 25, unit: "ft" }],
    });
    const wireBefore = (await level(truckKey, WIRE))?.qtyOnHand ?? 0;
    const res = await request(app).post(`/purchase-orders/${po.id}/land`).send({ lines: [{ lineId: lines[0].id, qtyLanded: 25, unitCost: 0.7 }] });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/test account/);
    expect(await movementsOn(po.id)).toEqual([]);
    expect((await level(truckKey, WIRE))?.qtyOnHand ?? 0).toBe(wireBefore);
    const after = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id }, include: { lines: true } });
    expect(after.status).toBe("purchased");
    expect(after.landedAt).toBeNull();
    expect(after.lines[0].landedAt).toBeNull();
    expect(await prisma.purchaseOrderEvent.count({ where: { purchaseOrderId: po.id, kind: "landed" } })).toBe(0);
  });

  it("a truck already below zero does not block the landing; the consume is written and the deficit stays as it was", async () => {
    // Kyle's manual override drove the truck to −3 breakers before this purchase.
    await applyMovement(prisma, { kind: "consume", itemId: BREAKER, name: "20A breaker", unit: "ea", qty: 3, fromLocationKey: truckKey, jobId: negativeJob, reason: "count is behind", actor: "owner", allowNegative: true });
    expect((await level(truckKey, BREAKER))!.qtyOnHand).toBe(-3);

    const { po, lines } = await purchasedPo({
      supplier: "Home Depot", openedBy: "owner", actor: "test", truckId, jobId: negativeJob,
      lines: [{ itemId: BREAKER, name: "20A breaker", qty: 10, unit: "ea" }],
    });
    await landPurchaseOrder(po.id, [{ lineId: lines[0].id, qtyLanded: 10, unitCost: 11 }], "owner");
    const lvl = (await level(truckKey, BREAKER))!;
    expect(lvl.qtyOnHand).toBe(-3);
    const consume = (await movementsOn(po.id)).find((m) => m.kind === "consume")!;
    expect(consume.unitCost).toBe(11);
    expect(consume.qty).toBe(10);
  });
});
