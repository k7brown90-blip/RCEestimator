/**
 * Slot-hold and scheduleJob race safety.
 *
 * Slot holds: atomic day-claims that close the check-then-book race between
 * the availability read and the calendar write.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/lib/prisma";
import {
  acquireSlotHolds,
  releaseSlotHolds,
  workingDaysCT,
  SlotContentionError,
  HOLD_TTL_MS,
} from "../src/services/slotHolds";

// Google client env stubs — the googleapis module itself is mocked below.
process.env.GOOGLE_CLIENT_ID = "test_id";
process.env.GOOGLE_CLIENT_SECRET = "test_secret";
process.env.GOOGLE_REFRESH_TOKEN = "test_token";

// Mock Twilio + Google Calendar.
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
import { scheduleJob, ConflictError } from "../src/services/scheduling";

beforeEach(async () => {
  await prisma.slotHold.deleteMany();
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
  it("lists consecutive calendar days — weekends count (Kyle, 2026-08-30)", () => {
    // 2026-08-01 is a Saturday (CT) — a 3-day job spans Sat, Sun, Mon.
    const start = new Date("2026-08-01T12:00:00-05:00");
    expect(workingDaysCT(start, 3)).toEqual(["2026-08-01", "2026-08-02", "2026-08-03"]);
  });

  it("single-day job claims exactly one date", () => {
    expect(workingDaysCT(new Date("2026-08-05T12:00:00-05:00"), 1)).toEqual(["2026-08-05"]);
  });
});

describe("slot hold acquisition", () => {
  it("second claim on a held date throws SlotContentionError", async () => {
    await acquireSlotHolds(["2026-09-01"], "holder-a");
    await expect(acquireSlotHolds(["2026-09-01"], "holder-b")).rejects.toThrow(SlotContentionError);
  });

  it("multi-day claims are all-or-nothing", async () => {
    await acquireSlotHolds(["2026-09-02"], "holder-a");
    await expect(acquireSlotHolds(["2026-09-01", "2026-09-02"], "holder-b")).rejects.toThrow(SlotContentionError);
    // The losing claim must not leave a partial hold on the free day.
    expect(await prisma.slotHold.count({ where: { holdDate: "2026-09-01" } })).toBe(0);
  });

  it("released dates can be claimed again", async () => {
    await acquireSlotHolds(["2026-09-03"], "holder-a");
    await releaseSlotHolds(["2026-09-03"]);
    await expect(acquireSlotHolds(["2026-09-03"], "holder-b")).resolves.toBeUndefined();
  });

  it("expired holds do not block a new claim", async () => {
    await prisma.slotHold.create({
      data: { holdDate: "2026-09-04", heldBy: "crashed-process", expiresAt: new Date(Date.now() - 1000) },
    });
    await expect(acquireSlotHolds(["2026-09-04"], "holder-a")).resolves.toBeUndefined();
    const hold = await prisma.slotHold.findFirst({ where: { holdDate: "2026-09-04" } });
    expect(hold?.heldBy).toBe("holder-a");
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

describe("slot hold keys", () => {
  it("appointment slot keys never collide with job day-block holds", async () => {
    await acquireSlotHolds(["2026-10-09"], "scheduler"); // day-block job hold
    await expect(acquireSlotHolds(["2026-10-09T10:00"], "booking-chat")).resolves.toBeUndefined();
  });
});
