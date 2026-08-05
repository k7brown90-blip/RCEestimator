/**
 * Estimate appointments — 2-hour block plus an hour of travel leeway.
 *
 * The distinction that matters: production work claims whole business days
 * through SlotHold because the crew is committed; an estimate books by the hour
 * and takes no hold, so the rest of the day stays sellable. Getting this wrong
 * in either direction is expensive — either the calendar double-books estimates,
 * or a 90-minute site visit burns a whole day of capacity.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { prisma } from "../src/lib/prisma";
import {
  ESTIMATE_BLOCK_MINUTES,
  ESTIMATE_TRAVEL_BUFFER_MINUTES,
  appointmentKindFor,
} from "../src/services/scheduling";

// getCalendarClient() checks for credentials before it ever touches googleapis,
// so the mock below is unreachable without these.
process.env.GOOGLE_CLIENT_ID = "test_id";
process.env.GOOGLE_CLIENT_SECRET = "test_secret";
process.env.GOOGLE_REFRESH_TOKEN = "test_token";

vi.mock("../src/services/twilio", () => ({
  sendSms: vi.fn().mockResolvedValue({ sid: "SM_mock" }),
  KYLE_PHONE: "+19706661626",
  isFromKyle: vi.fn().mockReturnValue(false),
}));

const insertedEvents: { start: Date; end: Date; summary: string }[] = [];

vi.mock("googleapis", () => {
  class MockOAuth2 {
    setCredentials() {}
  }
  return {
    google: {
      auth: { OAuth2: MockOAuth2 },
      calendar: () => ({
        freebusy: {
          query: vi.fn().mockResolvedValue({ data: { calendars: { primary: { busy: [] } } } }),
        },
        events: {
          insert: vi.fn().mockImplementation((params: {
            requestBody: { summary: string; start: { dateTime: string }; end: { dateTime: string } };
          }) => {
            const body = params.requestBody;
            insertedEvents.push({
              summary: body.summary,
              start: new Date(body.start.dateTime),
              end: new Date(body.end.dateTime),
            });
            return Promise.resolve({
              data: {
                id: `gcal_${insertedEvents.length}`,
                summary: body.summary,
                start: body.start,
                end: body.end,
              },
            });
          }),
          patch: vi.fn().mockImplementation((params: {
            requestBody: { start: { dateTime: string }; end: { dateTime: string } };
          }) => {
            const body = params.requestBody;
            insertedEvents.push({
              summary: "moved",
              start: new Date(body.start.dateTime),
              end: new Date(body.end.dateTime),
            });
            return Promise.resolve({
              data: { id: "gcal_moved", summary: "moved", start: body.start, end: body.end },
            });
          }),
          delete: vi.fn().mockResolvedValue({}),
          get: vi.fn().mockResolvedValue({
            data: { id: "gcal_1", start: { dateTime: new Date().toISOString() }, end: { dateTime: new Date().toISOString() } },
          }),
          list: vi.fn().mockResolvedValue({ data: { items: [] } }),
        },
      }),
    },
  };
});

import { app } from "../src/app";

let customerId: string;
let propertyId: string;

async function makeVisit(status: string, estimatedDurationDays?: number) {
  return prisma.visit.create({
    data: { customerId, propertyId, mode: "service_diagnostic", status, estimatedDurationDays },
  });
}

const minutesBetween = (a: Date, b: Date) => (b.getTime() - a.getTime()) / 60_000;

beforeEach(async () => {
  insertedEvents.length = 0;
  await prisma.slotHold.deleteMany();
  await prisma.visit.deleteMany();
  await prisma.property.deleteMany();
  await prisma.customer.deleteMany();

  const customer = await prisma.customer.create({
    data: { name: "Estimate Co", phone: "+16155550188", email: "est@example.com" },
  });
  customerId = customer.id;
  const property = await prisma.property.create({
    data: {
      customerId, name: "Main", addressLine1: "5 Quote Rd",
      city: "Murfreesboro", state: "TN", postalCode: "37130",
    },
  });
  propertyId = property.id;
});

afterAll(async () => {
  await prisma.slotHold.deleteMany();
  await prisma.visit.deleteMany();
  await prisma.property.deleteMany();
  await prisma.customer.deleteMany();
});

describe("appointmentKindFor", () => {
  it("derives the kind from visit status so it can never disagree with the record", () => {
    expect(appointmentKindFor("estimate")).toBe("estimate");
    expect(appointmentKindFor("contracted")).toBe("production");
    expect(appointmentKindFor("scheduled")).toBe("production");
    expect(appointmentKindFor("in_progress")).toBe("production");
  });
});

describe("Scheduling an estimate visit", () => {
  it("books a 2-hour block and reports the travel buffer", async () => {
    const visit = await makeVisit("estimate");
    const res = await request(app)
      .post(`/crm/jobs/${visit.id}/schedule`)
      .send({ startDate: "2026-08-04", startTime: "09:00" });

    expect(res.status).toBe(200);
    expect(res.body.appointmentKind).toBe("estimate");
    expect(res.body.travelBufferMinutes).toBe(ESTIMATE_TRAVEL_BUFFER_MINUTES);

    const start = new Date(res.body.scheduledStart);
    const end = new Date(res.body.scheduledEnd);
    expect(minutesBetween(start, end)).toBe(ESTIMATE_BLOCK_MINUTES);
  });

  it("reserves the travel leeway on the calendar event, not on the visit record", async () => {
    const visit = await makeVisit("estimate");
    await request(app)
      .post(`/crm/jobs/${visit.id}/schedule`)
      .send({ startDate: "2026-08-04", startTime: "09:00" });

    // The visit stores the customer-facing window (2 h)…
    const stored = await prisma.visit.findUniqueOrThrow({ where: { id: visit.id } });
    expect(minutesBetween(stored.scheduledStart!, stored.scheduledEnd!)).toBe(ESTIMATE_BLOCK_MINUTES);

    // …while the calendar blocks the drive too, so availability accounts for it.
    const event = insertedEvents.at(-1)!;
    expect(minutesBetween(event.start, event.end)).toBe(
      ESTIMATE_BLOCK_MINUTES + ESTIMATE_TRAVEL_BUFFER_MINUTES,
    );
    expect(event.summary).toMatch(/^ESTIMATE:/);
  });

  it("takes no slot hold, leaving the day bookable for production work", async () => {
    const visit = await makeVisit("estimate");
    await request(app)
      .post(`/crm/jobs/${visit.id}/schedule`)
      .send({ startDate: "2026-08-04", startTime: "09:00" });

    expect(await prisma.slotHold.count()).toBe(0);
  });

  it("leaves the visit at status 'estimate' — booked-ness lives in scheduledStart", async () => {
    // Flipping to "scheduled" here would make a booked estimate report itself as
    // production work, and would silently give it a whole-day footprint.
    const visit = await makeVisit("estimate");
    await request(app)
      .post(`/crm/jobs/${visit.id}/schedule`)
      .send({ startDate: "2026-08-04", startTime: "09:00" });

    const stored = await prisma.visit.findUniqueOrThrow({ where: { id: visit.id } });
    expect(stored.status).toBe("estimate");
    expect(stored.scheduledStart).not.toBeNull();
  });

  it("ignores estimatedDurationDays — that describes the work, not the visit pricing it", async () => {
    const visit = await makeVisit("estimate", 5);
    const res = await request(app)
      .post(`/crm/jobs/${visit.id}/schedule`)
      .send({ startDate: "2026-08-04", startTime: "09:00" });

    expect(res.body.durationDays).toBe(1);
    expect(minutesBetween(new Date(res.body.scheduledStart), new Date(res.body.scheduledEnd)))
      .toBe(ESTIMATE_BLOCK_MINUTES);
  });

  it("keeps the 2-hour shape and the buffer across a reschedule", async () => {
    const visit = await makeVisit("estimate");
    await request(app)
      .post(`/crm/jobs/${visit.id}/schedule`)
      .send({ startDate: "2026-08-04", startTime: "09:00" });

    const res = await request(app)
      .post(`/crm/jobs/${visit.id}/reschedule`)
      .send({ newStartDate: "2026-08-06", newStartTime: "13:00", reason: "customer request" });

    expect(res.status).toBe(200);
    expect(res.body.appointmentKind).toBe("estimate");
    expect(minutesBetween(new Date(res.body.scheduledStart), new Date(res.body.scheduledEnd)))
      .toBe(ESTIMATE_BLOCK_MINUTES);

    // newStartTime was silently dropped from the zod schema for a while, so a
    // rescheduled 13:00 came out at 07:00 (the DEFAULT_JOB_START_TIME) and Kyle
    // reported it as "the reschedule didn't take". Pin the actual time.
    const scheduledStart = new Date(res.body.scheduledStart);
    const ctHour = Number(
      new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Chicago", hour: "2-digit", hour12: false,
      }).format(scheduledStart),
    );
    expect(ctHour).toBe(13);

    const moved = insertedEvents.at(-1)!;
    expect(minutesBetween(moved.start, moved.end)).toBe(
      ESTIMATE_BLOCK_MINUTES + ESTIMATE_TRAVEL_BUFFER_MINUTES,
    );
    expect(await prisma.slotHold.count()).toBe(0);
  });
});

describe("Scheduling contracted production work", () => {
  it("still claims whole business days and flips status to scheduled", async () => {
    const visit = await makeVisit("contracted", 2);
    const res = await request(app)
      .post(`/crm/jobs/${visit.id}/schedule`)
      .send({ startDate: "2026-08-04", startTime: "07:00" });

    expect(res.status).toBe(200);
    expect(res.body.appointmentKind).toBe("production");
    expect(res.body.travelBufferMinutes).toBe(0);
    expect(res.body.durationDays).toBe(2);

    const stored = await prisma.visit.findUniqueOrThrow({ where: { id: visit.id } });
    expect(stored.status).toBe("scheduled");

    const event = insertedEvents.at(-1)!;
    expect(event.summary).toMatch(/^JOB:/);
  });

  it("releases its slot holds once the calendar event owns the days", async () => {
    const visit = await makeVisit("contracted", 1);
    await request(app)
      .post(`/crm/jobs/${visit.id}/schedule`)
      .send({ startDate: "2026-08-04", startTime: "07:00" });

    expect(await prisma.slotHold.count()).toBe(0);
  });
});

describe("Schedulable statuses", () => {
  it("rejects a job that hasn't reached the estimate stage", async () => {
    const visit = await makeVisit("in_progress");
    const res = await request(app)
      .post(`/crm/jobs/${visit.id}/schedule`)
      .send({ startDate: "2026-08-04" });

    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe("GET /crm/schedule/calendar", () => {
  it("returns booked visits as appointments with their kind and buffer", async () => {
    const estimate = await makeVisit("estimate");
    await request(app)
      .post(`/crm/jobs/${estimate.id}/schedule`)
      .send({ startDate: "2026-08-04", startTime: "09:00" });

    const res = await request(app).get("/crm/schedule/calendar?start=2026-08-01&end=2026-08-31");
    expect(res.status).toBe(200);

    const appointment = res.body.appointments.find(
      (a: { visitId: string }) => a.visitId === estimate.id,
    );
    expect(appointment.appointmentKind).toBe("estimate");
    expect(appointment.travelBufferMinutes).toBe(ESTIMATE_TRAVEL_BUFFER_MINUTES);
    expect(appointment.address).toContain("5 Quote Rd");
  });

  it("lists unbooked estimate and contracted work in the needs-scheduling rail", async () => {
    const waiting = await makeVisit("estimate");
    const res = await request(app).get("/crm/schedule/calendar?start=2026-08-01&end=2026-08-31");

    const ids = res.body.unscheduled.map((u: { visitId: string }) => u.visitId);
    expect(ids).toContain(waiting.id);
  });

  it("keeps a cancelled visit off the calendar", async () => {
    const cancelled = await prisma.visit.create({
      data: {
        customerId, propertyId, mode: "remodel", status: "cancelled",
        scheduledStart: new Date("2026-08-04T14:00:00.000Z"),
      },
    });
    const res = await request(app).get("/crm/schedule/calendar?start=2026-08-01&end=2026-08-31");
    const ids = res.body.appointments.map((a: { visitId: string }) => a.visitId);
    expect(ids).not.toContain(cancelled.id);
  });

  it("still returns the CRM's own schedule when the Google overlay is unavailable", async () => {
    // A calendar outage must degrade the overlay, not blank the page.
    const res = await request(app).get("/crm/schedule/calendar?start=2026-08-01&end=2026-08-31");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.googleOnlyEvents)).toBe(true);
  });
});
