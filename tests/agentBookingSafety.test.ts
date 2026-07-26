/**
 * Tier 2 — voice-agent booking safety.
 *
 * Slot holds: atomic day-claims that close the check-then-book race between
 * the availability read and the calendar write.
 * Call dispositions: structured end-of-call outcomes so no call leaves the
 * pipeline without a lead state.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { prisma } from "../src/lib/prisma";
import {
  acquireSlotHolds,
  releaseSlotHolds,
  workingDaysCT,
  SlotContentionError,
  HOLD_TTL_MS,
} from "../src/services/slotHolds";

const TOKEN = process.env.AGENT_API_TOKEN ?? "test-agent-token";
process.env.AGENT_API_TOKEN = TOKEN;
// Google client env stubs — the googleapis module itself is mocked below.
process.env.GOOGLE_CLIENT_ID = "test_id";
process.env.GOOGLE_CLIENT_SECRET = "test_secret";
process.env.GOOGLE_REFRESH_TOKEN = "test_token";

// Mock Twilio + Google Calendar the same way agentScheduling.test.ts does.
vi.mock("../src/services/twilio", () => ({
  sendSms: vi.fn().mockResolvedValue({ sid: "SM_mock_sid" }),
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
          query: vi.fn().mockResolvedValue({ data: { calendars: { primary: { busy: [] } } } }),
        },
        events: {
          insert: vi.fn().mockResolvedValue({
            data: { id: "gcal_mock_id", summary: "Test", start: { dateTime: new Date().toISOString() }, end: { dateTime: new Date().toISOString() } },
          }),
          delete: vi.fn().mockResolvedValue({}),
          patch: vi.fn().mockResolvedValue({ data: { id: "gcal_mock_id" } }),
          get: vi.fn().mockResolvedValue({ data: { id: "gcal_mock_id" } }),
          list: vi.fn().mockResolvedValue({ data: { items: [] } }),
        },
      }),
    },
  };
});

// Import after mocks so the mocked modules are wired in.
import { app } from "../src/app";
import { scheduleJob, ConflictError } from "../src/services/scheduling";

beforeEach(async () => {
  await prisma.slotHold.deleteMany();
  await prisma.agentIdempotency.deleteMany();
  await prisma.lead.deleteMany({ where: { name: { startsWith: "T2 " } } });
});

afterAll(async () => {
  await prisma.slotHold.deleteMany();
  await prisma.lead.deleteMany({ where: { name: { startsWith: "T2 " } } });
  await prisma.visit.deleteMany({ where: { purpose: "T2 slot hold test" } });
  await prisma.property.deleteMany({ where: { name: "T2 House" } });
  await prisma.customer.deleteMany({ where: { name: "T2 Customer" } });
});

describe("workingDaysCT", () => {
  it("lists consecutive business days, skipping Sundays", () => {
    // 2026-08-01 is a Saturday (CT) — a 3-day job spans Sat, Mon, Tue.
    const start = new Date("2026-08-01T12:00:00-05:00");
    expect(workingDaysCT(start, 3)).toEqual(["2026-08-01", "2026-08-03", "2026-08-04"]);
  });

  it("single-day job claims exactly one date", () => {
    expect(workingDaysCT(new Date("2026-08-05T12:00:00-05:00"), 1)).toEqual(["2026-08-05"]);
  });
});

describe("slot hold acquisition", () => {
  it("second claim on a held date throws SlotContentionError", async () => {
    await acquireSlotHolds(["2026-09-01"], "savannah");
    await expect(acquireSlotHolds(["2026-09-01"], "jerry")).rejects.toThrow(SlotContentionError);
  });

  it("multi-day claims are all-or-nothing", async () => {
    await acquireSlotHolds(["2026-09-02"], "savannah");
    await expect(acquireSlotHolds(["2026-09-01", "2026-09-02"], "jerry")).rejects.toThrow(SlotContentionError);
    // The losing claim must not leave a partial hold on the free day.
    expect(await prisma.slotHold.count({ where: { holdDate: "2026-09-01" } })).toBe(0);
  });

  it("released dates can be claimed again", async () => {
    await acquireSlotHolds(["2026-09-03"], "savannah");
    await releaseSlotHolds(["2026-09-03"]);
    await expect(acquireSlotHolds(["2026-09-03"], "jerry")).resolves.toBeUndefined();
  });

  it("expired holds do not block a new claim", async () => {
    await prisma.slotHold.create({
      data: { holdDate: "2026-09-04", heldBy: "crashed-process", expiresAt: new Date(Date.now() - 1000) },
    });
    await expect(acquireSlotHolds(["2026-09-04"], "savannah")).resolves.toBeUndefined();
    const hold = await prisma.slotHold.findFirst({ where: { holdDate: "2026-09-04" } });
    expect(hold?.heldBy).toBe("savannah");
    expect(hold!.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(hold!.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + HOLD_TTL_MS + 1000);
  });

  it("concurrency: exactly one of five simultaneous claims wins", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) => acquireSlotHolds(["2026-09-05"], `caller-${i}`)),
    );
    const wins = results.filter((r) => r.status === "fulfilled").length;
    const losses = results.filter(
      (r) => r.status === "rejected" && r.reason instanceof SlotContentionError,
    ).length;
    expect(wins).toBe(1);
    expect(losses).toBe(4);
  });
});

describe("scheduleJob race protection", () => {
  async function contractedJob() {
    const customer = await prisma.customer.create({ data: { name: "T2 Customer", phone: "+16155550142" } });
    const property = await prisma.property.create({
      data: {
        customerId: customer.id, name: "T2 House", addressLine1: "1 Race Ct",
        city: "Murfreesboro", state: "TN", postalCode: "37127",
      },
    });
    return prisma.visit.create({
      data: {
        propertyId: property.id, customerId: customer.id, mode: "job",
        purpose: "T2 slot hold test", status: "contracted", jobType: "Panel swap",
        estimatedDurationDays: 1,
      },
    });
  }

  it("a foreign in-flight hold turns into a spoken ConflictError", async () => {
    const job = await contractedJob();
    await acquireSlotHolds(["2026-10-05"], "another-caller");
    await expect(scheduleJob(job.id, "2026-10-05")).rejects.toThrow(ConflictError);
    await expect(scheduleJob(job.id, "2026-10-05")).rejects.toThrow(/booking is in progress/);
  });

  it("a successful booking releases its holds (calendar event takes over)", async () => {
    const job = await contractedJob();
    const result = await scheduleJob(job.id, "2026-10-06");
    expect(result.googleEventId).toBe("gcal_mock_id");
    expect(await prisma.slotHold.count()).toBe(0);
    const updated = await prisma.visit.findUnique({ where: { id: job.id } });
    expect(updated?.status).toBe("scheduled");
  });
});

describe("Vapi /calendar/book race protection", () => {
  it("a foreign in-flight hold on the slot returns 409 with a spoken fallback", async () => {
    // 10:00 AM CT on 2026-10-07 — the slot key the booking will compute.
    await acquireSlotHolds(["2026-10-07T10:00"], "another-caller");
    const res = await request(app)
      .post("/calendar/book")
      .send({
        date: "Wednesday, October 7, 2026",
        startTime: "10:00 AM",
        customerName: "T2 Race Caller",
        description: "Estimate — panel upgrade",
        address: "2 Race Ct, Murfreesboro, TN",
      })
      .expect(409);
    expect(res.body.spoken_fallback).toContain("unavailable");
  });

  it("a clean booking verifies the window, creates the event, and releases its hold", async () => {
    const res = await request(app)
      .post("/calendar/book")
      .send({
        date: "Thursday, October 8, 2026",
        startTime: "10:00 AM",
        customerName: "T2 Clean Caller",
        description: "Estimate — EV charger",
        address: "3 Race Ct, Murfreesboro, TN",
      })
      .expect(200);
    expect(res.body.eventId).toBe("gcal_mock_id");
    expect(await prisma.slotHold.count()).toBe(0);
  });

  it("appointment slot keys never collide with job day-block holds", async () => {
    await acquireSlotHolds(["2026-10-09"], "scheduler"); // day-block job hold
    await expect(acquireSlotHolds(["2026-10-09T10:00"], "vapi-booking")).resolves.toBeUndefined();
  });
});

describe("call disposition endpoint", () => {
  it("rejects unauthenticated calls", async () => {
    await request(app)
      .post("/agent/calendar/call-disposition")
      .send({ call_type: "new_job", lead_status: "booked", name: "T2 Caller" })
      .expect(401);
  });

  it("creates a lead when nothing matches, so the outcome is never dropped", async () => {
    const res = await request(app)
      .post("/agent/calendar/call-disposition")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({
        name: "T2 New Caller",
        phone: "615-555-0177",
        call_type: "new_job",
        lead_status: "planning",
        follow_up_date: "2026-08-15",
        follow_up_reason: "comparing_estimates",
        notes: "Wants EV charger quote after vacation",
      })
      .expect(200);
    expect(res.body.data.lead_created).toBe(true);

    const lead = await prisma.lead.findUnique({ where: { id: res.body.data.lead_id } });
    expect(lead?.leadStatus).toBe("planning");
    expect(lead?.phone).toBe("+16155550177");
    expect(lead?.followUpDate).not.toBeNull();
    expect(lead?.notes).toContain("EV charger");
  });

  it("updates the most recent lead matched by phone and appends the note", async () => {
    const existing = await prisma.lead.create({
      data: { name: "T2 Repeat Caller", phone: "+16155550188", source: "phone", notes: "first contact" },
    });
    const res = await request(app)
      .post("/agent/calendar/call-disposition")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ phone: "6155550188", call_type: "callback", lead_status: "booked" })
      .expect(200);
    expect(res.body.data.lead_id).toBe(existing.id);
    expect(res.body.data.lead_created).toBe(false);

    const updated = await prisma.lead.findUnique({ where: { id: existing.id } });
    expect(updated?.leadStatus).toBe("booked");
    expect(updated?.notes).toContain("first contact");
    expect(updated?.notes).toContain("callback/booked");
  });

  it("is idempotent by x-client-request-id (Vapi retries)", async () => {
    const send = () =>
      request(app)
        .post("/agent/calendar/call-disposition")
        .set("Authorization", `Bearer ${TOKEN}`)
        .set("x-client-request-id", "t2-disposition-retry-1")
        .send({ name: "T2 Retry Caller", call_type: "new_job", lead_status: "unresolved" })
        .expect(200);
    const first = await send();
    const second = await send();
    expect(second.body.data.lead_id).toBe(first.body.data.lead_id);
    expect(await prisma.lead.count({ where: { name: "T2 Retry Caller" } })).toBe(1);
  });

  it("requires some way to attach the outcome to a lead", async () => {
    await request(app)
      .post("/agent/calendar/call-disposition")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ call_type: "new_job", lead_status: "booked" })
      .expect(422);
  });
});
