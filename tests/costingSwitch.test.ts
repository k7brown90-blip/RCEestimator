/**
 * Build 4 — the costing switch (Kyle, 2026-09-09).
 *
 * "On future jobs I can label some stock as truckstock and it won't double
 * count the cost." Materials land on a truck or in the warehouse, never on a
 * job. A job is charged ONLY when stock is consumed from a truck, at the
 * truck's moving-average unit cost; each unit is charged once. THE MATERIAL
 * RULE, four rungs: stock → receipts (not on a PO) → the signed estimate's
 * frozen material → none. GET /jobs, the account summary and
 * /financials/job-profitability all go through materialCostForJobs, so they
 * cannot disagree. Legacy jobs (receipts with no PO) do not move.
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
import { landPurchaseOrder, truckLocationKey } from "../src/services/inventory";
import { materialCostForJobs, resolveMaterialCost, rollupJobCosts } from "../src/services/jobCosting";
import { applyReceiptReroll, planReceiptReroll, rerollJobMaterialCost } from "../src/services/receiptCosting";

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
let poNumberForReceipt: string;

async function wipeInventory() {
  await prisma.stockMovement.deleteMany();
  await prisma.stockLevel.deleteMany();
  await prisma.toolMovement.deleteMany();
  await prisma.tool.deleteMany();
  await prisma.stockRequest.deleteMany();
  await prisma.receipt.updateMany({ where: { purchaseOrderId: { not: null } }, data: { purchaseOrderId: null } });
  await prisma.receipt.deleteMany({ where: { vendor: { startsWith: "CSW-test" } } });
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

describe("THE MATERIAL RULE — precedence", () => {
  it("stock beats receipts beats the estimate; a zero actual means nothing recorded", () => {
    expect(resolveMaterialCost(43.2, 500, 900)).toEqual({ materialCost: 43.2, materialSource: "stock" });
    expect(resolveMaterialCost(0, 500, 900)).toEqual({ materialCost: 0, materialSource: "stock" });
    expect(resolveMaterialCost(null, 381.9, 900)).toEqual({ materialCost: 381.9, materialSource: "receipts" });
    expect(resolveMaterialCost(null, 0, 900)).toEqual({ materialCost: 900, materialSource: "estimate" });
    expect(resolveMaterialCost(null, null, 900)).toEqual({ materialCost: 900, materialSource: "estimate" });
    expect(resolveMaterialCost(null, 0, null)).toEqual({ materialCost: 0, materialSource: "none" });
    expect(resolveMaterialCost(null, null, null)).toEqual({ materialCost: 0, materialSource: "none" });
  });

  it("rollupJobCosts takes the stock rung as its fifth argument and labels it", () => {
    const base = { estimatedCost: null, laborHours: 0, overheadAllocation: 0, revenue: 1000 };
    const costs = rollupJobCosts({ ...base, actualMaterialCost: 212.4 }, null, 100, 572.84, 43.2);
    expect(costs.materialCost).toBe(43.2);
    expect(costs.materialSource).toBe("stock");
    // Legacy: no stock rung → exactly what it was before this build.
    expect(rollupJobCosts({ ...base, actualMaterialCost: 212.4 }, null, 100, 572.84, null).materialSource).toBe("receipts");
    expect(rollupJobCosts({ ...base, actualMaterialCost: 212.4 }, null, 100, 572.84).materialCost).toBe(212.4);
  });
});

describe("the roll — land 250 ft @0.72", () => {
  it("lands on the truck through a PO; the receipt on that PO is inventory, not job cost", async () => {
    const po = await createPurchaseOrder({
      supplier: "Home Depot", openedBy: "owner", actor: "test", truckId, jobId: poReceiptJob,
      lines: [{ itemId: WIRE, name: "12-2 NM-B", qty: 250, unit: "ft" }],
    });
    poNumberForReceipt = po.number;
    // A receipt on the PO, on the job the PO was opened from. Pre-build this was
    // stamped straight onto the job; now it is the roll's landing that carries it.
    const receipt = await prisma.receipt.create({
      data: { id: newId(), jobId: poReceiptJob, category: "materials", vendor: "CSW-test Home Depot", amount: 180, status: "confirmed", source: "manual" },
    });
    const attach = await request(app).post(`/purchase-orders/${po.id}/receipts/${receipt.id}`).send({});
    expect(attach.status).toBe(200);
    expect((await prisma.visit.findUniqueOrThrow({ where: { id: poReceiptJob } })).actualMaterialCost).toBe(0);

    const lineId = (await prisma.purchaseOrderLine.findFirstOrThrow({ where: { purchaseOrderId: po.id } })).id;
    await landPurchaseOrder(po.id, [{ lineId, qtyLanded: 250, unitCost: 0.72 }], "test");
    const l = await level(truckKey, WIRE);
    expect(l!.qtyOnHand).toBe(250);
    expect(l!.avgUnitCost).toBe(0.72);
  });

  it("GET /jobs/:id/materials suggests the signed estimate's taken lines, grouped, with on-hand beside each", async () => {
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
    // Nothing consumed yet: the estimate rung carries the card.
    expect(res.body.materialSource).toBe("estimate");
    expect(res.body.materialCost).toBe(76.4);
    expect(res.body.lines).toEqual([]);

    const onHand = await request(app).get(`/inventory/on-hand?itemIds=${WIRE},${BOX}`);
    expect(onHand.status).toBe(200);
    expect(onHand.body[WIRE]).toEqual({ qty: 250, unit: "ft", avgUnitCost: 0.72 });
    expect(onHand.body[BOX].qty).toBe(0);
  });

  it("job A consumes 60 → 43.20 at the truck's average; truck 190", async () => {
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
    expect(view.body.materialSource).toBe("stock");
    expect(view.body.materialCost).toBe(43.2);
    expect(view.body.stock).toEqual({ consumed: 43.2, returned: 0, net: 43.2, movementCount: 1 });
    expect(view.body.lines[0].cost).toBe(43.2);
    expect(view.body.suggested.find((s: { itemId: string }) => s.itemId === WIRE).consumedQty).toBe(60);
  });

  it("job B consumes 100 from the field → 72.00; returns 10 → 64.80; truck 100", async () => {
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

    const costs = await materialCostForJobs([
      { visitId: jobA, actualMaterialCost: 0, estimatedMaterialCost: 76.4 },
      { visitId: jobB, actualMaterialCost: 0, estimatedMaterialCost: null },
      { visitId: legacyJob, actualMaterialCost: 381.9, estimatedMaterialCost: null },
    ]);
    expect(costs.get(jobA)).toMatchObject({ materialCost: 43.2, materialSource: "stock" });
    expect(costs.get(jobB)).toMatchObject({ materialCost: 64.8, materialSource: "stock", stock: { consumed: 72, returned: 7.2, net: 64.8, movementCount: 2 } });
    expect(costs.get(legacyJob)).toMatchObject({ materialCost: 381.9, materialSource: "receipts", stockMaterial: null });

    // The field view: the tech's truck, the job's lines, no negative override.
    const view = await request(app).get(`/health-record/visits/${jobB}/materials`).set("Authorization", `Bearer ${techToken}`);
    expect(view.status).toBe(200);
    expect(view.body.data.materialCost).toBe(64.8);
    expect(view.body.data.lines.map((l: { kind: string }) => l.kind)).toEqual(["consume", "return"]);
    const notMine = await request(app).get(`/health-record/visits/${jobA}/materials`).set("Authorization", `Bearer ${techToken}`);
    expect(notMine.status).toBe(403);
  });

  it("Financials: the month shows bought 180 / used 108 / inventory value 72.00", async () => {
    const now = new Date();
    const year = now.getFullYear();
    const res = await request(app).get(`/financials/materials?year=${year}`);
    expect(res.status).toBe(200);
    const month = res.body.months[now.getMonth()];
    // Other suites may leave confirmed no-PO materials receipts in this month; they are "bought" too.
    const stray = await prisma.receipt.findMany({
      where: {
        status: "confirmed", category: "materials", purchaseOrderId: null,
        receivedAt: { gte: new Date(year, now.getMonth(), 1), lt: new Date(year, now.getMonth() + 1, 1) },
      },
      select: { amount: true },
    });
    const strayTotal = r2(stray.reduce((s, r) => s + r.amount, 0));
    expect(month.bought).toBe(r2(180 + strayTotal));
    expect(month.used).toBe(108); // 43.20 + 72.00 − 7.20
    expect(month.inventoryValue).toBe(72); // 100 ft × 0.72
    expect(res.body.totals.used).toBe(108);

    const summary = await request(app).get(`/financials/summary?year=${year}`);
    expect(summary.status).toBe(200);
    expect(summary.body.materials.months[now.getMonth()]).toEqual(month);
  });

  it("GET /jobs, the account summary and job-profitability agree on a stock-costed job", async () => {
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
    expect(fromJobs.costs.materialCost).toBe(43.2);
    expect(fromJobs.costs.materialSource).toBe("stock");
    expect(fromSummary.costs).toEqual(fromJobs.costs);
    expect(fromProfit.materialSpend).toBe(43.2);
    expect(fromProfit.materialSource).toBe("stock");
    // Legacy stays legacy: receipts with no PO, exactly what was stamped.
    const legacy = summary.body.jobs.find((j: { visitId: string }) => j.visitId === legacyJob);
    expect(legacy.costs.materialSource).toBe("none");
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
  it("warns (never blocks) when a signed estimate has material lines and nothing was consumed", async () => {
    const first = await request(app).post(`/jobs/${jobC}/complete`).send({});
    expect(first.status).toBe(200);
    expect(first.body.warnings).toContain("No materials recorded from truck stock — job material will fall back to receipts/estimate.");
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

describe("the backfill", () => {
  it("dry run lists only the job whose receipt is on a PO; apply changes only that one", async () => {
    // Legacy: a confirmed receipt with no PO, stamped the pre-build way.
    await prisma.receipt.create({
      data: { id: newId(), jobId: legacyJob, category: "materials", vendor: "CSW-test SiteOne", amount: 381.9, status: "confirmed", source: "manual" },
    });
    await rerollJobMaterialCost(legacyJob);
    expect((await prisma.visit.findUniqueOrThrow({ where: { id: legacyJob } })).actualMaterialCost).toBe(381.9);
    // The PO-receipt job, stamped the way production was before the rule (receipt + PO both counted).
    await prisma.visit.update({ where: { id: poReceiptJob }, data: { actualMaterialCost: 180 } });

    const plans = await planReceiptReroll();
    const legacy = plans.find((p) => p.jobId === legacyJob)!;
    expect(legacy.changes).toBe(false);
    expect(legacy.from).toBe(381.9);
    expect(legacy.to).toBe(381.9);
    expect(legacy.excluded).toEqual([]);
    const onPo = plans.find((p) => p.jobId === poReceiptJob)!;
    expect(onPo.changes).toBe(true);
    expect(onPo.from).toBe(180);
    expect(onPo.to).toBe(0);
    expect(onPo.excluded).toHaveLength(1);
    expect(onPo.excluded[0].amount).toBe(180);
    expect(onPo.excluded[0].purchaseOrderNumber).toBe(poNumberForReceipt);

    const written = await applyReceiptReroll(plans.filter((p) => p.jobId === legacyJob || p.jobId === poReceiptJob));
    expect(written).toEqual([poReceiptJob]);
    expect((await prisma.visit.findUniqueOrThrow({ where: { id: legacyJob } })).actualMaterialCost).toBe(381.9);
    expect((await prisma.visit.findUniqueOrThrow({ where: { id: poReceiptJob } })).actualMaterialCost).toBe(0);
  });
});
