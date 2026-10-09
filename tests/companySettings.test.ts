/**
 * Company settings — flexible key-value config store behind the PIN session.
 * Covers key validation, upsert round-trips, and the aggregate GET shape.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { prisma } from "../src/lib/prisma";

// No PIN_HASH in test env — pinAuthMiddleware passes through (dev/test mode).
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

beforeEach(async () => {
  await prisma.companySetting.deleteMany();
});

afterAll(async () => {
  await prisma.companySetting.deleteMany();
});

describe("Company settings store", () => {
  it("returns an empty object when nothing is configured", async () => {
    const res = await request(app).get("/crm/settings");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
  });

  it("rejects unknown settings keys", async () => {
    const res = await request(app)
      .put("/crm/settings/nonsense")
      .send({ any: "thing" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Unknown settings key/);
  });

  it("saves and returns a company profile", async () => {
    const profile = {
      companyName: "Red Cedar Electric LLC",
      phone: "(731) 462-0443",
      licenseNumber: "TN-12345",
      insuranceCarrier: "Acme Mutual",
    };
    const put = await request(app).put("/crm/settings/companyProfile").send(profile);
    expect(put.status).toBe(200);
    expect(put.body.key).toBe("companyProfile");
    expect(put.body.value.licenseNumber).toBe("TN-12345");

    const get = await request(app).get("/crm/settings");
    expect(get.body.companyProfile.companyName).toBe("Red Cedar Electric LLC");
  });

  it("saves territories with utility contacts and inspector info per ZIP", async () => {
    const territories = [
      {
        zip: "37064",
        area: "Franklin",
        codeCycle: "NEC 2017",
        utilityProvider: "Middle Tennessee Electric",
        utilityPhone: "615-555-0100",
        utilityEmail: "dispatch@mte.example",
        utilityNotes: "48h notice for planned power cuts",
        inspectorName: "J. Smith",
        inspectorPhone: "615-555-0199",
        inspectorEmail: "jsmith@franklin.example",
        inspectorNotes: "Books 2 days out",
      },
    ];
    const put = await request(app).put("/crm/settings/territories").send(territories);
    expect(put.status).toBe(200);

    const get = await request(app).get("/crm/settings");
    expect(get.body.territories).toHaveLength(1);
    expect(get.body.territories[0].utilityPhone).toBe("615-555-0100");
    expect(get.body.territories[0].inspectorName).toBe("J. Smith");
  });

  it("upserts — second PUT to the same key replaces the value", async () => {
    await request(app).put("/crm/settings/operatingHours").send({ weekdays: "8-5" });
    await request(app).put("/crm/settings/operatingHours").send({ weekdays: "7-4", saturday: "Closed" });

    const get = await request(app).get("/crm/settings");
    expect(get.body.operatingHours).toEqual({ weekdays: "7-4", saturday: "Closed" });

    const rows = await prisma.companySetting.findMany({ where: { key: "operatingHours" } });
    expect(rows).toHaveLength(1);
  });

  /**
   * Payroll (Kyle, 2026-10-08, decision 10): "Employer cost on top of wages (%)" is a PERCENT —
   * 9.5 means 9.5%. A fraction (0.095) would burden labor by a tenth of a percent and overstate
   * every job's profit, so it is refused; so is anything over 50 (a typo). Null clears it.
   */
  it("payroll: employer cost on top of wages is a percent between 0 and 50; fractions are refused; null clears", async () => {
    const saved = await request(app).put("/crm/settings/payroll").send({ employerCostPercent: 9.5 });
    expect(saved.status).toBe(200);
    expect(saved.body.value).toEqual({ employerCostPercent: 9.5 });
    expect((await request(app).get("/crm/settings")).body.payroll).toEqual({ employerCostPercent: 9.5 });

    const fraction = await request(app).put("/crm/settings/payroll").send({ employerCostPercent: 0.095 });
    expect(fraction.status).toBe(400);
    expect(fraction.body.error).toMatch(/PERCENT.*not a fraction/);

    const typo = await request(app).put("/crm/settings/payroll").send({ employerCostPercent: 95 });
    expect(typo.status).toBe(400);
    expect(typo.body.error).toMatch(/more than 50%/);

    expect((await request(app).put("/crm/settings/payroll").send({ employerCostPercent: -1 })).status).toBe(400);
    expect((await request(app).put("/crm/settings/payroll").send({ employerCostPercent: "nine" })).status).toBe(400);
    expect((await request(app).put("/crm/settings/payroll").send([9.5])).status).toBe(400);

    // Zero is a real answer (set, and 0%), unlike "not set".
    expect((await request(app).put("/crm/settings/payroll").send({ employerCostPercent: 0 })).body.value).toEqual({ employerCostPercent: 0 });

    const cleared = await request(app).put("/crm/settings/payroll").send({ employerCostPercent: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.value).toEqual({ employerCostPercent: null });
    // A refused value never replaced the stored one.
    expect((await request(app).get("/crm/settings")).body.payroll).toEqual({ employerCostPercent: null });
  });
});
