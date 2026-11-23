/**
 * W2-C (Kyle 2026-11-23, items 4 and 5): "on every new team-thread message, send an event to every agent whose key can read that thread
 * (per-agent webhook URL, custom Authorization header, and signing secret in Settings) ... @mentions mark who should answer. Everyone with
 * access still gets the event, but only mentioned agents reply. With no mention, Admin answers and routes. Loop guard: never send an agent
 * its own post back."
 *
 * Kyle's test plan line 1, end to end against real receivers: Kyle posts "@Inventory test" in his Team thread -> one signed message.team row
 * per agent role whose live key can read Team, each with the full text, mentions ['inventory'] and reply_expected true for Inventory alone;
 * Inventory's reply, posted through the door (Team posts publish immediately), fans out to every reader EXCEPT Inventory with reply_expected
 * false for all (it mentions nobody) and is readable by the field app's tech thread read.
 *
 * Also pinned: no mention from a person -> Admin alone is expected; an agent mentioning @Admin -> Admin alone; an agent's own role never gets
 * its own post, including the edit-approved copy of its draft (which is NOT a person's message for mentions); a role whose key lacks the read
 * scope, a revoked, expired or retired key and a key of the other environment get nothing; two live keys of one role are one row; a group
 * wakes only its member keys; a job crew chat wakes hub:read keys too; customer messages keep their single target and message.dev keeps no
 * body; a receiver with no address gets a visible no_target row; Claude Code gets no webhook; one row per target per message however many
 * times a message is announced; every wire body verifies by the receiver recipe from the body alone.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { createHmac, randomUUID } from "node:crypto";

process.env.GOOGLE_CLIENT_ID = "test_id";
process.env.GOOGLE_CLIENT_SECRET = "test_secret";
process.env.GOOGLE_REFRESH_TOKEN = "test_token";
delete process.env.OPENAI_API_KEY;
delete process.env.STRIPE_SECRET_KEY;
vi.mock("stripe", () => ({ default: class MockStripe { constructor() { throw new Error("Stripe must not be constructed in tests"); } } }));
vi.mock("../src/services/twilio", () => ({
  sendSms: vi.fn().mockResolvedValue({ sid: "SM_mock" }),
  KYLE_PHONE: "+19706661626",
  isFromKyle: vi.fn().mockReturnValue(false),
  fetchTwilioMedia: vi.fn().mockResolvedValue(null),
}));
vi.mock("googleapis", () => {
  class MockOAuth2 { setCredentials() {} }
  return { google: { auth: { OAuth2: MockOAuth2 }, calendar: () => ({ freebusy: { query: vi.fn() }, events: { list: vi.fn(), delete: vi.fn() } }) } };
});
vi.mock("../src/services/confirmationEmail", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/services/confirmationEmail")>();
  return { ...mod, sendBrandedEmail: vi.fn().mockResolvedValue(true), sendKyleNotificationEmail: vi.fn().mockResolvedValue(undefined) };
});

import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { hashPin } from "../src/middleware/pinAuth";
import { mintAgentKey } from "../src/agentApi/keys";
import { fanOutMessage } from "../src/services/hub";
import { deliverDueEvents, emitTeamMessageEvents, receivingRolesFor } from "../src/services/hubEvents";
import { splitWireBody, HUB_WEBHOOK_TARGET_IDS, type HubWebhookTargetId } from "../shared/hub/events";
import { AGENT_ROLES, type AgentRole } from "../shared/agentScopes";

vi.setConfig({ testTimeout: 30_000 }); // eight key mints (each hashed) and a real receiver per test
const TAG = "FanOut";
const PIN = "1234";
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const idem = () => `idem-${randomUUID()}`;
const SEND_ROLES = HUB_WEBHOOK_TARGET_IDS as readonly HubWebhookTargetId[];

interface Hit { role: string; headers: http.IncomingHttpHeaders; body: string }
let hits: Hit[] = [];
/** approval.decided (the key-published Team post is auto-approved, which tells Admin as it always did) is kept apart: it is not what these tests count. */
let decided: Hit[] = [];
let server: http.Server;
let baseUrl = "";
const secrets: Partial<Record<HubWebhookTargetId, string>> = {};

let savedPin: string | undefined;
let savedPepper: string | undefined;
let savedEnvName: string | undefined;
let savedUrl: string | undefined;
let savedSecret: string | undefined;
let kyle = "";
let techId = "";
let techToken = "";
let teamThreadId = "";
let jobThreadId = "";
let customerId = "";
let visitId = "";
let customerThreadId = "";
const keyIds: string[] = [];

type Made = { id: string; secret: string; name: string; role: AgentRole };
async function keyFor(role: AgentRole, over: { scopes?: string[]; hubThreadKinds?: string[]; writesEnabled?: boolean; teamPostsPublish?: boolean; environment?: "live" | "test"; retiresAt?: Date | null; expiresAt?: Date | null } = {}): Promise<Made> {
  const name = `${TAG} ${role} ${randomUUID().slice(0, 5)}`;
  const made = await mintAgentKey({ name, agentRole: role, createdBy: "owner", writesEnabled: over.writesEnabled ?? true, ...over });
  keyIds.push(made.row.id);
  return { id: made.row.id, secret: made.key, name, role };
}
/** One live key per webhook role, with the role's default scopes (what the Agent keys card prefills). */
async function allReaders(): Promise<Record<string, Made>> {
  const out: Record<string, Made> = {};
  for (const role of SEND_ROLES) out[role] = await keyFor(role);
  return out;
}

const rowsFor = (messageId: string) => prisma.hubEvent.findMany({ where: { type: "message.team", payloadJson: { contains: `"message_id":"${messageId}"` } }, orderBy: { target: "asc" } });
const settle = (ms = 350) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn: () => boolean | Promise<boolean>, ms = 6000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timed out waiting");
};
/** What a receiver that strips every custom header can still do: cut the body at the last `,"timestamp":`, add `}`, check the HMAC. */
function verifyBodyOnly(body: string, secret: string): boolean {
  const wire = splitWireBody(body);
  if (!wire) return false;
  return wire.signature === `sha256=${createHmac("sha256", secret).update(`${wire.timestamp}.${wire.payloadJson}`).digest("hex")}`;
}
const payloadOf = (h: Hit) => JSON.parse(h.body) as Record<string, unknown>;
const byRole = (messageId: string) => Object.fromEntries(hits.filter((h) => payloadOf(h).message_id === messageId).map((h) => [h.role, payloadOf(h)]));
const rolesOf = (messageId: string) => Object.keys(byRole(messageId)).sort();
const ALL_ROLES = [...SEND_ROLES].sort();

/** A person (the technician) posts in his Team thread through the field route. */
const techPost = (body: string) => request(app).post(`/health-record/hub/threads/${teamThreadId}/messages`).set(bearer(techToken)).send({ body, clientMessageId: `tech-${randomUUID()}` });
const door = (secret: string, body: Record<string, unknown>) => request(app).post("/api/hub/messages").set(bearer(secret)).send({ idempotency_key: idem(), ...body });

/** A posted message made directly (a person's or an agent's), then announced through the ONE fan-out call site. */
async function say(threadId: string, who: { agent?: Made; person?: boolean; aiAdmin?: boolean }, body: string, over: Record<string, unknown> = {}) {
  const thread = await prisma.hubThread.findUniqueOrThrow({ where: { id: threadId } });
  const base = { threadId, channel: "in_app", direction: "internal", status: "posted", body, ...over };
  const msg = await prisma.hubMessage.create({
    data: who.agent
      ? { ...base, authorType: who.agent.role === "claude_code" ? "claude" : "ai_agent", authorKey: `key:${who.agent.id}`, authorBotKeyId: who.agent.id, authorDisplay: who.agent.name }
      : who.aiAdmin
        ? { ...base, authorType: "ai_agent", authorKey: "ai-admin", authorDisplay: "AI admin" }
        : { ...base, authorType: "tech", authorKey: `tech:${techId}`, authorTechnicianId: techId, authorDisplay: "Eric Ward" },
  } as never);
  fanOutMessage(msg, thread);
  return msg;
}

async function setTargets(over: Partial<Record<HubWebhookTargetId, { url: string | null; enabled?: boolean }>> = {}) {
  await request(app).put("/owner-settings/agentWebhooks").set(bearer(kyle)).send({
    targets: SEND_ROLES.map((id) => ({ id, url: over[id] ? over[id]!.url : `${baseUrl}/hook/${id}`, enabled: over[id]?.enabled ?? true })), routes: {},
  }).expect(200);
}

beforeAll(async () => {
  savedPin = process.env.PIN_HASH;
  savedPepper = process.env.AGENT_KEY_PEPPER;
  savedEnvName = process.env.RAILWAY_ENVIRONMENT_NAME;
  savedUrl = process.env.HUB_AGENT_WEBHOOK_URL;
  savedSecret = process.env.HUB_WEBHOOK_SECRET;
  process.env.PIN_HASH = await hashPin(PIN);
  process.env.AGENT_KEY_PEPPER = "test-pepper-for-the-w2c-fan-out-suite";
  delete process.env.RAILWAY_ENVIRONMENT_NAME;
  delete process.env.HUB_AGENT_WEBHOOK_URL;
  delete process.env.HUB_WEBHOOK_SECRET;

  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const hit = { role: (req.url ?? "").split("/").pop() ?? "", headers: req.headers, body };
      if ((JSON.parse(body) as { type?: string }).type === "approval.decided") decided.push(hit); else hits.push(hit);
      res.statusCode = 200;
      res.end("ok");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  kyle = (await request(app).post("/auth/pin").send({ pin: PIN })).body.token as string;
  await prisma.companySetting.deleteMany({ where: { key: { in: ["agentWebhooks", "agentAccess"] } } });
  await setTargets();
  for (const id of SEND_ROLES) secrets[id] = (await request(app).post(`/hub/webhooks/${id}/signing-secret`).set(bearer(kyle)).expect(200)).body.secret as string;

  const customer = await prisma.customer.create({
    data: {
      name: `${TAG} Jane Homeowner`, email: `${TAG.toLowerCase()}@homeowner.example`,
      properties: { create: { name: "Home", addressLine1: "88 Cedar Hollow Court", city: "Smyrna", state: "TN", postalCode: "37167" } },
    },
  });
  customerId = customer.id;
  const property = await prisma.property.findFirstOrThrow({ where: { customerId } });
  const visit = await prisma.visit.create({ data: { customerId, propertyId: property.id, mode: "service_diagnostic", purpose: `${TAG} job`, status: "contracted" } });
  visitId = visit.id;
  jobThreadId = (await prisma.hubThread.create({ data: { kind: "job", title: `${TAG} crew chat`, visitId } })).id;
  customerThreadId = (await prisma.hubThread.create({ data: { kind: "customer", title: `${TAG} Jane thread`, customerId } })).id;
  const tech = await prisma.technician.create({ data: { name: "Eric Ward", accessToken: `${TAG}-tok-${randomUUID()}`, isActive: true } });
  techId = tech.id;
  techToken = tech.accessToken;
  teamThreadId = (await prisma.hubThread.create({ data: { kind: "team", title: `${TAG} Eric team`, technicianId: techId } })).id;
});

afterAll(async () => {
  const restore = (k: string, v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
  restore("PIN_HASH", savedPin);
  restore("AGENT_KEY_PEPPER", savedPepper);
  restore("RAILWAY_ENVIRONMENT_NAME", savedEnvName);
  restore("HUB_AGENT_WEBHOOK_URL", savedUrl);
  restore("HUB_WEBHOOK_SECRET", savedSecret);
  await new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
  await prisma.hubEventAttempt.deleteMany();
  await prisma.hubEvent.deleteMany();
  await prisma.companySetting.deleteMany({ where: { key: { in: ["agentWebhooks", "agentAccess"] } } });
  await prisma.hubThread.deleteMany({ where: { OR: [{ customerId }, { title: { startsWith: TAG } }] } });
  await prisma.agentIdempotency.deleteMany({ where: { agentKeyId: { in: keyIds } } });
  await prisma.agentKey.deleteMany({ where: { id: { in: keyIds } } });
  await prisma.visit.deleteMany({ where: { customerId } });
  await prisma.property.deleteMany({ where: { customerId } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
  await prisma.technician.deleteMany({ where: { id: techId } });
});

beforeEach(async () => {
  await settle(80); // anything a previous test left on the wire
  hits = [];
  decided = [];
  await prisma.hubEventAttempt.deleteMany();
  await prisma.hubEvent.deleteMany();
  await prisma.agentIdempotency.deleteMany({ where: { agentKeyId: { in: keyIds } } });
  await prisma.agentKey.deleteMany({ where: { id: { in: keyIds.splice(0) } } });
  await prisma.hubMessage.deleteMany({ where: { threadId: { in: [teamThreadId, jobThreadId, customerThreadId] } } });
  await prisma.hubThread.deleteMany({ where: { title: { startsWith: `${TAG} group` } } });
  await prisma.companySetting.deleteMany({ where: { key: "agentAccess" } });
  await setTargets();
});

// ── Kyle's test plan, line 1 ─────────────────────────────────────────────────────────────────────

describe("Kyle's test plan: '@Inventory test' in the Team thread", () => {
  it("sends a signed event with the full text to every agent whose key reads Team, expecting only Inventory to reply; Inventory's reply goes to everyone else and shows in the field app", async () => {
    const keys = await allReaders();
    const res = await techPost("@Inventory test");
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const messageId = res.body.data.id as string;
    await waitFor(() => hits.length === SEND_ROLES.length);
    expect(rolesOf(messageId)).toEqual(ALL_ROLES);

    // One HubEvent row per role, one shared eventKey, each with its own event_id.
    const rows = await rowsFor(messageId);
    expect(rows).toHaveLength(SEND_ROLES.length);
    expect(new Set(rows.map((r) => r.eventKey)).size).toBe(1);
    expect(new Set(rows.map((r) => r.id)).size).toBe(SEND_ROLES.length);
    expect(rows.map((r) => r.target).sort()).toEqual(ALL_ROLES);
    for (const h of hits) {
      const p = payloadOf(h);
      expect(p, h.role).toMatchObject({
        type: "message.team", message_id: messageId, thread_id: teamThreadId, thread_kind: "team", text: "@Inventory test", mentions: ["inventory"],
        author_type: "person", author_name: "Eric", author_id: techId, author_agent: null, summary: "New team message",
        reply_expected: h.role === "inventory",
      });
      // Signed with THAT agent's own secret, verifiable from the body alone and from the headers.
      expect(verifyBodyOnly(h.body, secrets[h.role as HubWebhookTargetId]!), h.role).toBe(true);
      expect(h.headers["x-rce-signature"]).toBe(p.signature);
      expect(h.headers["x-rce-timestamp"]).toBe(p.timestamp);
      expect(h.headers["x-rce-event-id"]).toBe(p.event_id);
      expect(verifyBodyOnly(h.body, secrets[h.role === "admin" ? "inventory" : "admin"]!), `${h.role} with another agent's secret`).toBe(false);
    }

    // Inventory answers through the door: Team posts publish immediately, so it is posted at once.
    hits = [];
    const reply = await door(keys.inventory.secret, { thread_id: teamThreadId, body: "On it: the truck has 6 breakers." });
    expect(reply.status, JSON.stringify(reply.body)).toBe(201);
    expect(reply.body.status).toBe("posted");
    const replyId = reply.body.messageId as string;
    await waitFor(() => hits.length === SEND_ROLES.length - 1);
    expect(rolesOf(replyId)).toEqual(ALL_ROLES.filter((r) => r !== "inventory"));
    for (const h of hits) {
      expect(payloadOf(h), h.role).toMatchObject({
        text: "On it: the truck has 6 breakers.", mentions: [], reply_expected: false, author_type: "agent", author_kind: "ai_agent",
        author_agent: "inventory", author_name: keys.inventory.name, author_id: null,
      });
    }
    // Admin was also told, as ever, that the key-published post was approved (approval.decided is a separate event, routed to Admin).
    expect(decided.map((d) => d.role)).toEqual(["admin"]);
    // It is readable by the field app's own thread read (posted, in-app, internal).
    const fieldRead = await request(app).get(`/health-record/hub/threads/${teamThreadId}/messages`).set(bearer(techToken));
    expect(fieldRead.status, JSON.stringify(fieldRead.body)).toBe(200);
    expect(JSON.stringify(fieldRead.body)).toContain("On it: the truck has 6 breakers.");
  });

  it("a person's message with NO mention expects Admin alone to answer", async () => {
    await allReaders();
    const res = await techPost("Panel is set on the Smyrna job.");
    const messageId = res.body.data.id as string;
    await waitFor(() => hits.length === SEND_ROLES.length);
    const got = byRole(messageId);
    for (const role of SEND_ROLES) expect(got[role], role).toMatchObject({ mentions: [], reply_expected: role === "admin" });
  });

  it("a person's message mentioning only @Coding expects nobody on the webhook side: Admin is not expected, Claude Code gets no webhook", async () => {
    await allReaders();
    await keyFor("claude_code");
    const res = await techPost("@Coding add a comment to README saying hub test");
    const messageId = res.body.data.id as string;
    await waitFor(() => hits.length === SEND_ROLES.length);
    await settle();
    expect(hits).toHaveLength(SEND_ROLES.length);
    const got = byRole(messageId);
    for (const role of SEND_ROLES) expect(got[role], role).toMatchObject({ mentions: ["claude_code"], reply_expected: false });
    expect(await rolesOf(messageId)).not.toContain("claude_code");
    expect((await rowsFor(messageId)).map((r) => r.target)).not.toContain("claude_code");
  });
});

// ── agents' own posts, the loop guard ────────────────────────────────────────────────────────────

describe("an agent's posted message", () => {
  it("mentioning @Admin expects Admin alone, and never goes back to its own role", async () => {
    const keys = await allReaders();
    const msg = await say(teamThreadId, { agent: keys.facebook }, "@Admin the ad is live, please log it.");
    await waitFor(() => hits.length === SEND_ROLES.length - 1);
    await settle();
    expect(rolesOf(msg.id)).toEqual(ALL_ROLES.filter((r) => r !== "facebook"));
    const got = byRole(msg.id);
    for (const [role, p] of Object.entries(got)) expect(p, role).toMatchObject({ mentions: ["admin"], reply_expected: role === "admin", author_agent: "facebook", author_type: "agent" });
  });

  it("mentioning nobody expects nobody (no Admin fallback, so the team cannot start answering itself)", async () => {
    const keys = await allReaders();
    const msg = await say(teamThreadId, { agent: keys.cfo }, "Q3 invoices are all paid.");
    await waitFor(() => hits.length === SEND_ROLES.length - 1);
    for (const p of Object.values(byRole(msg.id))) expect(p).toMatchObject({ mentions: [], reply_expected: false });
  });

  it("mentioning its OWN role gives it nothing back (loop guard beats the mention)", async () => {
    const keys = await allReaders();
    const msg = await say(teamThreadId, { agent: keys.inventory }, "@Inventory remember to count the truck.");
    await waitFor(() => hits.length === SEND_ROLES.length - 1);
    expect(rolesOf(msg.id)).not.toContain("inventory");
  });

  it("an agent's post in a team chat is announced by the one fan-out only once it is posted: a draft waiting for approval wakes nobody", async () => {
    const keys = await allReaders();
    const waiting = await say(teamThreadId, { agent: keys.admin }, "@Inventory pending draft", { status: "pending_approval" });
    await settle();
    expect(hits).toHaveLength(0);
    expect(await rowsFor(waiting.id)).toHaveLength(0);
  });

  // W2-C review (Kyle 2026-11-23 item 5, "never send an agent its own post back"): the AI admin session is the Admin agent's own login to the
  // CRM. Its post has no AgentKey, but it IS Admin's words, so Admin is not sent it back (this test used to expect every reader, Admin too).
  it("the AI admin session's post (an AI author with no key) wakes every reader EXCEPT Admin, whose own words it is, and expects nobody", async () => {
    await allReaders();
    const msg = await say(teamThreadId, { aiAdmin: true }, "Heads up from the AI admin.");
    await waitFor(() => hits.length === SEND_ROLES.length - 1);
    await settle();
    expect(rolesOf(msg.id)).toEqual(ALL_ROLES.filter((r) => r !== "admin"));
    expect((await rowsFor(msg.id)).map((r) => r.target)).not.toContain("admin");
    for (const p of Object.values(byRole(msg.id))) expect(p).toMatchObject({ author_type: "agent", author_kind: "ai_agent", author_agent: "admin", reply_expected: false });
  });

  it("an edit-approved copy of an AI admin post still counts as Admin's words (no Admin event, author_agent admin)", async () => {
    await allReaders();
    const original = await prisma.hubMessage.create({
      data: { threadId: teamThreadId, authorType: "ai_agent", authorKey: "ai-admin", authorDisplay: "AI admin", channel: "in_app", direction: "internal", status: "posted", body: "first words" },
    });
    const copy = await say(teamThreadId, { person: true }, "@Inventory edited words", { editedFromId: original.id });
    await waitFor(() => hits.length >= SEND_ROLES.length - 1);
    await settle();
    expect(rolesOf(copy.id)).toEqual(ALL_ROLES.filter((r) => r !== "admin"));
    for (const [role, p] of Object.entries(byRole(copy.id))) expect(p, role).toMatchObject({ author_type: "agent", author_agent: "admin", reply_expected: role === "inventory" });
  });

  it("an agent's post in a Dev or customer conversation still wakes nobody", async () => {
    const keys = await allReaders();
    const dev = await prisma.hubThread.create({ data: { kind: "dev", title: `${TAG} dev` } });
    await say(dev.id, { agent: keys.claude_code ?? keys.admin }, "dev reply");
    await say(customerThreadId, { agent: keys.admin }, "to the customer thread");
    await settle();
    expect(hits).toHaveLength(0);
    expect(await prisma.hubEvent.count({ where: { type: "message.team" } })).toBe(0);
    await prisma.hubThread.deleteMany({ where: { id: dev.id } });
  });
});

describe("the edit-approved copy of an agent's draft (W2-C, map-approvals C5)", () => {
  async function draftBy(agent: Made, body: string) {
    // Team posts publish immediately is OFF for this key, so the post waits for a person.
    const res = await door(agent.secret, { thread_id: teamThreadId, body });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.status).toBe("pending_approval");
    return res.body.messageId as string;
  }

  it("counts as written by the ORIGINAL agent: it never wakes that agent, its mentions come from the agent's words, and no Admin fallback applies", async () => {
    const keys = await allReaders();
    const admin = await keyFor("admin", { teamPostsPublish: false });
    const draftId = await draftBy(admin, "Hold on, drafting.");
    const edit = await request(app).post(`/hub/messages/${draftId}/edit-approve`).set(bearer(kyle)).send({ body: "@Inventory please check the Smyrna order." });
    expect(edit.status, JSON.stringify(edit.body)).toBe(200);
    const copyId = edit.body.card.id as string;
    const copy = await prisma.hubMessage.findUniqueOrThrow({ where: { id: copyId } });
    // The copy is re-authored as the approver, linked back to the agent's original...
    expect(copy).toMatchObject({ authorType: "office", editedFromId: draftId, status: "posted" });
    await waitFor(() => hits.length >= SEND_ROLES.length - 1);
    await settle();
    // ...but it wakes the agents as the ORIGINAL agent's words: not Admin's own role (the loop guard), only Inventory expected to reply.
    expect(rolesOf(copyId)).toEqual(ALL_ROLES.filter((r) => r !== "admin"));
    for (const [role, p] of Object.entries(byRole(copyId))) {
      expect(p, role).toMatchObject({
        text: "@Inventory please check the Smyrna order.", mentions: ["inventory"], reply_expected: role === "inventory",
        author_type: "agent", author_kind: "ai_agent", author_agent: "admin", author_name: admin.name, author_id: null,
      });
    }
    void keys;
  });

  it("an edited copy with NO mention does not make Admin answer: it is not Kyle's message", async () => {
    await allReaders();
    const facebook = await keyFor("facebook", { teamPostsPublish: false });
    const draftId = await draftBy(facebook, "draft");
    const edit = await request(app).post(`/hub/messages/${draftId}/edit-approve`).set(bearer(kyle)).send({ body: "The new ad copy is approved." });
    expect(edit.status).toBe(200);
    const copyId = edit.body.card.id as string;
    await waitFor(() => hits.length >= SEND_ROLES.length - 1);
    for (const p of Object.values(byRole(copyId))) expect(p).toMatchObject({ reply_expected: false, mentions: [] });
    expect(rolesOf(copyId)).not.toContain("facebook");
  });

  it("an unedited Approve of an agent's draft announces the agent's own message the same way (never back to its role)", async () => {
    await allReaders();
    const cfo = await keyFor("cfo", { teamPostsPublish: false });
    const draftId = await draftBy(cfo, "@Admin please look at invoice 1042");
    const approve = await request(app).post(`/hub/messages/${draftId}/approve`).set(bearer(kyle)).send({});
    expect(approve.status, JSON.stringify(approve.body)).toBe(200);
    await waitFor(() => hits.length >= SEND_ROLES.length - 1);
    await settle();
    expect(rolesOf(draftId)).toEqual(ALL_ROLES.filter((r) => r !== "cfo"));
    expect(byRole(draftId).admin).toMatchObject({ reply_expected: true, author_agent: "cfo" });
  });
});

// ── who counts as a receiver ─────────────────────────────────────────────────────────────────────

describe("which keys count as 'can read this thread'", () => {
  it("a role whose key lacks Team read gets nothing (hub:read alone opens customer and crew chat, not Team)", async () => {
    await keyFor("admin");
    await keyFor("facebook", { scopes: ["hub:read", "marketing:read"] });
    const msg = await say(teamThreadId, { person: true }, "Team only.");
    await waitFor(() => hits.length === 1);
    await settle();
    expect(rolesOf(msg.id)).toEqual(["admin"]);
    expect((await rowsFor(msg.id)).map((r) => r.target)).toEqual(["admin"]);
  });

  it("team:reply alone still reads the Team chat (the older key keeps hearing it)", async () => {
    await keyFor("scout", { scopes: ["team:reply"] });
    const msg = await say(teamThreadId, { person: true }, "Scout, you there?");
    await waitFor(() => hits.length === 1);
    expect(rolesOf(msg.id)).toEqual(["scout"]);
  });

  it("a key limited by hubThreadKinds to other kinds gets nothing", async () => {
    await keyFor("research", { hubThreadKinds: ["training"] });
    await keyFor("admin");
    const msg = await say(teamThreadId, { person: true }, "Kinds.");
    await waitFor(() => hits.length === 1);
    await settle();
    expect(rolesOf(msg.id)).toEqual(["admin"]);
  });

  it("revoked, expired and retired keys do not count", async () => {
    const revoked = await keyFor("inventory");
    await prisma.agentKey.update({ where: { id: revoked.id }, data: { revokedAt: new Date() } });
    await keyFor("cfo", { expiresAt: new Date(Date.now() - 60_000) });
    await keyFor("research", { retiresAt: new Date(Date.now() - 60_000) });
    await keyFor("nec_coach", { retiresAt: new Date(Date.now() + 3_600_000) }); // still in its grace window: counts
    const msg = await say(teamThreadId, { person: true }, "Who is live?");
    await waitFor(() => hits.length === 1);
    await settle();
    expect(rolesOf(msg.id)).toEqual(["nec_coach"]);
  });

  it("a key minted for the other environment cannot authenticate here, so it hears nothing", async () => {
    await keyFor("scout", { environment: "live" });
    await keyFor("admin");
    const msg = await say(teamThreadId, { person: true }, "Env.");
    await waitFor(() => hits.length === 1);
    await settle();
    expect(rolesOf(msg.id)).toEqual(["admin"]);
  });

  it("two live keys of one role (a rotation's grace window) are ONE event", async () => {
    await keyFor("inventory");
    await keyFor("inventory", { retiresAt: new Date(Date.now() + 3_600_000) });
    const msg = await say(teamThreadId, { person: true }, "Rotating.");
    await waitFor(() => hits.length >= 1);
    await settle();
    expect(hits.filter((h) => h.role === "inventory")).toHaveLength(1);
    expect(await rowsFor(msg.id)).toHaveLength(1);
  });

  it("Claude Code and Other are never receivers, whatever their scopes", async () => {
    await keyFor("claude_code");
    await keyFor("other", { scopes: ["team:read", "team:reply"] });
    const thread = await prisma.hubThread.findUniqueOrThrow({ where: { id: teamThreadId } });
    expect(await receivingRolesFor(thread)).toEqual([]);
    const msg = await say(teamThreadId, { person: true }, "Nobody here.");
    await settle();
    expect(await rowsFor(msg.id)).toHaveLength(0);
    expect(hits).toHaveLength(0);
  });

  it("the order of roles follows the Agent webhooks card", async () => {
    for (const role of [...SEND_ROLES].reverse()) await keyFor(role);
    const thread = await prisma.hubThread.findUniqueOrThrow({ where: { id: teamThreadId } });
    expect(await receivingRolesFor(thread)).toEqual([...SEND_ROLES]);
    expect([...AGENT_ROLES].filter((r) => (SEND_ROLES as readonly string[]).includes(r))).toHaveLength(SEND_ROLES.length);
  });
});

describe("group and crew chats", () => {
  it("a group wakes only the roles whose key is a MEMBER of it (and can read groups)", async () => {
    const admin = await keyFor("admin");
    await keyFor("inventory"); // can read groups, but is not in this one
    const cfo = await keyFor("cfo");
    const group = await prisma.hubThread.create({ data: { kind: "group", title: `${TAG} group A` } });
    await prisma.hubThreadMember.createMany({ data: [{ threadId: group.id, addedBy: "owner", agentKeyId: admin.id }, { threadId: group.id, addedBy: "owner", agentKeyId: cfo.id }, { threadId: group.id, addedBy: "owner", technicianId: techId }] });
    const msg = await say(group.id, { person: true }, "Group hello.");
    await waitFor(() => hits.length === 2);
    await settle();
    expect(rolesOf(msg.id)).toEqual(["admin", "cfo"]);
    expect(byRole(msg.id).admin).toMatchObject({ thread_kind: "group", reply_expected: true, context: { kind: "group", id: group.id } });
    // A group with no agent member sends nothing at all.
    const empty = await prisma.hubThread.create({ data: { kind: "group", title: `${TAG} group B` } });
    await prisma.hubThreadMember.create({ data: { threadId: empty.id, addedBy: "owner", technicianId: techId } });
    hits = [];
    const quiet = await say(empty.id, { person: true }, "Anyone?");
    await settle();
    expect(await rowsFor(quiet.id)).toHaveLength(0);
    expect(hits).toHaveLength(0);
  });

  it("an agent's post in a group goes to the other member agents, not back to its own role", async () => {
    const admin = await keyFor("admin");
    const cfo = await keyFor("cfo");
    const group = await prisma.hubThread.create({ data: { kind: "group", title: `${TAG} group C` } });
    await prisma.hubThreadMember.createMany({ data: [{ threadId: group.id, addedBy: "owner", agentKeyId: admin.id }, { threadId: group.id, addedBy: "owner", agentKeyId: cfo.id }] });
    const msg = await say(group.id, { agent: cfo }, "@Admin the books are closed.");
    await waitFor(() => hits.length === 1);
    await settle();
    expect(rolesOf(msg.id)).toEqual(["admin"]);
    expect(byRole(msg.id).admin).toMatchObject({ reply_expected: true, author_agent: "cfo" });
  });

  it("a job crew chat wakes keys that read it with hub:read as well as the Team scopes", async () => {
    await keyFor("outreach", { scopes: ["hub:read"] }); // hub:read alone opens a job crew chat
    await keyFor("research"); // team:read opens it too
    await keyFor("facebook", { scopes: ["marketing:read"] }); // neither
    const msg = await say(jobThreadId, { person: true }, "Crew: on site at 8.");
    await waitFor(() => hits.length === 2);
    await settle();
    expect(rolesOf(msg.id)).toEqual(["outreach", "research"]);
    expect(byRole(msg.id).research).toMatchObject({ thread_kind: "job", context: { kind: "job", id: visitId } });
    // The same hub:read-only key does NOT hear the Team chat.
    hits = [];
    const team = await say(teamThreadId, { person: true }, "Team line.");
    await waitFor(() => hits.length === 1);
    await settle();
    expect(rolesOf(team.id)).toEqual(["research"]);
  });

  it("a crew chat's text loses the customer's own address and phone, exactly as the door's read does", async () => {
    await keyFor("admin");
    const msg = await say(jobThreadId, { person: true }, "Go to 88 Cedar Hollow Court, Smyrna and call 615-555-0100 first.");
    await waitFor(() => hits.length === 1);
    const text = String(byRole(msg.id).admin.text);
    expect(text).not.toContain("Cedar Hollow");
    expect(text).not.toContain("555-0100");
    expect(text).toContain("[withheld]");
  });
});

// ── what does not change ─────────────────────────────────────────────────────────────────────────

describe("what keeps its old shape", () => {
  it("a customer's inbound message is still ONE event, to the routed target, ids only", async () => {
    await allReaders();
    const thread = await prisma.hubThread.findUniqueOrThrow({ where: { id: customerThreadId } });
    const msg = await prisma.hubMessage.create({
      data: { threadId: customerThreadId, authorType: "customer", authorDisplay: "Jane Homeowner", channel: "sms", direction: "inbound", status: "received", body: "Can you come Tuesday? 615-555-0100" },
    });
    fanOutMessage(msg, thread);
    await waitFor(() => hits.length === 1);
    await settle();
    expect(hits).toHaveLength(1);
    expect(hits[0].role).toBe("admin");
    const p = payloadOf(hits[0]);
    expect(p).toMatchObject({ type: "message.inbound", summary: "New customer message" });
    expect(p).not.toHaveProperty("text");
    expect(p).not.toHaveProperty("mentions");
    expect(hits[0].body).not.toContain("Tuesday");
    expect(verifyBodyOnly(hits[0].body, secrets.admin!)).toBe(true);
  });

  it("a stored route for message.team is ignored: the fan-out decides, and the next save drops it", async () => {
    await allReaders();
    await request(app).put("/owner-settings/agentWebhooks").set(bearer(kyle)).send({
      targets: SEND_ROLES.map((id) => ({ id, url: `${baseUrl}/hook/${id}`, enabled: true })), routes: { "message.team": "inventory", "lead.created": "cfo" },
    }).expect(200);
    const saved = (await request(app).get("/owner-settings/agentWebhooks").set(bearer(kyle)).expect(200)).body.value;
    expect(saved.routes).toEqual({ "lead.created": "cfo" });
    // Even a row that still holds one (written before this build) is read and ignored.
    await prisma.companySetting.update({
      where: { key: "agentWebhooks" },
      data: { valueJson: JSON.stringify({ ...JSON.parse((await prisma.companySetting.findUniqueOrThrow({ where: { key: "agentWebhooks" } })).valueJson), routes: { "message.team": "inventory" } }) },
    });
    const msg = await say(teamThreadId, { person: true }, "Routes?");
    await waitFor(() => hits.length === SEND_ROLES.length);
    expect(rolesOf(msg.id)).toEqual(ALL_ROLES);
  });
});

// ── no silent drop, one row per target per message ───────────────────────────────────────────────

describe("delivery bookkeeping", () => {
  it("a receiver with no address, or turned Off, gets a visible no_target row; the others are sent", async () => {
    await keyFor("admin");
    await keyFor("facebook");
    await keyFor("scout");
    await setTargets({ facebook: { url: null }, scout: { url: `${baseUrl}/hook/scout`, enabled: false } });
    const msg = await say(teamThreadId, { person: true }, "Who is reachable?");
    await waitFor(() => hits.length === 1);
    await settle();
    const rows = await rowsFor(msg.id);
    expect(rows.map((r) => [r.target, r.status, r.lastError])).toEqual([
      ["admin", "delivered", null],
      ["facebook", "no_target", "No receiving address is set"],
      ["scout", "no_target", "This agent is turned Off"],
    ]);
    // It shows in that agent's Recent events (the Agent events log filtered to it).
    const log = await request(app).get("/hub/events?target=facebook&type=message.team").set(bearer(kyle)).expect(200);
    expect(log.body.events).toHaveLength(1);
    expect(log.body.events[0]).toMatchObject({ status: "no_target", target: "facebook", summary: "New team message" });
    expect(JSON.stringify(log.body)).not.toContain("Who is reachable");
  });

  it("a receiver with an address but no signing secret keeps its row waiting (nothing is sent unsigned)", async () => {
    await keyFor("cfo");
    await request(app).delete("/hub/webhooks/cfo/signing-secret").set(bearer(kyle)).expect(200);
    const msg = await say(teamThreadId, { person: true }, "Unsigned?");
    await settle(500);
    const rows = await rowsFor(msg.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ target: "cfo", status: "pending", attempts: 0, lastError: "No signing secret is set for CFO" });
    expect(hits).toHaveLength(0);
    secrets.cfo = (await request(app).post("/hub/webhooks/cfo/signing-secret").set(bearer(kyle)).expect(200)).body.secret as string;
  });

  it("announcing the same message twice still writes ONE row per target (the double-announcement trap)", async () => {
    await keyFor("admin");
    await keyFor("inventory");
    const thread = await prisma.hubThread.findUniqueOrThrow({ where: { id: teamThreadId } });
    const msg = await prisma.hubMessage.create({
      data: { threadId: teamThreadId, authorType: "tech", authorKey: `tech:${techId}`, authorTechnicianId: techId, authorDisplay: "Eric Ward", channel: "in_app", direction: "internal", status: "posted", body: "Once." },
    });
    fanOutMessage(msg, thread);
    fanOutMessage(msg, thread);
    const [a, b] = await Promise.all([emitTeamMessageEvents({ messageId: msg.id }), emitTeamMessageEvents({ messageId: msg.id })]);
    await waitFor(() => hits.length >= 2);
    await settle();
    expect(await rowsFor(msg.id)).toHaveLength(2);
    expect(hits).toHaveLength(2);
    expect(a.length + b.length).toBeLessThanOrEqual(2); // whichever call won the lock wrote the two rows; the rest were no-ops
  });

  it("every agent's wire body is the stored payload plus the two members, and the stored payload holds neither the signature nor the secret", async () => {
    await keyFor("admin");
    const msg = await say(teamThreadId, { person: true }, "Check the wire.");
    await waitFor(() => hits.length === 1);
    const row = (await rowsFor(msg.id))[0];
    expect(row.payloadJson).not.toContain("signature");
    expect(row.payloadJson).not.toContain(secrets.admin!);
    expect(splitWireBody(hits[0].body)!.payloadJson).toBe(row.payloadJson);
    expect(hits[0].body).not.toContain(secrets.admin!);
  });
});

// ── W2-C review: author_id for the PIN session, send-time recheck ────────────────────────────────

describe("author_id is the person's Technician.id from every door (W2-C review)", () => {
  it("Kyle's CRM PIN session (no technician on the message) carries the principal login's Technician.id, like the field app does", async () => {
    await keyFor("admin");
    const principalTech = await prisma.technician.create({ data: { name: "Kyle Principal", accessToken: `${TAG}-p-${randomUUID()}`, isActive: true } });
    const priorPrincipals = await prisma.crmLogin.findMany({ where: { isPrincipal: true }, select: { id: true } });
    await prisma.crmLogin.updateMany({ where: { isPrincipal: true }, data: { isPrincipal: false } });
    const ownThread = await prisma.hubThread.create({ data: { kind: "team", title: `${TAG} principal team`, technicianId: principalTech.id } });
    const login = await prisma.crmLogin.create({ data: { technicianId: principalTech.id, username: `${TAG.toLowerCase()}-${randomUUID().slice(0, 6)}`, role: "admin", isPrincipal: true } });
    try {
      const res = await request(app).post(`/hub/threads/${ownThread.id}/messages`).set(bearer(kyle)).send({ body: "@Inventory test", clientMessageId: `pin-${randomUUID()}` });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      await waitFor(() => hits.length === 1);
      const messageId = String(payloadOf(hits[0]).message_id);
      const stored = await prisma.hubMessage.findUniqueOrThrow({ where: { id: messageId } });
      expect(stored.authorTechnicianId).toBeNull(); // the PIN session stores no technician...
      // ...but the event names the person, the same Technician.id the field app / principal login would carry.
      expect(payloadOf(hits[0])).toMatchObject({ author_type: "person", author_id: principalTech.id });
    } finally {
      await prisma.hubMessage.deleteMany({ where: { threadId: teamThreadId } });
      await prisma.crmLogin.deleteMany({ where: { id: login.id } });
      await prisma.crmLogin.updateMany({ where: { id: { in: priorPrincipals.map((p) => p.id) } }, data: { isPrincipal: true } });
      await prisma.hubMessage.deleteMany({ where: { threadId: ownThread.id } });
      await prisma.hubThread.deleteMany({ where: { id: ownThread.id } });
      await prisma.technician.deleteMany({ where: { id: principalTech.id } });
    }
  });
});

describe("a queued message.team row is re-checked at send time (W2-C review)", () => {
  async function queueWithoutSecret(role: HubWebhookTargetId, text: string) {
    await request(app).delete(`/hub/webhooks/${role}/signing-secret`).set(bearer(kyle)).expect(200);
    const msg = await say(teamThreadId, { person: true }, text);
    await settle(500);
    const rows = await rowsFor(msg.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ target: role, status: "pending" });
    return { msg, row: rows[0] };
  }
  const regenerate = async (role: HubWebhookTargetId) => {
    secrets[role] = (await request(app).post(`/hub/webhooks/${role}/signing-secret`).set(bearer(kyle)).expect(200)).body.secret as string;
  };
  const makeDue = (id: string) => prisma.hubEvent.update({ where: { id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });

  it("a deleted message is never sent: its waiting rows end dead, without the text, and the worker and Resend stay quiet", async () => {
    await keyFor("facebook");
    const { msg, row } = await queueWithoutSecret("facebook", "Gate code 4471 at the Johnson house");
    await request(app).delete(`/hub/messages/${msg.id}`).set(bearer(kyle)).send({ reason: "wrong thread" }).expect(204);
    const after = await prisma.hubEvent.findUniqueOrThrow({ where: { id: row.id } });
    expect(after).toMatchObject({ status: "dead", lastError: "The message was deleted - not sent" });
    expect(after.payloadJson).not.toContain("4471");
    await regenerate("facebook");
    await deliverDueEvents();
    await request(app).post(`/hub/events/${row.id}/resend`).set(bearer(kyle));
    await settle();
    expect(hits).toHaveLength(0);
  });

  it("a row whose message was deleted by some other route is still stopped at send time", async () => {
    await keyFor("facebook");
    const { msg, row } = await queueWithoutSecret("facebook", "Another secret thing");
    await prisma.hubMessage.update({ where: { id: msg.id }, data: { deletedAt: new Date() } });
    await regenerate("facebook");
    await makeDue(row.id);
    await deliverDueEvents();
    expect(await prisma.hubEvent.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ status: "dead", lastError: "The message was deleted - not sent" });
    expect(hits).toHaveLength(0);
  });

  it("a key revoked while the row waited gets nothing when the secret is finally set", async () => {
    const k = await keyFor("facebook");
    const { row } = await queueWithoutSecret("facebook", "Private budget note");
    await prisma.agentKey.update({ where: { id: k.id }, data: { revokedAt: new Date() } });
    await regenerate("facebook");
    await makeDue(row.id);
    await deliverDueEvents();
    expect(await prisma.hubEvent.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ status: "dead", lastError: "This agent can no longer read that conversation - not sent" });
    expect(hits).toHaveLength(0);
  });

  it("a member removed from a group while the row waited gets nothing", async () => {
    const k = await keyFor("facebook");
    await request(app).delete("/hub/webhooks/facebook/signing-secret").set(bearer(kyle)).expect(200);
    const group = await prisma.hubThread.create({ data: { kind: "group", title: `${TAG} group send-time` } });
    await prisma.hubThreadMember.create({ data: { threadId: group.id, addedBy: "owner", agentKeyId: k.id } });
    const msg = await say(group.id, { person: true }, "Group-only note");
    await settle(500);
    const rows = await rowsFor(msg.id);
    expect(rows).toHaveLength(1);
    await prisma.hubThreadMember.deleteMany({ where: { threadId: group.id } });
    await regenerate("facebook");
    await makeDue(rows[0].id);
    await deliverDueEvents();
    expect(await prisma.hubEvent.findUniqueOrThrow({ where: { id: rows[0].id } })).toMatchObject({ status: "dead", lastError: "This agent can no longer read that conversation - not sent" });
    expect(hits).toHaveLength(0);
  });

  it("a row whose reader is unchanged is still sent when the secret arrives", async () => {
    await keyFor("facebook");
    const { msg, row } = await queueWithoutSecret("facebook", "Still fine");
    await regenerate("facebook");
    await makeDue(row.id);
    await deliverDueEvents();
    await waitFor(() => hits.length === 1);
    expect(payloadOf(hits[0])).toMatchObject({ message_id: msg.id, text: "Still fine" });
  });
});
