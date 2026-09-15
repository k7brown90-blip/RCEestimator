/**
 * Receipt → job material, one writer (Kyle, 2026-09-08: Daughdrill's office-uploaded
 * receipts landed confirmed but the job's actualMaterialCost stayed 0, so the card kept
 * showing the estimate's material). Every receipt door must leave the job's stamped
 * total equal to its confirmed material receipts.
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
import { rollupJobCosts } from "../src/services/jobCosting";
import { plausiblePurchaseDate, resolvePurchaseDate } from "../src/services/receiptVision";
import { matchSpendForReceipt } from "../src/services/cardSpend";

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
// the receipt for review. Tested directly (no network call) since it's the real guard,
// not a caller's mock of it.
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

const stamped = async (id: string) =>
  (await prisma.visit.findUniqueOrThrow({ where: { id }, select: { actualMaterialCost: true } })).actualMaterialCost;

beforeAll(async () => {
  const customer = await prisma.customer.create({ data: { name: "Reroll Customer", phone: "+16155509999" } });
  customerId = customer.id;
  const property = await prisma.property.create({
    data: { customerId, name: "Reroll House", addressLine1: "9 Reroll Rd", city: "Smyrna", state: "TN", postalCode: "37167" },
  });
  const mk = async (purpose: string) =>
    (await prisma.visit.create({
      data: { customerId, propertyId: property.id, mode: "onsite", purpose, jobType: "Service", status: "completed", visitDate: new Date() },
    })).id;
  jobId = await mk("Reroll job");
  otherJobId = await mk("Reroll other job");
});

afterAll(async () => {
  await prisma.receipt.deleteMany({ where: { jobId: { in: [jobId, otherJobId] } } });
  await prisma.visit.deleteMany({ where: { customerId } });
  await prisma.property.deleteMany({ where: { customerId } });
  await prisma.customer.delete({ where: { id: customerId } });
});

describe("receipt doors re-roll the job's material cost", () => {
  it("office upload (PUT /jobs/:id/receipts/:id) lands confirmed AND re-rolls the job", async () => {
    const res = await request(app)
      .put(`/jobs/${jobId}/receipts/${newId()}?vendor=Home%20Depot&amount=212.40&category=materials`)
      .set("Content-Type", "image/jpeg")
      .send(jpg);
    expect(res.status).toBe(201);
    expect(await stamped(jobId)).toBe(212.4);

    const second = await request(app)
      .put(`/jobs/${jobId}/receipts/${newId()}?vendor=Lowes&amount=100.10&category=materials`)
      .set("Content-Type", "image/jpeg")
      .send(jpg);
    expect(second.status).toBe(201);
    expect(await stamped(jobId)).toBe(312.5);
  });

  it("non-material receipts never count toward material", async () => {
    const res = await request(app)
      .put(`/jobs/${jobId}/receipts/${newId()}?vendor=Shell&amount=60&category=gas`)
      .set("Content-Type", "image/jpeg")
      .send(jpg);
    expect(res.status).toBe(201);
    expect(await stamped(jobId)).toBe(312.5);
  });

  it("moving a receipt to another job re-rolls both jobs; deleting re-rolls again", async () => {
    const moved = await prisma.receipt.findFirstOrThrow({ where: { jobId, vendor: "Lowes" } });
    const patch = await request(app).patch(`/health-record-admin/receipts/${moved.id}`).send({ jobId: otherJobId });
    expect(patch.status).toBe(200);
    expect(await stamped(jobId)).toBe(212.4);
    expect(await stamped(otherJobId)).toBe(100.1);

    const del = await request(app).delete(`/health-record-admin/receipts/${moved.id}`);
    expect(del.status).toBe(204);
    expect(await stamped(otherJobId)).toBe(0);
    expect(await prisma.receipt.findUnique({ where: { id: moved.id } })).toBeNull();
  });

  it("the card names its material source", () => {
    const base = { estimatedCost: null, laborHours: 0, overheadAllocation: 0, revenue: 1000 };
    expect(rollupJobCosts({ ...base, actualMaterialCost: 212.4 }, null, 100, 572.84).materialSource).toBe("receipts");
    expect(rollupJobCosts({ ...base, actualMaterialCost: 0 }, null, 100, 572.84).materialSource).toBe("estimate");
    expect(rollupJobCosts({ ...base, actualMaterialCost: 0 }, null, 100, null).materialSource).toBe("none");
    // The material figure itself is unchanged by the label.
    expect(rollupJobCosts({ ...base, actualMaterialCost: 0 }, null, 100, 572.84).materialCost).toBe(572.84);
  });
});

// Legacy purchase close-out, Unit 4 (2026-09-14): the admin PATCH route is the only
// correction path for a receipt whose receivedAt was written from a mis-parsed Vision
// year — this mirrors the real production defect (receipt 9f7901d9f3c840318d08688fa0bb5170,
// $324.33, dated 2022-09-08 instead of 2026-09-08).
describe("PATCH /health-record-admin/receipts/:id accepts a receivedAt correction", () => {
  const stripeTxnId = () => `txn_${newId()}`;

  it("updates receivedAt, and a receipt whose date moves into range becomes reachable by the card matcher", async () => {
    const receipt = await prisma.receipt.create({
      data: {
        jobId, category: "materials", vendor: "Home Depot", amount: 324.33,
        status: "confirmed", source: "tech_pwa",
        receivedAt: new Date("2022-09-08T12:00:00Z"), // the exact mis-parse: right day/month, wrong year
      },
    });
    const spend = await prisma.cardSpend.create({
      data: {
        stripeTransactionId: stripeTxnId(), stripeCardId: "card_test", kind: "materials",
        amount: 324.33, merchantName: "HOME DEPOT", status: "unmatched",
        occurredAt: new Date("2026-09-08T18:06:00Z"),
      },
    });

    // Before the fix: the card matcher's ±3-day window can't reach a 2026 transaction
    // from a 2022 receivedAt — this is the mechanism, not a guess.
    expect(await matchSpendForReceipt(receipt.id)).toBeNull();
    expect((await prisma.cardSpend.findUniqueOrThrow({ where: { id: spend.id } })).status).toBe("unmatched");

    const patch = await request(app)
      .patch(`/health-record-admin/receipts/${receipt.id}`)
      .send({ receivedAt: "2026-09-08" });
    expect(patch.status).toBe(200);

    const row = await prisma.receipt.findUniqueOrThrow({ where: { id: receipt.id } });
    expect(row.receivedAt.toISOString().slice(0, 10)).toBe("2026-09-08");

    // The route re-runs the matcher itself (health-record.ts's receivedAt !== undefined
    // branch) — the now-reachable spend links without a second call.
    const matchedSpend = await prisma.cardSpend.findUniqueOrThrow({ where: { id: spend.id } });
    expect(matchedSpend.status).toBe("matched");
    expect(matchedSpend.receiptId).toBe(receipt.id);

    await prisma.cardSpend.delete({ where: { id: spend.id } });
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
