/**
 * W2 batch B (Kyle, 2026-11-23): the agents' /mcp door. "Accept agent keys ... on /mcp (whoami included) for any key with the matching scope",
 * "audit log of every agent read, post, approval" and the Research and CFO read-only data (R-f). Real HTTP through the app and the test database.
 *
 * Pinned here:
 *   - the matrix: initialize, tools/list and tools/call whoami work for all nine roles with their default scopes (Kyle's MCP column of the test plan);
 *   - the door: no bearer 401, a session PIN token / a technician token 401, a revoked key 401, GET and DELETE 405 JSON (never index.html, even with
 *     Accept text/html), the /api prefix works, stateless (no session id issued), nothing about /mcp is public;
 *   - the hub tools are the SAME code as REST: list_threads / read_thread / post_message answer exactly what REST answers for the same key; a Team post is
 *     posted, a customer draft is pending_approval with its reason, Research / CFO / NEC Coach are refused on a customer thread with the scope + label
 *     sentence, an idempotent replay returns the same message id (through MCP, and across MCP and REST), the 8-in-a-row agent limit applies, and the writes
 *     switch and the kill switch are checked inside the tool;
 *   - Research and CFO read tools: ids, status, dates, money and a first name only (a fixture that has phone, email, street, last name, notes, titles,
 *     pay rates and check numbers set shows none of them), the test account left out, and the right tools refused to the wrong keys, naming the scope;
 *   - the audit: every tool call (success and refusal) leaves one AgentAuditLog row with door mcp, the tool, the scope that allowed it and the key's name;
 *   - secret egress: no key value appears in any MCP response, audit row or log line.
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

import { app, spaFallbackServes } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { hashPin } from "../src/middleware/pinAuth";
import { mintAgentKey } from "../src/agentApi/keys";
import { AGENT_DAILY_DRAFT_LIMIT } from "../src/agentApi/audit";
import { AGENT_TOOLS } from "../src/agentApi/tools";
import { THREAD_AGENT_POST_LIMIT } from "../src/agentApi/hubDoor";
import { ensureThreadFor } from "../src/services/hub";
import { AGENT_ROLES, DEFAULT_SCOPES_BY_ROLE, type AgentRole } from "../shared/agentScopes";

const TAG = "McpW2";
const PIN = "1234";
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const idem = () => `idem-${randomUUID()}`;
const PHONE = "(615) 555-0142";
const EMAIL = `${TAG.toLowerCase()}@homeowner.example`;
const STREET = "88 Cedar Hollow Court";
// Everything the Research and CFO answers must never carry.
const FORBIDDEN = ["Quillfeather", "555-0142", "5550142", EMAIL, "Cedar Hollow", "SECRET-PURPOSE", "SECRET-NOTE", "SECRET-TITLE", "SECRET-SCOPE", "SECRET-PAYNOTE", "4417", "Techwell", "61.37", "hourlyRate"];

let savedPin: string | undefined;
let savedPepper: string | undefined;
let savedEnvName: string | undefined;
let pin = "";
let customerId = "";
let propertyId = "";
let techId = "";
let techToken = "";
let teamThreadId = "";
let loopThreadId = "";
let jobThreadId = "";
let visit1 = "";
let visit2 = "";
let testVisit = "";
let invoiceId = "";
let testInvoiceId = "";
let payment1 = "";
const keyIds: string[] = [];
const secrets: string[] = [];
/** Every response body text this file receives, for the egress check. */
const texts: string[] = [];
const customerIds: string[] = [];

type Made = { id: string; secret: string; name: string; role: AgentRole };

async function keyFor(role: AgentRole, over: { scopes?: string[]; writesEnabled?: boolean; teamPostsPublish?: boolean } = {}): Promise<Made> {
  const name = `${TAG} ${role} ${randomUUID().slice(0, 5)}`;
  const made = await mintAgentKey({
    name, agentRole: role, createdBy: "owner", writesEnabled: over.writesEnabled ?? true, scopes: over.scopes, teamPostsPublish: over.teamPostsPublish,
  });
  keyIds.push(made.row.id);
  secrets.push(made.key);
  return { id: made.row.id, secret: made.key, name, role };
}
async function setMode(mode: "on" | "read_only" | "off") {
  const valueJson = JSON.stringify({ mode, changedAt: null, changedBy: null });
  await prisma.companySetting.upsert({ where: { key: "agentAccess" }, create: { key: "agentAccess", valueJson }, update: { valueJson } });
}

/** One JSON-RPC request to /mcp. */
async function rpc(secret: string | null, method: string, params?: Record<string, unknown>, path = "/mcp") {
  let r = request(app).post(path).set("Accept", "application/json, text/event-stream");
  if (secret) r = r.set(bearer(secret));
  const res = await r.send({ jsonrpc: "2.0", id: 1, method, params });
  texts.push(res.text ?? "");
  return res;
}
/** tools/call, the tool's answer parsed. */
async function tool(secret: string, name: string, args: Record<string, unknown> = {}) {
  const res = await rpc(secret, "tools/call", { name, arguments: args });
  expect(res.status, res.text).toBe(200);
  const result = res.body.result as { content: Array<{ text: string }>; isError?: boolean };
  return { isError: result.isError === true, body: JSON.parse(result.content[0]!.text) as Record<string, any>, text: result.content[0]!.text };
}
const get = (secret: string, url: string) => request(app).get(url).set(bearer(secret));
const restPost = (secret: string, body: Record<string, unknown>) => request(app).post("/api/hub/messages").set(bearer(secret)).send(body);
const ageAiPosts = () => prisma.hubMessage.updateMany({
  where: { authorType: { in: ["ai_agent", "claude"] }, threadId: { in: [teamThreadId, loopThreadId, jobThreadId] } },
  data: { createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000) },
});
const auditRows = (keyId: string) => prisma.agentAuditLog.findMany({ where: { agentKeyId: keyId }, orderBy: { createdAt: "asc" } });

const logLines: string[] = [];

beforeAll(async () => {
  savedPin = process.env.PIN_HASH;
  savedPepper = process.env.AGENT_KEY_PEPPER;
  savedEnvName = process.env.RAILWAY_ENVIRONMENT_NAME;
  process.env.PIN_HASH = await hashPin(PIN);
  process.env.AGENT_KEY_PEPPER = "test-pepper-for-the-w2-mcp-suite";
  delete process.env.RAILWAY_ENVIRONMENT_NAME;
  for (const level of ["log", "info", "warn", "error"] as const) {
    const original = console[level].bind(console);
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logLines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")); original(...(args as [unknown])); });
  }
  pin = (await request(app).post("/auth/pin").send({ pin: PIN })).body.token as string;

  const customer = await prisma.customer.create({
    data: {
      name: "Mabel Quillfeather", email: EMAIL, phone: PHONE,
      properties: { create: { name: "Home", addressLine1: STREET, city: "Smyrna", state: "TN", postalCode: "37167" } },
    },
    include: { properties: true },
  });
  customerId = customer.id;
  customerIds.push(customerId);
  propertyId = customer.properties[0]!.id;
  const tech = await prisma.technician.create({ data: { name: "Orson Techwell", accessToken: `${TAG}-tok-${randomUUID()}`, isActive: true, hourlyRate: 61.37 } });
  techId = tech.id;
  techToken = tech.accessToken;

  // Team threads (one per test group so the agent-to-agent counts never meet).
  teamThreadId = (await prisma.hubThread.create({ data: { kind: "team", title: `${TAG} Orson team`, technicianId: techId } })).id;
  loopThreadId = (await prisma.hubThread.create({ data: { kind: "team", title: `${TAG} loop team` } })).id;
  for (const threadId of [teamThreadId, loopThreadId]) {
    await prisma.hubMessage.create({
      data: { threadId, authorType: "tech", authorKey: `tech:${techId}`, authorTechnicianId: techId, authorDisplay: "Orson Techwell", channel: "in_app", direction: "internal", body: "Orson here.", status: "posted" },
    });
  }

  // The reporting fixture: dates in March 2020 so no other file's rows meet it.
  const v1 = await prisma.visit.create({
    data: {
      customerId, propertyId, mode: "service_diagnostic", status: "completed", jobType: "Panel Upgrade",
      purpose: `SECRET-PURPOSE call Mabel at ${PHONE}`, notes: "SECRET-NOTE", visitDate: new Date("2020-03-01T15:00:00Z"),
      scheduledStart: new Date("2020-03-05T15:00:00Z"), scheduledEnd: new Date("2020-03-05T17:00:00Z"), completedAt: new Date("2020-03-05T17:00:00Z"),
      revenue: 4200, laborHours: 6.5,
    },
  });
  visit1 = v1.id;
  const v2 = await prisma.visit.create({
    data: { customerId, propertyId, mode: "service_diagnostic", status: "scheduled", jobType: "Lighting", visitDate: new Date("2020-03-02T15:00:00Z"), scheduledStart: new Date("2020-03-06T15:00:00Z") },
  });
  visit2 = v2.id;
  jobThreadId = (await prisma.hubThread.create({ data: { kind: "job", title: `${TAG} crew chat`, visitId: visit1 } })).id;
  await prisma.hubMessage.create({
    data: { threadId: jobThreadId, authorType: "tech", authorKey: `tech:${techId}`, authorTechnicianId: techId, authorDisplay: "Orson Techwell", channel: "in_app", direction: "internal", body: "Crew chat.", status: "posted" },
  });
  await prisma.visitAssignment.create({ data: { visitId: visit1, technicianId: techId } });

  await prisma.priceBookSupplier.create({ data: { id: `${TAG}-SUP`, name: `${TAG} Supply`, quotable: "YES" } });
  const draft = await prisma.priceBookDraftEstimate.create({ data: { title: `${TAG} draft`, supplierId: `${TAG}-SUP` } });
  const estimate = async (cust: string, prop: string, number: string, visitId: string) => prisma.issuedEstimate.create({
    data: {
      number, token: `${TAG}${randomUUID().replace(/-/g, "")}`.padEnd(64, "0"), status: "signed", draftId: draft.id, customerId: cust,
      serviceAddressId: prop, customerName: "Mabel Quillfeather", customerEmail: EMAIL, customerPhone: PHONE, serviceAddress: `${STREET}, Smyrna, TN`,
      title: "SECRET-TITLE", scopeText: "SECRET-SCOPE", workSubtotal: 1000, tripCharge: 0, total: 1000,
      signedAt: new Date("2020-03-02T16:00:00Z"), jobVisitId: visitId, visitId,
      options: { create: [{ option: "A", label: "Panel", subtotal: 1000, lineCount: 1 }] },
    },
  });
  invoiceId = (await estimate(customerId, propertyId, `2020-${TAG}-1`, visit1)).id;
  payment1 = (await prisma.payment.create({
    data: {
      customerId, estimateId: invoiceId, visitId: visit1, amount: 333.33, method: "check", kind: "deposit", status: "paid", paidAt: new Date("2020-03-03T16:00:00Z"),
      note: "SECRET-PAYNOTE", checkNumber: "4417",
    },
  })).id;
  // A lead or two (the counts are by source and platform only).
  const lead = (extra: Record<string, unknown>) => prisma.lead.create({
    data: { name: "Lena Leadperson", email: `lead-${EMAIL}`, phone: "(615) 555-0177", receivedAt: new Date("2020-03-04T12:00:00Z"), ...extra } as never,
  });
  await lead({ source: "web", platform: "google" });
  await lead({ source: "web", platform: "google" });
  await lead({ source: "phone", platform: "yelp" });
  await lead({ source: "phone", platform: "yelp", callType: "wrong_number" });

  // The TEST account: the same shapes, all of which must stay out of every figure.
  const test = await prisma.customer.create({
    data: {
      name: "Tess Testaccount", isTestAccount: true,
      properties: { create: { name: "Home", addressLine1: "1 Practice Lane", city: "Smyrna", state: "TN", postalCode: "37167" } },
    },
    include: { properties: true },
  });
  customerIds.push(test.id);
  const tv = await prisma.visit.create({
    data: { customerId: test.id, propertyId: test.properties[0]!.id, mode: "service_diagnostic", status: "completed", visitDate: new Date("2020-03-01T16:00:00Z"), scheduledStart: new Date("2020-03-05T16:00:00Z") },
  });
  testVisit = tv.id;
  testInvoiceId = (await estimate(test.id, test.properties[0]!.id, `2020-${TAG}-T`, tv.id)).id;
  await prisma.payment.create({
    data: { customerId: test.id, estimateId: testInvoiceId, visitId: tv.id, amount: 111, method: "check", kind: "deposit", status: "paid", paidAt: new Date("2020-03-03T17:00:00Z") },
  });
  await prisma.lead.create({
    data: { name: "Tess Lead", receivedAt: new Date("2020-03-04T12:00:00Z"), source: "web", platform: "google", customerId: test.id } as never,
  });
});

afterAll(async () => {
  vi.restoreAllMocks();
  if (savedPin === undefined) delete process.env.PIN_HASH; else process.env.PIN_HASH = savedPin;
  if (savedPepper === undefined) delete process.env.AGENT_KEY_PEPPER; else process.env.AGENT_KEY_PEPPER = savedPepper;
  if (savedEnvName === undefined) delete process.env.RAILWAY_ENVIRONMENT_NAME; else process.env.RAILWAY_ENVIRONMENT_NAME = savedEnvName;
  await prisma.companySetting.deleteMany({ where: { key: { in: ["agentAccess", "hubAutoSend"] } } });
  await prisma.hubThread.deleteMany({ where: { OR: [{ customerId: { in: customerIds } }, { title: { startsWith: TAG } }] } });
  await prisma.agentIdempotency.deleteMany({ where: { agentKeyId: { in: keyIds } } });
  await prisma.agentKey.deleteMany({ where: { id: { in: keyIds } } });
  await prisma.payment.deleteMany({ where: { customerId: { in: customerIds } } });
  await prisma.issuedEstimate.deleteMany({ where: { customerId: { in: customerIds } } });
  await prisma.priceBookDraftEstimate.deleteMany({ where: { title: `${TAG} draft` } });
  await prisma.priceBookSupplier.deleteMany({ where: { id: `${TAG}-SUP` } });
  await prisma.visitAssignment.deleteMany({ where: { technicianId: techId } });
  await prisma.visit.deleteMany({ where: { customerId: { in: customerIds } } });
  await prisma.lead.deleteMany({ where: { OR: [{ customerId: { in: customerIds } }, { email: `lead-${EMAIL}` }] } });
  await prisma.property.deleteMany({ where: { customerId: { in: customerIds } } });
  await prisma.customer.deleteMany({ where: { id: { in: customerIds } } });
  await prisma.technician.deleteMany({ where: { id: techId } });
});

beforeEach(async () => {
  await prisma.companySetting.deleteMany({ where: { key: { in: ["agentAccess", "hubAutoSend"] } } });
  await ageAiPosts();
});

// ── the matrix ───────────────────────────────────────────────────────────────────────────────────

const NINE: AgentRole[] = ["admin", "inventory", "facebook", "outreach", "scout", "research", "cfo", "nec_coach", "claude_code"];

describe("Kyle's MCP column: initialize, tools/list and whoami for the nine roles with their default scopes", () => {
  it("covers exactly the nine roles Kyle named", () => {
    expect([...NINE].sort()).toEqual(AGENT_ROLES.filter((r) => r !== "other").sort());
  });

  for (const role of NINE) {
    it(`${role}: initialize, tools/list and tools/call whoami succeed, and whoami tells the truth about the key`, async () => {
      const k = await keyFor(role);
      const init = await rpc(k.secret, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "w2-test", version: "1" } });
      expect(init.status, init.text).toBe(200);
      expect(init.body.result.serverInfo.name).toBe("rce-agent-door");
      expect(init.headers["mcp-session-id"], "stateless: no session id is ever issued").toBeUndefined();

      const list = await rpc(k.secret, "tools/list", {});
      expect(list.status, list.text).toBe(200);
      const names: string[] = list.body.result.tools.map((t: { name: string }) => t.name);
      expect(names).toContain("whoami");
      for (const t of list.body.result.tools) expect(t.inputSchema.type, t.name).toBe("object");

      const who = await tool(k.secret, "whoami");
      expect(who.isError, who.text).toBe(false);
      expect(who.body).toMatchObject({
        key_name: k.name, agent: role, writes_enabled: true, team_posts_publish: true, agent_access: "on", environment: "test", key_environment: "test",
        customer_drafts_left_today: AGENT_DAILY_DRAFT_LIMIT,
      });
      expect(who.body.scopes.map((s: { scope: string }) => s.scope).sort()).toEqual([...DEFAULT_SCOPES_BY_ROLE[role]].sort());
      for (const s of who.body.scopes) expect(s.label, s.scope).toEqual(expect.any(String));
      expect(who.body.thread_kinds.read).toContain("team");
      expect(who.body.thread_kinds.post).toContain("team");
      expect(who.body.time_chicago).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}-0[56]:00$/);
      expect(typeof who.body.requests_left_this_minute).toBe("number");
      expect(who.text).not.toContain(k.secret);
    });
  }

  it("tools/list shows only the tools a key's scopes open; every tool shown is callable and every hidden one is refused", async () => {
    const research = await keyFor("research");
    const cfo = await keyFor("cfo");
    const inventory = await keyFor("inventory");
    const namesOf = async (k: Made) => ((await rpc(k.secret, "tools/list", {})).body.result.tools as Array<{ name: string }>).map((t) => t.name).sort();
    const everyone = ["list_threads", "post_message", "read_thread", "whoami"];
    expect(await namesOf(research)).toEqual([...everyone, "get_invoice", "get_job", "lead_source_counts", "list_invoices", "list_jobs", "list_visits"].sort());
    expect(await namesOf(cfo)).toEqual([...everyone, "get_invoice", "get_job", "list_invoices", "list_jobs", "list_payments"].sort());
    expect(await namesOf(inventory)).toEqual(everyone);
    // No write tool exists for Research or CFO beyond the hub post.
    expect(AGENT_TOOLS.filter((t) => t.write).map((t) => t.name)).toEqual(["post_message"]);
  });

  it("whoami's request count goes down as the key is used", async () => {
    const k = await keyFor("admin");
    const first = (await tool(k.secret, "whoami")).body.requests_left_this_minute as number;
    const second = (await tool(k.secret, "whoami")).body.requests_left_this_minute as number;
    expect(second).toBeLessThan(first);
  });
});

// ── the door ─────────────────────────────────────────────────────────────────────────────────────

describe("who gets in", () => {
  it("no bearer is 401, and so is a session PIN token and a technician token (never a session for an agent door)", async () => {
    expect((await rpc(null, "tools/list", {})).status).toBe(401);
    expect((await rpc(pin, "tools/list", {})).status).toBe(401);
    expect((await rpc(techToken, "tools/list", {})).status).toBe(401);
    expect((await rpc("rce_test_" + "A".repeat(43), "tools/list", {})).status).toBe(401);
  });

  it("a revoked key is refused 401 key_revoked, and the refusal is audited with door mcp", async () => {
    const k = await keyFor("admin");
    await prisma.agentKey.update({ where: { id: k.id }, data: { revokedAt: new Date() } });
    const res = await rpc(k.secret, "tools/list", {});
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("key_revoked");
    const rows = await auditRows(k.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ door: "mcp", endpoint: "POST /mcp", resultCode: "key_revoked", agentKeyName: k.name, responseStatus: 401 });
  });

  it("a revoke applies to the very next request (stateless: nothing is remembered)", async () => {
    const k = await keyFor("admin");
    expect((await tool(k.secret, "whoami")).isError).toBe(false);
    await prisma.agentKey.update({ where: { id: k.id }, data: { revokedAt: new Date() } });
    expect((await rpc(k.secret, "tools/call", { name: "whoami", arguments: {} })).status).toBe(401);
  });

  it("the kill switch off refuses at the gate (503), read_only still lets the reads through", async () => {
    const k = await keyFor("admin");
    await setMode("off");
    expect((await rpc(k.secret, "tools/list", {})).status).toBe(503);
    await setMode("read_only");
    const who = await tool(k.secret, "whoami");
    expect(who.body.agent_access).toBe("read_only");
  });

  it("GET and DELETE /mcp are 405 JSON, never index.html, even with Accept text/html; the /api prefix works for POST", async () => {
    const k = await keyFor("admin");
    const html = await get(k.secret, "/mcp").set("Accept", "text/html,application/xhtml+xml");
    expect(html.status).toBe(405);
    expect(html.headers["content-type"]).toContain("application/json");
    expect(html.headers.allow).toBe("POST");
    expect(html.body).toMatchObject({ code: "method_not_allowed", retryable: false });
    expect(html.text).not.toContain("<html");
    const del = await request(app).delete("/mcp").set(bearer(k.secret));
    expect(del.status).toBe(405);
    expect((await get(k.secret, "/api/mcp")).status).toBe(405);
    expect((await rpc(k.secret, "tools/list", {}, "/api/mcp")).status).toBe(200);
    // Without a key a browser-style GET is the gate's 401, not the app shell.
    const anon = await request(app).get("/mcp").set("Accept", "text/html");
    expect(anon.status).toBe(401);
    expect(anon.text).not.toContain("<html");
    const rows = await auditRows(k.id);
    expect(rows.filter((r) => r.action === "mcp.method_not_allowed")).toHaveLength(3);
  });

  it("the SPA fallback's own rule never serves index.html for /mcp (the fallback is not mounted in tests, so the rule is pinned directly)", () => {
    for (const p of ["/mcp", "/MCP", "/mcp/x", "/Mcp/"]) expect(spaFallbackServes("GET", p, "text/html,application/xhtml+xml"), p).toBe(false);
    // The rule still serves the app shell for a real screen, so this fails if the rule is gutted instead of narrowed.
    expect(spaFallbackServes("GET", "/jobs", "text/html")).toBe(true);
    expect(spaFallbackServes("GET", "/mcpish", "text/html")).toBe(true);
    expect(spaFallbackServes("GET", "/e/abc", "text/html")).toBe(false);
    expect(spaFallbackServes("GET", "/api/x", "text/html")).toBe(false);
    expect(spaFallbackServes("POST", "/jobs", "text/html")).toBe(false);
    expect(spaFallbackServes("GET", "/jobs", "application/json")).toBe(false);
  });

  it("a JSON-RPC batch is refused 400 whole: no tool runs, one audit row each, nothing in it executes", async () => {
    const k = await keyFor("research");
    const call = { jsonrpc: "2.0", method: "tools/call", params: { name: "list_invoices", arguments: {} } };
    const post = (body: unknown) => request(app).post("/mcp").set(bearer(k.secret)).set("Accept", "application/json, text/event-stream").send(body as object);
    const res = await post([{ ...call, id: 1 }, { ...call, id: 2 }]);
    texts.push(res.text ?? "");
    expect(res.status, res.text).toBe(400);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.body.error.code).toBe(-32600);
    // An empty array and a one-message array are batches too.
    expect((await post([])).status).toBe(400);
    expect((await post([{ ...call, id: 3 }])).status).toBe(400);
    const rows = await auditRows(k.id);
    expect(rows.map((r) => [r.action, r.responseStatus])).toEqual([["mcp.batch_refused", 400], ["mcp.batch_refused", 400], ["mcp.batch_refused", 400]]);
    expect(rows.some((r) => r.action === "list_invoices")).toBe(false);
  });

  it("a request the transport refuses is audited with the status it really got: initialize, tools/call and tools/list with Accept: application/json only", async () => {
    const k = await keyFor("research");
    const send = (body: Record<string, unknown>) => request(app).post("/mcp").set(bearer(k.secret)).set("Accept", "application/json").send({ jsonrpc: "2.0", id: 1, ...body });
    const init = await send({ method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "w2-test", version: "1" } } });
    expect(init.status).toBe(406);
    const called = await send({ method: "tools/call", params: { name: "whoami", arguments: {} } });
    expect(called.status).toBe(406);
    const list = await send({ method: "tools/list" });
    expect(list.status).toBe(406);
    const rows = await auditRows(k.id);
    expect(rows.map((r) => [r.action, r.responseStatus, r.resultCode])).toEqual([
      ["mcp.initialize", 406, "not_acceptable"], ["mcp.transport_refused", 406, "not_acceptable"], ["mcp.tools_list", 406, "not_acceptable"],
    ]);
    for (const r of rows) { expect(r.door).toBe("mcp"); expect(r.agentKeyName).toBe(k.name); expect(r.resultCode).not.toBe("ok"); }
  });

  it("an agent key is still refused on every other route (the table gained exactly /mcp)", async () => {
    const k = await keyFor("admin");
    expect((await get(k.secret, "/accounts")).status).toBe(401);
  });
});

// ── the hub tools are the same code as REST ──────────────────────────────────────────────────────

describe("list_threads, read_thread and post_message give what REST gives", () => {
  it("list_threads and read_thread answer exactly what REST answers for the same key", async () => {
    for (const role of ["admin", "inventory", "scout", "research"] as AgentRole[]) {
      const k = await keyFor(role);
      const viaMcp = await tool(k.secret, "list_threads", {});
      const viaRest = await get(k.secret, "/api/hub/threads");
      expect(viaMcp.isError, viaMcp.text).toBe(false);
      expect(viaMcp.body, role).toEqual(viaRest.body);
      const detailMcp = await tool(k.secret, "read_thread", { thread_id: teamThreadId });
      const detailRest = await get(k.secret, `/api/hub/threads/${teamThreadId}/messages`);
      expect(detailMcp.isError, detailMcp.text).toBe(false);
      expect(detailMcp.body, role).toEqual(detailRest.body);
    }
  });

  it("a Team post through MCP is `posted` at once, exactly like REST, and the answer carries no pending_reason", async () => {
    const k = await keyFor("inventory");
    const res = await tool(k.secret, "post_message", { thread_id: teamThreadId, body: "Orson, the Smyrna panel is ordered.", idempotency_key: idem() });
    expect(res.isError, res.text).toBe(false);
    expect(res.body).toMatchObject({ threadId: teamThreadId, status: "posted", channel: "in_app", category: "team_internal", pending_reason: null });
    const row = await prisma.hubMessage.findUniqueOrThrow({ where: { id: res.body.messageId } });
    expect(row).toMatchObject({ status: "posted", decidedBy: `key:${k.id}`, authorBotKeyId: k.id });
    // The same call through REST has the same shape.
    const rest = await restPost(k.secret, { thread_id: teamThreadId, body: "Orson, the Smyrna panel is ordered.", idempotency_key: idem() });
    expect(Object.keys(rest.body).sort()).toEqual(Object.keys(res.body).sort());
  });

  it("a customer draft through MCP is pending_approval with a plain reason, and nothing is sent", async () => {
    const k = await keyFor("admin");
    const res = await tool(k.secret, "post_message", {
      customerId, channel: "email", subject: "Your quote", body: "Hello, your panel quote is ready to review.", idempotency_key: idem(),
    });
    expect(res.isError, res.text).toBe(false);
    expect(res.body.status).toBe("pending_approval");
    expect(res.body.pending_reason).toEqual(expect.any(String));
    const who = await tool(k.secret, "whoami");
    expect(who.body.customer_drafts_left_today).toBe(AGENT_DAILY_DRAFT_LIMIT - 1);
  });

  for (const role of ["research", "cfo", "nec_coach"] as AgentRole[]) {
    it(`${role} is refused on a customer thread, reading and drafting, with the scope and its Settings label named, and nothing is written`, async () => {
      const k = await keyFor(role);
      const thread = await ensureThreadFor({ customerId });
      const before = await prisma.hubMessage.count({ where: { threadId: thread.id } });
      const read = await tool(k.secret, "read_thread", { thread_id: thread.id });
      expect(read.isError).toBe(true);
      expect(read.body.code).toBe("forbidden");
      expect(read.body.reason).toContain("Read customer (hub:read)");
      expect(read.body.reason).toContain("Settings");
      const draft = await tool(k.secret, "post_message", { customerId, channel: "email", subject: "x", body: "A customer message.", idempotency_key: idem() });
      expect(draft.isError).toBe(true);
      expect(draft.body.reason).toContain("Draft customer (hub:draft)");
      expect(await prisma.hubMessage.count({ where: { threadId: thread.id } })).toBe(before);
    });
  }

  it("an idempotent replay returns the first message id and posts nothing twice, through MCP and across MCP and REST", async () => {
    const k = await keyFor("scout");
    const args = { thread_id: teamThreadId, body: "Scout checking in on the Smyrna panel.", idempotency_key: idem() };
    const first = await tool(k.secret, "post_message", args);
    const again = await tool(k.secret, "post_message", args);
    expect(first.isError || again.isError).toBe(false);
    expect(again.body.messageId).toBe(first.body.messageId);
    const viaRest = await restPost(k.secret, args);
    expect(viaRest.status).toBe(200);
    expect(viaRest.body.messageId).toBe(first.body.messageId);
    expect(await prisma.hubMessage.count({ where: { threadId: teamThreadId, body: args.body } })).toBe(1);
    const rows = await auditRows(k.id);
    expect(rows.filter((r) => r.action === "post_message").map((r) => r.resultCode)).toEqual(["ok", "replayed"]);
    // The same key with a different request is a conflict, as in REST.
    const conflict = await tool(k.secret, "post_message", { ...args, body: "A different message." });
    expect(conflict.isError).toBe(true);
    expect(conflict.body.code).toBe("idempotency_conflict");
  });

  it("the agent-to-agent limit applies through MCP: the 9th AI post in a row is 429 thread_agent_limit", async () => {
    const k = await keyFor("admin");
    for (let i = 0; i < THREAD_AGENT_POST_LIMIT; i += 1) {
      const ok = await tool(k.secret, "post_message", { thread_id: loopThreadId, body: `Admin post ${i}.`, idempotency_key: idem() });
      expect(ok.isError, ok.text).toBe(false);
    }
    const over = await tool(k.secret, "post_message", { thread_id: loopThreadId, body: "One too many.", idempotency_key: idem() });
    expect(over.isError).toBe(true);
    expect(over.body).toMatchObject({ code: "thread_agent_limit", retryable: true });
    expect(await prisma.hubMessage.count({ where: { threadId: loopThreadId, body: "One too many." } })).toBe(0);
  });

  it("post_message is a write tool: writes off is 403 writes_disabled, the kill switch read_only is 503 agents_read_only, and no row is written either way", async () => {
    const off = await keyFor("inventory", { writesEnabled: false });
    const body = (text: string) => ({ thread_id: teamThreadId, body: text, idempotency_key: idem() });
    const a = await tool(off.secret, "post_message", body("Writes are off for this key."));
    expect(a.isError).toBe(true);
    expect(a.body.code).toBe("writes_disabled");
    // Reads still work for it.
    expect((await tool(off.secret, "list_threads")).isError).toBe(false);
    const on = await keyFor("inventory");
    await setMode("read_only");
    const b = await tool(on.secret, "post_message", body("Read only right now."));
    expect(b.isError).toBe(true);
    expect(b.body.code).toBe("agents_read_only");
    expect(await prisma.hubMessage.count({ where: { threadId: teamThreadId, body: { in: ["Writes are off for this key.", "Read only right now."] } } })).toBe(0);
  });

  it("a recipient or cc is refused through MCP exactly as in REST (the core reads the raw arguments)", async () => {
    const k = await keyFor("admin");
    const res = await tool(k.secret, "post_message", { customerId, channel: "email", body: "Hi.", toAddress: "someone@example.com", idempotency_key: idem() });
    expect(res.isError).toBe(true);
    expect(res.body.code).toBe("bad_request");
    expect(res.body.reason).toContain("no recipient");
  });

  it("bad arguments are a bad_request naming the field, never the value; an unknown tool is unknown_tool", async () => {
    const k = await keyFor("admin");
    const bad = await tool(k.secret, "read_thread", { thread_id: 12345 });
    expect(bad.isError).toBe(true);
    expect(bad.body.code).toBe("bad_request");
    expect(bad.body.reason).toContain("thread_id");
    expect(bad.text).not.toContain("12345");
    const unknown = await tool(k.secret, "drop_database", {});
    expect(unknown.isError).toBe(true);
    expect(unknown.body.code).toBe("unknown_tool");
  });
});

// ── Research and CFO read tools (R-f) ────────────────────────────────────────────────────────────

const RANGE = { from: "2020-03-01", to: "2020-03-31" };

function expectDeidentified(text: string) {
  for (const f of FORBIDDEN) expect(text, f).not.toContain(f);
}

describe("Research (reports:read): jobs, invoices, visits and lead sources, de-identified", () => {
  it("list_jobs and get_job: ids, status, dates, money and a first name; none of the phone, email, street, last name or notes; the test account left out", async () => {
    const k = await keyFor("research");
    const list = await tool(k.secret, "list_jobs", RANGE);
    expect(list.isError, list.text).toBe(false);
    expectDeidentified(list.text);
    const ids = list.body.items.map((j: { id: string }) => j.id);
    expect(ids.sort()).toEqual([visit1, visit2].sort());
    expect(ids).not.toContain(testVisit);
    const job = list.body.items.find((j: { id: string }) => j.id === visit1);
    expect(job).toMatchObject({
      status: "completed", customer_id: customerId, customer_first_name: "Mabel", invoice_number: `2020-${TAG}-1`,
      contracted_revenue: 4200, labor_hours: 6.5,
    });
    expect(JSON.stringify(list.body)).not.toContain("Panel Upgrade");
    expect(job.scheduled_start).toMatch(/^2020-03-05T09:00:00-06:00$/);
    expect(Object.keys(job).sort()).toEqual([
      "completed_at", "contracted_at", "contracted_revenue", "customer_first_name", "customer_id", "id", "invoice_number", "labor_hours", "mode",
      "scheduled_end", "scheduled_start", "status", "visit_date",
    ]);
    const one = await tool(k.secret, "get_job", { job_id: visit1 });
    expect(one.isError, one.text).toBe(false);
    expectDeidentified(one.text);
    expect(one.body.id).toBe(visit1);
    // The status filter, and the test account's job is not found by id.
    const scheduled = await tool(k.secret, "list_jobs", { ...RANGE, status: "scheduled" });
    expect(scheduled.body.items.map((j: { id: string }) => j.id)).toEqual([visit2]);
    const test = await tool(k.secret, "get_job", { job_id: testVisit });
    expect(test.isError).toBe(true);
    expect(test.body.code).toBe("not_found");
    // limit is honoured and says so.
    const one1 = await tool(k.secret, "list_jobs", { ...RANGE, limit: 1 });
    expect(one1.body.items).toHaveLength(1);
    expect(one1.body.truncated).toBe(true);
    expect((await tool(k.secret, "list_jobs", { limit: 500 })).body.code).toBe("bad_request");
    expect((await tool(k.secret, "list_jobs", { from: "March 1" })).body.code).toBe("bad_request");
  });

  it("list_invoices and get_invoice: numbers, status and money (a deposit leaves the balance); no title, scope, email, phone or street; test account out", async () => {
    const k = await keyFor("research");
    const list = await tool(k.secret, "list_invoices", RANGE);
    expect(list.isError, list.text).toBe(false);
    expectDeidentified(list.text);
    expect(list.body.items.map((i: { id: string }) => i.id)).toEqual([invoiceId]);
    expect(list.body.items[0]).toMatchObject({
      number: `2020-${TAG}-1`, status: "signed", payment_status: "deposit_paid", customer_first_name: "Mabel", job_id: visit1,
      billed_total: 1000, total_paid: 333.33, balance: 666.67,
    });
    expect((await tool(k.secret, "list_invoices", { ...RANGE, status: "paid" })).body.items).toEqual([]);
    expect((await tool(k.secret, "list_invoices", { ...RANGE, status: "deposit_paid" })).body.items).toHaveLength(1);
    const one = await tool(k.secret, "get_invoice", { invoice_id: invoiceId });
    expect(one.isError, one.text).toBe(false);
    expectDeidentified(one.text);
    const test = await tool(k.secret, "get_invoice", { invoice_id: testInvoiceId });
    expect(test.isError).toBe(true);
    expect(test.body.code).toBe("not_found");
  });

  it("list_visits: date and time, status, job type, the customer's first name and the technician's first name, with no last name or pay rate", async () => {
    const k = await keyFor("research");
    const res = await tool(k.secret, "list_visits", RANGE);
    expect(res.isError, res.text).toBe(false);
    expectDeidentified(res.text);
    expect(res.body.items.map((v: { id: string }) => v.id)).toEqual([visit1, visit2]);
    expect(res.body.items[0]).toMatchObject({ status: "completed", customer_first_name: "Mabel", technician_first_names: ["Orson"] });
    // W2-B review: the hand-typed job description (jobType: "Panel Upgrade") is free text and never leaves.
    expect(res.text).not.toContain("Panel Upgrade");
    expect(res.body.items[0].scheduled_start).toBe("2020-03-05T09:00:00-06:00");
    expect(JSON.stringify(res.body.items.map((v: { id: string }) => v.id))).not.toContain(testVisit);
  });

  it("lead_source_counts: counts by source and platform only, the not-a-lead call and the test account's lead left out, no identity in the answer", async () => {
    const k = await keyFor("research");
    const res = await tool(k.secret, "lead_source_counts", RANGE);
    expect(res.isError, res.text).toBe(false);
    expect(res.body.total).toBe(3);
    expect(res.body.by_source).toEqual([{ source: "web", count: 2 }, { source: "phone", count: 1 }]);
    expect(res.body.by_platform).toEqual([{ platform: "google", count: 2 }, { platform: "yelp", count: 1 }]);
    for (const f of ["Leadperson", "Lena", "555-0177", `lead-${EMAIL}`, "Tess"]) expect(res.text, f).not.toContain(f);
    expect(Object.keys(res.body).sort()).toEqual(["by_platform", "by_source", "from", "to", "total"]);
  });

  it("is refused list_payments, naming finance:read", async () => {
    const k = await keyFor("research");
    const res = await tool(k.secret, "list_payments", RANGE);
    expect(res.isError).toBe(true);
    expect(res.body.code).toBe("scope_denied");
    expect(res.body.reason).toContain("finance:read");
  });
});

describe("CFO (finance:read): jobs, invoices and payments, de-identified, read-only", () => {
  it("list_payments: id, invoice id, job id, amount, method, status and date; no check number, note or Stripe detail; the test account's payment out", async () => {
    const k = await keyFor("cfo");
    const res = await tool(k.secret, "list_payments", RANGE);
    expect(res.isError, res.text).toBe(false);
    expectDeidentified(res.text);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toEqual({
      id: payment1, invoice_id: invoiceId, job_id: visit1, amount: 333.33, refunded_amount: 0, method: "check", kind: "deposit", status: "paid", payer: "customer",
      received_at: "2020-03-03T10:00:00-06:00", voided: false,
    });
    expect(res.text).not.toContain("111");
  });

  it("the same list_jobs, get_job, list_invoices and get_invoice tools answer the CFO, in the same de-identified shape", async () => {
    const research = await keyFor("research");
    const cfo = await keyFor("cfo");
    for (const [name, args] of [["list_jobs", RANGE], ["list_invoices", RANGE], ["get_job", { job_id: visit1 }], ["get_invoice", { invoice_id: invoiceId }]] as const) {
      const a = await tool(research.secret, name, args);
      const b = await tool(cfo.secret, name, args);
      expect(b.isError, `${name} ${b.text}`).toBe(false);
      expect(b.body, name).toEqual(a.body);
      expectDeidentified(b.text);
    }
  });

  it("is refused list_visits and lead_source_counts, naming reports:read", async () => {
    const k = await keyFor("cfo");
    for (const name of ["list_visits", "lead_source_counts"]) {
      const res = await tool(k.secret, name, RANGE);
      expect(res.isError, name).toBe(true);
      expect(res.body.code).toBe("scope_denied");
      expect(res.body.reason).toContain("reports:read");
    }
  });
});

describe("W2-B review: free text, ordering, lead window and the one money rule", () => {
  it("a long job description with a last name in it never reaches list_jobs, get_job or list_visits, and does not make them fail", async () => {
    const k = await keyFor("research");
    const text = `Panel swap for the Hendersons, dog in yard, key under mat ${"x".repeat(160)}`;
    const v = await prisma.visit.create({
      data: { customerId, propertyId, mode: "service_diagnostic", status: "scheduled", jobType: text, visitDate: new Date("2019-06-10T15:00:00Z"), scheduledStart: new Date("2019-06-11T15:00:00Z") },
    });
    const range = { from: "2019-06-01", to: "2019-06-30" };
    for (const [name, args] of [["list_jobs", range], ["list_visits", range], ["get_job", { job_id: v.id }]] as const) {
      const res = await tool(k.secret, name, args);
      expect(res.isError, `${name} ${res.text}`).toBe(false);
      expect(res.text, name).toContain(v.id);
      expect(res.text, name).not.toContain("Hendersons");
      expect(res.text, name).not.toContain("key under mat");
      expect(res.text, name).not.toContain("job_type");
    }
  });

  it("list_payments is newest RECEIVED first and keeps the most recent receipts when it truncates, whatever order the rows were created in", async () => {
    const k = await keyFor("cfo");
    const pay = (paidAt: string, createdAt: string, amount: number) => prisma.payment.create({
      data: { customerId, visitId: visit1, amount, method: "check", kind: "deposit", status: "paid", paidAt: new Date(paidAt), createdAt: new Date(createdAt) },
    });
    // Creation order is the opposite of receipt order.
    await pay("2019-05-20T16:00:00Z", "2019-05-31T16:00:00Z", 11);
    const newest = await pay("2019-05-27T16:00:00Z", "2019-05-02T16:00:00Z", 22);
    await pay("2019-05-24T16:00:00Z", "2019-05-15T16:00:00Z", 33);
    const all = await tool(k.secret, "list_payments", { from: "2019-05-01", to: "2019-05-31" });
    expect(all.body.items.map((p: { amount: number }) => p.amount)).toEqual([22, 33, 11]);
    const one = await tool(k.secret, "list_payments", { from: "2019-05-01", to: "2019-05-31", limit: 1 });
    expect(one.body.items.map((p: { id: string }) => p.id)).toEqual([newest.id]);
    expect(one.body.truncated).toBe(true);
  });

  it("lead_source_counts counts a lead by the Chicago day it really arrived (afternoon and late evening included) and cuts a long public-form label instead of failing", async () => {
    const k = await keyFor("research");
    const at = (iso: string, extra: Record<string, unknown> = {}) => prisma.lead.create({
      data: { name: "Window Lead", email: `lead-${EMAIL}`, phone: "(615) 555-0188", source: "web", platform: "google", receivedAt: new Date(iso), ...extra } as never,
    });
    await at("2020-04-10T09:00:00Z"); // 4am Chicago on the 10th (the old noon-UTC window missed it)
    await at("2020-04-10T20:00:00Z"); // 3pm Chicago on the 10th (the old window missed it)
    await at("2020-04-11T03:00:00Z"); // 10pm Chicago on the 10th (UTC says the 11th)
    await at("2020-04-11T06:00:00Z"); // 1am Chicago on the 11th: NOT the 10th
    await at("2020-04-10T04:00:00Z"); // 11pm Chicago on the 9th: NOT the 10th
    const one = await tool(k.secret, "lead_source_counts", { from: "2020-04-10", to: "2020-04-10" });
    expect(one.isError, one.text).toBe(false);
    expect(one.body.total).toBe(3);
    const two = await tool(k.secret, "lead_source_counts", { from: "2020-04-10", to: "2020-04-11" });
    expect(two.body.total).toBe(4);
    await at("2020-05-10T15:00:00Z", { source: `s${"y".repeat(200)}`, platform: `p${"z".repeat(200)}` });
    const long = await tool(k.secret, "lead_source_counts", { from: "2020-05-10", to: "2020-05-10" });
    expect(long.isError, long.text).toBe(false);
    expect(long.body.total).toBe(1);
    expect(long.body.by_source[0].source).toHaveLength(60);
  });

  it("the CRM Invoices list and the agents' invoice tools read the same money: status, total paid, balance and billed total agree", async () => {
    const k = await keyFor("cfo");
    const crm = await request(app).get("/invoices").set(bearer(pin));
    expect(crm.status, crm.text).toBe(200);
    const row = (crm.body as Array<Record<string, any>>).find((i) => i.id === invoiceId)!;
    expect(row).toBeTruthy();
    const mine = (await tool(k.secret, "get_invoice", { invoice_id: invoiceId })).body;
    expect(mine).toMatchObject({
      payment_status: row.paymentStatus, total_paid: row.totalPaid, balance: row.balance, billed_total: row.billedTotal, deposit_due: row.depositDue,
      deposit_required: row.depositRequired,
    });
    expect(row.paymentStatus).toBe("deposit_paid");
  });
});

describe("keys without a reporting scope", () => {
  for (const role of ["inventory", "facebook", "nec_coach"] as AgentRole[]) {
    it(`${role} calling list_jobs is refused, naming reports:read and finance:read and where to tick them`, async () => {
      const k = await keyFor(role);
      const res = await tool(k.secret, "list_jobs", RANGE);
      expect(res.isError).toBe(true);
      expect(res.body).toMatchObject({ code: "scope_denied", retryable: false });
      expect(res.body.reason).toContain("reports:read");
      expect(res.body.reason).toContain("finance:read");
      expect(res.body.reason).toContain("Settings");
    });
  }

  it("a key with every reporting scope but not the hub's is refused post_message naming the scopes that open it", async () => {
    const k = await keyFor("other", { scopes: ["reports:read"] });
    const res = await tool(k.secret, "post_message", { thread_id: teamThreadId, body: "x", idempotency_key: idem() });
    expect(res.isError).toBe(true);
    expect(res.body.code).toBe("scope_denied");
    expect(res.body.reason).toContain("Post team (team:reply)");
  });

  it("a key with no scopes at all can still call whoami and nothing else", async () => {
    const k = await keyFor("other");
    const who = await tool(k.secret, "whoami");
    expect(who.isError).toBe(false);
    expect(who.body.scopes).toEqual([]);
    expect(who.body.thread_kinds).toEqual({ read: [], post: [] });
    expect((await tool(k.secret, "list_threads")).body.code).toBe("scope_denied");
  });
});

// ── the audit ────────────────────────────────────────────────────────────────────────────────────

describe("every call is audited (door mcp, the tool, the scope that allowed it, the key's name)", () => {
  it("success, refusal, write and replay each leave exactly one row, and no body is ever stored", async () => {
    const k = await keyFor("research");
    await rpc(k.secret, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "w2-test", version: "1" } });
    await rpc(k.secret, "tools/list", {});
    await tool(k.secret, "whoami");
    await tool(k.secret, "list_jobs", RANGE);
    await tool(k.secret, "list_payments", RANGE); // refused: scope_denied
    await tool(k.secret, "post_message", { thread_id: teamThreadId, body: "Research here.", idempotency_key: idem() });
    await tool(k.secret, "read_thread", { thread_id: "nope-nope" }); // not found
    await tool(k.secret, "no_such_tool", {});
    const rows = await auditRows(k.id);
    expect(rows.map((r) => [r.action, r.resultCode])).toEqual([
      ["mcp.initialize", "ok"], ["mcp.tools_list", "ok"], ["whoami", "ok"], ["list_jobs", "ok"], ["list_payments", "scope_denied"],
      ["post_message", "ok"], ["read_thread", "not_found"], ["unknown_tool", "unknown_tool"],
    ]);
    for (const r of rows) {
      expect(r.door, r.action).toBe("mcp");
      expect(r.agentKeyName, r.action).toBe(k.name);
      expect(r.agent, r.action).toBe("research");
      expect(r.endpoint, r.action).toMatch(/^POST \/mcp/);
      expect(r.agentKeyId).toBe(k.id);
      expect(r.durationMs).toBeGreaterThanOrEqual(0);
      expect(r.responseStatus).toBeGreaterThanOrEqual(200);
    }
    const byTool = (name: string) => rows.find((r) => r.action === name)!;
    expect(byTool("list_jobs")).toMatchObject({ endpoint: "POST /mcp list_jobs", scopeUsed: "reports:read", responseStatus: 200 });
    expect(byTool("list_payments")).toMatchObject({ endpoint: "POST /mcp list_payments", scopeUsed: null, responseStatus: 403 });
    expect(byTool("post_message")).toMatchObject({ endpoint: "POST /mcp post_message", scopeUsed: "team:reply", responseStatus: 201 });
    expect(byTool("read_thread")).toMatchObject({ scopeUsed: "team:read", responseStatus: 404 });
    expect(byTool("unknown_tool").endpoint).toBe("POST /mcp unknown_tool");
    // Ids only: the job ids it listed, never a name or a number.
    expect(byTool("list_jobs").recordIds).toEqual(expect.arrayContaining([visit1]));
    expect(JSON.stringify(rows)).not.toContain("Mabel");
    expect(JSON.stringify(rows)).not.toContain("Research here.");
    // The Activity panel on Settings -> Agent keys reads these same rows.
    const activity = await request(app).get(`/settings/agent-keys/${k.id}/activity`).set(bearer(pin));
    expect(activity.status, activity.text).toBe(200);
    expect(JSON.stringify(activity.body)).toContain("list_jobs");
    expect(JSON.stringify(activity.body)).toContain("mcp");
  });

  it("an Admin Team post is audited as team:reply and a customer draft as hub:draft, never the other", async () => {
    const k = await keyFor("admin");
    await tool(k.secret, "post_message", { thread_id: teamThreadId, body: "Admin in Team.", idempotency_key: idem() });
    await tool(k.secret, "post_message", { customerId, channel: "email", subject: "s", body: "Hello customer.", idempotency_key: idem() });
    const rows = (await auditRows(k.id)).filter((r) => r.action === "post_message");
    expect(rows.map((r) => r.scopeUsed)).toEqual(["team:reply", "hub:draft"]);
  });
});

// ── secrets ──────────────────────────────────────────────────────────────────────────────────────

describe("no key value ever leaves", () => {
  it("not in any MCP response, any audit row, or any log line this file produced", async () => {
    expect(secrets.length).toBeGreaterThan(10);
    const audit = JSON.stringify(await prisma.agentAuditLog.findMany({ where: { agentKeyId: { in: keyIds } } }));
    const everything = [...texts, audit, ...logLines].join("\n");
    for (const s of secrets) {
      expect(everything.includes(s), "a key value appeared").toBe(false);
      expect(everything.includes(s.slice(9)), "the key body appeared").toBe(false);
    }
    expect(everything).not.toMatch(/rce_(live|test)_[A-Za-z0-9_-]{20,}/);
    expect(everything).not.toContain("test-pepper-for-the-w2-mcp-suite");
    expect(everything).not.toContain(techToken);
  });
});
