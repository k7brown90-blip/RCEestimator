/**
 * Leads pipeline — the funnel filter behind the Leads tab.
 *
 * The Leads tab shows who has yet to be contacted or scheduled. Once a lead has
 * an appointment it belongs to the Calendar, and once it's lost or its job has
 * finished it belongs to Closed. The Lead→Visit link is a bare String column with
 * no relation, so the join is done by hand and is worth testing directly.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { prisma } from "../src/lib/prisma";

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

interface LeadRow {
  name: string;
  linkedVisit: { id: string; status: string; scheduledStart: string | null } | null;
}

const names = (body: LeadRow[]) => body.map((l) => l.name).sort();

let propertyId: string;
let customerId: string;

async function makeVisit(status: string, scheduledStart: Date | null) {
  return prisma.visit.create({
    data: {
      customerId,
      propertyId,
      mode: "service_diagnostic",
      status,
      scheduledStart,
      scheduledEnd: scheduledStart ? new Date(scheduledStart.getTime() + 7_200_000) : null,
    },
  });
}

beforeEach(async () => {
  await prisma.lead.deleteMany();
  await prisma.visit.deleteMany();
  await prisma.property.deleteMany();
  await prisma.customer.deleteMany();

  const customer = await prisma.customer.create({ data: { name: "Pipeline Co" } });
  customerId = customer.id;
  const property = await prisma.property.create({
    data: {
      customerId, name: "Main", addressLine1: "12 Funnel St",
      city: "Murfreesboro", state: "TN", postalCode: "37130",
    },
  });
  propertyId = property.id;

  const scheduledVisit = await makeVisit("scheduled", new Date("2026-08-04T13:00:00.000Z"));
  const bookedEstimate = await makeVisit("estimate", new Date("2026-08-05T13:00:00.000Z"));
  const unscheduledVisit = await makeVisit("estimate", null);
  const finishedVisit = await makeVisit("completed", null);

  await prisma.lead.createMany({
    data: [
      // Never touched — the canonical open lead.
      { name: "Brand New", status: "new", leadStatus: "new" },
      // Reached but not booked: still "yet to be scheduled", so still open.
      { name: "Contacted Only", status: "contacted", leadStatus: "planning" },
      // Converted creates a job, not an appointment — still open until booked.
      { name: "Converted Unscheduled", status: "converted", leadStatus: "new", visitId: unscheduledVisit.id },
      // Booked production work — belongs to the Calendar now.
      { name: "Booked Job", status: "converted", leadStatus: "booked", visitId: scheduledVisit.id },
      // Booked estimate visit — also scheduled, even though status is "estimate".
      { name: "Booked Estimate", status: "converted", leadStatus: "booked", visitId: bookedEstimate.id },
      // Written off two different ways. "Lost By LeadStatus" deliberately keeps
      // status="new" so the status+pipeline combination test has something to bite on.
      { name: "Lost By Status", status: "lost", leadStatus: "new" },
      { name: "Lost By LeadStatus", status: "new", leadStatus: "lost" },
      // Work is done and closed out.
      { name: "Finished Job", status: "converted", leadStatus: "won", visitId: finishedVisit.id },
    ],
  });
});

afterAll(async () => {
  await prisma.lead.deleteMany();
  await prisma.visit.deleteMany();
  await prisma.property.deleteMany();
  await prisma.customer.deleteMany();
});

describe("GET /leads ?pipeline", () => {
  it("returns every lead when no pipeline is requested", async () => {
    const res = await request(app).get("/leads");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(8);
  });

  it("open = not lost, not scheduled, job not finished", async () => {
    const res = await request(app).get("/leads?pipeline=open");
    expect(names(res.body)).toEqual(["Brand New", "Contacted Only", "Converted Unscheduled"]);
  });

  it("keeps a converted-but-unscheduled lead in open — conversion is not an appointment", async () => {
    const res = await request(app).get("/leads?pipeline=open");
    const lead = res.body.find((l: LeadRow) => l.name === "Converted Unscheduled");
    expect(lead).toBeDefined();
    expect(lead.linkedVisit.scheduledStart).toBeNull();
  });

  it("scheduled picks up booked estimates as well as booked production work", async () => {
    const res = await request(app).get("/leads?pipeline=scheduled");
    expect(names(res.body)).toEqual(["Booked Estimate", "Booked Job"]);
  });

  it("closed = lost by either status field, or a finished job", async () => {
    const res = await request(app).get("/leads?pipeline=closed");
    expect(names(res.body)).toEqual(["Finished Job", "Lost By LeadStatus", "Lost By Status"]);
  });

  it("partitions the funnel with no lead lost or double-counted", async () => {
    const [open, scheduled, closed] = await Promise.all([
      request(app).get("/leads?pipeline=open"),
      request(app).get("/leads?pipeline=scheduled"),
      request(app).get("/leads?pipeline=closed"),
    ]);
    const all = [...names(open.body), ...names(scheduled.body), ...names(closed.body)];
    expect(all).toHaveLength(8);
    expect(new Set(all).size).toBe(8);
  });

  it("attaches linkedVisit on every lead regardless of filter", async () => {
    const res = await request(app).get("/leads");
    for (const lead of res.body as LeadRow[]) {
      expect(lead).toHaveProperty("linkedVisit");
    }
    const booked = res.body.find((l: LeadRow) => l.name === "Booked Job");
    expect(booked.linkedVisit.status).toBe("scheduled");
    expect(booked.linkedVisit.scheduledStart).not.toBeNull();
    expect(res.body.find((l: LeadRow) => l.name === "Brand New").linkedVisit).toBeNull();
  });

  it("resolves the link through existingVisitId when visitId is unset", async () => {
    const visit = await makeVisit("scheduled", new Date("2026-08-10T13:00:00.000Z"));
    await prisma.lead.create({
      data: { name: "Via Existing", status: "new", leadStatus: "new", existingVisitId: visit.id },
    });
    const res = await request(app).get("/leads?pipeline=scheduled");
    expect(names(res.body)).toContain("Via Existing");
  });

  it("still honours the legacy status filter the nav badge depends on", async () => {
    const res = await request(app).get("/leads?status=new");
    expect(names(res.body)).toEqual(["Brand New", "Lost By LeadStatus"]);
  });

  it("combines the status filter with a pipeline filter", async () => {
    const res = await request(app).get("/leads?status=new&pipeline=open");
    // "Lost By LeadStatus" carries status=new but is lost, so the pipeline drops it.
    expect(names(res.body)).toEqual(["Brand New"]);
  });

  it("ignores an unrecognised pipeline value rather than returning nothing", async () => {
    const res = await request(app).get("/leads?pipeline=nonsense");
    expect(res.body).toHaveLength(8);
  });
});
