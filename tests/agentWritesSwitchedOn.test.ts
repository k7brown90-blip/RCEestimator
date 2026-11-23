/**
 * W1 - agent writes switched on (work order "Step 1 review - W1", Kyle 2026-11-22: "I want to start that work" ...
 * "How do I switch it on"). The old lock (AGENT_WRITE_TOOLS_AVAILABLE = false, "Write tools arrive in Phase B")
 * is gone because the first write tool, POST /api/hub/messages (scope hub:draft), shipped in C6. Nothing else
 * turns on by itself: a key keeps writesEnabled false until Kyle ticks "Allow writes" (Settings -> Agent keys), the
 * kill switch still governs, and (with the auto-send rules off, which is how this file starts; see W1b below) every agent post lands as pending_approval.
 *
 * This file walks the WHOLE path the way Kyle does, through the real routes, not through a hand-built key:
 *   1. a key made on the card (POST /settings/agent-keys) starts with writes OFF and POST /hub/messages answers
 *      403 writes_disabled and writes nothing;
 *   2. PATCH /settings/agent-keys/:id { writesEnabled: true } now SUCCEEDS for Kyle (and a person Kyle gave
 *      bot_keys), and is refused for a person without bot_keys, for the AI admin, and for a revoked key;
 *   3. with writes on and the kill switch On, the key drafts into a customer thread, its Team thread and a group it
 *      is a member of: every one is pending_approval and nothing is sent (team_internal auto-send is OFF);
 *   4. kill switch read_only and off refuse the post; a group the key is not in is the same 404 as an unknown id;
 *      Scout's posts in a training thread stay pending_approval (rule off);
 *   5. every PATCH is audited ("Agent key changed").
 *
 * W1b (work order "W1b", Kyle 2026-11-22: "I turned these on"): an agent's in-app post follows the auto-send rules Kyle switched
 * on. With "Team post by an AI" ON and the server-side gate ON, a post in a Team thread, a group the key is in, or a job's crew
 * chat is posted at once (decidedBy rule:team_internal) and announced ONCE; "Reply in a Training thread" does the same for Scout.
 * Rule OFF or gate off, it waits for Approve as before. A job thread is the crew chat: never an email or a text.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";

process.env.GOOGLE_CLIENT_ID = "test_id";
process.env.GOOGLE_CLIENT_SECRET = "test_secret";
process.env.GOOGLE_REFRESH_TOKEN = "test_token";
delete process.env.OPENAI_API_KEY;
delete process.env.STRIPE_SECRET_KEY;
vi.mock("stripe", () => ({ default: class MockStripe { constructor() { throw new Error("Stripe must not be constructed in tests"); } } }));
const smsSent = vi.hoisted(() => ({ calls: [] as unknown[] }));
vi.mock("../src/services/twilio", () => ({
  sendSms: vi.fn(async (...a: unknown[]) => { smsSent.calls.push(a); return { sid: "SM_mock" }; }),
  KYLE_PHONE: "+19706661626",
  isFromKyle: vi.fn().mockReturnValue(false),
  fetchTwilioMedia: vi.fn().mockResolvedValue(null),
}));
vi.mock("googleapis", () => {
  class MockOAuth2 { setCredentials() {} }
  return { google: { auth: { OAuth2: MockOAuth2 }, calendar: () => ({ freebusy: { query: vi.fn() }, events: { list: vi.fn(), delete: vi.fn() } }) } };
});
const emailSent = vi.hoisted(() => ({ calls: [] as unknown[] }));
vi.mock("../src/services/confirmationEmail", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/services/confirmationEmail")>();
  return {
    ...mod,
    sendBrandedEmail: vi.fn(async (...a: unknown[]) => { emailSent.calls.push(a); return true; }),
    sendKyleNotificationEmail: vi.fn().mockResolvedValue(undefined),
  };
});

// The approvers' "needs approval" alert and the team's "new message" push both go through notifyNewMessage: it passes through, and is watched.
const notified = vi.hoisted(() => ({ calls: [] as Array<{ id: string; status: string }> }));
vi.mock("../src/services/hubNotifier", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/services/hubNotifier")>();
  return {
    ...real,
    notifyNewMessage: (m: { id: string; status: string }, ...rest: unknown[]) => {
      notified.calls.push({ id: m.id, status: m.status });
      return (real.notifyNewMessage as (...a: unknown[]) => Promise<void>)(m, ...rest);
    },
  };
});

import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { hashPin } from "../src/middleware/pinAuth";
import { saveAdminLogin } from "../src/services/adminLogin";
import { saveCrmLogin, setPowers } from "../src/services/crmLogin";
import { subscribeHub, type HubBusEvent } from "../src/services/hubBus";
import { workflowEnvVar } from "../src/services/automationGate";
import { CRM_POWERS } from "../shared/crmPowers";
import { AGENT_KEYS_AI_ADMIN_REASON } from "../shared/agentScopes";
import * as agentScopes from "../shared/agentScopes";

const TAG = "AgentWritesOn";
const RUN = Math.random().toString(36).slice(2, 8);
const PIN = "1234";
const PASS = "correct horse battery";
const AI_PASS = "another long password!";
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const idem = () => `idem-${randomUUID()}`;

let savedPin: string | undefined;
let savedPepper: string | undefined;
let savedEnvName: string | undefined;
let savedGate: string | undefined;
let savedMaster: string | undefined;
let savedHubAutoSend: string | null = null;
let pin = "";
let customerId = "";
let visitId = "";
let jobThreadId = "";
let techId = "";
let techToken = "";
let teamThreadId = "";
let trainingThreadId = "";
const keyIds: string[] = [];
const loginTechIds: string[] = [];

async function setSwitch(mode: "on" | "read_only" | "off") {
  const res = await request(app).put("/owner-settings/agentAccess").set(bearer(pin)).send({ mode });
  expect(res.status).toBe(200);
}

/** A key made the way Kyle makes it: on the card, so it starts with Allow writes OFF. */
async function makeKey(body: Record<string, unknown>): Promise<{ id: string; secret: string; name: string }> {
  const name = `${TAG} ${randomUUID().slice(0, 6)}`;
  const res = await request(app).post("/settings/agent-keys").set(bearer(pin)).send({ name, agentRole: "admin", ...body });
  expect(res.status).toBe(201);
  expect(res.body.key.writesEnabled).toBe(false);
  keyIds.push(res.body.key.id);
  return { id: res.body.key.id, secret: res.body.secret, name };
}
const tick = (id: string, on: boolean, token = pin) =>
  request(app).patch(`/settings/agent-keys/${id}`).set(bearer(token)).send({ writesEnabled: on });
const post = (secret: string, body: Record<string, unknown>) => request(app).post("/api/hub/messages").set(bearer(secret)).send(body);
const customerDraft = (extra: Record<string, unknown> = {}) => ({
  customerId, channel: "email", subject: "Your quote", body: "Hello, your panel quote is ready to review.", idempotency_key: idem(), ...extra,
});
const rowsIn = (threadId: string) => prisma.hubMessage.count({ where: { threadId } });
const nothingSent = () => { expect(smsSent.calls).toHaveLength(0); expect(emailSent.calls).toHaveLength(0); };

async function personToken(username: string, powers: string[]) {
  const t = await prisma.technician.create({ data: { name: `${TAG} ${username}`, accessToken: `${TAG}-${randomUUID()}`, isActive: true } });
  loginTechIds.push(t.id);
  const login = await saveCrmLogin(t.id, { username: `${username}_${RUN}`, role: "owner", password: PASS });
  if (powers.length > 0) await setPowers(login.id, powers as never);
  const res = await request(app).post("/auth/login").send({ username: `${username}_${RUN}`, password: PASS });
  expect(res.status).toBe(200);
  return res.body.token as string;
}

beforeAll(async () => {
  savedPin = process.env.PIN_HASH;
  savedPepper = process.env.AGENT_KEY_PEPPER;
  savedEnvName = process.env.RAILWAY_ENVIRONMENT_NAME;
  savedGate = process.env[workflowEnvVar("hubAutoSend")];
  savedMaster = process.env.AUTOMATED_CUSTOMER_SENDS;
  savedHubAutoSend = (await prisma.companySetting.findUnique({ where: { key: "hubAutoSend" } }))?.valueJson ?? null;
  process.env.PIN_HASH = await hashPin(PIN);
  process.env.AGENT_KEY_PEPPER = "test-pepper-for-the-agent-writes-on-suite";
  delete process.env.RAILWAY_ENVIRONMENT_NAME;
  pin = (await request(app).post("/auth/pin").send({ pin: PIN })).body.token as string;
  const customer = await prisma.customer.create({
    data: {
      name: `${TAG} Jane Homeowner`, email: `${TAG.toLowerCase()}-${RUN}@homeowner.example`,
      properties: { create: { name: "Home", addressLine1: "88 Cedar Hollow Court", city: "Smyrna", state: "TN", postalCode: "37167" } },
    },
  });
  customerId = customer.id;
  const property = await prisma.property.findFirstOrThrow({ where: { customerId } });
  visitId = (await prisma.visit.create({ data: { customerId, propertyId: property.id, mode: "service_diagnostic", purpose: `${TAG} job`, status: "contracted" } })).id;
  jobThreadId = (await prisma.hubThread.create({ data: { kind: "job", title: `${TAG} crew chat`, visitId } })).id;
  const tech = await prisma.technician.create({ data: { name: `${TAG} Eric`, accessToken: `${TAG}-tok-${randomUUID()}`, isActive: true } });
  techId = tech.id;
  techToken = tech.accessToken;
  loginTechIds.push(tech.id);
  teamThreadId = (await prisma.hubThread.create({ data: { kind: "team", title: `${TAG} Eric team`, technicianId: techId } })).id;
  const apprentice = await prisma.technician.create({ data: { name: `${TAG} Apprentice`, accessToken: `${TAG}-tok-${randomUUID()}`, isActive: true } });
  loginTechIds.push(apprentice.id);
  trainingThreadId = (await prisma.hubThread.create({ data: { kind: "training", title: `${TAG} training`, technicianId: apprentice.id } })).id;
});

afterAll(async () => {
  if (savedPin === undefined) delete process.env.PIN_HASH; else process.env.PIN_HASH = savedPin;
  if (savedPepper === undefined) delete process.env.AGENT_KEY_PEPPER; else process.env.AGENT_KEY_PEPPER = savedPepper;
  if (savedEnvName === undefined) delete process.env.RAILWAY_ENVIRONMENT_NAME; else process.env.RAILWAY_ENVIRONMENT_NAME = savedEnvName;
  if (savedGate === undefined) delete process.env[workflowEnvVar("hubAutoSend")]; else process.env[workflowEnvVar("hubAutoSend")] = savedGate;
  if (savedMaster === undefined) delete process.env.AUTOMATED_CUSTOMER_SENDS; else process.env.AUTOMATED_CUSTOMER_SENDS = savedMaster;
  await prisma.companySetting.deleteMany({ where: { key: "hubAutoSend" } });
  if (savedHubAutoSend !== null) await prisma.companySetting.create({ data: { key: "hubAutoSend", valueJson: savedHubAutoSend } });
  await prisma.companySetting.deleteMany({ where: { key: "agentAccess" } });
  await prisma.hubThread.deleteMany({ where: { OR: [{ customerId }, { title: { startsWith: TAG } }] } });
  await prisma.agentIdempotency.deleteMany({ where: { agentKeyId: { in: keyIds } } });
  await prisma.agentKey.deleteMany({ where: { id: { in: keyIds } } });
  await prisma.crmLogin.deleteMany({ where: { technicianId: { in: loginTechIds } } });
  await prisma.adminLogin.deleteMany({ where: { username: `${TAG.toLowerCase()}-ai-${RUN}` } });
  await prisma.visit.deleteMany({ where: { customerId } });
  await prisma.property.deleteMany({ where: { customerId } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
  await prisma.technician.deleteMany({ where: { id: { in: loginTechIds } } });
});

beforeEach(async () => {
  // Every test starts with the auto-send rules OFF and the gate OFF (what Kyle ships with); a test that wants them on turns them on.
  delete process.env[workflowEnvVar("hubAutoSend")];
  delete process.env.AUTOMATED_CUSTOMER_SENDS;
  await prisma.companySetting.deleteMany({ where: { key: "hubAutoSend" } });
  notified.calls.length = 0;
  await setSwitch("on");
  smsSent.calls.length = 0;
  emailSent.calls.length = 0;
});

describe("the lock is gone, and the switch is the key's own Allow writes", () => {
  it("the code lock and its 'Phase B' reason no longer exist anywhere the card or the route can read them", () => {
    // Why: a constant that is always true is a dead switch (one tool, no dead switches); the only gate left is the key's writesEnabled.
    expect((agentScopes as Record<string, unknown>).AGENT_WRITE_TOOLS_AVAILABLE).toBeUndefined();
    expect((agentScopes as Record<string, unknown>).AGENT_WRITES_NOT_YET_REASON).toBeUndefined();
  });

  it("GET /settings/agent-keys no longer carries writeToolsAvailable", async () => {
    const res = await request(app).get("/settings/agent-keys").set(bearer(pin));
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty("writeToolsAvailable");
  });

  it("a key made on the card starts with writes OFF: 403 writes_disabled and no row; ticking Allow writes turns the same key on", async () => {
    const k = await makeKey({ scopes: ["hub:read", "hub:draft"] });
    const before = await prisma.hubMessage.count({ where: { thread: { customerId } } });
    const off = await post(k.secret, customerDraft());
    expect(off.status).toBe(403);
    expect(off.body.code).toBe("writes_disabled");
    expect(await prisma.hubMessage.count({ where: { thread: { customerId } } })).toBe(before);

    const on = await tick(k.id, true);
    expect(on.status).toBe(200);
    expect(on.body.key.writesEnabled).toBe(true);
    const ok = await post(k.secret, customerDraft());
    expect(ok.status).toBe(201);
    expect(ok.body.status).toBe("pending_approval");

    expect((await tick(k.id, false)).status).toBe(200);
    expect((await post(k.secret, customerDraft())).body.code).toBe("writes_disabled");
  });
});

describe("who may tick Allow writes", () => {
  it("Kyle and a person Kyle gave bot_keys can; a person without bot_keys and the AI admin cannot (403, nothing changes)", async () => {
    const k = await makeKey({ scopes: ["hub:read", "hub:draft"] });
    const without = await personToken("nopower", ["price_book_edit", "treasury"]);
    const refused = await tick(k.id, true, without);
    expect(refused.status).toBe(403);
    expect(refused.body).toEqual({ error: CRM_POWERS.bot_keys.reason });

    await prisma.adminLogin.deleteMany({ where: { username: `${TAG.toLowerCase()}-ai-${RUN}` } });
    await saveAdminLogin(`${TAG.toLowerCase()}-ai-${RUN}`, AI_PASS);
    const ai = (await request(app).post("/auth/login").send({ username: `${TAG.toLowerCase()}-ai-${RUN}`, password: AI_PASS })).body.token as string;
    const aiRefused = await tick(k.id, true, ai);
    expect(aiRefused.status).toBe(403);
    expect(aiRefused.body).toEqual({ error: AGENT_KEYS_AI_ADMIN_REASON });
    expect((await prisma.agentKey.findUniqueOrThrow({ where: { id: k.id } })).writesEnabled).toBe(false);

    const withPower = await personToken("haspower", ["bot_keys"]);
    expect((await tick(k.id, true, withPower)).status).toBe(200);
    expect((await prisma.agentKey.findUniqueOrThrow({ where: { id: k.id } })).writesEnabled).toBe(true);
    expect((await tick(k.id, false, pin)).status).toBe(200);
  });

  it("a revoked key cannot be ticked (409) and its box stays off", async () => {
    const k = await makeKey({ scopes: ["hub:read", "hub:draft"] });
    expect((await request(app).post(`/settings/agent-keys/${k.id}/revoke`).set(bearer(pin)).send({})).status).toBe(200);
    const res = await tick(k.id, true);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/revoked/i);
    expect((await prisma.agentKey.findUniqueOrThrow({ where: { id: k.id } })).writesEnabled).toBe(false);
  });

  it("an unknown key is 404", async () => {
    expect((await tick("cl_nobody", true)).status).toBe(404);
  });

  it("every tick and untick is audited as 'Agent key changed', naming Kyle and the key and never the secret", async () => {
    const k = await makeKey({ scopes: ["hub:read", "hub:draft"] });
    await tick(k.id, true);
    await tick(k.id, false);
    await new Promise((r) => setTimeout(r, 250));
    const events = await prisma.systemEvent.findMany({ where: { source: "agent_keys", message: "Agent key changed" }, orderBy: { createdAt: "desc" }, take: 20 });
    const mine = events.filter((e) => (e.detailsJson ?? "").includes(k.id));
    expect(mine.length).toBeGreaterThanOrEqual(2);
    for (const e of mine) {
      expect(e.detailsJson).toContain("writesEnabled");
      expect(e.detailsJson).toContain("Kyle");
      expect(e.detailsJson).not.toContain(k.secret);
    }
  });
});

describe("with writes on and the kill switch On, a member key drafts - and every draft waits for Approve", () => {
  it("a customer thread: hub:draft leaves a pending_approval draft, authored by the key, and nothing is sent", async () => {
    const k = await makeKey({ scopes: ["hub:read", "hub:draft"] });
    await tick(k.id, true);
    const res = await post(k.secret, customerDraft());
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("pending_approval");
    const row = await prisma.hubMessage.findUniqueOrThrow({ where: { id: res.body.messageId } });
    expect(row).toMatchObject({ status: "pending_approval", authorType: "ai_agent", authorBotKeyId: k.id });
    expect(row.sentAt).toBeNull();
    // A request that asks to skip Approve is refused outright, with no row.
    const before = await prisma.hubMessage.count({ where: { thread: { customerId } } });
    for (const status of ["approved", "sent"]) {
      expect((await post(k.secret, customerDraft({ status }))).status, status).toBe(403);
    }
    expect(await prisma.hubMessage.count({ where: { thread: { customerId } } })).toBe(before);
    nothingSent();
  });

  it("a Team thread: team:reply leaves a pending_approval in-app draft while the team_internal auto-send rule is OFF", async () => {
    const setting = await prisma.companySetting.findUnique({ where: { key: "hubAutoSend" } });
    expect(setting === null || !(JSON.parse(setting.valueJson) as { categories?: Record<string, boolean> }).categories?.team_internal).toBe(true);
    const k = await makeKey({ scopes: ["hub:read", "hub:draft", "team:reply"] });
    await tick(k.id, true);
    const res = await post(k.secret, { thread_id: teamThreadId, body: "Eric, the Smyrna panel is ordered.", idempotency_key: idem() });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ threadId: teamThreadId, status: "pending_approval", channel: "in_app" });
    const row = await prisma.hubMessage.findUniqueOrThrow({ where: { id: res.body.messageId } });
    expect(row).toMatchObject({ status: "pending_approval", authorType: "ai_agent", direction: "internal" });
    expect(row.decidedBy).toBeNull();
    nothingSent();
  });

  it("without team:reply the same key is refused in the Team thread (403) and writes no row", async () => {
    const k = await makeKey({ scopes: ["hub:read", "hub:draft"] });
    await tick(k.id, true);
    const before = await rowsIn(teamThreadId);
    expect((await post(k.secret, { thread_id: teamThreadId, body: "x", idempotency_key: idem() })).status).toBe(403);
    expect(await rowsIn(teamThreadId)).toBe(before);
  });

  it("a group the key is a member of: pending_approval; a group it is NOT in answers the very same 404 as an id nobody has", async () => {
    const member = await makeKey({ scopes: ["hub:read", "hub:draft", "team:reply"] });
    const outsider = await makeKey({ scopes: ["hub:read", "hub:draft", "team:reply"] });
    await tick(member.id, true);
    await tick(outsider.id, true);
    const made = await request(app).post("/hub/groups").set(bearer(pin))
      .send({ name: `${TAG} Crew ${RUN}`, technicianIds: [techId], agentKeyIds: [member.id] });
    expect(made.status).toBe(201);
    const groupId = made.body.id as string;

    const ok = await post(member.secret, { thread_id: groupId, body: "Noted, thanks.", idempotency_key: idem() });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ threadId: groupId, status: "pending_approval", channel: "in_app" });

    const unknown = `cl${randomUUID().replace(/-/g, "").slice(0, 23)}`;
    const hidden = await post(outsider.secret, { thread_id: groupId, body: "Let me in", idempotency_key: idem() });
    const missing = await post(outsider.secret, { thread_id: unknown, body: "Let me in", idempotency_key: idem() });
    expect(hidden.status).toBe(404);
    expect(missing.status).toBe(404);
    const strip = (b: Record<string, unknown>) => { const { call_id: _a, callId: _b, request_id: _c, requestId: _d, ...rest } = b; return rest; };
    expect(strip(hidden.body)).toEqual(strip(missing.body));
    expect(await rowsIn(groupId)).toBe(1);
    nothingSent();
  });

  it("Scout: a post in a training thread stays pending_approval even when it asks for 'draft'", async () => {
    const scout = await makeKey({ agentRole: "scout", scopes: ["hub:read", "hub:draft", "training:read", "training:write"], hubThreadKinds: ["training"] });
    await tick(scout.id, true);
    const res = await post(scout.secret, { thread_id: trainingThreadId, body: "Check the neutral first.", status: "draft", idempotency_key: idem() });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("pending_approval");
    expect((await prisma.hubMessage.findUniqueOrThrow({ where: { id: res.body.messageId } })).status).toBe("pending_approval");
    nothingSent();
  });
});

/** Kyle's "AI auto-send rules" card, through its real route; and the server-side gate, which is OFF unless a test turns it on. */
const rules = (categories: Record<string, boolean>) => request(app).put("/owner-settings/hubAutoSend").set(bearer(pin)).send({ categories });
const gate = (on: boolean) => { if (on) process.env[workflowEnvVar("hubAutoSend")] = "on"; else delete process.env[workflowEnvVar("hubAutoSend")]; };
const announced = (id: string) => notified.calls.filter((c) => c.id === id).map((c) => c.status);
/** The approval.decided event is fire-and-forget: wait briefly for its row, then read its action_kind. */
async function expectDecidedEvent(messageId: string, status: string, actionKind: string) {
  let rows: { payloadJson: string }[] = [];
  for (let i = 0; i < 40 && rows.length === 0; i++) {
    rows = await prisma.hubEvent.findMany({ where: { type: "approval.decided", payloadJson: { contains: messageId } }, select: { payloadJson: true } });
    if (rows.length === 0) await new Promise((r) => setTimeout(r, 50));
  }
  expect(rows).toHaveLength(1);
  expect(JSON.parse(rows[0].payloadJson)).toMatchObject({ action_kind: actionKind, status });
}
async function watchBus<T>(fn: () => Promise<T>): Promise<{ out: T; events: HubBusEvent[] }> {
  const events: HubBusEvent[] = [];
  const stop = subscribeHub((e) => events.push(e));
  try { return { out: await fn(), events }; } finally { stop(); }
}
const messageEvents = (events: HubBusEvent[], id: string) => events.filter((e) => e.type === "message" && e.messageId === id);

describe("W1b: an agent's in-app post follows the auto-send rules Kyle switched on", () => {
  /** A writes-on Admin-style key that may use customer, job (crew), team and group threads. */
  async function crewKey() {
    const k = await makeKey({ scopes: ["hub:read", "hub:draft", "team:reply"], hubThreadKinds: ["customer", "job", "team", "group"] });
    await tick(k.id, true);
    return k;
  }
  async function groupWith(keyId: string): Promise<string> {
    const made = await request(app).post("/hub/groups").set(bearer(pin)).send({ name: `${TAG} Crew ${randomUUID().slice(0, 6)}`, technicianIds: [techId], agentKeyIds: [keyId] });
    expect(made.status).toBe(201);
    return made.body.id as string;
  }
  async function expectAutoPosted(secret: string, threadId: string, body: string) {
    const { out: res, events } = await watchBus(() => post(secret, { thread_id: threadId, body, idempotency_key: idem() }));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ threadId, status: "posted", channel: "in_app", category: "team_internal" });
    const row = await prisma.hubMessage.findUniqueOrThrow({ where: { id: res.body.messageId } });
    expect(row).toMatchObject({ status: "posted", decidedBy: "rule:team_internal", direction: "internal", channel: "in_app", category: "team_internal", authorType: "ai_agent" });
    expect(row.sentAt).not.toBeNull();
    expect(await prisma.hubAuditLog.count({ where: { messageId: row.id, action: "message_auto_approved" } })).toBe(1);
    // ONE announcement, of the final row: never the "needs approval" wake for the approvers, and never twice (hubSend already announced it).
    expect(announced(row.id)).toEqual(["posted"]);
    expect(messageEvents(events, row.id)).toHaveLength(1);
    // The decision event an agent hears is a TEAM reply, the same kind a person's Approve of this post reports - never "customer_message".
    expect(row.actionKind).toBe("team_reply");
    await expectDecidedEvent(row.id, "approved", "team_reply");
    nothingSent();
    return res;
  }

  it("rule ON + gate ON: a post in the key's Team thread is posted at once, decided by rule:team_internal, announced once", async () => {
    expect((await rules({ team_internal: true })).status).toBe(200);
    gate(true);
    const k = await crewKey();
    await expectAutoPosted(k.secret, teamThreadId, "Eric, the Smyrna panel is ordered.");
  });

  it("rule ON + gate ON: a post in a group the key is a member of is posted at once", async () => {
    await rules({ team_internal: true });
    gate(true);
    const k = await crewKey();
    await expectAutoPosted(k.secret, await groupWith(k.id), "Noted, thanks.");
  });

  it("rule ON + gate ON: a post in a job's CREW chat is an in-app post, posted at once (never an email or text to the homeowner)", async () => {
    await rules({ team_internal: true });
    gate(true);
    const k = await crewKey();
    await expectAutoPosted(k.secret, jobThreadId, "Crew: the panel is in the garage.");
  });

  it("rule OFF (or gate off) leaves the post waiting for Approve, announced once as waiting - exactly as before", async () => {
    const k = await crewKey();
    for (const [label, ruleOn, gateOn] of [["rule off, gate on", false, true], ["rule on, gate off", true, false], ["both off", false, false]] as const) {
      notified.calls.length = 0;
      await rules({ team_internal: ruleOn });
      gate(gateOn);
      for (const threadId of [teamThreadId, jobThreadId]) {
        const res = await post(k.secret, { thread_id: threadId, body: `Hold for Approve (${label}).`, idempotency_key: idem() });
        expect(res.status, label).toBe(201);
        expect(res.body.status, label).toBe("pending_approval");
        const row = await prisma.hubMessage.findUniqueOrThrow({ where: { id: res.body.messageId } });
        expect(row, label).toMatchObject({ status: "pending_approval", decidedBy: null, category: "team_internal", channel: "in_app", actionKind: "team_reply" });
        expect(row.sentAt).toBeNull();
        expect(announced(row.id), label).toEqual(["pending_approval"]);
        expect(await prisma.hubAuditLog.count({ where: { messageId: row.id, action: "message_auto_approved" } })).toBe(0);
      }
    }
    nothingSent();
  });

  it("a draft the agent asks for ('draft') is never offered to the rule, even with the rule and gate ON", async () => {
    await rules({ team_internal: true });
    gate(true);
    const k = await crewKey();
    const res = await post(k.secret, { thread_id: teamThreadId, status: "draft", body: "Not ready yet.", idempotency_key: idem() });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("draft");
    const row = await prisma.hubMessage.findUniqueOrThrow({ where: { id: res.body.messageId } });
    expect(row).toMatchObject({ status: "draft", decidedBy: null });
    expect(await prisma.hubAuditLog.count({ where: { messageId: row.id, action: "message_auto_approved" } })).toBe(0);
  });

  it("a Scout Training post that ASKS for a draft stays pending_approval (never auto-posted) even with 'Reply in a Training thread' ON and the gate ON", async () => {
    // A Training thread turns every agent post into pending_approval (amendment 16b), so the final status alone cannot tell a
    // draft from a finished reply; the agent's own request is what keeps it out of the rule.
    await rules({ training_reply: true });
    gate(true);
    const scout = await makeKey({ agentRole: "scout", scopes: ["hub:read", "hub:draft", "training:read", "training:write"], hubThreadKinds: ["training"] });
    await tick(scout.id, true);
    const res = await post(scout.secret, { thread_id: trainingThreadId, status: "draft", body: "Not ready yet, still checking.", idempotency_key: idem() });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("pending_approval");
    const row = await prisma.hubMessage.findUniqueOrThrow({ where: { id: res.body.messageId } });
    expect(row).toMatchObject({ status: "pending_approval", decidedBy: null, category: "training_reply" });
    expect(row.sentAt).toBeNull();
    expect(await prisma.hubAuditLog.count({ where: { messageId: row.id, action: "message_auto_approved" } })).toBe(0);
    expect(announced(row.id)).toEqual(["pending_approval"]);
    nothingSent();
  });

  it("a post over the rule's length cap stays waiting for Approve", async () => {
    await rules({ team_internal: true });
    gate(true);
    const k = await crewKey();
    const res = await post(k.secret, { thread_id: teamThreadId, body: "x".repeat(2_000), idempotency_key: idem() });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("pending_approval");
  });

  it("Scout: a Training post is posted at once with 'Reply in a Training thread' ON, and waits with it OFF", async () => {
    const scout = await makeKey({ agentRole: "scout", scopes: ["hub:read", "hub:draft", "training:read", "training:write"], hubThreadKinds: ["training"] });
    await tick(scout.id, true);
    gate(true);
    await rules({ training_reply: false });
    const waiting = await post(scout.secret, { thread_id: trainingThreadId, body: "Check the neutral first.", idempotency_key: idem() });
    expect(waiting.status).toBe(201);
    expect(waiting.body).toMatchObject({ status: "pending_approval", category: "training_reply" });

    await rules({ training_reply: true });
    const { out: sent, events } = await watchBus(() => post(scout.secret, { thread_id: trainingThreadId, body: "Check the neutral first.", idempotency_key: idem() }));
    expect(sent.status).toBe(201);
    expect(sent.body).toMatchObject({ status: "posted", category: "training_reply" });
    const row = await prisma.hubMessage.findUniqueOrThrow({ where: { id: sent.body.messageId } });
    expect(row).toMatchObject({ status: "posted", decidedBy: "rule:training_reply" });
    expect(announced(row.id)).toEqual(["posted"]);
    expect(messageEvents(events, row.id)).toHaveLength(1);
    nothingSent();
    // Training is its own switch: "Team post by an AI" does not open it.
    await rules({ team_internal: true });
    const other = await post(scout.secret, { thread_id: trainingThreadId, body: "Second note.", idempotency_key: idem() });
    expect(other.body.status).toBe("pending_approval");
  });

  it("a send type that does not belong in the conversation is a 400 with a plain reason, and writes nothing", async () => {
    const k = await crewKey();
    const scout = await makeKey({ agentRole: "scout", scopes: ["hub:read", "hub:draft", "training:read", "training:write"], hubThreadKinds: ["training"] });
    await tick(scout.id, true);
    const before = [await rowsIn(teamThreadId), await rowsIn(jobThreadId), await rowsIn(trainingThreadId)];
    const wrongOnTeam = await post(k.secret, { thread_id: teamThreadId, category: "lead_first_response", body: "Hello", idempotency_key: idem() });
    expect(wrongOnTeam.status).toBe(400);
    expect(JSON.stringify(wrongOnTeam.body)).toMatch(/Team post by an AI/);
    expect((await post(k.secret, { thread_id: jobThreadId, category: "training_reply", body: "Hello", idempotency_key: idem() })).status).toBe(400);
    expect((await post(scout.secret, { thread_id: trainingThreadId, category: "team_internal", body: "Hello", idempotency_key: idem() })).status).toBe(400);
    expect([await rowsIn(teamThreadId), await rowsIn(jobThreadId), await rowsIn(trainingThreadId)]).toEqual(before);
  });

  it("a job thread is the crew chat: a customer message by thread_id is refused 400, and by jobId it is the account-thread draft, still waiting for Approve", async () => {
    // Replaces the W1 test that pinned the defect (an agent post in the crew chat became an outbound email draft to the homeowner).
    // Why: Kyle's "the AI team can talk with us in the field" means the crew chat is a crew post; a customer message goes in the customer's own conversation.
    await rules({ lead_first_response: true, team_internal: true });
    gate(true);
    const k = await crewKey();
    const before = await rowsIn(jobThreadId);
    for (const channel of ["email", "sms"]) {
      const refused = await post(k.secret, { thread_id: jobThreadId, channel, subject: "About your visit", category: "lead_first_response", body: "Crew: the panel is in the garage.", idempotency_key: idem() });
      expect(refused.status, channel).toBe(400);
      expect(JSON.stringify(refused.body)).toMatch(/customer's conversation.*not the crew chat/);
    }
    expect(await rowsIn(jobThreadId)).toBe(before);

    const viaJob = await post(k.secret, customerDraft({ customerId: undefined, jobId: visitId }));
    expect(viaJob.status).toBe(201);
    expect(viaJob.body.status).toBe("pending_approval");
    const row = await prisma.hubMessage.findUniqueOrThrow({ where: { id: viaJob.body.messageId }, include: { thread: true } });
    expect(row.thread.kind).toBe("customer");
    expect(row).toMatchObject({ status: "pending_approval", direction: "outbound", channel: "email", visitId });
    expect(row.sentAt).toBeNull();
    expect(await rowsIn(jobThreadId)).toBe(before);
    nothingSent();
  });

  it("an agent customer draft keeps waiting for Approve with team_internal ON (it is not a team post)", async () => {
    await rules({ team_internal: true });
    gate(true);
    const k = await crewKey();
    const res = await post(k.secret, customerDraft());
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("pending_approval");
    nothingSent();
  });

  it("a key with hub:draft but not team:reply can no longer post in the crew chat (job post = team:reply), but still reads it", async () => {
    const k = await makeKey({ scopes: ["hub:read", "hub:draft"], hubThreadKinds: ["customer", "job"] });
    await tick(k.id, true);
    const before = await rowsIn(jobThreadId);
    expect((await post(k.secret, { thread_id: jobThreadId, body: "x", idempotency_key: idem() })).status).toBe(403);
    expect(await rowsIn(jobThreadId)).toBe(before);
    expect((await request(app).get(`/api/hub/threads/${jobThreadId}/messages`).set(bearer(k.secret))).status).toBe(200);
  });

  it("an idempotent replay of an auto-posted message returns the same final row and sends and announces nothing again", async () => {
    await rules({ team_internal: true });
    gate(true);
    const k = await crewKey();
    const body = { thread_id: teamThreadId, body: "One send only.", idempotency_key: idem() };
    const first = await post(k.secret, body);
    expect(first.status).toBe(201);
    expect(first.body.status).toBe("posted");
    const second = await post(k.secret, body);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    const id = first.body.messageId as string;
    expect(await prisma.hubMessage.count({ where: { threadId: teamThreadId, body: "One send only." } })).toBe(1);
    expect(await prisma.hubAuditLog.count({ where: { messageId: id, action: "message_auto_approved" } })).toBe(1);
    expect(await prisma.hubAuditLog.count({ where: { messageId: id, action: "message_posted" } })).toBe(1);
    expect(announced(id)).toEqual(["posted"]);
  });

  it("a technician's post (a person, not an AI) is never offered to the rule: it is posted by its author, with no rule decision", async () => {
    await rules({ team_internal: true });
    gate(true);
    const res = await request(app).post(`/health-record/hub/threads/${teamThreadId}/messages`).set(bearer(techToken)).send({ body: "Eric here: panel is in.", clientMessageId: `tech-${randomUUID()}` });
    expect(res.status).toBe(201);
    const row = await prisma.hubMessage.findUniqueOrThrow({ where: { id: res.body.data.id } });
    expect(row).toMatchObject({ status: "posted", decidedBy: null, category: null, authorType: "tech" });
    expect(await prisma.hubAuditLog.count({ where: { messageId: row.id, action: "message_auto_approved" } })).toBe(0);
  });
});

describe("the kill switch still governs a key with writes on", () => {
  it("read_only refuses the post (503 agents_read_only) and still answers reads; off refuses both; back On it works again", async () => {
    const k = await makeKey({ scopes: ["hub:read", "hub:draft"] });
    await tick(k.id, true);
    await setSwitch("read_only");
    const before = await prisma.hubMessage.count({ where: { thread: { customerId } } });
    const refused = await post(k.secret, customerDraft());
    expect(refused.status).toBe(503);
    expect(refused.body.code).toBe("agents_read_only");
    expect((await request(app).get("/api/hub/threads").set(bearer(k.secret))).status).toBe(200);

    await setSwitch("off");
    const off = await post(k.secret, customerDraft());
    expect(off.status).toBe(503);
    expect((await request(app).get("/api/hub/threads").set(bearer(k.secret))).status).toBe(503);
    expect(await prisma.hubMessage.count({ where: { thread: { customerId } } })).toBe(before);

    await setSwitch("on");
    expect((await post(k.secret, customerDraft())).status).toBe(201);
  });

  it("a key whose Allow writes was unticked is refused at once, even with the kill switch On", async () => {
    const k = await makeKey({ scopes: ["hub:read", "hub:draft", "team:reply"] });
    await tick(k.id, true);
    expect((await post(k.secret, { thread_id: teamThreadId, body: "one", idempotency_key: idem() })).status).toBe(201);
    await tick(k.id, false);
    const res = await post(k.secret, { thread_id: teamThreadId, body: "two", idempotency_key: idem() });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("writes_disabled");
  });
});
