/**
 * Barcode/materials plan (2026-09-12), Unit 3 — the two technician-facing endpoints added to
 * `healthRecordTechRouter` in src/routes/health-record.ts:
 *
 *   GET  /health-record/materials         — the full Material table, cached offline by the field
 *                                            app (lib/crmSync.ts syncMaterials).
 *   POST /health-record/materials/scan     — resolve a scanned/typed code against Material. Kyle is
 *                                            standing at a register: an unknown code must NEVER
 *                                            404 or block the purchase — it creates an unassigned
 *                                            Material carrying that code and returns 201, and a
 *                                            second scan of the same unknown code must resolve to
 *                                            the row already created, never a duplicate.
 *
 * These endpoints sit behind `technicianAuth` (a per-technician bearer token), not
 * `pinAuthMiddleware` — the field PWA has no CRM operator session. That auth boundary is pinned
 * here with an explicit 401 test for both routes.
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

const newId = () => crypto.randomUUID().replaceAll("-", "");

let technicianId: string;
let techToken: string;
const createdMaterialIds: string[] = [];

beforeAll(async () => {
  const tech = await prisma.technician.create({ data: { name: "Materials Scan Tech", accessToken: `mscan-${newId()}` } });
  technicianId = tech.id;
  techToken = tech.accessToken;
});

afterAll(async () => {
  await prisma.material.deleteMany({ where: { id: { in: createdMaterialIds } } });
  await prisma.technician.deleteMany({ where: { id: technicianId } });
});

async function seedMaterial(overrides: Partial<{ upc: string | null; sku: string | null; supplier: string | null; description: string | null; lastCost: number | null; itemId: string | null }> = {}) {
  const row = await prisma.material.create({
    data: {
      description: "seeded test material",
      ...overrides,
    },
  });
  createdMaterialIds.push(row.id);
  return row;
}

describe("GET /health-record/materials — auth boundary", () => {
  it("401s with no bearer token", async () => {
    const res = await request(app).get("/health-record/materials");
    expect(res.status).toBe(401);
  });

  it("401s with an invalid bearer token", async () => {
    const res = await request(app).get("/health-record/materials").set("Authorization", "Bearer not-a-real-token");
    expect(res.status).toBe(401);
  });
});

describe("POST /health-record/materials/scan — auth boundary", () => {
  it("401s with no bearer token", async () => {
    const res = await request(app).post("/health-record/materials/scan").send({ code: "012345678905", source: "upc" });
    expect(res.status).toBe(401);
  });

  it("401s with an invalid bearer token", async () => {
    const res = await request(app)
      .post("/health-record/materials/scan")
      .set("Authorization", "Bearer not-a-real-token")
      .send({ code: "012345678905", source: "upc" });
    expect(res.status).toBe(401);
  });
});

describe("GET /health-record/materials — the offline cache payload", () => {
  it("returns the Material rows shaped for the field cache, nothing beyond Material's own fields", async () => {
    const upc = `${Math.floor(Math.random() * 1e12)}`;
    const seeded = await seedMaterial({ upc, description: "Leviton 5320-W 10-pack", lastCost: 11.97 });

    const res = await request(app).get("/health-record/materials").set("Authorization", `Bearer ${techToken}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data.materials)).toBe(true);

    const row = res.body.data.materials.find((m: { id: string }) => m.id === seeded.id);
    expect(row).toBeTruthy();
    // Exactly the fields the field cache needs — id, code identity, description, pack info, cost,
    // link — nothing else (e.g. no internal Prisma-only bookkeeping beyond what's listed here).
    expect(Object.keys(row).sort()).toEqual(
      ["description", "id", "itemId", "lastCost", "packQty", "packUnit", "sku", "supplier", "upc"].sort(),
    );
    expect(row.upc).toBe(upc);
    expect(row.description).toBe("Leviton 5320-W 10-pack");
    expect(row.lastCost).toBe(11.97);
  });
});

describe("POST /health-record/materials/scan — resolving known codes", () => {
  it("a known UPC resolves to the existing material and creates nothing new", async () => {
    const upc = `${Math.floor(Math.random() * 1e12)}`;
    const seeded = await seedMaterial({ upc, description: "Known UPC material" });

    const before = await prisma.material.count();
    const res = await request(app)
      .post("/health-record/materials/scan")
      .set("Authorization", `Bearer ${techToken}`)
      .send({ code: upc, source: "upc" });

    expect(res.status).toBe(200);
    expect(res.body.data.found).toBe(true);
    expect(res.body.data.material.id).toBe(seeded.id);

    const after = await prisma.material.count();
    expect(after).toBe(before);
  });

  it("a known (supplier, sku) resolves to the existing material", async () => {
    const sku = `SKU-${newId().slice(0, 10)}`;
    const seeded = await seedMaterial({ sku, supplier: "Home Depot", description: "Known SKU material" });

    const before = await prisma.material.count();
    const res = await request(app)
      .post("/health-record/materials/scan")
      .set("Authorization", `Bearer ${techToken}`)
      .send({ code: sku, source: "sku" });

    expect(res.status).toBe(200);
    expect(res.body.data.found).toBe(true);
    expect(res.body.data.material.id).toBe(seeded.id);

    const after = await prisma.material.count();
    expect(after).toBe(before);
  });
});

describe("POST /health-record/materials/scan — an unknown code never blocks the purchase", () => {
  it("returns 201 and creates exactly one unassigned material carrying the code", async () => {
    const unknownUpc = `${Math.floor(Math.random() * 1e12)}`;

    const first = await request(app)
      .post("/health-record/materials/scan")
      .set("Authorization", `Bearer ${techToken}`)
      .send({ code: unknownUpc, source: "upc", price: 4.5 });

    expect(first.status).toBe(201);
    expect(first.body.success).toBe(true);
    expect(first.body.data.found).toBe(false);
    expect(first.body.data.material.upc).toBe(unknownUpc);
    const createdId = first.body.data.material.id as string;
    createdMaterialIds.push(createdId);

    // Genuinely unassigned: no itemId (no labour link) — Kyle finishes assignment later at a desk.
    const row = await prisma.material.findUniqueOrThrow({ where: { id: createdId } });
    expect(row.itemId).toBeNull();
    expect(row.upc).toBe(unknownUpc);
    expect(row.lastCost).toBe(4.5);

    // Exactly one row for this code, before AND after a second scan of the same unknown code.
    const countAfterFirst = await prisma.material.count({ where: { upc: unknownUpc } });
    expect(countAfterFirst).toBe(1);

    const second = await request(app)
      .post("/health-record/materials/scan")
      .set("Authorization", `Bearer ${techToken}`)
      .send({ code: unknownUpc, source: "upc", price: 4.5 });

    // The second scan of the now-known code resolves to the same row rather than creating another.
    expect(second.status).toBe(200);
    expect(second.body.data.found).toBe(true);
    expect(second.body.data.material.id).toBe(createdId);

    const countAfterSecond = await prisma.material.count({ where: { upc: unknownUpc } });
    expect(countAfterSecond).toBe(1);
  });

  it("an unknown code with no price supplied still resolves (never blocks on a missing price)", async () => {
    const unknownSku = `SKU-UNK-${newId().slice(0, 8)}`;
    const res = await request(app)
      .post("/health-record/materials/scan")
      .set("Authorization", `Bearer ${techToken}`)
      .send({ code: unknownSku, source: "sku" });

    expect(res.status).toBe(201);
    expect(res.body.data.found).toBe(false);
    expect(res.body.data.material.sku).toBe(unknownSku);
    expect(res.body.data.material.lastCost).toBeNull();
    createdMaterialIds.push(res.body.data.material.id);

    const row = await prisma.material.findUniqueOrThrow({ where: { id: res.body.data.material.id } });
    expect(row.itemId).toBeNull();
  });
});
