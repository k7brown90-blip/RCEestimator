/**
 * The "AI auto-send rules" setting and the auto-send evaluation (work order agent-team, BA8 + BA7): the
 * owner setting `hubAutoSend` through the ONE owner-settings route family, the new hubSms leg and hubAutoSend
 * workflow in the automation gate, and services/hubAutoSend.ts through the draft-create path.
 *
 * Pinned here: every category is OFF by default and no row is needed; only Kyle reads or writes it (the AI
 * admin and any other login get 403); only categories the send-type registry marks eligible are accepted;
 * with a category ON but the server-side gate OFF a draft stays waiting for a person; with both ON a draft goes
 * out only if it is within the length cap, names no dollar amount, the customer may be contacted that way
 * (consent, unsubscribe, the SMS leg) - and the audit says "auto-approved by rule <category>".
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
// The approvers' "needs approval" alert goes out through notifyNewMessage; it passes through, and is watched.
const notified = vi.hoisted(() => ({ statuses: [] as string[] }));
vi.mock("../src/services/hubNotifier", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/services/hubNotifier")>();
  return { ...real, notifyNewMessage: (m: { status: string }, ...rest: unknown[]) => { notified.statuses.push(m.status); return (real.notifyNewMessage as (...a: unknown[]) => Promise<void>)(m, ...rest); } };
});

import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { hashPin } from "../src/middleware/pinAuth";
import { createMessageRow, ensureTeamThread, ensureThreadFor, type HubReader } from "../src/services/hub";
import { maybeAutoApprove } from "../src/services/hubAutoSend";
import { createDraftMessage } from "../src/services/hubDrafts";
import { saveCrmLogin, setPowers } from "../src/services/crmLogin";
import { saveAdminLogin } from "../src/services/adminLogin";
import {
  customerSendsEnabled, logAutomationGateState, twilioLegEnvVar, twilioSendEnabled, workflowEnvVar,
} from "../src/services/automationGate";
import { AUTO_SEND_CATEGORIES } from "../shared/hub/autoSendCategories";
import { cleanupCrmLoginFixtures, makePerson } from "./helpers/crmLoginFixture";

const PIN = "1234";
const PASS = "correct horse battery";
const AI_PASS = "another long password!";
const TAG = "HubAutoSend";
const DOMAIN = `hubautosend-${Date.now()}.example`;
const AI: HubReader = { key: "ai-admin", kind: "ai-admin", display: "RCE Admin", technicianId: null, threadKinds: [], agentRole: null, agentKeyId: null, isKyle: false };
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const twilioCalls = () => fetchMock.mock.calls.filter(([u]) => String(u).includes("api.twilio.com"));
const resendCalls = () => fetchMock.mock.calls.filter(([u]) => String(u).includes("api.resend.com"));
const GATE = workflowEnvVar("hubAutoSend");
const LEG = twilioLegEnvVar("hubSms");
const CATEGORY = "lead_first_response";

async function wipe() {
  const customers = await prisma.customer.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
  const ids = customers.map((c) => c.id);
  await prisma.hubThread.deleteMany({ where: { OR: [{ title: { startsWith: TAG } }, { customerId: { in: ids } }] } });
  await prisma.emailDelivery.deleteMany({ where: { to: { endsWith: `@${DOMAIN}` } } });
  await prisma.emailSuppression.deleteMany({ where: { email: { endsWith: `@${DOMAIN}` } } });
  if (ids.length > 0) await prisma.customer.deleteMany({ where: { id: { in: ids } } });
}

beforeAll(async () => {
  process.env.PIN_HASH = await hashPin(PIN);
  process.env.TWILIO_ACCOUNT_SID = "ACtest";
  process.env.TWILIO_AUTH_TOKEN = "tok";
  process.env.TWILIO_SMS_NUMBER = "+16155550000";
  await wipe();
});
afterAll(async () => {
  delete process.env.PIN_HASH;
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_AUTH_TOKEN;
  delete process.env.TWILIO_SMS_NUMBER;
  await prisma.companySetting.deleteMany({ where: { key: "hubAutoSend" } });
  await wipe();
  await cleanupCrmLoginFixtures();
});
beforeEach(async () => {
  await cleanupCrmLoginFixtures();
  await prisma.companySetting.deleteMany({ where: { key: "hubAutoSend" } });
  delete process.env[GATE];
  delete process.env[LEG];
  fetchMock.mockReset();
  mail.sendMail.mockReset();
  mail.sendMail.mockResolvedValue({});
  fetchMock.mockImplementation(async (url) => {
    if (String(url).includes("api.twilio.com")) return new Response(JSON.stringify({ sid: `SM${randomUUID().replace(/-/g, "")}`, status: "queued" }), { status: 201 });
    return new Response(JSON.stringify({ id: `re_${randomUUID()}` }), { status: 200 });
  });
});
afterEach(async () => {
  delete process.env[GATE];
  delete process.env[LEG];
  await wipe();
});

async function pinToken(): Promise<string> {
  const res = await request(app).post("/auth/pin").send({ pin: PIN });
  return res.body.token as string;
}
async function michael(powers: string[] = []) {
  const person = await makePerson("Michael");
  const row = await saveCrmLogin(person.id, { username: "michael", role: "owner", password: PASS });
  if (powers.length > 0) await setPowers(row.id, powers as never);
  const res = await request(app).post("/auth/login").send({ username: "michael", password: PASS });
  return res.body.token as string;
}
async function aiAdminToken(): Promise<string> {
  await saveAdminLogin("grok-admin", AI_PASS);
  const res = await request(app).post("/auth/login").send({ username: "grok-admin", password: AI_PASS });
  return res.body.token as string;
}
const turnOn = (kyle: string, categories: Record<string, boolean> = { [CATEGORY]: true }) =>
  request(app).put("/owner-settings/hubAutoSend").set(bearer(kyle)).send({ categories });

let seq = 0;
async function account(over: { smsConsent?: boolean | null } = {}) {
  const customer = await prisma.customer.create({
    data: { name: `${TAG} ${seq}`, phone: `615557${1000 + (seq++ % 8000)}`, email: `c${seq}@${DOMAIN}`, smsConsent: over.smsConsent === undefined ? true : over.smsConsent },
  });
  return { customer, thread: await ensureThreadFor({ customerId: customer.id }) };
}
const draftEmail = (threadId: string, body = "Thanks for your request. We will call you today.", category: string = CATEGORY) =>
  createDraftMessage(AI, { threadId, channel: "email", category, subject: "Got your request", body });
const draftText = (threadId: string, body = "Thanks for your request. We will call you today.", category: string = CATEGORY) =>
  createDraftMessage(AI, { threadId, channel: "sms", category, body });

describe("the setting: Settings -> AI auto-send rules", () => {
  it("every category is OFF by default, with no row needed, and the card learns whether the server gate is on", async () => {
    const kyle = await pinToken();
    const r = await request(app).get("/owner-settings/hubAutoSend").set(bearer(kyle));
    expect(r.status).toBe(200);
    expect(r.body.value).toEqual({ categories: {}, changedAt: null, changedBy: null });
    expect(r.body.status).toEqual({ gateOn: false, gateEnv: GATE });
    expect(await prisma.companySetting.count({ where: { key: "hubAutoSend" } })).toBe(0);
    process.env[GATE] = "on";
    expect((await request(app).get("/owner-settings/hubAutoSend").set(bearer(kyle))).body.status.gateOn).toBe(true);
    // The categories are the registry's eligible ones, as a view.
    expect(AUTO_SEND_CATEGORIES.map((c) => c.key)).toContain(CATEGORY);
  });

  it("Kyle saves it, the server stamps who and when; an unknown or non-eligible category is a 400", async () => {
    const kyle = await pinToken();
    const ok = await turnOn(kyle);
    expect(ok.status).toBe(200);
    expect(ok.body.value.categories).toEqual({ [CATEGORY]: true });
    expect(ok.body.value.changedBy).toBeTruthy();
    expect(ok.body.value.changedAt).toBeTruthy();
    expect((await turnOn(kyle, { nonsense: true })).status).toBe(400);
    expect((await turnOn(kyle, { thread_reply: true })).status).toBe(400);
    expect((await request(app).put("/owner-settings/hubAutoSend").set(bearer(kyle)).send({ categories: { [CATEGORY]: "yes" } })).status).toBe(400);
    // Turning it off again is the exit.
    expect((await turnOn(kyle, { [CATEGORY]: false })).body.value.categories[CATEGORY]).toBe(false);
  });

  it("the AI admin and any other login, even one holding approve_drafts, cannot read or change it", async () => {
    for (const token of [await aiAdminToken(), await michael(["approve_drafts", "bot_keys"])]) {
      expect((await request(app).get("/owner-settings/hubAutoSend").set(bearer(token))).status).toBe(403);
      expect((await turnOn(token)).status).toBe(403);
    }
    expect(await prisma.companySetting.count({ where: { key: "hubAutoSend" } })).toBe(0);
  });
});

describe("the gate: a new SMS leg and a new workflow, both default-deny", () => {
  it("hubSms is HUB_SMS_OUTBOUND_ENABLED and hubAutoSend is AUTOMATED_CUSTOMER_SENDS_HUB_AUTOSEND; both are off until set", () => {
    expect(LEG).toBe("HUB_SMS_OUTBOUND_ENABLED");
    expect(GATE).toBe("AUTOMATED_CUSTOMER_SENDS_HUB_AUTOSEND");
    expect(twilioSendEnabled("hubSms")).toBe(false);
    expect(customerSendsEnabled("hubAutoSend")).toBe(false);
    process.env[LEG] = "typo";
    expect(twilioSendEnabled("hubSms")).toBe(false);
    process.env[LEG] = "on";
    expect(twilioSendEnabled("hubSms")).toBe(true);
    process.env[GATE] = "on";
    expect(customerSendsEnabled("hubAutoSend")).toBe(true);
  });

  it("the boot log names the new leg and the new workflow, disabled", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    logAutomationGateState();
    const out = log.mock.calls.map((c) => String(c[0])).join("\n");
    log.mockRestore();
    expect(out).toContain("DISABLED hubSms");
    expect(out).toContain("DISABLED hubAutoSend");
  });
});

describe("evaluation in the draft-create path", () => {
  it("with the category ON but the server gate OFF, a draft stays waiting for a person", async () => {
    await turnOn(await pinToken());
    const { thread } = await account();
    const r = await draftEmail(thread.id);
    expect(r.autoApproved).toBe(false);
    expect(r.autoSendNote).toMatch(/gate is off/i);
    expect(r.message.status).toBe("pending_approval");
    expect(resendCalls()).toHaveLength(0);
  });

  it("with the gate ON but the category OFF, it stays waiting too", async () => {
    process.env[GATE] = "on";
    const { thread } = await account();
    const r = await draftEmail(thread.id);
    expect(r.autoApproved).toBe(false);
    expect(r.autoSendNote).toMatch(/off for/i);
    expect(r.message.status).toBe("pending_approval");
  });

  it("with both ON, an email in an eligible category goes out, approved by the rule, and the audit says so", async () => {
    await turnOn(await pinToken());
    process.env[GATE] = "on";
    const { customer, thread } = await account();
    const r = await draftEmail(thread.id);
    expect(r.autoApproved).toBe(true);
    expect(r.message).toMatchObject({ status: "sent", decidedBy: `rule:${CATEGORY}` });
    expect(resendCalls()).toHaveLength(1);
    expect(await prisma.emailDelivery.count({ where: { customerId: customer.id } })).toBe(1);
    const audit = await prisma.hubAuditLog.findFirstOrThrow({ where: { messageId: r.message.id, action: "message_auto_approved" } });
    expect(audit.afterText).toBe(`auto-approved by rule ${CATEGORY}`);
    expect(await prisma.hubEvent.count({ where: { type: "approval.decided", payloadJson: { contains: r.message.id } } })).toBe(1);
  });

  it("an auto-approved draft never tells the approvers it needs approval; one that stays waiting does", async () => {
    await turnOn(await pinToken());
    process.env[GATE] = "on";
    const { thread } = await account();
    notified.statuses.length = 0;
    const sent = await draftEmail(thread.id);
    expect(sent.autoApproved).toBe(true);
    // The announcement is made once, after the rule decided, with the row as it stands (sent): never "pending_approval".
    expect(notified.statuses).not.toContain("pending_approval");
    notified.statuses.length = 0;
    const waiting = await draftEmail(thread.id, "x".repeat(321));
    expect(waiting.autoApproved).toBe(false);
    expect(notified.statuses).toEqual(["pending_approval"]);
  });

  it("a draft over the length cap, or naming a dollar amount, stays waiting", async () => {
    await turnOn(await pinToken());
    process.env[GATE] = "on";
    const { thread } = await account();
    const long = await draftEmail(thread.id, "x".repeat(321));
    expect(long).toMatchObject({ autoApproved: false });
    expect(long.autoSendNote).toMatch(/longer than/);
    const priced = await draftEmail(thread.id, "The visit is $150 and we will call you.");
    expect(priced.autoApproved).toBe(false);
    expect(priced.autoSendNote).toMatch(/dollar/);
    expect(resendCalls()).toHaveLength(0);
  });

  it("a category the registry does not mark eligible never auto-sends, whatever is switched on", async () => {
    await turnOn(await pinToken());
    process.env[GATE] = "on";
    const { thread } = await account();
    const r = await draftEmail(thread.id, "Short note.", "thread_reply");
    expect(r.autoApproved).toBe(false);
    expect(r.autoSendNote).toMatch(/not one that can be auto-sent/);
  });

  it("an address that unsubscribed from email is not auto-emailed", async () => {
    await turnOn(await pinToken());
    process.env[GATE] = "on";
    const { customer, thread } = await account();
    await prisma.emailSuppression.create({ data: { email: customer.email!, reason: "unsubscribed" } });
    const r = await draftEmail(thread.id);
    expect(r.autoApproved).toBe(false);
    expect(r.autoSendNote).toMatch(/unsubscribed/);
  });

  it("a text auto-sends only with the SMS leg on AND the customer's consent; otherwise it waits", async () => {
    await turnOn(await pinToken());
    process.env[GATE] = "on";
    const { thread } = await account({ smsConsent: true });
    const legOff = await draftText(thread.id);
    expect(legOff.autoApproved).toBe(false);
    expect(legOff.autoSendNote).toMatch(/Texting is off/);

    process.env[LEG] = "on";
    const declined = await account({ smsConsent: null });
    const noConsent = await draftText(declined.thread.id);
    expect(noConsent.autoApproved).toBe(false);
    expect(noConsent.autoSendNote).toMatch(/not agreed to texts/);
    expect(twilioCalls()).toHaveLength(0);

    const ok = await draftText(thread.id);
    expect(ok.autoApproved).toBe(true);
    expect(ok.message.status).toBe("sent");
    expect(twilioCalls()).toHaveLength(1);
    const sent = new URLSearchParams(String(twilioCalls()[0]![1]?.body)).get("Body")!;
    expect(sent.startsWith("Red Cedar Electric: Request Received ")).toBe(true);
  });

  it("an agent can never create a message that is already approved or sent", async () => {
    const { thread } = await account();
    for (const status of ["approved", "sent", "posted"]) {
      await expect(createDraftMessage(AI, { threadId: thread.id, channel: "email", category: CATEGORY, subject: "x", body: "hi", status: status as never })).rejects.toMatchObject({ status: 403 });
    }
    expect(await prisma.hubMessage.count({ where: { threadId: thread.id } })).toBe(0);
  });

  it("only an AI author's draft can be auto-sent, and only the draft path creates one (a person cannot draft here)", async () => {
    const { thread } = await account();
    const person: HubReader = { ...AI, key: "owner", kind: "owner", display: "Kyle", isKyle: true };
    await expect(createDraftMessage(person, { threadId: thread.id, channel: "email", category: CATEGORY, subject: "x", body: "hi" })).rejects.toMatchObject({ status: 403 });
  });
});


describe("the four BA8 categories", () => {
  it("lead_first_response, visit_reminder (appointment reminder), team_internal and training_reply are all switchable, all OFF by default", async () => {
    const kyle = await pinToken();
    const keys = AUTO_SEND_CATEGORIES.map((c) => c.key);
    expect(keys).toEqual(expect.arrayContaining(["lead_first_response", "visit_reminder", "team_internal", "training_reply"]));
    expect((await request(app).get("/owner-settings/hubAutoSend").set(bearer(kyle))).body.value.categories).toEqual({});
    const on = await turnOn(kyle, { visit_reminder: true, team_internal: true, training_reply: true });
    expect(on.status).toBe(200);
    expect(on.body.value.categories).toEqual({ visit_reminder: true, team_internal: true, training_reply: true });
    // A send type that is not eligible still cannot be switched on.
    expect((await turnOn(kyle, { thread_reply: true })).status).toBe(400);
  });

  async function teamPost(category: string, threadId: string) {
    return createMessageRow(prisma, {
      threadId, authorType: "ai_agent", authorDisplay: "RCE Admin", channel: "in_app", direction: "internal", status: "pending_approval", body: "Noted for the team.", category,
    });
  }

  it("a team_internal / training_reply post auto-posts in a Team thread only when its category is ON and the gate is ON; never in a customer's conversation", async () => {
    const tech = await prisma.technician.create({ data: { name: `${TAG} Tech`, accessToken: `hubautosend-${randomUUID()}` } });
    try {
      const team = await ensureTeamThread(tech.id);
      const { thread: customerThread } = await account();

      // Off by default: stays waiting.
      const off = await teamPost("team_internal", team.id);
      expect(await maybeAutoApprove(off.id)).toMatchObject({ autoApproved: false, why: expect.stringMatching(/off for/i) });

      await turnOn(await pinToken(), { team_internal: true, training_reply: true });
      expect(await maybeAutoApprove(off.id)).toMatchObject({ autoApproved: false, why: expect.stringMatching(/gate is off/i) });

      process.env[GATE] = "on";
      const result = await maybeAutoApprove(off.id);
      expect(result).toMatchObject({ autoApproved: true, category: "team_internal", send: { status: "posted" } });
      expect(await prisma.hubAuditLog.count({ where: { messageId: off.id, action: "message_auto_approved", afterText: "auto-approved by rule team_internal" } })).toBe(1);
      expect(twilioCalls()).toHaveLength(0);
      expect(resendCalls()).toHaveLength(0);

      // The same category in a customer's conversation is refused: an in-app post must never land there.
      const wrongPlace = await teamPost("team_internal", customerThread.id);
      expect(await maybeAutoApprove(wrongPlace.id)).toMatchObject({ autoApproved: false, why: expect.stringMatching(/customer's conversation/) });
      expect((await prisma.hubMessage.findUniqueOrThrow({ where: { id: wrongPlace.id } })).status).toBe("pending_approval");

      // A customer-facing category on an in-app message is still refused.
      const mismatch = await teamPost("lead_first_response", team.id);
      await turnOn(await pinToken(), { lead_first_response: true });
      expect(await maybeAutoApprove(mismatch.id)).toMatchObject({ autoApproved: false });
    } finally {
      await prisma.hubThread.deleteMany({ where: { technicianId: tech.id } });
      await prisma.technician.delete({ where: { id: tech.id } });
    }
  });

  it("an appointment reminder draft by an AI auto-sends by email when its category and the gate are ON", async () => {
    await turnOn(await pinToken(), { visit_reminder: true });
    process.env[GATE] = "on";
    const { thread } = await account();
    const r = await draftEmail(thread.id, "Your visit is tomorrow morning.", "visit_reminder");
    expect(r.autoApproved).toBe(true);
    expect(r.message.status).toBe("sent");
    expect(resendCalls()).toHaveLength(1);
  });
});
