/**
 * The Conversation's "Text the customer" box, server side (Kyle 2026-11-26: "Every lead and every customer with a phone number gets a working
 * text box in Conversation, whether or not they came from the website form or have been converted to an account ... STOP is the ONLY reason a
 * text should ever be blocked"). Pinned through the REAL route (POST /communications/text, an office PIN session), the one sender (hubSend) and
 * the real timeline, with only Twilio's HTTP door stubbed:
 *   - a hand-entered lead (phone source, smsConsent null, never on the website form, no account) is texted;
 *   - an account and a job send too, the job's text tagged to the job and filed on the customer's conversation;
 *   - a STOP is refused: 409 with the reason, the text recorded as 'blocked' (shown as "Not texted"), nothing sent;
 *   - no phone is refused before anything is written; texting switched off is recorded, not sent, and not lost;
 *   - a retry with the same clientMessageId sends once;
 *   - the timeline says why the box is greyed (STOP, no phone) and says nothing for a lead that may be texted.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";

process.env.GMAIL_USER = "service@example.test";
process.env.GOOGLE_CLIENT_ID = "test_id";
process.env.GOOGLE_CLIENT_SECRET = "test_secret";
process.env.GOOGLE_REFRESH_TOKEN = "test_token";
process.env.RESEND_API_KEY = "re_test_key_never_used";
vi.mock("stripe", () => ({ default: class MockStripe { constructor() { throw new Error("Stripe must not be constructed in tests"); } } }));
vi.mock("googleapis");
const fetchMock = vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>();
vi.stubGlobal("fetch", fetchMock);

import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { hashPin } from "../src/middleware/pinAuth";
import { buildTimeline } from "../src/services/hubTimeline";
import { twilioLegEnvVar } from "../src/services/automationGate";
import type { HubReader } from "../src/services/hub";

const TAG = "OfficeText";
const PIN = "1234";
const LEG = twilioLegEnvVar("hubSms");
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const twilioCalls = () => fetchMock.mock.calls.filter(([u]) => String(u).includes("api.twilio.com"));
const OWNER: HubReader = { key: "owner", kind: "owner", display: "Kyle", technicianId: null, threadKinds: [], agentRole: null, agentKeyId: null, isKyle: true };

let savedPin: string | undefined;
let token = "";
let seq = 0;
const newPhone = () => `615554${1000 + (seq++ % 8000)}`;

async function wipe() {
  const customers = await prisma.customer.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
  const leads = await prisma.lead.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
  const cids = customers.map((c) => c.id);
  const lids = leads.map((l) => l.id);
  await prisma.hubThread.deleteMany({ where: { OR: [{ customerId: { in: cids } }, { leadId: { in: lids } }, { visit: { customerId: { in: cids } } }] } });
  await prisma.visit.deleteMany({ where: { customerId: { in: cids } } });
  await prisma.property.deleteMany({ where: { customerId: { in: cids } } });
  await prisma.lead.deleteMany({ where: { id: { in: lids } } });
  await prisma.customer.deleteMany({ where: { id: { in: cids } } });
}

beforeAll(async () => {
  savedPin = process.env.PIN_HASH;
  process.env.PIN_HASH = await hashPin(PIN);
  process.env.TWILIO_ACCOUNT_SID = "ACtest";
  process.env.TWILIO_AUTH_TOKEN = "tok";
  process.env.TWILIO_SMS_NUMBER = "+16155550000";
  await wipe();
  token = (await request(app).post("/auth/pin").send({ pin: PIN })).body.token as string;
});
afterAll(async () => {
  if (savedPin === undefined) delete process.env.PIN_HASH; else process.env.PIN_HASH = savedPin;
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_AUTH_TOKEN;
  delete process.env.TWILIO_SMS_NUMBER;
  delete process.env[LEG];
  await wipe();
});
beforeEach(() => {
  process.env[LEG] = "on";
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => new Response(JSON.stringify({ sid: `SM${randomUUID().replace(/-/g, "")}`, status: "queued" }), { status: 201 }));
});
afterEach(async () => {
  delete process.env[LEG];
  await wipe();
});

const lead = (over: { smsConsent?: boolean | null; phone?: string | null } = {}) =>
  prisma.lead.create({
    data: { name: `${TAG} Lead ${seq++}`, source: "phone", phone: over.phone === undefined ? newPhone() : over.phone, smsConsent: over.smsConsent === undefined ? null : over.smsConsent },
  });
const text = (body: Record<string, unknown>) => request(app).post("/communications/text").set(bearer(token)).send(body);

describe("POST /communications/text", () => {
  it("texts a brand-new hand-entered lead: smsConsent null, phone source, no website form, no account", async () => {
    const l = await lead();
    expect(l.smsConsent).toBeNull();
    const res = await text({ target: "lead", id: l.id, body: "We can be there Tuesday at 9. Does that work?" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ sent: true });

    expect(twilioCalls()).toHaveLength(1);
    const params = new URLSearchParams(String(twilioCalls()[0]![1]?.body));
    expect(params.get("To")).toBe(`+1${l.phone}`);
    // The one composer wrote the header and the first-text footer around the words.
    expect(params.get("Body")).toContain("We can be there Tuesday at 9. Does that work?");
    expect(params.get("Body")!.startsWith("Red Cedar Electric: ")).toBe(true);
    expect(params.get("Body")!.endsWith("Reply STOP to opt out.")).toBe(true);

    const row = await prisma.hubMessage.findUniqueOrThrow({ where: { id: res.body.messageId } });
    expect(row).toMatchObject({ authorType: "office", direction: "outbound", channel: "sms", status: "sent", category: "thread_reply", error: null });
    expect(row.sentAt).not.toBeNull();
    // It is in the lead's own Conversation, and the timeline says the box works.
    const tl = await buildTimeline(OWNER, { leadId: l.id });
    expect(tl.entries.some((e) => e.type === "message" && e.message.id === row.id)).toBe(true);
    expect(tl.textBlock).toBeNull();
  });

  it("texts an account, and a job's text goes to the job's customer and is tagged to the job", async () => {
    const customer = await prisma.customer.create({
      data: {
        name: `${TAG} Acct ${seq++}`, phone: newPhone(), smsConsent: null,
        properties: { create: { name: "Home", addressLine1: "12 Main St", city: "Smyrna", state: "TN", postalCode: "37167" } },
      },
      include: { properties: true },
    });
    const visit = await prisma.visit.create({ data: { customerId: customer.id, propertyId: customer.properties[0]!.id, mode: "service_call", jobType: "Panel upgrade" } });

    const a = await text({ target: "account", id: customer.id, body: "Running 15 minutes late." });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    const j = await text({ target: "job", id: visit.id, body: "On our way." });
    expect(j.status, JSON.stringify(j.body)).toBe(200);
    expect(twilioCalls()).toHaveLength(2);

    const rows = await prisma.hubMessage.findMany({ where: { thread: { customerId: customer.id }, channel: "sms" }, orderBy: { createdAt: "asc" } });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.visitId)).toEqual([null, visit.id]);
    expect(rows.every((r) => r.status === "sent")).toBe(true);
  });

  it("refuses a lead who replied STOP: 409 with the reason, nothing sent, recorded as blocked (shown as 'Not texted')", async () => {
    const l = await lead({ smsConsent: false });
    const res = await text({ target: "lead", id: l.id, body: "Are you still interested?" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/replied STOP/);
    expect(res.body.sent).toBe(false);
    expect(twilioCalls()).toHaveLength(0);
    const row = await prisma.hubMessage.findUniqueOrThrow({ where: { id: res.body.messageId } });
    expect(row).toMatchObject({ status: "blocked", error: "replied_stop", authorType: "office" });
    expect(await prisma.hubAuditLog.count({ where: { messageId: row.id, action: "send_blocked" } })).toBe(1);
  });

  it("the timeline greys the box with the reason for a STOP and for no phone, and for nothing else", async () => {
    const stopped = await lead({ smsConsent: false });
    expect((await buildTimeline(OWNER, { leadId: stopped.id })).textBlock).toMatch(/replied STOP/);
    const noPhone = await lead({ phone: null });
    expect((await buildTimeline(OWNER, { leadId: noPhone.id })).textBlock).toMatch(/no phone number/i);
    const never = await lead({ smsConsent: null });
    expect((await buildTimeline(OWNER, { leadId: never.id })).textBlock).toBeNull();
    const ticked = await lead({ smsConsent: true });
    expect((await buildTimeline(OWNER, { leadId: ticked.id })).textBlock).toBeNull();
  });

  // Kyle 2026-11-26 (review): a STOP logged from a number that was on no record must still stop a lead hand-entered later.
  it("a STOP logged before the lead existed refuses the text (409 replied_stop) and greys the box", async () => {
    const phone10 = newPhone();
    await prisma.inboundMessage.create({ data: { fromPhone: `+1${phone10}`, body: "STOP", matchType: "unknown", handledAs: "opt_out" } });
    try {
      const l = await lead({ phone: phone10 });
      expect(l.smsConsent).toBeNull();
      const res = await text({ target: "lead", id: l.id, body: "Are you still interested?" });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/replied STOP/);
      expect(twilioCalls()).toHaveLength(0);
      const row = await prisma.hubMessage.findUniqueOrThrow({ where: { id: res.body.messageId } });
      expect(row).toMatchObject({ status: "blocked", error: "replied_stop" });
      expect((await buildTimeline(OWNER, { leadId: l.id })).textBlock).toMatch(/replied STOP/);
    } finally {
      await prisma.inboundMessage.deleteMany({ where: { fromPhone: `+1${phone10}` } });
    }
  });

  // Kyle 2026-11-26 (review): the box is greyed with the reason BEFORE the click when texting is switched off, so Send never writes a held row.
  it("the timeline greys the box with 'Texting is turned off' while the texting leg is off", async () => {
    const l = await lead();
    expect((await buildTimeline(OWNER, { leadId: l.id })).textBlock).toBeNull();
    delete process.env[LEG];
    expect((await buildTimeline(OWNER, { leadId: l.id })).textBlock).toMatch(/texting is turned off/i);
  });

  it("refuses a record with no phone before anything is written", async () => {
    const l = await lead({ phone: null });
    const res = await text({ target: "lead", id: l.id, body: "Hello." });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no phone number/i);
    expect(twilioCalls()).toHaveLength(0);
    expect(await prisma.hubMessage.count({ where: { thread: { leadId: l.id } } })).toBe(0);
  });

  it("with texting switched off the text is recorded as not sent (held), with the reason, and nothing goes to Twilio", async () => {
    delete process.env[LEG];
    const l = await lead();
    const res = await text({ target: "lead", id: l.id, body: "Hello." });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/texting is turned off/i);
    expect(twilioCalls()).toHaveLength(0);
    const row = await prisma.hubMessage.findUniqueOrThrow({ where: { id: res.body.messageId } });
    expect(row.status).toBe("approved");
  });

  it("a retry with the same clientMessageId sends once", async () => {
    const l = await lead();
    const clientMessageId = randomUUID();
    const first = await text({ target: "lead", id: l.id, body: "Hello.", clientMessageId });
    const second = await text({ target: "lead", id: l.id, body: "Hello.", clientMessageId });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.messageId).toBe(first.body.messageId);
    expect(twilioCalls()).toHaveLength(1);
  });

  it("refuses an empty text and needs a signed-in session", async () => {
    const l = await lead();
    expect((await text({ target: "lead", id: l.id, body: "   " })).status).toBe(400);
    const anon = await request(app).post("/communications/text").send({ target: "lead", id: l.id, body: "Hello." });
    expect([401, 403]).toContain(anon.status);
    expect(twilioCalls()).toHaveLength(0);
  });
});
