/**
 * The AI admin's "Email the customer" Message is a draft for Kyle (work order agent-team, U4b, default D2).
 *
 * Pinned here: signed in as the AI admin, POST /communications/email sends NOTHING - it leaves a pending_approval email
 * HubMessage on the record's customer conversation carrying the To and CC the panel chose (a lead's, an account's, a job's
 * customer's); Approve (Kyle, through the ONE approver gate) then emails EXACTLY that To and CC through hubSend's email branch,
 * once; it is refused for the very reasons a send would be (no address, no such record) and leaves no draft; Kyle's PIN session
 * and an ordinary office login still send directly, as before, and write no draft.
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
import { createDraftMessage } from "../src/services/hubDrafts";
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

beforeAll(async () => {
  process.env.PIN_HASH = await hashPin(PIN);
  await wipe();
});
afterAll(async () => {
  delete process.env.PIN_HASH;
  await wipe();
  await cleanupCrmLoginFixtures();
});
beforeEach(async () => {
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

describe("signed in as the AI admin, the Message is a draft", () => {
  it("sends nothing, leaves ONE pending_approval email on the account's conversation with the To and CC the panel chose", async () => {
    const customer = await account();
    const res = await send(await aiToken(), {
      target: "account", id: customer.id, to: `pm@${DOMAIN}`, cc: [`office@${DOMAIN}`], subject: "Tuesday", body: "We can be there Tuesday.",
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ sent: false, drafted: true, to: `pm@${DOMAIN}`, cc: [`office@${DOMAIN}`], suppressed: false });

    expect(resendCalls()).toHaveLength(0);
    expect(await prisma.emailDelivery.count({ where: { customerId: customer.id } })).toBe(0);
    const rows = await drafts({ thread: { customerId: customer.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: res.body.messageId, status: "pending_approval", channel: "email", direction: "outbound", subject: "Tuesday",
      body: "We can be there Tuesday.", toAddress: `pm@${DOMAIN}`, cc: [`office@${DOMAIN}`], authorType: "ai_agent",
    });
    const thread = await prisma.hubThread.findUniqueOrThrow({ where: { id: rows[0]!.threadId } });
    expect(thread).toMatchObject({ kind: "customer", customerId: customer.id });
  });

  it("with no address chosen the draft carries the one on file, so the card and the send agree", async () => {
    const customer = await account();
    const res = await send(await aiToken(), { target: "account", id: customer.id, subject: "Hi", body: "Checking in." });
    expect(res.status).toBe(200);
    expect(res.body.to).toBe(customer.email);
    expect((await drafts({ thread: { customerId: customer.id } }))[0]).toMatchObject({ toAddress: customer.email, cc: [] });
  });

  it("Approve (Kyle) emails EXACTLY the chosen To and CC, once, from hubSend's email branch", async () => {
    const customer = await account();
    const ai = await aiToken();
    const kyle = await pinToken();
    const res = await send(ai, { target: "account", id: customer.id, to: `pm@${DOMAIN}`, cc: [`office@${DOMAIN}`, `owner@${DOMAIN}`], subject: "Tuesday", body: "We can be there Tuesday." });
    const messageId = res.body.messageId as string;

    const card = (await request(app).get("/hub/approvals").set(bearer(kyle))).body.cards.find((c: { id: string }) => c.id === messageId);
    expect(card).toMatchObject({ status: "pending_approval", recipientAddress: `pm@${DOMAIN}`, cc: [`office@${DOMAIN}`, `owner@${DOMAIN}`], subject: "Tuesday" });

    // The AI admin cannot approve its own draft.
    expect((await request(app).post(`/hub/messages/${messageId}/approve`).set(bearer(ai)).send({})).status).toBe(403);
    expect(resendCalls()).toHaveLength(0);

    const approved = await request(app).post(`/hub/messages/${messageId}/approve`).set(bearer(kyle)).send({});
    expect(approved.status).toBe(200);
    expect(approved.body.send).toEqual({ status: "sent", error: null });
    expect(resendCalls()).toHaveLength(1);
    const deliveries = await prisma.emailDelivery.findMany({ where: { customerId: customer.id } });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ to: `pm@${DOMAIN}`, cc: [`office@${DOMAIN}`, `owner@${DOMAIN}`], subject: "Tuesday", kind: "communication" });
    expect((await request(app).post(`/hub/messages/${messageId}/approve`).set(bearer(kyle)).send({})).status).toBe(409);
    expect(resendCalls()).toHaveLength(1);
  });

  it("a lead's Message is drafted on the lead's conversation; a job's on its customer's, tagged with the job", async () => {
    const ai = await aiToken();
    const lead = await prisma.lead.create({ data: { name: `${TAG} Lead`, source: "phone", email: `lead@${DOMAIN}` } });
    const fromLead = await send(ai, { target: "lead", id: lead.id, subject: "Hello", body: "Following up." });
    expect(fromLead.status).toBe(200);
    const leadRow = (await drafts({ id: fromLead.body.messageId }))[0]!;
    expect((await prisma.hubThread.findUniqueOrThrow({ where: { id: leadRow.threadId } })).leadId).toBe(lead.id);
    expect(leadRow.toAddress).toBe(`lead@${DOMAIN}`);

    const customer = await account();
    const property = await prisma.property.create({ data: { customerId: customer.id, name: "Home", addressLine1: "12 Main St", city: "Smyrna", state: "TN", postalCode: "37167" } });
    const visit = await prisma.visit.create({ data: { customerId: customer.id, propertyId: property.id, mode: "service_call", jobType: "Panel upgrade" } });
    const fromJob = await send(ai, { target: "job", id: visit.id, subject: "Your visit", body: "We are on the way." });
    expect(fromJob.status).toBe(200);
    const jobRow = (await drafts({ id: fromJob.body.messageId }))[0]!;
    expect(jobRow.visitId).toBe(visit.id);
    expect((await prisma.hubThread.findUniqueOrThrow({ where: { id: jobRow.threadId } })).customerId).toBe(customer.id);
    expect(resendCalls()).toHaveLength(0);
  });

  it("a job's draft, once approved, is filed against the JOB (so the job's Email history lists it), exactly as a direct send is", async () => {
    const customer = await account();
    const property = await prisma.property.create({ data: { customerId: customer.id, name: "Home", addressLine1: "12 Main St", city: "Smyrna", state: "TN", postalCode: "37167" } });
    const visit = await prisma.visit.create({ data: { customerId: customer.id, propertyId: property.id, mode: "service_call", jobType: "Panel upgrade" } });
    const ai = await aiToken();
    const kyle = await pinToken();
    const drafted = await send(ai, { target: "job", id: visit.id, to: `pm@${DOMAIN}`, cc: [`office@${DOMAIN}`], subject: "Your visit", body: "We are on the way." });
    expect(drafted.status).toBe(200);

    const approved = await request(app).post(`/hub/messages/${drafted.body.messageId}/approve`).set(bearer(kyle)).send({});
    expect(approved.status).toBe(200);
    expect(approved.body.send).toEqual({ status: "sent", error: null });
    const filed = await prisma.emailDelivery.findMany({ where: { to: `pm@${DOMAIN}` } });
    expect(filed).toHaveLength(1);
    expect(filed[0]).toMatchObject({ visitId: visit.id, customerId: null, cc: [`office@${DOMAIN}`] });

    // The same message sent directly from the same panel files the same way.
    const direct = await send(kyle, { target: "job", id: visit.id, to: `direct@${DOMAIN}`, subject: "Your visit", body: "We are on the way." });
    expect(direct.status).toBe(200);
    expect((await prisma.emailDelivery.findMany({ where: { to: `direct@${DOMAIN}` } }))[0]).toMatchObject({ visitId: visit.id });
  });

  it("a visit tag that does not belong to the thread's customer is ignored: the email is filed against the account", async () => {
    const customer = await account();
    const other = await account();
    const property = await prisma.property.create({ data: { customerId: other.id, name: "Home", addressLine1: "9 Oak St", city: "Smyrna", state: "TN", postalCode: "37167" } });
    const foreign = await prisma.visit.create({ data: { customerId: other.id, propertyId: property.id, mode: "service_call", jobType: "Panel upgrade" } });
    const thread = await ensureThreadFor({ customerId: customer.id });
    const { message } = await createDraftMessage(
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

  it("an ordinary office login (no power at all) sends at once too: only the AI admin is drafted", async () => {
    const customer = await account();
    const res = await send(await officeToken(), { target: "account", id: customer.id, subject: "Tuesday", body: "See you then." });
    expect(res.status).toBe(200);
    expect(res.body.sent).toBe(true);
    expect(resendCalls()).toHaveLength(1);
    expect(await drafts({ thread: { customerId: customer.id } })).toHaveLength(0);
  });
});
