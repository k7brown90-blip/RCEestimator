import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { hashPin } from "../src/middleware/pinAuth";
import { isPublicRoute } from "../src/middleware/publicRoutes";
import { createAgentKeyGate, finishAgentCall, type AgentKeyRoute } from "../src/agentApi/gate";
import { saveAdminLogin } from "../src/services/adminLogin";
import { saveCrmLogin, setPowers } from "../src/services/crmLogin";
import { CRM_POWERS } from "../shared/crmPowers";
import { AGENT_KEYS_AI_ADMIN_REASON, DEFAULT_SCOPES_BY_ROLE } from "../shared/agentScopes";
import { cleanupCrmLoginFixtures, makePerson } from "./helpers/crmLoginFixture";

/**
 * Work order agent-team, K-U2: the routes behind Settings -> "Agent keys". Every route sits behind
 * requireBotKeys(): Kyle always passes, a person only with the bot_keys power Kyle granted, the AI
 * admin never. The plaintext key is in the create and rotate responses only; no response ever has a
 * hash. The kill switch is written ONLY through PUT /owner-settings/agentAccess, and the server
 * stamps who and when.
 */

const PIN = "1234";
const PASS = "correct horse battery";
const AI_PASS = "another long password!";
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const ROUTES: AgentKeyRoute[] = [{ methods: ["GET"], path: "/ping", scope: "crm:read", tool: "test.ping", reason: "t" }];

let savedPin: string | undefined;
let savedPepper: string | undefined;
let savedEnvName: string | undefined;
const madeIds: string[] = [];

beforeAll(async () => {
  savedPin = process.env.PIN_HASH;
  savedPepper = process.env.AGENT_KEY_PEPPER;
  savedEnvName = process.env.RAILWAY_ENVIRONMENT_NAME;
  process.env.PIN_HASH = await hashPin(PIN);
  process.env.AGENT_KEY_PEPPER = "test-pepper-for-the-agent-keys-routes";
  delete process.env.RAILWAY_ENVIRONMENT_NAME;
});
afterAll(async () => {
  if (savedPin === undefined) delete process.env.PIN_HASH; else process.env.PIN_HASH = savedPin;
  if (savedPepper === undefined) delete process.env.AGENT_KEY_PEPPER; else process.env.AGENT_KEY_PEPPER = savedPepper;
  if (savedEnvName === undefined) delete process.env.RAILWAY_ENVIRONMENT_NAME; else process.env.RAILWAY_ENVIRONMENT_NAME = savedEnvName;
  await prisma.agentKey.deleteMany({ where: { id: { in: madeIds } } });
  await prisma.companySetting.deleteMany({ where: { key: "agentAccess" } });
  await prisma.systemEvent.deleteMany({ where: { source: "agent_keys" } });
  await cleanupCrmLoginFixtures();
});
beforeEach(async () => {
  await cleanupCrmLoginFixtures();
  await prisma.companySetting.deleteMany({ where: { key: "agentAccess" } });
});

const pinToken = async () => (await request(app).post("/auth/pin").send({ pin: PIN })).body.token as string;

async function personToken(username = "michael", powers: string[] = []) {
  const person = await makePerson("Michael Test");
  const login = await saveCrmLogin(person.id, { username, role: "owner", password: PASS });
  if (powers.length) await setPowers(login.id, powers);
  const res = await request(app).post("/auth/login").send({ username, password: PASS });
  expect(res.status).toBe(200);
  return res.body.token as string;
}

async function aiAdminToken() {
  await saveAdminLogin("grok-admin", AI_PASS);
  return (await request(app).post("/auth/login").send({ username: "grok-admin", password: AI_PASS })).body.token as string;
}

async function create(token: string, body: Record<string, unknown> = { name: "Admin Agent", agentRole: "admin" }) {
  const res = await request(app).post("/settings/agent-keys").set(bearer(token)).send(body);
  if (res.status === 201) madeIds.push(res.body.key.id);
  return res;
}

function gateApp(now?: () => Date) {
  const a = express();
  a.use(createAgentKeyGate({ routes: ROUTES, now }));
  a.get("/ping", (req, res) => void finishAgentCall(req, res, { status: 200, body: { ok: true } }));
  return a;
}

describe("who may use the routes", () => {
  it("is behind the session gate and on no public allowlist", async () => {
    for (const [m, p] of [["GET", "/settings/agent-keys"], ["POST", "/settings/agent-keys"], ["PATCH", "/settings/agent-keys/x"],
      ["POST", "/settings/agent-keys/x/rotate"], ["POST", "/settings/agent-keys/x/revoke"]] as const) {
      expect(isPublicRoute(m, p), `${m} ${p}`).toBe(false);
      expect((await request(app)[m.toLowerCase() as "get"](p)).status, `${m} ${p}`).toBe(401);
    }
  });

  it("the AI admin is 403 on every route, read included, with the card's own sentence", async () => {
    const token = await aiAdminToken();
    const made = await create(await pinToken());
    const id = made.body.key.id as string;
    for (const res of [
      await request(app).get("/settings/agent-keys").set(bearer(token)),
      await request(app).post("/settings/agent-keys").set(bearer(token)).send({ name: "x", agentRole: "admin" }),
      await request(app).patch(`/settings/agent-keys/${id}`).set(bearer(token)).send({ name: "y" }),
      await request(app).post(`/settings/agent-keys/${id}/rotate`).set(bearer(token)),
      await request(app).post(`/settings/agent-keys/${id}/revoke`).set(bearer(token)).send({}),
      await request(app).get(`/settings/agent-keys/${id}/activity`).set(bearer(token)), // W2: the card's Activity button
      await request(app).put("/owner-settings/agentAccess").set(bearer(token)).send({ mode: "off" }),
      await request(app).get("/owner-settings/agentAccess").set(bearer(token)),
    ]) {
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: AGENT_KEYS_AI_ADMIN_REASON });
    }
    expect((await prisma.agentKey.findUnique({ where: { id } }))?.name).toBe("Admin Agent");
    expect((await prisma.companySetting.findUnique({ where: { key: "agentAccess" } }))).toBeNull();
  });

  it("a person without the bot_keys power is 403 with the shared reason, whatever else Kyle granted; with it they pass", async () => {
    const without = await personToken("michael", ["price_book_edit", "treasury", "approve_drafts"]);
    for (const res of [
      await request(app).get("/settings/agent-keys").set(bearer(without)),
      await request(app).post("/settings/agent-keys").set(bearer(without)).send({ name: "x", agentRole: "admin" }),
      await request(app).get("/settings/agent-keys/anything/activity").set(bearer(without)),
      await request(app).put("/owner-settings/agentAccess").set(bearer(without)).send({ mode: "off" }),
    ]) {
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: CRM_POWERS.bot_keys.reason });
    }
    await cleanupCrmLoginFixtures();
    const withPower = await personToken("michael2", ["bot_keys"]);
    expect((await request(app).get("/settings/agent-keys").set(bearer(withPower))).status).toBe(200);
    expect((await create(withPower)).status).toBe(201);
  });

  it("Kyle (the PIN) passes every route", async () => {
    const pin = await pinToken();
    expect((await request(app).get("/settings/agent-keys").set(bearer(pin))).status).toBe(200);
    expect((await create(pin)).status).toBe(201);
  });
});

describe("GET /settings/agent-keys", () => {
  it("reports the pepper, the environment, write tools, the kill switch and the keys, never a hash or a secret", async () => {
    const pin = await pinToken();
    const made = await create(pin);
    const res = await request(app).get("/settings/agent-keys").set(bearer(pin));
    expect(res.status).toBe(200);
    // W1 (2026-11-22): the write-tool lock is gone, so the card's data no longer carries writeToolsAvailable.
    expect(res.body).not.toHaveProperty("writeToolsAvailable");
    expect(res.body).toMatchObject({
      pepperConfigured: true, environment: "test",
      agentAccess: { mode: "on", changedAt: null, changedBy: null },
    });
    const row = res.body.keys.find((k: { id: string }) => k.id === made.body.key.id);
    expect(row).toMatchObject({ name: "Admin Agent", agentRole: "admin", environment: "test", writesEnabled: false, status: "active" });
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(made.body.secret);
    expect(text).not.toContain(made.body.secret.slice(9));
    expect(text).not.toMatch(/secretHash|"hash"/i);
    const stored = await prisma.agentKey.findUnique({ where: { id: made.body.key.id } });
    expect(text).not.toContain(stored!.secretHash);
  });

  it("says the pepper is not configured when it is not", async () => {
    const saved = process.env.AGENT_KEY_PEPPER;
    delete process.env.AGENT_KEY_PEPPER;
    try {
      const res = await request(app).get("/settings/agent-keys").set(bearer(await pinToken()));
      expect(res.body.pepperConfigured).toBe(false);
    } finally {
      process.env.AGENT_KEY_PEPPER = saved;
    }
  });
});

describe("POST /settings/agent-keys (create)", () => {
  it("returns the secret once, in a form the gate accepts; the key row holds only the hash", async () => {
    const pin = await pinToken();
    const res = await create(pin);
    expect(res.status).toBe(201);
    expect(res.body.secret).toMatch(/^rce_test_[A-Za-z0-9_-]{43}$/);
    expect(res.body.key.displayPrefix).toBe(res.body.secret.slice(0, 13));
    expect(res.body.key.scopes.sort()).toEqual([...DEFAULT_SCOPES_BY_ROLE.admin].sort());
    expect(res.body.key.writesEnabled).toBe(false);
    expect(JSON.stringify(res.body.key)).not.toContain(res.body.secret);
    // The key works at the agent gate (crm:read is an admin default).
    expect((await request(gateApp()).get("/ping").set(bearer(res.body.secret))).status).toBe(200);
  });

  it("takes the role's default scopes and hub thread kinds when none are given, and honours edited ones", async () => {
    const pin = await pinToken();
    const scout = await create(pin, { name: "Scout", agentRole: "scout" });
    // W2 (Kyle 2026-11-23): Scout and Claude Code read and post in the Team chats and are no longer limited to one kind of thread.
    // Kyle 2026-11-24: every role but Other also reads the price book (pricebook:read).
    expect(scout.body.key.scopes.sort()).toEqual(["leads:dupcheck", "leads:draft", "marketing:read",
      "media:marketing:read", "pricebook:read", "team:read", "team:reply", "training:read", "training:write"].sort());
    expect(scout.body.key.hubThreadKinds).toEqual([]);
    const claude = await create(pin, { name: "Claude Code", agentRole: "claude_code" });
    expect(claude.body.key.scopes.sort()).toEqual(["dev:read", "dev:write", "pricebook:read", "team:read", "team:reply"]);
    expect(claude.body.key.hubThreadKinds).toEqual([]);
    // A CFO key can be made, and gets its own defaults.
    const cfo = await create(pin, { name: "CFO", agentRole: "cfo" });
    expect(cfo.status).toBe(201);
    expect(cfo.body.key.scopes.sort()).toEqual(["finance:read", "pricebook:read", "team:read", "team:reply"]);
    const custom = await create(pin, { name: "Narrow", agentRole: "admin", scopes: ["hub:read"], hubThreadKinds: ["team", "dev"] });
    expect(custom.body.key.scopes).toEqual(["hub:read"]);
    expect(custom.body.key.hubThreadKinds.sort()).toEqual(["dev", "team"]);
  });

  it("validates: unknown scope, unknown thread kind, unknown role, empty name, past expiry, extra fields are 400 and store nothing", async () => {
    const pin = await pinToken();
    const before = await prisma.agentKey.count();
    for (const body of [
      { name: "x", agentRole: "admin", scopes: ["crm:read", "root:everything"] },
      { name: "x", agentRole: "admin", hubThreadKinds: ["everything"] },
      { name: "x", agentRole: "wizard" },
      { name: "  ", agentRole: "admin" },
      { name: "x", agentRole: "admin", expiresAt: "2020-01-01" },
      { name: "x", agentRole: "admin", writesEnabled: true },
      {},
    ]) {
      const res = await request(app).post("/settings/agent-keys").set(bearer(pin)).send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(typeof res.body.error).toBe("string");
    }
    expect(await prisma.agentKey.count()).toBe(before);
  });

  it("an expiry date means the end of that Chicago day", async () => {
    const pin = await pinToken();
    const res = await create(pin, { name: "Dated", agentRole: "admin", expiresAt: "2099-06-15" });
    expect(res.body.key.expiresAt).toBe("2099-06-15T23:59:00-05:00");
  });

  it("with AGENT_KEY_PEPPER unset: 503 with the instruction, and nothing is stored", async () => {
    const saved = process.env.AGENT_KEY_PEPPER;
    delete process.env.AGENT_KEY_PEPPER;
    try {
      const before = await prisma.agentKey.count();
      const res = await request(app).post("/settings/agent-keys").set(bearer(await pinToken())).send({ name: "x", agentRole: "admin" });
      expect(res.status).toBe(503);
      expect(res.body.error).toBe("Set AGENT_KEY_PEPPER in Railway first.");
      expect(await prisma.agentKey.count()).toBe(before);
    } finally {
      process.env.AGENT_KEY_PEPPER = saved;
    }
  });

  it("writes a SystemEvent naming the actor and the key, and never the secret", async () => {
    const res = await create(await pinToken(), { name: "Audited", agentRole: "admin" });
    const events = await prisma.systemEvent.findMany({ where: { source: "agent_keys", message: "Agent key created" }, orderBy: { createdAt: "desc" }, take: 3 });
    await new Promise((r) => setTimeout(r, 100));
    const again = await prisma.systemEvent.findMany({ where: { source: "agent_keys", message: "Agent key created" }, orderBy: { createdAt: "desc" }, take: 3 });
    const mine = [...events, ...again].find((e) => (e.detailsJson ?? "").includes(res.body.key.id));
    expect(mine).toBeTruthy();
    expect(mine!.detailsJson).toContain("Kyle");
    expect(mine!.detailsJson).not.toContain(res.body.secret);
    expect(mine!.detailsJson).not.toContain(res.body.secret.slice(9));
  });
});

describe("PATCH /settings/agent-keys/:id (edit)", () => {
  it("changes name, scopes, hub thread kinds and expiry; a scope edit applies on the very next agent call", async () => {
    const pin = await pinToken();
    const made = await create(pin, { name: "Editable", agentRole: "admin", scopes: ["hub:read"] });
    const gate = gateApp();
    expect((await request(gate).get("/ping").set(bearer(made.body.secret))).status).toBe(403);
    const patch = await request(app).patch(`/settings/agent-keys/${made.body.key.id}`).set(bearer(pin))
      .send({ name: "Renamed", scopes: ["crm:read", "hub:read"], hubThreadKinds: ["team"], expiresAt: "2099-01-31" });
    expect(patch.status).toBe(200);
    expect(patch.body.key).toMatchObject({ name: "Renamed", scopes: ["crm:read", "hub:read"], hubThreadKinds: ["team"] });
    expect(patch.body.key.expiresAt).toBe("2099-01-31T23:59:00-06:00");
    expect((await request(gate).get("/ping").set(bearer(made.body.secret))).status).toBe(200);
    const clear = await request(app).patch(`/settings/agent-keys/${made.body.key.id}`).set(bearer(pin)).send({ expiresAt: null });
    expect(clear.body.key.expiresAt).toBeNull();
  });

  // W1 (2026-11-22): POST /hub/messages is the first write tool, so the old 409 "Write tools arrive in Phase B" is gone.
  // The full path (draft lands pending_approval, kill switch, non-Kyle, revoked) is in tests/agentWritesSwitchedOn.test.ts.
  it("Allow writes can be turned ON by Kyle (a new key starts OFF) and OFF again", async () => {
    const pin = await pinToken();
    const made = await create(pin);
    expect(made.body.key.writesEnabled).toBe(false);
    const on = await request(app).patch(`/settings/agent-keys/${made.body.key.id}`).set(bearer(pin)).send({ writesEnabled: true });
    expect(on.status).toBe(200);
    expect(on.body.key.writesEnabled).toBe(true);
    expect((await prisma.agentKey.findUnique({ where: { id: made.body.key.id } }))?.writesEnabled).toBe(true);
    expect((await request(app).patch(`/settings/agent-keys/${made.body.key.id}`).set(bearer(pin)).send({ writesEnabled: false })).status).toBe(200);
    expect((await prisma.agentKey.findUnique({ where: { id: made.body.key.id } }))?.writesEnabled).toBe(false);
  });

  // W2 (Kyle 2026-11-23): the per-key "Team posts publish immediately" box. Default ON; Kyle (bot_keys) edits it; a rotation copies it.
  it("Team posts publish immediately starts ON, can be turned off and on, is audited, and a rotation keeps the setting", async () => {
    const pin = await pinToken();
    const made = await create(pin, { name: "Publisher", agentRole: "inventory" });
    expect(made.body.key.teamPostsPublish).toBe(true);
    const off = await request(app).patch(`/settings/agent-keys/${made.body.key.id}`).set(bearer(pin)).send({ teamPostsPublish: false });
    expect(off.status).toBe(200);
    expect(off.body.key.teamPostsPublish).toBe(false);
    expect((await prisma.agentKey.findUniqueOrThrow({ where: { id: made.body.key.id } })).teamPostsPublish).toBe(false);
    const rot = await request(app).post(`/settings/agent-keys/${made.body.key.id}/rotate`).set(bearer(pin));
    expect(rot.status).toBe(201);
    madeIds.push(rot.body.key.id);
    expect(rot.body.key.teamPostsPublish).toBe(false); // the new key keeps what the old one had
    const on = await request(app).patch(`/settings/agent-keys/${rot.body.key.id}`).set(bearer(pin)).send({ teamPostsPublish: true });
    expect(on.body.key.teamPostsPublish).toBe(true);
    expect((await request(app).patch(`/settings/agent-keys/${rot.body.key.id}`).set(bearer(pin)).send({ teamPostsPublish: "yes" })).status).toBe(400);
    await new Promise((r) => setTimeout(r, 150)); // logSystemEvent is fire-and-forget
    const events = await prisma.systemEvent.findMany({ where: { source: "agent_keys", message: "Agent key changed" }, orderBy: { createdAt: "desc" }, take: 5 });
    expect(events.some((e) => (e.detailsJson ?? "").includes("teamPostsPublish"))).toBe(true);
  });

  it("is refused for unknown fields, bad values, an unknown key (404) and a revoked key (409)", async () => {
    const pin = await pinToken();
    const made = await create(pin);
    const url = `/settings/agent-keys/${made.body.key.id}`;
    expect((await request(app).patch(url).set(bearer(pin)).send({ secretHash: "x" })).status).toBe(400);
    expect((await request(app).patch(url).set(bearer(pin)).send({ scopes: ["nope"] })).status).toBe(400);
    expect((await request(app).patch(url).set(bearer(pin)).send({ expiresAt: "2020-01-01" })).status).toBe(400);
    expect((await request(app).patch("/settings/agent-keys/nope").set(bearer(pin)).send({ name: "x" })).status).toBe(404);
    await request(app).post(`${url}/revoke`).set(bearer(pin)).send({});
    expect((await request(app).patch(url).set(bearer(pin)).send({ name: "x" })).status).toBe(409);
  });
});

describe("GET /settings/agent-keys/:id/activity (W2: the card's Activity button)", () => {
  it("lists that key's calls newest first with the key's name, the action, the endpoint and the result - never a body - and 404s an unknown key", async () => {
    const pin = await pinToken();
    const made = await create(pin, { name: "Watched Agent", agentRole: "admin" });
    const other = await create(pin, { name: "Other Agent", agentRole: "admin" });
    const t0 = Date.now();
    await request(gateApp(() => new Date(t0))).get("/ping").set(bearer(made.body.secret));
    await request(gateApp(() => new Date(t0))).get("/ping").set(bearer(other.body.secret));
    await request(gateApp(() => new Date(t0))).get("/ping").set(bearer(made.body.secret));
    const res = await request(app).get(`/settings/agent-keys/${made.body.key.id}/activity`).set(bearer(pin));
    expect(res.status).toBe(200);
    expect(res.body.keyName).toBe("Watched Agent");
    expect(res.body.activity).toHaveLength(2); // the other key's call is not here
    expect(res.body.activity[0].at >= res.body.activity[1].at).toBe(true); // newest first
    expect(res.body.activity[0]).toMatchObject({ keyName: "Watched Agent", action: "test.ping", endpoint: "GET /ping", resultCode: "ok", status: 200 });
    expect(Object.keys(res.body.activity[0]).sort()).toEqual(["action", "at", "endpoint", "id", "keyName", "resultCode", "status"]);
    expect(JSON.stringify(res.body)).not.toContain(made.body.secret);
    expect((await request(app).get("/settings/agent-keys/nope/activity").set(bearer(pin))).status).toBe(404);
  });

  it("a row written before W2 (no name snapshot) shows the key's own name", async () => {
    const pin = await pinToken();
    const made = await create(pin, { name: "Old Rows", agentRole: "admin" });
    await prisma.agentAuditLog.create({ data: { action: "hub.threads.list", agent: "admin", endpoint: "GET /hub/threads", agentKeyId: made.body.key.id, door: "rest", resultCode: "ok", responseStatus: 200 } });
    const res = await request(app).get(`/settings/agent-keys/${made.body.key.id}/activity`).set(bearer(pin));
    expect(res.body.activity[0].keyName).toBe("Old Rows");
  });
});

describe("rotate and revoke", () => {
  it("rotate makes a new key with the same settings, shows its secret once, and the old key stops at +24h: both work at 23h, the old is 401 at 24h01m", async () => {
    const pin = await pinToken();
    const made = await create(pin, { name: "Rotating", agentRole: "admin", scopes: ["crm:read"], hubThreadKinds: ["team"], expiresAt: "2099-01-31" });
    const rot = await request(app).post(`/settings/agent-keys/${made.body.key.id}/rotate`).set(bearer(pin));
    expect(rot.status).toBe(201);
    madeIds.push(rot.body.key.id);
    expect(rot.body.secret).toMatch(/^rce_test_/);
    expect(rot.body.secret).not.toBe(made.body.secret);
    expect(rot.body.key).toMatchObject({
      name: "Rotating", agentRole: "admin", scopes: ["crm:read"], hubThreadKinds: ["team"], rotatedFromId: made.body.key.id, status: "active",
    });
    expect(rot.body.key.expiresAt).toBe(made.body.key.expiresAt);
    expect(rot.body.retired.status).toBe("retiring");
    expect(JSON.stringify(rot.body.retired)).not.toContain(rot.body.secret);

    const t0 = Date.now();
    const at = (ms: number) => gateApp(() => new Date(t0 + ms));
    const H = 3600_000;
    expect((await request(at(23 * H)).get("/ping").set(bearer(made.body.secret))).status).toBe(200);
    expect((await request(at(23 * H)).get("/ping").set(bearer(rot.body.secret))).status).toBe(200);
    const late = await request(at(24 * H + 60_000)).get("/ping").set(bearer(made.body.secret));
    expect(late.status).toBe(401);
    expect(late.body.code).toBe("key_retired");
    expect((await request(at(24 * H + 60_000)).get("/ping").set(bearer(rot.body.secret))).status).toBe(200);
    // The list shows the old one as retiring until its time.
    const list = await request(app).get("/settings/agent-keys").set(bearer(pin));
    const oldRow = list.body.keys.find((k: { id: string }) => k.id === made.body.key.id);
    expect(oldRow.status).toBe("retiring");
    expect(oldRow.retiresAt).toBeTruthy();
  });

  it("rotating a key that is already being replaced, or revoked, is 409; an unknown key is 404", async () => {
    const pin = await pinToken();
    const made = await create(pin);
    const url = `/settings/agent-keys/${made.body.key.id}/rotate`;
    const first = await request(app).post(url).set(bearer(pin));
    madeIds.push(first.body.key.id);
    expect((await request(app).post(url).set(bearer(pin))).status).toBe(409);
    const other = await create(pin, { name: "Other", agentRole: "admin" });
    await request(app).post(`/settings/agent-keys/${other.body.key.id}/revoke`).set(bearer(pin)).send({});
    expect((await request(app).post(`/settings/agent-keys/${other.body.key.id}/rotate`).set(bearer(pin))).status).toBe(409);
    expect((await request(app).post("/settings/agent-keys/nope/rotate").set(bearer(pin))).status).toBe(404);
  });

  it("revoke is the exit: the very next agent call is 401 key_revoked, the row stays, and revoking again changes nothing", async () => {
    const pin = await pinToken();
    const made = await create(pin);
    const gate = gateApp();
    expect((await request(gate).get("/ping").set(bearer(made.body.secret))).status).toBe(200);
    const rev = await request(app).post(`/settings/agent-keys/${made.body.key.id}/revoke`).set(bearer(pin)).send({ reason: "leaked in a chat" });
    expect(rev.status).toBe(200);
    expect(rev.body.key).toMatchObject({ status: "revoked", revokedReason: "leaked in a chat" });
    const next = await request(gate).get("/ping").set(bearer(made.body.secret));
    expect(next.status).toBe(401);
    expect(next.body.code).toBe("key_revoked");
    const again = await request(app).post(`/settings/agent-keys/${made.body.key.id}/revoke`).set(bearer(pin)).send({});
    expect(again.body.key.revokedAt).toBe(rev.body.key.revokedAt);
    expect(await prisma.agentKey.findUnique({ where: { id: made.body.key.id } })).toBeTruthy();
    expect((await request(app).post("/settings/agent-keys/nope/revoke").set(bearer(pin)).send({})).status).toBe(404);
  });

  it("revoking a retiring key stops it at once (the card's Revoke now)", async () => {
    const pin = await pinToken();
    const made = await create(pin);
    const rot = await request(app).post(`/settings/agent-keys/${made.body.key.id}/rotate`).set(bearer(pin));
    madeIds.push(rot.body.key.id);
    await request(app).post(`/settings/agent-keys/${made.body.key.id}/revoke`).set(bearer(pin)).send({});
    expect((await request(gateApp()).get("/ping").set(bearer(made.body.secret))).body.code).toBe("key_revoked");
    expect((await request(gateApp()).get("/ping").set(bearer(rot.body.secret))).status).toBe(200);
  });

  it("there is no way to delete a key", async () => {
    const pin = await pinToken();
    const made = await create(pin);
    expect((await request(app).delete(`/settings/agent-keys/${made.body.key.id}`).set(bearer(pin))).status).toBe(404);
    expect(await prisma.agentKey.findUnique({ where: { id: made.body.key.id } })).toBeTruthy();
  });
});

describe("the kill switch: one writer, PUT /owner-settings/agentAccess", () => {
  it("Kyle sets the mode and the SERVER stamps who and when; client-supplied stamps are ignored", async () => {
    const pin = await pinToken();
    const before = Date.now();
    const put = await request(app).put("/owner-settings/agentAccess").set(bearer(pin))
      .send({ mode: "read_only", changedAt: "2001-01-01T00:00:00Z", changedBy: "Someone Else" });
    expect(put.status).toBe(200);
    expect(put.body.value.mode).toBe("read_only");
    expect(put.body.value.changedBy).toBe("Kyle");
    expect(new Date(put.body.value.changedAt).getTime()).toBeGreaterThanOrEqual(before - 1000);
    const list = await request(app).get("/settings/agent-keys").set(bearer(pin));
    expect(list.body.agentAccess).toEqual(put.body.value);
  });

  it("a person holding bot_keys is stamped with their own name; the mode goes through to the gate at once", async () => {
    const made = await create(await pinToken());
    const token = await personToken("michael", ["bot_keys"]);
    const put = await request(app).put("/owner-settings/agentAccess").set(bearer(token)).send({ mode: "off" });
    expect(put.status).toBe(200);
    expect(put.body.value.changedBy).toBe("Michael Test");
    const res = await request(gateApp()).get("/ping").set(bearer(made.body.secret));
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("agents_off");
    const resume = await request(app).put("/owner-settings/agentAccess").set(bearer(token)).send({ mode: "on" });
    expect(resume.body.value.mode).toBe("on");
    expect((await request(gateApp()).get("/ping").set(bearer(made.body.secret))).status).toBe(200);
  });

  it("every change is logged: a SystemEvent from agent_keys with the actor, the mode it was and the mode it became", async () => {
    const pin = await pinToken();
    await prisma.systemEvent.deleteMany({ where: { source: "agent_keys", message: { startsWith: "Agent access set to" } } });
    await request(app).put("/owner-settings/agentAccess").set(bearer(pin)).send({ mode: "off" });
    const token = await personToken("michael", ["bot_keys"]);
    await request(app).put("/owner-settings/agentAccess").set(bearer(token)).send({ mode: "on" });
    await new Promise((r) => setTimeout(r, 200));
    const events = await prisma.systemEvent.findMany({
      where: { source: "agent_keys", message: { startsWith: "Agent access set to" } }, orderBy: { createdAt: "asc" },
    });
    expect(events.map((e) => e.message)).toEqual(["Agent access set to off", "Agent access set to on"]);
    expect(JSON.parse(events[0].detailsJson!)).toMatchObject({ actor: "Kyle", from: "on", to: "off" });
    expect(JSON.parse(events[1].detailsJson!)).toMatchObject({ actor: "Michael Test", from: "off", to: "on" });
    // A refused change (bad mode) leaves no event.
    await request(app).put("/owner-settings/agentAccess").set(bearer(pin)).send({ mode: "sideways" });
    await new Promise((r) => setTimeout(r, 100));
    expect(await prisma.systemEvent.count({ where: { source: "agent_keys", message: { startsWith: "Agent access set to" } } })).toBe(2);
  });

  it("refuses a bad mode (400) and a missing mode, and stores nothing", async () => {
    const pin = await pinToken();
    expect((await request(app).put("/owner-settings/agentAccess").set(bearer(pin)).send({ mode: "sideways" })).status).toBe(400);
    expect((await request(app).put("/owner-settings/agentAccess").set(bearer(pin)).send({})).status).toBe(400);
    expect((await request(app).put("/owner-settings/agentAccess").set(bearer(pin)).send("off")).status).toBe(400);
    expect(await prisma.companySetting.findUnique({ where: { key: "agentAccess" } })).toBeNull();
  });

  it("the bot_keys power does not open the other owner settings: quietHours stays Kyle only", async () => {
    const token = await personToken("michael", ["bot_keys"]);
    const res = await request(app).put("/owner-settings/quietHours").set(bearer(token)).send({ start: "09:00", end: "18:00" });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Only Kyle can see or change this setting." });
  });

  it("there is no second route for the switch", async () => {
    const pin = await pinToken();
    expect((await request(app).put("/settings/agent-access").set(bearer(pin)).send({ mode: "off" })).status).toBe(404);
    expect((await request(app).put("/settings/agent-keys/access").set(bearer(pin)).send({ mode: "off" })).status).toBeGreaterThanOrEqual(400);
  });
});
