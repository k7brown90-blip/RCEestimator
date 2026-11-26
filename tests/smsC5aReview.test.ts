/**
 * Work order agent-team, U9 (batch C5a), the fixes that came back from review. Real sendSms, fetch mocked. Pinned:
 *   * the first-text footer rule counts only texts that REACHED a customer: a rehearsal row (sent, no provider id)
 *     and an internal text to the same number do not hide the STOP footer from the real first text;
 *   * the opt-in confirmation carries "Reply STOP to opt out." every time, even to a number already texted;
 *   * an automatic text in the timeline and the thread view names who it went to, masked (never the full number),
 *     with its class, so a staff alert never reads as a text the customer got;
 *   * a text the CRM sent or refused by itself is never an approval card (list and single read);
 *   * a text to Kyle that names a technician and a visit is filed in the visit's CUSTOMER thread, never the crew's.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
vi.mock("googleapis");

const fetchMock = vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>();
vi.stubGlobal("fetch", fetchMock);

import { prisma } from "../src/lib/prisma";
import { KYLE_PHONE, sendSms } from "../src/services/twilio";
import { buildTimeline } from "../src/services/hubTimeline";
import { threadDetail } from "../src/services/hubInbox";
import { approvalCardFor, listApprovalCards } from "../src/services/hubCards";
import { approveMessage } from "../src/services/hubApproval";
import { waitingDraft } from "./helpers/waitingDraft"; // Kyle 2026-11-24: an agent message now SENDS when posted; these tests need a card already waiting (a pre-deploy one)
import { ensureThreadFor, isFirstTextTo, type HubReader } from "../src/services/hub";
import { SMS_FOOTER } from "../shared/sms/compose";

const TAG = "SmsC5aRev";
const OWNER: HubReader = { key: "owner", kind: "owner", display: "Kyle", technicianId: null, threadKinds: [], agentRole: null, agentKeyId: null, isKyle: true };
const AI: HubReader = { key: "ai-admin", kind: "ai-admin", display: "RCE Admin", technicianId: null, threadKinds: [], agentRole: null, agentKeyId: null, isKyle: false };
let phoneSeq = 1000 + Math.floor(Math.random() * 7000);
const newPhone10 = () => `615559${phoneSeq++}`;
const techIds: string[] = [];

const twilioCalls = () => fetchMock.mock.calls.filter(([u]) => String(u).includes("api.twilio.com"));
const lastBody = () => new URLSearchParams(String(twilioCalls().at(-1)?.[1]?.body)).get("Body") ?? "";

function stubNetwork() {
  let n = 0;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () =>
    new Response(JSON.stringify({ sid: `SM${randomUUID().replace(/-/g, "")}${n++}`, status: "queued" }), { status: 201, headers: { "Content-Type": "application/json" } }));
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
async function account(over: { isTestAccount?: boolean; phone?: string } = {}) {
  const phone10 = over.phone ?? newPhone10();
  const customer = await prisma.customer.create({
    data: {
      name: `${TAG} Jane ${seq++}`, phone: phone10, smsConsent: true, isTestAccount: over.isTestAccount ?? false,
      properties: { create: { name: "Home", addressLine1: "88 Cedar Hollow Court", city: "Franklin", state: "TN", postalCode: "37064" } },
    },
    include: { properties: true },
  });
  const visit = await prisma.visit.create({
    data: { customerId: customer.id, propertyId: customer.properties[0]!.id, mode: "service_call", jobType: "Panel upgrade", scheduledStart: new Date("2026-11-23T14:00:00Z"), scheduledEnd: new Date("2026-11-23T16:00:00Z") },
  });
  return { customer, visit, phone10, to: `+1${phone10}` };
}
const TR = (category: string) => ({ messageClass: "transactional" as const, category });
const sms = (threadWhere: object) => prisma.hubMessage.findMany({ where: { channel: "sms", thread: threadWhere }, orderBy: { createdAt: "asc" } });
const newTech = async () => {
  const tech = await prisma.technician.create({ data: { name: `${TAG} Tech`, phone: newPhone10(), isActive: true, accessToken: `c5arev-${randomUUID()}` } });
  techIds.push(tech.id);
  return tech;
};

describe("the first-text footer rule counts only texts that reached a customer", () => {
  it("a rehearsal on a test account to a REAL customer's number does not hide that customer's STOP footer from their first real text", async () => {
    const real = await account();
    const test = await account({ isTestAccount: true });
    const thread = await ensureThreadFor({ customerId: test.customer.id });
    // An agent drafts a text in the TEST account's thread, addressed to the real customer's number.
    const { message } = await waitingDraft(AI, { threadId: thread.id, channel: "sms", category: "confirmation_request", body: "Tuesday works.", toPhone: real.to });
    const done = await approveMessage(OWNER, message.id);
    expect(done.send).toMatchObject({ status: "sent" });
    expect(twilioCalls()).toHaveLength(0); // a rehearsal: nothing texted
    const rehearsed = await prisma.hubMessage.findUniqueOrThrow({ where: { id: message.id } });
    expect(rehearsed).toMatchObject({ status: "sent", providerMessageId: null, toPhone10: real.phone10 });

    expect(await isFirstTextTo(prisma, real.phone10, { id: null })).toBe(true);
    const sent = await sendSms(real.to, "Your visit is booked.", { ...TR("job_scheduled"), hub: { customerId: real.customer.id, visitId: real.visit.id } });
    expect(sent?.footerIncluded).toBe(true);
    expect(lastBody().endsWith(SMS_FOOTER)).toBe(true);
  });

  it("an internal text to a number that is ALSO a customer's does not hide that customer's footer, and a real text still does", async () => {
    const phone = newPhone10();
    const tech = await prisma.technician.create({ data: { name: `${TAG} Tech`, phone, isActive: true, accessToken: `c5arev-${randomUUID()}` } });
    techIds.push(tech.id);
    const a = await account({ phone });
    const internal = await sendSms(`+1${phone}`, "NEW JOB", { messageClass: "internal", category: "tech_notice", hub: { customerId: a.customer.id } });
    expect(internal).not.toBeNull();
    expect(await prisma.hubMessage.count({ where: { toPhone10: phone, messageClass: "internal", status: "sent" } })).toBe(1);

    const sent = await sendSms(a.to, "Your visit is booked.", { ...TR("job_scheduled"), hub: { customerId: a.customer.id, visitId: a.visit.id } });
    expect(sent?.footerIncluded).toBe(true);
    // The footer rule still stops once a REAL text has reached them.
    const second = await sendSms(a.to, "See you then.", { ...TR("visit_reminder"), hub: { customerId: a.customer.id, visitId: a.visit.id } });
    expect(second?.footerIncluded).toBe(false);
  });
});

describe("the opt-in confirmation always carries the opt-out wording", () => {
  it("to a number that has already been texted, it still ends with 'Reply STOP to opt out.'", async () => {
    const a = await account();
    const first = await sendSms(a.to, "Your visit is booked.", { ...TR("job_scheduled"), hub: { customerId: a.customer.id, visitId: a.visit.id } });
    expect(first?.footerIncluded).toBe(true);
    for (let i = 0; i < 2; i++) {
      const optIn = await sendSms(a.to, "You are confirmed to receive service and appointment texts from us.", { ...TR("opt_in_confirmation"), hub: { customerId: a.customer.id } });
      expect(optIn).toMatchObject({ footerIncluded: true });
      expect(lastBody().endsWith(`\n${SMS_FOOTER}`)).toBe(true);
      expect(lastBody().split("\n")[0]).toMatch(/^Red Cedar Electric: Text Alerts Confirmed /);
    }
    // Other transactional types are unchanged: the footer is only on the first text.
    const reminder = await sendSms(a.to, "See you then.", { ...TR("visit_reminder"), hub: { customerId: a.customer.id, visitId: a.visit.id } });
    expect(reminder?.footerIncluded).toBe(false);
  });
});

describe("an automatic text in the conversation says who it went to", () => {
  it("the timeline and the thread view carry the masked recipient and the class, never the full number", async () => {
    const a = await account();
    await sendSms(a.to, "Your visit is booked.", { ...TR("job_scheduled"), hub: { customerId: a.customer.id, visitId: a.visit.id } });
    process.env.TWILIO_SENDS_OPERATOR_NOTIFICATIONS = "on";
    try {
      await sendSms(KYLE_PHONE, `JOB SCHEDULED - ${a.customer.name}`, { messageClass: "internal", category: "internal_alert", hub: { customerId: a.customer.id, visitId: a.visit.id } });
    } finally {
      delete process.env.TWILIO_SENDS_OPERATOR_NOTIFICATIONS;
    }
    const tl = await buildTimeline(OWNER, { customerId: a.customer.id });
    const messages = tl.entries
      .filter((e) => e.type === "message")
      .map((e) => (e as unknown as { message: { toMasked: string | null; messageClass: string | null } }).message);
    expect(messages).toHaveLength(2);
    const customerText = messages.find((m) => m.messageClass === "transactional")!;
    const staffText = messages.find((m) => m.messageClass === "internal")!;
    expect(customerText.toMasked).toBe(`(${a.phone10.slice(0, 3)}) ***-${a.phone10.slice(-4)}`);
    expect(staffText.toMasked).toBe("Kyle");
    expect(JSON.stringify(tl)).not.toContain(a.phone10);

    const thread = await ensureThreadFor({ customerId: a.customer.id });
    const detail = await threadDetail(OWNER, thread.id);
    const viaThread = detail.messages.filter((m) => m.channel === "sms");
    expect(viaThread.map((m) => m.toMasked).sort()).toEqual([customerText.toMasked, "Kyle"].sort());
    expect(viaThread.map((m) => m.messageClass).sort()).toEqual(["internal", "transactional"]);
    expect(JSON.stringify(detail)).not.toContain(a.phone10);
  });
});

describe("a system text is never an approval card", () => {
  it("a blocked system line is absent from the card list (pending and all) and its single card read is 404", async () => {
    const a = await account();
    await prisma.customer.update({ where: { id: a.customer.id }, data: { smsConsent: false } });
    const refused = await sendSms(a.to, "Your visit is booked.", { ...TR("job_scheduled"), hub: { customerId: a.customer.id, visitId: a.visit.id } });
    expect(refused).toBeNull();
    const blocked = await prisma.hubMessage.findFirstOrThrow({ where: { status: "blocked", authorType: "system", thread: { customerId: a.customer.id } } });
    const thread = await ensureThreadFor({ customerId: a.customer.id });
    for (const status of ["pending", "all"] as const) {
      const list = await listApprovalCards(OWNER, { status, threadId: thread.id }, true);
      expect(list.cards.map((c) => c.id)).not.toContain(blocked.id);
    }
    await expect(approvalCardFor(OWNER, blocked.id)).rejects.toMatchObject({ status: 404 });
    // The line itself is still in the conversation, with its reason.
    const tl = await buildTimeline(OWNER, { customerId: a.customer.id });
    expect(JSON.stringify(tl)).toContain("no_sms_consent");
  });
});

describe("a text to Kyle is never filed in the crew's job thread", () => {
  it("a Kyle-bound text naming a technician and a visit lands in the visit's customer thread", async () => {
    process.env.TWILIO_SENDS_OPERATOR_NOTIFICATIONS = "on";
    const a = await account();
    const tech = await newTech();
    try {
      await sendSms(KYLE_PHONE, "TECH NOTE - Mike on Jane: panel is hot", { messageClass: "internal", category: "internal_alert", hub: { technicianId: tech.id, visitId: a.visit.id } });
    } finally {
      delete process.env.TWILIO_SENDS_OPERATOR_NOTIFICATIONS;
    }
    expect(await sms({ kind: "job", visitId: a.visit.id })).toHaveLength(0);
    const rows = await sms({ customerId: a.customer.id });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ visitId: a.visit.id, messageClass: "internal", toPhone10: "9706661626" });
  });

  it("the same context sent to the TECHNICIAN still goes to the job thread (the crew's own notice)", async () => {
    const a = await account();
    const tech = await newTech();
    await sendSms(tech.phone!, "NEW JOB", { messageClass: "internal", category: "tech_notice", hub: { technicianId: tech.id, visitId: a.visit.id } });
    expect(await sms({ kind: "job", visitId: a.visit.id })).toHaveLength(1);
    expect(await sms({ customerId: a.customer.id })).toHaveLength(0);
  });
});
