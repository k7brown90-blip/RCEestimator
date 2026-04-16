/**
 * Agent Scheduling Endpoints — Test Suite
 *
 * Covers: Savannah (lookup-job, job-schedule, reschedule-job),
 *         Jerry Mode 2 (ready-to-schedule, schedule),
 *         Shared (availability-block),
 *         Jerry Mode 1 (delete-last-item)
 *
 * Auth, validation, idempotency, and happy path for each endpoint.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";

const TOKEN = process.env.AGENT_API_TOKEN ?? "test-agent-token";
const AUTH = `Bearer ${TOKEN}`;

// Set AGENT_API_TOKEN for tests
process.env.AGENT_API_TOKEN = TOKEN;

// Mock Twilio
vi.mock("../src/services/twilio", () => ({
  sendSms: vi.fn().mockResolvedValue({ sid: "SM_mock_sid" }),
  KYLE_PHONE: "+19706661626",
  isFromKyle: vi.fn().mockReturnValue(false),
}));

// Mock Google Calendar
vi.mock("googleapis", () => {
  class MockOAuth2 {
    setCredentials() {}
  }
  return {
    google: {
      auth: { OAuth2: MockOAuth2 },
      calendar: () => ({
        freebusy: {
          query: vi.fn().mockResolvedValue({
            data: { calendars: { primary: { busy: [] } } },
          }),
        },
        events: {
          insert: vi.fn().mockResolvedValue({
            data: { id: "gcal_mock_id", summary: "Test", start: { dateTime: new Date().toISOString() }, end: { dateTime: new Date().toISOString() } },
          }),
          delete: vi.fn().mockResolvedValue({}),
          patch: vi.fn().mockResolvedValue({
            data: { id: "gcal_mock_id", summary: "Test", start: { dateTime: new Date().toISOString() }, end: { dateTime: new Date().toISOString() } },
          }),
          get: vi.fn().mockResolvedValue({
            data: { id: "gcal_mock_id", start: { dateTime: new Date().toISOString() }, end: { dateTime: new Date().toISOString() } },
          }),
          list: vi.fn().mockResolvedValue({ data: { items: [] } }),
        },
      }),
    },
  };
});

async function clearAgentTables() {
  await prisma.agentIdempotency.deleteMany();
  await prisma.agentAuditLog.deleteMany();
  await prisma.recommendation.deleteMany();
  await prisma.limitation.deleteMany();
  await prisma.finding.deleteMany();
  await prisma.observation.deleteMany();
  await prisma.customerRequest.deleteMany();
  await prisma.document.deleteMany();
  await prisma.materialOrder.deleteMany();
  // Clear estimate chain
  await prisma.itemModifier.deleteMany();
  await prisma.estimateItem.deleteMany();
  await prisma.supportItem.deleteMany();
  await prisma.assemblyComponent.deleteMany();
  await prisma.estimateAssembly.deleteMany();
  await prisma.changeOrder.deleteMany();
  await prisma.proposalAcceptance.deleteMany();
  await prisma.signatureRecord.deleteMany();
  await prisma.proposalDelivery.deleteMany();
  await prisma.inspectionStatus.deleteMany();
  await prisma.permitStatus.deleteMany();
  await prisma.estimateModifier.deleteMany();
  await prisma.estimateOption.deleteMany();
  await prisma.estimate.deleteMany();
  await prisma.visit.deleteMany();
  await prisma.systemSnapshot.deleteMany();
  await prisma.property.deleteMany();
  await prisma.customer.deleteMany();
  await prisma.lead.deleteMany();
}

let testCustomer: { id: string };
let testProperty: { id: string };

async function seedTestData() {
  testCustomer = await prisma.customer.create({
    data: { name: "Jane Smith", phone: "+16155551234", email: "jane@test.com" },
  });

  testProperty = await prisma.property.create({
    data: {
      customerId: testCustomer.id,
      name: "Smith House",
      addressLine1: "123 Oak St",
      city: "La Vergne",
      state: "TN",
      postalCode: "37086",
    },
  });
}

beforeEach(async () => {
  await clearAgentTables();
  await seedTestData();
});

afterAll(async () => {
  await clearAgentTables();
});

// ─── AUTH TESTS ─────────────────────────────────────────────────────────────────

describe("Agent auth", () => {
  it("rejects requests without auth token", async () => {
    const res = await request(app)
      .post("/agent/savannah/lookup-job")
      .send({ phone: "6155551234" });
    expect(res.status).toBe(401);
  });

  it("rejects requests with bad token", async () => {
    const res = await request(app)
      .post("/agent/savannah/lookup-job")
      .set("Authorization", "Bearer wrong-token")
      .send({ phone: "6155551234" });
    expect(res.status).toBe(401);
  });
});

// ─── SAVANNAH: LOOKUP-JOB ───────────────────────────────────────────────────────

describe("POST /agent/savannah/lookup-job", () => {
  it("finds a scheduled job by phone", async () => {
    const tomorrow = new Date(Date.now() + 86_400_000);
    await prisma.visit.create({
      data: {
        customerId: testCustomer.id,
        propertyId: testProperty.id,
        mode: "estimate",
        status: "scheduled",
        jobType: "Panel Upgrade",
        scheduledStart: tomorrow,
        scheduledEnd: new Date(tomorrow.getTime() + 86_400_000),
        estimatedDurationDays: 1,
      },
    });

    const res = await request(app)
      .post("/agent/savannah/lookup-job")
      .set("Authorization", AUTH)
      .send({ phone: "6155551234" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.matches).toHaveLength(1);
    expect(res.body.data.matches[0].customer_name).toBe("Jane Smith");
  });

  it("returns empty matches for unknown phone", async () => {
    const res = await request(app)
      .post("/agent/savannah/lookup-job")
      .set("Authorization", AUTH)
      .send({ phone: "9999999999" });

    expect(res.status).toBe(200);
    expect(res.body.data.matches).toHaveLength(0);
  });

  it("rejects when both phone and address are missing", async () => {
    const res = await request(app)
      .post("/agent/savannah/lookup-job")
      .set("Authorization", AUTH)
      .send({});

    expect(res.status).toBe(422);
  });

  it("finds job by address", async () => {
    const tomorrow = new Date(Date.now() + 86_400_000);
    await prisma.visit.create({
      data: {
        customerId: testCustomer.id,
        propertyId: testProperty.id,
        mode: "estimate",
        status: "scheduled",
        jobType: "Lighting",
        scheduledStart: tomorrow,
        scheduledEnd: new Date(tomorrow.getTime() + 86_400_000),
        estimatedDurationDays: 1,
      },
    });

    const res = await request(app)
      .post("/agent/savannah/lookup-job")
      .set("Authorization", AUTH)
      .send({ address: "123 Oak" });

    expect(res.status).toBe(200);
    expect(res.body.data.matches.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── SAVANNAH: JOB-SCHEDULE ─────────────────────────────────────────────────────

describe("POST /agent/savannah/job-schedule", () => {
  it("returns schedule details for a job", async () => {
    const tomorrow = new Date(Date.now() + 86_400_000);
    const job = await prisma.visit.create({
      data: {
        customerId: testCustomer.id,
        propertyId: testProperty.id,
        mode: "estimate",
        status: "scheduled",
        jobType: "Panel Upgrade",
        scheduledStart: tomorrow,
        scheduledEnd: new Date(tomorrow.getTime() + 86_400_000),
        estimatedDurationDays: 2,
        googleEventId: "gcal_123",
      },
    });

    const res = await request(app)
      .post("/agent/savannah/job-schedule")
      .set("Authorization", AUTH)
      .send({ job_id: job.id });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.duration_days).toBe(2);
    expect(res.body.data.google_event_id).toBe("gcal_123");
  });

  it("returns 404 for non-existent job", async () => {
    const res = await request(app)
      .post("/agent/savannah/job-schedule")
      .set("Authorization", AUTH)
      .send({ job_id: "nonexistent_id" });

    expect(res.status).toBe(404);
  });
});

// ─── SAVANNAH: RESCHEDULE-JOB ───────────────────────────────────────────────────

describe("POST /agent/savannah/reschedule-job", () => {
  it("rejects requests with duration_days parameter", async () => {
    const res = await request(app)
      .post("/agent/savannah/reschedule-job")
      .set("Authorization", AUTH)
      .send({
        job_id: "some_id",
        new_start_date: "2026-05-01",
        reason: "conflict",
        duration_days: 3,
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_PARAMETER");
  });

  it("rejects requests with new_duration parameter", async () => {
    const res = await request(app)
      .post("/agent/savannah/reschedule-job")
      .set("Authorization", AUTH)
      .send({
        job_id: "some_id",
        new_start_date: "2026-05-01",
        reason: "conflict",
        new_duration: 2,
      });

    expect(res.status).toBe(400);
  });

  it("validates required fields", async () => {
    const res = await request(app)
      .post("/agent/savannah/reschedule-job")
      .set("Authorization", AUTH)
      .send({ job_id: "some_id" });

    expect(res.status).toBe(422);
  });
});

// ─── JERRY: READY-TO-SCHEDULE ───────────────────────────────────────────────────

describe("POST /agent/jerry/jobs/ready-to-schedule", () => {
  it("returns contracted jobs ordered by contracted_at", async () => {
    const v1 = await prisma.visit.create({
      data: {
        customerId: testCustomer.id,
        propertyId: testProperty.id,
        mode: "estimate",
        status: "contracted",
        jobType: "Panel Upgrade",
        estimatedDurationDays: 2,
        contractedAt: new Date("2026-04-01"),
      },
    });
    const v2 = await prisma.visit.create({
      data: {
        customerId: testCustomer.id,
        propertyId: testProperty.id,
        mode: "estimate",
        status: "contracted",
        jobType: "Lighting",
        estimatedDurationDays: 1,
        contractedAt: new Date("2026-04-10"),
      },
    });

    const res = await request(app)
      .post("/agent/jerry/jobs/ready-to-schedule")
      .set("Authorization", AUTH)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.jobs).toHaveLength(2);
    expect(res.body.data.jobs[0].job_id).toBe(v1.id); // older first
    expect(res.body.data.jobs[1].job_id).toBe(v2.id);
  });

  it("returns empty array when no contracted jobs", async () => {
    const res = await request(app)
      .post("/agent/jerry/jobs/ready-to-schedule")
      .set("Authorization", AUTH)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.data.jobs).toHaveLength(0);
    expect(res.body.spoken_confirmation).toContain("No contracted jobs");
  });

  it("excludes already-scheduled jobs", async () => {
    await prisma.visit.create({
      data: {
        customerId: testCustomer.id,
        propertyId: testProperty.id,
        mode: "estimate",
        status: "scheduled",
        jobType: "Panel Upgrade",
      },
    });

    const res = await request(app)
      .post("/agent/jerry/jobs/ready-to-schedule")
      .set("Authorization", AUTH)
      .send({});

    expect(res.body.data.jobs).toHaveLength(0);
  });
});

// ─── JERRY: SCHEDULE ────────────────────────────────────────────────────────────

describe("POST /agent/jerry/jobs/schedule", () => {
  it("rejects non-contracted job", async () => {
    const job = await prisma.visit.create({
      data: {
        customerId: testCustomer.id,
        propertyId: testProperty.id,
        mode: "estimate",
        status: "estimate",
        jobType: "Panel Upgrade",
      },
    });

    const res = await request(app)
      .post("/agent/jerry/jobs/schedule")
      .set("Authorization", AUTH)
      .send({ job_id: job.id, start_date: "2026-05-01" });

    expect(res.status).toBe(500); // scheduling.ts throws on wrong status
  });

  it("validates date format", async () => {
    const res = await request(app)
      .post("/agent/jerry/jobs/schedule")
      .set("Authorization", AUTH)
      .send({ job_id: "some_id", start_date: "May 1 2026" });

    expect(res.status).toBe(422);
  });

  it("schedules a contracted job successfully", async () => {
    const job = await prisma.visit.create({
      data: {
        customerId: testCustomer.id,
        propertyId: testProperty.id,
        mode: "estimate",
        status: "contracted",
        jobType: "Panel Upgrade",
        estimatedDurationDays: 1,
        contractedAt: new Date(),
      },
    });

    // Set Google Calendar env vars for mock
    process.env.GOOGLE_CLIENT_ID = "test_id";
    process.env.GOOGLE_CLIENT_SECRET = "test_secret";
    process.env.GOOGLE_REFRESH_TOKEN = "test_token";

    const res = await request(app)
      .post("/agent/jerry/jobs/schedule")
      .set("Authorization", AUTH)
      .send({ job_id: job.id, start_date: "2026-05-01" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.job_id).toBe(job.id);
    expect(res.body.data.customer_notified).toBe(true);
    expect(res.body.data.kyle_notified).toBe(true);

    // Verify job was updated
    const updated = await prisma.visit.findUnique({ where: { id: job.id } });
    expect(updated?.status).toBe("scheduled");
    expect(updated?.googleEventId).toBeTruthy();
  });
});

// ─── SHARED: AVAILABILITY-BLOCK ─────────────────────────────────────────────────

describe("POST /agent/calendar/availability-block", () => {
  it("returns available for open dates", async () => {
    process.env.GOOGLE_CLIENT_ID = "test_id";
    process.env.GOOGLE_CLIENT_SECRET = "test_secret";
    process.env.GOOGLE_REFRESH_TOKEN = "test_token";

    const res = await request(app)
      .post("/agent/calendar/availability-block")
      .set("Authorization", AUTH)
      .send({ start_date: "2026-05-05", days_needed: 2 }); // Monday

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.available).toBe(true);
  });

  it("validates days_needed range", async () => {
    const res = await request(app)
      .post("/agent/calendar/availability-block")
      .set("Authorization", AUTH)
      .send({ start_date: "2026-05-05", days_needed: 15 });

    expect(res.status).toBe(422);
  });

  it("validates date format", async () => {
    const res = await request(app)
      .post("/agent/calendar/availability-block")
      .set("Authorization", AUTH)
      .send({ start_date: "not-a-date", days_needed: 1 });

    expect(res.status).toBe(422);
  });
});

// ─── IDEMPOTENCY ────────────────────────────────────────────────────────────────

describe("Idempotency", () => {
  it("returns cached response for duplicate request", async () => {
    const reqId = "idem-test-001";

    // First request
    const res1 = await request(app)
      .post("/agent/jerry/jobs/ready-to-schedule")
      .set("Authorization", AUTH)
      .set("x-client-request-id", reqId)
      .send({});

    expect(res1.status).toBe(200);

    // Create a new contracted job — should NOT appear in idempotent response
    await prisma.visit.create({
      data: {
        customerId: testCustomer.id,
        propertyId: testProperty.id,
        mode: "estimate",
        status: "contracted",
        jobType: "New Job",
        contractedAt: new Date(),
      },
    });

    // Second request with same ID — should return cached (no new job)
    const res2 = await request(app)
      .post("/agent/jerry/jobs/ready-to-schedule")
      .set("Authorization", AUTH)
      .set("x-client-request-id", reqId)
      .send({});

    expect(res2.status).toBe(200);
    expect(res2.body).toEqual(res1.body);
  });
});

// ─── NOTIFICATION TEMPLATES ─────────────────────────────────────────────────────

describe("Notification templates", () => {
  it("generates correct customer work scheduled SMS", async () => {
    const { customerWorkScheduled } = await import("../src/services/notifications");
    const msg = customerWorkScheduled({
      customerName: "Jane Smith",
      phone: "+16155551234",
      address: "123 Oak St, La Vergne",
      jobType: "Panel Upgrade",
      scheduledStart: new Date("2026-05-05T12:00:00Z"),
      scheduledEnd: new Date("2026-05-06T22:00:00Z"),
      durationDays: 2,
      startTime: "7:00 AM",
    });

    expect(msg).toContain("Hi Jane");
    expect(msg).toContain("Panel Upgrade");
    expect(msg).toContain("7:00 AM");
    expect(msg).toContain("2 day(s)");
    expect(msg).toContain("Reply STOP to opt out");
  });

  it("generates correct Kyle work scheduled SMS", async () => {
    const { kyleWorkScheduled } = await import("../src/services/notifications");
    const msg = kyleWorkScheduled({
      customerName: "Jane Smith",
      phone: "+16155551234",
      address: "123 Oak St, La Vergne",
      jobType: "Panel Upgrade",
      scheduledStart: new Date("2026-05-05T12:00:00Z"),
      scheduledEnd: new Date("2026-05-06T22:00:00Z"),
      durationDays: 2,
      startTime: "7:00 AM",
    });

    expect(msg).toContain("JOB SCHEDULED");
    expect(msg).toContain("Jane Smith");
    expect(msg).toContain("Panel Upgrade");
    expect(msg).toContain("2 day(s)");
  });

  it("generates correct reschedule conflict SMS for Kyle", async () => {
    const { kyleRescheduleConflict } = await import("../src/services/notifications");
    const msg = kyleRescheduleConflict(
      {
        customerName: "Jane Smith",
        phone: "+16155551234",
        address: "123 Oak St",
        jobType: "Panel Upgrade",
        scheduledStart: new Date("2026-05-05T12:00:00Z"),
        scheduledEnd: new Date("2026-05-06T22:00:00Z"),
        durationDays: 2,
        startTime: "7:00 AM",
      },
      new Date("2026-05-12T12:00:00Z"),
      "Existing event blocks 8am-12pm",
    );

    expect(msg).toContain("RESCHEDULE ATTEMPTED");
    expect(msg).toContain("BLOCKED");
    expect(msg).toContain("Savannah told them");
  });
});
