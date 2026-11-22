/**
 * Work order agent-team, U9 (batch C5a): the header and the footer on EVERY text, at the one choke point.
 *
 * These use the REAL sendSms with `fetch` mocked (the alerting, communicationMesh and
 * manualScheduleBeatsCalendar tests mock sendSms, so they never see composed text and cannot be evidence
 * for this). What is pinned:
 *   * transactional "Red Cedar Electric: <Label> <date/window>" in America/Chicago; marketing is refused;
 *     internal is the prefix "Red Cedar Electric:" and nothing else;
 *   * "Reply STOP to opt out." on the FIRST text to a number and not on the second - two sends back to back,
 *     which is only deterministic because the conversation write is awaited (ruling E);
 *   * the double-brand and double-footer refusals apply to the customer classes and NEVER to internal (a
 *     forward that quotes "reply stop?" still goes);
 *   * "internal" goes only to Kyle, the alert number and an active technician;
 *   * a missing class or send type is refused, never thrown;
 *   * every live send site carries the class and header label the addendum's table names;
 *   * Kyle's label rename (the smsPurposeLabels owner setting) reaches the text.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
vi.mock("googleapis");
const mail = vi.hoisted(() => ({ sendMail: vi.fn<(opts: Record<string, unknown>) => Promise<unknown>>() }));
vi.mock("nodemailer", () => ({ default: { createTransport: () => ({ sendMail: mail.sendMail }) } }));

const fetchMock = vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>();
vi.stubGlobal("fetch", fetchMock);

import { prisma } from "../src/lib/prisma";
import { KYLE_PHONE, sendSms } from "../src/services/twilio";
import { sendCustomerSms } from "../src/services/notifications";
import { applyConfirmationAction, notifyTechnicianOfAssignment, sendVisitConfirmationRequest, sendVisitReminders } from "../src/services/visitConfirmations";
import { saveOwnerSetting } from "../src/services/ownerSettings";
import { SMS_PURPOSES } from "../shared/sms/purposes";
import { MESSAGE_CATEGORY_LIST } from "../shared/hub/messageCategories";

const TAG = "SmsHF";
let phoneSeq = 3000 + Math.floor(Math.random() * 5000);
const newPhone10 = () => `615556${phoneSeq++}`;
const e164 = (p10: string) => `+1${p10}`;

const twilioCalls = () => fetchMock.mock.calls.filter(([u]) => String(u).includes("api.twilio.com"));
const sentBodies = () => twilioCalls().map(([, init]) => new URLSearchParams(String(init?.body)).get("Body") ?? "");
const sentTo = () => twilioCalls().map(([, init]) => new URLSearchParams(String(init?.body)).get("To") ?? "");

const techIds: string[] = [];

function stubNetwork() {
  let n = 0;
  fetchMock.mockReset();
  mail.sendMail.mockReset();
  mail.sendMail.mockResolvedValue({});
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
  await prisma.companySetting.deleteMany({ where: { key: "smsPurposeLabels" } });
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
  process.env.TWILIO_SENDS_CUSTOMER_LIFECYCLE = "on";
  process.env.TWILIO_SENDS_OPERATOR_NOTIFICATIONS = "on";
  process.env.TWILIO_SENDS_TECHNICIAN = "on";
});
afterEach(async () => {
  delete process.env.TWILIO_SENDS_CUSTOMER_LIFECYCLE;
  delete process.env.TWILIO_SENDS_OPERATOR_NOTIFICATIONS;
  delete process.env.TWILIO_SENDS_TECHNICIAN;
  delete process.env.OPERATOR_ALERT_NUMBER;
  await wipe();
});

let seq = 0;
/** A consenting customer with one property and a visit, so a text can be filed under the account and the job. */
async function account(over: { status?: string; start?: Date; end?: Date | null } = {}) {
  const phone10 = newPhone10();
  const customer = await prisma.customer.create({
    data: {
      name: `${TAG} Jane ${seq++}`, phone: phone10, smsConsent: true,
      properties: { create: { name: "Home", addressLine1: "12 Main St", city: "Smyrna", state: "TN", postalCode: "37167" } },
    },
    include: { properties: true },
  });
  const start = over.start ?? new Date("2026-11-23T14:00:00Z"); // Mon 11/23, 8 AM Chicago
  const visit = await prisma.visit.create({
    data: {
      customerId: customer.id, propertyId: customer.properties[0]!.id, mode: "service_call", jobType: "Panel upgrade",
      status: over.status ?? "estimate", scheduledStart: start, scheduledEnd: over.end === undefined ? new Date(start.getTime() + 2 * 3600_000) : over.end,
    },
  });
  return { customer, visit, phone10, to: e164(phone10) };
}

const T = (category: string, extra: object = {}) => ({ messageClass: "transactional" as const, category, ...extra });
const lines = (text: string) => text.split("\n");

describe("the header and the footer, composed inside sendSms", () => {
  it("a transactional text is 'Red Cedar Electric: <Label> <date, window>' in America/Chicago, then the words, then the footer on the first text", async () => {
    const { to } = await account();
    const sent = await sendSms(to, "Your visit is booked.", T("confirmation_request", { when: { start: new Date("2026-11-23T14:00:00Z"), end: new Date("2026-11-23T16:00:00Z") } }));
    expect(sent).toMatchObject({ footerIncluded: true });
    expect(sent!.sentText).toBe("Red Cedar Electric: Appointment Confirmation Mon 11/23, 8-10 AM\nYour visit is booked.\nReply STOP to opt out.");
    expect(sentBodies()).toEqual([sent!.sentText]);
    expect(sent!.sid).toMatch(/^SM/);
  });

  it("the footer is on the FIRST text to a number and not the second, two sends back to back (the conversation write is awaited)", async () => {
    const { to, customer, visit } = await account();
    const hub = { customerId: customer.id, visitId: visit.id };
    const first = await sendSms(to, "First.", T("visit_reminder", { hub }));
    const second = await sendSms(to, "Second.", T("visit_reminder", { hub }));
    expect(first!.footerIncluded).toBe(true);
    expect(first!.sentText.endsWith("\nReply STOP to opt out.")).toBe(true);
    expect(second!.footerIncluded).toBe(false);
    expect(second!.sentText).not.toMatch(/reply stop/i);
    // Both are in the account's Conversation, tagged with the job, with exactly what was sent.
    const rows = await prisma.hubMessage.findMany({ where: { thread: { customerId: customer.id }, channel: "sms" }, orderBy: { createdAt: "asc" } });
    expect(rows.map((r) => [r.status, r.footerIncluded, r.visitId, r.messageClass, r.purposeKey])).toEqual([
      ["sent", true, visit.id, "transactional", "appointment_reminder"],
      ["sent", false, visit.id, "transactional", "appointment_reminder"],
    ]);
    expect(rows.map((r) => r.sentText)).toEqual([first!.sentText, second!.sentText]);
  });

  it("an internal text is the prefix and nothing else: no label, no date, no footer", async () => {
    const sent = await sendSms(KYLE_PHONE, "New web lead — Jane, panel, 615-555-0100", { messageClass: "internal", category: "internal_alert" });
    expect(sent!.sentText).toBe("Red Cedar Electric:\nNew web lead — Jane, panel, 615-555-0100");
    expect(sent!.footerIncluded).toBe(false);
  });

  it("a marketing text is refused: there is no marketing opt-in on record", async () => {
    const { to } = await account();
    const sent = await sendSms(to, "Fall special.", { messageClass: "marketing", category: "thread_reply" });
    expect(sent).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("the double-brand and double-footer refusals apply to the customer classes, never to internal", async () => {
    const { to } = await account();
    expect(await sendSms(to, "Red Cedar Electric: hello", T("visit_reminder"))).toBeNull();
    expect(await sendSms(to, "Hello. Reply STOP to opt out.", T("visit_reminder"))).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    // An internal forward QUOTES the customer's own words, which may say anything.
    const forward = await sendSms(KYLE_PHONE, 'CUSTOMER SMS — Jane (+16155550100): "reply stop?? red cedar electric: help"', { messageClass: "internal", category: "internal_alert" });
    expect(forward).not.toBeNull();
    expect(sentBodies()[0]).toContain("reply stop??");
  });

  it("'internal' goes only to Kyle, the operator alert number and an active technician: a customer is refused as internal", async () => {
    const { to } = await account();
    expect(await sendSms(to, "hello", { messageClass: "internal", category: "internal_alert" })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    process.env.OPERATOR_ALERT_NUMBER = "+16155557777";
    expect(await sendSms("+16155557777", "alert", { messageClass: "internal", category: "internal_alert" })).not.toBeNull();

    const active = await prisma.technician.create({ data: { name: `${TAG} Active`, phone: newPhone10(), isActive: true, accessToken: `smshf-${randomUUID()}` } });
    const gone = await prisma.technician.create({ data: { name: `${TAG} Gone`, phone: newPhone10(), isActive: false, accessToken: `smshf-${randomUUID()}` } });
    techIds.push(active.id, gone.id);
    expect(await sendSms(e164(active.phone!), "job", { messageClass: "internal", category: "tech_notice" })).not.toBeNull();
    expect(await sendSms(e164(gone.phone!), "job", { messageClass: "internal", category: "tech_notice" })).toBeNull();
    expect(sentTo()).toEqual(["+16155557777", e164(active.phone!)]);
  });

  it("a text with no class or no send type is refused and logged, never thrown", async () => {
    const calls: Array<() => Promise<unknown>> = [
      // @ts-expect-error: the class and the send type are required
      () => sendSms(KYLE_PHONE, "no meta at all"),
      // @ts-expect-error: the third argument is required
      () => sendSms(KYLE_PHONE, "no opts", undefined),
      // @ts-expect-error: a class is required
      () => sendSms(KYLE_PHONE, "no class", { category: "internal_alert" }),
      // @ts-expect-error: a send type is required
      () => sendSms(KYLE_PHONE, "no category", { messageClass: "internal" }),
      // @ts-expect-error: a class outside the three is not a class
      () => sendSms(KYLE_PHONE, "bad class", { messageClass: "urgent", category: "internal_alert" }),
    ];
    for (const call of calls) await expect(call()).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await sendSms(KYLE_PHONE, "unknown type", { messageClass: "internal", category: "no_such_type" })).toBeNull();
    // The class must be the send type's own class.
    expect(await sendSms(KYLE_PHONE, "mismatch", { messageClass: "transactional", category: "internal_alert" })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps opts as the THIRD argument (the alerting tests read calls[0][2])", async () => {
    expect(sendSms.length).toBe(3);
  });

  it("Kyle's renamed label is what prints (smsPurposeLabels), and every registry purpose has a default", async () => {
    const { to } = await account();
    await saveOwnerSetting("smsPurposeLabels", { appointment_reminder: "Visit Tomorrow" });
    const sent = await sendSms(to, "See you soon.", T("visit_reminder", { when: { start: new Date("2026-11-23T14:00:00Z") } }));
    expect(sent!.sentText.split("\n")[0]).toBe("Red Cedar Electric: Visit Tomorrow Mon 11/23, 8 AM");
    for (const c of MESSAGE_CATEGORY_LIST.filter((x) => x.messageClass === "transactional")) {
      expect(SMS_PURPOSES[c.purposeKey!].defaultLabel.length).toBeGreaterThan(0);
    }
  });
});

describe("every live send site wears its class and header label (addendum section 4)", () => {
  it("scheduling's customer text: a consultation is 'Consultation <window>', a work visit is 'Job Scheduled <date>'", async () => {
    const consult = await account();
    await sendCustomerSms(consult.to, "Hi Jane, your visit is booked.", T("consultation_scheduled", { when: { start: consult.visit.scheduledStart!, end: consult.visit.scheduledEnd } }));
    const work = await account({ status: "scheduled", end: null });
    await sendCustomerSms(work.to, "Hi Jane, your job is booked.", T("job_scheduled", { when: { start: work.visit.scheduledStart! } }));
    expect(sentBodies().map((b) => lines(b)[0])).toEqual([
      "Red Cedar Electric: Consultation Mon 11/23, 8-10 AM",
      "Red Cedar Electric: Job Scheduled Mon 11/23, 8 AM",
    ]);
  });

  it("reschedule and cancel texts: 'Reschedule <new window>' and 'Appointment Cancelled <date>'", async () => {
    const { to } = await account();
    await sendCustomerSms(to, "Moved.", T("visit_rescheduled", { when: { start: new Date("2026-11-24T15:00:00Z"), end: new Date("2026-11-24T17:00:00Z") } }));
    await sendCustomerSms(to, "Cancelled.", T("visit_cancelled", { when: { start: new Date("2026-11-23T14:00:00Z") } }));
    expect(sentBodies().map((b) => lines(b)[0])).toEqual([
      "Red Cedar Electric: Reschedule Tue 11/24, 9-11 AM",
      "Red Cedar Electric: Appointment Cancelled Mon 11/23, 8 AM",
    ]);
  });

  it("the confirmation request carries the visit's window for a consultation (VisitContact.scheduledEnd and kind) and only the start for a job", async () => {
    const consult = await account();
    const base = { customerName: "Jane Smith", phone: consult.to, email: null, address: "12 Main St, Smyrna", jobType: "Panel upgrade" };
    const r1 = await sendVisitConfirmationRequest({
      ...base, visitId: consult.visit.id, customerId: consult.customer.id,
      scheduledStart: consult.visit.scheduledStart!, scheduledEnd: consult.visit.scheduledEnd, visitKind: "estimate",
    });
    const work = await account({ status: "scheduled", end: new Date("2026-11-23T22:00:00Z") });
    const r2 = await sendVisitConfirmationRequest({
      ...base, phone: work.to, visitId: work.visit.id, customerId: work.customer.id,
      scheduledStart: work.visit.scheduledStart!, scheduledEnd: work.visit.scheduledEnd, visitKind: "production",
    });
    expect(r1.sms && r2.sms).toBe(true);
    const bodies = sentBodies();
    expect(lines(bodies[0]!)[0]).toBe("Red Cedar Electric: Appointment Confirmation Mon 11/23, 8-10 AM");
    expect(lines(bodies[1]!)[0]).toBe("Red Cedar Electric: Appointment Confirmation Mon 11/23, 8 AM");
    // The words no longer carry the company name or the STOP line: they are the header and the footer.
    expect(lines(bodies[0]!)[1]).toMatch(/^Hi Jane, please confirm your appointment on /);
    expect(bodies[0]).not.toMatch(/this is Red Cedar Electric/);
    expect(bodies[0]!.endsWith("\nReply STOP to opt out.")).toBe(true);
  });

  it("the 24-hour reminder is 'Appointment Reminder <window>' and the mid-body brand is gone", async () => {
    const start = new Date(Date.now() + 24 * 3600_000);
    const a = await account({ status: "estimate", start, end: new Date(start.getTime() + 2 * 3600_000) });
    await sendVisitReminders();
    const mine = sentBodies().filter((_b, i) => sentTo()[i]!.endsWith(a.phone10));
    expect(mine).toHaveLength(1);
    expect(lines(mine[0]!)[0]).toMatch(/^Red Cedar Electric: Appointment Reminder \w{3} \d{1,2}\/\d{1,2}, \d{1,2}(:\d{2})?-\d{1,2}(:\d{2})? [AP]M$/);
    expect(mine[0]).not.toMatch(/reminder from Red Cedar Electric/);
    expect(mine[0]!.endsWith("\nReply STOP to opt out.")).toBe(true);
    const row = await prisma.hubMessage.findFirstOrThrow({ where: { thread: { customerId: a.customer.id }, channel: "sms" } });
    expect(row).toMatchObject({ visitId: a.visit.id, purposeKey: "appointment_reminder", messageClass: "transactional" });
  });

  it("a technician's assignment text is internal ('NEW JOB' under the prefix, no mid-text brand) and is filed on the JOB's thread, never a customer's", async () => {
    const a = await account();
    const tech = await prisma.technician.create({ data: { name: `${TAG} Tech`, phone: newPhone10(), isActive: true, accessToken: `smshf-${randomUUID()}` } });
    techIds.push(tech.id);
    await notifyTechnicianOfAssignment(tech.id, a.visit.id, "assigned");
    await vi.waitFor(() => expect(twilioCalls()).toHaveLength(1));
    const body = sentBodies()[0]!;
    expect(body.startsWith("Red Cedar Electric:\nNEW JOB\n")).toBe(true);
    expect(body).not.toMatch(/NEW JOB — Red Cedar Electric/);
    expect(sentTo()[0]).toBe(tech.phone);
    await vi.waitFor(async () => expect(await prisma.hubMessage.count({ where: { thread: { visitId: a.visit.id }, channel: "sms" } })).toBe(1));
    expect(await prisma.hubMessage.count({ where: { thread: { customerId: a.customer.id } } })).toBe(0);
  });

  it("applyConfirmationAction (both the SMS-reply door and the email-link door) texts Kyle and files it in that customer's conversation, tagged with the visit", async () => {
    const a = await account();
    await applyConfirmationAction(a.visit.id, "confirm", "email_link");
    await vi.waitFor(async () => expect(await prisma.hubMessage.count({ where: { thread: { customerId: a.customer.id }, channel: "sms" } })).toBe(1));
    expect(sentTo()).toEqual([KYLE_PHONE]);
    expect(sentBodies()[0]!.startsWith("Red Cedar Electric:\nCONFIRMED: ")).toBe(true);
    const row = await prisma.hubMessage.findFirstOrThrow({ where: { thread: { customerId: a.customer.id }, channel: "sms" } });
    expect(row).toMatchObject({ visitId: a.visit.id, messageClass: "internal", category: "internal_alert", status: "sent" });
  });
});
