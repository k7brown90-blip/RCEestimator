/**
 * Job costing — the money invariant.
 *
 * The whole reason rollupJobCosts() was extracted is that GET /jobs and
 * GET /accounts/:id/summary must never quote different numbers for the same job.
 * The integration test at the bottom is the one that actually protects that.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { prisma } from "../src/lib/prisma";
import {
  DEFAULT_LABOR_RATE,
  estimateOptionTotal,
  rollupJobCosts,
  sumJobCosts,
} from "../src/services/jobCosting";

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

const noCosts = {
  estimatedCost: null,
  actualMaterialCost: null,
  laborHours: null,
  overheadAllocation: null,
  revenue: null,
};

describe("rollupJobCosts", () => {
  it("treats every null money field as zero cost and unknown revenue", () => {
    const costs = rollupJobCosts(noCosts, null);
    expect(costs.materialCost).toBe(0);
    expect(costs.laborCost).toBe(0);
    expect(costs.overhead).toBe(0);
    expect(costs.totalCost).toBe(0);
    expect(costs.revenue).toBeNull();
    // No revenue means profit and margin are unknown, not zero — a zero here
    // would read as "this job broke even", which is a different claim.
    expect(costs.grossProfit).toBeNull();
    expect(costs.margin).toBeNull();
  });

  it("computes labor from hours x rate and rolls up total cost", () => {
    const costs = rollupJobCosts(
      { ...noCosts, actualMaterialCost: 400, laborHours: 8, overheadAllocation: 100, revenue: 2000 },
      null,
      75,
    );
    expect(costs.laborCost).toBe(600);
    expect(costs.totalCost).toBe(1100);
    expect(costs.grossProfit).toBe(900);
    expect(costs.margin).toBe(45);
  });

  it("honours an explicit labor rate over the default", () => {
    const cheap = rollupJobCosts({ ...noCosts, laborHours: 10 }, null, 50);
    const dear = rollupJobCosts({ ...noCosts, laborHours: 10 }, null, 125);
    expect(cheap.laborCost).toBe(500);
    expect(dear.laborCost).toBe(1250);
    expect(rollupJobCosts({ ...noCosts, laborHours: 10 }, null).laborRate).toBe(DEFAULT_LABOR_RATE);
  });

  it("prefers recorded revenue over the accepted estimate option", () => {
    // Visit.revenue is what someone typed after the job closed; it always wins.
    const recorded = rollupJobCosts({ ...noCosts, revenue: 1800 }, 2500);
    expect(recorded.revenue).toBe(1800);

    const projected = rollupJobCosts(noCosts, 2500);
    expect(projected.revenue).toBe(2500);
  });

  it("reports a negative margin rather than clamping at zero", () => {
    const costs = rollupJobCosts(
      { ...noCosts, actualMaterialCost: 1500, revenue: 1000 },
      null,
    );
    expect(costs.grossProfit).toBe(-500);
    expect(costs.margin).toBe(-50);
  });

  it("does not divide by zero when revenue is recorded as 0", () => {
    const costs = rollupJobCosts({ ...noCosts, revenue: 0, actualMaterialCost: 100 }, null);
    expect(costs.revenue).toBe(0);
    expect(costs.grossProfit).toBe(-100);
    expect(costs.margin).toBeNull();
  });
});

describe("estimateOptionTotal", () => {
  it("returns the accepted option when one exists", () => {
    const { acceptedTotal, displayTotal } = estimateOptionTotal([
      { accepted: false, totalCost: 5000 },
      { accepted: true, totalCost: 3000 },
    ]);
    expect(acceptedTotal).toBe(3000);
    expect(displayTotal).toBe(3000);
  });

  it("falls back to the highest option for display but credits no revenue", () => {
    const { acceptedTotal, displayTotal } = estimateOptionTotal([
      { accepted: false, totalCost: 5000 },
      { accepted: false, totalCost: 3000 },
    ]);
    // Nothing accepted → nothing to book as revenue…
    expect(acceptedTotal).toBeNull();
    // …but the tab should still show what's on the table.
    expect(displayTotal).toBe(5000);
  });

  it("handles an estimate with no options", () => {
    expect(estimateOptionTotal([])).toEqual({ acceptedTotal: null, displayTotal: null });
  });
});

describe("sumJobCosts", () => {
  it("skips unknown revenue instead of counting it as zero", () => {
    const totals = sumJobCosts([
      rollupJobCosts({ ...noCosts, revenue: 1000, actualMaterialCost: 400 }, null),
      rollupJobCosts({ ...noCosts, actualMaterialCost: 200 }, null), // revenue unknown
    ]);
    expect(totals.lifetimeRevenue).toBe(1000);
    expect(totals.lifetimeCost).toBe(600);
    expect(totals.lifetimeProfit).toBe(400);
    expect(totals.lifetimeMargin).toBe(40);
  });

  it("returns a null margin for an account that has never billed", () => {
    expect(sumJobCosts([]).lifetimeMargin).toBeNull();
  });
});

// ─── THE INVARIANT ─────────────────────────────────────────────────────────────

describe("GET /jobs and GET /accounts/:id/summary agree about money", () => {
  let customerId: string;
  let visitId: string;

  beforeEach(async () => {
    await prisma.receipt.deleteMany();
    await prisma.visit.deleteMany();
    await prisma.property.deleteMany();
    await prisma.customer.deleteMany();
    await prisma.companySetting.deleteMany();

    const customer = await prisma.customer.create({
      data: { name: "Costing Invariant Co", phone: "+16155550101" },
    });
    customerId = customer.id;
    const property = await prisma.property.create({
      data: {
        customerId,
        name: "Main",
        addressLine1: "88 Ledger Ln",
        city: "Murfreesboro",
        state: "TN",
        postalCode: "37130",
      },
    });
    const visit = await prisma.visit.create({
      data: {
        customerId,
        propertyId: property.id,
        mode: "service_diagnostic",
        status: "completed",
        actualMaterialCost: 612.5,
        laborHours: 6.5,
        overheadAllocation: 90,
        revenue: 2400,
      },
    });
    visitId = visit.id;
  });

  afterAll(async () => {
    await prisma.receipt.deleteMany();
    await prisma.visit.deleteMany();
    await prisma.property.deleteMany();
    await prisma.customer.deleteMany();
    await prisma.companySetting.deleteMany();
  });

  it("produces byte-identical cost objects from both endpoints", async () => {
    const jobs = await request(app).get("/jobs");
    const summary = await request(app).get(`/accounts/${customerId}/summary`);
    expect(jobs.status).toBe(200);
    expect(summary.status).toBe(200);

    const fromJobs = jobs.body.find((j: { visitId: string }) => j.visitId === visitId).costs;
    const fromSummary = summary.body.jobs.find((j: { visitId: string }) => j.visitId === visitId).costs;
    expect(fromSummary).toEqual(fromJobs);
    expect(fromJobs.laborCost).toBe(6.5 * DEFAULT_LABOR_RATE);
  });

  it("both endpoints pick up a labor rate change from company settings", async () => {
    await request(app).put("/crm/settings/companyProfile").send({ laborRate: 110 });

    const jobs = await request(app).get("/jobs");
    const summary = await request(app).get(`/accounts/${customerId}/summary`);

    const fromJobs = jobs.body.find((j: { visitId: string }) => j.visitId === visitId).costs;
    const fromSummary = summary.body.jobs.find((j: { visitId: string }) => j.visitId === visitId).costs;
    expect(fromJobs.laborRate).toBe(110);
    expect(fromJobs.laborCost).toBe(6.5 * 110);
    expect(fromSummary).toEqual(fromJobs);
  });

  it("ignores a malformed labor rate rather than costing every job at NaN", async () => {
    await request(app).put("/crm/settings/companyProfile").send({ laborRate: "not a number" });
    const jobs = await request(app).get("/jobs");
    const costs = jobs.body.find((j: { visitId: string }) => j.visitId === visitId).costs;
    expect(costs.laborRate).toBe(DEFAULT_LABOR_RATE);
    expect(Number.isFinite(costs.laborCost)).toBe(true);
  });

  it("rolls account lifetime totals off the same per-job costs", async () => {
    const summary = await request(app).get(`/accounts/${customerId}/summary`);
    const job = summary.body.jobs[0];
    expect(summary.body.totals.lifetimeRevenue).toBe(job.costs.revenue);
    expect(summary.body.totals.lifetimeCost).toBe(job.costs.totalCost);
    expect(summary.body.totals.completedJobCount).toBe(1);
    expect(summary.body.totals.activeJobCount).toBe(0);
  });
});

describe("GET /jobs ?archived", () => {
  let customerId: string;

  beforeEach(async () => {
    await prisma.visit.deleteMany();
    await prisma.property.deleteMany();
    await prisma.customer.deleteMany();

    const customer = await prisma.customer.create({ data: { name: "Archive Co" } });
    customerId = customer.id;
    const property = await prisma.property.create({
      data: {
        customerId, name: "Main", addressLine1: "1 Archive Way",
        city: "Franklin", state: "TN", postalCode: "37064",
      },
    });
    for (const status of ["estimate", "contracted", "scheduled", "in_progress", "completed", "cancelled"]) {
      await prisma.visit.create({
        data: { customerId, propertyId: property.id, mode: "remodel", status },
      });
    }
  });

  afterAll(async () => {
    await prisma.visit.deleteMany();
    await prisma.property.deleteMany();
    await prisma.customer.deleteMany();
  });

  it("returns everything when the filter is absent, so existing callers are unaffected", async () => {
    const res = await request(app).get("/jobs");
    expect(res.body).toHaveLength(6);
  });

  it("archived=true returns only completed and cancelled", async () => {
    const res = await request(app).get("/jobs?archived=true");
    expect(res.body.map((j: { status: string }) => j.status).sort()).toEqual(["cancelled", "completed"]);
  });

  it("archived=false returns everything still in flight", async () => {
    const res = await request(app).get("/jobs?archived=false");
    expect(res.body.map((j: { status: string }) => j.status).sort()).toEqual(
      ["contracted", "estimate", "in_progress", "scheduled"],
    );
  });

  it("exposes the schedule fields the calendar and Jobs tab need", async () => {
    const res = await request(app).get("/jobs");
    const job = res.body[0];
    expect(job).toHaveProperty("status");
    expect(job).toHaveProperty("scheduledStart");
    expect(job).toHaveProperty("estimatedDurationDays");
    expect(job).toHaveProperty("confirmationStatus");
    expect(Array.isArray(job.technicians)).toBe(true);
  });
});
