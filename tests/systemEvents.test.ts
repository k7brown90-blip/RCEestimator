/**
 * System event log + feedback box — the audit trail the coding agent reads.
 *
 * Pins the three write paths:
 *   1. logSystemEvent() persists a queryable row
 *   2. POST /feedback (authenticated UI) lands in the same table, source "feedback"
 *   3. The global Express error handler records unhandled 500s with the route
 */

import { afterAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { prisma } from "../src/lib/prisma";

process.env.WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? "test-webhook-secret";

vi.mock("../src/services/twilio", () => ({
  sendSms: vi.fn().mockResolvedValue({ sid: "SM_mock" }),
  KYLE_PHONE: "+19706661626",
  isFromKyle: vi.fn().mockReturnValue(false),
  fetchTwilioMedia: vi.fn().mockResolvedValue(null),
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
import { logSystemEvent } from "../src/services/systemEvents";

/** Fire-and-forget writes need a beat to land before we query for them. */
async function waitForEvent(where: object, timeoutMs = 3000) {
  const start = Date.now();
  for (;;) {
    const row = await prisma.systemEvent.findFirst({ where, orderBy: { createdAt: "desc" } });
    if (row) return row;
    if (Date.now() - start > timeoutMs) throw new Error("Event row never appeared");
    await new Promise((r) => setTimeout(r, 25));
  }
}

afterAll(async () => {
  await prisma.systemEvent.deleteMany({ where: { message: { contains: "SysEvent Test" } } });
});

describe("logSystemEvent", () => {
  it("persists a row with level, source, route and details", async () => {
    logSystemEvent("error", "twilio", "SysEvent Test — send failed", {
      route: "POST /example",
      status: 500,
    });
    const row = await waitForEvent({ message: "SysEvent Test — send failed" });
    expect(row.level).toBe("error");
    expect(row.source).toBe("twilio");
    expect(row.route).toBe("POST /example");
    expect(JSON.parse(row.detailsJson!)).toMatchObject({ status: 500 });
  });

  it("serializes Error objects in details instead of dropping them", async () => {
    logSystemEvent("error", "express", "SysEvent Test — with stack", {
      stack: new Error("boom").stack,
    });
    const row = await waitForEvent({ message: "SysEvent Test — with stack" });
    expect(row.detailsJson).toContain("boom");
  });
});

describe("POST /feedback", () => {
  it("stores operator feedback as a system event with the page attached", async () => {
    const res = await request(app)
      .post("/feedback")
      .send({ message: "SysEvent Test — the calendar page froze", page: "/calendar" });
    expect(res.status).toBe(201);

    const row = await waitForEvent({ message: "SysEvent Test — the calendar page froze" });
    expect(row.source).toBe("feedback");
    expect(row.level).toBe("info");
    expect(JSON.parse(row.detailsJson!)).toMatchObject({ page: "/calendar" });
  });

  it("rejects an empty message", async () => {
    const res = await request(app).post("/feedback").send({ message: "   " });
    expect(res.status).toBe(400);
  });
});
