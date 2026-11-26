/**
 * SMS: STOP is the ONLY reason a text to a lead or customer is blocked.
 *
 * Kyle, 2026-11-26: "REMOVE THE SMS CONSENT GATE COMPLETELY ... The Twilio number is used ONLY to schedule, reschedule, and confirm
 * appointments with people who contacted Red Cedar Electric first ... No consent checkbox is needed or wanted ... Keep STOP handling only:
 * if a person replies STOP, mark them opted out and stop texting them. That is the ONLY reason a text should ever be blocked."
 *
 * This file used to pin the opposite (default-deny: a known contact was blocked unless smsConsent === true, "the website checkbox is the
 * ONLY opt-in channel"). Those cases are changed deliberately; the ones that still hold are kept. What is pinned now:
 *   1. POST /leads records true for a ticked box and NEVER false: an unticked or absent box is null
 *   2. sendSms() sends to a known Lead/Customer whose smsConsent is null or true, and refuses one whose smsConsent is false (a STOP) -
 *      one stopped row is enough when two records share the number
 *   3. sendSms() does not gate numbers with no matching Lead/Customer at all (e.g. a technician's phone)
 *   4. An inbound STOP flips every matching record to false, START flips them back to true
 *   5. The automated texts (the 24-hour reminder, the confirmation request, a reschedule) go to a customer who was never asked, through the
 *      real paths, and a customer who replied STOP is still refused on those same paths
 *
 * The twilio service is deliberately NOT mocked - the gate under test lives in it. Twilio env vars are set and global fetch is stubbed instead.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { prisma } from "../src/lib/prisma";

process.env.WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? "test-webhook-secret";
process.env.TWILIO_ACCOUNT_SID = "AC_test";
process.env.TWILIO_AUTH_TOKEN = "test_token";
// P017 rev 2 closed the inbound webhook by default (Kyle's 2026-08-16 ruling). These tests pin
// inbound ROUTING, which only runs when the channel is open, so they open it explicitly. The
// closed behaviour is pinned in securityFollowups.test.ts.
process.env.TWILIO_INBOUND_SMS_WEBHOOK = "on";
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
import { postSignedTwilioWebhook } from "./helpers/twilioWebhook";
import { sendSms, KYLE_PHONE } from "../src/services/twilio";
import { sendCustomerSms, webOptInConfirmation } from "../src/services/notifications";
import { sendVisitConfirmationRequest, sendVisitReminders } from "../src/services/visitConfirmations";

const WEBHOOK = process.env.WEBHOOK_SECRET!;

// Distinct numbers per scenario so lookups can't bleed across tests.
const DECLINED_PHONE = "+16155559001"; // a STOP: smsConsent false, written directly (POST /leads can no longer write false)
const DECLINED_PUNCTUATED = "(615) 555-9002"; // stored punctuated, dialed E.164
const CONSENTED_PHONE = "+16155559003";
const NEVER_ASKED_PHONE = "+16155559004";
const STOP_PHONE = "+16155559005";
const UNKNOWN_PHONE = "+16155559006"; // no matching Lead/Customer — e.g. a technician

// Every text gets its own provider id: the CRM files each sent text in a conversation, and that id is unique there.
let sidSeq = 0;
const fetchMock = vi.fn().mockImplementation(async () => ({
  ok: true,
  json: async () => ({ sid: `SM_test_${++sidSeq}` }),
}));

/**
 * U9 files every text the CRM sends under the customer or lead it was for, and the "first text to a number
 * carries Reply STOP" rule reads those lines. A lead's thread survives the lead (its leadId is set null), so
 * the lines this file writes are removed with the leads, and any left by an earlier run are cleared first.
 */
async function clearHubLinesForConsentFixtures() {
  const leads = await prisma.lead.findMany({ where: { name: { startsWith: "Consent Test" } }, select: { id: true } });
  const customers = await prisma.customer.findMany({ where: { name: { startsWith: "Consent Test" } }, select: { id: true } });
  await prisma.hubThread.deleteMany({ where: { OR: [{ leadId: { in: leads.map((l) => l.id) } }, { customerId: { in: customers.map((c) => c.id) } }] } });
  await prisma.hubMessage.deleteMany({ where: { channel: "sms", toPhone10: { startsWith: "6155559" } } });
}

beforeAll(async () => {
  vi.stubGlobal("fetch", fetchMock);
  await clearHubLinesForConsentFixtures();
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await clearHubLinesForConsentFixtures();
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

describe("POST /leads records a ticked box and never a false", () => {
  it("records an explicit true", async () => {
    const res = await request(app)
      .post("/leads")
      .set("webhook_secret", WEBHOOK)
      .send({ name: "Consent Test Opt-In", phone: CONSENTED_PHONE, source: "manual", smsConsent: true });
    expect(res.status).toBe(201);
    const lead = await prisma.lead.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(lead.smsConsent).toBe(true);
  });

  it("an unticked box (an explicit false) is stored as null, NOT false - false now means only 'replied STOP' (Kyle 2026-11-26)", async () => {
    const res = await request(app)
      .post("/leads")
      .set("webhook_secret", WEBHOOK)
      .send({ name: "Consent Test Decline", phone: "+16155559010", source: "web", smsConsent: false });
    expect(res.status).toBe(201);
    const lead = await prisma.lead.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(lead.smsConsent).toBeNull();
  });

  it("leaves the field null when absent - a phone lead is textable all the same", async () => {
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

  /**
   * Two independent gates now stand between a web lead and a text: the manual-first
   * customer-send gate (2026-08-11) and the Twilio gate (2026-08-13). Tests that exist to
   * assert something OTHER than the gates — the A2P wording, the consent check — open both
   * so the assertion they were written for keeps running on the live path.
   */
  function openBothGates(): void {
    process.env.AUTOMATED_CUSTOMER_SENDS_WEB_LEAD_AUTOREPLY = "on";
    process.env.TWILIO_SENDS_CUSTOMER_LIFECYCLE = "on";
    process.env.TWILIO_SENDS_OPERATOR_NOTIFICATIONS = "on";
  }

  function closeBothGates(): void {
    delete process.env.AUTOMATED_CUSTOMER_SENDS_WEB_LEAD_AUTOREPLY;
    delete process.env.AUTOMATED_CUSTOMER_SENDS;
    delete process.env.TWILIO_SENDS_CUSTOMER_LIFECYCLE;
    delete process.env.TWILIO_SENDS_OPERATOR_NOTIFICATIONS;
    delete process.env.TWILIO_SENDS;
  }

  afterEach(() => {
    closeBothGates();
  });

  it("sends the exact declared opt-in confirmation once, when a web lead consents", async () => {
    // Both gates suppress this send in production by default. The A2P compliance assertion
    // below — that the wording matches exactly what was declared to Twilio — must keep
    // running regardless, so both are explicitly opened for this test. The suppressed case
    // is asserted in the test after this one.
    openBothGates();
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
    // U9: the words are webOptInConfirmation(); the header and the footer are the composer's (this is the
    // first text ever sent to the number, so it carries "Reply STOP to opt out.").
    await waitUntil(() => sentBodies().some((p) => (p.get("Body") ?? "").includes(webOptInConfirmation())));

    const optInCall = sentBodies().find((p) => (p.get("Body") ?? "").includes(webOptInConfirmation()));
    expect(optInCall).toBeDefined();
    expect(optInCall!.get("To")).toBe(WEB_OPT_IN_PHONE);
    const sent = optInCall!.get("Body") ?? "";
    expect(sent).toMatch(/^Red Cedar Electric: Text Alerts Confirmed \w{3} \d{1,2}\/\d{1,2}, \d{1,2}(:\d{2})? [AP]M\n/);
    expect(sent.endsWith("\nReply STOP to opt out.")).toBe(true);
    // The wording carries no STOP line of its own and no company name: the composer would have refused it.
    expect(webOptInConfirmation()).not.toMatch(/reply\s+stop/i);
    expect(webOptInConfirmation()).not.toMatch(/^\s*red\s+cedar/i);
  });

  it("TWILIO GATE: a consenting web lead produces ZERO Twilio calls — not to the lead, not to Kyle", async () => {
    // This replaces the P004-era assertion that Kyle still gets texted. Kyle's 2026-08-13
    // clarification withdrew that exception: "I am not using twilio for texts." Consent is
    // TRUE here and the lead is a web lead, so every send this route can make is armed —
    // the gates are the only thing stopping them. It fails the moment either one is
    // re-enabled by accident.
    closeBothGates();
    const GATED_PHONE = "+16155559009";

    const res = await request(app)
      .post("/leads")
      .set("webhook_secret", WEBHOOK)
      .send({ name: "Consent Test Web Gated", phone: GATED_PHONE, source: "web", smsConsent: true });
    expect(res.status).toBe(201);

    // Nothing to wait FOR, so wait out the fire-and-forget window instead and prove the
    // silence is real rather than a race we won.
    await new Promise((r) => setTimeout(r, 300));

    expect(sentBodies().find((p) => p.get("To") === GATED_PHONE)).toBeUndefined();
    expect(sentBodies().find((p) => p.get("To") === KYLE_PHONE)).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();

    // The lead itself is untouched by the gate — it is in the CRM, which is now the channel.
    const lead = await prisma.lead.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(lead.smsConsent).toBe(true);
  });

  it("does not send the one-time opt-in confirmation when the web lead left the box unticked (the lead is stored null, not false)", async () => {
    // Gates open, so the ONLY thing that can suppress the opt-in text here is the unticked box.
    openBothGates();
    const res = await request(app)
      .post("/leads")
      .set("webhook_secret", WEBHOOK)
      .send({ name: "Consent Test Web Decline", phone: WEB_DECLINE_PHONE, source: "web", smsConsent: false });
    expect(res.status).toBe(201);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: res.body.id } })).smsConsent).toBeNull();

    // The Kyle notification still fires for any web lead regardless of
    // consent — wait for it as the completion signal for this request's
    // fire-and-forget work, so nothing bleeds into the next test.
    await waitUntil(() => sentBodies().some((p) => p.get("To") === KYLE_PHONE));

    const optInCall = sentBodies().find((p) => (p.get("Body") ?? "").includes(webOptInConfirmation()));
    expect(optInCall).toBeUndefined();
  });
});

describe("sendSms STOP gate", () => {
  beforeAll(async () => {
    // A STOP is the only way smsConsent is false now, so these rows are written directly.
    await prisma.lead.create({ data: { name: "Consent Test Stopped Lead", phone: DECLINED_PHONE, smsConsent: false } });
    await prisma.customer.create({ data: { name: "Consent Test Punctuated", phone: DECLINED_PUNCTUATED, smsConsent: false } });
    // A customer who was never asked (null).
    await prisma.customer.create({ data: { name: "Consent Test Never Asked", phone: NEVER_ASKED_PHONE, smsConsent: null } });
  });

  it("blocks a number that replied STOP (smsConsent false)", async () => {
    const result = await sendSms(DECLINED_PHONE, "test message", {"messageClass":"transactional","category":"thread_reply"});
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks even when the stored number is punctuated and the dialed one is E.164", async () => {
    const result = await sendSms("+16155559002", "test message", {"messageClass":"transactional","category":"thread_reply"});
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends when smsConsent is true", async () => {
    const result = await sendSms(CONSENTED_PHONE, "test message", {"messageClass":"transactional","category":"thread_reply"});
    expect(result).toMatchObject({ sid: expect.stringContaining("SM_test") });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("SENDS to a known customer who was never asked (null) - there is no consent step any more (Kyle 2026-11-26)", async () => {
    const result = await sendSms(NEVER_ASKED_PHONE, "test message", {"messageClass":"transactional","category":"thread_reply"});
    expect(result).toMatchObject({ sid: expect.stringContaining("SM_test") });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("SENDS to a hand-entered lead (phone source, smsConsent null, never on the website form)", async () => {
    const res = await request(app).post("/leads").set("webhook_secret", WEBHOOK)
      .send({ name: "Consent Test Hand Entered", phone: "+16155559011", source: "phone" });
    expect(res.status).toBe(201);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: res.body.id } })).smsConsent).toBeNull();
    const result = await sendSms("+16155559011", "We can be there Tuesday.", {"messageClass":"transactional","category":"thread_reply"});
    expect(result).toMatchObject({ sid: expect.stringContaining("SM_test") });
  });

  it("one STOP is enough: a number on two records, one never asked and one stopped, is blocked", async () => {
    const phone = "+16155559012";
    await prisma.customer.create({ data: { name: "Consent Test Shared Null", phone, smsConsent: null } });
    await prisma.lead.create({ data: { name: "Consent Test Shared Stop", phone: "(615) 555-9012", smsConsent: false } });
    expect(await sendSms(phone, "test message", {"messageClass":"transactional","category":"thread_reply"})).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not gate a number with no matching Lead/Customer at all (e.g. a technician)", async () => {
    const result = await sendSms(UNKNOWN_PHONE, "test message", {"messageClass":"transactional","category":"thread_reply"});
    expect(result).toMatchObject({ sid: expect.stringContaining("SM_test") });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // Kyle 2026-11-26 (review): the old "bypasses the STOP check for a direct reply" case is gone with the flag. STOP is the only block, so it holds
  // on EVERY customer-class path, including a direct reply to a text the person just sent.
  it("a direct reply is checked for STOP too: there is no bypass option any more", async () => {
    expect(await sendSms(DECLINED_PHONE, "reply to their inbound text", { messageClass: "transactional", category: "thread_reply" })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// Kyle 2026-11-26 (review): a STOP is also kept in the log of inbound STOP/START replies. A number that texted STOP while it was on no
// lead or customer (or whose record was deleted) has no row set to false, yet a lead hand-entered LATER with that number must not be texted.
describe("a logged STOP blocks a lead or customer created after it", () => {
  const LATE_PHONE10 = "6155559301";
  const LATE_PHONE = `+1${LATE_PHONE10}`;
  const clearLog = () => prisma.inboundMessage.deleteMany({ where: { fromPhone: { contains: LATE_PHONE10 } } });
  beforeEach(clearLog);
  afterAll(clearLog);

  it("STOP from a number on no record, then a null-consent lead on that number: sendSms refuses with replied_stop, a later START frees it", async () => {
    const res = await postSignedTwilioWebhook(app, "/sms/inbound", { From: LATE_PHONE, Body: "STOP" });
    expect(res.status).toBe(200);
    expect(await prisma.inboundMessage.count({ where: { fromPhone: { contains: LATE_PHONE10 }, handledAs: "opt_out" } })).toBe(1);

    const lead = await prisma.lead.create({ data: { name: "Consent Test Late Lead", phone: "(615) 555-9301", source: "phone", smsConsent: null } });
    expect(lead.smsConsent).toBeNull();
    const refused = await sendSms(LATE_PHONE, "Are you still interested?", { messageClass: "transactional", category: "thread_reply", hub: { leadId: lead.id } });
    expect(refused).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    const line = await prisma.hubMessage.findFirstOrThrow({ where: { thread: { leadId: lead.id }, channel: "sms" } });
    expect(line).toMatchObject({ status: "blocked", error: "replied_stop" });

    // START logs opt_in (and flips the row to true): the latest keyword now decides, so the number may be texted again.
    await postSignedTwilioWebhook(app, "/sms/inbound", { From: LATE_PHONE, Body: "START" });
    fetchMock.mockClear();
    expect(await sendSms(LATE_PHONE, "Are you still interested?", { messageClass: "transactional", category: "thread_reply" })).toMatchObject({ sid: expect.stringContaining("SM_test") });
  });

  it("the 24-hour reminder to a customer created after a STOP is refused, through the real reminder path", async () => {
    process.env.TWILIO_SENDS_CUSTOMER_LIFECYCLE = "on";
    try {
      await prisma.inboundMessage.create({ data: { fromPhone: LATE_PHONE, body: "STOP", matchType: "unknown", handledAs: "opt_out" } });
      const customer = await prisma.customer.create({
        data: {
          name: "Consent Test Late Customer", phone: LATE_PHONE10, smsConsent: null,
          properties: { create: { name: "Home", addressLine1: "12 Main St", city: "Smyrna", state: "TN", postalCode: "37167" } },
        },
        include: { properties: true },
      });
      const start = new Date(Date.now() + 24 * 3600_000);
      await prisma.visit.create({
        data: { customerId: customer.id, propertyId: customer.properties[0]!.id, mode: "service_call", jobType: "Panel upgrade", status: "estimate", scheduledStart: start, scheduledEnd: new Date(start.getTime() + 2 * 3600_000) },
      });
      await sendVisitReminders();
      expect(sentBodies().map((p) => (p.get("To") ?? "").replace(/\D/g, "").slice(-10))).not.toContain(LATE_PHONE10);
      const row = await prisma.hubMessage.findFirstOrThrow({ where: { thread: { customerId: customer.id }, channel: "sms" } });
      expect(row).toMatchObject({ status: "blocked", error: "replied_stop" });
      await prisma.hubThread.deleteMany({ where: { customerId: customer.id } });
      await prisma.visit.deleteMany({ where: { customerId: customer.id } });
      await prisma.property.deleteMany({ where: { customerId: customer.id } });
    } finally {
      delete process.env.TWILIO_SENDS_CUSTOMER_LIFECYCLE;
    }
  });
});

// Kyle 2026-11-26 (review): the confirmation auto-reply used to call sendSms with the STOP bypass on. It no longer can.
describe("the automatic reply to a customer's C text still honours STOP", () => {
  const PH10 = ["6155559311", "6155559312"] as const;
  const mkCustomer = async (phone10: string, smsConsent: boolean | null) => {
    const customer = await prisma.customer.create({
      data: {
        name: `Consent Test Reply ${phone10}`, phone: phone10, smsConsent,
        properties: { create: { name: "Home", addressLine1: "12 Main St", city: "Smyrna", state: "TN", postalCode: "37167" } },
      },
      include: { properties: true },
    });
    const start = new Date(Date.now() + 72 * 3600_000);
    await prisma.visit.create({
      data: { customerId: customer.id, propertyId: customer.properties[0]!.id, mode: "service_call", jobType: "Panel upgrade", status: "estimate", scheduledStart: start, scheduledEnd: new Date(start.getTime() + 2 * 3600_000) },
    });
    return customer;
  };
  beforeAll(() => {
    process.env.AUTOMATED_CUSTOMER_SENDS = "on";
    process.env.AUTOMATED_CUSTOMER_SENDS_INBOUND_AUTOREPLY = "on";
    process.env.TWILIO_SENDS_CUSTOMER_LIFECYCLE = "on";
  });
  afterAll(async () => {
    delete process.env.AUTOMATED_CUSTOMER_SENDS;
    delete process.env.AUTOMATED_CUSTOMER_SENDS_INBOUND_AUTOREPLY;
    delete process.env.TWILIO_SENDS_CUSTOMER_LIFECYCLE;
    const customers = await prisma.customer.findMany({ where: { name: { startsWith: "Consent Test Reply" } }, select: { id: true } });
    const ids = customers.map((c) => c.id);
    await prisma.hubThread.deleteMany({ where: { OR: [{ customerId: { in: ids } }, { visit: { customerId: { in: ids } } }] } });
    await prisma.visit.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.property.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.customer.deleteMany({ where: { id: { in: ids } } });
  });

  it("a customer who never replied STOP gets the reply; one who did gets none, though the visit is still confirmed", async () => {
    await mkCustomer(PH10[0], null);
    const stopped = await mkCustomer(PH10[1], false);
    await postSignedTwilioWebhook(app, "/sms/inbound", { From: `+1${PH10[0]}`, Body: "C" });
    await waitUntil(() => sentBodies().some((p) => (p.get("To") ?? "").endsWith(PH10[0])));
    fetchMock.mockClear();
    await postSignedTwilioWebhook(app, "/sms/inbound", { From: `+1${PH10[1]}`, Body: "C" });
    await new Promise((r) => setTimeout(r, 300));
    expect(sentBodies().map((p) => p.get("To"))).not.toContain(`+1${PH10[1]}`);
    const visit = await prisma.visit.findFirstOrThrow({ where: { customerId: stopped.id } });
    expect(visit.confirmationStatus).toBe("confirmed");
  });
});

describe("automated texts go to a customer who was never asked, and still stop for a STOP (real paths, nothing mocked)", () => {
  const TAG = "Consent Test Auto";
  let seq = 0;
  async function visitFor(smsConsent: boolean | null, start: Date) {
    const phone10 = `615555${9100 + seq++}`;
    const customer = await prisma.customer.create({
      data: {
        name: `${TAG} ${seq}`, phone: phone10, smsConsent,
        properties: { create: { name: "Home", addressLine1: "12 Main St", city: "Smyrna", state: "TN", postalCode: "37167" } },
      },
      include: { properties: true },
    });
    const visit = await prisma.visit.create({
      data: {
        customerId: customer.id, propertyId: customer.properties[0]!.id, mode: "service_call", jobType: "Panel upgrade", status: "estimate",
        scheduledStart: start, scheduledEnd: new Date(start.getTime() + 2 * 3600_000),
      },
    });
    return { customer, visit, phone10, to: `+1${phone10}` };
  }
  const digitsOf = (n: string | null) => (n ?? "").replace(/\D/g, "").slice(-10);
  const toNumbers = () => sentBodies().map((p) => digitsOf(p.get("To")));

  beforeAll(() => {
    process.env.TWILIO_SENDS_CUSTOMER_LIFECYCLE = "on";
  });
  afterAll(async () => {
    delete process.env.TWILIO_SENDS_CUSTOMER_LIFECYCLE;
    const customers = await prisma.customer.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
    const ids = customers.map((c) => c.id);
    await prisma.hubThread.deleteMany({ where: { OR: [{ customerId: { in: ids } }, { visit: { customerId: { in: ids } } }] } });
    await prisma.visit.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.property.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.customer.deleteMany({ where: { id: { in: ids } } });
  });

  it("the 24-hour reminder (sendVisitReminders) is TEXTED to a customer with smsConsent null, and the conversation line says sent, not 'Not texted'", async () => {
    const a = await visitFor(null, new Date(Date.now() + 24 * 3600_000));
    await sendVisitReminders();
    expect(toNumbers()).toContain(a.phone10);
    const row = await prisma.hubMessage.findFirstOrThrow({ where: { thread: { customerId: a.customer.id }, channel: "sms" } });
    expect(row).toMatchObject({ status: "sent", category: "visit_reminder", error: null });
  });

  it("the same reminder is REFUSED for a customer who replied STOP: nothing goes to Twilio and the line is 'blocked'", async () => {
    const a = await visitFor(false, new Date(Date.now() + 24 * 3600_000));
    await sendVisitReminders();
    expect(toNumbers()).not.toContain(a.phone10);
    const row = await prisma.hubMessage.findFirstOrThrow({ where: { thread: { customerId: a.customer.id }, channel: "sms" } });
    expect(row).toMatchObject({ status: "blocked", error: "replied_stop" });
  });

  it("the visit confirmation request (sendVisitConfirmationRequest) is texted to a customer with smsConsent null", async () => {
    const a = await visitFor(null, new Date(Date.now() + 72 * 3600_000));
    const out = await sendVisitConfirmationRequest({
      visitId: a.visit.id, customerId: a.customer.id, customerName: "Jane Smith", phone: a.to, email: null, address: "12 Main St, Smyrna",
      jobType: "Panel upgrade", scheduledStart: a.visit.scheduledStart!, scheduledEnd: a.visit.scheduledEnd, visitKind: "estimate",
    });
    expect(out.sms).toBe(true);
    expect(toNumbers()).toContain(a.phone10);
  });

  it("a reschedule text (visit_rescheduled through sendCustomerSms) is texted to a customer with smsConsent null, and refused for a STOP", async () => {
    const never = await visitFor(null, new Date(Date.now() + 72 * 3600_000));
    const stopped = await visitFor(false, new Date(Date.now() + 72 * 3600_000));
    const meta = (visitId: string, customerId: string) => ({
      messageClass: "transactional" as const, category: "visit_rescheduled", hub: { customerId, visitId },
    });
    expect(await sendCustomerSms(never.to, "Your visit moved to Thursday.", meta(never.visit.id, never.customer.id))).toMatchObject({ sid: expect.stringContaining("SM_test") });
    expect(await sendCustomerSms(stopped.to, "Your visit moved to Thursday.", meta(stopped.visit.id, stopped.customer.id))).toBeNull();
    expect(toNumbers()).toContain(never.phone10);
    expect(toNumbers()).not.toContain(stopped.phone10);
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

  it("STOP flips every matching Customer and Lead to false (replied STOP), regardless of stored format", async () => {
    const res = await postSignedTwilioWebhook(app, "/sms/inbound", { From: STOP_PHONE, Body: "STOP" });
    expect(res.status).toBe(200);

    const customer = await prisma.customer.findUniqueOrThrow({ where: { id: customerId } });
    const lead = await prisma.lead.findUniqueOrThrow({ where: { id: leadId } });
    expect(customer.smsConsent).toBe(false);
    expect(lead.smsConsent).toBe(false);

    // And the gate now blocks them.
    fetchMock.mockClear();
    expect(await sendSms(STOP_PHONE, "should not go out", {"messageClass":"transactional","category":"thread_reply"})).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("START opts them back in", async () => {
    const res = await postSignedTwilioWebhook(app, "/sms/inbound", { From: STOP_PHONE, Body: "START" });
    expect(res.status).toBe(200);

    const customer = await prisma.customer.findUniqueOrThrow({ where: { id: customerId } });
    const lead = await prisma.lead.findUniqueOrThrow({ where: { id: leadId } });
    expect(customer.smsConsent).toBe(true);
    expect(lead.smsConsent).toBe(true);
  });
});
