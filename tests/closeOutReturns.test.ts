/**
 * The close-out count — "What came back?" (Kyle, 2026-09-15).
 *
 * "All items on a P.O. should land automatically on the job it was bought
 * for. Left over material gets counted to the truck or warehouse once the
 * job is marked complete." Unit 3 shipped the auto-charge at landing; this is
 * the return half — returnForJob (services/jobMaterials.ts) now accepts a
 * warehouse destination as well as a truck, and refuses a return that would
 * take a job's outstanding balance for an item negative. Completion itself
 * (POST /jobs/:id/complete) carries NO gate — Kyle's standing rule
 * (client/src/components/JobCloseoutPanel.tsx:7-11): "We do not want to lock
 * ourselves out of closing a job."
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
import { defaultTruckId } from "../src/services/purchaseOrders";
import { WAREHOUSE_KEY, applyMovement, truckLocationKey } from "../src/services/inventory";

const newId = () => crypto.randomUUID().replaceAll("-", "");
const r2 = (n: number) => Math.round(n * 100) / 100;

const WIRE = "COR-WIRE";

let truckId: string;
let truckKey: string;
let customerId: string;
let propertyId: string;
let jobTruckReturn: string;
let jobWarehouseReturn: string;
let jobNoCount: string;
let jobOverrun: string;

const level = (locationKey: string, itemId: string) =>
  prisma.stockLevel.findUnique({ where: { locationKey_itemId: { locationKey, itemId } } });

async function wipeInventory() {
  await prisma.stockMovement.deleteMany({ where: { itemId: WIRE } });
  await prisma.stockLevel.deleteMany({ where: { itemId: WIRE } });
}

beforeAll(async () => {
  await wipeInventory();
  truckId = await defaultTruckId();
  truckKey = truckLocationKey(truckId);
  await prisma.priceBookAtomic.deleteMany({ where: { itemId: WIRE } });
  await prisma.priceBookAtomic.create({ data: { itemId: WIRE, description: "COR 12-2 NM-B", unit: "ft", purchasePrice: 2 } });

  const customer = await prisma.customer.create({ data: { name: "Close-Out Returns Co", phone: "+16155507788" } });
  customerId = customer.id;
  const property = await prisma.property.create({
    data: { customerId, name: "Count House", addressLine1: "9 Tally Ln", city: "Franklin", state: "TN", postalCode: "37064" },
  });
  propertyId = property.id;
  const mk = async (jobType: string) =>
    (await prisma.visit.create({
      data: { customerId, propertyId, mode: "onsite", purpose: jobType, jobType, status: "in_progress", visitDate: new Date() },
    })).id;
  jobTruckReturn = await mk("COR truck return");
  jobWarehouseReturn = await mk("COR warehouse return");
  jobNoCount = await mk("COR no count");
  jobOverrun = await mk("COR overrun");

  // Land 300 ft @ $2.00 on the truck — enough for every job below to draw from.
  await applyMovement(prisma, { kind: "purchase_in", itemId: WIRE, name: "12-2 NM-B", unit: "ft", qty: 300, unitCost: 2, toLocationKey: truckKey, actor: "test" });
});

afterAll(async () => {
  await wipeInventory();
  await prisma.stockLevel.deleteMany({ where: { itemId: WIRE, locationKey: WAREHOUSE_KEY } });
  await prisma.priceBookAtomic.deleteMany({ where: { itemId: WIRE } });
  await prisma.visitAssignment.deleteMany({ where: { visit: { customerId } } });
  await prisma.visit.deleteMany({ where: { customerId } });
  await prisma.property.deleteMany({ where: { customerId } });
  await prisma.customer.delete({ where: { id: customerId } });
});

describe("the close-out count", () => {
  it("counting leftovers back to the truck credits the ledger at the charged cost — the job's cost is its P.O. money, untouched", async () => {
    const consume = await request(app).post(`/jobs/${jobTruckReturn}/consume`).send({
      lines: [{ itemId: WIRE, name: "12-2 NM-B", qty: 50, unit: "ft" }], reason: "Materials used",
    });
    expect(consume.status).toBe(201);
    const before = await request(app).get(`/jobs/${jobTruckReturn}/materials`);
    expect(before.body.stock.net).toBe(100); // 50 * 2.00 off the truck — inventory, not cost (2026-09-19)
    expect(before.body.materialCost).toBe(0); // no P.O. money on this job

    const ret = await request(app).post(`/jobs/${jobTruckReturn}/return`).send({
      lines: [{ itemId: WIRE, qty: 20, unit: "ft" }], reason: "Job close-out count",
    });
    expect(ret.status).toBe(201);
    expect(ret.body[0].kind).toBe("return");
    expect(ret.body[0].toLocationKey).toBe(truckKey);
    expect(ret.body[0].unitCost).toBe(2); // credited at the cost the job was charged, not a re-averaged truck price

    expect((await level(truckKey, WIRE))!.qtyOnHand).toBeGreaterThanOrEqual(20);
    const after = await request(app).get(`/jobs/${jobTruckReturn}/materials`);
    expect(after.body.stock).toEqual({ consumed: 100, returned: 40, net: 60, movementCount: 2 }); // 100 − (20 * 2.00)
    expect(after.body.materialCost).toBe(0);
  });

  it("counting leftovers back to the warehouse puts them in the warehouse, not the truck, and credits the job identically", async () => {
    const consume = await request(app).post(`/jobs/${jobWarehouseReturn}/consume`).send({
      lines: [{ itemId: WIRE, name: "12-2 NM-B", qty: 30, unit: "ft" }], reason: "Materials used",
    });
    expect(consume.status).toBe(201);
    const truckAfterConsume = (await level(truckKey, WIRE))!.qtyOnHand;
    const warehouseBefore = (await level(WAREHOUSE_KEY, WIRE))?.qtyOnHand ?? 0;

    const ret = await request(app).post(`/jobs/${jobWarehouseReturn}/return`).send({
      warehouse: true, lines: [{ itemId: WIRE, qty: 10, unit: "ft" }], reason: "Job close-out count",
    });
    expect(ret.status).toBe(201);
    expect(ret.body[0].kind).toBe("return");
    expect(ret.body[0].toLocationKey).toBe(WAREHOUSE_KEY);
    expect(ret.body[0].unitCost).toBe(2); // same charged-cost credit as the truck case

    expect((await level(WAREHOUSE_KEY, WIRE))!.qtyOnHand).toBe(warehouseBefore + 10);
    expect((await level(truckKey, WIRE))!.qtyOnHand).toBe(truckAfterConsume); // the truck did not move

    const after = await request(app).get(`/jobs/${jobWarehouseReturn}/materials`);
    expect(after.body.stock.net).toBe(40); // 60 − (10 * 2.00), same formula as the truck case
  });

  it("marking a job complete with an un-done count still succeeds — a warning at most, never a block", async () => {
    const consume = await request(app).post(`/jobs/${jobNoCount}/consume`).send({
      lines: [{ itemId: WIRE, name: "12-2 NM-B", qty: 5, unit: "ft" }], reason: "Materials used",
    });
    expect(consume.status).toBe(201);
    // No return posted at all — the job still has 5 ft outstanding.
    const complete = await request(app).post(`/jobs/${jobNoCount}/complete`).send({});
    expect(complete.status).toBe(200);
    const visit = await prisma.visit.findUniqueOrThrow({ where: { id: jobNoCount } });
    expect(visit.status).toBe("completed");
  });

  it("returning more than was taken is refused", async () => {
    const consume = await request(app).post(`/jobs/${jobOverrun}/consume`).send({
      lines: [{ itemId: WIRE, name: "12-2 NM-B", qty: 5, unit: "ft" }], reason: "Materials used",
    });
    expect(consume.status).toBe(201);
    const truckBefore = (await level(truckKey, WIRE))!.qtyOnHand;

    const overReturn = await request(app).post(`/jobs/${jobOverrun}/return`).send({
      lines: [{ itemId: WIRE, qty: 10, unit: "ft" }], reason: "Job close-out count",
    });
    expect(overReturn.status).toBe(409);
    expect(overReturn.body.error).toMatch(/only has 5 ft outstanding/);

    // Refused — nothing moved.
    expect((await level(truckKey, WIRE))!.qtyOnHand).toBe(truckBefore);
    const after = await request(app).get(`/jobs/${jobOverrun}/materials`);
    expect(after.body.stock.net).toBe(10); // unchanged: 5 * 2.00
  });
});
