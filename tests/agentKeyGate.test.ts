import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { hashPin } from "../src/middleware/pinAuth";
import { entryCovers } from "../src/middleware/publicRoutes";
import { AGENT_KEY_ROUTES, agentKeyRouteFor, createAgentKeyGate, finishAgentCall, type AgentKeyRoute } from "../src/agentApi/gate";
import {
  AGENT_KEY_SHAPE, hashAgentKey, isAgentKeyShaped, mintAgentKey, type MintAgentKeyInput,
} from "../src/agentApi/keys";
import { chicagoDayStart } from "../src/agentApi/audit";
import { AGENT_SCOPE_KEYS, DEFAULT_SCOPES_BY_ROLE, isAgentScope } from "../shared/agentScopes";
import { cleanupCrmLoginFixtures, makePerson } from "./helpers/crmLoginFixture";

/**
 * Work order agent-team, K-U1: ONE agent-key store and ONE gate. The real app lists only the three K-U7
 * hub routes in AGENT_KEY_ROUTES (tests/hubBotDoor.test.ts drives those), so most of these mount the gate on
 * a test express app with dummy routes. The human-door tests use the real app.
 */

const JWT_SECRET = process.env.JWT_SECRET ?? "rce-dev-secret-change-me";
const PIN = "1234";
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

const ROUTES: AgentKeyRoute[] = [
  { methods: ["GET"], path: "/ping", scope: "crm:read", tool: "test.ping", reason: "test" },
  { methods: ["POST"], path: "/note", scope: "notes:write", write: true, tool: "test.note", reason: "test" },
  { methods: ["POST"], path: "/draft", scope: "hub:draft", write: true, draft: true, tool: "test.draft", reason: "test" },
  { methods: ["GET"], path: "/any", scope: "any", tool: "test.any", reason: "test" },
];

function testApp(options: Parameters<typeof createAgentKeyGate>[0] = {}) {
  const a = express();
  a.use(express.json());
  a.use(createAgentKeyGate({ routes: ROUTES, ...options }));
  const ok = (req: express.Request, res: express.Response) =>
    void finishAgentCall(req, res, {
      status: 200,
      body: { ok: true, actor: (req as { _authActor?: string })._authActor, outcome: (req as { _authOutcome?: string })._authOutcome },
    });
  a.get("/ping", ok);
  a.get("/any", ok);
  a.get("/unlisted", ok);
  a.post("/note", ok);
  a.post("/draft", (req, res) => void finishAgentCall(req, res, { status: 200, body: { ok: true }, madeDraft: true }));
  return a;
}

const madeKeyIds: string[] = [];
async function mint(overrides: Partial<MintAgentKeyInput> = {}) {
  const made = await mintAgentKey({ name: `gate test ${randomUUID().slice(0, 8)}`, agentRole: "admin", createdBy: "owner", ...overrides });
  madeKeyIds.push(made.row.id);
  return made;
}

let savedPepper: string | undefined;
let savedEnvName: string | undefined;
beforeAll(() => {
  savedPepper = process.env.AGENT_KEY_PEPPER;
  savedEnvName = process.env.RAILWAY_ENVIRONMENT_NAME;
  process.env.AGENT_KEY_PEPPER = "test-pepper-for-the-agent-gate-suite";
  delete process.env.RAILWAY_ENVIRONMENT_NAME;
});
afterAll(async () => {
  if (savedPepper === undefined) delete process.env.AGENT_KEY_PEPPER; else process.env.AGENT_KEY_PEPPER = savedPepper;
  if (savedEnvName === undefined) delete process.env.RAILWAY_ENVIRONMENT_NAME; else process.env.RAILWAY_ENVIRONMENT_NAME = savedEnvName;
  await prisma.companySetting.deleteMany({ where: { key: "agentAccess" } });
  await prisma.agentKey.deleteMany({ where: { id: { in: madeKeyIds } } });
  await cleanupCrmLoginFixtures();
});
beforeEach(async () => {
  await prisma.companySetting.deleteMany({ where: { key: "agentAccess" } });
});

async function setMode(mode: "on" | "read_only" | "off") {
  const valueJson = JSON.stringify({ mode, changedAt: null, changedBy: null });
  await prisma.companySetting.upsert({ where: { key: "agentAccess" }, create: { key: "agentAccess", valueJson }, update: { valueJson } });
}

describe("minting and storing a key", () => {
  it("makes rce_test_ + 43 base64url, stores only the HMAC, and never the plaintext", async () => {
    const { key, row } = await mint();
    expect(key).toMatch(AGENT_KEY_SHAPE);
    expect(key.startsWith("rce_test_")).toBe(true);
    expect(row.environment).toBe("test");
    expect(row.displayPrefix).toBe(key.slice(0, 13));
    expect(row.secretHash).toBe(hashAgentKey(key));
    expect(row.secretHash).not.toContain(key.slice(9));
    expect(JSON.stringify(row)).not.toContain(key);
    expect(row.writesEnabled).toBe(false);
  });

  it("labels the key live only on Railway production", async () => {
    process.env.RAILWAY_ENVIRONMENT_NAME = "production";
    try {
      const { key, row } = await mint();
      expect(key.startsWith("rce_live_")).toBe(true);
      expect(row.environment).toBe("live");
    } finally {
      delete process.env.RAILWAY_ENVIRONMENT_NAME;
    }
  });

  it("takes the role's default scopes and thread kinds, and refuses a scope that is not in the one enum", async () => {
    const scout = await mint({ agentRole: "scout" });
    expect(scout.row.scopes.sort()).toEqual([...DEFAULT_SCOPES_BY_ROLE.scout].sort());
    expect(scout.row.hubThreadKinds).toEqual(["training"]);
    const claude = await mint({ agentRole: "claude_code" });
    expect(claude.row.scopes.sort()).toEqual(["dev:read", "dev:write"]);
    expect(claude.row.hubThreadKinds).toEqual(["dev"]);
    await expect(mint({ scopes: ["crm:read", "root:everything"] })).rejects.toThrow(/Unknown scope: root:everything/);
  });

  it("has no pepper, no key: minting and hashing throw instead of storing something weak", async () => {
    const saved = process.env.AGENT_KEY_PEPPER;
    delete process.env.AGENT_KEY_PEPPER;
    try {
      expect(() => hashAgentKey("rce_test_x")).toThrow(/AGENT_KEY_PEPPER/);
      await expect(mint()).rejects.toThrow(/AGENT_KEY_PEPPER/);
    } finally {
      process.env.AGENT_KEY_PEPPER = saved;
    }
  });
});

describe("shared/agentScopes.ts", () => {
  it("the defaults only use scopes that exist, and every scope has a one-line label", () => {
    for (const [role, scopes] of Object.entries(DEFAULT_SCOPES_BY_ROLE)) {
      for (const s of scopes) expect(isAgentScope(s), `${role}: ${s}`).toBe(true);
    }
    expect(AGENT_SCOPE_KEYS.length).toBe(27);
    expect(new Set(AGENT_SCOPE_KEYS).size).toBe(AGENT_SCOPE_KEYS.length);
    for (const s of ["hub:read", "hub:draft", "inventory:usage", "campaign:draft", "media:marketing:read", "training:write",
      "crm:read", "leads:write", "leads:draft", "leads:dupcheck", "schedule:propose", "estimate:draft", "estimate:propose_accept",
      "notes:write", "team:reply", "dev:ticket", "inventory:read", "pricebook:propose", "outreach:read", "reviews:confirm",
      "reports:read", "marketing:read", "training:read", "media:original:read", "media:edit:upload", "dev:read", "dev:write"]) {
      expect(isAgentScope(s), s).toBe(true);
    }
  });

  it("gives Facebook the original-photo scopes and Scout training-only hub access", () => {
    expect(DEFAULT_SCOPES_BY_ROLE.facebook).toEqual(
      ["marketing:read", "media:marketing:read", "media:original:read", "campaign:draft", "media:edit:upload"]);
    expect(DEFAULT_SCOPES_BY_ROLE.scout).toContain("hub:read");
    expect(DEFAULT_SCOPES_BY_ROLE.scout).toContain("hub:draft");
    expect(DEFAULT_SCOPES_BY_ROLE.scout).not.toContain("media:original:read");
    expect(DEFAULT_SCOPES_BY_ROLE.other).toEqual([]);
  });
});

describe("AGENT_KEY_ROUTES", () => {
  it("holds exactly the three REST /api/hub/* routes (K-U7) and never an approve, edit-approve, reject, send or audit route", () => {
    expect(AGENT_KEY_ROUTES.map((r) => `${r.methods.join("|")} ${r.path} ${r.scope}`)).toEqual([
      "GET /hub/threads hub:read",
      "GET /hub/threads/:id/messages hub:read",
      "POST /hub/messages hub:draft",
    ]);
    for (const r of AGENT_KEY_ROUTES) expect(r.path).not.toMatch(/approve|reject|send|audit|stream|attachments|push/);
  });

  it("every entry declares a scope that exists (or any) and matches its own path", () => {
    for (const entry of [...AGENT_KEY_ROUTES, ...ROUTES]) {
      expect(entry.scope === "any" || isAgentScope(entry.scope), entry.path).toBe(true);
      expect(entry.methods.length, entry.path).toBeGreaterThan(0);
      const concrete = entry.path.replace(/:[A-Za-z]+/g, "abc123");
      for (const m of entry.methods) {
        expect(m === "*" ? true : entryCovers(entry, m, concrete), `${m} ${entry.path}`).toBe(true);
      }
    }
  });

  it("agentKeyRouteFor matches the way Express routes: case-insensitive, trailing slash, HEAD as GET", () => {
    const list: AgentKeyRoute[] = [
      { methods: ["POST"], path: "/mcp", scope: "any", agentOnly: true, reason: "t" },
      { methods: ["GET"], path: "/Hub/Threads/:id", scope: "hub:read", reason: "t" },
    ];
    expect(agentKeyRouteFor("POST", "/MCP", list)).not.toBeNull();
    expect(agentKeyRouteFor("POST", "/Mcp/", list)).not.toBeNull();
    expect(agentKeyRouteFor("post", "/mcp", list)).not.toBeNull();
    expect(agentKeyRouteFor("HEAD", "/hub/threads/abc", list)).not.toBeNull();
    expect(agentKeyRouteFor("GET", "/HUB/THREADS/abc", list)).not.toBeNull();
    expect(agentKeyRouteFor("HEAD", "/mcp", list)).toBeNull(); // HEAD is GET, and /mcp lists only POST
    expect(agentKeyRouteFor("GET", "/mcp2", list)).toBeNull();
  });

  it("agentKeyRouteFor finds an entry by method and path, and nothing else", () => {
    expect(agentKeyRouteFor("GET", "/ping", ROUTES)?.tool).toBe("test.ping");
    expect(agentKeyRouteFor("POST", "/ping", ROUTES)).toBeNull();
    expect(agentKeyRouteFor("GET", "/elsewhere", ROUTES)).toBeNull();
  });
});

describe("agentKeyGate: refusals", () => {
  it("401 for no credential, garbage, a mangled key, and a JWT; no database read decides it", async () => {
    const a = testApp();
    for (const header of [undefined, "Bearer nonsense", "Bearer rce_test_short", `Bearer ${jwt.sign({ sub: "owner" }, JWT_SECRET)}`]) {
      const req = request(a).get("/ping");
      const res = await (header ? req.set("Authorization", header) : req);
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ code: "unauthenticated", retryable: false });
      expect(res.body.reason).toBeTruthy();
    }
  });

  it("401 for an owner JWT, an ai-admin JWT and a real technician token", async () => {
    const a = testApp();
    const person = await makePerson("Gate Tech");
    const tech = await prisma.technician.findUnique({ where: { id: person.id } });
    for (const token of [
      jwt.sign({ sub: "owner" }, JWT_SECRET),
      jwt.sign({ sub: "ai-admin", ver: 1, aid: "x" }, JWT_SECRET),
      tech!.accessToken,
    ]) {
      const res = await request(a).get("/ping").set(bearer(token));
      expect(res.status).toBe(401);
      expect(res.body.code).toBe("unauthenticated");
    }
  });

  it("401 key_revoked, key_expired, key_retired", async () => {
    const a = testApp();
    const revoked = await mint();
    await prisma.agentKey.update({ where: { id: revoked.row.id }, data: { revokedAt: new Date(), revokedReason: "test" } });
    const expired = await mint({ expiresAt: new Date(Date.now() - 1000) });
    const retired = await mint({ retiresAt: new Date(Date.now() - 24 * 3600 * 1000) });
    const overlap = await mint({ retiresAt: new Date(Date.now() + 3600 * 1000) });
    const code = async (k: string) => (await request(a).get("/ping").set(bearer(k))).body.code;
    expect(await code(revoked.key)).toBe("key_revoked");
    expect(await code(expired.key)).toBe("key_expired");
    expect(await code(retired.key)).toBe("key_retired");
    expect((await request(a).get("/ping").set(bearer(overlap.key))).status).toBe(200);
  });

  it("revoking applies to the very next request (the key row is loaded every time)", async () => {
    const a = testApp();
    const { key, row } = await mint();
    expect((await request(a).get("/ping").set(bearer(key))).status).toBe(200);
    await prisma.agentKey.update({ where: { id: row.id }, data: { revokedAt: new Date() } });
    const res = await request(a).get("/ping").set(bearer(key));
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("key_revoked");
  });

  it("a scope edit shows on the next request", async () => {
    const a = testApp();
    const { key, row } = await mint({ scopes: ["hub:read"] });
    expect((await request(a).get("/ping").set(bearer(key))).status).toBe(403);
    await prisma.agentKey.update({ where: { id: row.id }, data: { scopes: ["crm:read"] } });
    expect((await request(a).get("/ping").set(bearer(key))).status).toBe(200);
  });

  it("401 key_wrong_environment when the label is not this deployment's", async () => {
    const a = testApp();
    const live = await mint({ environment: "live" });
    const res = await request(a).get("/ping").set(bearer(live.key));
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("key_wrong_environment");
    process.env.RAILWAY_ENVIRONMENT_NAME = "production";
    try {
      const test = await mint({ environment: "test" });
      const res2 = await request(a).get("/ping").set(bearer(test.key));
      expect(res2.status).toBe(401);
      expect(res2.body.code).toBe("key_wrong_environment");
    } finally {
      delete process.env.RAILWAY_ENVIRONMENT_NAME;
    }
  });

  it("503 not_configured when AGENT_KEY_PEPPER is unset, even for a well-formed key", async () => {
    const a = testApp();
    const { key } = await mint();
    const saved = process.env.AGENT_KEY_PEPPER;
    delete process.env.AGENT_KEY_PEPPER;
    try {
      const res = await request(a).get("/ping").set(bearer(key));
      expect(res.status).toBe(503);
      expect(res.body.code).toBe("not_configured");
    } finally {
      process.env.AGENT_KEY_PEPPER = saved;
    }
  });

  it("403 scope_denied for a scope the key lacks, and for a path no entry covers (nothing is open by default)", async () => {
    const a = testApp();
    const { key } = await mint({ scopes: ["hub:read"] });
    expect((await request(a).get("/ping").set(bearer(key))).body.code).toBe("scope_denied");
    const open = await mint({ scopes: ["crm:read"] });
    expect((await request(a).get("/unlisted").set(bearer(open.key))).body.code).toBe("scope_denied");
    expect((await request(a).get("/any").set(bearer(key))).status).toBe(200);
  });

  it("403 writes_disabled until the key's writes switch is on", async () => {
    const a = testApp();
    const off = await mint({ scopes: ["notes:write"] });
    const res = await request(a).post("/note").set(bearer(off.key)).send({});
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("writes_disabled");
    const on = await mint({ scopes: ["notes:write"], writesEnabled: true });
    expect((await request(a).post("/note").set(bearer(on.key)).send({})).status).toBe(200);
  });
});

describe("agentKeyGate: the kill switch", () => {
  it("off answers 503 agents_off on the very next request, and on again lets the key through", async () => {
    const a = testApp();
    const { key } = await mint();
    expect((await request(a).get("/ping").set(bearer(key))).status).toBe(200);
    await setMode("off");
    const res = await request(a).get("/ping").set(bearer(key));
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ code: "agents_off", retryable: true });
    await setMode("on");
    expect((await request(a).get("/ping").set(bearer(key))).status).toBe(200);
  });

  it("read_only serves reads and refuses writes and drafts", async () => {
    const a = testApp();
    const { key } = await mint({ scopes: ["crm:read", "notes:write", "hub:draft"], writesEnabled: true });
    await setMode("read_only");
    expect((await request(a).get("/ping").set(bearer(key))).status).toBe(200);
    expect((await request(a).post("/note").set(bearer(key)).send({})).body.code).toBe("agents_read_only");
    expect((await request(a).post("/draft").set(bearer(key)).send({})).body.code).toBe("agents_read_only");
  });

  it("a stored value that is not valid counts as off, not on", async () => {
    const a = testApp();
    const { key } = await mint();
    await prisma.companySetting.upsert({
      where: { key: "agentAccess" }, create: { key: "agentAccess", valueJson: '{"mode":"maybe"}' }, update: { valueJson: '{"mode":"maybe"}' },
    });
    expect((await request(a).get("/ping").set(bearer(key))).body.code).toBe("agents_off");
  });

  it("an unknown or garbage credential is told nothing about the switch", async () => {
    const a = testApp();
    await setMode("off");
    expect((await request(a).get("/ping").set(bearer("rce_test_" + "a".repeat(43)))).body.code).toBe("unauthenticated");
  });
});

describe("agentKeyGate: limits", () => {
  it("the 61st call in a minute is 429 rate_limited with Retry-After and retry_after", async () => {
    const a = testApp();
    const { key } = await mint();
    for (let i = 0; i < 60; i += 1) {
      const res = await request(a).get("/ping").set(bearer(key));
      expect(res.status).toBe(200);
    }
    const res = await request(a).get("/ping").set(bearer(key));
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ code: "rate_limited", retryable: true });
    expect(res.body.retry_after).toBeGreaterThanOrEqual(1);
    expect(Number(res.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    // Another key is unaffected: the limit is per key.
    const other = await mint();
    expect((await request(a).get("/ping").set(bearer(other.key))).status).toBe(200);
  }, 60_000);

  it("a per-IP limiter sits in front of key resolution", async () => {
    const a = testApp({ perIpPerMinute: 3 });
    for (let i = 0; i < 3; i += 1) expect((await request(a).get("/ping")).status).toBe(401);
    const res = await request(a).get("/ping");
    expect(res.status).toBe(429);
    expect(res.body.code).toBe("rate_limited");
  });

  it("the 501st draft in a Chicago day is 429 daily_draft_limit; yesterday's drafts and replays do not count", async () => {
    const a = testApp();
    const { key, row } = await mint({ scopes: ["hub:draft"], writesEnabled: true });
    const base = { agentKeyId: row.id, action: "test.draft", agent: "admin", door: "rest", resultCode: "ok", entityType: "draft" };
    const yesterday = new Date(chicagoDayStart().getTime() - 3_600_000);
    await prisma.agentAuditLog.createMany({ data: Array.from({ length: 50 }, () => ({ ...base, createdAt: yesterday })) });
    await prisma.agentAuditLog.createMany({ data: Array.from({ length: 20 }, () => ({ ...base, resultCode: "replayed", entityType: null })) });
    await prisma.agentAuditLog.createMany({ data: Array.from({ length: 499 }, () => base) });
    const ok = await request(a).post("/draft").set(bearer(key)).send({});
    expect(ok.status).toBe(200); // the 500th
    const res = await request(a).post("/draft").set(bearer(key)).send({}); // the 501st
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ code: "daily_draft_limit", retryable: true });
    expect(res.body.retry_after).toBeGreaterThan(0);
    expect(res.body.retry_after).toBeLessThanOrEqual(24 * 3600 + 3600);
    // Reads are not drafts.
    const reader = await mint({ scopes: ["crm:read"] });
    expect((await request(a).get("/ping").set(bearer(reader.key))).status).toBe(200);
  }, 60_000);
});

describe("agentKeyGate: review fixes", () => {
  it("#7 parallel draft calls at 499 cannot overshoot 500: one gets in, the rest are daily_draft_limit", async () => {
    const a = express();
    a.use(express.json());
    a.use(createAgentKeyGate({ routes: ROUTES }));
    a.post("/draft", async (req, res) => {
      await new Promise((r) => setTimeout(r, 300)); // hold the slot while the others arrive
      await finishAgentCall(req, res, { status: 200, body: { ok: true }, madeDraft: true });
    });
    const { key, row } = await mint({ scopes: ["hub:draft"], writesEnabled: true });
    const base = { agentKeyId: row.id, action: "test.draft", agent: "admin", door: "rest", resultCode: "ok", entityType: "draft" };
    await prisma.agentAuditLog.createMany({ data: Array.from({ length: 499 }, () => base) });
    const results = await Promise.all(Array.from({ length: 8 }, () => request(a).post("/draft").set(bearer(key)).send({})));
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((x) => x === 200)).toHaveLength(1);
    expect(statuses.filter((x) => x === 429)).toHaveLength(7);
    expect(results.filter((r) => r.status === 429).every((r) => r.body.code === "daily_draft_limit")).toBe(true);
    expect(await prisma.agentAuditLog.count({ where: { agentKeyId: row.id, entityType: "draft", resultCode: "ok" } })).toBe(500);
    // The cap still holds afterwards, and no slot is left reserved by the refused calls.
    expect((await request(a).post("/draft").set(bearer(key)).send({})).body.code).toBe("daily_draft_limit");
  }, 60_000);

  it("#7 a slot is given back when a call ends, so reserved slots never leak", async () => {
    const a = testApp();
    const { key, row } = await mint({ scopes: ["hub:draft"], writesEnabled: true });
    for (let i = 0; i < 5; i += 1) expect((await request(a).post("/draft").set(bearer(key)).send({})).status).toBe(200);
    expect(await prisma.agentAuditLog.count({ where: { agentKeyId: row.id, entityType: "draft" } })).toBe(5);
    const small = express();
    small.use(createAgentKeyGate({ routes: ROUTES, dailyDraftLimit: 6 }));
    small.post("/draft", (req, res) => void finishAgentCall(req, res, { status: 200, body: {}, madeDraft: true }));
    expect((await request(small).post("/draft").set(bearer(key))).status).toBe(200); // the 6th
    expect((await request(small).post("/draft").set(bearer(key))).status).toBe(429); // the 7th
  });

  it("#7 a client that disconnects while the gate is still awaiting the database leaves no slot reserved", async () => {
    const a = express();
    a.use(createAgentKeyGate({ routes: ROUTES, dailyDraftLimit: 1 }));
    // Reaches the route but makes nothing, so the count of finished drafts stays 0.
    a.post("/draft", (req, res) => void finishAgentCall(req, res, { status: 200, body: { ok: true } }));
    const { key, row } = await mint({ scopes: ["hub:draft"], writesEnabled: true });
    const server = http.createServer(a);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    // Hold the gate in countDraftsToday long enough for the client to hang up first.
    const slow = vi.spyOn(prisma.agentAuditLog, "count").mockImplementationOnce((async () => {
      await new Promise((r) => setTimeout(r, 400));
      return 0;
    }) as never);
    try {
      await new Promise<void>((resolve) => {
        const aborted = http.request({ host: "127.0.0.1", port, method: "POST", path: "/draft", headers: { Authorization: `Bearer ${key}` } });
        aborted.on("error", () => resolve());
        aborted.end();
        setTimeout(() => aborted.destroy(), 100);
      });
      await new Promise((r) => setTimeout(r, 700)); // the gate finishes its awaits on a dead socket
      // With a leaked slot this would be 429 daily_draft_limit (0 made + 1 phantom >= 1).
      const res = await request(a).post("/draft").set(bearer(key)).send({});
      expect(res.status).toBe(200);
      expect(await prisma.agentAuditLog.count({ where: { agentKeyId: row.id, resultCode: "daily_draft_limit" } })).toBe(0);
    } finally {
      slow.mockRestore();
      await new Promise((r) => server.close(r));
    }
  }, 30_000);

  it("#8 the audit's endpoint is the matched entry's declared path, never what the sender typed", async () => {
    const routes: AgentKeyRoute[] = [
      { methods: ["GET"], path: "/hub", prefix: true, scope: "any", reason: "t" },
      { methods: ["POST"], path: "/mcp", scope: "any", agentOnly: true, reason: "t" },
    ];
    const a = express();
    a.use(createAgentKeyGate({ routes }));
    const junk = "jane.doe%40example.com/" + "x".repeat(500);
    const forged = "rce_test_" + "Qq1".repeat(14) + "Z";
    const before = Date.now() - 1;
    await request(a).get(`/hub/${junk}`).set(bearer(forged));
    await request(a).post("/MCP").set(bearer(forged));
    await request(a).get(`/nowhere/${junk}`).set(bearer(forged));
    const rows = await prisma.agentAuditLog.findMany({
      where: { agentKeyId: null, createdAt: { gte: new Date(before) } }, orderBy: { createdAt: "asc" },
    });
    const mine = rows.filter((r) => ["GET /hub", "POST /mcp", "GET unmatched"].includes(r.endpoint ?? ""));
    expect(mine.map((r) => r.endpoint)).toEqual(["GET /hub", "POST /mcp", "GET unmatched"]);
    for (const r of rows) {
      expect(JSON.stringify(r)).not.toContain("jane.doe");
      expect((r.endpoint ?? "").length).toBeLessThan(40);
      expect((r.action ?? "").length).toBeLessThan(40);
    }
    expect(mine[1].door).toBe("mcp");
  });

  it("#9 a gate failure that becomes a 500 still leaves its audit row", async () => {
    const a = testApp();
    const { key, row } = await mint({ scopes: ["hub:draft"], writesEnabled: true });
    const spy = vi.spyOn(prisma.agentAuditLog, "count").mockRejectedValueOnce(new Error("slow query timed out"));
    try {
      const res = await request(a).post("/draft").set(bearer(key)).send({});
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ code: "internal", reason: expect.any(String), retryable: true });
      expect(JSON.stringify(res.body)).not.toContain("slow query");
    } finally {
      spy.mockRestore();
    }
    const rows = await prisma.agentAuditLog.findMany({ where: { agentKeyId: row.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ resultCode: "internal", responseStatus: 500, endpoint: "POST /draft" });
  });
});

describe("agentKeyGate: a key that passes", () => {
  it("sets the principal, names the actor agent:<name> (never the key), marks the outcome, and stamps lastUsedAt", async () => {
    const a = testApp();
    const { key, row } = await mint({ name: "Admin Agent" });
    const res = await request(a).get("/ping").set(bearer(key));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, actor: "agent:Admin Agent", outcome: "agent-key" });
    expect(JSON.stringify(res.body)).not.toContain(key);
    await new Promise((r) => setTimeout(r, 150));
    const after = await prisma.agentKey.findUnique({ where: { id: row.id } });
    expect(after?.lastUsedAt).toBeTruthy();
  });

  it("writes lastUsedAt at most once a minute", async () => {
    const a = testApp();
    const { key, row } = await mint();
    await request(a).get("/ping").set(bearer(key));
    await new Promise((r) => setTimeout(r, 150));
    const first = (await prisma.agentKey.findUnique({ where: { id: row.id } }))!.lastUsedAt!;
    await request(a).get("/ping").set(bearer(key));
    await new Promise((r) => setTimeout(r, 150));
    const second = (await prisma.agentKey.findUnique({ where: { id: row.id } }))!.lastUsedAt!;
    expect(second.getTime()).toBe(first.getTime());
  });
});

describe("agent keys on the human doors (the real app, PIN set)", () => {
  let savedPin: string | undefined;
  beforeAll(async () => {
    savedPin = process.env.PIN_HASH;
    process.env.PIN_HASH = await hashPin(PIN);
  });
  afterAll(() => {
    if (savedPin === undefined) delete process.env.PIN_HASH; else process.env.PIN_HASH = savedPin;
  });
  afterEach(() => {
    AGENT_KEY_ROUTES.length = 0;
  });

  it("a valid agent key on a session route (/accounts) is 401 and never reaches a session", async () => {
    const { key } = await mint({ scopes: ["crm:read"] });
    const res = await request(app).get("/accounts").set(bearer(key));
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("agent_key_not_accepted");
    // The key is not a session: the same key is refused on the session refresh and who-am-I too.
    expect((await request(app).get("/auth/session").set(bearer(key))).status).toBe(401);
    expect((await request(app).post("/auth/refresh").set(bearer(key))).status).toBe(401);
  });

  it("a valid agent key on /health-record/* is 401 (the field door refuses it before any lookup)", async () => {
    const { key } = await mint({ scopes: ["crm:read"] });
    const res = await request(app).get("/health-record/me").set(bearer(key));
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("unauthorized");
  });

  it("is on the public allowlist nowhere: key-shaped bearers are agent keys, not a public credential", async () => {
    expect(isAgentKeyShaped("rce_live_" + "a".repeat(43))).toBe(true);
    expect(isAgentKeyShaped("rce_test_whatever")).toBe(true);
    expect(isAgentKeyShaped("eyJhbGciOi")).toBe(false);
    expect(isAgentKeyShaped(undefined)).toBe(false);
  });

  it("an owner session on a listed agent-only route is 401, and a key on it goes to the agent gate", async () => {
    AGENT_KEY_ROUTES.push({ methods: ["GET"], path: "/__agent_gate_probe", scope: "crm:read", agentOnly: true, reason: "test" });
    const pin = await request(app).post("/auth/pin").send({ pin: PIN });
    const owner = pin.body.token as string;
    // The owner JWT never reaches the session on an agent-only route.
    const ownerRes = await request(app).get("/__agent_gate_probe").set(bearer(owner));
    expect(ownerRes.status).toBe(401);
    expect(ownerRes.body.code).toBe("unauthenticated");
    // No credential at all: the agent gate answers, not the session gate.
    expect((await request(app).get("/__agent_gate_probe")).body.code).toBe("unauthenticated");
    // A good key passes the gate (the app has no such route, so the next stop is a 404, not a 401).
    const good = await mint({ scopes: ["crm:read"] });
    expect((await request(app).get("/__agent_gate_probe").set(bearer(good.key))).status).toBe(404);
    // A key without the scope is a 403 from the agent gate.
    const weak = await mint({ scopes: ["hub:read"] });
    expect((await request(app).get("/__agent_gate_probe").set(bearer(weak.key))).status).toBe(403);
  });

  it("a different case, a trailing slash or HEAD cannot get a human session onto an agent-only route", async () => {
    AGENT_KEY_ROUTES.push({ methods: ["GET", "POST"], path: "/__agent_gate_probe", scope: "crm:read", agentOnly: true, reason: "test" });
    const owner = (await request(app).post("/auth/pin").send({ pin: PIN })).body.token as string;
    const aiAdmin = jwt.sign({ sub: "ai-admin", ver: 1, aid: "x" }, JWT_SECRET);
    for (const token of [owner, aiAdmin, null]) {
      const send = (r: request.Test) => (token ? r.set(bearer(token)) : r);
      for (const res of [
        await send(request(app).post("/__AGENT_GATE_PROBE")),
        await send(request(app).post("/__Agent_Gate_Probe/")),
        await send(request(app).get("/__agent_gate_probe/")),
        await send(request(app).head("/__agent_gate_probe")),
        await send(request(app).head("/__Agent_Gate_Probe")),
      ]) {
        expect(res.status).toBe(401);
      }
    }
    // The same spellings with a good key reach the gate and pass it (the app has no such route: 404).
    const good = await mint({ scopes: ["crm:read"] });
    expect((await request(app).get("/__AGENT_GATE_PROBE").set(bearer(good.key))).status).toBe(404);
  });

  it("with no PIN_HASH, a different case or HEAD still gets 401 on an agent-only route", async () => {
    const saved = process.env.PIN_HASH;
    delete process.env.PIN_HASH;
    try {
      AGENT_KEY_ROUTES.push({ methods: ["GET", "POST"], path: "/__agent_gate_probe", scope: "crm:read", agentOnly: true, reason: "test" });
      expect((await request(app).post("/__AGENT_GATE_PROBE")).status).toBe(401);
      expect((await request(app).post("/__Agent_Gate_Probe/")).status).toBe(401);
      expect((await request(app).head("/__agent_gate_probe")).status).toBe(401);
    } finally {
      process.env.PIN_HASH = saved;
    }
  });

  it("a gate-disabled environment (no PIN_HASH) still enforces keys on an agent route", async () => {
    const saved = process.env.PIN_HASH;
    delete process.env.PIN_HASH;
    try {
      AGENT_KEY_ROUTES.push({ methods: ["GET"], path: "/__agent_gate_probe", scope: "crm:read", agentOnly: true, reason: "test" });
      expect((await request(app).get("/__agent_gate_probe")).status).toBe(401);
      expect((await request(app).get("/__agent_gate_probe").set(bearer("not-a-key"))).status).toBe(401);
      const good = await mint({ scopes: ["crm:read"] });
      expect((await request(app).get("/__agent_gate_probe").set(bearer(good.key))).status).toBe(404);
      const weak = await mint({ scopes: ["hub:read"] });
      expect((await request(app).get("/__agent_gate_probe").set(bearer(weak.key))).status).toBe(403);
    } finally {
      process.env.PIN_HASH = saved;
    }
  });
});
