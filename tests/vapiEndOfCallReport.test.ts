/**
 * POST /vapi/end-of-call-report — the backend safety net for call disposition.
 * A model can skip log_call_disposition under multi-step pressure; this checks
 * whether the ended call's id already has one logged, and if not, applies a
 * generic fallback so a dropped call never produces zero record.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";

vi.mock("../src/services/twilio");
vi.mock("googleapis");

import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";

const TAG = "EOCR";
const SECRET = "eocr-test-secret";
const FALLBACK_PHONE = "+16155550199";

beforeAll(async () => {
  process.env.VAPI_SERVER_SECRET = SECRET;
  // A prior failed run's fallback lead has no TAG in its name (it's created
  // with the default "Unknown caller" name) — clean up by phone too, or a
  // leftover row makes this test match an existing lead instead of creating one.
  await prisma.lead.deleteMany({ where: { phone: FALLBACK_PHONE } });
});

afterAll(async () => {
  delete process.env.VAPI_SERVER_SECRET;
  await prisma.lead.deleteMany({ where: { OR: [{ name: { startsWith: TAG } }, { phone: FALLBACK_PHONE }] } });
  await prisma.agentAuditLog.deleteMany({ where: { callId: { startsWith: TAG } } });
});

describe("POST /vapi/end-of-call-report auth", () => {
  it("refuses without the key", async () => {
    await request(app).post("/vapi/end-of-call-report").send({}).expect(401);
  });

  it("refuses a wrong key", async () => {
    await request(app).post("/vapi/end-of-call-report?key=nope").send({}).expect(401);
  });
});

describe("POST /vapi/end-of-call-report behavior", () => {
  it("ignores non-end-of-call-report message types", async () => {
    const res = await request(app)
      .post(`/vapi/end-of-call-report?key=${SECRET}`)
      .send({ message: { type: "status-update" } })
      .expect(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("auto-logs a fallback disposition when none was recorded for the call", async () => {
    const callId = `${TAG}-call-1`;
    const res = await request(app)
      .post(`/vapi/end-of-call-report?key=${SECRET}`)
      .send({
        message: {
          type: "end-of-call-report",
          call: { id: callId, customer: { number: FALLBACK_PHONE } },
          summary: "Caller asked about panel upgrade pricing, hung up mid-quote.",
        },
      })
      .expect(200);

    expect(res.body.leadCreated).toBe(true);
    const lead = await prisma.lead.findUnique({ where: { id: res.body.leadId } });
    expect(lead?.leadStatus).toBe("unresolved");
    expect(lead?.callType).toBe("auto_fallback");
    expect(lead?.notes).toContain("Auto-logged");
    expect(lead?.notes).toContain("panel upgrade pricing");

    const auditRow = await prisma.agentAuditLog.findFirst({ where: { callId, action: "call_disposition" } });
    expect(auditRow).not.toBeNull();
  });

  it("does nothing when a disposition was already logged for that call.id", async () => {
    const callId = `${TAG}-call-2`;
    const existingLead = await prisma.lead.create({
      data: { name: `${TAG} Already Logged`, source: "phone", leadStatus: "booked" },
    });
    await prisma.agentAuditLog.create({
      data: { action: "call_disposition", callId, entityType: "lead", entityId: existingLead.id },
    });

    const res = await request(app)
      .post(`/vapi/end-of-call-report?key=${SECRET}`)
      .send({ message: { type: "end-of-call-report", call: { id: callId } } })
      .expect(200);

    expect(res.body.alreadyLogged).toBe(true);
    expect(await prisma.lead.count({ where: { source: "phone", name: `${TAG} Already Logged` } })).toBe(1);
  });

  it("acks without crashing when call.id is missing", async () => {
    await request(app)
      .post(`/vapi/end-of-call-report?key=${SECRET}`)
      .send({ message: { type: "end-of-call-report" } })
      .expect(200);
  });
});
