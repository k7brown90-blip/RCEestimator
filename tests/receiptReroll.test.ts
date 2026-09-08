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
