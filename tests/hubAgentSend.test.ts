/**
 * Agents act without check-ins (Kyle 2026-11-24: "I don't want the built in approvals you have been doing. We are submitting direct
 * requests to these agents which implies approval to all that they are reqested to do in the CRM. requiring them to check-in on everything
 * defeates the purpose of the chat and the agents workload cause I end up having to micro manage it rather than work in the field." and
 * "The messages are going to be automated too, no check in."). This file replaces tests/hubAutoSend.test.ts ("AI auto-send rules": an owner
 * setting, an env gate and a per-category switch that decided whether an agent's customer message needed an Approve), which pinned the
 * behaviour Kyle removed.
 *
 * Pinned here, through the REAL agent route (POST /api/hub/messages, an agent key with Allow writes) and services/hubAgentSend.ts:
 *   - an agent's customer EMAIL and TEXT are SENT when posted, by the one sender, authored by the key, with an audit row that says "sent
 *     directly" and nothing waiting in Messages -> Waiting for approval; a replay sends nothing again;
 *   - every guard still holds and the message is recorded as NOT SENT (status blocked, one send_blocked row, the agent told why, nothing queued):
 *     a customer who opted out or never agreed to texts; an address that unsubscribed; texting switched off (the env leg); Agent access paused or
 *     off (the kill switch); the key's Allow writes off or the key revoked (at the gate, and again at the moment of sending);
 *   - the 500-a-day cap still refuses before anything is written;
 *   - what stays gated stays gated: a price book change card is never touched by the direct send or the key's Team-post publish; an older
 *     message already waiting for approval is not sent by the deploy and can still be approved.
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
delete process.env.OPENAI_API_KEY;
delete process.env.STRIPE_SECRET_KEY;
vi.mock("stripe", () => ({ default: class MockStripe { constructor() { throw new Error("Stripe must not be constructed in tests"); } } }));
vi.mock("googleapis");
const mail = vi.hoisted(() => ({ sendMail: vi.fn<(opts: Record<string, unknown>) => Promise<unknown>>() }));
vi.mock("nodemailer", () => ({ default: { createTransport: () => ({ sendMail: mail.sendMail }) } }));
const fetchMock = vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>();
vi.stubGlobal("fetch", fetchMock);

import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { hashPin } from "../src/middleware/pinAuth";
import { mintAgentKey, type MintAgentKeyInput } from "../src/agentApi/keys";
import { AGENT_DAILY_DRAFT_LIMIT, countDraftsToday } from "../src/agentApi/audit";
import { createMessageRow, ensureThreadFor, type HubReader } from "../src/services/hub";
import { publishTeamPost, sendAgentMessageNow } from "../src/services/hubAgentSend";
import { createDraftMessage } from "../src/services/hubDrafts";
import { twilioLegEnvVar } from "../src/services/automationGate";
import { waitingDraft } from "./helpers/waitingDraft";

const TAG = "HubAgentSend";
const PIN = "1234";
const DOMAIN = `hubagentsend-${Date.now()}.example`;
const LEG = twilioLegEnvVar("hubSms");
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const idem = () => `idem-${randomUUID()}`;
const twilioCalls = () => fetchMock.mock.calls.filter(([u]) => String(u).includes("api.twilio.com"));
const resendCalls = () => fetchMock.mock.calls.filter(([u]) => String(u).includes("api.resend.com"));
const nothingWentOut = () => { expect(twilioCalls()).toHaveLength(0); expect(resendCalls()).toHaveLength(0); };

let savedPin: string | undefined;
let savedPepper: string | undefined;
let savedEnvName: string | undefined;
let savedGate: string | undefined;
let savedMaster: string | undefined;
const keyIds: string[] = [];

async function mint(overrides: Partial<MintAgentKeyInput> = {}) {
  const made = await mintAgentKey({
    name: `${TAG} ${randomUUID().slice(0, 6)}`, agentRole: "admin", createdBy: "owner", writesEnabled: true,
    scopes: ["hub:read", "hub:draft"], hubThreadKinds: [], ...overrides,
  });
  keyIds.push(made.row.id);
  return { secret: made.key, id: made.row.id, name: made.row.name };
}
const setMode = (mode: "on" | "read_only" | "off") => {
  const valueJson = JSON.stringify({ mode, changedAt: null, changedBy: null });
  return prisma.companySetting.upsert({ where: { key: "agentAccess" }, create: { key: "agentAccess", valueJson }, update: { valueJson } });
};
const post = (secret: string, body: Record<string, unknown>) => request(app).post("/api/hub/messages").set(bearer(secret)).send(body);

async function wipe() {
  const customers = await prisma.customer.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
  const ids = customers.map((c) => c.id);
  await prisma.hubThread.deleteMany({ where: { OR: [{ title: { startsWith: TAG } }, { customerId: { in: ids } }] } });
  await prisma.emailDelivery.deleteMany({ where: { to: { endsWith: `@${DOMAIN}` } } });
  await prisma.emailSuppression.deleteMany({ where: { email: { endsWith: `@${DOMAIN}` } } });
  if (ids.length > 0) await prisma.customer.deleteMany({ where: { id: { in: ids } } });
}

beforeAll(async () => {
  savedPin = process.env.PIN_HASH;
  savedPepper = process.env.AGENT_KEY_PEPPER;
  savedEnvName = process.env.RAILWAY_ENVIRONMENT_NAME;
  savedGate = process.env.AUTOMATED_CUSTOMER_SENDS_HUB_AUTOSEND;
  savedMaster = process.env.AUTOMATED_CUSTOMER_SENDS;
  process.env.PIN_HASH = await hashPin(PIN);
  process.env.AGENT_KEY_PEPPER = "test-pepper-for-the-hub-agent-send-suite";
  delete process.env.RAILWAY_ENVIRONMENT_NAME;
  process.env.TWILIO_ACCOUNT_SID = "ACtest";
  process.env.TWILIO_AUTH_TOKEN = "tok";
  process.env.TWILIO_SMS_NUMBER = "+16155550000";
  await wipe();
});
afterAll(async () => {
  if (savedPin === undefined) delete process.env.PIN_HASH; else process.env.PIN_HASH = savedPin;
  if (savedPepper === undefined) delete process.env.AGENT_KEY_PEPPER; else process.env.AGENT_KEY_PEPPER = savedPepper;
  if (savedEnvName === undefined) delete process.env.RAILWAY_ENVIRONMENT_NAME; else process.env.RAILWAY_ENVIRONMENT_NAME = savedEnvName;
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_AUTH_TOKEN;
  delete process.env.TWILIO_SMS_NUMBER;
  delete process.env[LEG];
  if (savedGate === undefined) delete process.env.AUTOMATED_CUSTOMER_SENDS_HUB_AUTOSEND; else process.env.AUTOMATED_CUSTOMER_SENDS_HUB_AUTOSEND = savedGate;
  if (savedMaster === undefined) delete process.env.AUTOMATED_CUSTOMER_SENDS; else process.env.AUTOMATED_CUSTOMER_SENDS = savedMaster;
  await prisma.companySetting.deleteMany({ where: { key: "agentAccess" } });
  await prisma.agentIdempotency.deleteMany({ where: { agentKeyId: { in: keyIds } } });
  await prisma.agentKey.deleteMany({ where: { id: { in: keyIds } } });
  await wipe();
});
beforeEach(() => {
  delete process.env[LEG];
  // The server-side switch for an AI customer send (the env gate the plan keeps): on for the direct-send tests, switched off by the tests about it.
  process.env.AUTOMATED_CUSTOMER_SENDS_HUB_AUTOSEND = "on";
  delete process.env.AUTOMATED_CUSTOMER_SENDS;
  fetchMock.mockReset();
  mail.sendMail.mockReset();
  mail.sendMail.mockResolvedValue({});
  fetchMock.mockImplementation(async (url) => {
    if (String(url).includes("api.twilio.com")) return new Response(JSON.stringify({ sid: `SM${randomUUID().replace(/-/g, "")}`, status: "queued" }), { status: 201 });
    return new Response(JSON.stringify({ id: `re_${randomUUID()}` }), { status: 200 });
  });
});
afterEach(async () => {
  delete process.env[LEG];
  await prisma.companySetting.deleteMany({ where: { key: "agentAccess" } });
  await wipe();
});

let seq = 0;
async function account(over: { smsConsent?: boolean | null } = {}) {
  const customer = await prisma.customer.create({
    data: { name: `${TAG} ${seq}`, phone: `615558${1000 + (seq++ % 8000)}`, email: `c${seq}@${DOMAIN}`, smsConsent: over.smsConsent === undefined ? true : over.smsConsent },
  });
  return customer;
}
const emailBody = (customerId: string, extra: Record<string, unknown> = {}) => ({
  customerId, channel: "email", category: "thread_reply", subject: "Your quote", body: "Your panel quote is ready to review.", idempotency_key: idem(), ...extra,
});
const textBody = (customerId: string, extra: Record<string, unknown> = {}) => ({
  customerId, channel: "sms", category: "lead_first_response", body: "Thanks for your request. We will call you today.", idempotency_key: idem(), ...extra,
});
const rowOf = (id: string) => prisma.hubMessage.findUniqueOrThrow({ where: { id } });

describe("an agent's customer message goes out when it is posted (the real route)", () => {
  it("an EMAIL is sent once, through the one sender, authored by the key, with an audit row saying it was sent directly, and nothing waits for approval", async () => {
    const k = await mint();
    const customer = await account();
    const res = await post(k.secret, emailBody(customer.id));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ status: "sent", channel: "email", pending_reason: null, not_sent_reason: null });

    expect(resendCalls()).toHaveLength(1);
    const delivery = await prisma.emailDelivery.findMany({ where: { customerId: customer.id } });
    expect(delivery).toHaveLength(1);
    const row = await rowOf(res.body.messageId);
    expect(row).toMatchObject({ status: "sent", authorType: "ai_agent", authorBotKeyId: k.id, decidedBy: `agent:${k.id}`, direction: "outbound" });
    expect(row.sentAt).not.toBeNull();
    expect(row.emailDeliveryId).toBe(delivery[0]!.id);
    // The Message audit log says who sent it and that nobody approved it; the card queue holds nothing for it.
    const direct = await prisma.hubAuditLog.findFirstOrThrow({ where: { messageId: row.id, action: "message_sent_directly" } });
    expect(direct).toMatchObject({ actorKey: `agent:${k.id}`, actorDisplay: k.name });
    expect(direct.afterText).toContain("without an approval step");
    expect(await prisma.hubAuditLog.count({ where: { messageId: row.id, action: "message_sent" } })).toBe(1);
    expect(await prisma.hubAuditLog.count({ where: { messageId: row.id, action: { in: ["message_approved", "message_auto_approved"] } } })).toBe(0);
    const kyle = (await request(app).post("/auth/pin").send({ pin: PIN })).body.token as string;
    const queue = (await request(app).get("/hub/approvals").set(bearer(kyle))).body.cards as Array<{ id: string }>;
    expect(queue.map((c) => c.id)).not.toContain(row.id);
    // The agent's own audit trail names the call.
    const call = await prisma.agentAuditLog.findFirstOrThrow({ where: { agentKeyId: k.id, action: "hub.messages.draft" } });
    expect(call).toMatchObject({ responseStatus: 201, resultCode: "sent" });
    expect(String(call.recordIds)).toContain(row.id);
  });

  it("a TEXT is sent once with the texting leg on and the customer's consent, in the CRM's own words (header and first-text footer)", async () => {
    process.env[LEG] = "on";
    const k = await mint();
    const customer = await account({ smsConsent: true });
    const res = await post(k.secret, textBody(customer.id));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ status: "sent", channel: "sms", not_sent_reason: null });
    expect(twilioCalls()).toHaveLength(1);
    expect(resendCalls()).toHaveLength(0);
    const sentWords = new URLSearchParams(String(twilioCalls()[0]![1]?.body)).get("Body")!;
    expect(sentWords.startsWith("Red Cedar Electric: Request Received ")).toBe(true);
    expect(await rowOf(res.body.messageId)).toMatchObject({ status: "sent", decidedBy: `agent:${k.id}`, authorBotKeyId: k.id });
  });

  it("a replay of the same call returns the same answer and sends nothing again", async () => {
    const k = await mint();
    const customer = await account();
    const body = emailBody(customer.id);
    const first = await post(k.secret, body);
    expect(first.status).toBe(201);
    const second = await post(k.secret, body);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(resendCalls()).toHaveLength(1);
    expect(await prisma.hubMessage.count({ where: { thread: { customerId: customer.id }, direction: "outbound" } })).toBe(1);
  });

  it("an explicit 'draft' is the agent's own choice to NOT send: it goes nowhere", async () => {
    const k = await mint();
    const customer = await account();
    const res = await post(k.secret, emailBody(customer.id, { status: "draft" }));
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("draft");
    expect(res.body.not_sent_reason).toMatch(/draft/);
    nothingWentOut();
  });
});

describe("every guard still holds, and the refusal is recorded as NOT SENT (never queued for approval)", () => {
  /** The message is recorded, not waiting, and the audit says why. */
  async function expectRecordedNotSent(res: request.Response, code: string, reason: RegExp) {
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.status).toBe("blocked");
    expect(res.body.not_sent_reason).toMatch(reason);
    const row = await rowOf(res.body.messageId);
    expect(row).toMatchObject({ status: "blocked", error: code });
    expect(row.sentAt).toBeNull();
    expect(await prisma.hubAuditLog.count({ where: { messageId: row.id, action: "send_blocked" } })).toBe(1);
    nothingWentOut();
  }

  it("a customer who opted out of texts is refused: blocked, nothing sent, the reason told to the agent", async () => {
    process.env[LEG] = "on";
    const k = await mint();
    const optedOut = await account({ smsConsent: false });
    await expectRecordedNotSent(await post(k.secret, textBody(optedOut.id)), "no_sms_consent", /has not agreed to texts/);
  });

  it("a customer who was never asked (no consent on file) is refused the same way", async () => {
    process.env[LEG] = "on";
    const k = await mint();
    const never = await account({ smsConsent: null });
    await expectRecordedNotSent(await post(k.secret, textBody(never.id)), "no_sms_consent", /has not agreed to texts/);
  });

  it("an address that unsubscribed from email is refused: blocked, nothing sent", async () => {
    const k = await mint();
    const customer = await account();
    await prisma.emailSuppression.create({ data: { email: customer.email!, reason: "unsubscribed" } });
    await expectRecordedNotSent(await post(k.secret, emailBody(customer.id)), "email_unsubscribed", /unsubscribed/);
    expect(await prisma.emailDelivery.count({ where: { customerId: customer.id } })).toBe(0);
  });

  it("texting switched OFF at the server (the env leg) is recorded as not sent, without throwing and without holding it for a later release", async () => {
    const k = await mint();
    const customer = await account({ smsConsent: true });
    expect(process.env[LEG]).toBeUndefined();
    const res = await post(k.secret, textBody(customer.id));
    await expectRecordedNotSent(res, "texting_off", /Texting is turned off/);
    // Not the "approved, held until texting is on" state a person's Approve leaves: nothing about it can release later.
    expect((await rowOf(res.body.messageId)).heldReason).toBeNull();
  });

  it("the kill switch: Agent access read_only or off refuses at the gate and writes no row; the send itself re-reads it too (a row made while it was On)", async () => {
    const k = await mint();
    const customer = await account();
    for (const mode of ["read_only", "off"] as const) {
      await setMode(mode);
      const before = await prisma.hubMessage.count({ where: { thread: { customerId: customer.id } } });
      const res = await post(k.secret, emailBody(customer.id));
      expect(res.status, mode).toBe(503);
      expect(await prisma.hubMessage.count({ where: { thread: { customerId: customer.id } } }), mode).toBe(before);
    }
    nothingWentOut();
    // The send re-reads the switch at the moment of sending: an approved agent row found while it is not On is blocked, not sent.
    await setMode("on");
    const thread = await ensureThreadFor({ customerId: customer.id });
    const row = await createMessageRow(prisma, {
      threadId: thread.id, authorType: "ai_agent", authorKey: `agent:${k.id}`, authorBotKeyId: k.id, authorDisplay: k.name, channel: "email", direction: "outbound",
      status: "approved", decidedBy: `agent:${k.id}`, decidedAt: new Date(), body: "Hello.", subject: "Hi", category: "thread_reply",
    });
    await setMode("read_only");
    const out = await sendAgentMessageNow(row.id);
    expect(out.sent).toBe(false);
    expect(out.notSentReason).toMatch(/Agent access is paused or off/);
    expect(out.message).toMatchObject({ status: "blocked", error: "agent_access_off" });
    nothingWentOut();
  });

  it("Allow writes off: refused at the gate (403 writes_disabled), no row, nothing sent; unticked or revoked after the row was made, the send itself still refuses", async () => {
    const off = await mint({ writesEnabled: false });
    const customer = await account();
    const before = await prisma.hubMessage.count({ where: { thread: { customerId: customer.id } } });
    const res = await post(off.secret, emailBody(customer.id));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("writes_disabled");
    expect(await prisma.hubMessage.count({ where: { thread: { customerId: customer.id } } })).toBe(before);
    nothingWentOut();

    const reader = (k: { id: string; name: string }): HubReader => ({
      key: `agent:${k.id}`, kind: "agent", display: k.name, technicianId: null, threadKinds: ["customer"], agentRole: "admin", agentKeyId: k.id, agentScopes: ["hub:read", "hub:draft"], isKyle: false,
    });
    const thread = await ensureThreadFor({ customerId: customer.id });
    // The key had Allow writes when the call was accepted; Kyle un-ticks it before the send runs.
    const k = await mint();
    await prisma.agentKey.update({ where: { id: k.id }, data: { writesEnabled: false } });
    const unticked = await createDraftMessage(reader(k), { threadId: thread.id, channel: "email", category: "thread_reply", subject: "Hi", body: "Hello." });
    expect(unticked.sent).toBe(false);
    expect(unticked.message).toMatchObject({ status: "blocked", error: "agent_writes_off" });
    // ...or revokes the key.
    await prisma.agentKey.update({ where: { id: k.id }, data: { writesEnabled: true, revokedAt: new Date() } });
    const revoked = await createDraftMessage(reader(k), { threadId: thread.id, channel: "email", category: "thread_reply", subject: "Hi again", body: "Hello again." });
    expect(revoked.sent).toBe(false);
    expect(revoked.message).toMatchObject({ status: "blocked", error: "agent_writes_off" });
    nothingWentOut();
  });

  it("the 500-a-day cap still holds: at the cap the call is 429 daily_draft_limit, no row is written, nothing is sent", async () => {
    const k = await mint();
    const customer = await account();
    await prisma.agentAuditLog.createMany({
      data: Array.from({ length: AGENT_DAILY_DRAFT_LIMIT }, () => ({
        action: "hub.messages.draft", agent: "admin", endpoint: "POST /hub/messages", agentKeyId: k.id, door: "rest", resultCode: "ok", responseStatus: 201, entityType: "draft",
      })),
    });
    const res = await post(k.secret, emailBody(customer.id));
    expect(res.status).toBe(429);
    expect(res.body.code).toBe("daily_draft_limit");
    expect(await prisma.hubMessage.count({ where: { thread: { customerId: customer.id } } })).toBe(0);
    nothingWentOut();
  });

  it("a scope the key does not hold is refused at the gate: a key without hub:draft cannot message a customer", async () => {
    const k = await mint({ scopes: ["hub:read"] });
    const customer = await account();
    const res = await post(k.secret, emailBody(customer.id));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("scope_denied");
    nothingWentOut();
  });
});

describe("what stays gated", () => {
  it("a price book change card is never sent or published by the agents' own request: the direct send and the key's Team-post box both leave it pending", async () => {
    const k = await mint();
    const thread = await prisma.hubThread.create({ data: { kind: "dev", title: `${TAG} price book` } });
    const card = await createMessageRow(prisma, {
      threadId: thread.id, authorType: "ai_agent", authorKey: `agent:${k.id}`, authorBotKeyId: k.id, authorDisplay: k.name, channel: "in_app", direction: "internal",
      status: "pending_approval", body: "Price book change proposed for X: cost.", actionKind: "price_change", actionPayloadJson: "{}",
    });
    expect(await publishTeamPost(card.id)).toMatchObject({ published: false });
    expect((await sendAgentMessageNow(card.id)).sent).toBe(false);
    expect(await rowOf(card.id)).toMatchObject({ status: "pending_approval", decidedBy: null });
    expect(await prisma.hubAuditLog.count({ where: { messageId: card.id, action: { in: ["message_auto_approved", "message_sent_directly", "message_approved"] } } })).toBe(0);
  });

  it("an older message already waiting for approval is NOT sent by the change and can still be approved by a person", async () => {
    const k = await mint();
    const customer = await account();
    const thread = await ensureThreadFor({ customerId: customer.id });
    const reader: HubReader = { key: `agent:${k.id}`, kind: "agent", display: k.name, technicianId: null, threadKinds: ["customer"], agentRole: "admin", agentKeyId: k.id, agentScopes: ["hub:read", "hub:draft"], isKyle: false };
    const { message } = await waitingDraft(reader, { threadId: thread.id, channel: "email", category: "thread_reply", subject: "Tuesday", body: "We can be there Tuesday." });
    expect(message.status).toBe("pending_approval");
    // The direct send ignores anything that is not in the approved state it writes itself.
    expect((await sendAgentMessageNow(message.id)).sent).toBe(false);
    expect((await rowOf(message.id)).status).toBe("pending_approval");
    nothingWentOut();
    const kyle = (await request(app).post("/auth/pin").send({ pin: PIN })).body.token as string;
    const waiting = (await request(app).get("/hub/approvals").set(bearer(kyle))).body.cards as Array<{ id: string }>;
    expect(waiting.map((c) => c.id)).toContain(message.id);
    const approved = await request(app).post(`/hub/messages/${message.id}/approve`).set(bearer(kyle)).send({});
    expect(approved.status).toBe(200);
    expect(approved.body.send).toEqual({ status: "sent", error: null });
    expect(resendCalls()).toHaveLength(1);
  });

  it("the old status 'pending_approval' in a request body is read as 'send' (no approval step is left for an agent to ask for)", async () => {
    const k = await mint();
    const customer = await account();
    const res = await post(k.secret, emailBody(customer.id, { status: "pending_approval" }));
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("sent");
  });
});

describe("the removed Auto-send rules, and the server-side switch that stays", () => {
  it("the owner setting hubAutoSend is no longer a setting", async () => {
    const kyle = (await request(app).post("/auth/pin").send({ pin: PIN })).body.token as string;
    expect((await request(app).get("/owner-settings/hubAutoSend").set(bearer(kyle))).status).toBe(400);
  });

  // Plan P7 (Kyle 2026-11-24) keeps "the Twilio/email env gates" in the guard list, and the manual-first ruling of 2026-08-11 is default-deny:
  // AUTOMATED_CUSTOMER_SENDS_HUB_AUTOSEND (or the master) must be on for an AI's customer email or text to go out.
  it("with the server switch OFF (both variables unset) an agent's email is recorded NOT SENT, told why, nothing goes out and nothing waits for approval", async () => {
    delete process.env.AUTOMATED_CUSTOMER_SENDS_HUB_AUTOSEND;
    delete process.env.AUTOMATED_CUSTOMER_SENDS;
    const k = await mint();
    const customer = await account();
    const res = await post(k.secret, emailBody(customer.id));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.status).toBe("blocked");
    expect(res.body.not_sent_reason).toMatch(/switched off on the server/);
    expect(await rowOf(res.body.messageId)).toMatchObject({ status: "blocked", error: "agent_sends_off" });
    expect(await prisma.hubAuditLog.count({ where: { messageId: res.body.messageId, action: "send_blocked" } })).toBe(1);
    nothingWentOut();
    const kyle = (await request(app).post("/auth/pin").send({ pin: PIN })).body.token as string;
    expect(((await request(app).get("/hub/approvals").set(bearer(kyle))).body.cards as Array<{ id: string }>).map((c) => c.id)).not.toContain(res.body.messageId);
  });

  it("a text needs the same server switch AND its own texting leg: switch off with the leg on is still refused, with the reason named", async () => {
    process.env[LEG] = "on";
    delete process.env.AUTOMATED_CUSTOMER_SENDS_HUB_AUTOSEND;
    const k = await mint();
    const customer = await account({ smsConsent: true });
    const res = await post(k.secret, textBody(customer.id));
    expect(res.body.status).toBe("blocked");
    expect(await rowOf(res.body.messageId)).toMatchObject({ status: "blocked", error: "agent_sends_off" });
    nothingWentOut();
  });

  it("the master switch alone also opens it, and the email goes out", async () => {
    delete process.env.AUTOMATED_CUSTOMER_SENDS_HUB_AUTOSEND;
    process.env.AUTOMATED_CUSTOMER_SENDS = "on";
    const k = await mint();
    const customer = await account();
    expect((await post(k.secret, emailBody(customer.id))).body.status).toBe("sent");
    expect(resendCalls()).toHaveLength(1);
  });
});

describe("the office TEST ACCOUNT is rehearsed exactly as a person's Approve rehearses it (TC10)", () => {
  it("an agent text to the test account with texting OFF settles as a rehearsal: sent, no provider call, not blocked", async () => {
    const k = await mint();
    const testCustomer = await prisma.customer.create({ data: { name: `${TAG} Test acct`, phone: "6155559900", email: `test@${DOMAIN}`, smsConsent: true, isTestAccount: true } });
    expect(process.env[LEG]).toBeUndefined();
    const res = await post(k.secret, textBody(testCustomer.id));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.status).toBe("sent");
    expect(await rowOf(res.body.messageId)).toMatchObject({ status: "sent", error: null });
    nothingWentOut();
  });

  it("the rehearsal needs no server switch either, and a real customer in the same state is still refused", async () => {
    delete process.env.AUTOMATED_CUSTOMER_SENDS_HUB_AUTOSEND;
    const k = await mint();
    const testCustomer = await prisma.customer.create({ data: { name: `${TAG} Test acct`, phone: "6155559901", email: `test2@${DOMAIN}`, smsConsent: true, isTestAccount: true } });
    expect((await post(k.secret, textBody(testCustomer.id))).body.status).toBe("sent");
    const real = await account({ smsConsent: true });
    expect((await post(k.secret, textBody(real.id))).body.status).toBe("blocked");
    nothingWentOut();
  });
});

describe("what the office screens and the agent audit say about a direct send", () => {
  it("the conversation view marks an agent's own send sentDirectly, and an AI message a person approved is NOT marked (Messages -> Conversation, Customer drawer)", async () => {
    const k = await mint();
    const customer = await account();
    const sent = await post(k.secret, emailBody(customer.id));
    expect(sent.body.status).toBe("sent");
    // A pre-deploy card a person approves afterwards: sent, but by a person.
    const thread = await ensureThreadFor({ customerId: customer.id });
    const reader: HubReader = { key: `agent:${k.id}`, kind: "agent", display: k.name, technicianId: null, threadKinds: ["customer"], agentRole: "admin", agentKeyId: k.id, agentScopes: ["hub:read", "hub:draft"], isKyle: false };
    const { message: old } = await waitingDraft(reader, { threadId: thread.id, channel: "email", category: "thread_reply", subject: "Older", body: "An older draft." });
    const kyle = (await request(app).post("/auth/pin").send({ pin: PIN })).body.token as string;
    expect((await request(app).post(`/hub/messages/${old.id}/approve`).set(bearer(kyle)).send({})).status).toBe(200);

    const timeline = await request(app).get(`/hub/timeline?customerId=${customer.id}`).set(bearer(kyle));
    expect(timeline.status).toBe(200);
    const byId = new Map<string, { sentDirectly: boolean; status: string }>(
      (timeline.body.entries as Array<{ type: string; message?: { id: string; sentDirectly: boolean; status: string } }>)
        .filter((e) => e.type === "message" && e.message).map((e) => [e.message!.id, e.message!]),
    );
    expect(byId.get(sent.body.messageId)).toMatchObject({ status: "sent", sentDirectly: true });
    expect(byId.get(old.id)).toMatchObject({ status: "sent", sentDirectly: false });

    const detail = await request(app).get(`/hub/threads/${thread.id}`).set(bearer(kyle));
    expect(detail.status).toBe(200);
    const inThread = new Map<string, { sentDirectly: boolean }>((detail.body.messages as Array<{ id: string; sentDirectly: boolean }>).map((m) => [m.id, m]));
    expect(inThread.get(sent.body.messageId)?.sentDirectly).toBe(true);
    expect(inThread.get(old.id)?.sentDirectly).toBe(false);
  });

  it("AgentAuditLog tells a send from a refusal (resultCode sent / not_sent), and both still count toward the 500 a day", async () => {
    const k = await mint();
    const ok = await account();
    const optedOut = await account({ smsConsent: false });
    process.env[LEG] = "on";
    const sent = await post(k.secret, emailBody(ok.id));
    const refused = await post(k.secret, textBody(optedOut.id));
    expect(sent.body.status).toBe("sent");
    expect(refused.body.status).toBe("blocked");
    const rows = await prisma.agentAuditLog.findMany({ where: { agentKeyId: k.id, action: "hub.messages.draft" }, orderBy: { createdAt: "asc" } });
    expect(rows.map((r) => r.resultCode)).toEqual(["sent", "not_sent"]);
    expect(rows.every((r) => r.entityType === "draft")).toBe(true);
    expect(await countDraftsToday(k.id)).toBe(2);
  });
});
