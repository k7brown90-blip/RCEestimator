/**
 * The PO becomes a real document (Kyle, 2026-09-09: "Purchasing needs to start
 * with a P.O. number then the purchase and photo verification of the receipt").
 *
 * Numbers are PO-YYYY-NNNN, unique, assigned at creation, never reused; the
 * status chain is enforced; attaching a receipt is the verification and keeps
 * the job's material rolling; every edit leaves a reason in the trail.
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

const newId = () => crypto.randomUUID().replaceAll("-", "");
const jpg = Buffer.from("ffd8ffe000104a464946", "hex");

let customerId: string;
let jobId: string;
let technicianId: string;
let techToken: string;
let truckId: string;

const stamped = async (id: string) =>
  (await prisma.visit.findUniqueOrThrow({ where: { id }, select: { actualMaterialCost: true } })).actualMaterialCost;

beforeAll(async () => {
  // A clean counter and no leftover POs — numbering assertions need a known start.
  await prisma.receipt.updateMany({ where: { purchaseOrderId: { not: null } }, data: { purchaseOrderId: null } });
  await prisma.purchaseOrder.deleteMany();
  await prisma.purchaseOrderCounter.deleteMany();
  truckId = await defaultTruckId();

  const customer = await prisma.customer.create({ data: { name: "PO Customer", phone: "+16155508888" } });
  customerId = customer.id;
  const property = await prisma.property.create({
    data: { customerId, name: "PO House", addressLine1: "1 Purchase Ln", city: "Smyrna", state: "TN", postalCode: "37167" },
  });
  const visit = await prisma.visit.create({
    data: { customerId, propertyId: property.id, mode: "onsite", purpose: "PO job", jobType: "Service", status: "in_progress", visitDate: new Date() },
  });
  jobId = visit.id;

  const tech = await prisma.technician.create({
    data: { name: "PO Test Tech", accessToken: `po-test-${newId()}` },
  });
  technicianId = tech.id;
  techToken = tech.accessToken;
  await prisma.visitAssignment.create({ data: { visitId: jobId, technicianId } });
});

afterAll(async () => {
  await prisma.receipt.deleteMany({ where: { OR: [{ jobId }, { vendor: { startsWith: "PO-test" } }] } });
  await prisma.purchaseOrder.deleteMany();
  await prisma.purchaseOrderCounter.deleteMany();
  await prisma.visitAssignment.deleteMany({ where: { visitId: jobId } });
  await prisma.technician.deleteMany({ where: { id: technicianId } });
  await prisma.visit.deleteMany({ where: { customerId } });
  await prisma.property.deleteMany({ where: { customerId } });
  await prisma.customer.delete({ where: { id: customerId } });
});

const thisYear = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", year: "numeric" }).format(new Date()));

describe("PO numbers", () => {
  it("the first PO of a year is PO-YYYY-0001, truck stock on the default truck", async () => {
    const res = await request(app).post("/purchase-orders").send({ supplier: "Home Depot" });
    expect(res.status).toBe(201);
    expect(res.body.number).toBe(`PO-${thisYear}-0001`);
    expect(res.body.purpose).toBe("truck_stock");
    expect(res.body.destinationType).toBe("truck");
    expect(res.body.truckId).toBe(truckId);
    expect(res.body.truckName).toBe("Truck 1");
    expect(res.body.status).toBe("open");
  });

  it("five concurrent creates get five distinct sequential numbers", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        request(app).post("/purchase-orders").send({ supplier: `Concurrent ${i}`, purpose: "warehouse" }),
      ),
    );
    for (const r of results) expect(r.status).toBe(201);
    const numbers = results.map((r) => r.body.number as string).sort();
    expect(new Set(numbers).size).toBe(5);
    expect(numbers).toEqual([2, 3, 4, 5, 6].map((n) => `PO-${thisYear}-${String(n).padStart(4, "0")}`));
    // Warehouse POs land in the warehouse — no truck.
    expect(results[0].body.destinationType).toBe("warehouse");
    expect(results[0].body.truckId).toBeNull();
  });

  it("a second year starts back at 0001", async () => {
    const po = await createPurchaseOrder({
      supplier: "Next year", openedBy: "owner", actor: "test", openedAt: new Date(`${thisYear + 1}-03-01T12:00:00Z`),
    });
    expect(po.number).toBe(`PO-${thisYear + 1}-0001`);
    const again = await createPurchaseOrder({
      supplier: "Next year 2", openedBy: "owner", actor: "test", openedAt: new Date(`${thisYear + 1}-03-02T12:00:00Z`),
    });
    expect(again.number).toBe(`PO-${thisYear + 1}-0002`);
  });
});

describe("status chain", () => {
  it("open → purchased → verified → closed; closed is terminal", async () => {
    const created = await request(app).post("/purchase-orders").send({ supplier: "Chain" });
    const id = created.body.id as string;
    for (const to of ["purchased", "verified", "closed"]) {
      const r = await request(app).post(`/purchase-orders/${id}/status`).send({ to });
      expect(r.status, to).toBe(200);
      expect(r.body.status).toBe(to);
    }
    const back = await request(app).post(`/purchase-orders/${id}/status`).send({ to: "open" });
    expect(back.status).toBe(409);
    const cancelClosed = await request(app).post(`/purchase-orders/${id}/status`).send({ to: "cancelled", reason: "nope" });
    expect(cancelClosed.status).toBe(409);
    const events = await prisma.purchaseOrderEvent.findMany({ where: { purchaseOrderId: id, kind: "status" } });
    expect(events.length).toBe(3);
    const po = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id } });
    expect(po.purchasedAt).not.toBeNull();
    expect(po.verifiedAt).not.toBeNull();
    expect(po.closedAt).not.toBeNull();
  });

  it("cancel from open works (reason required); skipping steps is refused", async () => {
    const created = await request(app).post("/purchase-orders").send({ supplier: "Cancel me" });
    const id = created.body.id as string;
    const skip = await request(app).post(`/purchase-orders/${id}/status`).send({ to: "verified" });
    expect(skip.status).toBe(409);
    const noReason = await request(app).post(`/purchase-orders/${id}/status`).send({ to: "cancelled" });
    expect(noReason.status).toBe(400);
    const cancelled = await request(app).post(`/purchase-orders/${id}/status`).send({ to: "cancelled", reason: "Store was out" });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe("cancelled");
  });
});

describe("attaching a receipt", () => {
  it("copies the PO's job onto a jobless receipt, re-rolls the job, moves the PO to purchased, and writes the event", async () => {
    const created = await request(app).post("/purchase-orders").send({ supplier: "Lowes", jobId });
    expect(created.status).toBe(201);
    const poId = created.body.id as string;
    expect(created.body.jobId).toBe(jobId);

    const before = await stamped(jobId);
    const receipt = await prisma.receipt.create({
      data: { id: newId(), category: "materials", vendor: "PO-test Lowes", amount: 150.25, status: "confirmed", source: "manual" },
    });
    const attach = await request(app).post(`/purchase-orders/${poId}/receipts/${receipt.id}`).send({});
    expect(attach.status).toBe(200);
    expect(attach.body.jobId).toBe(jobId);

    const after = await prisma.receipt.findUniqueOrThrow({ where: { id: receipt.id } });
    expect(after.purchaseOrderId).toBe(poId);
    expect(after.jobId).toBe(jobId);
    expect(await stamped(jobId)).toBe(Math.round(((before ?? 0) + 150.25) * 100) / 100);

    const po = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: poId } });
    expect(po.status).toBe("purchased");
    const events = await prisma.purchaseOrderEvent.findMany({ where: { purchaseOrderId: poId }, orderBy: { at: "asc" } });
    expect(events.map((e) => e.kind)).toEqual(["created", "receipt_attached", "status"]);

    // The detail endpoint shows the receipt and the trail; the review queue shows the PO number.
    const detail = await request(app).get(`/purchase-orders/${poId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.receipts.map((r: { id: string }) => r.id)).toEqual([receipt.id]);
    expect(detail.body.events.length).toBe(3);

    // Detach puts it back on the needs-PO list.
    const detach = await request(app).delete(`/purchase-orders/${poId}/receipts/${receipt.id}`);
    expect(detach.status).toBe(204);
    const needing = await request(app).get("/receipts-needing-po");
    expect(needing.status).toBe(200);
    expect(needing.body.some((r: { id: string; needsPo: boolean }) => r.id === receipt.id && r.needsPo)).toBe(true);

    // And the admin receipt PATCH routes purchaseOrderId through the same attach.
    const patched = await request(app).patch(`/health-record-admin/receipts/${receipt.id}`).send({ purchaseOrderId: poId });
    expect(patched.status).toBe(200);
    expect(patched.body.purchaseOrderId).toBe(poId);
  });

  it("the account summary and job PO list carry number, purpose and status", async () => {
    const summary = await request(app).get(`/accounts/${customerId}/summary`);
    expect(summary.status).toBe(200);
    const job = summary.body.jobs.find((j: { visitId: string }) => j.visitId === jobId);
    expect(job.purchaseOrders[0].number).toMatch(/^PO-\d{4}-\d{4}$/);
    expect(job.purchaseOrders[0].purpose).toBe("truck_stock");
    expect(job.purchaseOrders[0].status).toBe("purchased");
    expect(job.receipts[0].purchaseOrderNumber).toBe(job.purchaseOrders[0].number);

    const list = await request(app).get(`/jobs/${jobId}/purchase-orders`);
    expect(list.status).toBe(200);
    expect(list.body[0].number).toBe(job.purchaseOrders[0].number);
    expect(list.body[0].receiptCount).toBe(1);
  });
});

describe("the edit trail", () => {
  it("PATCH with a reason writes an edited event with before/after; without a reason is 400", async () => {
    const created = await request(app).post("/purchase-orders").send({
      supplier: "Typo Supply", lines: [{ name: "12-2 NM-B 250ft", qty: 2, unit: "roll" }],
    });
    const id = created.body.id as string;
    const noReason = await request(app).patch(`/purchase-orders/${id}`).send({ supplier: "ASD Lighting" });
    expect(noReason.status).toBe(400);

    const fixed = await request(app).patch(`/purchase-orders/${id}`).send({ supplier: "ASD Lighting", reason: "Wrong supplier keyed" });
    expect(fixed.status).toBe(200);
    expect(fixed.body.supplier).toBe("ASD Lighting");
    const edited = await prisma.purchaseOrderEvent.findFirst({ where: { purchaseOrderId: id, kind: "edited" } });
    expect(edited).not.toBeNull();
    expect(edited!.reason).toBe("Wrong supplier keyed");
    expect(JSON.parse(edited!.before!)).toEqual({ supplier: "Typo Supply" });
    expect(JSON.parse(edited!.after!)).toEqual({ supplier: "ASD Lighting" });

    // Lines: edit needs a reason, remove needs a reason, add records an event.
    const lineId = created.body.lines[0].id as string;
    const lineNoReason = await request(app).patch(`/purchase-orders/${id}/lines/${lineId}`).send({ qty: 3 });
    expect(lineNoReason.status).toBe(400);
    const lineFixed = await request(app).patch(`/purchase-orders/${id}/lines/${lineId}`).send({ qty: 3, reason: "Needed one more" });
    expect(lineFixed.status).toBe(200);
    expect(lineFixed.body.qty).toBe(3);
    const added = await request(app).post(`/purchase-orders/${id}/lines`).send({ name: "Staples", qty: 1, unit: "box" });
    expect(added.status).toBe(201);
    const removed = await request(app).delete(`/purchase-orders/${id}/lines/${added.body.id}`).send({ reason: "Had some on the truck" });
    expect(removed.status).toBe(204);
    const kinds = (await prisma.purchaseOrderEvent.findMany({ where: { purchaseOrderId: id }, orderBy: { at: "asc" } })).map((e) => e.kind);
    expect(kinds).toEqual(["created", "edited", "line_edited", "line_added", "line_removed"]);
  });
});

describe("the field app", () => {
  it("POST /visits/:id/purchase-orders returns a number, defaults truck stock on the default truck, opened by the tech", async () => {
    const res = await request(app)
      .post(`/health-record/visits/${jobId}/purchase-orders`)
      .set("Authorization", `Bearer ${techToken}`)
      .send({ supplier: "Nashville Electric Supply", items: [{ name: "200A panel", qty: 1 }] });
    expect(res.status).toBe(201);
    expect(res.body.data.number).toMatch(/^PO-\d{4}-\d{4}$/);
    expect(res.body.data.purpose).toBe("truck_stock");
    expect(res.body.data.status).toBe("open");
    const po = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: res.body.data.id } });
    expect(po.truckId).toBe(truckId);
    expect(po.jobId).toBe(jobId);
    expect(po.openedBy).toBe("tech");
    expect(po.openedByTechnicianId).toBe(technicianId);

    // The tech's purchases list carries it, with lines and receipt count.
    const mine = await request(app).get("/health-record/purchase-orders").set("Authorization", `Bearer ${techToken}`);
    expect(mine.status).toBe(200);
    const row = mine.body.data.orders.find((o: { id: string }) => o.id === po.id);
    expect(row.items).toEqual([{ name: "200A panel", qty: 1 }]);
    expect(row.receiptCount).toBe(0);

    // A receipt photo for this PO attaches it and moves the PO to purchased.
    const upload = await request(app)
      .put(`/health-record/receipts/${newId()}?purchaseOrderId=${po.id}&amount=412.10&vendor=PO-test%20NES&category=materials`)
      .set("Authorization", `Bearer ${techToken}`)
      .set("Content-Type", "image/jpeg")
      .send(jpg);
    expect(upload.status).toBe(201);
    expect(upload.body.data.purchaseOrderNumber).toBe(po.number);
    const receipt = await prisma.receipt.findUniqueOrThrow({ where: { id: upload.body.data.id } });
    expect(receipt.purchaseOrderId).toBe(po.id);
    expect(receipt.jobId).toBe(jobId); // inherited from the PO
    expect((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } })).status).toBe("purchased");

    // Purchased → verified from the phone; a job-less purchase also works.
    const verified = await request(app)
      .post(`/health-record/purchase-orders/${po.id}/status`).set("Authorization", `Bearer ${techToken}`).send({ to: "verified" });
    expect(verified.status).toBe(200);
    expect(verified.body.data.status).toBe("verified");
    const standalone = await request(app)
      .post("/health-record/purchase-orders").set("Authorization", `Bearer ${techToken}`).send({ supplier: "Harbor Freight", purpose: "tool" });
    expect(standalone.status).toBe(201);
    expect(standalone.body.data.purpose).toBe("tool");
  });

  it("closing the job warns about a materials receipt with no PO — never blocks", async () => {
    await prisma.receipt.create({
      data: { id: newId(), jobId, category: "materials", vendor: "PO-test loose", amount: 9.99, status: "confirmed", source: "manual" },
    });
    const res = await request(app).post(`/jobs/${jobId}/complete`).send({});
    expect(res.status).toBe(200);
    expect(res.body.completed).toBe(true);
    expect(res.body.warnings.some((w: string) => /materials receipt\(s\) on this job have no PO/.test(w))).toBe(true);
  });
});
