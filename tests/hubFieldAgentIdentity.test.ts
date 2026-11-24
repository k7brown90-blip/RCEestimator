/**
 * W2-D, the field app's view of the AI team (Kyle 2026-11-23 item 6: "agent replies show live ... with the agent's name/avatar.
 * Customer-facing drafts show a 'waiting for approval' badge with Approve / Edit / Reject"):
 *
 *   * WHO WROTE IT. A technician's thread read and list line carry `agentRole`: the role of the AgentKey that wrote an AI post, "admin" for
 *     the AI admin's own CRM session (no key), null for a person, for an AI post whose key row is gone, and for an approver's edited copy
 *     of an agent's draft (the approver rewrote and sent it as themselves: their name is on it). The key is read ONCE for the whole
 *     read (never one query per message) and ONLY its id and role are selected (a key row holds its secret hash); nothing of a key
 *     but the role reaches the phone.
 *   * THE HOME-BUTTON COUNT. GET /health-record/hub/badge carries `waitingApproval`: the length of the SAME card list the field's
 *     "Waiting for approval" screen reads, for Kyle's principal login and for a login holding approve_drafts, and 0 for everyone else.
 *   * LIVE. An agent's posted Team reply is in the technician's thread read AND is announced on the live-update bus in the same call.
 *
 * (The approval PUSH to an approver's field phone is pinned in tests/hubPush.test.ts, beside the other push rules.)
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
  return {
    google: {
      auth: { OAuth2: MockOAuth2 },
      calendar: () => ({
        freebusy: { query: vi.fn().mockResolvedValue({ data: { calendars: { primary: { busy: [] } } } }) },
        events: { list: vi.fn().mockResolvedValue({ data: { items: [] } }), delete: vi.fn().mockResolvedValue({}) },
      }),
    },
  };
});

import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { createMessageRow, ensureTeamThread, ensureThreadFor, postMessage, type HubReader } from "../src/services/hub";
import { createDraftMessage } from "../src/services/hubDrafts";
import { agentRolesFor, techReader } from "../src/services/hubTech";
import { subscribeHub, type HubBusEvent } from "../src/services/hubBus";
import { saveCrmLogin, setPowers, setPrincipal } from "../src/services/crmLogin";
import { cleanupCrmLoginFixtures, makePerson } from "./helpers/crmLoginFixture";

const TAG = "HubFieldAgentId";
const PASS = "correct horse battery";
const AI: HubReader = { key: "ai-admin", kind: "ai-admin", display: "RCE Admin", technicianId: null, threadKinds: [], agentRole: null, agentKeyId: null, isKyle: false };
const keyIds: string[] = [];

async function wipe() {
  const customers = await prisma.customer.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
  const ids = customers.map((c) => c.id);
  const people = await prisma.technician.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
  await prisma.hubThread.deleteMany({ where: { OR: [{ title: { startsWith: TAG } }, { customerId: { in: ids } }, { technicianId: { in: people.map((p) => p.id) } }] } });
  if (ids.length > 0) await prisma.customer.deleteMany({ where: { id: { in: ids } } });
  if (keyIds.length > 0) await prisma.agentKey.deleteMany({ where: { id: { in: keyIds.splice(0) } } });
  await cleanupCrmLoginFixtures();
}
beforeAll(wipe);
beforeEach(wipe);
afterAll(wipe);

async function tech(name: string) {
  const p = await makePerson(`${TAG} ${name}`);
  const row = await prisma.technician.findUniqueOrThrow({ where: { id: p.id } });
  return { id: p.id, token: row.accessToken, name: row.name };
}
async function makeKey(role: string, extra: Record<string, unknown> = {}) {
  const row = await prisma.agentKey.create({
    data: {
      name: `${TAG} ${role} ${randomUUID().slice(0, 4)}`, agentRole: role, environment: "test", displayPrefix: "rce_test_xxxx",
      secretHash: `hash-secret-${randomUUID()}`, scopes: ["team:read", "team:reply"], createdBy: "owner", ...extra,
    },
  });
  keyIds.push(row.id);
  return row;
}
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const get = (token: string, path: string) => request(app).get(`/health-record${path}`).set(bearer(token));

/** An in-app, posted message in a thread: what a technician's phone may read. */
const said = (threadId: string, over: Record<string, unknown>) =>
  createMessageRow(prisma, {
    threadId, authorType: "ai_agent", authorDisplay: "Someone", channel: "in_app", direction: "internal", status: "posted", body: "text", ...over,
  } as Parameters<typeof createMessageRow>[1]);

type WireMessage = { id: string; authorType: string; agentRole: string | null; authorLabel: string; body: string | null };
const wire = async (token: string, threadId: string) =>
  ((await get(token, `/hub/threads/${threadId}/messages`)).body.data.messages as WireMessage[]);

describe("who wrote it: agentRole on a technician's thread read and list line", () => {
  it("names the role of the key behind an AI post, 'admin' for the AI admin session, and null for people, a lost key and an approver's edited copy", async () => {
    const eric = await tech("Eric");
    const team = await ensureTeamThread(eric.id);
    const adminKey = await makeKey("admin");
    const inventoryKey = await makeKey("inventory");
    const codingKey = await makeKey("claude_code");
    const ids: Record<string, string> = {};
    ids.admin = (await said(team.id, { authorKey: `agent:${adminKey.id}`, authorBotKeyId: adminKey.id, authorDisplay: "RCE Admin" })).id;
    ids.inventory = (await said(team.id, { authorKey: `agent:${inventoryKey.id}`, authorBotKeyId: inventoryKey.id, authorDisplay: "Stock" })).id;
    ids.coding = (await said(team.id, { authorType: "claude", authorKey: `agent:${codingKey.id}`, authorBotKeyId: codingKey.id, authorDisplay: "Coder" })).id;
    ids.aiAdmin = (await said(team.id, { authorKey: "ai-admin", authorDisplay: "AI admin" })).id;
    ids.gone = (await said(team.id, { authorKey: "agent:deleted", authorBotKeyId: "deleted-key-id", authorDisplay: "Old bot" })).id;
    ids.person = (await said(team.id, { authorType: "tech", authorKey: `tech:${eric.id}`, authorTechnicianId: eric.id, authorDisplay: "Eric" })).id;
    ids.office = (await said(team.id, { authorType: "office", authorKey: "owner", authorDisplay: "Kyle" })).id;
    // An approver edited an agent's draft and sent their own version: authored as the person, linked back by editedFromId.
    const original = await said(team.id, { authorKey: `agent:${adminKey.id}`, authorBotKeyId: adminKey.id, authorDisplay: "RCE Admin", status: "edited" });
    ids.edited = (await said(team.id, { authorType: "office", authorKey: "owner", authorDisplay: "Kyle", editedFromId: original.id })).id;

    const res = await get(eric.token, `/hub/threads/${team.id}/messages`);
    expect(res.status).toBe(200);
    const byId = new Map((res.body.data.messages as WireMessage[]).map((m) => [m.id, m]));
    const roleOf = (k: string) => byId.get(ids[k]!)!.agentRole;
    expect(roleOf("admin")).toBe("admin");
    expect(roleOf("inventory")).toBe("inventory");
    expect(roleOf("coding")).toBe("claude_code");
    expect(roleOf("aiAdmin")).toBe("admin");
    expect(roleOf("gone")).toBeNull();
    expect(roleOf("person")).toBeNull();
    expect(roleOf("office")).toBeNull();
    expect(roleOf("edited")).toBeNull();
    // The "(AI)" rule on the wire is unchanged (the avatar drops it on screen only).
    expect(byId.get(ids.admin!)!.authorLabel).toBe("RCE Admin (AI)");
    expect(byId.get(ids.person!)!.authorLabel).toBe(eric.name);
    // The draft the approver replaced is not shown to a technician at all.
    expect(byId.has(original.id)).toBe(false);
  });

  it("the thread list's last line carries authorType and agentRole too", async () => {
    const eric = await tech("Eric");
    const team = await ensureTeamThread(eric.id);
    const key = await makeKey("research");
    await said(team.id, { authorKey: `agent:${key.id}`, authorBotKeyId: key.id, authorDisplay: "Researcher", body: "Found it" });
    const rows = (await get(eric.token, "/hub/threads")).body.data.threads as Array<{ key: string; lastLine: { authorType: string; agentRole: string | null; authorLabel: string; text: string } | null }>;
    expect(rows.find((r) => r.key === "team")!.lastLine).toMatchObject({ authorType: "ai_agent", agentRole: "research", authorLabel: "Researcher (AI)", text: "Found it" });

    await said(team.id, { authorType: "office", authorKey: "owner", authorDisplay: "Kyle", body: "Thanks" });
    const after = (await get(eric.token, "/hub/threads")).body.data.threads as typeof rows;
    expect(after.find((r) => r.key === "team")!.lastLine).toMatchObject({ authorType: "office", agentRole: null, authorLabel: "Kyle" });
  });

  it("leaks nothing of an agent key but its role: no secret hash, no key id, no key name beyond the display name already shown", async () => {
    const eric = await tech("Eric");
    const team = await ensureTeamThread(eric.id);
    const key = await makeKey("facebook");
    await said(team.id, { authorKey: `agent:${key.id}`, authorBotKeyId: key.id, authorDisplay: "Social" });
    const res = await get(eric.token, `/hub/threads/${team.id}/messages`);
    const text = res.text + (await get(eric.token, "/hub/threads")).text;
    for (const secret of [key.secretHash, "hash-secret", "secretHash", key.id, key.name, key.displayPrefix, "authorBotKeyId", "scopes"]) expect(text).not.toContain(secret);
    const m = (res.body.data.messages as Array<Record<string, unknown>>)[0]!;
    expect(Object.keys(m).sort()).toEqual([
      "agentRole", "at", "attachments", "authorLabel", "authorType", "body", "canDelete", "canEdit", "createdAt", "deleted", "editedAt", "id", "mine", "photoIds",
    ]);
  });

  it("asks for the keys ONCE for the whole read, selecting only id and agentRole", async () => {
    const findMany = vi.fn().mockResolvedValue([{ id: "k1", agentRole: "admin" }, { id: "k2", agentRole: "scout" }]);
    const db = { agentKey: { findMany } } as unknown as Parameters<typeof agentRolesFor>[1];
    const rows = [
      { authorType: "ai_agent", authorKey: "agent:k1", authorBotKeyId: "k1" },
      { authorType: "ai_agent", authorKey: "agent:k1", authorBotKeyId: "k1" },
      { authorType: "ai_agent", authorKey: "agent:k2", authorBotKeyId: "k2" },
      { authorType: "tech", authorKey: "tech:t1", authorBotKeyId: null },
      { authorType: "ai_agent", authorKey: "ai-admin", authorBotKeyId: null },
    ];
    const roleOf = await agentRolesFor(rows, db);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith({ where: { id: { in: ["k1", "k2"] } }, select: { id: true, agentRole: true } });
    expect(rows.map(roleOf)).toEqual(["admin", "admin", "scout", null, "admin"]);
    // A read with no AI key in it asks for nothing.
    findMany.mockClear();
    await agentRolesFor([{ authorType: "tech", authorKey: "tech:t1", authorBotKeyId: null }], db);
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe("the home button's count: waitingApproval on /hub/badge", () => {
  async function draftOnCustomer(n: number) {
    const customer = await prisma.customer.create({ data: { name: `${TAG} Jane ${randomUUID().slice(0, 4)}`, phone: "6155550101", email: `jane-${randomUUID().slice(0, 6)}@hubfieldagent.example` } });
    const thread = await ensureThreadFor({ customerId: customer.id });
    for (let i = 0; i < n; i++) await createDraftMessage(AI, { threadId: thread.id, channel: "email", category: "thread_reply", subject: `Tuesday ${i}`, body: "We can be there Tuesday.", });
  }
  async function login(personId: string, opts: { powers?: string[]; principal?: boolean }) {
    const row = await saveCrmLogin(personId, { username: `u-${personId.slice(-6)}`, role: "owner", password: PASS });
    if (opts.powers?.length) await setPowers(row.id, opts.powers as never);
    if (opts.principal) await setPrincipal(row.id);
    return row;
  }

  it("counts the drafts waiting for Kyle (principal login) and for a login holding approve_drafts, and is 0 for a plain technician", async () => {
    await draftOnCustomer(2);
    const kyle = await tech("Kyle");
    const michael = await tech("Michael");
    const plain = await tech("Plain");
    const noPower = await tech("NoPower");
    await login(kyle.id, { principal: true });
    await login(michael.id, { powers: ["approve_drafts"] });
    await login(noPower.id, { powers: [] });

    const badge = async (t: { token: string }) => (await get(t.token, "/hub/badge")).body.data as { unread: number; waitingApproval: number };
    expect((await badge(kyle)).waitingApproval).toBe(2);
    expect((await badge(michael)).waitingApproval).toBe(2);
    expect((await badge(plain)).waitingApproval).toBe(0);
    expect((await badge(noPower)).waitingApproval).toBe(0);
    // It is the SAME number the "Waiting for approval" screen lists.
    const list = (await get(kyle.token, "/hub/approvals")).body.data as { cards: unknown[]; canApprove: boolean };
    expect(list.canApprove).toBe(true);
    expect(list.cards).toHaveLength((await badge(kyle)).waitingApproval);
    // Unread still counts as before, beside it.
    expect(typeof (await badge(plain)).unread).toBe("number");
  });

  it("drops to 0 when the approver's login is turned off, and moves when a draft is decided", async () => {
    await draftOnCustomer(1);
    const michael = await tech("Michael");
    const row = await login(michael.id, { powers: ["approve_drafts"] });
    expect(((await get(michael.token, "/hub/badge")).body.data as { waitingApproval: number }).waitingApproval).toBe(1);
    const card = ((await get(michael.token, "/hub/approvals")).body.data as { cards: Array<{ id: string }> }).cards[0]!;
    const rejected = await request(app).post(`/health-record/hub/messages/${card.id}/reject`).set(bearer(michael.token)).send({ reason: "not today" });
    expect(rejected.status).toBe(200);
    expect(((await get(michael.token, "/hub/badge")).body.data as { waitingApproval: number }).waitingApproval).toBe(0);
    await prisma.crmLogin.update({ where: { id: row.id }, data: { enabled: false } });
    await draftOnCustomer(1);
    expect(((await get(michael.token, "/hub/badge")).body.data as { waitingApproval: number }).waitingApproval).toBe(0);
  });
});

describe("live: an agent's posted Team reply reaches the technician at once", () => {
  it("is in the technician's thread read, with its role, and is announced on the live-update bus by the same post", async () => {
    const eric = await tech("Eric");
    const team = await ensureTeamThread(eric.id);
    const key = await makeKey("admin", { writesEnabled: true, teamPostsPublish: true });
    await prisma.companySetting.upsert({
      where: { key: "agentAccess" }, create: { key: "agentAccess", valueJson: JSON.stringify({ mode: "on", changedAt: null, changedBy: null }) },
      update: { valueJson: JSON.stringify({ mode: "on", changedAt: null, changedBy: null }) },
    });
    const agent: HubReader = {
      key: `agent:${key.id}`, kind: "agent", display: key.name, technicianId: null, threadKinds: [], agentRole: "admin", agentKeyId: key.id, agentScopes: ["team:read", "team:reply"], isKyle: false,
    };
    const heard: HubBusEvent[] = [];
    const off = subscribeHub((e) => heard.push(e));
    try {
      const posted = await postMessage(agent, { threadId: team.id, body: "Pulled the 200 amp base for Tuesday." });
      expect(posted.status).toBe("posted");
      expect(heard.some((e) => e.threadId === team.id && e.type === "message")).toBe(true);
    } finally {
      off();
    }
    const read = await wire(eric.token, team.id);
    expect(read).toHaveLength(1);
    expect(read[0]).toMatchObject({ authorType: "ai_agent", agentRole: "admin", body: "Pulled the 200 amp base for Tuesday." });
    // A technician reads it as a technician: the same reader the stream filters with.
    expect(techReader({ id: eric.id, name: eric.name }).key).toBe(`tech:${eric.id}`);
  });
});
