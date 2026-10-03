/**
 * What Kyle schedules by hand takes priority over a Google Calendar block (2026-10-02).
 *
 * Kyle: "I am not scheduling Michael I am scheduling myself and his schedule is blocking me" and
 * "I want what I manually schedule in this system to take priority." Production: a job for Oct 6-7
 * assigned to Kyle Brown got a 409 "Calendar conflict: Wednesday, October 7: Busy: 12:00 AM-12:00 AM"
 * — an all-day "ON CALL" on Michael Schramm's own calendar.
 *
 * Pinned here:
 *  - a booking reads ONLY the assigned technician's calendar, so another tech's block never refuses it;
 *  - when the assigned tech's own calendar is busy the refusal NAMES that calendar and says "all day"
 *    for an all-day block, and is overridable ("Schedule anyway");
 *  - with no technician picked the whole company set is still checked (and the refusal is overridable);
 *  - the agent paths (no options) keep the hard company-wide block and the old `Busy:` wording;
 *  - the CRM routes carry `overrideCalendarConflict` and answer `canOverride` ONLY for a calendar conflict.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { prisma } from "../src/lib/prisma";

process.env.GOOGLE_CLIENT_ID = "test_id";
process.env.GOOGLE_CLIENT_SECRET = "test_secret";
process.env.GOOGLE_REFRESH_TOKEN = "test_token";
// Kyle's operator texts are off by default (automationGate); the "blocked reschedule texts Kyle"
// assertions below need them on to be able to see — or rule out — that text.
process.env.TWILIO_SENDS_OPERATOR_NOTIFICATIONS = "true";

const cal = vi.hoisted(() => ({
  /** calendar id -> busy periods the mocked freebusy answers with */
  busy: {} as Record<string, Array<{ start: string; end: string }>>,
  /** the `items` of every freebusy query, in order */
  queried: [] as string[][],
}));

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
        freebusy: {
          query: vi.fn().mockImplementation((params: { requestBody: { items: Array<{ id: string }> } }) => {
            const ids = params.requestBody.items.map((i) => i.id);
            cal.queried.push(ids);
            return Promise.resolve({
              data: { calendars: Object.fromEntries(ids.map((id) => [id, { busy: cal.busy[id] ?? [] }])) },
            });
          }),
        },
        events: {
          insert: vi.fn().mockImplementation((params: { requestBody: { summary: string; start: unknown; end: unknown } }) =>
            Promise.resolve({ data: { id: `gcal_msbc_${Math.random().toString(36).slice(2)}`, ...params.requestBody } })),
          patch: vi.fn().mockResolvedValue({ data: { id: "gcal_moved" } }),
          delete: vi.fn().mockResolvedValue({}),
          // The job's "own event" lookup on a reschedule — dated far from anything under test.
          get: vi.fn().mockResolvedValue({
            data: { id: "own", start: { dateTime: "2000-01-01T15:00:00.000Z" }, end: { dateTime: "2000-01-01T20:00:00.000Z" } },
          }),
          list: vi.fn().mockResolvedValue({ data: { items: [] } }),
        },
      }),
    },
  };
});

import { app } from "../src/app";
import { sendSms } from "../src/services/twilio";
import { scheduleJob, rescheduleJob, ConflictError } from "../src/services/scheduling";
import { checkAvailabilityBlock } from "../src/services/schedule";

// Oct 2031 is on daylight time (CDT, UTC-5): Monday the 6th, Tuesday the 7th.
const MON = "2031-10-06";
const TUE = "2031-10-07";
/** Tuesday as an all-day event comes back from freebusy: midnight CT to midnight CT. */
const TUE_ALL_DAY = [{ start: "2031-10-07T05:00:00Z", end: "2031-10-08T05:00:00Z" }];
/** Tuesday 2:00-5:00 PM CT. */
const TUE_AFTERNOON = [{ start: "2031-10-07T19:00:00Z", end: "2031-10-07T22:00:00Z" }];

const KYLE_EMAIL = "msbc-kyle@example.com";
const MICHAEL_EMAIL = "msbc-michael@example.com";

let customerId: string;
let propertyId: string;
let kyleId: string;
let michaelId: string;
const visitIds: string[] = [];

async function makeJob(status = "contracted") {
  const v = await prisma.visit.create({
    data: { customerId, propertyId, mode: "service_diagnostic", status, estimatedDurationDays: 2 },
  });
  visitIds.push(v.id);
  return v;
}

/** What the CRM routes pass so a conflict names whose calendar is busy. Agents never do. */
const NAMED = { nameCalendarOwners: true } as const;

/** Mon 9:00 AM -> Tue 5:00 PM, exactly as the CRM scheduler sends it. */
const MON_TO_TUE = { date: TUE, time: "17:00" };

beforeEach(async () => {
  cal.busy = {};
  cal.queried = [];
  vi.mocked(sendSms).mockClear();
  await prisma.slotHold.deleteMany({ where: { holdDate: { in: [MON, TUE] } } });
  await prisma.visitAssignment.deleteMany({ where: { visitId: { in: visitIds } } });

  if (!customerId) {
    const customer = await prisma.customer.create({
      data: { name: "MSBC Customer", phone: "+16155550177", email: "msbc@example.com" },
    });
    customerId = customer.id;
    const property = await prisma.property.create({
      data: { customerId, name: "Main", addressLine1: "9 Override Ln", city: "Murfreesboro", state: "TN", postalCode: "37130" },
    });
    propertyId = property.id;
    kyleId = (await prisma.technician.create({
      data: { name: "MSBC Kyle Brown", email: KYLE_EMAIL, accessToken: `msbc-kyle-${Date.now()}-${Math.random()}` },
    })).id;
    michaelId = (await prisma.technician.create({
      data: { name: "MSBC Michael Schramm", email: MICHAEL_EMAIL, accessToken: `msbc-michael-${Date.now()}-${Math.random()}` },
    })).id;
  }
});

afterAll(async () => {
  await prisma.slotHold.deleteMany({ where: { holdDate: { in: [MON, TUE] } } });
  await prisma.visitAssignment.deleteMany({ where: { visitId: { in: visitIds } } });
  await prisma.visit.deleteMany({ where: { id: { in: visitIds } } });
  await prisma.technician.deleteMany({ where: { name: { startsWith: "MSBC " } } });
  await prisma.property.deleteMany({ where: { name: "Main", addressLine1: "9 Override Ln" } });
  await prisma.customer.deleteMany({ where: { name: "MSBC Customer" } });
});

describe("a booking reads only the assigned technician's calendar", () => {
  it("books Kyle when only Michael's calendar is busy — and asks Google for Kyle's calendar alone", async () => {
    cal.busy[MICHAEL_EMAIL] = TUE_ALL_DAY;
    const job = await makeJob();

    const result = await scheduleJob(job.id, MON, "09:00", kyleId, MON_TO_TUE);

    expect(result.scheduledStart).toBeInstanceOf(Date);
    expect(cal.queried.at(-1)).toEqual([KYLE_EMAIL]);
    const stored = await prisma.visit.findUniqueOrThrow({ where: { id: job.id } });
    expect(stored.status).toBe("scheduled");
  });

  it("refuses when the assigned tech's own calendar is busy, naming whose and saying all day", async () => {
    cal.busy[MICHAEL_EMAIL] = TUE_ALL_DAY;
    const job = await makeJob();

    const err = await scheduleJob(job.id, MON, "09:00", michaelId, MON_TO_TUE, NAMED).catch((e) => e);

    expect(err).toBeInstanceOf(ConflictError);
    expect(err.officeMessage).toBe("MSBC Michael Schramm's calendar is busy all day Tuesday, October 7");
    expect(err.officeMessage).not.toMatch(/12:00 AM/);
    // The plain message stays the legacy string — no technician name in it.
    expect(err.message).toMatch(/^Calendar conflict: Tuesday, October 7: Busy: /);
    expect(err.message).not.toMatch(/MSBC/);
    expect(err.canOverride).toBe(true);
    expect(cal.queried.at(-1)).toEqual([MICHAEL_EMAIL]);
    // Nothing was booked.
    const stored = await prisma.visit.findUniqueOrThrow({ where: { id: job.id } });
    expect(stored.scheduledStart).toBeNull();
    expect(stored.status).toBe("contracted");
  });

  it("names the clock span, not 'all day', when the block is only part of the day", async () => {
    cal.busy[MICHAEL_EMAIL] = TUE_AFTERNOON;
    const job = await makeJob();

    const err = await scheduleJob(job.id, MON, "09:00", michaelId, MON_TO_TUE, NAMED).catch((e) => e);

    expect(err).toBeInstanceOf(ConflictError);
    expect(err.officeMessage).toBe("MSBC Michael Schramm's calendar is busy 2:00 PM–5:00 PM Tuesday, October 7");
  });

  it("books over that conflict when the CRM says Schedule anyway", async () => {
    cal.busy[MICHAEL_EMAIL] = TUE_ALL_DAY;
    const job = await makeJob();

    const result = await scheduleJob(job.id, MON, "09:00", michaelId, MON_TO_TUE, { overrideCalendarConflict: true });

    expect(result.googleEventId).toBeTruthy();
    const stored = await prisma.visit.findUniqueOrThrow({ where: { id: job.id } });
    expect(stored.status).toBe("scheduled");
    const assignment = await prisma.visitAssignment.findUnique({
      where: { visitId_technicianId: { visitId: job.id, technicianId: michaelId } },
    });
    expect(assignment?.role).toBe("primary");
  });

  it("with no technician picked still checks the whole company set — and that refusal is overridable", async () => {
    cal.busy[MICHAEL_EMAIL] = TUE_ALL_DAY;
    const job = await makeJob();

    const err = await scheduleJob(job.id, MON, "09:00", null, MON_TO_TUE, NAMED).catch((e) => e);

    expect(err).toBeInstanceOf(ConflictError);
    expect(err.officeMessage).toContain("MSBC Michael Schramm's calendar is busy all day Tuesday, October 7");
    expect(err.canOverride).toBe(true);
    const asked = cal.queried.at(-1)!;
    expect(asked).toEqual(expect.arrayContaining(["primary", KYLE_EMAIL, MICHAEL_EMAIL]));

    await expect(scheduleJob(job.id, MON, "09:00", null, MON_TO_TUE, { overrideCalendarConflict: true }))
      .resolves.toMatchObject({ jobId: job.id });
  });

  it("names the company calendar for a block on 'primary'", async () => {
    cal.busy.primary = TUE_ALL_DAY;
    const job = await makeJob();

    const err = await scheduleJob(job.id, MON, "09:00", null, MON_TO_TUE, NAMED).catch((e) => e);

    expect(err).toBeInstanceOf(ConflictError);
    expect(err.officeMessage).toContain("The company calendar is busy all day Tuesday, October 7");
  });
});

describe("the agent paths keep the hard company-wide block", () => {
  it("scheduleJob with no technician and no options still throws on a busy calendar", async () => {
    cal.busy[MICHAEL_EMAIL] = TUE_ALL_DAY;
    const job = await makeJob();

    await expect(scheduleJob(job.id, TUE, "09:00")).rejects.toBeInstanceOf(ConflictError);
    const asked = cal.queried.at(-1)!;
    expect(asked).toEqual(expect.arrayContaining(["primary", KYLE_EMAIL, MICHAEL_EMAIL]));
  });

  it("an agent-path conflict keeps the exact old message — and no technician name anywhere in it", async () => {
    cal.busy[MICHAEL_EMAIL] = TUE_AFTERNOON;
    const job = await makeJob();

    const err = await scheduleJob(job.id, TUE, "09:00").catch((e) => e);

    expect(err).toBeInstanceOf(ConflictError);
    // agent-jerry / agent-savannah pass err.message straight into the agent JSON.
    expect(err.message).toBe("Calendar conflict: Tuesday, October 7: Busy: 2:00 PM–5:00 PM");
    expect(err.officeMessage).toBeUndefined();
    expect(JSON.stringify(err.conflicts)).not.toMatch(/MSBC|Michael|Schramm/);
    expect(err.conflicts[0]).not.toHaveProperty("message");
  });

  it("checkAvailabilityBlock with no calendar named keeps the old 'Busy:' reason and queries the union", async () => {
    cal.busy.primary = TUE_AFTERNOON;

    const result = await checkAvailabilityBlock(new Date("2031-10-07T12:00:00Z"), 1);

    expect(result.available).toBe(false);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].date).toBe("Tuesday, October 7");
    expect(result.conflicts[0].reason).toBe("Busy: 2:00 PM–5:00 PM");
    // agent-shared.ts returns `conflicts` to the voice agent wholesale: no named sentence unless asked for.
    expect(result.conflicts[0]).not.toHaveProperty("message");
    expect(cal.queried.at(-1)).toEqual(expect.arrayContaining(["primary", KYLE_EMAIL, MICHAEL_EMAIL]));

    cal.busy.primary = [];
    cal.busy[MICHAEL_EMAIL] = TUE_AFTERNOON;
    const unnamed = await checkAvailabilityBlock(new Date("2031-10-07T12:00:00Z"), 1);
    expect(JSON.stringify(unnamed)).not.toMatch(/MSBC|Michael|Schramm/);
    const named = await checkAvailabilityBlock(new Date("2031-10-07T12:00:00Z"), 1, undefined, undefined, undefined, true);
    expect(named.conflicts[0].message).toBe("MSBC Michael Schramm's calendar is busy 2:00 PM–5:00 PM Tuesday, October 7");
  });

  it("the same appointment on two calendars is one span in the legacy reason", async () => {
    cal.busy.primary = TUE_AFTERNOON;
    cal.busy[KYLE_EMAIL] = TUE_AFTERNOON;

    const result = await checkAvailabilityBlock(new Date("2031-10-07T12:00:00Z"), 1);

    expect(result.conflicts[0].reason).toBe("Busy: 2:00 PM–5:00 PM");
  });
});

describe("rescheduling", () => {
  it("from the CRM checks the job's current tech, so another tech's block does not refuse it", async () => {
    const job = await makeJob();
    await scheduleJob(job.id, MON, "09:00", kyleId, { date: MON, time: "17:00" });
    cal.busy[MICHAEL_EMAIL] = TUE_ALL_DAY;

    const result = await rescheduleJob(
      job.id, TUE, "09:00", "customer asked", { date: TUE, time: "17:00" }, null,
      { scopeToCurrentTech: true },
    );

    expect(result.jobId).toBe(job.id);
    expect(cal.queried.at(-1)).toEqual([KYLE_EMAIL]);
  });

  it("from an agent (no options, no tech) keeps the company-wide hard block and texts Kyle", async () => {
    const job = await makeJob();
    await scheduleJob(job.id, MON, "09:00", kyleId, { date: MON, time: "17:00" });
    cal.busy[MICHAEL_EMAIL] = TUE_ALL_DAY;
    vi.mocked(sendSms).mockClear();

    await expect(rescheduleJob(job.id, TUE, "09:00", "customer asked", { date: TUE, time: "17:00" }))
      .rejects.toBeInstanceOf(ConflictError);
    expect(cal.queried.at(-1)).toEqual(expect.arrayContaining(["primary", KYLE_EMAIL, MICHAEL_EMAIL]));
    expect(vi.mocked(sendSms).mock.calls.some((c) => String(c[1]).includes("RESCHEDULE ATTEMPTED"))).toBe(true);
  });

  it("onto a newly picked tech whose calendar is busy: named conflict, then Reschedule anyway — with no 'blocked' text to Kyle", async () => {
    const job = await makeJob();
    await scheduleJob(job.id, MON, "09:00", kyleId, { date: MON, time: "17:00" });
    cal.busy[MICHAEL_EMAIL] = TUE_ALL_DAY;

    const err = await rescheduleJob(
      job.id, TUE, "09:00", "swap tech", { date: TUE, time: "17:00" }, michaelId,
      { scopeToCurrentTech: true, nameCalendarOwners: true },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.officeMessage).toBe("MSBC Michael Schramm's calendar is busy all day Tuesday, October 7");
    expect(err.message).not.toMatch(/MSBC/);
    expect(err.canOverride).toBe(true);

    vi.mocked(sendSms).mockClear();
    const result = await rescheduleJob(
      job.id, TUE, "09:00", "swap tech", { date: TUE, time: "17:00" }, michaelId,
      { scopeToCurrentTech: true, overrideCalendarConflict: true },
    );
    expect(result.jobId).toBe(job.id);
    expect(vi.mocked(sendSms).mock.calls.some((c) => String(c[1]).includes("RESCHEDULE ATTEMPTED"))).toBe(false);
  });
});

describe("the CRM routes", () => {
  it("POST /crm/jobs/:id/schedule answers 409 canOverride:true for a calendar conflict, and 200 with overrideCalendarConflict", async () => {
    cal.busy[MICHAEL_EMAIL] = TUE_ALL_DAY;
    const job = await makeJob();
    const body = { startDate: MON, startTime: "09:00", endDate: TUE, endTime: "17:00", technicianId: michaelId };

    const refused = await request(app).post(`/crm/jobs/${job.id}/schedule`).send(body);
    expect(refused.status).toBe(409);
    expect(refused.body.canOverride).toBe(true);
    expect(refused.body.error).toBe("MSBC Michael Schramm's calendar is busy all day Tuesday, October 7");

    const booked = await request(app).post(`/crm/jobs/${job.id}/schedule`).send({ ...body, overrideCalendarConflict: true });
    expect(booked.status).toBe(200);
  });

  it("books Kyle on the same day Michael is blocked, no override needed", async () => {
    cal.busy[MICHAEL_EMAIL] = TUE_ALL_DAY;
    const job = await makeJob();

    const res = await request(app)
      .post(`/crm/jobs/${job.id}/schedule`)
      .send({ startDate: MON, startTime: "09:00", endDate: TUE, endTime: "17:00", technicianId: kyleId });

    expect(res.status).toBe(200);
  });

  it("an end before the start is a 409 that does NOT offer an override", async () => {
    const job = await makeJob();

    const res = await request(app)
      .post(`/crm/jobs/${job.id}/schedule`)
      .send({ startDate: TUE, startTime: "09:00", endDate: MON, endTime: "17:00", overrideCalendarConflict: true });

    expect(res.status).toBe(409);
    expect(res.body.canOverride).toBe(false);
  });

  it("a slot being held by someone else is a 409 that does NOT offer an override, even with the flag", async () => {
    const job = await makeJob();
    await prisma.slotHold.create({
      data: { holdDate: MON, heldBy: "savannah", expiresAt: new Date(Date.now() + 60_000) },
    });

    const res = await request(app)
      .post(`/crm/jobs/${job.id}/schedule`)
      .send({ startDate: MON, startTime: "09:00", endDate: TUE, endTime: "17:00", overrideCalendarConflict: true });

    expect(res.status).toBe(409);
    expect(res.body.canOverride).toBe(false);
    expect(res.body.error).toMatch(/Another booking is in progress/);
  });

  it("POST /crm/jobs/:id/reschedule carries the override too", async () => {
    const job = await makeJob();
    await scheduleJob(job.id, MON, "09:00", michaelId, { date: MON, time: "17:00" }, { overrideCalendarConflict: true });
    cal.busy[MICHAEL_EMAIL] = TUE_ALL_DAY;
    const body = { newStartDate: TUE, newStartTime: "09:00", endDate: TUE, endTime: "17:00", reason: "customer asked" };

    // No tech named: the job's current tech (Michael) is the one checked.
    const refused = await request(app).post(`/crm/jobs/${job.id}/reschedule`).send(body);
    expect(refused.status).toBe(409);
    expect(refused.body.canOverride).toBe(true);

    const moved = await request(app).post(`/crm/jobs/${job.id}/reschedule`).send({ ...body, overrideCalendarConflict: true });
    expect(moved.status).toBe(200);
  });
});
