/**
 * Railway crash webhook — auth gate + failure-only alerting.
 * Pre-gate policy is a URL-path token compared in constant time; deferred to
 * signature verification at the customer-data gate per
 * decisions/2026-08-04-secrets-and-security-posture.md.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

process.env.PIN_HASH = process.env.PIN_HASH ?? "";
process.env.WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? "test-webhook-secret";
process.env.TWILIO_ACCOUNT_SID = "AC_test";
process.env.TWILIO_AUTH_TOKEN = "test_token";
process.env.TWILIO_PHONE_NUMBER = "+16150000000";
process.env.INTERNAL_WEBHOOK_TOKEN = "test-webhook-token-abcdefghijklmnop";

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

const TOKEN = process.env.INTERNAL_WEBHOOK_TOKEN!;

describe("POST /internal/webhooks/railway/:token", () => {
  beforeEach(() => {
    sendAlertSpy.mockClear();
  });

  it("returns 401 when no token is supplied", async () => {
    const res = await request(app)
      .post("/internal/webhooks/railway/wrongtokenwrongtokenwrongtoken00")
      .send({ type: "deploy.failed", deployment: { id: "d1" } });
    expect(res.status).toBe(401);
    expect(sendAlertSpy).not.toHaveBeenCalled();
  });

  it("fires an alert on a deploy.failed event", async () => {
    const res = await request(app)
      .post(`/internal/webhooks/railway/${TOKEN}`)
      .send({ type: "deploy.failed", deployment: { id: "d1" }, project: { name: "RCEestimator" } });
    expect(res.status).toBe(200);
    expect(sendAlertSpy).toHaveBeenCalledTimes(1);
    expect(sendAlertSpy.mock.calls[0][0]).toMatchObject({
      severity: "critical",
      eventType: "railway.deploy.failed",
      service: "RCEestimator",
      dedupeKey: "railway:deploy.failed:d1",
    });
  });

  it("fires an alert on a deploy.crashed event", async () => {
    const res = await request(app)
      .post(`/internal/webhooks/railway/${TOKEN}`)
      .send({ type: "deploy.crashed", deployment: { id: "d2" }, project: { name: "RCEestimator" } });
    expect(res.status).toBe(200);
    expect(sendAlertSpy).toHaveBeenCalledTimes(1);
  });

  it("ignores deploy.success and does not alert", async () => {
    const res = await request(app)
      .post(`/internal/webhooks/railway/${TOKEN}`)
      .send({ type: "deploy.success", deployment: { id: "d3" } });
    expect(res.status).toBe(204);
    expect(sendAlertSpy).not.toHaveBeenCalled();
  });
});
