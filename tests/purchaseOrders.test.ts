/**
 * The PO becomes a real document (Kyle, 2026-09-09: "Purchasing needs to start
 * with a P.O. number then the purchase and photo verification of the receipt").
 *
 * Numbers are PO-YYYY-NNNN, unique, assigned at creation, never reused; the
 * status chain is enforced; attaching a receipt is the proof; every edit
 * leaves a reason in the trail. Kyle, 2026-09-19 ("the P.O. is the money"):
 * the charge is the money, the receipt is proof — attaching or detaching a
 * receipt moves no cost figure; a charge on a P.O. tagged to a job is the
 * job's material, cancelled or not.
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
import { materialCostForJobs } from "../src/services/jobCosting";

const newId = () => crypto.randomUUID().replaceAll("-", "");
const jpg = Buffer.from("ffd8ffe000104a464946", "hex");

let customerId: string;
let jobId: string;
let technicianId: string;
let techToken: string;
let truckId: string;

/** THE MONEY on the job (Kyle, 2026-09-19): the P.O.s tagged to it. */
const costOf = async (id: string) => (await materialCostForJobs([{ visitId: id }])).get(id)!;

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
  await prisma.cardSpend.deleteMany({ where: { stripeCardId: "card_po_test" } });
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
    // Verified means the money is PROVED (Kyle, 2026-09-19) — the chain needs a
    // receipt with a file on it before it can reach verified.
    await prisma.receipt.create({
      data: { purchaseOrderId: id, category: "materials", vendor: "Chain", amount: 10, imageMime: "image/jpeg", imageData: Buffer.from([1]) },
    });
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

  it("verified is refused until a receipt with a file is on the P.O. (the charge is the money, the receipt is proof)", async () => {
    const created = await request(app).post("/purchase-orders").send({ supplier: "No proof yet" });
    const id = created.body.id as string;
    expect((await request(app).post(`/purchase-orders/${id}/status`).send({ to: "purchased" })).status).toBe(200);

    const bare = await request(app).post(`/purchase-orders/${id}/status`).send({ to: "verified" });
    expect(bare.status).toBe(409);
    expect(bare.body.error).toMatch(/no receipt yet/i);

    // An amount with no photo is not proof either.
    const amountOnly = await prisma.receipt.create({
      data: { purchaseOrderId: id, category: "materials", vendor: "No proof yet", amount: 25 },
    });
    expect((await request(app).post(`/purchase-orders/${id}/status`).send({ to: "verified" })).status).toBe(409);

    await prisma.receipt.update({
      where: { id: amountOnly.id },
      data: { imageMime: "application/pdf", imageData: Buffer.from([1]) },
    });
    const proved = await request(app).post(`/purchase-orders/${id}/status`).send({ to: "verified" });
    expect(proved.status).toBe(200);
    expect(proved.body.status).toBe("verified");
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

describe("the charge is the money, cancelled or not (Kyle, 2026-09-19)", () => {
  it("a card charge on a P.O. tagged to the job is the job's material; cancelling the P.O. moves no money (the Daughdrill $381.90)", async () => {
    // A dedicated job — the shared `jobId` above accumulates POs across other
    // tests in this file and its running total would make this fragile.
    const property = await prisma.property.create({
      data: { customerId, name: "Cancel PO House", addressLine1: "2 Purchase Ln", city: "Smyrna", state: "TN", postalCode: "37167" },
    });
    const visit = await prisma.visit.create({
      data: { customerId, propertyId: property.id, mode: "onsite", purpose: "Cancel PO job", jobType: "Service", status: "in_progress", visitDate: new Date() },
    });
    const cancelJobId = visit.id;

    const created = await request(app).post("/purchase-orders").send({ supplier: "PO-test SiteOne", jobId: cancelJobId });
    expect(created.status).toBe(201);
    const poId = created.body.id as string;
    expect((await costOf(cancelJobId)).materialSource).toBe("none");

    await prisma.cardSpend.create({
      data: { stripeTransactionId: `po_test_${newId()}`, stripeCardId: "card_po_test", kind: "materials", amount: 381.9, merchantName: "SiteOne Landscape Supp", purchaseOrderId: poId, occurredAt: new Date() },
    });
    expect(await costOf(cancelJobId)).toMatchObject({ materialCost: 381.9, materialSource: "po", po: { card: 381.9, typed: 0, net: 381.9, poCount: 1 } });

    // The receipt is proof: attaching it changes nothing about the figure.
    const receipt = await prisma.receipt.create({
      data: { id: newId(), jobId: cancelJobId, category: "materials", vendor: "PO-test SiteOne", amount: 381.9, status: "confirmed", source: "manual" },
    });
    const attach = await request(app).post(`/purchase-orders/${poId}/receipts/${receipt.id}`).send({});
    expect(attach.status).toBe(200);
    expect((await costOf(cancelJobId)).materialCost).toBe(381.9);

    // Cancel: the charge still happened. The only way off the job is to move
    // the charge to another P.O. or ignore it with a reason.
    const cancel = await request(app).post(`/purchase-orders/${poId}/status`).send({ to: "cancelled", reason: "Receipt photo lost" });
    expect(cancel.status).toBe(200);
    expect(cancel.body.status).toBe("cancelled");
    expect((await costOf(cancelJobId)).materialCost).toBe(381.9);
  });
});

describe("attaching a receipt", () => {
  it("copies the PO's job onto a jobless receipt, moves no money, moves the PO to purchased, and writes the event", async () => {
    const created = await request(app).post("/purchase-orders").send({ supplier: "Lowes", jobId });
    expect(created.status).toBe(201);
    const poId = created.body.id as string;
    expect(created.body.jobId).toBe(jobId);

    const before = (await costOf(jobId)).materialCost;
    const receipt = await prisma.receipt.create({
      data: { id: newId(), category: "materials", vendor: "PO-test Lowes", amount: 150.25, status: "confirmed", source: "manual" },
    });
    const attach = await request(app).post(`/purchase-orders/${poId}/receipts/${receipt.id}`).send({});
    expect(attach.status).toBe(200);
    expect(attach.body.jobId).toBe(jobId);

    const after = await prisma.receipt.findUniqueOrThrow({ where: { id: receipt.id } });
    expect(after.purchaseOrderId).toBe(poId);
    expect(after.jobId).toBe(jobId);
    // The receipt is proof, never money (Kyle, 2026-09-19).
    expect((await costOf(jobId)).materialCost).toBe(before);

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
    // Off the PO it still counts nothing — it never did.
    expect((await costOf(jobId)).materialCost).toBe(before);

    // And the admin receipt PATCH routes purchaseOrderId through the same attach.
    const patched = await request(app).patch(`/health-record-admin/receipts/${receipt.id}`).send({ purchaseOrderId: poId });
    expect(patched.status).toBe(200);
    expect(patched.body.purchaseOrderId).toBe(poId);
    expect((await costOf(jobId)).materialCost).toBe(before);
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

describe("PUT /purchase-orders/:id/receipts/:receiptId accepts PDFs (Unit R, 2026-09-17)", () => {
  // Root cause of the 2026-09-17 double-booked $765.74 Home Depot receipt:
  // this door parsed the body with express.raw({ type: "image/*" }), so a PDF
  // (application/pdf) silently failed to parse, hasImage read false, and the
  // row still saved with a 201 and no file. Fixed to capture every body and
  // refuse explicitly instead of dropping it.
  const pdfBytes = Buffer.from("%PDF-1.4\n%mock receipt pdf\n", "utf8");

  it("stores a PDF with imageMime application/pdf when the amount is typed, and skips Vision", async () => {
    const created = await request(app).post("/purchase-orders").send({ supplier: "PO-test PDF Depot", jobId });
    const poId = created.body.id as string;
    const receiptId = newId();
    const res = await request(app)
      .put(`/purchase-orders/${poId}/receipts/${receiptId}?vendor=PO-test%20PDF%20Depot&amount=765.74&category=materials`)
      .set("Content-Type", "application/pdf")
      .send(pdfBytes);
    expect(res.status).toBe(201);
    expect(res.body.amount).toBe(765.74);
    expect(res.body.parsed).toBe(false);
    const row = await prisma.receipt.findUniqueOrThrow({ where: { id: receiptId } });
    expect(row.imageMime).toBe("application/pdf");
    expect(row.status).toBe("confirmed");
    expect(Buffer.from(row.imageData!).equals(pdfBytes)).toBe(true);
  });

  it("no longer refuses a PDF with no typed amount — it attempts to read it like a photo (Unit 1, 2026-09-18)", async () => {
    // OPENAI_API_KEY is deleted for this whole test file, so parseReceiptImage
    // degrades to null exactly as it does for an unreadable photo — this test
    // pins that the PDF is no longer rejected outright with a 400. The actual
    // PDF-shape call to OpenAI and reconciliation logic are covered by
    // tests/receiptVisionPdf.test.ts, which stubs the HTTP call.
    //
    // Unit 2 correction (coordinator, 2026-09-18): when nothing on the receipt
    // backs the amount (no typed amount, and Vision read nothing), the row
    // must NOT land as a CONFIRMED $0 cost — it must be pending_review with a
    // reason, never silently a $0 that nobody looked at.
    const created = await request(app).post("/purchase-orders").send({ supplier: "PO-test PDF No Amount", jobId });
    const poId = created.body.id as string;
    const receiptId = newId();
    const res = await request(app)
      .put(`/purchase-orders/${poId}/receipts/${receiptId}?vendor=PO-test%20PDF%20No%20Amount&category=materials`)
      .set("Content-Type", "application/pdf")
      .send(pdfBytes);
    expect(res.status).toBe(201);
    expect(res.body.parsed).toBe(false);
    expect(res.body.amount).toBe(0);
    expect(res.body.note).toMatch(/could not be read/i);
    const row = await prisma.receipt.findUniqueOrThrow({ where: { id: receiptId } });
    expect(row.imageMime).toBe("application/pdf");
    expect(Buffer.from(row.imageData!).equals(pdfBytes)).toBe(true);
    expect(row.status).toBe("pending_review");
    expect(row.amount).toBe(0);
    expect(row.reconciliationNote).toMatch(/could not be read/i);
  });

  it("a file this door cannot store is refused (415), never a silent 201 — the 2026-09-17 defect", async () => {
    const created = await request(app).post("/purchase-orders").send({ supplier: "PO-test Bad File", jobId });
    const poId = created.body.id as string;
    const receiptId = newId();
    const res = await request(app)
      .put(`/purchase-orders/${poId}/receipts/${receiptId}?vendor=PO-test%20Bad%20File&amount=10&category=materials`)
      .set("Content-Type", "text/plain")
      .send(Buffer.from("not a receipt"));
    expect(res.status).toBe(415);
    expect(await prisma.receipt.findUnique({ where: { id: receiptId } })).toBeNull();
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

describe("field fix batch (2026-09-21) items 6 & 7 — cancel and receipt edits from the field", () => {
  let ffbVisitId: string;

  beforeAll(async () => {
    const property = await prisma.property.findFirstOrThrow({ where: { customerId } });
    const visit = await prisma.visit.create({
      data: { customerId, propertyId: property.id, mode: "onsite", purpose: "FFB PO test", jobType: "Service", status: "in_progress", visitDate: new Date() },
    });
    ffbVisitId = visit.id;
    await prisma.visitAssignment.create({ data: { visitId: ffbVisitId, technicianId } });
  });

  afterAll(async () => {
    await prisma.receipt.deleteMany({ where: { jobId: ffbVisitId } });
    await prisma.purchaseOrder.deleteMany({ where: { jobId: ffbVisitId } });
    await prisma.visitAssignment.deleteMany({ where: { visitId: ffbVisitId } });
    await prisma.visit.deleteMany({ where: { id: ffbVisitId } });
  });

  it("item 6 — cancels a PO from the field with a required reason", async () => {
    const created = await request(app)
      .post(`/health-record/visits/${ffbVisitId}/purchase-orders`)
      .set("Authorization", `Bearer ${techToken}`)
      .send({ supplier: "PO-test FFB Cancel", items: [{ name: "Breaker", qty: 1 }] });
    expect(created.status).toBe(201);
    const poId = created.body.data.id as string;

    const noReason = await request(app)
      .post(`/health-record/purchase-orders/${poId}/status`)
      .set("Authorization", `Bearer ${techToken}`)
      .send({ to: "cancelled" });
    expect(noReason.status).toBe(400);
    expect((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: poId } })).status).toBe("open");

    const cancelled = await request(app)
      .post(`/health-record/purchase-orders/${poId}/status`)
      .set("Authorization", `Bearer ${techToken}`)
      .send({ to: "cancelled", reason: "Wrong supplier" });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data.status).toBe("cancelled");
    expect((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: poId } })).status).toBe("cancelled");
  });

  it("item 6 — a PO opened by one tech is not another tech's to cancel", async () => {
    const other = await prisma.technician.create({ data: { name: "PO Test FFB Other Tech", accessToken: `po-test-ffb-other-${newId()}` } });
    const created = await request(app)
      .post(`/health-record/visits/${ffbVisitId}/purchase-orders`)
      .set("Authorization", `Bearer ${techToken}`)
      .send({ supplier: "PO-test FFB Scope", items: [{ name: "Wire", qty: 1 }] });
    const poId = created.body.data.id as string;

    const res = await request(app)
      .post(`/health-record/purchase-orders/${poId}/status`)
      .set("Authorization", `Bearer ${other.accessToken}`)
      .send({ to: "cancelled", reason: "not mine to cancel" });
    expect(res.status).toBe(403);
    expect((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: poId } })).status).toBe("open");

    await prisma.technician.deleteMany({ where: { id: other.id } });
  });

  it("item 7 — edits and removes a receipt on the field PO; a receipt is proof, never money", async () => {
    const created = await request(app)
      .post(`/health-record/visits/${ffbVisitId}/purchase-orders`)
      .set("Authorization", `Bearer ${techToken}`)
      .send({ supplier: "PO-test FFB Receipt Edit", items: [{ name: "Panel", qty: 1 }] });
    const poId = created.body.data.id as string;

    const upload = await request(app)
      .put(`/health-record/receipts/${newId()}?purchaseOrderId=${poId}&amount=88.10&vendor=PO-test%20FFB&category=materials`)
      .set("Authorization", `Bearer ${techToken}`)
      .set("Content-Type", "image/jpeg")
      .send(jpg);
    expect(upload.status).toBe(201);
    const receiptId = upload.body.data.id as string;

    const list = await request(app)
      .get(`/health-record/purchase-orders/${poId}/receipts`)
      .set("Authorization", `Bearer ${techToken}`);
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].amount).toBe(88.1);

    const costBefore = await costOf(ffbVisitId);

    const edited = await request(app)
      .patch(`/health-record/receipts/${receiptId}`)
      .set("Authorization", `Bearer ${techToken}`)
      .send({ vendor: "PO-test FFB Edited Vendor", amount: 91.5 });
    expect(edited.status).toBe(200);
    expect(edited.body.data.vendor).toBe("PO-test FFB Edited Vendor");
    expect(edited.body.data.amount).toBe(91.5);

    // A receipt is proof, never money: editing it moves no job-cost figure
    // (materialCostForJobs derives from card charges / typed off-card amounts
    // on the P.O., never the receipt row).
    expect(await costOf(ffbVisitId)).toEqual(costBefore);

    const removed = await request(app)
      .delete(`/health-record/receipts/${receiptId}`)
      .set("Authorization", `Bearer ${techToken}`);
    expect(removed.status).toBe(204);
    expect(await prisma.receipt.findUnique({ where: { id: receiptId } })).toBeNull();
    expect(await costOf(ffbVisitId)).toEqual(costBefore);
  });

  it("item 7 — a receipt on someone else's PO/visit is not this tech's to edit or remove", async () => {
    const other = await prisma.technician.create({ data: { name: "PO Test FFB Receipt Other Tech", accessToken: `po-test-ffb-recv-other-${newId()}` } });
    const created = await request(app)
      .post(`/health-record/visits/${ffbVisitId}/purchase-orders`)
      .set("Authorization", `Bearer ${techToken}`)
      .send({ supplier: "PO-test FFB Receipt Scope", items: [{ name: "Conduit", qty: 1 }] });
    const poId = created.body.data.id as string;
    const upload = await request(app)
      .put(`/health-record/receipts/${newId()}?purchaseOrderId=${poId}&amount=10&vendor=PO-test%20FFB&category=materials`)
      .set("Authorization", `Bearer ${techToken}`)
      .set("Content-Type", "image/jpeg")
      .send(jpg);
    const receiptId = upload.body.data.id as string;

    const patch = await request(app)
      .patch(`/health-record/receipts/${receiptId}`)
      .set("Authorization", `Bearer ${other.accessToken}`)
      .send({ amount: 5 });
    expect(patch.status).toBe(403);

    const del = await request(app)
      .delete(`/health-record/receipts/${receiptId}`)
      .set("Authorization", `Bearer ${other.accessToken}`);
    expect(del.status).toBe(403);
    expect(await prisma.receipt.findUnique({ where: { id: receiptId } })).not.toBeNull();

    await prisma.technician.deleteMany({ where: { id: other.id } });
  });
});

describe("waiving a receipt off the needs-PO queue (Unit 2, legacy purchase close-out, 2026-09-14)", () => {
  // A dedicated job so the shared `jobId`'s receipts from other tests stay out of the queue assertions.
  let waiveJobId: string;

  beforeAll(async () => {
    const property = await prisma.property.create({
      data: { customerId, name: "Waive PO House", addressLine1: "3 Purchase Ln", city: "Smyrna", state: "TN", postalCode: "37167" },
    });
    const visit = await prisma.visit.create({
      data: { customerId, propertyId: property.id, mode: "onsite", purpose: "Waive PO job", jobType: "Service", status: "in_progress", visitDate: new Date() },
    });
    waiveJobId = visit.id;
  });

  it("waiving removes the receipt from /receipts-needing-po but leaves purchaseOrderId null; no cost figure is involved", async () => {
    const receipt = await prisma.receipt.create({
      data: { id: newId(), jobId: waiveJobId, category: "materials", vendor: "PO-test Home Depot Womack", amount: 406.74, status: "confirmed", source: "manual" },
    });
    const before = (await costOf(waiveJobId)).materialCost;

    const needingBefore = await request(app).get("/receipts-needing-po");
    expect(needingBefore.body.some((r: { id: string }) => r.id === receipt.id)).toBe(true);

    const waive = await request(app).post(`/receipts/${receipt.id}/waive-po`).send({ reason: "Receipt photo lost in the 9/11 upload failure" });
    expect(waive.status).toBe(200);
    expect(waive.body.purchaseOrderId).toBeNull();
    expect(waive.body.poWaivedReason).toBe("Receipt photo lost in the 9/11 upload failure");

    const needingAfter = await request(app).get("/receipts-needing-po");
    expect(needingAfter.body.some((r: { id: string }) => r.id === receipt.id)).toBe(false);

    // No attach: purchaseOrderId stays null. (The Womack $406.74 itself lives on
    // a legacy P.O. as a typed amount since the 2026-09-19 migration.)
    const row = await prisma.receipt.findUniqueOrThrow({ where: { id: receipt.id } });
    expect(row.purchaseOrderId).toBeNull();
    expect(row.poWaivedAt).not.toBeNull();
    expect((await costOf(waiveJobId)).materialCost).toBe(before);
  });

  it("a waive with no reason, or a whitespace-only reason, is rejected 400 and writes nothing", async () => {
    const receipt = await prisma.receipt.create({
      data: { id: newId(), jobId: waiveJobId, category: "materials", vendor: "PO-test no reason", amount: 55, status: "confirmed", source: "manual" },
    });

    const missing = await request(app).post(`/receipts/${receipt.id}/waive-po`).send({});
    expect(missing.status).toBe(400);
    const whitespace = await request(app).post(`/receipts/${receipt.id}/waive-po`).send({ reason: "   " });
    expect(whitespace.status).toBe(400);

    const row = await prisma.receipt.findUniqueOrThrow({ where: { id: receipt.id } });
    expect(row.poWaivedAt).toBeNull();
    expect(row.poWaivedReason).toBeNull();

    const needing = await request(app).get("/receipts-needing-po");
    expect(needing.body.some((r: { id: string }) => r.id === receipt.id)).toBe(true);
  });

  it("refuses to waive a receipt already attached to a live PO", async () => {
    const created = await request(app).post("/purchase-orders").send({ supplier: "PO-test Waive Attached", jobId: waiveJobId });
    const poId = created.body.id as string;
    const receipt = await prisma.receipt.create({
      data: { id: newId(), jobId: waiveJobId, category: "materials", vendor: "PO-test attached", amount: 20, status: "confirmed", source: "manual" },
    });
    await request(app).post(`/purchase-orders/${poId}/receipts/${receipt.id}`).send({});

    const waive = await request(app).post(`/receipts/${receipt.id}/waive-po`).send({ reason: "Should not work" });
    expect(waive.status).toBe(409);
    const row = await prisma.receipt.findUniqueOrThrow({ where: { id: receipt.id } });
    expect(row.poWaivedAt).toBeNull();
  });
});

/**
 * GET /jobs/:jobId/purchase-orders (Kyle, 2026-09-20: "I need each job's P.O.
 * to show up on the job specific screen"). Money must agree with
 * jobCosting.ts's poMaterialByJob — a non-materials/other card charge (a
 * permit fee, say) must NOT show up here, and a tool P.O.'s typed amount must
 * read null, exactly like the job's aggregate.
 */
describe("GET /jobs/:jobId/purchase-orders — the money", () => {
  it("sums card spend of kind materials/other only, matches the job's poMaterialByJob aggregate, and excludes a tool PO's typed amount", async () => {
    const property = await prisma.property.create({
      data: { customerId, name: "Job PO Money House", addressLine1: "3 Purchase Ln", city: "Smyrna", state: "TN", postalCode: "37167" },
    });
    const visit = await prisma.visit.create({
      data: { customerId, propertyId: property.id, mode: "onsite", purpose: "Job PO money job", jobType: "Service", status: "in_progress", visitDate: new Date() },
    });
    const moneyJobId = visit.id;

    const materialPo = await request(app).post("/purchase-orders").send({ supplier: "PO-test Money Depot", jobId: moneyJobId });
    const materialPoId = materialPo.body.id as string;
    // Materials — counts.
    await prisma.cardSpend.create({
      data: { stripeTransactionId: `po_test_${newId()}`, stripeCardId: "card_po_test", kind: "materials", amount: 100, merchantName: "PO-test Money Depot", purchaseOrderId: materialPoId, occurredAt: new Date() },
    });
    // A permit fee on the SAME PO — must not count as material money
    // (jobCosting.ts: "only MATERIAL money is material" — a permit charge is a
    // job FEE, not material).
    await prisma.cardSpend.create({
      data: { stripeTransactionId: `po_test_${newId()}`, stripeCardId: "card_po_test", kind: "permit", amount: 45, merchantName: "PO-test Permit Office", purchaseOrderId: materialPoId, occurredAt: new Date() },
    });

    const toolPo = await request(app).post("/purchase-orders").send({ supplier: "PO-test Tool Supply", jobId: moneyJobId, purpose: "tool" });
    const toolPoId = toolPo.body.id as string;
    await request(app).patch(`/purchase-orders/${toolPoId}/money`).send({ reason: "Typed for a tool", offCardAmount: 250 });

    const res = await request(app).get(`/jobs/${moneyJobId}/purchase-orders`);
    expect(res.status).toBe(200);
    const materialRow = res.body.find((r: { id: string }) => r.id === materialPoId);
    const toolRow = res.body.find((r: { id: string }) => r.id === toolPoId);

    expect(materialRow.cardTotal).toBe(100);
    expect(materialRow.offCardAmount).toBeNull();
    expect(materialRow.moneyTotal).toBe(100);
    expect(materialRow.proofCount).toBe(0);

    // Tool POs never charge a job — the typed amount reads null here too.
    expect(toolRow.cardTotal).toBe(0);
    expect(toolRow.offCardAmount).toBeNull();
    expect(toolRow.moneyTotal).toBe(0);

    // Must agree with the job's own aggregate (jobCosting.ts poMaterialByJob) —
    // the same rule, so the job screen and the Materials-used panel never show
    // two different totals for the same job.
    expect((await costOf(moneyJobId)).materialCost).toBe(100);
  });

  it("attaching a receipt to a closed or cancelled PO is allowed (Kyle, 2026-09-20: \"edit/add to the P.O. currently assigned to it\")", async () => {
    const property = await prisma.property.create({
      data: { customerId, name: "Closed PO Receipt House", addressLine1: "4 Purchase Ln", city: "Smyrna", state: "TN", postalCode: "37167" },
    });
    const visit = await prisma.visit.create({
      data: { customerId, propertyId: property.id, mode: "onsite", purpose: "Closed PO receipt job", jobType: "Service", status: "in_progress", visitDate: new Date() },
    });
    const closedJobId = visit.id;

    const created = await request(app).post("/purchase-orders").send({ supplier: "PO-test Already Closed", jobId: closedJobId });
    const poId = created.body.id as string;
    const cancel = await request(app).post(`/purchase-orders/${poId}/status`).send({ to: "cancelled", reason: "PO-test setup" });
    expect(cancel.status).toBe(200);

    const receiptId = newId();
    const res = await request(app)
      .put(`/purchase-orders/${poId}/receipts/${receiptId}?vendor=PO-test%20Already%20Closed&amount=42.50&category=materials`)
      .set("Content-Type", "image/jpeg")
      .send(jpg);
    // Before 2026-09-20 this 409'd: "is cancelled; attach the receipt to a live PO."
    expect(res.status).toBe(201);

    const row = await prisma.receipt.findUniqueOrThrow({ where: { id: receiptId } });
    expect(row.purchaseOrderId).toBe(poId);

    const list = await request(app).get(`/jobs/${closedJobId}/purchase-orders`);
    const poRow = list.body.find((r: { id: string }) => r.id === poId);
    expect(poRow.proofCount).toBe(1);

    // And it can be taken back off — the standing rule that anything attached
    // is removable from the surface that shows it.
    const detach = await request(app).delete(`/purchase-orders/${poId}/receipts/${receiptId}`);
    expect(detach.status).toBe(204);
    const after = await prisma.receipt.findUniqueOrThrow({ where: { id: receiptId } });
    expect(after.purchaseOrderId).toBeNull();
  });
});
