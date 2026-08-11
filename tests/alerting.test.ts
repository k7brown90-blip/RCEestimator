/**
 * Alerting dedup + Twilio path — the tripwire's own tripwire.
 *
 * The `sendSms` service is mocked so we test alerting logic in isolation;
 * `smsConsent.test.ts` covers the underlying send path.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/twilio", () => ({
  sendSms: vi.fn(),
  KYLE_PHONE: "+19706661626",
}));

vi.mock("../src/services/systemEvents", () => ({
  logSystemEvent: vi.fn(),
}));

import { sendAlert, _resetDedupForTests } from "../src/services/alerting";
import { sendSms } from "../src/services/twilio";

const sendSmsMock = vi.mocked(sendSms);

describe("sendAlert", () => {
  beforeEach(() => {
    _resetDedupForTests();
    sendSmsMock.mockReset();
    sendSmsMock.mockResolvedValue({ sid: "SMxxx", status: "queued" });
  });

  it("routes an alert via sendSms and returns the Twilio status", async () => {
    const result = await sendAlert({
      severity: "critical",
      eventType: "crash",
      service: "RCEestimator",
      reason: "boom",
    });

    expect(sendSmsMock).toHaveBeenCalledTimes(1);
    expect(result.delivered).toBe(true);
    expect(result.twilioStatus).toBe("queued");
    expect(result.sid).toBe("SMxxx");
    const body = sendSmsMock.mock.calls[0][1];
    expect(body).toContain("[RCE CRITICAL] crash");
    expect(body).toContain("svc: RCEestimator");
    expect(body).toContain("why: boom");
  });

  it("dedupes bursts of the same event within 15 minutes to one send", async () => {
    const first = await sendAlert({ severity: "critical", eventType: "crash", service: "svc" });
    const second = await sendAlert({ severity: "critical", eventType: "crash", service: "svc" });
    const third = await sendAlert({ severity: "critical", eventType: "crash", service: "svc" });

    expect(first.delivered).toBe(true);
    expect(first.deduplicated).toBeFalsy();
    expect(second.deduplicated).toBe(true);
    expect(third.deduplicated).toBe(true);
    expect(sendSmsMock).toHaveBeenCalledTimes(1);
  });

  it("distinguishes events with different dedupeKeys", async () => {
    await sendAlert({ severity: "critical", eventType: "crash", service: "svc", dedupeKey: "a" });
    await sendAlert({ severity: "critical", eventType: "crash", service: "svc", dedupeKey: "b" });
    expect(sendSmsMock).toHaveBeenCalledTimes(2);
  });

  it("reports twilio-unconfigured without lying about delivery", async () => {
    sendSmsMock.mockResolvedValueOnce(null);
    const result = await sendAlert({ severity: "critical", eventType: "crash", service: "svc" });
    expect(result.delivered).toBe(false);
    expect(result.reason).toBe("twilio-unconfigured");
  });

  it("uses the consent bypass — an alert is internal, not a marketing send", async () => {
    await sendAlert({ severity: "critical", eventType: "crash", service: "svc" });
    const opts = sendSmsMock.mock.calls[0][2];
    expect(opts?.bypassConsentCheck).toBe(true);
  });
});
