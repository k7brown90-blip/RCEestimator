/**
 * The receipt is proof, never money (Kyle, 2026-09-19, "the P.O. is the money").
 *
 * Every receipt door — the P.O. upload, the admin PATCH (amount, job, date,
 * status), delete — moves NO cost figure. The job's material is the money on
 * its P.O.s; the receipt proves the P.O. it sits on. The Vision purchase-date
 * guards and the receivedAt correction (2026-09-14) are kept here because they
 * pin rules that still stand: a receipt's date is what the proof says.
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
import { plausiblePurchaseDate, resolvePurchaseDate } from "../src/services/receiptVision";
import { createPurchaseOrder, setPurchaseOrderMoney, transitionPurchaseOrder } from "../src/services/purchaseOrders";
import { materialCostForJobs } from "../src/services/jobCosting";

describe("vision purchase dates are only trusted when plausible", () => {
  const now = new Date("2026-09-08T17:00:00Z");
  it("keeps a recent date, drops a misread year, the future, and garbage", () => {
    expect(plausiblePurchaseDate("2026-09-08", now)).toBe("2026-09-08");
    expect(plausiblePurchaseDate("2025-11-30", now)).toBe("2025-11-30");
    // Kyle's 2026-09-08 captures came back as 2022-09-08.
    expect(plausiblePurchaseDate("2022-09-08", now)).toBeNull();
    expect(plausiblePurchaseDate("2026-09-20", now)).toBeNull();
    expect(plausiblePurchaseDate("09/08/2026", now)).toBeNull();
    expect(plausiblePurchaseDate(null, now)).toBeNull();
  });
});

// Legacy purchase close-out, Unit 4 (2026-09-14): resolvePurchaseDate() is the exact
// function both Vision write sites (app.ts's PO-receipt PUT and health-record.ts's
// applyVisionParse) call to decide whether to trust a parsed date and whether to flag
// the receipt for review.
describe("resolvePurchaseDate distinguishes 'no date read' from 'date rejected'", () => {
  const now = new Date("2026-09-14T17:00:00Z");
  it("an in-range date is trusted and not flagged", () => {
    expect(resolvePurchaseDate("2026-09-08", now)).toEqual({ purchaseDate: "2026-09-08", purchaseDateRejected: false });
  });
  it("the exact Tran mis-parse (2022 instead of 2026) is rejected AND flagged", () => {
    expect(resolvePurchaseDate("2022-09-08", now)).toEqual({ purchaseDate: null, purchaseDateRejected: true });
  });
  it("Vision simply not reading a date at all is neither trusted nor flagged", () => {
    expect(resolvePurchaseDate(null, now)).toEqual({ purchaseDate: null, purchaseDateRejected: false });
    expect(resolvePurchaseDate(undefined, now)).toEqual({ purchaseDate: null, purchaseDateRejected: false });
  });
});

const newId = () => crypto.randomUUID().replaceAll("-", "");
const jpg = Buffer.from("ffd8ffe000104a464946", "hex");

let customerId: string;
let jobId: string;
let otherJobId: string;

const costOf = async (id: string) => (await materialCostForJobs([{ visitId: id }])).get(id)!;

beforeAll(async () => {
  const customer = await prisma.customer.create({ data: { name: "Proof Customer", phone: "+16155509999" } });
  customerId = customer.id;
  const property = await prisma.property.create({
    data: { customerId, name: "Proof House", addressLine1: "9 Proof Rd", city: "Smyrna", state: "TN", postalCode: "37167" },
  });
  const mk = async (purpose: string) =>
    (await prisma.visit.create({
      data: { customerId, propertyId: property.id, mode: "onsite", purpose, jobType: "Service", status: "completed", visitDate: new Date() },
    })).id;
  jobId = await mk("Proof job");
  otherJobId = await mk("Proof other job");
});

afterAll(async () => {
  await prisma.receipt.deleteMany({ where: { jobId: { in: [jobId, otherJobId] } } });
  await prisma.purchaseOrder.deleteMany({ where: { jobId: { in: [jobId, otherJobId] } } });
  await prisma.visit.deleteMany({ where: { customerId } });
  await prisma.property.deleteMany({ where: { customerId } });
  await prisma.customer.delete({ where: { id: customerId } });
});

describe("receipt doors move no money (Kyle, 2026-09-19)", () => {
  it("the P.O. upload door files the receipt as proof; the job's figure is the P.O.'s typed amount, not the receipt's", async () => {
    const po = await createPurchaseOrder({ supplier: "Home Depot", purpose: "warehouse", jobId, openedBy: "owner", actor: "test" });
    await setPurchaseOrderMoney(po.id, { offCardAmount: 100, offCardMethod: "check" }, { actor: "test", reason: "Paid by check" });
    expect(await costOf(jobId)).toMatchObject({ materialCost: 100, materialSource: "po" });

    // The receipt says $88.20 — a different number on purpose. It is proof, not money.
    const res = await request(app)
      .put(`/purchase-orders/${po.id}/receipts/${newId()}?vendor=Home%20Depot&amount=88.20&category=materials`)
      .set("Content-Type", "image/jpeg")
      .send(jpg);
    expect(res.status).toBe(201);
    expect((await costOf(jobId)).materialCost).toBe(100);
    // Money (typed) + proof (the photo) → verified, with no amount comparison.
    expect((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } })).status).toBe("verified");

    // Cancelling the P.O. moves no money either.
    await transitionPurchaseOrder(po.id, "cancelled", { actor: "test", reason: "test — never landed" });
    expect((await costOf(jobId)).materialCost).toBe(100);
  });

  it("moving a receipt to another job, editing its amount, or deleting it changes neither job", async () => {
    const before = (await costOf(jobId)).materialCost;
    const other = (await costOf(otherJobId)).materialCost;
    const receipt = await prisma.receipt.create({
      data: { jobId, category: "materials", status: "confirmed", source: "manual", vendor: "Lowes", amount: 100.1 },
    });
    const patch = await request(app).patch(`/health-record-admin/receipts/${receipt.id}`).send({ jobId: otherJobId, amount: 999 });
    expect(patch.status).toBe(200);
    expect((await costOf(jobId)).materialCost).toBe(before);
    expect((await costOf(otherJobId)).materialCost).toBe(other);

    const del = await request(app).delete(`/health-record-admin/receipts/${receipt.id}`);
    expect(del.status).toBe(204);
    expect((await costOf(otherJobId)).materialCost).toBe(other);
    expect(await prisma.receipt.findUnique({ where: { id: receipt.id } })).toBeNull();
  });

  it("PUT /jobs/:jobId/receipts/:receiptId is retired — no CRM door can create a P.O.-less receipt", async () => {
    const res = await request(app)
      .put(`/jobs/${jobId}/receipts/${newId()}?vendor=Home%20Depot&amount=1&category=materials`)
      .set("Content-Type", "image/jpeg")
      .send(jpg);
    expect(res.status).toBe(404);
  });
});

// Legacy purchase close-out, Unit 4 (2026-09-14): the admin PATCH route is the only
// correction path for a receipt whose receivedAt was written from a mis-parsed Vision
// year — this mirrors the real production defect (receipt 9f7901d9f3c840318d08688fa0bb5170,
// $324.33, dated 2022-09-08 instead of 2026-09-08).
describe("PATCH /health-record-admin/receipts/:id accepts a receivedAt correction", () => {
  it("updates receivedAt at NOON UTC so the day survives the Central offset", async () => {
    const receipt = await prisma.receipt.create({
      data: {
        jobId, category: "materials", vendor: "Home Depot", amount: 324.33,
        status: "confirmed", source: "tech_pwa",
        receivedAt: new Date("2022-09-08T12:00:00Z"), // the exact mis-parse: right day/month, wrong year
      },
    });
    const patch = await request(app)
      .patch(`/health-record-admin/receipts/${receipt.id}`)
      .send({ receivedAt: "2026-09-08" });
    expect(patch.status).toBe(200);

    const row = await prisma.receipt.findUniqueOrThrow({ where: { id: receipt.id } });
    // NOON UTC, not midnight. Midnight UTC is 7pm the PREVIOUS day in
    // America/Chicago, which is how Kyle's 2026-09-08 correction filed itself
    // under 9/7 in production on 2026-09-15.
    expect(row.receivedAt.toISOString()).toBe("2026-09-08T12:00:00.000Z");
    await prisma.receipt.delete({ where: { id: receipt.id } });
  });

  it("anchors the 1st of a month inside that month, not the last day of the one before", async () => {
    const receipt = await prisma.receipt.create({
      data: {
        jobId, category: "materials", vendor: "Home Depot", amount: 12.5,
        status: "confirmed", source: "manual", receivedAt: new Date("2026-08-15T12:00:00Z"),
      },
    });
    const patch = await request(app)
      .patch(`/health-record-admin/receipts/${receipt.id}`)
      .send({ receivedAt: "2026-09-01" });
    expect(patch.status).toBe(200);
    const row = await prisma.receipt.findUniqueOrThrow({ where: { id: receipt.id } });
    expect(row.receivedAt.toISOString()).toBe("2026-09-01T12:00:00.000Z");
    expect(row.receivedAt.toLocaleDateString("en-US", { timeZone: "America/Chicago" })).toBe("9/1/2026");
    await prisma.receipt.delete({ where: { id: receipt.id } });
  });

  it("a PATCH with no receivedAt leaves the field untouched", async () => {
    const receipt = await prisma.receipt.create({
      data: {
        jobId, category: "materials", vendor: "Home Depot", amount: 46.8,
        status: "confirmed", source: "tech_pwa", receivedAt: new Date("2026-09-08T12:00:00Z"),
      },
    });
    const patch = await request(app).patch(`/health-record-admin/receipts/${receipt.id}`).send({ vendor: "Home Depot #0776" });
    expect(patch.status).toBe(200);
    const row = await prisma.receipt.findUniqueOrThrow({ where: { id: receipt.id } });
    expect(row.receivedAt.toISOString().slice(0, 10)).toBe("2026-09-08");
    expect(row.vendor).toBe("Home Depot #0776");
    await prisma.receipt.delete({ where: { id: receipt.id } });
  });
});
