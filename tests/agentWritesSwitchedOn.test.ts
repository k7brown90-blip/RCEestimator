/**
 * W1 - agent writes switched on (work order "Step 1 review - W1", Kyle 2026-11-22: "I want to start that work" ...
 * "How do I switch it on"). The old lock (AGENT_WRITE_TOOLS_AVAILABLE = false, "Write tools arrive in Phase B")
 * is gone because the first write tool, POST /api/hub/messages (scope hub:draft), shipped in C6. Nothing else
 * turns on by itself: a key keeps writesEnabled false until Kyle ticks "Allow writes" (Settings -> Agent keys), the
 * kill switch still governs. (Kyle 2026-11-24, no check-ins: an agent's customer message is now SENT when posted and a Training post is published;
 * this file's original "every agent post lands as pending_approval" no longer holds, and the tests below say what does.)
 *
 * This file walks the WHOLE path the way Kyle does, through the real routes, not through a hand-built key:
 *   1. a key made on the card (POST /settings/agent-keys) starts with writes OFF and POST /hub/messages answers
 *      403 writes_disabled and writes nothing;
 *   2. PATCH /settings/agent-keys/:id { writesEnabled: true } now SUCCEEDS for Kyle (and a person Kyle gave
 *      bot_keys), and is refused for a person without bot_keys, for the AI admin, and for a revoked key;
 *   3. with writes on and the kill switch On, the key drafts into a customer thread, its Team thread and a group it
 *      is a member of (Kyle 2026-11-24: the customer message is sent at once; a Team post is posted by the key's own box);
 *   4. kill switch read_only and off refuse the post; a group the key is not in is the same 404 as an unknown id;
 *      Scout's posts in a training thread are published (amendment 16b's forced wait is gone, Kyle 2026-11-24);
 *   5. every PATCH is audited ("Agent key changed").
 *
 * W1b (work order "W1b", Kyle 2026-11-22: "I turned these on"): an agent's in-app post followed the auto-send rules Kyle switched on.
 * W2 (Kyle 2026-11-23) CHANGED THAT for Team, group and crew posts: the owner rule "Team post by an AI" and the customer-send env gate
 * no longer decide them. They are published by the author KEY's own "Team posts publish immediately" box (default ON) while Agent access
 * is On: posted at once (decidedBy key:<keyId>, announced ONCE), no 320-character cap, no dollar rule. Box off, or Agent access paused or
 * off, it waits for Approve and the door says why (pending_reason). A Training reply (Scout) is published when posted (Kyle 2026-11-24; this
 * was Kyle's owner rule "Reply in a Training thread", now removed with the Auto-send rules). A job thread is the crew chat: never an email or a text.
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
let savedMaster: string | undefined;
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

// Plan P7 keeps the server-side switch for an AI's customer send (AUTOMATED_CUSTOMER_SENDS_HUB_AUTOSEND, default-deny): on for this file's direct sends.
let savedAgentSendGate: string | undefined;
beforeAll(async () => {
  savedAgentSendGate = process.env.AUTOMATED_CUSTOMER_SENDS_HUB_AUTOSEND;
  process.env.AUTOMATED_CUSTOMER_SENDS_HUB_AUTOSEND = "on";
  savedPin = process.env.PIN_HASH;
  savedPepper = process.env.AGENT_KEY_PEPPER;
  savedEnvName = process.env.RAILWAY_ENVIRONMENT_NAME;
  savedMaster = process.env.AUTOMATED_CUSTOMER_SENDS;
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
  if (savedAgentSendGate === undefined) delete process.env.AUTOMATED_CUSTOMER_SENDS_HUB_AUTOSEND; else process.env.AUTOMATED_CUSTOMER_SENDS_HUB_AUTOSEND = savedAgentSendGate;
  if (savedPin === undefined) delete process.env.PIN_HASH; else process.env.PIN_HASH = savedPin;
  if (savedPepper === undefined) delete process.env.AGENT_KEY_PEPPER; else process.env.AGENT_KEY_PEPPER = savedPepper;
  if (savedEnvName === undefined) delete process.env.RAILWAY_ENVIRONMENT_NAME; else process.env.RAILWAY_ENVIRONMENT_NAME = savedEnvName;
  if (savedMaster === undefined) delete process.env.AUTOMATED_CUSTOMER_SENDS; else process.env.AUTOMATED_CUSTOMER_SENDS = savedMaster;
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
  delete process.env.AUTOMATED_CUSTOMER_SENDS;
  emailSent.calls.length = 0;
  smsSent.calls.length = 0;
  notified.calls.length = 0;
  // W2's agent-to-agent limit (8 AI posts in 10 minutes with no person's post) counts the messages the earlier tests left in these shared
  // threads: age them out so each test starts with a clean count (the limit itself is pinned in agentTeamChatW2.test.ts).
  await prisma.hubMessage.updateMany({
    where: { authorType: { in: ["ai_agent", "claude"] }, threadId: { in: [teamThreadId, jobThreadId, trainingThreadId] } },
    data: { createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000) },
  });
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
    expect(ok.body.status).toBe("sent"); // Kyle 2026-11-24: sent when posted (this said "pending_approval")

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

describe("with writes on and the kill switch On, a customer message is SENT when posted, and a Team post waits only when its key's box is off", () => {
  // Kyle 2026-11-24 ("requiring them to check-in on everything defeats the purpose of the chat"): this test pinned "hub:draft leaves a
  // pending_approval draft ... and nothing is sent". It is now sent through the one sender, by the key, with no approval step.
  it("a customer thread: hub:draft SENDS the message, authored by the key, with no approval step", async () => {
    const k = await makeKey({ scopes: ["hub:read", "hub:draft"] });
    await tick(k.id, true);
    const res = await post(k.secret, customerDraft());
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("sent");
    expect(res.body.pending_reason).toBeNull();
    const row = await prisma.hubMessage.findUniqueOrThrow({ where: { id: res.body.messageId } });
    expect(row).toMatchObject({ status: "sent", authorType: "ai_agent", authorBotKeyId: k.id });
    expect(row.sentAt).not.toBeNull();
    expect(emailSent.calls).toHaveLength(1);
    // A request that asks for any other state is still refused outright, with no row: an agent cannot make a message that is already "approved".
    const before = await prisma.hubMessage.count({ where: { thread: { customerId } } });
    for (const status of ["approved", "sent"]) {
      expect((await post(k.secret, customerDraft({ status }))).status, status).toBe(403);
    }
    expect(await prisma.hubMessage.count({ where: { thread: { customerId } } })).toBe(before);
    expect(emailSent.calls).toHaveLength(1);
  });

  // W2: a key's "Team posts publish immediately" box decides its Team post. A key made on the card starts with it ON.
  it("a Team thread: with the key's Team posts box OFF, team:reply leaves a pending_approval in-app post and says why (pending_reason)", async () => {
    const k = await makeKey({ scopes: ["hub:read", "hub:draft", "team:reply"] });
    await tick(k.id, true);
    expect((await request(app).patch(`/settings/agent-keys/${k.id}`).set(bearer(pin)).send({ teamPostsPublish: false })).status).toBe(200);
    const res = await post(k.secret, { thread_id: teamThreadId, body: "Eric, the Smyrna panel is ordered.", idempotency_key: idem() });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ threadId: teamThreadId, status: "pending_approval", channel: "in_app" });
    expect(res.body.pending_reason).toMatch(/Team posts publish immediately.*off.*waits for a person to approve/);
    const row = await prisma.hubMessage.findUniqueOrThrow({ where: { id: res.body.messageId } });
    expect(row).toMatchObject({ status: "pending_approval", authorType: "ai_agent", direction: "internal" });
    expect(row.decidedBy).toBeNull();
    nothingSent();
  });

  it("a Team thread: a new key's box is ON, so the same post is posted at once with no pending_reason", async () => {
    const k = await makeKey({ scopes: ["hub:read", "hub:draft", "team:reply"] });
    await tick(k.id, true);
    expect((await prisma.agentKey.findUniqueOrThrow({ where: { id: k.id } })).teamPostsPublish).toBe(true);
    const res = await post(k.secret, { thread_id: teamThreadId, body: "Eric, the Smyrna panel is ordered.", idempotency_key: idem() });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ threadId: teamThreadId, status: "posted", channel: "in_app", pending_reason: null });
    nothingSent();
  });

  it("without team:reply the same key is refused in the Team thread (403) and writes no row", async () => {
    const k = await makeKey({ scopes: ["hub:read", "hub:draft"] });
    await tick(k.id, true);
    const before = await rowsIn(teamThreadId);
    expect((await post(k.secret, { thread_id: teamThreadId, body: "x", idempotency_key: idem() })).status).toBe(403);
    expect(await rowsIn(teamThreadId)).toBe(before);
  });

  it("a group the key is a member of: posted (the key's box is ON); a group it is NOT in answers the very same 404 as an id nobody has", async () => {
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
    expect(ok.body).toMatchObject({ threadId: groupId, status: "posted", channel: "in_app" }); // W2: the key's Team posts box is ON

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

  // Kyle 2026-11-24: amendment 16b's forced pending is gone; a Training post is published (a draft is still not an option there).
  it("Scout: a post in a training thread is published even when it asks for 'draft'", async () => {
    const scout = await makeKey({ agentRole: "scout", scopes: ["hub:read", "hub:draft", "training:read", "training:write"], hubThreadKinds: ["training"] });
    await tick(scout.id, true);
    const res = await post(scout.secret, { thread_id: trainingThreadId, body: "Check the neutral first.", status: "draft", idempotency_key: idem() });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("posted");
    expect((await prisma.hubMessage.findUniqueOrThrow({ where: { id: res.body.messageId } })).status).toBe("posted");
    nothingSent();
  });
});

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

describe("W1b + W2: an agent's in-app post is published by its key's Team posts box (a Training reply is published when posted)", () => {
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
  async function expectAutoPosted(k: { id: string; secret: string; name: string }, threadId: string, body: string) {
    const { out: res, events } = await watchBus(() => post(k.secret, { thread_id: threadId, body, idempotency_key: idem() }));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ threadId, status: "posted", channel: "in_app", category: "team_internal", pending_reason: null });
    const row = await prisma.hubMessage.findUniqueOrThrow({ where: { id: res.body.messageId } });
    // W2: approved by the KEY (key:<id>), never by a rule; the audit row names the key.
    expect(row).toMatchObject({ status: "posted", decidedBy: `key:${k.id}`, direction: "internal", channel: "in_app", category: "team_internal", authorType: "ai_agent" });
    expect(row.sentAt).not.toBeNull();
    expect(await prisma.hubAuditLog.count({ where: { messageId: row.id, action: "message_auto_approved", actorKey: `key:${k.id}`, actorDisplay: k.name } })).toBe(1);
    // ONE announcement, of the final row: never the "needs approval" wake for the approvers, and never twice (hubSend already announced it).
    expect(announced(row.id)).toEqual(["posted"]);
    expect(messageEvents(events, row.id)).toHaveLength(1);
    // The decision event an agent hears is a TEAM reply, the same kind a person's Approve of this post reports - never "customer_message".
    expect(row.actionKind).toBe("team_reply");
    await expectDecidedEvent(row.id, "approved", "team_reply");
    nothingSent();
    return res;
  }

  it("key box ON + Agent access On: a post in the key's Team thread is posted at once, decided by key:<id>, announced once", async () => {
    const k = await crewKey();
    await expectAutoPosted(k, teamThreadId, "Eric, the Smyrna panel is ordered.");
  });

  it("key box ON: a post in a group the key is a member of is posted at once", async () => {
    const k = await crewKey();
    await expectAutoPosted(k, await groupWith(k.id), "Noted, thanks.");
  });

  it("key box ON: a post in a job's CREW chat is an in-app post, posted at once (never an email or text to the homeowner)", async () => {
    const k = await crewKey();
    await expectAutoPosted(k, jobThreadId, "Crew: the panel is in the garage.");
  });

  it("key box OFF, or Agent access not On, leaves the post waiting for Approve with a plain reason, announced once as waiting", async () => {
    const k = await crewKey();
    const box = (on: boolean) => request(app).patch(`/settings/agent-keys/${k.id}`).set(bearer(pin)).send({ teamPostsPublish: on });
    expect((await box(false)).status).toBe(200);
    for (const threadId of [teamThreadId, jobThreadId]) {
      notified.calls.length = 0;
      const res = await post(k.secret, { thread_id: threadId, body: "Hold for Approve (box off).", idempotency_key: idem() });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe("pending_approval");
      expect(res.body.pending_reason).toMatch(/Team posts publish immediately.*off/);
      const row = await prisma.hubMessage.findUniqueOrThrow({ where: { id: res.body.messageId } });
      expect(row).toMatchObject({ status: "pending_approval", decidedBy: null, category: "team_internal", channel: "in_app", actionKind: "team_reply" });
      expect(row.sentAt).toBeNull();
      expect(announced(row.id)).toEqual(["pending_approval"]);
      expect(await prisma.hubAuditLog.count({ where: { messageId: row.id, action: "message_auto_approved" } })).toBe(0);
    }
    // Box back on, but the key is re-read on EVERY post: un-ticking it again takes effect on the very next one.
    expect((await box(true)).status).toBe(200);
    expect((await post(k.secret, { thread_id: teamThreadId, body: "Back on.", idempotency_key: idem() })).body.status).toBe("posted");
    expect((await box(false)).status).toBe(200);
    expect((await post(k.secret, { thread_id: teamThreadId, body: "Off again.", idempotency_key: idem() })).body.status).toBe("pending_approval");
    nothingSent();
  });

  it("the kill switch overrides the box: while Agent access is read_only the door refuses the post, and a post offered while it is not On is never published", async () => {
    const k = await crewKey();
    await setSwitch("read_only");
    const refused = await post(k.secret, { thread_id: teamThreadId, body: "Paused.", idempotency_key: idem() });
    expect(refused.status).toBe(503);
    expect(refused.body.code).toBe("agents_read_only");
    await setSwitch("on");
    // The decision itself fails closed too: publishTeamPost re-reads Agent access, so a post offered while it is not On waits.
    const { publishTeamPost } = await import("../src/services/hubAgentSend");
    const waiting = await prisma.hubMessage.findUniqueOrThrow({ where: { id: (await post(k.secret, { thread_id: teamThreadId, body: "Held by the decision.", status: "draft", idempotency_key: idem() })).body.messageId } });
    await prisma.hubMessage.update({ where: { id: waiting.id }, data: { status: "pending_approval" } });
    await setSwitch("read_only");
    expect(await publishTeamPost(waiting.id)).toMatchObject({ published: false, why: expect.stringMatching(/Agent access is not On/) });
    await setSwitch("off");
    expect(await publishTeamPost(waiting.id)).toMatchObject({ published: false, why: expect.stringMatching(/Agent access is not On/) });
    expect((await prisma.hubMessage.findUniqueOrThrow({ where: { id: waiting.id } })).status).toBe("pending_approval");
    await setSwitch("on");
    expect(await publishTeamPost(waiting.id)).toMatchObject({ published: true, send: { status: "posted" } });
  });

  it("a revoked key's post is never published by its box", async () => {
    const k = await crewKey();
    const { publishTeamPost } = await import("../src/services/hubAgentSend");
    const made = await post(k.secret, { thread_id: teamThreadId, body: "Before revoke.", status: "draft", idempotency_key: idem() });
    await prisma.hubMessage.update({ where: { id: made.body.messageId }, data: { status: "pending_approval" } });
    await prisma.agentKey.update({ where: { id: k.id }, data: { revokedAt: new Date() } });
    expect(await publishTeamPost(made.body.messageId)).toMatchObject({ published: false, why: expect.stringMatching(/revoked/) });
  });

  it("a draft the agent asks for ('draft') is never offered to the auto-publish step, even with the key's box ON", async () => {
    const k = await crewKey();
    const res = await post(k.secret, { thread_id: teamThreadId, status: "draft", body: "Not ready yet.", idempotency_key: idem() });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("draft");
    const row = await prisma.hubMessage.findUniqueOrThrow({ where: { id: res.body.messageId } });
    expect(row).toMatchObject({ status: "draft", decidedBy: null });
    expect(await prisma.hubAuditLog.count({ where: { messageId: row.id, action: "message_auto_approved" } })).toBe(0);
  });

  // Kyle 2026-11-24: this pinned "stays pending_approval even with the rule ON". There is no rule and no wait: a Training post is published, a draft
  // asked for there included (it was never an option in a Training thread).
  it("a Scout Training post that asks for a draft is published like any other (no draft in a Training thread, no rule)", async () => {
    const scout = await makeKey({ agentRole: "scout", scopes: ["hub:read", "hub:draft", "training:read", "training:write"], hubThreadKinds: ["training"] });
    await tick(scout.id, true);
    const res = await post(scout.secret, { thread_id: trainingThreadId, status: "draft", body: "Not ready yet, still checking.", idempotency_key: idem() });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("posted");
    const row = await prisma.hubMessage.findUniqueOrThrow({ where: { id: res.body.messageId } });
    expect(row).toMatchObject({ status: "posted", category: "training_reply" });
    expect(announced(row.id)).toEqual(["posted"]);
    nothingSent();
  });

  it("W2: a long team post and one with a dollar amount are posted too: no 320-character cap and no price rule (CFO and Inventory talk money)", async () => {
    const k = await crewKey();
    const long = await post(k.secret, { thread_id: teamThreadId, body: "x".repeat(2_000), idempotency_key: idem() });
    expect(long.status).toBe(201);
    expect(long.body.status).toBe("posted");
    const priced = await post(k.secret, { thread_id: teamThreadId, body: "The Smyrna panel job invoiced at $4,250.", idempotency_key: idem() });
    expect(priced.body.status).toBe("posted");
  });

  it("Scout: a Training post is posted at once, announced once, with no rule and no gate (Kyle 2026-11-24)", async () => {
    const scout = await makeKey({ agentRole: "scout", scopes: ["hub:read", "hub:draft", "training:read", "training:write"], hubThreadKinds: ["training"] });
    await tick(scout.id, true);
    const { out: sent, events } = await watchBus(() => post(scout.secret, { thread_id: trainingThreadId, body: "Check the neutral first.", idempotency_key: idem() }));
    expect(sent.status).toBe(201);
    expect(sent.body).toMatchObject({ status: "posted", category: "training_reply", pending_reason: null });
    const row = await prisma.hubMessage.findUniqueOrThrow({ where: { id: sent.body.messageId } });
    expect(row).toMatchObject({ status: "posted", authorBotKeyId: scout.id });
    expect(announced(row.id)).toEqual(["posted"]);
    expect(messageEvents(events, row.id)).toHaveLength(1);
    nothingSent();
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

  it("a job thread is the crew chat: a customer message by thread_id is refused 400, and by jobId it is sent from the account thread", async () => {
    // Replaces the W1 test that pinned the defect (an agent post in the crew chat became an outbound email draft to the homeowner).
    // Why: Kyle's "the AI team can talk with us in the field" means the crew chat is a crew post; a customer message goes in the customer's own conversation.
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
    expect(viaJob.body.status).toBe("sent"); // Kyle 2026-11-24: sent when posted (this said "pending_approval")
    const row = await prisma.hubMessage.findUniqueOrThrow({ where: { id: viaJob.body.messageId }, include: { thread: true } });
    expect(row.thread.kind).toBe("customer");
    expect(row).toMatchObject({ status: "sent", direction: "outbound", channel: "email", visitId });
    expect(row.sentAt).not.toBeNull();
    expect(await rowsIn(jobThreadId)).toBe(before);
    expect(emailSent.calls).toHaveLength(1);
  });

  it("an agent customer message is decided by the send guards, not by the key's Team posts box (it is not a team post): box OFF, it still sends", async () => {
    const k = await crewKey();
    await request(app).patch(`/settings/agent-keys/${k.id}`).set(bearer(pin)).send({ teamPostsPublish: false });
    const res = await post(k.secret, customerDraft());
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("sent");
    expect(res.body.pending_reason).toBeNull();
    expect(emailSent.calls).toHaveLength(1);
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

  it("a technician's post (a person, not an AI) is never offered to the key's box: it is posted by its author, with no decision", async () => {
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
