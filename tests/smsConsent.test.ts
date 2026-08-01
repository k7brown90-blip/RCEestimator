/**
 * SMS consent — recorded at intake, enforced at the send gate.
 *
 * The website form has always sent `smsConsent` with the lead; before this the
 * backend dropped it on the floor. These tests pin the full loop the A2P
 * registration attests to. The website checkbox is the ONLY opt-in channel we
 * claim to Twilio and to customers — there is no verbal opt-in flow anywhere
 * in the call system — so the gate is default-deny for any known contact:
 *   1. POST /leads persists the tri-state (true / false / null-when-absent)
 *   2. sendSms() blocks a known Lead/Customer unless smsConsent === true
 *      (both false and null block — "never asked" is not consent)
 *   3. sendSms() does NOT gate numbers with no matching Lead/Customer at all
 *      (e.g. a technician's phone, dispatched over the same Twilio line)
 *   4. An inbound STOP flips every matching record to declined,
 *      START flips them back to true
 *
 * The twilio service is deliberately NOT mocked — the gate under test lives in
 * it. Twilio env vars are set and global fetch is stubbed instead.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { prisma } from "../src/lib/prisma";

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

import { app } from "../src/app";
import { sendSms, KYLE_PHONE } from "../src/services/twilio";
import { webOptInConfirmation } from "../src/services/notifications";

const WEBHOOK = process.env.WEBHOOK_SECRET!;

// Distinct numbers per scenario so lookups can't bleed across tests.
const DECLINED_PHONE = "+16155559001";
const DECLINED_PUNCTUATED = "(615) 555-9002"; // stored punctuated, dialed E.164
const CONSENTED_PHONE = "+16155559003";
const NEVER_ASKED_PHONE = "+16155559004";
const STOP_PHONE = "+16155559005";
const UNKNOWN_PHONE = "+16155559006"; // no matching Lead/Customer — e.g. a technician

const fetchMock = vi.fn().mockResolvedValue({
  ok: true,
  json: async () => ({ sid: "SM_test" }),
});

beforeAll(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await prisma.lead.deleteMany({ where: { name: { startsWith: "Consent Test" } } });
  await prisma.customer.deleteMany({ where: { name: { startsWith: "Consent Test" } } });
});

beforeEach(() => {
  fetchMock.mockClear();
});

/** Polls until `predicate` is true or `timeoutMs` elapses, then throws. */
async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil: timed out");
    await new Promise((r) => setTimeout(r, 15));
  }
}

function sentBodies(): URLSearchParams[] {
  return fetchMock.mock.calls.map(([, init]) => new URLSearchParams(String((init as RequestInit).body ?? "")));
}

describe("POST /leads persists smsConsent", () => {
  it("records an explicit true", async () => {
    const res = await request(app)
      .post("/leads")
      .set("webhook_secret", WEBHOOK)
      .send({ name: "Consent Test Opt-In", phone: CONSENTED_PHONE, source: "manual", smsConsent: true });
    expect(res.status).toBe(201);
    const lead = await prisma.lead.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(lead.smsConsent).toBe(true);
  });

  it("records an explicit false", async () => {
    const res = await request(app)
      .post("/leads")
      .set("webhook_secret", WEBHOOK)
      .send({ name: "Consent Test Decline", phone: DECLINED_PHONE, source: "manual", smsConsent: false });
    expect(res.status).toBe(201);
    const lead = await prisma.lead.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(lead.smsConsent).toBe(false);
  });

  it("leaves the field null when absent — never-asked is not a decline", async () => {
    const res = await request(app)
      .post("/leads")
      .set("webhook_secret", WEBHOOK)
      .send({ name: "Consent Test Phone Intake", phone: NEVER_ASKED_PHONE, source: "phone" });
    expect(res.status).toBe(201);
    const lead = await prisma.lead.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(lead.smsConsent).toBeNull();
  });
});

describe("web lead opt-in confirmation SMS", () => {
  const WEB_OPT_IN_PHONE = "+16155559007";
  const WEB_DECLINE_PHONE = "+16155559008";

  it("sends the exact declared opt-in confirmation once, when a web lead consents", async () => {
    const res = await request(app)
      .post("/leads")
      .set("webhook_secret", WEBHOOK)
      .send({ name: "Consent Test Web Opt-In", phone: WEB_OPT_IN_PHONE, source: "web", smsConsent: true });
    expect(res.status).toBe(201);

    // Two fire-and-forget sends go out for a web lead: the Kyle notification
    // (always) and the opt-in confirmation (consent === true). Wait for both
    // by name so this test doesn't finish — and bleed a pending fetch call
    // into the next test — before they land.
    await waitUntil(() => sentBodies().some((p) => p.get("To") === KYLE_PHONE));
    await waitUntil(() => sentBodies().some((p) => p.get("Body") === webOptInConfirmation()));

    const optInCall = sentBodies().find((p) => p.get("Body") === webOptInConfirmation());
    expect(optInCall).toBeDefined();
    expect(optInCall!.get("To")).toBe(WEB_OPT_IN_PHONE);
  });

  it("does not send it when the web lead declines", async () => {
    const res = await request(app)
      .post("/leads")
      .set("webhook_secret", WEBHOOK)
      .send({ name: "Consent Test Web Decline", phone: WEB_DECLINE_PHONE, source: "web", smsConsent: false });
    expect(res.status).toBe(201);

    // The Kyle notification still fires for any web lead regardless of
    // consent — wait for it as the completion signal for this request's
    // fire-and-forget work, so nothing bleeds into the next test.
    await waitUntil(() => sentBodies().some((p) => p.get("To") === KYLE_PHONE));

    const optInCall = sentBodies().find((p) => p.get("Body") === webOptInConfirmation());
    expect(optInCall).toBeUndefined();
  });
});

describe("sendSms consent gate", () => {
  it("blocks a number whose lead declined", async () => {
    // Lead created in the test above with smsConsent: false
    const result = await sendSms(DECLINED_PHONE, "test message");
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks even when the stored number is punctuated and the dialed one is E.164", async () => {
    await prisma.customer.create({
      data: { name: "Consent Test Punctuated", phone: DECLINED_PUNCTUATED, smsConsent: false },
    });
    const result = await sendSms("+16155559002", "test message");
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends when consent is true", async () => {
    const result = await sendSms(CONSENTED_PHONE, "test message");
    expect(result).toEqual({ sid: "SM_test" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("blocks a known lead who was never asked (null) — the checkbox is the only opt-in channel", async () => {
    const result = await sendSms(NEVER_ASKED_PHONE, "test message");
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not gate a number with no matching Lead/Customer at all (e.g. a technician)", async () => {
    const result = await sendSms(UNKNOWN_PHONE, "test message");
    expect(result).toEqual({ sid: "SM_test" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("bypasses the gate for direct replies when asked to", async () => {
    const result = await sendSms(DECLINED_PHONE, "reply to their inbound text", { bypassConsentCheck: true });
    expect(result).toEqual({ sid: "SM_test" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("inbound STOP / START keywords", () => {
  let customerId: string;
  let leadId: string;

  beforeAll(async () => {
    const customer = await prisma.customer.create({
      data: { name: "Consent Test Stop", phone: STOP_PHONE, smsConsent: true },
    });
    customerId = customer.id;
    const lead = await prisma.lead.create({
      data: { name: "Consent Test Stop Lead", phone: "(615) 555-9005", smsConsent: true },
    });
    leadId = lead.id;
  });

  it("STOP flips every matching Customer and Lead to declined, regardless of stored format", async () => {
    const res = await request(app).post("/sms/inbound").type("form").send({ From: STOP_PHONE, Body: "STOP" });
    expect(res.status).toBe(200);

    const customer = await prisma.customer.findUniqueOrThrow({ where: { id: customerId } });
    const lead = await prisma.lead.findUniqueOrThrow({ where: { id: leadId } });
    expect(customer.smsConsent).toBe(false);
    expect(lead.smsConsent).toBe(false);

    // And the gate now blocks them.
    fetchMock.mockClear();
    expect(await sendSms(STOP_PHONE, "should not go out")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("START opts them back in", async () => {
    const res = await request(app).post("/sms/inbound").type("form").send({ From: STOP_PHONE, Body: "START" });
    expect(res.status).toBe(200);

    const customer = await prisma.customer.findUniqueOrThrow({ where: { id: customerId } });
    const lead = await prisma.lead.findUniqueOrThrow({ where: { id: leadId } });
    expect(customer.smsConsent).toBe(true);
    expect(lead.smsConsent).toBe(true);
  });
});
