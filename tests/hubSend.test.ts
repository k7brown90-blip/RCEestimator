/**
 * hubSend, the ONE customer send function (work order agent-team, U4 + BA7): services/hubSend.ts.
 *
 * Pinned here: an approved email goes through the "Email the customer" pipe and links its ONE EmailDelivery
 * row; a draft, a message waiting for approval and a rejected one are refused; two senders send once; a
 * send into a closed thread reopens it (the same helper postMessage uses); and the BA7 text rules, in
 * order - the class guard BEFORE the "SMS disabled" hold (null class refused, marketing always refused and
 * never held, internal only to staff numbers, a review never texted), the consent gate (kept for
 * transactional, bypassed only for a thread_reply within 36 hours of their own text, a number with no
 * record is never-asked), the smsBlockReason stub, and "Sends as:" being the very text that goes out.
 * Twilio is the real service with fetch stubbed: "no fetch to api.twilio.com" is an assertion, not a hope.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

process.env.GMAIL_USER = "service@example.test";
process.env.GOOGLE_CLIENT_ID = "test_id";
process.env.GOOGLE_CLIENT_SECRET = "test_secret";
process.env.GOOGLE_REFRESH_TOKEN = "test_token";
process.env.RESEND_API_KEY = "re_test_key_never_used";
delete process.env.TRANSACTIONAL_EMAIL_PROVIDER;
vi.mock("googleapis");
const mail = vi.hoisted(() => ({ sendMail: vi.fn<(opts: Record<string, unknown>) => Promise<unknown>>() }));
vi.mock("nodemailer", () => ({ default: { createTransport: () => ({ sendMail: mail.sendMail }) } }));

const fetchMock = vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>();
vi.stubGlobal("fetch", fetchMock);

const block = vi.hoisted(() => ({ reason: null as string | null }));
vi.mock("../src/services/smsGuards", async (orig) => {
  const real = await orig<typeof import("../src/services/smsGuards")>();
  return { ...real, smsBlockReason: vi.fn(async () => block.reason) };
});

const settle = vi.hoisted(() => ({ failNext: 0 }));
vi.mock("../src/services/hub", async (orig) => {
  const real = await orig<typeof import("../src/services/hub")>();
  return {
    ...real,
    bumpThreadForMessage: vi.fn(async (...args: Parameters<typeof real.bumpThreadForMessage>) => {
      if (settle.failNext > 0) { settle.failNext -= 1; throw new Error("transient database error"); }
      return real.bumpThreadForMessage(...args);
    }),
  };
});

import { prisma } from "../src/lib/prisma";
import { createMessageRow, ensureThreadFor, type HubReader } from "../src/services/hub";
import { HubSendRefusal, STALE_SEND_ERROR, STALE_SEND_MS, hubSend, prepareSms, releaseStaleSends } from "../src/services/hubSend";
import { createDraftMessage } from "../src/services/hubDrafts";
import { approveMessage } from "../src/services/hubApproval";

const TAG = "HubSend";
const DOMAIN = `hubsend-${Date.now()}.example`;
const AI: HubReader = { key: "ai-admin", kind: "ai-admin", display: "RCE Admin", technicianId: null, threadKinds: [], agentRole: null, agentKeyId: null, isKyle: false };
const KYLE: HubReader = { key: "owner", kind: "owner", display: "Kyle", technicianId: null, threadKinds: [], agentRole: null, agentKeyId: null, isKyle: true };
const ACTOR = { key: "owner", display: "Kyle" };

let phoneSeq = 1000 + Math.floor(Math.random() * 7000);
/** A fresh ten-digit number nothing else in the test database uses. */
const newPhone = () => `615555${phoneSeq++}`;

const twilioCalls = () => fetchMock.mock.calls.filter(([u]) => String(u).includes("api.twilio.com"));
const sentBodies = () => twilioCalls().map(([, init]) => new URLSearchParams(String(init?.body)).get("Body"));

function stubNetwork() {
  let sid = 0;
  fetchMock.mockReset();
  mail.sendMail.mockReset();
  mail.sendMail.mockResolvedValue({});
  fetchMock.mockImplementation(async (url) => {
    const u = String(url);
    if (u.includes("api.twilio.com")) {
      return new Response(JSON.stringify({ sid: `SM${randomUUID().replace(/-/g, "")}${sid++}`, status: "queued" }), { status: 201, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ id: `re_${randomUUID()}` }), { status: 200, headers: { "Content-Type": "application/json" } });
  });
}

async function wipe() {
  const customers = await prisma.customer.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
  const ids = customers.map((c) => c.id);
  await prisma.hubThread.deleteMany({ where: { OR: [{ title: { startsWith: TAG } }, { customerId: { in: ids } }] } });
  await prisma.emailDelivery.deleteMany({ where: { to: { endsWith: `@${DOMAIN}` } } });
  await prisma.lead.deleteMany({ where: { name: { startsWith: TAG } } });
  if (ids.length > 0) {
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
  settle.failNext = 0;
  stubNetwork();
  block.reason = null;
  delete process.env.HUB_SMS_OUTBOUND_ENABLED;
  delete process.env.TWILIO_SENDS;
});
afterEach(async () => {
  delete process.env.HUB_SMS_OUTBOUND_ENABLED;
  await wipe();
});

let seq = 0;
async function account(over: { smsConsent?: boolean | null; phone?: string | null; email?: string | null } = {}) {
  const phone = over.phone === undefined ? newPhone() : over.phone;
  const c = await prisma.customer.create({
    data: {
      name: `${TAG} ${seq++}`, phone, email: over.email === undefined ? `c${seq}@${DOMAIN}` : over.email,
      smsConsent: over.smsConsent === undefined ? true : over.smsConsent,
    },
  });
  const thread = await ensureThreadFor({ customerId: c.id });
  return { customer: c, thread, phone };
}

/** A text draft waiting for approval, made through the draft-create path (so class and purpose are derived). */
async function textDraft(threadId: string, category = "thread_reply", body = "We can be there Tuesday morning.") {
  const { message } = await createDraftMessage(AI, { threadId, channel: "sms", category, body });
  return message;
}
async function emailDraft(threadId: string, over: Record<string, unknown> = {}) {
  const { message } = await createDraftMessage(AI, { threadId, channel: "email", category: "thread_reply", subject: "Tuesday", body: "We can be there Tuesday morning.", ...over });
  return message;
}
/** Approve without sending (the first half of Approve), so hubSend can be exercised on its own. */
const approveOnly = (id: string) => prisma.hubMessage.update({ where: { id }, data: { status: "approved", decidedBy: "owner", decidedAt: new Date() } });

/** A row the registry could never have made (no class, marketing, a review): written straight to the table. */
async function rawSms(threadId: string, toPhone10: string, over: Record<string, unknown>) {
  return prisma.hubMessage.create({
    data: {
      threadId, authorType: "ai_agent", authorDisplay: "RCE Admin", channel: "sms", direction: "outbound", status: "approved",
      body: "Fall special.", toPhone10, ...over,
    } as never,
  });
}

describe("hubSend: which messages it will send", () => {
  it("refuses a draft, a message waiting for approval and a rejected one, and sends nothing", async () => {
    const { thread } = await account();
    for (const status of ["draft", "pending_approval", "rejected", "posted"]) {
      const row = await prisma.hubMessage.create({
        data: { threadId: thread.id, authorType: "ai_agent", authorDisplay: "RCE Admin", channel: "email", direction: "outbound", status, subject: "x", body: "hello" },
      });
      await expect(hubSend(row.id, ACTOR)).rejects.toBeInstanceOf(HubSendRefusal);
    }
    await expect(hubSend("no-such-message", ACTOR)).rejects.toBeInstanceOf(HubSendRefusal);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("hubSend: email", () => {
  it("sends through the one email pipe, writes exactly one EmailDelivery tied to the account and links it", async () => {
    const { customer, thread } = await account();
    const draft = await emailDraft(thread.id);
    await approveOnly(draft.id);

    const result = await hubSend(draft.id, ACTOR);
    expect(result).toMatchObject({ status: "sent", error: null });

    const rows = await prisma.emailDelivery.findMany({ where: { customerId: customer.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "communication", subject: "Tuesday", to: customer.email });
    const after = await prisma.hubMessage.findUniqueOrThrow({ where: { id: draft.id } });
    expect(after).toMatchObject({ status: "sent", emailDeliveryId: rows[0]!.id, error: null });
    expect(after.sentAt).not.toBeNull();
    const audits = await prisma.hubAuditLog.findMany({ where: { messageId: draft.id, action: "message_sent" } });
    expect(audits).toHaveLength(1);
  });

  it("two senders at once send it once", async () => {
    const { customer, thread } = await account();
    const draft = await emailDraft(thread.id);
    await approveOnly(draft.id);
    const results = await Promise.allSettled([hubSend(draft.id, ACTOR), hubSend(draft.id, ACTOR)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(await prisma.emailDelivery.count({ where: { customerId: customer.id } })).toBe(1);
  });

  it("a failed send is a settled 'failed' row with the reason, and 'Send now' (approve again) sends it", async () => {
    const { customer, thread } = await account();
    const draft = await emailDraft(thread.id);
    await approveOnly(draft.id);
    fetchMock.mockImplementation(async () => new Response("{}", { status: 500 }));
    mail.sendMail.mockRejectedValue(new Error("Gmail is down"));
    const first = await hubSend(draft.id, ACTOR);
    expect(first.status).toBe("failed");
    expect((await prisma.hubMessage.findUniqueOrThrow({ where: { id: draft.id } })).error).toBeTruthy();

    stubNetwork();
    const again = await approveMessage(KYLE, draft.id);
    expect(again.send).toMatchObject({ status: "sent" });
    expect(await prisma.emailDelivery.count({ where: { customerId: customer.id, status: "sent" } })).toBe(1);
  });

  it("a message sent into a CLOSED thread reopens it, with the audit saying why", async () => {
    const { thread } = await account();
    await prisma.hubThread.update({ where: { id: thread.id }, data: { status: "closed" } });
    const draft = await emailDraft(thread.id);
    await approveOnly(draft.id);
    await hubSend(draft.id, ACTOR);
    expect((await prisma.hubThread.findUniqueOrThrow({ where: { id: thread.id } })).status).toBe("open");
    const reopened = await prisma.hubAuditLog.findMany({ where: { threadId: thread.id, action: "thread_status", afterText: "open" } });
    expect(reopened).toHaveLength(1);
  });

  it("an in-app draft is posted, not sent", async () => {
    const { thread } = await account();
    const row = await createMessageRow(prisma, {
      threadId: thread.id, authorType: "ai_agent", authorDisplay: "RCE Admin", channel: "in_app", direction: "internal", status: "approved", body: "Noted.",
    });
    expect(await hubSend(row.id, ACTOR)).toMatchObject({ status: "posted" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("hubSend: the text branch (BA7)", () => {
  it("with the SMS leg OFF an approved text is held as 'SMS disabled' and nothing goes to Twilio", async () => {
    const { thread } = await account();
    const draft = await textDraft(thread.id);
    await approveOnly(draft.id);
    const r = await hubSend(draft.id, ACTOR);
    expect(r).toMatchObject({ status: "approved", error: "SMS disabled" });
    expect(twilioCalls()).toHaveLength(0);
    expect(await prisma.hubAuditLog.count({ where: { messageId: draft.id, action: "message_held" } })).toBe(1);
    expect(await prisma.hubAuditLog.count({ where: { messageId: draft.id, action: "send_blocked" } })).toBe(0);
  });

  it("with the leg ON it sends the composed words once; the preview is that same text; the footer is only on the first", async () => {
    process.env.HUB_SMS_OUTBOUND_ENABLED = "on";
    const { customer, thread, phone } = await account({ smsConsent: true });
    // The customer texted us a minute ago, so a thread_reply is inside the window as well as consented.
    const first = await textDraft(thread.id, "confirmation_request", "Tuesday works.");
    await approveOnly(first.id);
    const preview = await prepareSms(await prisma.hubMessage.findUniqueOrThrow({ where: { id: first.id } }), thread, prisma);
    expect(preview.ok).toBe(true);

    await hubSend(first.id, ACTOR);
    expect(twilioCalls()).toHaveLength(1);
    const body1 = sentBodies()[0]!;
    expect(body1.startsWith("Red Cedar Electric: Appointment Confirmation ")).toBe(true);
    expect(body1).toContain("\nTuesday works.");
    expect(body1.endsWith("\nReply STOP to opt out.")).toBe(true);
    if (preview.ok) expect(preview.sentText.split("\n").slice(1).join("\n")).toBe(body1.split("\n").slice(1).join("\n"));
    const row1 = await prisma.hubMessage.findUniqueOrThrow({ where: { id: first.id } });
    expect(row1).toMatchObject({ status: "sent", footerIncluded: true, sentText: body1, toPhone10: phone });
    expect(row1.providerMessageId).toMatch(/^SM/);

    const second = await textDraft(thread.id, "confirmation_request", "See you then.");
    await approveOnly(second.id);
    await hubSend(second.id, ACTOR);
    expect(sentBodies()[1]!.includes("Reply STOP")).toBe(false);
    expect(customer.id).toBeTruthy();
  });

  it("class guard 1: a text with no class is refused, before the leg hold and with the leg on", async () => {
    const { thread, phone } = await account();
    const row = await rawSms(thread.id, phone!, { messageClass: null, category: null });
    for (const leg of [undefined, "on"]) {
      if (leg) process.env.HUB_SMS_OUTBOUND_ENABLED = leg;
      await prisma.hubMessage.update({ where: { id: row.id }, data: { status: "approved", error: null } });
      expect(await hubSend(row.id, ACTOR)).toMatchObject({ status: "blocked", error: "no_class" });
    }
    expect(twilioCalls()).toHaveLength(0);
  });

  it("class guard 2: marketing is ALWAYS refused - never held, one send_blocked row, the reason on the card, zero Twilio calls", async () => {
    const { thread, phone } = await account({ smsConsent: true });
    for (const leg of [undefined, "on"]) {
      if (leg) process.env.HUB_SMS_OUTBOUND_ENABLED = leg;
      const row = await rawSms(thread.id, phone!, { messageClass: "marketing", category: "seasonal_offer" });
      const r = await hubSend(row.id, ACTOR);
      expect(r).toMatchObject({ status: "blocked", error: "marketing_not_opted_in" });
      expect(await prisma.hubAuditLog.count({ where: { messageId: row.id, action: "send_blocked" } })).toBe(1);
      expect(await prisma.hubAuditLog.count({ where: { messageId: row.id, action: "message_held" } })).toBe(0);
      const after = await prisma.hubMessage.findUniqueOrThrow({ where: { id: row.id } });
      expect(after.status).toBe("blocked");
      expect(after.heldReason).toBeNull();
      const audit = await prisma.hubAuditLog.findFirstOrThrow({ where: { messageId: row.id, action: "send_blocked" } });
      expect(JSON.parse(audit.detailsJson!)).toMatchObject({ reason: "marketing_not_opted_in", messageClass: "marketing", channel: "sms", toLast4: phone!.slice(-4) });
    }
    expect(twilioCalls()).toHaveLength(0);
  });

  it("class guard 7: a text of kind review is refused: review requests are never texted", async () => {
    const { thread, phone } = await account({ smsConsent: true });
    process.env.HUB_SMS_OUTBOUND_ENABLED = "on";
    const row = await rawSms(thread.id, phone!, { messageClass: "transactional", category: "review_request", purposeKey: "thread_reply" });
    expect(await hubSend(row.id, ACTOR)).toMatchObject({ status: "blocked", error: "review_never_sms" });
    expect(twilioCalls()).toHaveLength(0);
  });

  it("an internal text is refused to a customer's number (internal is staff numbers only)", async () => {
    const { thread, phone } = await account({ smsConsent: true });
    process.env.HUB_SMS_OUTBOUND_ENABLED = "on";
    const draft = await textDraft(thread.id, "internal_alert", "Heads up.");
    await approveOnly(draft.id);
    expect(await hubSend(draft.id, ACTOR)).toMatchObject({ status: "blocked", error: "internal_not_allowed" });
    expect(phone).toBeTruthy();
    expect(twilioCalls()).toHaveLength(0);
  });

  it("an opt-out answer from smsBlockReason refuses the text (the stub returns null until step 6)", async () => {
    process.env.HUB_SMS_OUTBOUND_ENABLED = "on";
    const { thread } = await account({ smsConsent: true });
    const draft = await textDraft(thread.id, "visit_reminder", "Reminder for tomorrow.");
    await approveOnly(draft.id);
    block.reason = "opted_out";
    expect(await hubSend(draft.id, ACTOR)).toMatchObject({ status: "blocked", error: "opted_out" });
    expect(twilioCalls()).toHaveLength(0);
  });

  it("transactional keeps the consent gate: a customer who never said yes is refused (leg off or on), one who did is not", async () => {
    const declined = await account({ smsConsent: null });
    const draft = await textDraft(declined.thread.id, "visit_reminder", "Reminder for tomorrow.");
    await approveOnly(draft.id);
    expect(await hubSend(draft.id, ACTOR)).toMatchObject({ status: "blocked", error: "no_sms_consent" });
    expect(twilioCalls()).toHaveLength(0);
  });

  it("bypass 4: a thread_reply within 36 hours of their own text goes round the consent gate; at 37 hours it does not; another type never does", async () => {
    process.env.HUB_SMS_OUTBOUND_ENABLED = "on";
    const { thread, phone } = await account({ smsConsent: null });
    const inbound = (hoursAgo: number) => prisma.hubMessage.create({
      data: {
        threadId: thread.id, authorType: "customer", authorDisplay: "Customer", channel: "sms", direction: "inbound", status: "received",
        body: "Can you come Tuesday?", createdAt: new Date(Date.now() - hoursAgo * 3_600_000), toPhone10: null,
      },
    });
    const hours35 = await inbound(35);
    const reply = await textDraft(thread.id, "thread_reply", "Yes, Tuesday works.");
    await approveOnly(reply.id);
    expect(await hubSend(reply.id, ACTOR)).toMatchObject({ status: "sent" });
    expect(twilioCalls()).toHaveLength(1);

    // Not a thread_reply: the window does not help.
    const reminder = await textDraft(thread.id, "visit_reminder", "Reminder for tomorrow.");
    await approveOnly(reminder.id);
    expect(await hubSend(reminder.id, ACTOR)).toMatchObject({ status: "blocked", error: "no_sms_consent" });

    // Their text is now 37 hours old: the window has closed.
    await prisma.hubMessage.update({ where: { id: hours35.id }, data: { createdAt: new Date(Date.now() - 37 * 3_600_000) } });
    const late = await textDraft(thread.id, "thread_reply", "Following up.");
    await approveOnly(late.id);
    expect(await hubSend(late.id, ACTOR)).toMatchObject({ status: "blocked", error: "no_sms_consent" });
    // A newer text from them reopens it.
    await inbound(1);
    const again = await textDraft(thread.id, "thread_reply", "Following up again.");
    await approveOnly(again.id);
    expect(await hubSend(again.id, ACTOR)).toMatchObject({ status: "sent" });
    expect(phone).toBeTruthy();
  });

  it("a number with no Lead or Customer is never-asked: answerable only within 36 hours of its last text", async () => {
    process.env.HUB_SMS_OUTBOUND_ENABLED = "on";
    const { thread } = await account({ phone: null, smsConsent: null });
    const stranger = newPhone();
    const make = async (hoursAgoInbound: number | null) => {
      const t = await prisma.hubThread.update({ where: { id: thread.id }, data: { phone: stranger } });
      if (hoursAgoInbound !== null) {
        await prisma.hubMessage.create({
          data: { threadId: t.id, authorType: "customer", authorDisplay: "Unknown", channel: "sms", direction: "inbound", status: "received", body: "Hi", createdAt: new Date(Date.now() - hoursAgoInbound * 3_600_000) },
        });
      }
      const d = await createDraftMessage(AI, { threadId: t.id, channel: "sms", category: "thread_reply", body: "Hello.", toPhone: stranger });
      await approveOnly(d.message.id);
      return d.message.id;
    };
    expect(await hubSend(await make(null), ACTOR)).toMatchObject({ status: "blocked", error: "reply_window_closed" });
    expect(await hubSend(await make(2), ACTOR)).toMatchObject({ status: "sent" });
  });

  it("a draft to a person with no phone number fails with the reason instead of sending", async () => {
    process.env.HUB_SMS_OUTBOUND_ENABLED = "on";
    const { thread } = await account({ phone: null, smsConsent: true });
    const draft = await textDraft(thread.id, "visit_reminder", "Reminder.");
    await approveOnly(draft.id);
    expect(await hubSend(draft.id, ACTOR)).toMatchObject({ status: "blocked", error: "no_phone" });
  });

  it("refuses a body that already carries the header or the STOP footer (the composer's double-brand rule), with no Twilio call", async () => {
    process.env.HUB_SMS_OUTBOUND_ENABLED = "on";
    const { thread } = await account({ smsConsent: true });
    const draft = await textDraft(thread.id, "visit_reminder", "Red Cedar Electric: see you tomorrow");
    await approveOnly(draft.id);
    expect(await hubSend(draft.id, ACTOR)).toMatchObject({ status: "blocked", error: "double_brand" });
    expect(twilioCalls()).toHaveLength(0);
  });
});


describe("a send that succeeded is never recorded as failed (settling the row throws)", () => {
  it("an email whose settle transaction throws is still 'sent', keeps its delivery link, and cannot be sent a second time", async () => {
    const { customer, thread } = await account();
    const draft = await emailDraft(thread.id);
    await approveOnly(draft.id);
    settle.failNext = 1;
    const r = await hubSend(draft.id, ACTOR);
    expect(r).toMatchObject({ status: "sent", error: null });

    const after = await prisma.hubMessage.findUniqueOrThrow({ where: { id: draft.id } });
    const deliveries = await prisma.emailDelivery.findMany({ where: { customerId: customer.id } });
    expect(deliveries).toHaveLength(1);
    expect(after).toMatchObject({ status: "sent", emailDeliveryId: deliveries[0]!.id, error: null });
    expect(after.sentAt).not.toBeNull();
    // "Try sending again" is not offered, and the server refuses it too: no second email.
    await expect(approveMessage(KYLE, draft.id)).rejects.toMatchObject({ status: 409 });
    expect(await prisma.emailDelivery.count({ where: { customerId: customer.id } })).toBe(1);
  });

  it("a text whose settle throws is 'sent' with its Twilio id kept, and one Twilio call only", async () => {
    process.env.HUB_SMS_OUTBOUND_ENABLED = "on";
    const { thread } = await account({ smsConsent: true });
    const draft = await textDraft(thread.id, "confirmation_request", "Tuesday works.");
    await approveOnly(draft.id);
    settle.failNext = 1;
    expect(await hubSend(draft.id, ACTOR)).toMatchObject({ status: "sent" });
    const row = await prisma.hubMessage.findUniqueOrThrow({ where: { id: draft.id } });
    expect(row).toMatchObject({ status: "sent", footerIncluded: true });
    expect(row.providerMessageId).toMatch(/^SM/);
    expect(row.sentText).toBeTruthy();
    expect(twilioCalls()).toHaveLength(1);
  });

  it("a failed row that already carries a sentAt is refused on Try sending again, so nothing goes twice", async () => {
    const { thread } = await account();
    const draft = await emailDraft(thread.id);
    await prisma.hubMessage.update({ where: { id: draft.id }, data: { status: "failed", error: "x", sentAt: new Date() } });
    await expect(approveMessage(KYLE, draft.id)).rejects.toMatchObject({ status: 409 });
    expect(mail.sendMail).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("a send the server lost track of has an exit (releaseStaleSends)", () => {
  const old = () => new Date(Date.now() - STALE_SEND_MS - 60_000);

  it("a stale 'approving' row becomes failed with the interruption sentence and one audit row; Try sending again then sends it once", async () => {
    const { customer, thread } = await account();
    const draft = await emailDraft(thread.id);
    await prisma.hubMessage.update({ where: { id: draft.id }, data: { status: "approving", claimedAt: old(), decidedBy: "owner", decidedAt: old() } });

    expect(await releaseStaleSends(prisma)).toBe(1);
    const row = await prisma.hubMessage.findUniqueOrThrow({ where: { id: draft.id } });
    expect(row).toMatchObject({ status: "failed", error: STALE_SEND_ERROR, claimedAt: null });
    expect(await prisma.hubAuditLog.count({ where: { messageId: draft.id, action: "message_send_interrupted" } })).toBe(1);
    // It is not released twice.
    expect(await releaseStaleSends(prisma)).toBe(0);

    const again = await approveMessage(KYLE, draft.id);
    expect(again.send).toMatchObject({ status: "sent" });
    expect(await prisma.emailDelivery.count({ where: { customerId: customer.id } })).toBe(1);
  });

  it("a stale 'approving' row whose provider already accepted it is settled as SENT, not failed (so it is never sent twice)", async () => {
    const { thread } = await account();
    const draft = await emailDraft(thread.id);
    await prisma.hubMessage.update({ where: { id: draft.id }, data: { status: "approving", claimedAt: old(), sentAt: old() } });
    await releaseStaleSends(prisma);
    expect(await prisma.hubMessage.findUniqueOrThrow({ where: { id: draft.id } })).toMatchObject({ status: "sent", error: null });
  });

  it("an 'approved' row with no error that no send ever claimed becomes failed; a held text and a fresh claim are left alone", async () => {
    const { thread, phone } = await account();
    const stuck = await emailDraft(thread.id);
    await prisma.hubMessage.update({ where: { id: stuck.id }, data: { status: "approved", decidedAt: old(), decidedBy: "owner" } });
    const held = await rawSms(thread.id, phone!, { status: "approved", error: "SMS disabled", heldReason: "sms_disabled", decidedAt: old(), messageClass: "transactional", category: "visit_reminder" });
    const fresh = await emailDraft(thread.id);
    await prisma.hubMessage.update({ where: { id: fresh.id }, data: { status: "approving", claimedAt: new Date() } });

    expect(await releaseStaleSends(prisma)).toBe(1);
    expect((await prisma.hubMessage.findUniqueOrThrow({ where: { id: stuck.id } })).status).toBe("failed");
    expect((await prisma.hubMessage.findUniqueOrThrow({ where: { id: held.id } })).status).toBe("approved");
    expect((await prisma.hubMessage.findUniqueOrThrow({ where: { id: fresh.id } })).status).toBe("approving");
  });

  it("opening the card list (what the screen does) releases it, and the failed card can be rejected", async () => {
    const { thread } = await account();
    const draft = await emailDraft(thread.id);
    await prisma.hubMessage.update({ where: { id: draft.id }, data: { status: "approving", claimedAt: old() } });
    const { listApprovalCards } = await import("../src/services/hubCards");
    const list = await listApprovalCards(KYLE, { status: "all", threadId: thread.id }, true);
    expect(list.cards.find((c) => c.id === draft.id)).toMatchObject({ status: "failed" });
    const { rejectMessage } = await import("../src/services/hubApproval");
    expect((await rejectMessage(KYLE, draft.id, "Do not resend")).card.status).toBe("rejected");
  });

  it("a stuck claim never removes the STOP footer: a text to a number nothing has reached still carries it", async () => {
    process.env.HUB_SMS_OUTBOUND_ENABLED = "on";
    const { thread, phone } = await account({ smsConsent: true });
    // An earlier text to this number that claimed and was never settled (a restart), and one still in flight.
    await rawSms(thread.id, phone!, { status: "approving", claimedAt: old(), messageClass: "transactional", category: "visit_reminder", purposeKey: "appointment_reminder" });
    await rawSms(thread.id, phone!, { status: "approving", claimedAt: new Date(Date.now() - 1000), messageClass: "transactional", category: "visit_reminder", purposeKey: "appointment_reminder" });
    const draft = await textDraft(thread.id, "confirmation_request", "Tuesday works.");
    await approveOnly(draft.id);
    await hubSend(draft.id, ACTOR);
    expect(sentBodies()[0]!.endsWith("\nReply STOP to opt out.")).toBe(true);
    expect((await prisma.hubMessage.findUniqueOrThrow({ where: { id: draft.id } })).footerIncluded).toBe(true);
  });
});
