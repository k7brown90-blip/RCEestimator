/**
 * Unit 2 (Kyle, 2026-09-12): PUT /health-record/receipts/:id must return
 * before Vision runs — the photo's safety must not depend on an external API
 * call completing. The row is persisted pending_review and 201 returned
 * immediately; Vision parses afterward, in the background, and patches
 * vendor/amount/lineItems into the row. A parse that throws must leave the
 * row exactly as it was — pending_review, photo bytes intact — never
 * silently confirmed, never dropped. An operator can retry a stuck receipt
 * via the admin reparse route, which is idempotent (fills empty fields only,
 * upserts nothing, so a second call can never create a second row).
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

// The Vision call is mocked so each test controls exactly what it returns (or
// throws) instead of depending on OpenAI or a real network call.
const vision = vi.hoisted(() => ({
  mode: "resolve" as "resolve" | "throw",
  result: null as ParsedReceipt | null,
  delayMs: 0,
}));
vi.mock("../src/services/receiptVision", () => ({
  parseReceiptImage: vi.fn(async () => {
    if (vision.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, vision.delayMs));
    if (vision.mode === "throw") throw new Error("vision boom (simulated)");
    return vision.result;
  }),
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

const newId = () => crypto.randomUUID().replaceAll("-", "");
const jpg = Buffer.from("ffd8ffe000104a464946", "hex");

let technicianId: string;
let techToken: string;

beforeAll(async () => {
  const tech = await prisma.technician.create({ data: { name: "Async Parse Tech", accessToken: `apt-${newId()}` } });
  technicianId = tech.id;
  techToken = tech.accessToken;
});

afterAll(async () => {
  await prisma.receipt.deleteMany({ where: { technicianId } });
  await prisma.technician.deleteMany({ where: { id: technicianId } });
});

/** Poll until `predicate` is true or the timeout elapses; returns the last-read value either way (a failing expect() below shows what it actually was). */
async function waitFor<T>(read: () => Promise<T>, predicate: (v: T) => boolean, timeoutMs = 2000): Promise<T> {
  const start = Date.now();
  let value = await read();
  while (!predicate(value) && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 20));
    value = await read();
  }
  return value;
}

describe("PUT /health-record/receipts/:id — Vision moved off the request path", () => {
  it("returns 201 immediately, without awaiting Vision — the row is pending_review with no parsed data yet", async () => {
    vision.mode = "resolve";
    vision.delayMs = 300;
    // Vision would eventually succeed, but slowly. If the endpoint awaited it,
    // this response would already carry the parsed vendor/amount below.
    vision.result = { vendor: "Slow Vendor", total: 99.99, purchaseDate: null, category: "materials", lineItems: [] };
    const id = newId();
    const res = await request(app)
      .put(`/health-record/receipts/${id}`)
      .set("Authorization", `Bearer ${techToken}`)
      .set("Content-Type", "image/jpeg")
      .send(jpg);

    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe("pending_review");
    expect(res.body.data.amount).toBe(0);
    expect(res.body.data.vendor).toBeNull();
    expect(res.body.data.parsed).toBe(false);

    // Read straight back, before the mocked Vision call's 300ms delay could
    // possibly have elapsed — proves the row was written unparsed, not that
    // parsing happened to be slower than the assertion.
    const row = await prisma.receipt.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("pending_review");
    expect(row.vendor).toBeNull();
    expect(row.amount).toBe(0);
    expect(row.imageData).not.toBeNull();

    vision.delayMs = 0; // reset for the other tests
  });

  it("a later parse updates the row: vendor, amount, and lineItems", async () => {
    vision.mode = "resolve";
    vision.result = {
      vendor: "Home Depot Async",
      total: 123.45,
      purchaseDate: null,
      category: "materials",
      lineItems: [{ name: "12-2 NM-B", qty: 1, unit: "roll", unitCost: 89.0 }],
    };
    const id = newId();
    const res = await request(app)
      .put(`/health-record/receipts/${id}`)
      .set("Authorization", `Bearer ${techToken}`)
      .set("Content-Type", "image/jpeg")
      .send(jpg);
    expect(res.status).toBe(201);

    const row = await waitFor(
      () => prisma.receipt.findUniqueOrThrow({ where: { id } }),
      (r) => r.vendor !== null,
    );
    expect(row.vendor).toBe("Home Depot Async");
    expect(row.amount).toBe(123.45);
    expect(row.lineItems).not.toBeNull();
    expect(JSON.parse(row.lineItems!)).toEqual([{ name: "12-2 NM-B", qty: 1, unit: "roll", unitCost: 89.0 }]);
    // Still pending_review — the async parse fills data but never confirms on its own.
    expect(row.status).toBe("pending_review");
  });

  it("a parse that THROWS leaves the row pending_review with its photo bytes intact", async () => {
    vision.mode = "throw";
    const id = newId();
    const res = await request(app)
      .put(`/health-record/receipts/${id}`)
      .set("Authorization", `Bearer ${techToken}`)
      .set("Content-Type", "image/jpeg")
      .send(jpg);
    expect(res.status).toBe(201);

    // Give the fire-and-forget parse a moment to run (and throw).
    await new Promise((r) => setTimeout(r, 200));

    const row = await prisma.receipt.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("pending_review");
    expect(row.vendor).toBeNull();
    expect(row.amount).toBe(0);
    expect(row.imageData).not.toBeNull();
    expect(Buffer.from(row.imageData!).equals(jpg)).toBe(true);
  });

  it("a re-parse updates the row without creating a second one", async () => {
    vision.mode = "resolve";
    // Seed a stuck receipt directly, as if an earlier async parse had died —
    // this is exactly the row an operator would retry.
    const id = newId();
    await prisma.receipt.create({
      data: {
        id, category: "materials", vendor: null, amount: 0, status: "pending_review",
        source: "tech_pwa", technicianId, imageData: jpg, imageMime: "image/jpeg",
      },
    });
    vision.result = { vendor: "Reparsed Vendor", total: 55.5, purchaseDate: null, category: "materials", lineItems: [] };

    const before = await prisma.receipt.count({ where: { technicianId } });
    const res = await request(app).post(`/health-record-admin/receipts/${id}/reparse`).send({});
    expect(res.status).toBe(200);
    expect(res.body.parsed).toBe(true);
    expect(res.body.data.vendor).toBe("Reparsed Vendor");
    expect(res.body.data.amount).toBe(55.5);
    expect(res.body.data.id).toBe(id);

    const after = await prisma.receipt.count({ where: { technicianId } });
    expect(after).toBe(before); // no second row created

    const row = await prisma.receipt.findUniqueOrThrow({ where: { id } });
    expect(row.vendor).toBe("Reparsed Vendor");
    expect(row.amount).toBe(55.5);
    expect(row.status).toBe("pending_review");

    // Calling it again is safe: still one row, and an already-filled field is
    // not clobbered by a second parse result.
    vision.result = { vendor: "Different Vendor", total: 1, purchaseDate: null, category: "materials", lineItems: [] };
    const again = await request(app).post(`/health-record-admin/receipts/${id}/reparse`).send({});
    expect(again.status).toBe(200);
    const stillOneRow = await prisma.receipt.count({ where: { id } });
    expect(stillOneRow).toBe(1);
    const rowAfter = await prisma.receipt.findUniqueOrThrow({ where: { id } });
    expect(rowAfter.vendor).toBe("Reparsed Vendor");
  });
});
