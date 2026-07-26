/**
 * Voice-agent technician verification — a caller claiming to be internal staff
 * proves it with an employee number, and Savannah transitions into admin mode
 * with the technician's assignments in hand. This backs the "field team
 * protocol" in the system prompt and produces an audit log for payroll tracking.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { prisma } from "../src/lib/prisma";

const TOKEN = process.env.AGENT_API_TOKEN ?? "test-agent-token";
process.env.AGENT_API_TOKEN = TOKEN;
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

let activeTechId: string;
let inactiveTechId: string;
let customerId: string;
let propertyId: string;
let scheduledVisitId: string;
let unscheduledVisitId: string;

beforeAll(async () => {
  const activeTech = await prisma.technician.create({
    data: {
      name: "TechVerify Active",
      employeeNumber: "EMP-0042",
      role: "technician",
      accessToken: `verify-active-${Date.now()}`,
      isActive: true,
    },
  });
  activeTechId = activeTech.id;

  const inactiveTech = await prisma.technician.create({
    data: {
      name: "TechVerify Inactive",
      employeeNumber: "EMP-9999",
      role: "technician",
      accessToken: `verify-inactive-${Date.now()}`,
      isActive: false,
    },
  });
  inactiveTechId = inactiveTech.id;

  const customer = await prisma.customer.create({
    data: { name: "TechVerify Customer", phone: "+16155559999" },
  });
  customerId = customer.id;

  const property = await prisma.property.create({
    data: {
      customerId,
      name: "TechVerify House",
      addressLine1: "42 Verify Ln",
      city: "Franklin",
      state: "TN",
      postalCode: "37064",
    },
  });
  propertyId = property.id;

  const scheduled = await prisma.visit.create({
    data: {
      customerId,
      propertyId,
      mode: "onsite",
      purpose: "Panel upgrade",
      status: "scheduled",
      scheduledStart: new Date(Date.now() + 24 * 60 * 60 * 1000),
      scheduledEnd: new Date(Date.now() + 26 * 60 * 60 * 1000),
    },
  });
  scheduledVisitId = scheduled.id;

  const unscheduled = await prisma.visit.create({
    data: { customerId, propertyId, mode: "onsite", purpose: "Diagnose flicker", status: "contracted" },
  });
  unscheduledVisitId = unscheduled.id;

  await prisma.visitAssignment.create({
    data: { visitId: scheduledVisitId, technicianId: activeTechId, status: "assigned" },
  });
  await prisma.visitAssignment.create({
    data: { visitId: unscheduledVisitId, technicianId: activeTechId, status: "in_progress" },
  });
});

afterAll(async () => {
  await prisma.visitAssignment.deleteMany({ where: { technicianId: { in: [activeTechId, inactiveTechId] } } });
  await prisma.visit.deleteMany({ where: { id: { in: [scheduledVisitId, unscheduledVisitId] } } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
  await prisma.technician.deleteMany({ where: { id: { in: [activeTechId, inactiveTechId] } } });
});

beforeEach(async () => {
  await prisma.agentIdempotency.deleteMany();
});

afterEach(async () => {
  await prisma.agentAuditLog.deleteMany({
    where: { action: { in: ["technician_verify_success", "technician_verify_failed"] } },
  });
});

describe("POST /agent/calendar/technicians/verify", () => {
  it("rejects requests without the agent bearer token", async () => {
    const res = await request(app)
      .post("/agent/calendar/technicians/verify")
      .send({ employee_number: "EMP-0042" });
    expect(res.status).toBe(401);
  });

  it("returns 401 with a spoken fallback when the employee number is unknown", async () => {
    const res = await request(app)
      .post("/agent/calendar/technicians/verify")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ employee_number: "EMP-XXXX", stated_name: "Some Person" });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.data.verified).toBe(false);
    expect(res.body.error.code).toBe("TECH_NOT_VERIFIED");
    expect(res.body.spoken_confirmation).toMatch(/operations lead/i);
  });

  it("returns 401 when the technician exists but is inactive", async () => {
    const res = await request(app)
      .post("/agent/calendar/technicians/verify")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ employee_number: "EMP-9999" });

    expect(res.status).toBe(401);
    expect(res.body.data.verified).toBe(false);
    expect(res.body.error.code).toBe("TECH_NOT_VERIFIED");
  });

  it("verifies an active technician and returns their identity and active assignments", async () => {
    const res = await request(app)
      .post("/agent/calendar/technicians/verify")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ employee_number: "EMP-0042", stated_name: "TechVerify Active" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.verified).toBe(true);
    expect(res.body.data.technician_id).toBe(activeTechId);
    expect(res.body.data.name).toBe("TechVerify Active");
    expect(res.body.data.role).toBe("technician");
    expect(res.body.data.active_assignments).toHaveLength(2);
    // The spoken confirmation should reference the next scheduled job.
    expect(res.body.spoken_confirmation).toMatch(/TechVerify Customer/);
    // Next-job resolver picks the scheduled visit, not the unscheduled one.
    expect(res.body.data.next_job.visit_id).toBe(scheduledVisitId);
  });

  it("trims whitespace on the employee number lookup", async () => {
    const res = await request(app)
      .post("/agent/calendar/technicians/verify")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ employee_number: "  EMP-0042  " });

    expect(res.status).toBe(200);
    expect(res.body.data.verified).toBe(true);
  });

  it("writes an audit log entry keyed to the technician on success", async () => {
    await request(app)
      .post("/agent/calendar/technicians/verify")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ employee_number: "EMP-0042" });

    const log = await prisma.agentAuditLog.findFirst({
      where: { action: "technician_verify_success", entityId: activeTechId },
    });
    expect(log).not.toBeNull();
    expect(log?.entityType).toBe("Technician");
  });

  it("honors x-client-request-id for idempotent replay", async () => {
    const requestId = `verify-${Date.now()}`;
    const first = await request(app)
      .post("/agent/calendar/technicians/verify")
      .set("Authorization", `Bearer ${TOKEN}`)
      .set("x-client-request-id", requestId)
      .send({ employee_number: "EMP-0042" });
    expect(first.status).toBe(200);

    const second = await request(app)
      .post("/agent/calendar/technicians/verify")
      .set("Authorization", `Bearer ${TOKEN}`)
      .set("x-client-request-id", requestId)
      .send({ employee_number: "EMP-0042" });
    expect(second.status).toBe(200);
    expect(second.body.data.verified).toBe(true);
  });
});
