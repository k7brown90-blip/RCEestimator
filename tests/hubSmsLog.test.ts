/**
 * Work order agent-team, U9 (batch C5a): the CRM's own texts written into the Messages hub as system lines.
 *
 * Real sendSms with `fetch` mocked. Pinned here:
 *   * a text that actually leaves is ONE outbound sms line by System, status sent, on the right thread
 *     (customer -> the customer's thread tagged with the visit; technician + visit -> the job thread; a text
 *     to Kyle that names a customer -> THAT customer's thread, never a Team or job thread; no context -> not
 *     filed), with the provider id, the composed words and the number kept only as its last ten digits;
 *   * the write is awaited and announced AFTER it commits (the one fan-out call site);
 *   * a refusal writes a 'blocked' line and exactly ONE send_blocked audit row; a leg switched off writes
 *     nothing; an HTTP error from Twilio writes nothing as sent;
 *   * a text that hubSend owns (opts.hub.messageId) is never logged twice;
 *   * an Admin hub read of a logged Kyle alert shows no customer phone or street (the every-key profile);
 *   * `// @ts-expect-error`: a call without a class and a send type does not type-check (tsc covers tests/**).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
vi.mock("googleapis");

const fetchMock = vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>();
vi.stubGlobal("fetch", fetchMock);

const block = vi.hoisted(() => ({ reason: null as string | null }));
vi.mock("../src/services/smsGuards", async (orig) => {
  const real = await orig<typeof import("../src/services/smsGuards")>();
  return { ...real, smsBlockReason: vi.fn(async () => block.reason) };
});

import { prisma } from "../src/lib/prisma";
import { KYLE_PHONE, sendSms } from "../src/services/twilio";
import { sendCustomerSms, sendKyleSms } from "../src/services/notifications";
import { subscribeHub, type HubBusEvent } from "../src/services/hubBus";
import { buildTimeline } from "../src/services/hubTimeline";
import { ensureThreadFor, type HubReader } from "../src/services/hub";
import { hubSend, prepareSms } from "../src/services/hubSend";
import { waitingDraft } from "./helpers/waitingDraft"; // Kyle 2026-11-24: an agent message now SENDS when posted; these tests need a card already waiting (a pre-deploy one)
import { projectMessageRead } from "../src/agentApi/profiles";

const TAG = "SmsLog";
const OWNER: HubReader = { key: "owner", kind: "owner", display: "Kyle", technicianId: null, threadKinds: [], agentRole: null, agentKeyId: null, isKyle: true };
let phoneSeq = 1000 + Math.floor(Math.random() * 7000);
const newPhone10 = () => `615557${phoneSeq++}`;

const twilioCalls = () => fetchMock.mock.calls.filter(([u]) => String(u).includes("api.twilio.com"));
const techIds: string[] = [];

function stubNetwork(status = 201) {
  let n = 0;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () =>
    status === 201
      ? new Response(JSON.stringify({ sid: `SM${randomUUID().replace(/-/g, "")}${n++}`, status: "queued" }), { status: 201, headers: { "Content-Type": "application/json" } })
      : new Response("boom", { status }));
}

async function wipe() {
  const customers = await prisma.customer.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
  const ids = customers.map((c) => c.id);
  await prisma.hubThread.deleteMany({ where: { OR: [{ title: { startsWith: TAG } }, { customerId: { in: ids } }, { visit: { customerId: { in: ids } } }] } });
  if (ids.length > 0) {
    await prisma.visit.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.property.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.customer.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.technician.deleteMany({ where: { id: { in: techIds } } });
  techIds.length = 0;
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
  block.reason = null;
  delete process.env.TWILIO_SENDS_CUSTOMER_LIFECYCLE;
  delete process.env.TWILIO_SENDS_OPERATOR_NOTIFICATIONS;
  delete process.env.TWILIO_SENDS;
});
afterEach(wipe);

let seq = 0;
async function account(over: { smsConsent?: boolean | null } = {}) {
  const phone10 = newPhone10();
  const customer = await prisma.customer.create({
    data: {
      name: `${TAG} Jane ${seq++}`, phone: phone10, smsConsent: over.smsConsent === undefined ? true : over.smsConsent,
      properties: { create: { name: "Home", addressLine1: "88 Cedar Hollow Court", city: "Franklin", state: "TN", postalCode: "37064" } },
    },
    include: { properties: true },
  });
  const visit = await prisma.visit.create({
    data: { customerId: customer.id, propertyId: customer.properties[0]!.id, mode: "service_call", jobType: "Panel upgrade", scheduledStart: new Date("2026-11-23T14:00:00Z"), scheduledEnd: new Date("2026-11-23T16:00:00Z") },
  });
  return { customer, visit, phone10, to: `+1${phone10}` };
}
const sms = (threadWhere: object) => prisma.hubMessage.findMany({ where: { channel: "sms", thread: threadWhere }, orderBy: { createdAt: "asc" } });
const TR = (category: string) => ({ messageClass: "transactional" as const, category });

describe("a text that went out is written into the conversation", () => {
  it("a customer text is ONE system line on the customer's thread, tagged with the visit, with the words, the id and only the last ten digits of the number", async () => {
    const a = await account();
    const sent = await sendSms(a.to, "Your panel visit is booked.", {
      ...TR("job_scheduled"), when: { start: a.visit.scheduledStart!, end: null }, hub: { customerId: a.customer.id, visitId: a.visit.id },
    });
    expect(sent).not.toBeNull();
    const rows = await sms({ customerId: a.customer.id });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      authorType: "system", direction: "outbound", status: "sent", visitId: a.visit.id, body: "Your panel visit is booked.",
      sentText: sent!.sentText, providerMessageId: sent!.sid, footerIncluded: true, toPhone10: a.phone10,
      messageClass: "transactional", category: "job_scheduled", purposeKey: "job_scheduled",
      eventStart: a.visit.scheduledStart, toAddress: null,
    });
    // The view of the conversation never carries the full number.
    const timeline = await buildTimeline(OWNER, { customerId: a.customer.id });
    expect(JSON.stringify(timeline)).not.toContain(a.phone10);
    expect(JSON.stringify(timeline)).toContain("Your panel visit is booked.");
  });

  it("a technician's text with a visit is filed on the JOB thread, not the customer's", async () => {
    const a = await account();
    const tech = await prisma.technician.create({ data: { name: `${TAG} Tech`, phone: newPhone10(), isActive: true, accessToken: `smslog-${randomUUID()}` } });
    techIds.push(tech.id);
    await sendSms(tech.phone!, "NEW JOB", { messageClass: "internal", category: "tech_notice", hub: { technicianId: tech.id, visitId: a.visit.id } });
    expect(await sms({ visitId: a.visit.id, kind: "job" })).toHaveLength(1);
    expect(await sms({ customerId: a.customer.id })).toHaveLength(0);
  });

  it("a text TO KYLE that names a customer is filed on THAT customer's thread (it carries the phone and address), never the job or a Team thread", async () => {
    process.env.TWILIO_SENDS_OPERATOR_NOTIFICATIONS = "on";
    const a = await account();
    await sendKyleSms(`CONFIRMED: ${a.customer.name} — Monday — 88 Cedar Hollow Court — ${a.phone10}`, {
      messageClass: "internal", category: "internal_alert", hub: { customerId: a.customer.id, visitId: a.visit.id },
    });
    const rows = await sms({ customerId: a.customer.id });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ messageClass: "internal", footerIncluded: false, toPhone10: "9706661626" });
    expect(await sms({ kind: "job", visitId: a.visit.id })).toHaveLength(0);
    expect(await sms({ kind: "team" })).toEqual([]);
  });

  it("no context: the text goes and nothing is filed", async () => {
    const before = await prisma.hubMessage.count({ where: { channel: "sms" } });
    expect(await sendSms(KYLE_PHONE, "cron digest", { messageClass: "internal", category: "internal_alert" })).not.toBeNull();
    expect(await prisma.hubMessage.count({ where: { channel: "sms" } })).toBe(before);
  });

  it("a lead's text is filed on the lead's thread", async () => {
    const lead = await prisma.lead.create({ data: { name: `${TAG} Lead`, phone: newPhone10(), smsConsent: true } });
    try {
      await sendSms(`+1${lead.phone}`, "You are confirmed.", { ...TR("opt_in_confirmation"), hub: { leadId: lead.id } });
      expect(await sms({ leadId: lead.id })).toHaveLength(1);
    } finally {
      await prisma.lead.delete({ where: { id: lead.id } });
    }
  });

  it("the write is announced to the open screens once, AFTER it has committed", async () => {
    const a = await account();
    const heard: Array<{ event: HubBusEvent; stored: boolean }> = [];
    const stop = subscribeHub((event) => {
      if (event.type === "message" && event.messageId) void prisma.hubMessage.count({ where: { id: event.messageId } }).then((n) => heard.push({ event, stored: n === 1 }));
    });
    try {
      await sendSms(a.to, "Heads up.", { ...TR("visit_reminder"), hub: { customerId: a.customer.id, visitId: a.visit.id } });
      await vi.waitFor(() => expect(heard).toHaveLength(1));
    } finally {
      stop();
    }
    expect(heard[0]!.stored).toBe(true);
  });

  it("a leg switched off writes NOTHING (no line, no audit), and sends nothing", async () => {
    const a = await account();
    const auditBefore = await prisma.hubAuditLog.count({ where: { action: "send_blocked" } });
    const result = await sendCustomerSms(a.to, "Hi.", { ...TR("job_scheduled"), hub: { customerId: a.customer.id, visitId: a.visit.id } });
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await sms({ customerId: a.customer.id })).toHaveLength(0);
    expect(await prisma.hubAuditLog.count({ where: { action: "send_blocked" } })).toBe(auditBefore);
  });

  it("an HTTP error from Twilio writes nothing as sent", async () => {
    stubNetwork(500);
    const a = await account();
    expect(await sendSms(a.to, "Hi.", { ...TR("visit_reminder"), hub: { customerId: a.customer.id, visitId: a.visit.id } })).toBeNull();
    expect(await sms({ customerId: a.customer.id })).toHaveLength(0);
  });
});

describe("a refused text is written down, once", () => {
  async function blockedRows(customerId: string) {
    const lines = await sms({ customerId });
    const audits = await prisma.hubAuditLog.findMany({ where: { action: "send_blocked", messageId: { in: lines.map((l) => l.id) } } });
    return { lines, audits };
  }

  // Kyle 2026-11-26: this used to use smsConsent null ("no consent"). Null is textable now; the one refusal is a STOP (smsConsent false), which keeps
  // the new code replied_stop; no_sms_consent remains only on rows written before 2026-11-26.
  it("a STOP: a 'blocked' line and ONE send_blocked audit row (reason, class, category, purpose, last four, ids), and no Twilio call", async () => {
    const a = await account({ smsConsent: false });
    const result = await sendSms(a.to, "Reminder.", { ...TR("visit_reminder"), hub: { customerId: a.customer.id, visitId: a.visit.id } });
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    const { lines, audits } = await blockedRows(a.customer.id);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ status: "blocked", error: "replied_stop", visitId: a.visit.id, sentText: null, authorType: "system" });
    expect(audits).toHaveLength(1);
    expect(JSON.parse(audits[0]!.detailsJson!)).toMatchObject({
      reason: "replied_stop", messageClass: "transactional", category: "visit_reminder", purposeKey: "appointment_reminder", channel: "sms", toLast4: a.phone10.slice(-4),
      ids: { customerId: a.customer.id, visitId: a.visit.id },
    });
    expect(audits[0]!.detailsJson).not.toContain(a.phone10);
  });

  it("an opted-out number (the one smsBlockReason answer) is refused with the reason code", async () => {
    block.reason = "opted_out";
    const a = await account();
    expect(await sendSms(a.to, "Reminder.", { ...TR("visit_reminder"), hub: { customerId: a.customer.id } })).toBeNull();
    const { lines, audits } = await blockedRows(a.customer.id);
    expect(lines.map((l) => [l.status, l.error])).toEqual([["blocked", "opted_out"]]);
    expect(audits).toHaveLength(1);
  });

  it("a body that already carries the header or the footer, an internal text to a customer, and a claimed marketing text are each refused and written down once", async () => {
    const a = await account();
    const hub = { customerId: a.customer.id, visitId: a.visit.id };
    await sendSms(a.to, "Red Cedar Electric: hi", { ...TR("visit_reminder"), hub });
    await sendSms(a.to, "Hi. Reply STOP to opt out.", { ...TR("visit_reminder"), hub });
    await sendSms(a.to, "hello", { messageClass: "internal", category: "internal_alert", hub });
    await sendSms(a.to, "Fall special.", { messageClass: "marketing", category: "thread_reply", hub });
    expect(fetchMock).not.toHaveBeenCalled();
    const { lines, audits } = await blockedRows(a.customer.id);
    expect(lines.map((l) => l.error)).toEqual(["double_brand", "double_footer", "internal_not_allowed", "class_mismatch"]);
    // (No send type is marketing yet, so a text that CLAIMS to be marketing never matches one.)
    expect(audits).toHaveLength(4);
  });

  it("with no thread to file it under, the refusal still writes its audit row (a block is never silent)", async () => {
    const before = await prisma.hubAuditLog.count({ where: { action: "send_blocked" } });
    expect(await sendSms(KYLE_PHONE, "Red Cedar Electric: nope", { ...TR("visit_reminder") })).toBeNull();
    // (the consent gate is not reached: the composer refuses the doubled brand first for a customer class)
    expect(await prisma.hubAuditLog.count({ where: { action: "send_blocked" } })).toBe(before + 1);
  });

  it("a text with no class at all is refused without throwing, and says so in the audit", async () => {
    const before = await prisma.hubAuditLog.count({ where: { action: "send_blocked" } });
    // @ts-expect-error: a text must say what it is (class and send type); tsc covers tests/**
    await expect(sendSms(KYLE_PHONE, "who am I")).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await prisma.hubAuditLog.count({ where: { action: "send_blocked" } })).toBe(before + 1);
  });
});

describe("hubSend owns its own row", () => {
  it("sendSms for a message the hub already holds composes and sends but writes no second line and no audit row", async () => {
    const a = await account();
    const thread = await ensureThreadFor({ customerId: a.customer.id });
    const mine = await prisma.hubMessage.create({
      data: {
        threadId: thread.id, authorType: "ai_agent", authorDisplay: "RCE Admin", channel: "sms", direction: "outbound", status: "approving",
        body: "Tuesday works.", category: "confirmation_request", messageClass: "transactional", purposeKey: "appointment_confirmation", toPhone10: a.phone10,
      },
    });
    const sent = await sendSms(a.to, "Tuesday works.", {
      ...TR("confirmation_request"), when: { start: a.visit.scheduledStart!, end: a.visit.scheduledEnd },
      hub: { customerId: a.customer.id, messageId: mine.id },
    });
    expect(sent!.sentText).toBe("Red Cedar Electric: Appointment Confirmation Mon 11/23, 8-10 AM\nTuesday works.\nReply STOP to opt out.");
    expect(await sms({ customerId: a.customer.id })).toHaveLength(1);

    // And a refusal inside sendSms for that row leaves the settling to hubSend: no extra line, no extra audit.
    block.reason = "opted_out";
    const auditBefore = await prisma.hubAuditLog.count({ where: { action: "send_blocked" } });
    expect(await sendSms(a.to, "again", { ...TR("confirmation_request"), hub: { customerId: a.customer.id, messageId: mine.id } })).toBeNull();
    expect(await sms({ customerId: a.customer.id })).toHaveLength(1);
    expect(await prisma.hubAuditLog.count({ where: { action: "send_blocked" } })).toBe(auditBefore);
  });
});

describe("hubSend hands the words to sendSms and lets it compose (the C3 hand-off)", () => {
  it("an approved text is sent ONCE, logged ONCE (its own row), and the 'Sends as:' preview is the very text Twilio received", async () => {
    process.env.HUB_SMS_OUTBOUND_ENABLED = "on";
    try {
      const a = await account();
      const thread = await ensureThreadFor({ customerId: a.customer.id });
      const AI: HubReader = { key: "ai-admin", kind: "ai-admin", display: "RCE Admin", technicianId: null, threadKinds: [], agentRole: null, agentKeyId: null, isKyle: false };
      const { message } = await waitingDraft(AI, { threadId: thread.id, channel: "sms", category: "confirmation_request", body: "Tuesday works." });
      await prisma.hubMessage.update({ where: { id: message.id }, data: { status: "approved", decidedBy: "owner", decidedAt: new Date(), eventStart: a.visit.scheduledStart, eventEnd: a.visit.scheduledEnd } });
      const preview = await prepareSms(await prisma.hubMessage.findUniqueOrThrow({ where: { id: message.id } }), thread, prisma);
      expect(preview.ok).toBe(true);

      const result = await hubSend(message.id, { key: "owner", display: "Kyle" });
      expect(result.status).toBe("sent");
      expect(twilioCalls()).toHaveLength(1);
      const body = new URLSearchParams(String(twilioCalls()[0]![1]?.body)).get("Body");
      expect(body).toBe("Red Cedar Electric: Appointment Confirmation Mon 11/23, 8-10 AM\nTuesday works.\nReply STOP to opt out.");
      if (preview.ok) expect(preview.sentText).toBe(body);
      const rows = await sms({ customerId: a.customer.id });
      expect(rows).toHaveLength(1); // the approved message itself: sendSms wrote no second line
      expect(rows[0]).toMatchObject({ id: message.id, status: "sent", sentText: body, footerIncluded: true });
    } finally {
      delete process.env.HUB_SMS_OUTBOUND_ENABLED;
    }
  });
});

describe("what an AI agent can read of a logged text to Kyle", () => {
  it("an Admin hub read of a logged Kyle alert shows no customer phone and no street", async () => {
    process.env.TWILIO_SENDS_OPERATOR_NOTIFICATIONS = "on";
    const a = await account();
    await sendKyleSms(`RESCHEDULE REQUEST: ${a.customer.name} — currently Monday — 88 Cedar Hollow Court, Franklin — ${a.phone10}. Call to arrange a new time.`, {
      messageClass: "internal", category: "internal_alert", hub: { customerId: a.customer.id, visitId: a.visit.id },
    });
    const row = await prisma.hubMessage.findFirstOrThrow({ where: { thread: { customerId: a.customer.id }, channel: "sms" } });
    expect(row.body).toContain("88 Cedar Hollow Court");
    // The one every-key message profile (K-U4), as the Admin key's hub read applies it, with the linked record's own contacts.
    const read = projectMessageRead(
      { id: row.id, threadId: row.threadId, authorType: row.authorType, authorDisplay: row.authorDisplay, subject: row.subject, body: row.body, createdAt: row.createdAt },
      { phones: [a.phone10], addresses: ["88 Cedar Hollow Court, Franklin, TN 37064"] },
      true,
    );
    expect(read.body).not.toContain(a.phone10);
    expect(read.body).not.toMatch(/Cedar Hollow/);
    expect(read.body).toContain("[withheld]");
  });
});
