/**
 * The AI admin's "Email the customer" Message is SENT (Kyle 2026-11-24: "We are submitting direct requests to these agents which implies
 * approval to all that they are reqested to do in the CRM. requiring them to check-in on everything defeats the purpose of the chat").
 * It used to be a draft that waited for Kyle (work order agent-team, U4b, default D2); this file pinned that, and now pins the replacement.
 *
 * Pinned here: signed in as the AI admin, POST /communications/email sends the email through the ONE agent send (createDraftMessage ->
 * sendAgentMessageNow -> hubSend's email branch) and records it on the record's customer conversation as a SENT message by the AI admin,
 * carrying the To and CC the panel chose (a lead's, an account's, a job's customer's); nothing ever waits for approval; every guard still
 * refuses (no address, no such record, Agent access paused, an address that unsubscribed) and the refusal is recorded as NOT SENT (409);
 * Kyle's PIN session and an ordinary office login still send directly, as before, with no message row.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
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

import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { hashPin } from "../src/middleware/pinAuth";
import { saveCrmLogin } from "../src/services/crmLogin";
import { ensureThreadFor } from "../src/services/hub";
import { AGENT_DAILY_DRAFT_LIMIT } from "../src/agentApi/audit";
import { waitingDraft } from "./helpers/waitingDraft"; // a pre-deploy card (this file still checks that the filing of an approved one is unchanged)
import { saveAdminLogin } from "../src/services/adminLogin";
import { cleanupCrmLoginFixtures, makePerson } from "./helpers/crmLoginFixture";

const PIN = "1234";
const PASS = "correct horse battery";
const AI_PASS = "another long password!";
const TAG = "HubAiAdminDraft";
const DOMAIN = `hubaidraft-${Date.now()}.example`;
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const resendCalls = () => fetchMock.mock.calls.filter(([u]) => String(u).includes("api.resend.com"));

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

let savedGate: string | undefined;
let savedMaster: string | undefined;
beforeAll(async () => {
  savedGate = process.env.AUTOMATED_CUSTOMER_SENDS_HUB_AUTOSEND;
  savedMaster = process.env.AUTOMATED_CUSTOMER_SENDS;
  process.env.PIN_HASH = await hashPin(PIN);
  await wipe();
});
afterAll(async () => {
  delete process.env.PIN_HASH;
  if (savedGate === undefined) delete process.env.AUTOMATED_CUSTOMER_SENDS_HUB_AUTOSEND; else process.env.AUTOMATED_CUSTOMER_SENDS_HUB_AUTOSEND = savedGate;
  if (savedMaster === undefined) delete process.env.AUTOMATED_CUSTOMER_SENDS; else process.env.AUTOMATED_CUSTOMER_SENDS = savedMaster;
  await wipe();
  await cleanupCrmLoginFixtures();
});
beforeEach(async () => {
  // The server-side switch for an AI's customer send (plan P7 keeps the env gates); on here, switched off by the test about it.
  process.env.AUTOMATED_CUSTOMER_SENDS_HUB_AUTOSEND = "on";
  delete process.env.AUTOMATED_CUSTOMER_SENDS;
  await cleanupCrmLoginFixtures();
  fetchMock.mockReset();
  mail.sendMail.mockReset();
  mail.sendMail.mockResolvedValue({});
  fetchMock.mockImplementation(async () => new Response(JSON.stringify({ id: `re_${randomUUID()}` }), { status: 200 }));
});
afterEach(wipe);

const pinToken = async () => (await request(app).post("/auth/pin").send({ pin: PIN })).body.token as string;
async function aiToken() {
  await saveAdminLogin("grok-admin", AI_PASS);
  const res = await request(app).post("/auth/login").send({ username: "grok-admin", password: AI_PASS });
  expect(res.status).toBe(200);
  return res.body.token as string;
}
async function officeToken() {
  const person = await makePerson(`${TAG} Michael`);
  await saveCrmLogin(person.id, { username: "michael", role: "owner", password: PASS });
  return (await request(app).post("/auth/login").send({ username: "michael", password: PASS })).body.token as string;
}

let seq = 0;
async function account(over: { email?: string | null } = {}) {
  return prisma.customer.create({
    data: { name: `${TAG} Jane ${seq++}`, phone: "6155550101", email: over.email === undefined ? `jane${seq}@${DOMAIN}` : over.email },
  });
}
const send = (token: string, body: Record<string, unknown>) => request(app).post("/communications/email").set(bearer(token)).send(body);
const drafts = (where: object = {}) => prisma.hubMessage.findMany({ where: { channel: "email", ...where }, orderBy: { createdAt: "asc" } });

describe("signed in as the AI admin, the Message is SENT", () => {
  it("sends the email once, and records ONE sent message on the account's conversation with the To and CC the panel chose and no approval step", async () => {
    const customer = await account();
    const res = await send(await aiToken(), {
      target: "account", id: customer.id, to: `pm@${DOMAIN}`, cc: [`office@${DOMAIN}`], subject: "Tuesday", body: "We can be there Tuesday.",
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ sent: true, drafted: false, to: `pm@${DOMAIN}`, cc: [`office@${DOMAIN}`], suppressed: false });

    expect(resendCalls()).toHaveLength(1);
    const deliveries = await prisma.emailDelivery.findMany({ where: { customerId: customer.id } });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ to: `pm@${DOMAIN}`, cc: [`office@${DOMAIN}`], subject: "Tuesday", kind: "communication" });
    const rows = await drafts({ thread: { customerId: customer.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: res.body.messageId, status: "sent", channel: "email", direction: "outbound", subject: "Tuesday",
      body: "We can be there Tuesday.", toAddress: `pm@${DOMAIN}`, cc: [`office@${DOMAIN}`], authorType: "ai_agent", authorDisplay: "AI admin",
      decidedBy: "ai-admin",
    });
    // The trail says in so many words that nobody approved it.
    expect(await prisma.hubAuditLog.count({ where: { messageId: rows[0]!.id, action: "message_sent_directly" } })).toBe(1);
    expect(await prisma.hubAuditLog.count({ where: { messageId: rows[0]!.id, action: "message_sent" } })).toBe(1);
    const thread = await prisma.hubThread.findUniqueOrThrow({ where: { id: rows[0]!.threadId } });
    expect(thread).toMatchObject({ kind: "customer", customerId: customer.id });
    // Nothing is waiting for anyone's approval.
    expect((await request(app).get("/hub/approvals").set(bearer(await pinToken()))).body.cards.filter((c: { id: string }) => c.id === rows[0]!.id)).toHaveLength(0);
  });

  it("with the server-side switch OFF the AI admin's email is refused (409), recorded NOT SENT, and nothing goes out", async () => {
    delete process.env.AUTOMATED_CUSTOMER_SENDS_HUB_AUTOSEND;
    const customer = await account();
    const res = await send(await aiToken(), { target: "account", id: customer.id, subject: "Hi", body: "Checking in." });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ sent: false });
    expect(res.body.error).toMatch(/switched off on the server/);
    expect(await prisma.hubMessage.findUniqueOrThrow({ where: { id: res.body.messageId } })).toMatchObject({ status: "blocked", error: "agent_sends_off" });
    expect(resendCalls()).toHaveLength(0);
  });

  // Kyle 2026-11-24 removed the approval step, so the 500-a-day cap is the brake left: the AI admin has no key, so the cap is held where it sends.
  it("the AI admin's 500-a-day cap holds: at 500 sent today the next email is 429, nothing is written or sent", async () => {
    const customer = await account();
    const thread = await ensureThreadFor({ customerId: customer.id });
    await prisma.hubMessage.createMany({
      data: Array.from({ length: AGENT_DAILY_DRAFT_LIMIT }, () => ({
        threadId: thread.id, authorType: "ai_agent", authorKey: "ai-admin", authorDisplay: "AI admin", channel: "email", direction: "outbound", status: "sent",
        body: "Earlier today.", subject: "Earlier", category: "thread_reply",
      })),
    });
    const res = await send(await aiToken(), { target: "account", id: customer.id, subject: "One more", body: "Over the cap." });
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ sent: false });
    expect(res.body.error).toMatch(/500 messages for today/);
    expect(await prisma.hubMessage.count({ where: { threadId: thread.id } })).toBe(AGENT_DAILY_DRAFT_LIMIT);
    expect(resendCalls()).toHaveLength(0);
    // A draft the AI admin leaves is not a send; and under the cap the next one goes.
    await prisma.hubMessage.deleteMany({ where: { threadId: thread.id, subject: "Earlier" } });
    expect((await send(await aiToken(), { target: "account", id: customer.id, subject: "Now", body: "Under the cap." })).status).toBe(200);
  });

  it("with no address chosen the message goes to the one on file, and the record says so", async () => {
    const customer = await account();
    const res = await send(await aiToken(), { target: "account", id: customer.id, subject: "Hi", body: "Checking in." });
    expect(res.status).toBe(200);
    expect(res.body.to).toBe(customer.email);
    expect((await drafts({ thread: { customerId: customer.id } }))[0]).toMatchObject({ toAddress: customer.email, cc: [], status: "sent" });
  });

  it("every guard still holds: Agent access paused, or an address that unsubscribed, refuses with a 409 and the message is recorded NOT SENT (never waiting)", async () => {
    const ai = await aiToken();
    const customer = await account();
    await prisma.companySetting.upsert({
      where: { key: "agentAccess" },
      create: { key: "agentAccess", valueJson: JSON.stringify({ mode: "read_only", changedAt: null, changedBy: null }) },
      update: { valueJson: JSON.stringify({ mode: "read_only", changedAt: null, changedBy: null }) },
    });
    try {
      const paused = await send(ai, { target: "account", id: customer.id, subject: "Hi", body: "Checking in." });
      expect(paused.status).toBe(409);
      expect(paused.body.error).toMatch(/Agent access is paused or off/);
      expect(paused.body.sent).toBe(false);
      const row = await prisma.hubMessage.findUniqueOrThrow({ where: { id: paused.body.messageId } });
      expect(row).toMatchObject({ status: "blocked", error: "agent_access_off" });
      expect(await prisma.hubAuditLog.count({ where: { messageId: row.id, action: "send_blocked" } })).toBe(1);
    } finally {
      await prisma.companySetting.deleteMany({ where: { key: "agentAccess" } });
    }
    await prisma.emailSuppression.create({ data: { email: customer.email!, reason: "unsubscribed" } });
    const unsub = await send(ai, { target: "account", id: customer.id, subject: "Hi again", body: "Checking in." });
    expect(unsub.status).toBe(409);
    expect(unsub.body.error).toMatch(/unsubscribed/);
    expect((await prisma.hubMessage.findUniqueOrThrow({ where: { id: unsub.body.messageId } })).status).toBe("blocked");
    expect(resendCalls()).toHaveLength(0);
    expect(await prisma.emailDelivery.count({ where: { customerId: customer.id } })).toBe(0);
    await prisma.emailSuppression.deleteMany({ where: { email: customer.email! } });
  });

  it("a lead's Message is sent on the lead's conversation; a job's on its customer's, tagged with the job and filed against the JOB", async () => {
    const ai = await aiToken();
    const lead = await prisma.lead.create({ data: { name: `${TAG} Lead`, source: "phone", email: `lead@${DOMAIN}` } });
    const fromLead = await send(ai, { target: "lead", id: lead.id, subject: "Hello", body: "Following up." });
    expect(fromLead.status).toBe(200);
    const leadRow = (await drafts({ id: fromLead.body.messageId }))[0]!;
    expect(leadRow.status).toBe("sent");
    expect((await prisma.hubThread.findUniqueOrThrow({ where: { id: leadRow.threadId } })).leadId).toBe(lead.id);
    expect(leadRow.toAddress).toBe(`lead@${DOMAIN}`);

    const customer = await account();
    const property = await prisma.property.create({ data: { customerId: customer.id, name: "Home", addressLine1: "12 Main St", city: "Smyrna", state: "TN", postalCode: "37167" } });
    const visit = await prisma.visit.create({ data: { customerId: customer.id, propertyId: property.id, mode: "service_call", jobType: "Panel upgrade" } });
    const fromJob = await send(ai, { target: "job", id: visit.id, to: `pm@${DOMAIN}`, cc: [`office@${DOMAIN}`], subject: "Your visit", body: "We are on the way." });
    expect(fromJob.status).toBe(200);
    const jobRow = (await drafts({ id: fromJob.body.messageId }))[0]!;
    expect(jobRow).toMatchObject({ visitId: visit.id, status: "sent" });
    expect((await prisma.hubThread.findUniqueOrThrow({ where: { id: jobRow.threadId } })).customerId).toBe(customer.id);
    const filed = await prisma.emailDelivery.findMany({ where: { to: `pm@${DOMAIN}` } });
    expect(filed).toHaveLength(1);
    expect(filed[0]).toMatchObject({ visitId: visit.id, customerId: null, cc: [`office@${DOMAIN}`] });
    expect(resendCalls()).toHaveLength(2);

    // The same message sent directly from the same panel files the same way.
    const direct = await send(await pinToken(), { target: "job", id: visit.id, to: `direct@${DOMAIN}`, subject: "Your visit", body: "We are on the way." });
    expect(direct.status).toBe(200);
    expect((await prisma.emailDelivery.findMany({ where: { to: `direct@${DOMAIN}` } }))[0]).toMatchObject({ visitId: visit.id });
  });

  it("a visit tag that does not belong to the thread's customer is ignored: the email is filed against the account", async () => {
    const customer = await account();
    const other = await account();
    const property = await prisma.property.create({ data: { customerId: other.id, name: "Home", addressLine1: "9 Oak St", city: "Smyrna", state: "TN", postalCode: "37167" } });
    const foreign = await prisma.visit.create({ data: { customerId: other.id, propertyId: property.id, mode: "service_call", jobType: "Panel upgrade" } });
    const thread = await ensureThreadFor({ customerId: customer.id });
    const { message } = await waitingDraft(
      { key: "ai-admin", kind: "ai-admin", display: "RCE Admin", technicianId: null, threadKinds: [], agentRole: null, agentKeyId: null, isKyle: false },
      { threadId: thread.id, channel: "email", category: "thread_reply", subject: "Hi", body: "Checking in.", toAddress: `pm@${DOMAIN}`, visitId: foreign.id },
    );
    const approved = await request(app).post(`/hub/messages/${message.id}/approve`).set(bearer(await pinToken())).send({});
    expect(approved.status).toBe(200);
    expect((await prisma.emailDelivery.findMany({ where: { to: `pm@${DOMAIN}` } }))[0]).toMatchObject({ customerId: customer.id, visitId: null });
  });

  it("is refused for the reasons a send would be refused, and leaves no draft behind", async () => {
    const ai = await aiToken();
    const noEmail = await account({ email: null });
    const none = await send(ai, { target: "account", id: noEmail.id, subject: "Hi", body: "Checking in." });
    expect(none.status).toBe(400);
    expect(none.body.error).toMatch(/No email address on file/);
    const missing = await send(ai, { target: "account", id: "no-such-account", subject: "Hi", body: "Checking in." });
    expect(missing.status).toBe(404);
    expect(await drafts({ thread: { customerId: noEmail.id } })).toHaveLength(0);
    expect(await prisma.hubThread.count({ where: { customerId: noEmail.id } })).toBe(0);
  });
});

describe("everyone else still sends directly", () => {
  it("Kyle's PIN session sends at once and leaves no draft", async () => {
    const customer = await account();
    const res = await send(await pinToken(), { target: "account", id: customer.id, subject: "Tuesday", body: "See you then." });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ sent: true, to: customer.email });
    expect(res.body.drafted).toBeUndefined();
    expect(resendCalls()).toHaveLength(1);
    expect(await prisma.emailDelivery.count({ where: { customerId: customer.id } })).toBe(1);
    expect(await drafts({ thread: { customerId: customer.id } })).toHaveLength(0);
  });

  it("an ordinary office login (no power at all) sends at once too, with no message row (only the AI admin's send is recorded as a message)", async () => {
    const customer = await account();
    const res = await send(await officeToken(), { target: "account", id: customer.id, subject: "Tuesday", body: "See you then." });
    expect(res.status).toBe(200);
    expect(res.body.sent).toBe(true);
    expect(resendCalls()).toHaveLength(1);
    expect(await drafts({ thread: { customerId: customer.id } })).toHaveLength(0);
  });
});
