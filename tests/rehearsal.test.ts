/**
 * Work order agent-team, TC10 (batch C5a): an approval on a TEST ACCOUNT never calls real email or SMS.
 *
 * Spies on the two things that would leave the building: the mailer (nodemailer's sendMail, plus any fetch to
 * Resend) and Twilio (fetch to api.twilio.com). Everything else is real. Pinned here:
 *   * inside the rehearsal context, sendCustomerEmail and sendSms answer "skipped (test account)" / null with
 *     ZERO mailer and ZERO Twilio calls, and each skip is a SystemEvent;
 *   * scheduleJob, rescheduleJob and cancelJob (no new parameter) on a test account, run inside the context,
 *     make zero mailer and zero SMS calls AND still write the visit; the same three calls outside the context
 *     DO reach the spies (so the spies work);
 *   * hubSend on a test account's thread settles an email and a text exactly as for a customer, with nothing
 *     sent, no provider id, the texting switch off or not, and the card says so before and after.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

process.env.GMAIL_USER = "service@example.test";
process.env.GOOGLE_CLIENT_ID = "test_id";
process.env.GOOGLE_CLIENT_SECRET = "test_secret";
process.env.GOOGLE_REFRESH_TOKEN = "test_token";
process.env.RESEND_API_KEY = "re_test_key_never_used";
delete process.env.TRANSACTIONAL_EMAIL_PROVIDER;

const mail = vi.hoisted(() => ({ sendMail: vi.fn<(opts: Record<string, unknown>) => Promise<unknown>>() }));
vi.mock("nodemailer", () => ({ default: { createTransport: () => ({ sendMail: mail.sendMail }) } }));
vi.mock("googleapis", () => {
  class MockOAuth2 { setCredentials() {} }
  return {
    google: {
      auth: { OAuth2: MockOAuth2 },
      calendar: () => ({
        freebusy: { query: vi.fn().mockResolvedValue({ data: { calendars: { primary: { busy: [] } } } }) },
        events: {
          insert: vi.fn().mockImplementation((p: { requestBody: object }) => Promise.resolve({ data: { id: `gcal_rh_${Math.random().toString(36).slice(2)}`, ...p.requestBody } })),
          patch: vi.fn().mockResolvedValue({ data: { id: "gcal_moved" } }),
          delete: vi.fn().mockResolvedValue({}),
          get: vi.fn().mockResolvedValue({ data: { id: "own", start: { dateTime: "2000-01-01T15:00:00.000Z" }, end: { dateTime: "2000-01-01T20:00:00.000Z" } } }),
          list: vi.fn().mockResolvedValue({ data: { items: [] } }),
        },
      }),
    },
  };
});

const fetchMock = vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>();
vi.stubGlobal("fetch", fetchMock);

import { prisma } from "../src/lib/prisma";
import { sendSms } from "../src/services/twilio";
import { sendCustomerEmail } from "../src/services/transactionalEmail";
import { runAsRehearsal, inRehearsal, REHEARSAL_CARD_LINE, REHEARSAL_RESULT_LINE, REHEARSAL_SKIPPED } from "../src/services/rehearsal";
import { cancelJob, rescheduleJob, scheduleJob } from "../src/services/scheduling";
import { ensureThreadFor, type HubReader } from "../src/services/hub";
import { waitingDraft } from "./helpers/waitingDraft"; // Kyle 2026-11-24: an agent message now SENDS when posted; these tests need a card already waiting (a pre-deploy one)
import { approveMessage } from "../src/services/hubApproval";
import { approvalCardFor } from "../src/services/hubCards";

const TAG = "Rehearsal";
const DOMAIN = `rehearsal-${Date.now()}.example`;
const AI: HubReader = { key: "ai-admin", kind: "ai-admin", display: "RCE Admin", technicianId: null, threadKinds: [], agentRole: null, agentKeyId: null, isKyle: false };
const KYLE: HubReader = { key: "owner", kind: "owner", display: "Kyle", technicianId: null, threadKinds: [], agentRole: null, agentKeyId: null, isKyle: true };
let phoneSeq = 1000 + Math.floor(Math.random() * 7000);
const newPhone10 = () => `615558${phoneSeq++}`;

const twilioCalls = () => fetchMock.mock.calls.filter(([u]) => String(u).includes("api.twilio.com"));
const resendCalls = () => fetchMock.mock.calls.filter(([u]) => String(u).includes("api.resend.com"));
const outbound = () => twilioCalls().length + resendCalls().length + mail.sendMail.mock.calls.length;
const quiet = (ms = 350) => new Promise((r) => setTimeout(r, ms));

function stubNetwork() {
  let n = 0;
  fetchMock.mockReset();
  mail.sendMail.mockReset();
  mail.sendMail.mockResolvedValue({});
  fetchMock.mockImplementation(async (url) => String(url).includes("api.twilio.com")
    ? new Response(JSON.stringify({ sid: `SM${randomUUID().replace(/-/g, "")}${n++}`, status: "queued" }), { status: 201, headers: { "Content-Type": "application/json" } })
    : new Response(JSON.stringify({ id: `re_${randomUUID()}` }), { status: 200, headers: { "Content-Type": "application/json" } }));
}

async function wipe() {
  const customers = await prisma.customer.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
  const ids = customers.map((c) => c.id);
  await prisma.hubThread.deleteMany({ where: { OR: [{ customerId: { in: ids } }, { visit: { customerId: { in: ids } } }] } });
  await prisma.emailDelivery.deleteMany({ where: { to: { endsWith: `@${DOMAIN}` } } });
  if (ids.length > 0) {
    await prisma.slotHold.deleteMany({});
    await prisma.visit.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.property.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.customer.deleteMany({ where: { id: { in: ids } } });
  }
}

beforeAll(async () => {
  process.env.TWILIO_ACCOUNT_SID = "ACtest";
  process.env.TWILIO_AUTH_TOKEN = "tok";
  process.env.TWILIO_SMS_NUMBER = "+16155550000";
  await wipe();
});
afterAll(async () => {
  await wipe();
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_AUTH_TOKEN;
  delete process.env.TWILIO_SMS_NUMBER;
});
beforeEach(() => {
  stubNetwork();
  // Every leg is OPEN, so the only thing that can stop a send below is the rehearsal.
  process.env.TWILIO_SENDS = "on";
  process.env.AUTOMATED_CUSTOMER_SENDS = "on";
  delete process.env.HUB_SMS_OUTBOUND_ENABLED;
});
afterEach(async () => {
  delete process.env.TWILIO_SENDS;
  delete process.env.AUTOMATED_CUSTOMER_SENDS;
  delete process.env.HUB_SMS_OUTBOUND_ENABLED;
  await wipe();
});

let seq = 0;
async function account(isTestAccount: boolean) {
  const phone = newPhone10();
  const email = `c${seq}@${DOMAIN}`;
  const customer = await prisma.customer.create({
    data: {
      name: `${TAG} ${seq++}`, phone, email, smsConsent: true, isTestAccount,
      properties: { create: { name: "Home", addressLine1: "12 Main St", city: "Smyrna", state: "TN", postalCode: "37167" } },
    },
    include: { properties: true },
  });
  const visit = await prisma.visit.create({
    data: { customerId: customer.id, propertyId: customer.properties[0]!.id, mode: "service_call", jobType: "Panel upgrade", status: "estimate" },
  });
  return { customer, visit, phone, email };
}

describe("the rehearsal context at the two doors", () => {
  it("sendCustomerEmail and sendSms inside it send nothing and say so; each skip is a SystemEvent", async () => {
    const a = await account(true);
    expect(inRehearsal()).toBe(false);
    const result = await runAsRehearsal(async () => {
      expect(inRehearsal()).toBe(true);
      const e = await sendCustomerEmail({ to: a.email, subject: "Hello", html: "<p>Hi</p>", text: "Hi", kind: "appointment" });
      const s = await sendSms(a.phone, "Hi.", { messageClass: "transactional", category: "visit_reminder" });
      return { e, s };
    }, a.customer.id);
    expect(result.e).toEqual({ ok: true, provider: REHEARSAL_SKIPPED, id: null, deliveryId: "" });
    expect(result.s).toBeNull();
    expect(outbound()).toBe(0);
    expect(await prisma.emailDelivery.count({ where: { to: a.email } })).toBe(0);
    await vi.waitFor(async () => {
      const events = await prisma.systemEvent.findMany({ where: { source: "rehearsal", message: { contains: "skipped (test account)" } }, orderBy: { createdAt: "desc" }, take: 10 });
      expect(events.map((e) => e.message).join("\n")).toMatch(/email skipped \(test account\): appointment email/);
      expect(events.map((e) => e.message).join("\n")).toMatch(/sms skipped \(test account\): transactional \/ visit_reminder/);
    });
    expect(inRehearsal()).toBe(false);
  });

  it("outside the context the same two calls DO reach the spies (so a zero above means something)", async () => {
    const a = await account(false);
    const e = await sendCustomerEmail({ to: a.email, subject: "Hello", html: "<p>Hi</p>", text: "Hi", kind: "appointment" });
    const s = await sendSms(a.phone, "Hi.", { messageClass: "transactional", category: "visit_reminder" });
    expect(e.ok).toBe(true);
    expect(s).not.toBeNull();
    expect(resendCalls().length + mail.sendMail.mock.calls.length).toBe(1);
    expect(twilioCalls()).toHaveLength(1);
  });
});

describe("booking, rescheduling and cancelling on a test account", () => {
  it("makes zero mailer and zero SMS calls and still writes the visit; the same calls on a real account reach them", async () => {
    const a = await account(true);
    await runAsRehearsal(async () => {
      const booked = await scheduleJob(a.visit.id, "2031-10-06", "09:00");
      expect(booked.googleEventId).toBeTruthy();
      await rescheduleJob(a.visit.id, "2031-10-07", "09:00", "customer asked");
      await cancelJob(a.visit.id, "rehearsal over");
    }, a.customer.id);
    await quiet(); // the confirmation request and the tech notices are fire-and-forget
    expect(outbound()).toBe(0);
    const visit = await prisma.visit.findUniqueOrThrow({ where: { id: a.visit.id } });
    expect(visit.status).toBe("cancelled"); // the work was real: the visit was booked, moved and cancelled

    const real = await account(false);
    await scheduleJob(real.visit.id, "2031-10-06", "09:00");
    await vi.waitFor(() => expect(outbound()).toBeGreaterThan(0));
    expect(twilioCalls().length).toBeGreaterThan(0);
    expect(resendCalls().length + mail.sendMail.mock.calls.length).toBeGreaterThan(0);
  });
});

describe("the Messages hub on a test account's thread", () => {
  it("an approved email and an approved text settle as sent with nothing sent, the card says so before and after, and the texting switch does not hold it", async () => {
    const a = await account(true);
    const thread = await ensureThreadFor({ customerId: a.customer.id });
    const { message: email } = await waitingDraft(AI, { threadId: thread.id, channel: "email", category: "thread_reply", subject: "Tuesday", body: "We can be there Tuesday morning." });
    const { message: text } = await waitingDraft(AI, { threadId: thread.id, channel: "sms", category: "confirmation_request", body: "Tuesday works." });

    const before = await approvalCardFor(KYLE, text.id);
    expect(before.chip).toEqual({ tone: "internal", text: REHEARSAL_CARD_LINE });
    expect(before.effectLines[0]).toBe(REHEARSAL_CARD_LINE);
    expect(REHEARSAL_CARD_LINE).toBe("Test account — nothing is emailed or texted");

    const e = await approveMessage(KYLE, email.id);
    const t = await approveMessage(KYLE, text.id);
    expect(e.send).toMatchObject({ status: "sent", error: null });
    expect(t.send).toMatchObject({ status: "sent", error: null }); // not held "SMS disabled": a rehearsal is not a send
    expect(e.card.outcome.text).toBe(REHEARSAL_RESULT_LINE);
    expect(t.card.outcome.text).toBe("Rehearsal: email and text skipped");
    expect(outbound()).toBe(0);

    const row = await prisma.hubMessage.findUniqueOrThrow({ where: { id: text.id } });
    expect(row).toMatchObject({ status: "sent", providerMessageId: null, footerIncluded: true });
    expect(row.sentText).toMatch(/^Red Cedar Electric: Appointment Confirmation /);
    expect((await prisma.hubMessage.findUniqueOrThrow({ where: { id: email.id } })).emailDeliveryId).toBeNull();
  });

  it("a real account's card does not say 'Test account', and its approved text really goes out when texting is on", async () => {
    process.env.HUB_SMS_OUTBOUND_ENABLED = "on";
    const a = await account(false);
    const thread = await ensureThreadFor({ customerId: a.customer.id });
    const { message: text } = await waitingDraft(AI, { threadId: thread.id, channel: "sms", category: "confirmation_request", body: "Tuesday works." });
    const card = await approvalCardFor(KYLE, text.id);
    expect(JSON.stringify(card.effectLines) + card.chip.text).not.toContain("Test account");
    const done = await approveMessage(KYLE, text.id);
    expect(done.send).toMatchObject({ status: "sent" });
    expect(done.card.outcome.text).toMatch(/^Sent by /);
    expect(twilioCalls()).toHaveLength(1);
  });
});
