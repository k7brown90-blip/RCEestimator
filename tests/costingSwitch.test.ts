/**
 * Build 4 — the inventory ledger (Kyle, 2026-09-09), under the 2026-09-19 rule.
 *
 * "On future jobs I can label some stock as truckstock and it won't double
 * count the cost." Materials land on a truck or in the warehouse, never on a
 * job; consume and return move the ledger at the truck's moving-average unit
 * cost. What changed on 2026-09-19 ("the P.O. is the money"): the ledger says
 * what is ON THE TRUCK — it no longer decides job cost. A job's material is
 * the money on the P.O.s tagged to it; a restock P.O. with no job is overhead.
 * GET /jobs, the account summary and /financials/job-profitability all go
 * through materialCostForJobs, so they cannot disagree.
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
import { createPurchaseOrder, defaultTruckId, setPurchaseOrderMoney } from "../src/services/purchaseOrders";
import { landPurchaseOrder, truckLocationKey } from "../src/services/inventory";
import { materialCostForJobs, resolveMaterialCost, rollupJobCosts } from "../src/services/jobCosting";

const newId = () => crypto.randomUUID().replaceAll("-", "");
const r2 = (n: number) => Math.round(n * 100) / 100;

const WIRE = "CSW-WIRE";
const BOX = "CSW-BOX";

let truckId: string;
let truckKey: string;
let technicianId: string;
let techToken: string;
let customerId: string;
let propertyId: string;
let jobA: string;
let jobB: string;
let jobC: string;
let legacyJob: string;
let poReceiptJob: string;
let estimateNumberA: string;

async function wipeInventory() {
  await prisma.stockMovement.deleteMany();
  await prisma.stockLevel.deleteMany();
  await prisma.toolMovement.deleteMany();
  await prisma.tool.deleteMany();
  await prisma.stockRequest.deleteMany();
  await prisma.receipt.updateMany({ where: { purchaseOrderId: { not: null } }, data: { purchaseOrderId: null } });
  await prisma.receipt.deleteMany({ where: { vendor: { startsWith: "CSW-test" } } });
  await prisma.cardSpend.deleteMany({ where: { stripeCardId: "card_csw" } });
  await prisma.purchaseOrder.deleteMany();
  await prisma.purchaseOrderCounter.deleteMany();
}

async function cleanFixtures() {
  await prisma.issuedEstimate.deleteMany({ where: { number: { startsWith: "0000-CSW" } } });
  await prisma.priceBookDraftEstimate.deleteMany({ where: { title: "costing-switch draft" } });
  await prisma.receipt.deleteMany({ where: { vendor: { startsWith: "CSW-test" } } });
  if (customerId) {
    await prisma.visitAssignment.deleteMany({ where: { visit: { customerId } } });
    await prisma.visit.deleteMany({ where: { customerId } });
    await prisma.property.deleteMany({ where: { customerId } });
    await prisma.customer.delete({ where: { id: customerId } }).catch(() => {});
  }
}

const level = (locationKey: string, itemId: string) =>
  prisma.stockLevel.findUnique({ where: { locationKey_itemId: { locationKey, itemId } } });

async function signedEstimateFor(jobVisitId: string, suffix: string, draftId: string, lines: Array<{ itemId: string; description: string; quantity: number; materialCost: number }>) {
  return prisma.issuedEstimate.create({
    data: {
      number: `0000-CSW${suffix}`,
      token: `csw-token-${suffix}-${newId()}`,
      status: "signed",
      draftId,
      customerId,
      serviceAddressId: propertyId,
      jobVisitId,
      customerName: "Costing Switch Co",
      serviceAddress: "4 Roll Rd, Franklin",
      title: `Costing switch ${suffix}`,
      workSubtotal: 1500,
      total: 1500,
      selectedOptions: ["A"],
      signedAt: new Date(),
      signedChannel: "email",
      lines: {
        create: lines.map((l, i) => ({
          itemId: l.itemId, description: l.description, quantity: l.quantity, unitPrice: 2, lineTotal: 2 * l.quantity,
          sortOrder: i, option: "A", materialCost: l.materialCost, materialSell: r2(l.materialCost * 1.3),
        })),
      },
    },
  });
}

beforeAll(async () => {
  await wipeInventory();
  truckId = await defaultTruckId();
  truckKey = truckLocationKey(truckId);
  const tech = await prisma.technician.create({ data: { name: "CSW Test Tech", accessToken: `csw-test-${newId()}` } });
  technicianId = tech.id;
  techToken = tech.accessToken;
  await prisma.truck.update({ where: { id: truckId }, data: { technicianId } });
  await prisma.priceBookAtomic.deleteMany({ where: { itemId: { in: [WIRE, BOX] } } });
  await prisma.priceBookAtomic.create({ data: { itemId: WIRE, description: "CSW 12-2 NM-B", unit: "ft", purchasePrice: 0.72 } });
  await prisma.priceBookAtomic.create({ data: { itemId: BOX, description: "CSW 4-square box", unit: "ea", purchasePrice: 1.1 } });

  const customer = await prisma.customer.create({ data: { name: "Costing Switch Co", phone: "+16155507777" } });
  customerId = customer.id;
  const property = await prisma.property.create({
    data: { customerId, name: "Roll House", addressLine1: "4 Roll Rd", city: "Franklin", state: "TN", postalCode: "37064" },
  });
  propertyId = property.id;
  const mk = async (jobType: string, status = "completed") =>
    (await prisma.visit.create({
      data: {
        customerId, propertyId, mode: "onsite", purpose: jobType, jobType, status,
        visitDate: new Date(), ...(status === "completed" ? { completedAt: new Date() } : {}),
      },
    })).id;
  jobA = await mk("CSW Job A");
  jobB = await mk("CSW Job B");
  jobC = await mk("CSW Job C", "in_progress");
  legacyJob = await mk("CSW Legacy");
  poReceiptJob = await mk("CSW PO receipt job");
  await prisma.visitAssignment.create({ data: { visitId: jobB, technicianId } });
  await prisma.visitAssignment.create({ data: { visitId: jobC, technicianId } });

  const draft = await prisma.priceBookDraftEstimate.create({ data: { title: "costing-switch draft", supplierId: "CSW-SUP" } });
  const estA = await signedEstimateFor(jobA, "A", draft.id, [
    { itemId: WIRE, description: "12-2 NM-B", quantity: 60, materialCost: 43.2 },
    { itemId: WIRE, description: "12-2 NM-B (second run)", quantity: 40, materialCost: 28.8 },
    { itemId: BOX, description: "4-square box", quantity: 4, materialCost: 4.4 },
  ]);
  estimateNumberA = estA.number;
  await signedEstimateFor(jobC, "C", draft.id, [{ itemId: WIRE, description: "12-2 NM-B", quantity: 25, materialCost: 18 }]);
});

afterAll(async () => {
  await wipeInventory();
  await cleanFixtures();
  await prisma.priceBookAtomic.deleteMany({ where: { itemId: { in: [WIRE, BOX] } } });
  await prisma.truck.update({ where: { id: truckId }, data: { technicianId: null } });
  await prisma.technician.delete({ where: { id: technicianId } });
});

describe("THE MATERIAL RULE — the P.O. is the money", () => {
  it("resolves to the P.O. money when there is any, else nothing — no other rung exists", () => {
    expect(resolveMaterialCost(43.2)).toEqual({ materialCost: 43.2, materialSource: "po" });
    expect(resolveMaterialCost(0)).toEqual({ materialCost: 0, materialSource: "po" });
    expect(resolveMaterialCost(null)).toEqual({ materialCost: 0, materialSource: "none" });
  });

  it("rollupJobCosts takes the money as its fourth argument and labels it", () => {
    const base = { estimatedCost: null, laborHours: 0, overheadAllocation: 0, revenue: 1000 };
    const costs = rollupJobCosts(base, null, 100, 43.2);
    expect(costs.materialCost).toBe(43.2);
    expect(costs.materialSource).toBe("po");
    expect(rollupJobCosts(base, null, 100, null).materialSource).toBe("none");
    expect(rollupJobCosts(base, null, 100).materialCost).toBe(0);
  });
});

describe("the roll — land 250 ft @0.72", () => {
  it("lands on the truck through a restock PO; the receipt on that PO is proof, never money", async () => {
    // A restock: no job on the PO. It has to STAY on the truck for jobs A, B and C to consume from it below.
    const po = await createPurchaseOrder({
      supplier: "Home Depot", openedBy: "owner", actor: "test", truckId,
      lines: [{ itemId: WIRE, name: "12-2 NM-B", qty: 250, unit: "ft" }],
    });
    // A receipt filed on a job, then attached to the PO: it proves the PO and charges nothing.
    const receipt = await prisma.receipt.create({
      data: { id: newId(), jobId: poReceiptJob, category: "materials", vendor: "CSW-test Home Depot", amount: 180, status: "confirmed", source: "manual" },
    });
    const attach = await request(app).post(`/purchase-orders/${po.id}/receipts/${receipt.id}`).send({});
    expect(attach.status).toBe(200);
    expect((await materialCostForJobs([{ visitId: poReceiptJob }])).get(poReceiptJob)).toMatchObject({ materialCost: 0, materialSource: "none" });

    const lineId = (await prisma.purchaseOrderLine.findFirstOrThrow({ where: { purchaseOrderId: po.id } })).id;
    await landPurchaseOrder(po.id, [{ lineId, qtyLanded: 250, unitCost: 0.72 }], "test");
    const l = await level(truckKey, WIRE);
    expect(l!.qtyOnHand).toBe(250);
    expect(l!.avgUnitCost).toBe(0.72);
  });

  it("GET /jobs/:id/materials suggests the signed estimate's taken lines, grouped, with on-hand beside each; the estimate is display only", async () => {
    const res = await request(app).get(`/jobs/${jobA}/materials`);
    expect(res.status).toBe(200);
    expect(res.body.truck.id).toBe(truckId);
    expect(res.body.estimate.number).toBe(estimateNumberA);
    const wire = res.body.suggested.find((s: { itemId: string }) => s.itemId === WIRE);
    expect(wire.qty).toBe(100); // 60 + 40, the same atomic twice on the estimate
    expect(wire.onHand).toBe(250);
    expect(wire.avgUnitCost).toBe(0.72);
    expect(wire.unit).toBe("ft");
    expect(wire.consumedQty).toBe(0);
    const box = res.body.suggested.find((s: { itemId: string }) => s.itemId === BOX);
    expect(box.qty).toBe(4);
    expect(box.onHand).toBe(0);
    // No P.O. money on job A yet: the estimate's $76.40 is shown, never charged.
    expect(res.body.materialSource).toBe("none");
    expect(res.body.materialCost).toBe(0);
    expect(res.body.estimateMaterial).toBe(76.4);
    expect(res.body.lines).toEqual([]);

    const onHand = await request(app).get(`/inventory/on-hand?itemIds=${WIRE},${BOX}`);
    expect(onHand.status).toBe(200);
    expect(onHand.body[WIRE]).toEqual({ qty: 250, unit: "ft", avgUnitCost: 0.72 });
    expect(onHand.body[BOX].qty).toBe(0);
  });

  it("job A consumes 60 → the ledger charges the truck 43.20; the job's cost is still its P.O. money, which arrives when a P.O. names it", async () => {
    const res = await request(app).post(`/jobs/${jobA}/consume`).send({
      lines: [{ itemId: WIRE, name: "12-2 NM-B", qty: 60, unit: "ft" }], reason: "Close-out",
    });
    expect(res.status).toBe(201);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].kind).toBe("consume");
    expect(res.body[0].fromLocationKey).toBe(truckKey);
    expect(res.body[0].jobId).toBe(jobA);
    expect(res.body[0].unitCost).toBe(0.72);
    expect(res.body[0].reason).toBe("Close-out");
    expect(res.body[0].actor).toBe("owner");
    expect((await level(truckKey, WIRE))!.qtyOnHand).toBe(190);

    const view = await request(app).get(`/jobs/${jobA}/materials`);
    // Inventory moved; cost did not — the consume is not money.
    expect(view.body.stock).toEqual({ consumed: 43.2, returned: 0, net: 43.2, movementCount: 1 });
    expect(view.body.lines[0].cost).toBe(43.2);
    expect(view.body.materialSource).toBe("none");
    expect(view.body.materialCost).toBe(0);
    expect(view.body.suggested.find((s: { itemId: string }) => s.itemId === WIRE).consumedQty).toBe(60);

    // A P.O. tagged to job A with money typed on it IS the job's material.
    const po = await createPurchaseOrder({ supplier: "Home Depot", openedBy: "owner", actor: "test", truckId, jobId: jobA });
    await setPurchaseOrderMoney(po.id, { offCardAmount: 55, offCardMethod: "cash" }, { actor: "test", reason: "Paid cash" });
    const after = await request(app).get(`/jobs/${jobA}/materials`);
    expect(after.body.materialSource).toBe("po");
    expect(after.body.materialCost).toBe(55);
    expect(after.body.po).toEqual({ card: 0, typed: 55, net: 55, poCount: 1 });
  });

  it("job B consumes 100 from the field → 72.00 off the truck; returns 10 → 64.80; truck 100; none of it is cost", async () => {
    const consume = await request(app)
      .post(`/health-record/visits/${jobB}/consume`)
      .set("Authorization", `Bearer ${techToken}`)
      .send({ lines: [{ itemId: WIRE, qty: 100 }] });
    expect(consume.status).toBe(201);
    expect(consume.body.data[0].unitCost).toBe(0.72);
    expect(consume.body.data[0].actor).toBe("tech:CSW Test Tech");
    expect(consume.body.data[0].name).toBe("12-2 NM-B"); // the truck's level names it when the line does not
    expect((await level(truckKey, WIRE))!.qtyOnHand).toBe(90);

    const ret = await request(app).post(`/jobs/${jobB}/return`).send({
      lines: [{ itemId: WIRE, qty: 10 }], reason: "Ten feet left on the roll",
    });
    expect(ret.status).toBe(201);
    expect(ret.body[0].kind).toBe("return");
    expect(ret.body[0].toLocationKey).toBe(truckKey);
    expect(ret.body[0].unitCost).toBe(0.72);
    expect(ret.body[0].reason).toBe("Ten feet left on the roll");
    expect((await level(truckKey, WIRE))!.qtyOnHand).toBe(100);

    // The legacy job: the 2026-09-19 migration gave its receipt-rung figure a closed P.O. of its own.
    await prisma.purchaseOrder.create({
      data: {
        number: "PO-CSW-LEGACY", purpose: "truck_stock", destinationType: "truck", truckId, jobId: legacyJob, supplier: "SiteOne",
        status: "closed", openedBy: "system", afterTheFact: true, offCardAmount: 381.9, offCardMethod: "unknown", offCardAt: new Date(),
      },
    });
    const costs = await materialCostForJobs([{ visitId: jobA }, { visitId: jobB }, { visitId: legacyJob }]);
    expect(costs.get(jobA)).toMatchObject({ materialCost: 55, materialSource: "po" });
    expect(costs.get(jobB)).toMatchObject({ materialCost: 0, materialSource: "none", po: null });
    expect(costs.get(legacyJob)).toMatchObject({ materialCost: 381.9, materialSource: "po", po: { card: 0, typed: 381.9, net: 381.9, poCount: 1 } });

    // The field view: the tech's truck, the job's lines, no negative override.
    const view = await request(app).get(`/health-record/visits/${jobB}/materials`).set("Authorization", `Bearer ${techToken}`);
    expect(view.status).toBe(200);
    expect(view.body.data.materialCost).toBe(0);
    expect(view.body.data.materialSource).toBe("none");
    expect(view.body.data.stock).toEqual({ consumed: 72, returned: 7.2, net: 64.8, movementCount: 2 });
    expect(view.body.data.lines.map((l: { kind: string }) => l.kind)).toEqual(["consume", "return"]);
    const notMine = await request(app).get(`/health-record/visits/${jobA}/materials`).set("Authorization", `Bearer ${techToken}`);
    expect(notMine.status).toBe(403);
  });

  it("Financials: the Materials card is the ledger — bought 180 (the landing) / used 108 / inventory value 72.00", async () => {
    const now = new Date();
    const year = now.getFullYear();
    const res = await request(app).get(`/financials/materials?year=${year}`);
    expect(res.status).toBe(200);
    const month = res.body.months[now.getMonth()];
    expect(month.bought).toBe(180); // 250 ft × 0.72 landed; receipts add nothing
    expect(month.used).toBe(108); // 43.20 + 72.00 − 7.20
    expect(month.inventoryValue).toBe(72); // 100 ft × 0.72
    expect(res.body.totals.used).toBe(108);

    const summary = await request(app).get(`/financials/summary?year=${year}`);
    expect(summary.status).toBe(200);
    expect(summary.body.materials.months[now.getMonth()]).toEqual(month);
  });

  it("GET /jobs, the account summary and job-profitability agree on a P.O.-costed job", async () => {
    const year = new Date().getFullYear();
    const [jobs, summary, profit] = await Promise.all([
      request(app).get("/jobs"),
      request(app).get(`/accounts/${customerId}/summary`),
      request(app).get(`/financials/job-profitability?year=${year}`),
    ]);
    expect(jobs.status).toBe(200);
    expect(summary.status).toBe(200);
    expect(profit.status).toBe(200);
    const fromJobs = jobs.body.find((j: { visitId: string }) => j.visitId === jobA);
    const fromSummary = summary.body.jobs.find((j: { visitId: string }) => j.visitId === jobA);
    const fromProfit = profit.body.find((j: { visitId: string }) => j.visitId === jobA);
    expect(fromJobs.costs.materialCost).toBe(55);
    expect(fromJobs.costs.materialSource).toBe("po");
    expect(fromSummary.costs).toEqual(fromJobs.costs);
    expect(fromProfit.materialSpend).toBe(55);
    expect(fromProfit.materialSource).toBe("po");
    // The legacy job keeps its figure through its legacy P.O.
    const legacy = summary.body.jobs.find((j: { visitId: string }) => j.visitId === legacyJob);
    expect(legacy.costs.materialCost).toBe(381.9);
    expect(legacy.costs.materialSource).toBe("po");
  });
});

describe("the truck is short", () => {
  it("409 names the item and the on-hand; allowNegative needs a reason, and the reason rides the movement", async () => {
    const short = await request(app).post(`/jobs/${jobA}/consume`).send({ lines: [{ itemId: WIRE, qty: 500 }] });
    expect(short.status).toBe(409);
    expect(short.body.error).toMatch(/Only 100 ft of 12-2 NM-B on hand/);
    expect(short.body.error).toMatch(/500 would go negative/);
    expect((await level(truckKey, WIRE))!.qtyOnHand).toBe(100);

    const noReason = await request(app).post(`/jobs/${jobA}/consume`).send({ lines: [{ itemId: BOX, qty: 2 }], allowNegative: true });
    expect(noReason.status).toBe(400);
    expect(noReason.body.error).toMatch(/needs a reason/);

    const forced = await request(app).post(`/jobs/${jobA}/consume`).send({
      lines: [{ itemId: BOX, qty: 2 }], allowNegative: true, reason: "Boxes on the truck, count is behind",
    });
    expect(forced.status).toBe(201);
    expect(forced.body[0].reason).toBe("Boxes on the truck, count is behind");
    expect(forced.body[0].name).toBe("CSW 4-square box"); // the book names an item the truck never held
    expect((await level(truckKey, BOX))!.qtyOnHand).toBe(-2);

    // The field has no override: the same short consume is refused with the item named.
    const field = await request(app)
      .post(`/health-record/visits/${jobB}/consume`)
      .set("Authorization", `Bearer ${techToken}`)
      .send({ lines: [{ itemId: WIRE, qty: 500 }], allowNegative: true, reason: "not allowed from here" });
    expect(field.status).toBe(409);
    expect(field.body.error.message).toMatch(/12-2 NM-B/);
  });
});

describe("close-out", () => {
  it("warns (never blocks) when a signed estimate has material lines and nothing was consumed — the truck count, not the cost", async () => {
    const first = await request(app).post(`/jobs/${jobC}/complete`).send({});
    expect(first.status).toBe(200);
    expect(first.body.warnings.some((w: string) => /No materials recorded from truck stock/.test(w))).toBe(true);
    await request(app).post(`/jobs/${jobC}/reopen`).send({});

    const consume = await request(app)
      .post(`/health-record/visits/${jobC}/consume`)
      .set("Authorization", `Bearer ${techToken}`)
      .send({ lines: [{ itemId: WIRE, qty: 25 }] });
    expect(consume.status).toBe(201);
    const again = await request(app).post(`/jobs/${jobC}/complete`).send({});
    expect(again.status).toBe(200);
    expect(again.body.warnings.some((w: string) => /No materials recorded/.test(w))).toBe(false);
  });
});
