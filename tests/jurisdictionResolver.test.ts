/**
 * Jurisdiction resolution — which code edition governs an address.
 *
 * This replaces a fuzzy city-name match on the technician's phone that silently
 * defaulted unknown cities to Rutherford (2017 NEC). The behaviour that matters
 * most here is the `source` field: when nobody has actually decided, the caller
 * must be able to tell, so the field app can say so instead of guessing.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { prisma } from "../src/lib/prisma";
import {
  DEFAULT_JURISDICTION_ID,
  isKnownJurisdiction,
  resolveJurisdiction,
  resolveJurisdictions,
} from "../src/services/jurisdictionResolver";

process.env.GOOGLE_CLIENT_ID = "test_id";
process.env.GOOGLE_CLIENT_SECRET = "test_secret";
process.env.GOOGLE_REFRESH_TOKEN = "test_token";

vi.mock("../src/services/twilio", () => ({
  sendSms: vi.fn().mockResolvedValue({ sid: "SM_mock" }),
  KYLE_PHONE: "+19706661626",
  isFromKyle: vi.fn().mockReturnValue(false),
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

const nashvilleAddress = { city: "Nashville", state: "TN", postalCode: "37206" };

beforeEach(async () => {
  await prisma.companySetting.deleteMany();
});

afterAll(async () => {
  await prisma.companySetting.deleteMany();
});

describe("resolveJurisdiction precedence", () => {
  it("prefers an explicit property override above everything", async () => {
    const result = await resolveJurisdiction({ jurisdictionId: "franklin", ...nashvilleAddress });
    expect(result).toEqual({ jurisdictionId: "franklin", source: "property" });
  });

  it("ignores an override that isn't a jurisdiction we know", async () => {
    // A typo or a retired id must fall through, not be trusted.
    const result = await resolveJurisdiction({ jurisdictionId: "atlantis", ...nashvilleAddress });
    expect(result.jurisdictionId).toBe("nashville");
    expect(result.source).toBe("city");
  });

  it("matches the territories setting on ZIP", async () => {
    await request(app).put("/crm/settings/territories").send([
      { zip: "37130", area: "Murfreesboro", codeCycle: "NEC 2017", jurisdictionId: "murfreesboro" },
      { zip: "37206", area: "East Nashville", codeCycle: "NEC 2023", jurisdictionId: "nashville" },
    ]);

    const result = await resolveJurisdiction({ jurisdictionId: null, ...nashvilleAddress });
    expect(result).toEqual({ jurisdictionId: "nashville", source: "territory" });
  });

  it("prefers ZIP over city — ZIPs don't collide, city names do", async () => {
    await request(app).put("/crm/settings/territories").send([
      { zip: "37206", jurisdictionId: "franklin" },
    ]);
    const result = await resolveJurisdiction({ jurisdictionId: null, ...nashvilleAddress });
    expect(result).toEqual({ jurisdictionId: "franklin", source: "territory" });
  });

  it("tolerates ZIP+4 by matching on the first five digits", async () => {
    await request(app).put("/crm/settings/territories").send([{ zip: "37130", jurisdictionId: "murfreesboro" }]);
    const result = await resolveJurisdiction({
      jurisdictionId: null, city: "Nowhere", state: "TN", postalCode: "37130-1234",
    });
    expect(result).toEqual({ jurisdictionId: "murfreesboro", source: "territory" });
  });

  it("skips territory rows with no jurisdiction set rather than failing", async () => {
    await request(app).put("/crm/settings/territories").send([
      { zip: "37206", area: "East Nashville", codeCycle: "NEC 2023" }, // no jurisdictionId
    ]);
    const result = await resolveJurisdiction({ jurisdictionId: null, ...nashvilleAddress });
    expect(result.source).toBe("city");
  });

  it("falls back to the city map", async () => {
    const result = await resolveJurisdiction({
      jurisdictionId: null, city: "Smyrna", state: "TN", postalCode: "37167",
    });
    expect(result).toEqual({ jurisdictionId: "rutherford", source: "city" });
  });

  it("is case- and whitespace-insensitive about city names", async () => {
    const result = await resolveJurisdiction({
      jurisdictionId: null, city: "  MURFREESBORO ", state: "TN", postalCode: "",
    });
    expect(result).toEqual({ jurisdictionId: "murfreesboro", source: "city" });
  });

  it("flags an unrecognised address as default rather than quietly picking one", async () => {
    // This is the whole point: the report must be able to say the office hasn't
    // confirmed the jurisdiction, instead of applying 2017 NEC by accident.
    const result = await resolveJurisdiction({
      jurisdictionId: null, city: "Chattanooga", state: "TN", postalCode: "37402",
    });
    expect(result).toEqual({ jurisdictionId: DEFAULT_JURISDICTION_ID, source: "default" });
  });

  it("does not substring-match city names", async () => {
    const result = await resolveJurisdiction({
      jurisdictionId: null, city: "Franklin County", state: "TN", postalCode: "",
    });
    expect(result.source).toBe("default");
  });

  it("survives a malformed territories setting", async () => {
    await prisma.companySetting.upsert({
      where: { key: "territories" },
      update: { valueJson: "not json at all" },
      create: { key: "territories", valueJson: "not json at all" },
    });
    const result = await resolveJurisdiction({ jurisdictionId: null, ...nashvilleAddress });
    expect(result.jurisdictionId).toBe("nashville");
  });
});

describe("resolveJurisdictions (batch)", () => {
  it("gives the same answer as the single-property path", async () => {
    await request(app).put("/crm/settings/territories").send([{ zip: "37130", jurisdictionId: "murfreesboro" }]);

    const properties = [
      { jurisdictionId: "franklin", city: "Nashville", state: "TN", postalCode: "37206" },
      { jurisdictionId: null, city: "Nowhere", state: "TN", postalCode: "37130" },
      { jurisdictionId: null, city: "Brentwood", state: "TN", postalCode: "37027" },
      { jurisdictionId: null, city: "Chattanooga", state: "TN", postalCode: "37402" },
    ];

    const batch = await resolveJurisdictions(properties);
    for (const property of properties) {
      expect(batch.get(property)).toEqual(await resolveJurisdiction(property));
    }
    expect([...batch.values()].map((r) => r.source)).toEqual(
      ["property", "territory", "city", "default"],
    );
  });
});

describe("isKnownJurisdiction", () => {
  it("accepts only the ids the field app has profiles for", () => {
    expect(isKnownJurisdiction("nashville")).toBe(true);
    expect(isKnownJurisdiction("atlantis")).toBe(false);
    expect(isKnownJurisdiction(null)).toBe(false);
    expect(isKnownJurisdiction(undefined)).toBe(false);
    expect(isKnownJurisdiction(42)).toBe(false);
  });
});

// ─── ASSIGNMENTS ENDPOINT ──────────────────────────────────────────────────────

describe("GET /health-record/assignments", () => {
  let token: string;
  let otherToken: string;
  let visitId: string;

  beforeEach(async () => {
    await prisma.visitAssignment.deleteMany();
    await prisma.healthInspection.deleteMany();
    await prisma.visit.deleteMany();
    await prisma.property.deleteMany();
    await prisma.customer.deleteMany();
    await prisma.technician.deleteMany();

    token = "tech-token-assignments";
    otherToken = "tech-token-other";
    const tech = await prisma.technician.create({
      data: { name: "Michael Schramm", accessToken: token },
    });
    await prisma.technician.create({ data: { name: "Someone Else", accessToken: otherToken } });

    const customer = await prisma.customer.create({ data: { name: "Hollis", phone: "+16155550123" } });
    const property = await prisma.property.create({
      data: {
        customerId: customer.id, name: "Home", addressLine1: "605 Green Farm Way",
        city: "Murfreesboro", state: "TN", postalCode: "37130",
      },
    });
    const visit = await prisma.visit.create({
      data: {
        customerId: customer.id, propertyId: property.id, mode: "service_diagnostic",
        status: "scheduled", jobType: "Health inspection",
        scheduledStart: new Date("2026-08-04T14:00:00.000Z"),
      },
    });
    visitId = visit.id;
    await prisma.visitAssignment.create({
      data: { visitId: visit.id, technicianId: tech.id, role: "primary", status: "assigned" },
    });
  });

  afterAll(async () => {
    await prisma.visitAssignment.deleteMany();
    await prisma.healthInspection.deleteMany();
    await prisma.visit.deleteMany();
    await prisma.property.deleteMany();
    await prisma.customer.deleteMany();
    await prisma.technician.deleteMany();
  });

  const get = (bearer: string) =>
    request(app).get("/health-record/assignments").set("Authorization", `Bearer ${bearer}`);

  it("returns only the calling technician's own work", async () => {
    const mine = await get(token);
    expect(mine.status).toBe(200);
    expect(mine.body.data).toHaveLength(1);
    expect(mine.body.data[0].visitId).toBe(visitId);

    const theirs = await get(otherToken);
    expect(theirs.body.data).toHaveLength(0);
  });

  it("returns a structured address the PWA can render without parsing", async () => {
    const res = await get(token);
    const assignment = res.body.data[0];
    expect(assignment.address.line1).toBe("605 Green Farm Way");
    expect(assignment.address.city).toBe("Murfreesboro");
    expect(assignment.address.postalCode).toBe("37130");
    expect(assignment.address.formatted).toContain("605 Green Farm Way");
    expect(assignment.address.formatted).toContain("37130");
  });

  it("carries the resolved jurisdiction and where it came from", async () => {
    const res = await get(token);
    expect(res.body.data[0].jurisdictionId).toBe("murfreesboro");
    expect(res.body.data[0].jurisdictionSource).toBe("city");
  });

  it("reports jurisdictionSource=default when the office hasn't decided", async () => {
    await prisma.property.updateMany({ data: { city: "Chattanooga", postalCode: "37402" } });
    const res = await get(token);
    expect(res.body.data[0].jurisdictionSource).toBe("default");
  });

  it("honours a per-property jurisdiction override", async () => {
    await prisma.property.updateMany({ data: { jurisdictionId: "nashville" } });
    const res = await get(token);
    expect(res.body.data[0].jurisdictionId).toBe("nashville");
    expect(res.body.data[0].jurisdictionSource).toBe("property");
  });

  it("includes the schedule and customer context the tech needs on site", async () => {
    const res = await get(token);
    const assignment = res.body.data[0];
    expect(assignment.scheduledStart).toBe("2026-08-04T14:00:00.000Z");
    expect(assignment.customerName).toBe("Hollis");
    expect(assignment.customerPhone).toBe("+16155550123");
    expect(assignment.jobType).toBe("Health inspection");
    expect(assignment.visitStatus).toBe("scheduled");
    expect(assignment.role).toBe("primary");
  });

  it("reports the property's most recent inspection date", async () => {
    const res0 = await get(token);
    expect(res0.body.data[0].lastInspectionDate).toBeNull();

    const visit = await prisma.visit.findUniqueOrThrow({ where: { id: visitId } });
    for (const date of ["2024-05-01", "2026-01-15"]) {
      await prisma.healthInspection.create({
        data: {
          id: `insp-${date}`,
          visitId, propertyId: visit.propertyId, customerId: visit.customerId,
          jurisdictionId: "murfreesboro", inspectionDate: new Date(date),
          score: 80, itemsAssessed: 28,
          criticalFindingsJson: "[]", itemsJson: "[]",
        },
      });
    }

    const res = await get(token);
    expect(res.body.data[0].lastInspectionDate).toContain("2026-01-15");
  });

  it("rejects a request with no technician token", async () => {
    const res = await request(app).get("/health-record/assignments");
    expect(res.status).toBe(401);
  });
});
