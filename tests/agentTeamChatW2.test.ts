/**
 * W2 batch A (Kyle, 2026-11-23): "The field app is the one place Kyle and Michael talk to the whole AI team." Server core: the one scope table,
 * any-of gate, Team posts published by the author KEY, the kill switch over every approval, clear scope errors, the agent-to-agent limit,
 * the migration's data step, and the Activity audit.
 *
 * Pinned here, against the real routes (agent keys minted with each role's DEFAULT scopes, writes ON, the way Kyle ticks them):
 *   - the nine roles: GET /api/hub/threads lists the Team thread for every role that holds team:read; reading it works; a Team post is `posted`;
 *     a role with no customer scope (Inventory, Facebook, Scout, Research, CFO, NEC Coach, Coding) is 403 with a reason naming "Read customer
 *     (hub:read)" on a customer thread, and Admin and Outreach draft to a customer (pending_approval, with a pending_reason);
 *   - the 2026-11-23 Facebook bug: a hub:read-only key limited to Team threads got 200 [] and now gets 403 with the reason; a team:read key sees it;
 *   - Team posts: the key's box OFF -> pending_approval + pending_reason; access read_only/off -> refused at the gate; no draft-cap use;
 *     a customer draft still counts toward the 500 a day;
 *   - the agent-to-agent limit (429 thread_agent_limit) and a person's post resetting it;
 *   - the audit: scopeUsed is the matched scope, agentKeyName is the key's name; the scope_denied reason names the missing scopes by their card labels;
 *   - the migration's data step, run on the test database, is correct and idempotent;
 *   - a stored `team_internal: true` rule no longer resets the other rules to OFF.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

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
import { AGENT_DAILY_DRAFT_LIMIT } from "../src/agentApi/audit";
import { THREAD_AGENT_POST_LIMIT, THREAD_LOCK_TIMEOUT_MS } from "../src/agentApi/hubDoor";
import { getHubAutoSend } from "../src/services/hubAutoSend";
import { ensureThreadFor } from "../src/services/hub";
import {
  AGENT_ROLES, DEFAULT_HUB_THREAD_KINDS_BY_ROLE, DEFAULT_SCOPES_BY_ROLE, type AgentRole,
} from "../shared/agentScopes";

const TAG = "W2Chat";
const PIN = "1234";
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const idem = () => `idem-${randomUUID()}`;

let savedPin: string | undefined;
let savedPepper: string | undefined;
let savedEnvName: string | undefined;
let pin = "";
let customerId = "";
let techId = "";
let techToken = "";
let teamThreadId = "";
let trainingThreadId = "";
let jobThreadId = "";
const keyIds: string[] = [];

type Made = { id: string; secret: string; name: string; role: AgentRole };

/** A key with the role's DEFAULT scopes and kinds (what the card prefills), writes ON (what Kyle ticks). */
async function keyFor(role: AgentRole, over: { scopes?: string[]; hubThreadKinds?: string[]; writesEnabled?: boolean; teamPostsPublish?: boolean } = {}): Promise<Made> {
  const name = `${TAG} ${role} ${randomUUID().slice(0, 5)}`;
  const made = await mintAgentKey({
    name, agentRole: role, createdBy: "owner", writesEnabled: over.writesEnabled ?? true, scopes: over.scopes, hubThreadKinds: over.hubThreadKinds, teamPostsPublish: over.teamPostsPublish,
  });
  keyIds.push(made.row.id);
  return { id: made.row.id, secret: made.key, name, role };
}
async function setMode(mode: "on" | "read_only" | "off") {
  const valueJson = JSON.stringify({ mode, changedAt: null, changedBy: null });
  await prisma.companySetting.upsert({ where: { key: "agentAccess" }, create: { key: "agentAccess", valueJson }, update: { valueJson } });
}
const get = (secret: string, url: string) => request(app).get(url).set(bearer(secret));
const post = (secret: string, body: Record<string, unknown>) => request(app).post("/api/hub/messages").set(bearer(secret)).send(body);
const teamPost = (secret: string, body = "Eric, the Smyrna panel is ordered.") => post(secret, { thread_id: teamThreadId, body, idempotency_key: idem() });
const customerDraft = (extra: Record<string, unknown> = {}) => ({
  customerId, channel: "email", subject: "Your quote", body: "Hello, your panel quote is ready to review.", idempotency_key: idem(), ...extra,
});
/** A person (the technician) posts in his Team thread through the field route: it is what starts a thread's agent count over. */
const techPost = (body: string) => request(app).post(`/health-record/hub/threads/${teamThreadId}/messages`).set(bearer(techToken)).send({ body, clientMessageId: `tech-${randomUUID()}` });
const ageAiPosts = () => prisma.hubMessage.updateMany({
  where: { authorType: { in: ["ai_agent", "claude"] }, threadId: { in: [teamThreadId, jobThreadId, trainingThreadId] } },
  data: { createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000) },
});

beforeAll(async () => {
  savedPin = process.env.PIN_HASH;
  savedPepper = process.env.AGENT_KEY_PEPPER;
  savedEnvName = process.env.RAILWAY_ENVIRONMENT_NAME;
  process.env.PIN_HASH = await hashPin(PIN);
  process.env.AGENT_KEY_PEPPER = "test-pepper-for-the-w2-agent-chat-suite";
  delete process.env.RAILWAY_ENVIRONMENT_NAME;
  pin = (await request(app).post("/auth/pin").send({ pin: PIN })).body.token as string;
  const customer = await prisma.customer.create({
    data: {
      name: `${TAG} Jane Homeowner`, email: `${TAG.toLowerCase()}@homeowner.example`,
      properties: { create: { name: "Home", addressLine1: "88 Cedar Hollow Court", city: "Smyrna", state: "TN", postalCode: "37167" } },
    },
  });
  customerId = customer.id;
  const property = await prisma.property.findFirstOrThrow({ where: { customerId } });
  const visit = await prisma.visit.create({ data: { customerId, propertyId: property.id, mode: "service_diagnostic", purpose: `${TAG} job`, status: "contracted" } });
  jobThreadId = (await prisma.hubThread.create({ data: { kind: "job", title: `${TAG} crew chat`, visitId: visit.id } })).id;
  const tech = await prisma.technician.create({ data: { name: `${TAG} Eric`, accessToken: `${TAG}-tok-${randomUUID()}`, isActive: true } });
  techId = tech.id;
  techToken = tech.accessToken;
  teamThreadId = (await prisma.hubThread.create({ data: { kind: "team", title: `${TAG} Eric team`, technicianId: techId } })).id;
  trainingThreadId = (await prisma.hubThread.create({ data: { kind: "training", title: `${TAG} training`, technicianId: techId } })).id;
  // A thread is listed only once it has a message: Eric's own post in his Team and Training threads.
  for (const threadId of [teamThreadId, trainingThreadId]) {
    await prisma.hubMessage.create({
      data: { threadId, authorType: "tech", authorKey: `tech:${techId}`, authorTechnicianId: techId, authorDisplay: `${TAG} Eric`, channel: "in_app", direction: "internal", body: "Eric here.", status: "posted" },
    });
  }
  // Same for the crew chat and a customer conversation the customer-scope roles can see.
  await prisma.hubMessage.create({
    data: { threadId: jobThreadId, authorType: "tech", authorKey: `tech:${techId}`, authorTechnicianId: techId, authorDisplay: `${TAG} Eric`, channel: "in_app", direction: "internal", body: "Crew chat.", status: "posted" },
  });
});

afterAll(async () => {
  if (savedPin === undefined) delete process.env.PIN_HASH; else process.env.PIN_HASH = savedPin;
  if (savedPepper === undefined) delete process.env.AGENT_KEY_PEPPER; else process.env.AGENT_KEY_PEPPER = savedPepper;
  if (savedEnvName === undefined) delete process.env.RAILWAY_ENVIRONMENT_NAME; else process.env.RAILWAY_ENVIRONMENT_NAME = savedEnvName;
  await prisma.companySetting.deleteMany({ where: { key: { in: ["agentAccess", "hubAutoSend"] } } });
  await prisma.hubThread.deleteMany({ where: { OR: [{ customerId }, { title: { startsWith: TAG } }] } });
  await prisma.agentIdempotency.deleteMany({ where: { agentKeyId: { in: keyIds } } });
  await prisma.agentKey.deleteMany({ where: { id: { in: keyIds } } });
  await prisma.agentKey.deleteMany({ where: { name: { startsWith: `${TAG} migrate` } } });
  await prisma.visit.deleteMany({ where: { customerId } });
  await prisma.property.deleteMany({ where: { customerId } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
  await prisma.technician.deleteMany({ where: { id: techId } });
});

beforeEach(async () => {
  await prisma.companySetting.deleteMany({ where: { key: { in: ["agentAccess", "hubAutoSend"] } } });
  await ageAiPosts();
});

// ── the nine roles ───────────────────────────────────────────────────────────────────────────────

const NINE: AgentRole[] = ["admin", "inventory", "facebook", "outreach", "scout", "research", "cfo", "nec_coach", "claude_code"];
const HAS_CUSTOMER = new Set<AgentRole>(["admin", "outreach"]);

describe("the nine roles with their default scopes (Kyle 2026-11-23: read/post/MCP matrix, REST part)", () => {
  it("covers exactly the nine roles Kyle named, and every role with team:read is on this list", () => {
    expect([...NINE].sort()).toEqual(AGENT_ROLES.filter((r) => r !== "other").sort());
    for (const role of NINE) expect(DEFAULT_SCOPES_BY_ROLE[role], role).toContain("team:read");
  });

  for (const role of NINE) {
    describe(role, () => {
      it("GET /api/hub/threads lists the Team thread, and GET its messages works", async () => {
        const k = await keyFor(role);
        const list = await get(k.secret, "/api/hub/threads");
        expect(list.status, JSON.stringify(list.body)).toBe(200);
        expect(list.body.threads.map((t: { id: string }) => t.id)).toContain(teamThreadId);
        const msgs = await get(k.secret, `/api/hub/threads/${teamThreadId}/messages`);
        expect(msgs.status, JSON.stringify(msgs.body)).toBe(200);
        expect(msgs.body.messages.length).toBeGreaterThan(0);
        // The crew chat opens with the Team scopes too (it used to need hub:read).
        expect((await get(k.secret, `/api/hub/threads/${jobThreadId}/messages`)).status).toBe(200);
      });

      it("POST a team post is `posted` at once (writes on, Agent access On, Team posts box ON), with no pending_reason", async () => {
        const k = await keyFor(role);
        const res = await teamPost(k.secret);
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        expect(res.body).toMatchObject({ threadId: teamThreadId, status: "posted", channel: "in_app", category: "team_internal", pending_reason: null });
        const row = await prisma.hubMessage.findUniqueOrThrow({ where: { id: res.body.messageId } });
        expect(row).toMatchObject({ status: "posted", decidedBy: `key:${k.id}`, authorBotKeyId: k.id });
      });

      if (HAS_CUSTOMER.has(role)) {
        it("may draft to a customer: pending_approval, with a pending_reason in plain words, and nothing is sent", async () => {
          const k = await keyFor(role);
          const res = await post(k.secret, customerDraft());
          expect(res.status, JSON.stringify(res.body)).toBe(201);
          expect(res.body.status).toBe("pending_approval");
          expect(res.body.pending_reason).toEqual(expect.any(String));
          expect((await get(k.secret, "/api/hub/threads?kind=customer")).status).toBe(200);
        });
      } else {
        it("has no customer scope: 403 with a reason naming Read customer (hub:read) / Draft customer (hub:draft), and no row is written", async () => {
          const k = await keyFor(role);
          const before = await prisma.hubMessage.count({ where: { thread: { customerId } } });
          const customerThread = await ensureThreadFor({ customerId });
          const read = await get(k.secret, `/api/hub/threads/${customerThread.id}/messages`);
          expect(read.status).toBe(403);
          expect(read.body.reason).toContain("Read customer (hub:read)");
          expect(read.body.reason).toContain("Settings");
          const draft = await post(k.secret, customerDraft());
          expect(draft.status).toBe(403);
          expect(draft.body.reason).toContain("Draft customer (hub:draft)");
          expect(await prisma.hubMessage.count({ where: { thread: { customerId } } })).toBe(before);
        });
      }
    });
  }

  it("Scout keeps its training scopes: it reads and posts in a Training thread in the Scout shape, and still posts in Team", async () => {
    const k = await keyFor("scout");
    const detail = await get(k.secret, `/api/hub/threads/${trainingThreadId}/messages`);
    expect(detail.status, JSON.stringify(detail.body)).toBe(200);
    // The Scout training profile (T4): messageId + apprenticeFirstName, no status/channel, no record links on the thread row.
    expect(Object.keys(detail.body.messages[0])).toEqual(expect.arrayContaining(["messageId", "apprenticeFirstName"]));
    expect(detail.body.thread).not.toHaveProperty("customerId");
    // The Team thread is read in the every-key shape for the same key.
    const team = await get(k.secret, `/api/hub/threads/${teamThreadId}/messages`);
    expect(Object.keys(team.body.messages[0])).toEqual(expect.arrayContaining(["id", "status", "channel"]));
    const reply = await post(k.secret, { thread_id: trainingThreadId, body: "Check the neutral first.", idempotency_key: idem() });
    expect(reply.status).toBe(201);
    expect(reply.body).toMatchObject({ status: "pending_approval", category: "training_reply" }); // 16b: a Training reply still waits
    expect(DEFAULT_HUB_THREAD_KINDS_BY_ROLE.scout).toEqual([]);
  });

  it("Research reads the Team chats but never a customer thread (its list has no customer kind)", async () => {
    const research = await keyFor("research");
    const rkinds = new Set((await get(research.secret, "/api/hub/threads")).body.threads.map((t: { kind: string }) => t.kind));
    expect(rkinds.has("team")).toBe(true);
    expect(rkinds.has("customer")).toBe(false);
  });
});

// ── the Facebook bug and the clear errors ─────────────────────────────────────────────────────────

describe("clear scope errors (the 2026-11-23 failures)", () => {
  it("a hub:read-only key limited to Team threads used to get 200 []: it now gets 403 with the reason, and a team:read key sees the Team thread", async () => {
    const stuck = await keyFor("facebook", { scopes: ["marketing:read", "hub:read"], hubThreadKinds: ["team"] });
    const res = await get(stuck.secret, "/api/hub/threads");
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("forbidden");
    expect(res.body.reason).toMatch(/limited to team threads/);
    // Review fix: the reason also names the boxes that would open Team, by the words the Messages group uses.
    expect(res.body.reason).toContain("Read team (team:read)");
    expect(res.body.reason).toContain("Post team (team:reply)");
    expect(res.body.reason).toContain("Settings");
    const fixed = await keyFor("facebook", { scopes: ["marketing:read", "team:read"], hubThreadKinds: ["team"] });
    const ok = await get(fixed.secret, "/api/hub/threads");
    expect(ok.status).toBe(200);
    expect(ok.body.threads.map((t: { id: string }) => t.id)).toContain(teamThreadId);
  });

  it("a key with no hub scope at all is refused at the gate with the missing scopes named by their card labels", async () => {
    const none = await keyFor("other", { scopes: ["crm:read"] });
    const res = await get(none.secret, "/api/hub/threads");
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("scope_denied");
    expect(res.body.reason).toContain("Read team (team:read)");
    expect(res.body.reason).toContain("Post team (team:reply)");
    expect(res.body.reason).toContain("Read customer (hub:read)");
    expect(res.body.reason).toContain("Tick it on Settings");
    const noPost = await keyFor("other", { scopes: ["team:read"] });
    const refused = await post(noPost.secret, { thread_id: teamThreadId, body: "x", idempotency_key: idem() });
    expect(refused.status).toBe(403);
    expect(refused.body.reason).toContain("Post team (team:reply)");
    expect(refused.body.reason).toContain("Draft customer (hub:draft)");
  });

  it("a key that reads Team but may not post there is refused with the per-kind sentence naming Post team (team:reply), and writes no row", async () => {
    // team:read + hub:draft passes the gate (hub:draft opens POST /hub/messages for customers); the door then says why Team is closed.
    const noReply = await keyFor("other", { scopes: ["team:read", "hub:draft"] });
    const before = await prisma.hubMessage.count({ where: { threadId: teamThreadId } });
    const res = await teamPost(noReply.secret);
    expect(res.status).toBe(403);
    expect(res.body.reason).toBe("This key needs Post team (team:reply) to post in team threads. Tick it on Settings → Agent keys.");
    expect(await prisma.hubMessage.count({ where: { threadId: teamThreadId } })).toBe(before);
  });

  it("an agent key on a route it is not allowed to use is told which routes it can use (generic, before any key lookup)", async () => {
    const k = await keyFor("admin");
    const res = await request(app).get("/api/accounts").set(bearer(k.secret));
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("agent_key_not_accepted");
    expect(res.body.reason).toContain("POST /api/hub/messages");
    expect(res.body.reason).toContain("GET /api/hub/threads/:id/messages");
    expect(res.body.reason).toContain("/mcp");
  });

  it("the audit row records the scope that matched (not just a single route scope) and the key's name", async () => {
    const k = await keyFor("nec_coach");
    expect((await get(k.secret, "/api/hub/threads")).status).toBe(200);
    expect((await teamPost(k.secret)).status).toBe(201);
    const refused = await keyFor("other", { scopes: ["crm:read"] });
    await get(refused.secret, "/api/hub/threads");
    const rows = await prisma.agentAuditLog.findMany({ where: { agentKeyId: k.id }, orderBy: { createdAt: "asc" } });
    expect(rows.map((r) => [r.action, r.scopeUsed, r.agentKeyName, r.resultCode])).toEqual([
      ["hub.threads.list", "team:read", k.name, "ok"],
      ["hub.messages.draft", "team:reply", k.name, "ok"],
    ]);
    const denied = await prisma.agentAuditLog.findFirstOrThrow({ where: { agentKeyId: refused.id } });
    expect(denied).toMatchObject({ resultCode: "scope_denied", agentKeyName: refused.name, scopeUsed: null });
  });
});

describe("review fix: scopeUsed is the scope that opened the thread's kind, not the first any-of scope in table order", () => {
  it("an Admin key holding all four Messages scopes is audited as team:reply / team:read in the Team chat, hub:read / hub:draft on the customer's", async () => {
    const k = await keyFor("admin");
    expect(k.id).toBeTruthy();
    const scopesHeld = (await prisma.agentKey.findUniqueOrThrow({ where: { id: k.id } })).scopes;
    for (const s of ["team:read", "team:reply", "hub:read", "hub:draft"]) expect(scopesHeld).toContain(s);
    expect((await get(k.secret, `/api/hub/threads/${teamThreadId}/messages`)).status).toBe(200);
    expect((await teamPost(k.secret)).status).toBe(201);
    const customerThread = await ensureThreadFor({ customerId });
    expect((await get(k.secret, `/api/hub/threads/${customerThread.id}/messages`)).status).toBe(200);
    expect((await post(k.secret, customerDraft())).status).toBe(201);
    const rows = await prisma.agentAuditLog.findMany({ where: { agentKeyId: k.id }, orderBy: { createdAt: "asc" } });
    expect(rows.map((r) => [r.action, r.scopeUsed, r.resultCode])).toEqual([
      ["hub.threads.get", "team:read", "ok"],
      ["hub.messages.draft", "team:reply", "ok"],
      ["hub.threads.get", "hub:read", "ok"],
      ["hub.messages.draft", "hub:draft", "ok"],
    ]);
  });
});

describe("review fix: the agent-to-agent count is serialized per thread (concurrent posts cannot overshoot the limit)", () => {
  it("with 6 AI posts already in, 6 simultaneous posts publish exactly 2 and refuse 4: the thread ends at 8, never 12", async () => {
    const k = await keyFor("admin");
    for (let i = 0; i < THREAD_AGENT_POST_LIMIT - 2; i++) {
      expect((await teamPost(k.secret, `Seed ${i + 1}.`)).status).toBe(201);
    }
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => teamPost(k.secret, `Racer ${i + 1}.`)));
    const codes = results.map((r) => r.status);
    expect(codes.filter((c) => c === 201).length, JSON.stringify(results.map((r) => r.body))).toBe(2);
    expect(codes.filter((c) => c === 429).length).toBe(4);
    const aiSince = await prisma.hubMessage.count({
      where: { threadId: teamThreadId, authorType: { in: ["ai_agent", "claude"] }, createdAt: { gt: new Date(Date.now() - 10 * 60 * 1000) } },
    });
    expect(aiSince).toBe(THREAD_AGENT_POST_LIMIT);
  });

  // The hung-pool defect (CI, connection_limit 5): every waiter used to sit in its own transaction, holding a pooled connection, blocked on
  // the thread's advisory lock, while the lock holder needed another connection to finish. More simultaneous posts than the pool is what
  // exhausted it. Run this file with `?connection_limit=5` on the database URL (CI does) for it to prove anything about the pool.
  it("12 simultaneous posts (more than the pool's 5 connections) all answer: exactly 8 publish, 4 are refused thread_agent_limit, none hangs", async () => {
    const k = await keyFor("admin");
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => teamPost(k.secret, `Burst ${i + 1}.`)));
    const codes = results.map((r) => r.status);
    expect(codes.filter((c) => c === 201).length, JSON.stringify(results.map((r) => r.body))).toBe(THREAD_AGENT_POST_LIMIT);
    expect(codes.filter((c) => c === 429).length).toBe(12 - THREAD_AGENT_POST_LIMIT);
    for (const r of results.filter((x) => x.status === 429)) expect(r.body.code).toBe("thread_agent_limit");
    const aiSince = await prisma.hubMessage.count({
      where: { threadId: teamThreadId, authorType: { in: ["ai_agent", "claude"] }, createdAt: { gt: new Date(Date.now() - 10 * 60 * 1000) } },
    });
    expect(aiSince).toBe(THREAD_AGENT_POST_LIMIT);
  });

  it("a post that cannot get the thread's database lock (another process holds it) is refused rate_limited, retryable, instead of hanging", async () => {
    const k = await keyFor("admin");
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => { locked = resolve; });
    // Stands in for another replica: its own transaction holds the same advisory lock the door takes.
    const holder = prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${teamThreadId}))`;
      locked();
      await held;
    }, { timeout: 60_000 });
    await lockTaken;
    try {
      const started = Date.now();
      const res = await teamPost(k.secret);
      expect(res.status, JSON.stringify(res.body)).toBe(429);
      expect(res.body.code).toBe("rate_limited");
      expect(res.body.retryable).toBe(true);
      expect(res.body.retry_after).toBeGreaterThan(0);
      expect(Date.now() - started).toBeGreaterThanOrEqual(THREAD_LOCK_TIMEOUT_MS - 500);
    } finally {
      release();
      await holder;
    }
    // The refusal left nothing behind: the key is free, so the same request goes through once the lock is free.
    expect((await teamPost(k.secret)).status).toBe(201);
  }, THREAD_LOCK_TIMEOUT_MS + 10_000);
});

// ── the publish rule ──────────────────────────────────────────────────────────────────────────────

describe("Team posts: the key's box, Agent access, and the draft cap", () => {
  it("box OFF: pending_approval with a pending_reason that names the key and the box; Agent access read_only is refused at the gate; off too", async () => {
    const k = await keyFor("inventory", { teamPostsPublish: false });
    const held = await teamPost(k.secret);
    expect(held.status).toBe(201);
    expect(held.body.status).toBe("pending_approval");
    expect(held.body.pending_reason).toContain(`"Team posts publish immediately" is off for the key "${k.name}"`);
    await setMode("read_only");
    const ro = await teamPost(k.secret);
    expect(ro.status).toBe(503);
    expect(ro.body.code).toBe("agents_read_only");
    await setMode("off");
    expect((await teamPost(k.secret)).status).toBe(503);
  });

  it("a team post never counts toward the 500 a day; a customer draft does (and 429s at the cap with the key's slot taken in the door)", async () => {
    const k = await keyFor("admin");
    await prisma.agentAuditLog.createMany({
      data: Array.from({ length: AGENT_DAILY_DRAFT_LIMIT }, () => ({
        action: "hub.messages.draft", agent: "admin", endpoint: "POST /hub/messages", agentKeyId: k.id, door: "rest", resultCode: "ok", responseStatus: 201, entityType: "draft",
      })),
    });
    // At the cap a Team post still goes through (and is not counted: the audit row it leaves has no draft entity)...
    const team = await teamPost(k.secret);
    expect(team.status).toBe(201);
    expect(team.body.status).toBe("posted");
    const mine = await prisma.agentAuditLog.findFirstOrThrow({ where: { agentKeyId: k.id, action: "hub.messages.draft", entityType: null } });
    expect(mine.resultCode).toBe("ok");
    // ... a customer draft is refused.
    const draft = await post(k.secret, customerDraft());
    expect(draft.status).toBe(429);
    expect(draft.body.code).toBe("daily_draft_limit");
    expect(draft.body.retry_after).toBeGreaterThan(0);
    expect(Number(draft.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("a status of posted, approved or sent in the body is still refused: only the key's box and Agent access publish", async () => {
    const k = await keyFor("admin");
    for (const status of ["posted", "approved", "sent"]) {
      const res = await post(k.secret, { thread_id: teamThreadId, body: "x", status, idempotency_key: idem() });
      expect(res.status, status).toBe(403);
    }
  });
});

// ── the agent-to-agent limit ──────────────────────────────────────────────────────────────────────

describe("the agent-to-agent limit (R-j): 8 AI posts in 10 minutes with no person in between", () => {
  it("the 9th is 429 thread_agent_limit with the plain reason; a person's post starts the count over; a customer thread is never limited", async () => {
    const k = await keyFor("admin");
    await prisma.hubMessage.updateMany({ where: { threadId: teamThreadId, authorType: "tech" }, data: { createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000) } });
    for (let i = 0; i < THREAD_AGENT_POST_LIMIT; i++) {
      const ok = await teamPost(k.secret, `Update ${i + 1}.`);
      expect(ok.status, `post ${i + 1}: ${JSON.stringify(ok.body)}`).toBe(201);
    }
    const ninth = await teamPost(k.secret, "Update 9.");
    expect(ninth.status).toBe(429);
    expect(ninth.body.code).toBe("thread_agent_limit");
    expect(ninth.body.reason).toBe("Too many AI replies in this thread in a row. A person needs to post before the AI team posts again.");
    expect(ninth.body.retryable).toBe(true);
    expect(await prisma.hubMessage.count({ where: { threadId: teamThreadId, body: "Update 9." } })).toBe(0);
    // Another AI key in the same thread is held back by the same count (agent-to-agent, not per key).
    const other = await keyFor("inventory");
    expect((await teamPost(other.secret, "Me too.")).status).toBe(429);
    // The refusal is audited.
    expect(await prisma.agentAuditLog.count({ where: { agentKeyId: k.id, resultCode: "thread_agent_limit" } })).toBe(1);
    // A customer conversation is not an agent-to-agent thread.
    expect((await post(k.secret, customerDraft())).status).toBe(201);
    // Eric posts: the count starts over.
    expect((await techPost("Eric: thanks, all of you.")).status).toBe(201);
    expect((await teamPost(k.secret, "Update 10.")).status).toBe(201);
  });
});

// ── the owner rules ───────────────────────────────────────────────────────────────────────────────

describe("the owner's AI auto-send rules after W2", () => {
  it("a stored team_internal rule no longer resets the other rules to OFF: it is dropped on read, the rest stay as Kyle set them", async () => {
    const valueJson = JSON.stringify({ categories: { team_internal: true, lead_first_response: true, visit_reminder: false }, changedAt: "2026-11-22T10:00:00-06:00", changedBy: "Kyle" });
    await prisma.companySetting.upsert({ where: { key: "hubAutoSend" }, create: { key: "hubAutoSend", valueJson }, update: { valueJson } });
    const value = await getHubAutoSend();
    expect(value.categories).toEqual({ lead_first_response: true, visit_reminder: false });
    expect(value.changedBy).toBe("Kyle");
    const card = await request(app).get("/owner-settings/hubAutoSend").set(bearer(pin));
    expect(card.status).toBe(200);
    expect(card.body.value.categories).toEqual({ lead_first_response: true, visit_reminder: false });
    // Saving from the card (which no longer shows team_internal) works, and an old client that still sends it is not refused.
    const saved = await request(app).put("/owner-settings/hubAutoSend").set(bearer(pin)).send({ categories: { lead_first_response: true, team_internal: true } });
    expect(saved.status).toBe(200);
    expect(saved.body.value.categories).toEqual({ lead_first_response: true });
    expect((await request(app).put("/owner-settings/hubAutoSend").set(bearer(pin)).send({ categories: { made_up: true } })).status).toBe(400);
  });
});

// ── the migration's data step ─────────────────────────────────────────────────────────────────────

describe("migration 20261123120000_w2_agent_chat: the data step", () => {
  const sql = fs.readFileSync(path.join(__dirname, "..", "prisma", "migrations", "20261123120000_w2_agent_chat", "migration.sql"), "utf8");
  /** Only the DATA statements: the two ALTER TABLEs are already applied to the test database by the schema push. */
  const dataStatements = sql.slice(sql.indexOf("-- DATA:")).split(/;\s*\n/).map((s) => s.trim()).filter((s) => /^(--[^\n]*\n)*\s*UPDATE/.test(s));

  it("is two UPDATEs and adds no DROP, DELETE or TRUNCATE", () => {
    expect(dataStatements).toHaveLength(2);
    expect(sql).not.toMatch(/\b(DROP|DELETE|TRUNCATE)\b/i);
    expect(sql.match(/ALTER TABLE/g)).toHaveLength(2);
  });

  async function seed(role: string, scopes: string[], kinds: string[], revoked = false) {
    const row = await prisma.agentKey.create({
      data: {
        name: `${TAG} migrate ${role}${revoked ? " revoked" : ""} ${randomUUID().slice(0, 4)}`, agentRole: role, environment: "test", displayPrefix: "rce_test_xxxx",
        secretHash: `hash-${randomUUID()}`, scopes, hubThreadKinds: kinds, createdBy: "owner", revokedAt: revoked ? new Date() : null,
      },
    });
    return row.id;
  }
  const scopesOf = async (id: string) => (await prisma.agentKey.findUniqueOrThrow({ where: { id } }));

  it("brings every live key's hub scopes to Kyle's defaults by role, keeps every other scope, clears Scout's and Coding's thread limit, skips revoked keys, and is idempotent", async () => {
    const ids = {
      admin: await seed("admin", ["crm:read", "hub:read", "hub:draft", "team:reply", "dev:ticket"], []),
      outreach: await seed("outreach", ["outreach:read", "hub:draft", "leads:draft"], []),
      inventory: await seed("inventory", ["inventory:read", "hub:read", "inventory:usage", "team:reply"], []),
      facebook: await seed("facebook", ["marketing:read", "hub:read", "campaign:draft"], ["team"]),
      scout: await seed("scout", ["training:read", "training:write", "hub:read", "hub:draft", "marketing:read"], ["training"]),
      coding: await seed("claude_code", ["dev:read", "dev:write"], ["dev"]),
      nec: await seed("nec_coach", ["hub:read"], []),
      research: await seed("research", ["reports:read"], []),
      other: await seed("other", ["hub:read", "crm:read"], []),
      revoked: await seed("scout", ["hub:read", "hub:draft"], ["training"], true),
    };
    const run = async () => { for (const s of dataStatements) await prisma.$executeRawUnsafe(s); };
    await run();
    const want = (rowScopes: string[], expected: string[]) => expect([...rowScopes].sort()).toEqual([...expected].sort());
    want((await scopesOf(ids.admin)).scopes, ["crm:read", "hub:read", "hub:draft", "team:read", "team:reply", "dev:ticket"]);
    want((await scopesOf(ids.outreach)).scopes, ["outreach:read", "leads:draft", "hub:read", "hub:draft", "team:read", "team:reply"]);
    want((await scopesOf(ids.inventory)).scopes, ["inventory:read", "inventory:usage", "team:read", "team:reply"]);
    want((await scopesOf(ids.facebook)).scopes, ["marketing:read", "campaign:draft", "team:read", "team:reply"]);
    want((await scopesOf(ids.scout)).scopes, ["training:read", "training:write", "marketing:read", "team:read", "team:reply"]);
    want((await scopesOf(ids.coding)).scopes, ["dev:read", "dev:write", "team:read", "team:reply"]);
    want((await scopesOf(ids.nec)).scopes, ["team:read", "team:reply"]);
    want((await scopesOf(ids.research)).scopes, ["reports:read", "team:read", "team:reply"]);
    // "other" has no defaults, and a revoked key is history: both untouched.
    want((await scopesOf(ids.other)).scopes, ["hub:read", "crm:read"]);
    expect(await scopesOf(ids.revoked)).toMatchObject({ scopes: ["hub:read", "hub:draft"], hubThreadKinds: ["training"] });
    // Scout and Claude Code lose their one-kind limit; a Facebook limit Kyle set stays.
    expect((await scopesOf(ids.scout)).hubThreadKinds).toEqual([]);
    expect((await scopesOf(ids.coding)).hubThreadKinds).toEqual([]);
    expect((await scopesOf(ids.facebook)).hubThreadKinds).toEqual(["team"]);
    // A second run changes nothing.
    const first = await prisma.agentKey.findMany({ where: { id: { in: Object.values(ids) } }, orderBy: { id: "asc" } });
    await run();
    const second = await prisma.agentKey.findMany({ where: { id: { in: Object.values(ids) } }, orderBy: { id: "asc" } });
    expect(second.map((r) => [r.id, r.scopes, r.hubThreadKinds])).toEqual(first.map((r) => [r.id, r.scopes, r.hubThreadKinds]));
    // And the migrated keys now work: the formerly empty-listing Facebook key sees the Team thread.
    expect(first.find((r) => r.id === ids.facebook)?.teamPostsPublish).toBe(true);
  });
});
