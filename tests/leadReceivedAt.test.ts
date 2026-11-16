import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

vi.mock("../src/services/twilio");
vi.mock("googleapis");

import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { getFunnelReport, type FunnelRange } from "../src/services/leadFunnel";
import { getLeadFunnelMetrics } from "../src/services/crmAnalytics";
import { ensurePriceBookGates, HD_SUPPLIER_ID } from "./helpers/priceBookFixture";

/**
 * "Original received date" and "Marketplace link" on a lead (plan lead-intake-fixes F3; Kyle,
 * 2026-11-15: count by "the month the lead really arrived").
 *
 * `Lead.receivedAt` is the day it reached Red Cedar; `createdAt` is only when the row was typed in.
 * The routes store a typed day at noon UTC (shared/calendarDay.ts) and refuse a day in the future;
 * the Leads list, the funnel (both the range and the quote attribution) and the Dashboard stage
 * counts read receivedAt.
 */

const TAG = "LRA";
const MARK = "LRA32";
const NOON = (ymd: string) => new Date(`${ymd}T12:00:00.000Z`);

async function wipeRoutes() {
  await prisma.lead.deleteMany({ where: { name: { startsWith: TAG } } });
}

const newLead = (overrides: Record<string, unknown> = {}) => ({ name: `${TAG} Jim Robinson`, ...overrides });

describe("POST /crm/leads — receivedAt and sourceUrl", () => {
  beforeEach(wipeRoutes);
  afterAll(wipeRoutes);

  it("stores a typed day at noon UTC, so it reads as that day in Chicago, and leaves createdAt as the entry moment", async () => {
    const res = await request(app).post("/crm/leads")
      .send(newLead({ receivedAt: "2026-10-20", sourceUrl: "https://www.angi.com/leads/9" })).expect(201);
    expect(res.body.lead.receivedAt).toBe("2026-10-20T12:00:00.000Z");
    expect(res.body.lead.sourceUrl).toBe("https://www.angi.com/leads/9");
    expect(Date.now() - new Date(res.body.lead.createdAt).getTime()).toBeLessThan(60_000);
    const row = await prisma.lead.findUniqueOrThrow({ where: { id: res.body.lead.id } });
    expect(row.receivedAt.toISOString()).toBe("2026-10-20T12:00:00.000Z");
  });

  it("a blank received date is NOW — never 1970, never null (the form sends null for a blank box)", async () => {
    for (const blank of [null, "", undefined]) {
      const body = newLead(blank === undefined ? {} : { receivedAt: blank });
      const res = await request(app).post("/crm/leads").send(body).expect(201);
      const received = new Date(res.body.lead.receivedAt).getTime();
      expect(received).toBeGreaterThan(Date.now() - 60_000);
      expect(received).toBeLessThanOrEqual(Date.now() + 1000);
      expect(res.body.lead.sourceUrl).toBeNull();
    }
  });

  it("refuses a day in the future, an unreadable date, and today-in-Chicago is fine", async () => {
    const res = await request(app).post("/crm/leads").send(newLead({ receivedAt: "2099-01-01" })).expect(400);
    expect(JSON.stringify(res.body)).toContain("Original received date cannot be in the future");
    await request(app).post("/crm/leads").send(newLead({ receivedAt: "not a date" })).expect(400);
    expect(await prisma.lead.count({ where: { name: { startsWith: TAG } } })).toBe(0);
  });

  it("accepts only an http or https link, and blank clears it", async () => {
    for (const bad of ["javascript:alert(1)", "ftp://example.com/x", "angi.com/leads/9", "not a url", `https://x.test/${"a".repeat(2100)}`]) {
      await request(app).post("/crm/leads").send(newLead({ sourceUrl: bad })).expect(400);
    }
    const blank = await request(app).post("/crm/leads").send(newLead({ sourceUrl: "  " })).expect(201);
    expect(blank.body.lead.sourceUrl).toBeNull();
    const nul = await request(app).post("/crm/leads").send(newLead({ sourceUrl: null })).expect(201);
    expect(nul.body.lead.sourceUrl).toBeNull();
    const http = await request(app).post("/crm/leads").send(newLead({ sourceUrl: "http://example.com/a?b=1" })).expect(201);
    expect(http.body.lead.sourceUrl).toBe("http://example.com/a?b=1");
  });
});

describe("PATCH /leads/:leadId — receivedAt and sourceUrl", () => {
  beforeEach(wipeRoutes);
  afterAll(wipeRoutes);

  async function makeLead() {
    const res = await request(app).post("/crm/leads").send(newLead()).expect(201);
    return res.body.lead as { id: string; createdAt: string; receivedAt: string };
  }

  it("sets both, then clears the link with blank or null", async () => {
    const lead = await makeLead();
    const set = await request(app).patch(`/leads/${lead.id}`)
      .send({ receivedAt: "2026-10-20", sourceUrl: "https://www.yelp.com/biz_leads/abc" }).expect(200);
    expect(set.body.receivedAt).toBe("2026-10-20T12:00:00.000Z");
    expect(set.body.sourceUrl).toBe("https://www.yelp.com/biz_leads/abc");

    const blank = await request(app).patch(`/leads/${lead.id}`).send({ sourceUrl: "" }).expect(200);
    expect(blank.body.sourceUrl).toBeNull();
    await request(app).patch(`/leads/${lead.id}`).send({ sourceUrl: "https://example.com/z" }).expect(200);
    const nul = await request(app).patch(`/leads/${lead.id}`).send({ sourceUrl: null }).expect(200);
    expect(nul.body.sourceUrl).toBeNull();
  });

  it("a blank received date puts the lead back on the day the row was entered (the column is not null)", async () => {
    const lead = await makeLead();
    await request(app).patch(`/leads/${lead.id}`).send({ receivedAt: "2026-10-20" }).expect(200);
    for (const blank of ["", null]) {
      await request(app).patch(`/leads/${lead.id}`).send({ receivedAt: "2026-10-20" }).expect(200);
      const res = await request(app).patch(`/leads/${lead.id}`).send({ receivedAt: blank }).expect(200);
      expect(res.body.receivedAt).toBe(lead.createdAt);
    }
  });

  it("refuses a future day, a bad link, and a wrong type — and writes nothing", async () => {
    const lead = await makeLead();
    const future = await request(app).patch(`/leads/${lead.id}`).send({ receivedAt: "2099-01-01" }).expect(400);
    expect(future.body.error).toBe("Original received date cannot be in the future");
    await request(app).patch(`/leads/${lead.id}`).send({ receivedAt: "garbage" }).expect(400);
    await request(app).patch(`/leads/${lead.id}`).send({ receivedAt: 12345 }).expect(400);
    for (const bad of ["javascript:alert(1)", "ftp://x.test/a", "just words"]) {
      const res = await request(app).patch(`/leads/${lead.id}`).send({ sourceUrl: bad }).expect(400);
      expect(res.body.error).toBe("Marketplace link must start with http:// or https://");
    }
    await request(app).patch(`/leads/${lead.id}`).send({ sourceUrl: 42 }).expect(400);
    const row = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(row.receivedAt.toISOString()).toBe(lead.receivedAt);
    expect(row.sourceUrl).toBeNull();
  });

  it("an edit that does not mention the date never moves it", async () => {
    const lead = await makeLead();
    await request(app).patch(`/leads/${lead.id}`).send({ receivedAt: "2026-10-20" }).expect(200);
    const res = await request(app).patch(`/leads/${lead.id}`).send({ name: `${TAG} Renamed`, notes: "x" }).expect(200);
    expect(res.body.receivedAt).toBe("2026-10-20T12:00:00.000Z");
  });
});

describe("GET /leads — newest arrival first", () => {
  beforeEach(wipeRoutes);
  afterAll(wipeRoutes);

  it("orders by the day the lead arrived, not the day it was typed in", async () => {
    // Typed in the other way round: the later-ENTERED lead is the OLDER arrival.
    const first = await request(app).post("/crm/leads").send(newLead({ name: `${TAG} Arrived October`, receivedAt: "2026-10-20" })).expect(201);
    const second = await request(app).post("/crm/leads").send(newLead({ name: `${TAG} Arrived September`, receivedAt: "2026-09-02" })).expect(201);
    const third = await request(app).post("/crm/leads").send(newLead({ name: `${TAG} Arrived today` })).expect(201);
    expect(first.body.lead.id).not.toBe(second.body.lead.id);
    expect(third.body.lead.id).toBeTruthy();

    const res = await request(app).get("/leads").expect(200);
    const names = (res.body as Array<{ name: string }>).map((l) => l.name).filter((n) => n.startsWith(TAG));
    expect(names).toEqual([`${TAG} Arrived today`, `${TAG} Arrived October`, `${TAG} Arrived September`]);
  });
});

describe("the funnel and the Dashboard count by the month the lead really arrived", () => {
  const RANGE: FunnelRange = {
    start: new Date("2032-03-01T00:00:00.000Z"),
    end: new Date("2032-03-31T23:59:59.999Z"),
    startDate: "2032-03-01",
    endDate: "2032-03-31",
  };
  let customerId: string;
  let propertyId: string;
  let draftId: string;

  beforeAll(async () => {
    await ensurePriceBookGates();
    const draft = await prisma.priceBookDraftEstimate.create({ data: { title: `${MARK} draft`, supplierId: HD_SUPPLIER_ID } });
    draftId = draft.id;
    const customer = await prisma.customer.create({ data: { name: `${MARK} account`, platform: "yelp" } });
    customerId = customer.id;
    const property = await prisma.property.create({
      data: { customerId, name: `${MARK} house`, addressLine1: "1 Funnel Way", city: "Smyrna", state: "TN", postalCode: "37167" },
    });
    propertyId = property.id;

    const make = (name: string, data: Record<string, unknown>) =>
      prisma.lead.create({ data: { name: `${MARK} ${name}`, source: "manual", platform: "yelp", ...data } });
    // Arrived in March, typed in LATER than the quote below went out.
    await make("L1 arrived March", {
      status: "converted", leadStatus: "won", customerId, createdAt: NOON("2032-03-20"), receivedAt: NOON("2032-03-01"),
    });
    // Entered in March, but it really arrived in February.
    await make("L2 arrived February", { status: "new", leadStatus: "new", createdAt: NOON("2032-03-06"), receivedAt: NOON("2032-02-20") });
    // Entered in May, but it really arrived in March.
    await make("L3 arrived March", { status: "new", leadStatus: "new", createdAt: NOON("2032-05-10"), receivedAt: NOON("2032-03-08") });

    // A quote with no lead link, issued Mar 10 on the account: L1's receivedAt (Mar 1) is before it,
    // its createdAt (Mar 20) is after it. Ranking on createdAt would credit nobody.
    await prisma.issuedEstimate.create({
      data: {
        number: `${MARK}-1`, revision: 1, status: "sent", token: `${MARK}-tok-1`, draftId, customerId,
        serviceAddressId: propertyId, customerName: `${MARK} customer`, title: `${MARK} quote`,
        workSubtotal: 1000, total: 1000, createdAt: NOON("2032-03-10"),
      },
    });
  });

  afterAll(async () => {
    await prisma.issuedEstimate.deleteMany({ where: { customerId } });
    await prisma.lead.deleteMany({ where: { name: { startsWith: MARK } } });
    await prisma.priceBookDraftEstimate.deleteMany({ where: { id: draftId } });
    await prisma.property.deleteMany({ where: { customerId } });
    await prisma.customer.deleteMany({ where: { id: customerId } });
  });

  it("phase 1 counts the leads that arrived in the range, whenever they were typed in", async () => {
    const report = await getFunnelReport(prisma, RANGE);
    expect(report.opportunity.leads).toBe(2); // L1 and L3 — not L2, which only LOOKS like March.
    expect(report.opportunity.opportunities).toBe(1);
  });

  it("phase 2 attributes a quote to a lead that ARRIVED before it was issued", async () => {
    const report = await getFunnelReport(prisma, RANGE);
    expect(report.quoted.leads).toBe(2);
    expect(report.quoted.quoted).toBe(1);
  });

  it("the Dashboard stage counts follow the same date", async () => {
    const metrics = await getLeadFunnelMetrics({
      start: RANGE.start, end: RANGE.end, startDate: RANGE.startDate, endDate: RANGE.endDate,
    });
    expect(metrics.total).toBe(2);
    expect(metrics.opportunityCount).toBe(1);
    expect(metrics.openCount).toBe(1);
  });
});
