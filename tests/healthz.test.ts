/**
 * /healthz — deep health for Railway. 200 iff the DB is reachable; 503 with a
 * reason otherwise. Kyle's rule: unknown is not "fine."
 */

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

process.env.PIN_HASH = process.env.PIN_HASH ?? "";
process.env.WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? "test-webhook-secret";
process.env.TWILIO_ACCOUNT_SID = "AC_test";
process.env.TWILIO_AUTH_TOKEN = "test_token";
process.env.TWILIO_PHONE_NUMBER = "+16150000000";

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

const { sendAlertSpy } = vi.hoisted(() => ({
  sendAlertSpy: vi.fn().mockResolvedValue({ delivered: true, sid: "SMxxx" }),
}));
vi.mock("../src/services/alerting", async () => {
  const actual = await vi.importActual<typeof import("../src/services/alerting")>("../src/services/alerting");
  return { ...actual, sendAlert: sendAlertSpy };
});

import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";

describe("GET /healthz", () => {
  beforeEach(() => {
    sendAlertSpy.mockClear();
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it("returns 200 with db=true when the DB responds", async () => {
    const res = await request(app).get("/internal/healthz");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.db).toBe(true);
    expect(sendAlertSpy).not.toHaveBeenCalled();
  });

  it("returns 503 and fires a critical alert when the DB throws", async () => {
    const spy = vi.spyOn(prisma, "$queryRaw").mockRejectedValueOnce(new Error("connection refused"));
    const res = await request(app).get("/internal/healthz");
    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
    expect(res.body.db).toBe(false);
    expect(res.body.reason).toContain("connection refused");
    expect(sendAlertSpy).toHaveBeenCalledTimes(1);
    expect(sendAlertSpy.mock.calls[0][0]).toMatchObject({
      severity: "critical",
      eventType: "healthz-db-unreachable",
      dedupeKey: "healthz-db-unreachable",
    });
    spy.mockRestore();
  });

  it("never returns 200 when DB status is unknown", async () => {
    const spy = vi.spyOn(prisma, "$queryRaw").mockRejectedValueOnce(new Error("ETIMEDOUT"));
    const res = await request(app).get("/internal/healthz");
    expect(res.status).not.toBe(200);
    spy.mockRestore();
  });
});
