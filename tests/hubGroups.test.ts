/**
 * Office-made group chats (work order agent-team, C7). Kyle, 2026-11-22: "I would rather beable to create a custom chat
 * that allows flexibility as the team grows. The office can create the chat groups and assign members to it including
 * specific AI bots".
 *
 * Pinned here, every way a group is written or read:
 *   * MAKE: any office sign-in (the PIN, a CRM login) makes one with a name and members; the AI admin session, a
 *     technician token and an agent key cannot; a blank name, someone who is not on the team (a customer's id, a
 *     turned-off technician) and an agent key that is switched off are refused; one group_created audit row;
 *   * SEE: the office sees every group (listed even before the first word); a technician and an agent key see only the
 *     groups they are in; the AI admin session sees none; a member's own Team thread is untouched;
 *   * POST: a member posts and the other members are told (push, unread); a non-member office login reads and manages
 *     but is refused with the reason, and is not counted unread or pushed to; a technician who is not in it gets a 403;
 *     a closed group takes no post and a message never reopens it (not even an approval);
 *   * AGENTS: a member key lists, reads and drafts (pending_approval, in_app, scrubbed); a key that is not a member gets
 *     the SAME not found as an id nobody has, on a read and on a post, even when its scopes allow groups; a key limited to
 *     other kinds or without team:reply is refused;
 *   * EXITS: rename, Close and Reopen, add and remove a member (each audited; a removed member stops seeing, hearing and
 *     counting the group at once), and Delete group only while nothing has been said in it;
 *   * REACH: an agent key that could never see or post in a group (no team:reply, or a thread-kinds list that leaves group
 *     out) is greyed in the picker with the reason, refused on create and on add, and flagged in the Members panel when its
 *     scopes change later; AGENT WAKE-UP (W2-C: every member agent whose key can read the group, one event per role; no agent in it, or an agent outside it, sends nothing) - a person's post in a group sends message.team to each such agent;
 *     APPROVALS: a draft in a closed group, or by an agent that has left, cannot be approved and its card says why;
 *   * the marketing-text block reads "Red Cedar never sends marketing by text".
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
const sendNotification = vi.fn();
vi.mock("web-push", () => ({ default: { sendNotification: (...a: unknown[]) => sendNotification(...a), setVapidDetails: vi.fn() } }));

import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { hashPin } from "../src/middleware/pinAuth";
import { saveCrmLogin, setPowers } from "../src/services/crmLogin";
import { saveAdminLogin } from "../src/services/adminLogin";
import { mintAgentKey, type MintAgentKeyInput } from "../src/agentApi/keys";
import { saveSubscription } from "../src/services/hubPush";
import { readerForKey, unreadCounts, visibleThreadWhere, type HubReader } from "../src/services/hub";
import { techReader } from "../src/services/hubTech";
import { SEND_BLOCK_REASONS } from "../shared/hub/sendBlocks";
import { hubKindsFor, HUB_KIND_SCOPES } from "../shared/agentScopes";
import { GROUP_AGENT_CANNOT_REASON, GROUP_DRAFT_CLOSED_REASON, GROUP_DRAFT_LEFT_REASON } from "../shared/hub/groups";

const TAG = "HubGroups";
const RUN = Math.random().toString(36).slice(2, 8);
const PIN = "1234";
const PASS = "correct horse battery";
const AI_PASS = "another long password!";
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const VAPID = { VAPID_PUBLIC_KEY: "BPublicKeyForTests", VAPID_PRIVATE_KEY: "privateKeyForTests", VAPID_SUBJECT: "mailto:test@example.com" } as const;
const PUSH_KEYS = { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" };
const endpoint = (name: string) => `https://fcm.googleapis.com/fcm/send/${TAG}-${RUN}-${name}`;
const pushedTo = (): string[] =>
  (sendNotification.mock.calls as Array<[{ endpoint: string }, string]>).map((c) => c[0].endpoint).filter((e) => e.includes(`${TAG}-${RUN}`));
const settle = () => new Promise((r) => setTimeout(r, 200));

const techIds: string[] = [];
const keyIds: string[] = [];
let savedPin: string | undefined;
let savedPepper: string | undefined;
const savedVapid: Record<string, string | undefined> = {};

async function wipe() {
  await prisma.hubPushSubscription.deleteMany({ where: { endpoint: { contains: `${TAG}-${RUN}` } } });
  await prisma.hubThread.deleteMany({ where: { OR: [{ title: { startsWith: TAG } }, { technicianId: { in: techIds } }] } });
  await prisma.crmLogin.deleteMany({ where: { technicianId: { in: techIds } } });
  await prisma.agentIdempotency.deleteMany({ where: { agentKeyId: { in: keyIds } } });
  await prisma.agentKey.deleteMany({ where: { id: { in: keyIds.splice(0) } } });
  await prisma.technician.deleteMany({ where: { id: { in: techIds.splice(0) } } });
}

beforeAll(async () => {
  savedPin = process.env.PIN_HASH;
  savedPepper = process.env.AGENT_KEY_PEPPER;
  for (const k of Object.keys(VAPID)) savedVapid[k] = process.env[k];
  process.env.PIN_HASH = await hashPin(PIN);
  process.env.AGENT_KEY_PEPPER = "test-pepper-for-the-hub-groups-suite";
  await wipe();
});
afterAll(async () => {
  if (savedPin === undefined) delete process.env.PIN_HASH; else process.env.PIN_HASH = savedPin;
  if (savedPepper === undefined) delete process.env.AGENT_KEY_PEPPER; else process.env.AGENT_KEY_PEPPER = savedPepper;
  for (const [k, v] of Object.entries(savedVapid)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await prisma.adminLogin.deleteMany({ where: { username: `${TAG.toLowerCase()}-ai-${RUN}` } });
  await wipe();
});
beforeEach(async () => {
  await wipe();
  sendNotification.mockReset();
  sendNotification.mockResolvedValue({ statusCode: 201 });
  for (const [k, v] of Object.entries(VAPID)) process.env[k] = v;
});

async function makeTech(name: string, active = true) {
  const t = await prisma.technician.create({ data: { name: `${TAG} ${name}`, isActive: active, accessToken: `hubgroups-${name}-${Math.random().toString(36).slice(2)}` } });
  techIds.push(t.id);
  return t;
}
async function makeOffice(name: string, powers: string[] = []) {
  const t = await makeTech(name);
  const username = `hg_${RUN}_${name.toLowerCase()}`;
  const login = await saveCrmLogin(t.id, { username, role: "office", password: PASS });
  if (powers.length > 0) await setPowers(login.id, powers as never);
  const res = await request(app).post("/auth/login").send({ username, password: PASS });
  expect(res.status).toBe(200);
  return { tech: t, loginId: login.id, token: res.body.token as string };
}
async function aiToken() {
  await prisma.adminLogin.deleteMany({ where: { username: `${TAG.toLowerCase()}-ai-${RUN}` } });
  await saveAdminLogin(`${TAG.toLowerCase()}-ai-${RUN}`, AI_PASS);
  const res = await request(app).post("/auth/login").send({ username: `${TAG.toLowerCase()}-ai-${RUN}`, password: AI_PASS });
  expect(res.status).toBe(200);
  return res.body.token as string;
}
const pinToken = async () => (await request(app).post("/auth/pin").send({ pin: PIN })).body.token as string;

async function mint(overrides: Partial<MintAgentKeyInput> = {}) {
  const made = await mintAgentKey({
    name: `${TAG} ${randomUUID().slice(0, 6)}`, agentRole: "admin", createdBy: "owner", writesEnabled: true,
    scopes: ["hub:read", "hub:draft", "team:reply"], hubThreadKinds: [], ...overrides,
  });
  keyIds.push(made.row.id);
  return { key: made.key, id: made.row.id, name: made.row.name };
}

const mkGroup = (token: string, name: string, members: { technicianIds?: string[]; agentKeyIds?: string[] } = {}) =>
  request(app).post("/hub/groups").set(bearer(token)).send({ name, technicianIds: [], agentKeyIds: [], ...members });
const groupOf = async (token: string, name: string, members: { technicianIds?: string[]; agentKeyIds?: string[] } = {}): Promise<string> => {
  const res = await mkGroup(token, name, members);
  expect(res.status).toBe(201);
  return res.body.id as string;
};
const fieldGet = (token: string, path: string) => request(app).get(`/health-record${path}`).set(bearer(token));
const fieldPost = (token: string, path: string, body: object = {}) => request(app).post(`/health-record${path}`).set(bearer(token)).send(body);
const crmPost = (token: string, id: string, body: string) => request(app).post(`/hub/threads/${id}/messages`).set(bearer(token)).send({ body });

describe("who makes a group, and what it must be made of", () => {
  it("any office sign-in makes one: the PIN and a CRM login; the group lists with no message in it and keeps its members", async () => {
    const eric = await makeTech("Eric");
    const bot = await mint();
    const id = await groupOf(await pinToken(), `${TAG} Install crew`, { technicianIds: [eric.id], agentKeyIds: [bot.id] });
    const michael = await makeOffice("Michael");
    const id2 = await groupOf(michael.token, `${TAG} Office chat`, { technicianIds: [eric.id] });

    const thread = await prisma.hubThread.findUniqueOrThrow({ where: { id }, include: { members: true } });
    expect(thread).toMatchObject({ kind: "group", title: `${TAG} Install crew`, status: "open", customerId: null, leadId: null, visitId: null, technicianId: null });
    expect(thread.members.map((m) => m.technicianId ?? m.agentKeyId).sort()).toEqual([eric.id, bot.id].sort());
    for (const m of thread.members) expect([m.technicianId === null, m.agentKeyId === null].filter(Boolean)).toHaveLength(1);

    const list = await request(app).get("/hub/threads?kind=group").set(bearer(await pinToken()));
    const rows = list.body.threads as Array<{ id: string; kind: string; title: string }>;
    expect(rows.map((r) => r.id)).toEqual(expect.arrayContaining([id, id2]));
    expect(rows.every((r) => r.kind === "group")).toBe(true);

    const audit = await prisma.hubAuditLog.findMany({ where: { threadId: id, action: "group_created" } });
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0]!.detailsJson!)).toMatchObject({ technicianIds: [eric.id], agentKeyIds: [bot.id] });
  });

  it("the AI admin session, a technician's token and an agent key cannot make, add to, remove from or delete a group", async () => {
    const eric = await makeTech("Eric");
    const bot = await mint();
    const id = await groupOf(await pinToken(), `${TAG} Locked`, { technicianIds: [eric.id] });
    const ai = await aiToken();
    expect((await mkGroup(ai, `${TAG} By AI`)).status).toBe(403);
    expect((await request(app).get("/hub/groups/choices").set(bearer(ai))).status).toBe(403);
    expect((await request(app).post(`/hub/groups/${id}/members`).set(bearer(ai)).send({ technicianIds: [], agentKeyIds: [bot.id] })).status).toBe(403);
    expect((await request(app).delete(`/hub/groups/${id}`).set(bearer(ai))).status).toBe(403);
    for (const token of [eric.accessToken, bot.key]) {
      expect((await mkGroup(token, `${TAG} By other`)).status).toBe(401);
      expect((await request(app).delete(`/hub/groups/${id}`).set(bearer(token))).status).toBe(401);
    }
    expect(await prisma.hubThread.count({ where: { kind: "group", title: { startsWith: `${TAG} By` } } })).toBe(0);
    expect(await prisma.hubThreadMember.count({ where: { threadId: id } })).toBe(1);
  });

  it("refuses a blank name, a customer's id, a turned-off person and an agent that is switched off - and makes nothing", async () => {
    const pin = await pinToken();
    const gone = await makeTech("Gone", false);
    const eric = await makeTech("Eric");
    const revoked = await mint();
    await prisma.agentKey.update({ where: { id: revoked.id }, data: { revokedAt: new Date() } });
    const customer = await prisma.customer.create({ data: { name: `${TAG} Customer` } });
    try {
      expect((await mkGroup(pin, "   ", { technicianIds: [eric.id] })).status).toBe(400);
      const asCustomer = await mkGroup(pin, `${TAG} Bad`, { technicianIds: [customer.id] });
      expect(asCustomer.status).toBe(400);
      expect((await mkGroup(pin, `${TAG} Bad`, { technicianIds: [gone.id] })).status).toBe(400);
      expect((await mkGroup(pin, `${TAG} Bad`, { agentKeyIds: [revoked.id] })).status).toBe(400);
      expect((await mkGroup(pin, "x".repeat(121))).status).toBe(400);
      expect(await prisma.hubThread.count({ where: { kind: "group", title: { startsWith: `${TAG} Bad` } } })).toBe(0);
      expect(await prisma.hubThreadMember.count({ where: { OR: [{ technicianId: customer.id }, { agentKeyId: revoked.id }] } })).toBe(0);
    } finally {
      await prisma.customer.delete({ where: { id: customer.id } });
    }
  });

  it("the picker offers active people and agents only, by name and role, and never a customer or a token", async () => {
    await makeTech("Eric");
    await makeTech("Off", false);
    const on = await mint({ agentRole: "inventory", scopes: ["inventory:read"] });
    const off = await mint();
    await prisma.agentKey.update({ where: { id: off.id }, data: { revokedAt: new Date() } });
    const res = await request(app).get("/hub/groups/choices").set(bearer(await pinToken()));
    expect(res.status).toBe(200);
    const people = (res.body.people as Array<{ id: string; name: string }>).map((p) => p.name);
    expect(people).toContain(`${TAG} Eric`);
    expect(people).not.toContain(`${TAG} Off`);
    const agents = res.body.agents as Array<{ id: string; name: string; roleLabel: string; canJoin: boolean; reason: string | null }>;
    // An Inventory key with no Team replies scope is listed, but greyed with the reason (see the REACH tests).
    expect(agents.find((a) => a.id === on.id)).toMatchObject({ name: on.name, roleLabel: "Inventory Manager", canJoin: false, reason: GROUP_AGENT_CANNOT_REASON });
    expect(agents.find((a) => a.id === off.id)).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toMatch(/accessToken|secretHash|hubgroups-/);
  });
});

describe("who sees a group", () => {
  it("a member technician has it in the field Messages list beside their own Team thread; another technician does not, and is refused the thread", async () => {
    const eric = await makeTech("Eric");
    const sam = await makeTech("Sam");
    const id = await groupOf(await pinToken(), `${TAG} Install crew`, { technicianIds: [eric.id] });

    const mine = await fieldGet(eric.accessToken, "/hub/threads");
    const rows = mine.body.data.threads as Array<{ key: string; kind: string; threadId: string; title: string }>;
    expect(rows.map((r) => r.key)).toEqual(["team", `group:${id}`]);
    expect(rows[1]).toMatchObject({ kind: "group", threadId: id, title: `${TAG} Install crew` });
    expect(rows[0]).toMatchObject({ kind: "team" }); // the person's own Team thread stays exactly as built

    const theirs = await fieldGet(sam.accessToken, "/hub/threads");
    expect((theirs.body.data.threads as Array<{ kind: string }>).map((r) => r.kind)).toEqual(["team"]);
    expect((await fieldGet(sam.accessToken, `/hub/threads/${id}/messages`)).status).toBe(403);
    expect((await fieldGet(eric.accessToken, `/hub/threads/${id}/messages`)).body.data.thread).toMatchObject({ kind: "group", id });
  });

  it("the office sees every group, a CRM login that is not in it included; the AI admin session sees none", async () => {
    const eric = await makeTech("Eric");
    const michael = await makeOffice("Michael");
    const id = await groupOf(await pinToken(), `${TAG} Install crew`, { technicianIds: [eric.id] });
    const asMichael = await request(app).get("/hub/threads?kind=group").set(bearer(michael.token));
    expect((asMichael.body.threads as Array<{ id: string }>).map((t) => t.id)).toContain(id);
    expect((await request(app).get(`/hub/threads/${id}`).set(bearer(michael.token))).status).toBe(200);
    const ai = await aiToken();
    expect(((await request(app).get("/hub/threads").set(bearer(ai))).body.threads as Array<{ id: string }>).map((t) => t.id)).not.toContain(id);
    expect((await request(app).get(`/hub/threads/${id}`).set(bearer(ai))).status).toBe(404);
  });

  it("the detail carries the members, whether the reader is one, and the Delete group state", async () => {
    const eric = await makeTech("Eric");
    const michael = await makeOffice("Michael");
    const bot = await mint({ agentRole: "inventory" });
    const id = await groupOf(michael.token, `${TAG} Mixed`, { technicianIds: [eric.id, michael.tech.id], agentKeyIds: [bot.id] });
    const detail = (await request(app).get(`/hub/threads/${id}`).set(bearer(michael.token))).body;
    expect(detail.group.youAreMember).toBe(true);
    expect(detail.group.canDelete).toBe(true);
    expect(detail.group.deleteReason).toBeNull();
    const byName = Object.fromEntries((detail.group.members as Array<{ name: string; kind: string; roleLabel: string | null; you: boolean; active: boolean }>).map((m) => [m.name, m]));
    expect(byName[`${TAG} Eric`]).toMatchObject({ kind: "person", roleLabel: null, you: false, active: true });
    expect(byName[`${TAG} Michael`]).toMatchObject({ kind: "person", you: true });
    expect(byName[bot.name]).toMatchObject({ kind: "agent", roleLabel: "Inventory Manager", active: true });
    expect(JSON.stringify(detail)).not.toMatch(/accessToken|secretHash/);
  });
});

describe("posting, unread and notification", () => {
  it("a member posts from the field; the other member is told and has it unread, the office login that is not in it is neither", async () => {
    const eric = await makeTech("Eric");
    const sam = await makeTech("Sam");
    const lou = await makeTech("Lou");
    const michael = await makeOffice("Michael");
    const id = await groupOf(await pinToken(), `${TAG} Install crew`, { technicianIds: [eric.id, sam.id] });
    await saveSubscription(`tech:${eric.id}`, { endpoint: endpoint("eric"), keys: PUSH_KEYS }, "t");
    await saveSubscription(`tech:${sam.id}`, { endpoint: endpoint("sam"), keys: PUSH_KEYS }, "t");
    await saveSubscription(`tech:${lou.id}`, { endpoint: endpoint("lou"), keys: PUSH_KEYS }, "t");
    await saveSubscription(`user:${michael.loginId}`, { endpoint: endpoint("michael"), keys: PUSH_KEYS }, "t");

    const sent = await fieldPost(eric.accessToken, `/hub/threads/${id}/messages`, { body: "Truck is loaded" });
    expect(sent.status).toBe(201);
    await settle();
    expect(pushedTo().sort()).toEqual([endpoint("sam")]);
    const payload = JSON.parse((sendNotification.mock.calls as Array<[unknown, string]>).find((c) => (c[0] as { endpoint: string }).endpoint === endpoint("sam"))![1]) as { body: string; url: string };
    expect(payload).toMatchObject({ body: "New message in a group chat", url: `/field/?thread=${id}` });

    const samList = await fieldGet(sam.accessToken, "/hub/threads");
    expect((samList.body.data.threads as Array<{ key: string; unread: number }>).find((t) => t.key === `group:${id}`)!.unread).toBe(1);
    expect((await fieldGet(sam.accessToken, "/hub/badge")).body.data.unread).toBe(1);
    expect((await fieldGet(eric.accessToken, "/hub/badge")).body.data.unread).toBe(0); // the author's own message

    const michaelBadge = await request(app).get("/hub/badge").set(bearer(michael.token));
    expect(michaelBadge.body.unread).toBe(0);
    const michaelRow = ((await request(app).get("/hub/threads?kind=group").set(bearer(michael.token))).body.threads as Array<{ id: string; unread: number }>).find((t) => t.id === id)!;
    expect(michaelRow.unread).toBe(0);
    // The office reader reads it all the same.
    expect((await request(app).get(`/hub/threads/${id}`).set(bearer(michael.token))).body.messages).toHaveLength(1);
  });

  it("an office login that is in the group is counted unread and pushed to, and can post", async () => {
    const eric = await makeTech("Eric");
    const michael = await makeOffice("Michael");
    const id = await groupOf(await pinToken(), `${TAG} Office`, { technicianIds: [eric.id, michael.tech.id] });
    await saveSubscription(`user:${michael.loginId}`, { endpoint: endpoint("michael"), keys: PUSH_KEYS }, "t");
    expect((await fieldPost(eric.accessToken, `/hub/threads/${id}/messages`, { body: "Morning" })).status).toBe(201);
    await settle();
    expect(pushedTo()).toEqual([endpoint("michael")]);
    expect((await request(app).get("/hub/badge").set(bearer(michael.token))).body.unread).toBe(1);
    expect((await crmPost(michael.token, id, "Morning, Eric")).status).toBe(201);
  });

  it("an office login that is not a member reads and manages but cannot post: 403 with the reason, no message; the detail says so", async () => {
    const eric = await makeTech("Eric");
    const michael = await makeOffice("Michael");
    const id = await groupOf(await pinToken(), `${TAG} Crew`, { technicianIds: [eric.id] });
    const refused = await crmPost(michael.token, id, "Can I join?");
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatch(/not a member of this group/);
    expect(await prisma.hubMessage.count({ where: { threadId: id } })).toBe(0);
    const detail = (await request(app).get(`/hub/threads/${id}`).set(bearer(michael.token))).body;
    expect(detail.postBlock).toMatch(/Add yourself under Members/);
    expect(detail.group.youAreMember).toBe(false);
    // Add himself with the same Add members button the office uses for anyone, and he can post.
    const added = await request(app).post(`/hub/groups/${id}/members`).set(bearer(michael.token)).send({ technicianIds: [michael.tech.id], agentKeyIds: [] });
    expect(added.status).toBe(200);
    expect(added.body.group.youAreMember).toBe(true);
    expect((await crmPost(michael.token, id, "Now I am in")).status).toBe(201);
  });

  it("a technician who is not in the group cannot post in it, and a group takes no customer or photo", async () => {
    const eric = await makeTech("Eric");
    const sam = await makeTech("Sam");
    const id = await groupOf(await pinToken(), `${TAG} Crew`, { technicianIds: [eric.id] });
    expect((await fieldPost(sam.accessToken, `/hub/threads/${id}/messages`, { body: "Let me in" })).status).toBe(403);
    expect(await prisma.hubMessage.count({ where: { threadId: id } })).toBe(0);
    // Words only: a photo is refused with the reason the screen shows.
    const photo = await request(app).post(`/health-record/hub/threads/${id}/attachments`).set(bearer(eric.accessToken)).set("Content-Type", "image/png").send(Buffer.from("not-an-image"));
    expect(photo.status).toBe(409);
  });
});

describe("the exits: rename, close and reopen, add and remove a member, delete an empty group", () => {
  it("Rename and Close group are the thread's own buttons, audited; a closed group takes no post, leaves the field list, and Reopen brings it back", async () => {
    const eric = await makeTech("Eric");
    const pin = await pinToken();
    const id = await groupOf(pin, `${TAG} Crew`, { technicianIds: [eric.id] });
    expect((await fieldPost(eric.accessToken, `/hub/threads/${id}/messages`, { body: "First" })).status).toBe(201);

    const renamed = await request(app).patch(`/hub/threads/${id}`).set(bearer(pin)).send({ title: `${TAG} Crew 2` });
    expect(renamed.status).toBe(200);
    expect(renamed.body.thread.title).toBe(`${TAG} Crew 2`);
    expect(await prisma.hubAuditLog.count({ where: { threadId: id, action: "thread_renamed" } })).toBe(1);

    expect((await request(app).patch(`/hub/threads/${id}`).set(bearer(pin)).send({ status: "closed" })).status).toBe(200);
    const closedPost = await fieldPost(eric.accessToken, `/hub/threads/${id}/messages`, { body: "Still here?" });
    expect(closedPost.status).toBe(403);
    expect(closedPost.body.error.message).toBe("This group is closed. Reopen it to post.");
    expect((await request(app).get(`/hub/threads/${id}`).set(bearer(pin))).body.postBlock).toBe("This group is closed. Reopen it to post.");
    expect((await fieldGet(eric.accessToken, "/hub/threads")).body.data.threads.map((t: { kind: string }) => t.kind)).toEqual(["team"]);
    expect((await prisma.hubThread.findUniqueOrThrow({ where: { id } })).status).toBe("closed");

    expect((await request(app).patch(`/hub/threads/${id}`).set(bearer(pin)).send({ status: "open" })).status).toBe(200);
    expect((await fieldPost(eric.accessToken, `/hub/threads/${id}/messages`, { body: "Back" })).status).toBe(201);
    expect((await fieldGet(eric.accessToken, "/hub/threads")).body.data.threads.map((t: { kind: string }) => t.kind)).toEqual(["team", "group"]);
  });

  it("adding skips someone already in; removing stops the member's list, thread, stream, push and unread at once; each is audited", async () => {
    const eric = await makeTech("Eric");
    const sam = await makeTech("Sam");
    const pin = await pinToken();
    const id = await groupOf(pin, `${TAG} Crew`, { technicianIds: [eric.id, sam.id] });
    await saveSubscription(`tech:${sam.id}`, { endpoint: endpoint("sam"), keys: PUSH_KEYS }, "t");
    expect((await fieldPost(eric.accessToken, `/hub/threads/${id}/messages`, { body: "One" })).status).toBe(201);
    await settle();
    expect(pushedTo()).toEqual([endpoint("sam")]);
    expect(await unreadCounts(techReader(sam))).toMatchObject({ total: 1 });

    const again = await request(app).post(`/hub/groups/${id}/members`).set(bearer(pin)).send({ technicianIds: [eric.id], agentKeyIds: [] });
    expect(again.status).toBe(200);
    expect(await prisma.hubThreadMember.count({ where: { threadId: id } })).toBe(2);
    expect(await prisma.hubAuditLog.count({ where: { threadId: id, action: "group_member_added" } })).toBe(0);

    const removed = await request(app).delete(`/hub/groups/${id}/members`).set(bearer(pin)).send({ technicianId: sam.id });
    expect(removed.status).toBe(200);
    expect((removed.body.group.members as Array<{ id: string }>).map((m) => m.id)).toEqual([eric.id]);
    expect(await prisma.hubAuditLog.count({ where: { threadId: id, action: "group_member_removed" } })).toBe(1);

    // Sam: not in the list, not openable, no unread, no push, and the stream's own visibility question says no.
    expect((await fieldGet(sam.accessToken, "/hub/threads")).body.data.threads.map((t: { kind: string }) => t.kind)).toEqual(["team"]);
    expect((await fieldGet(sam.accessToken, `/hub/threads/${id}/messages`)).status).toBe(403);
    expect((await fieldPost(sam.accessToken, `/hub/threads/${id}/messages`, { body: "Still me" })).status).toBe(403);
    expect(await unreadCounts(techReader(sam))).toMatchObject({ total: 0 });
    expect(await prisma.hubThread.count({ where: { AND: [{ id }, visibleThreadWhere(techReader(sam))] } })).toBe(0);
    sendNotification.mockClear();
    expect((await fieldPost(eric.accessToken, `/hub/threads/${id}/messages`, { body: "Two" })).status).toBe(201);
    await settle();
    expect(pushedTo()).toEqual([]);

    expect((await request(app).delete(`/hub/groups/${id}/members`).set(bearer(pin)).send({ technicianId: sam.id })).status).toBe(404);
    expect((await request(app).delete(`/hub/groups/${id}/members`).set(bearer(pin)).send({})).status).toBe(400);
  });

  it("Delete group works only while nothing has been said: a used group keeps its history and says why; an empty one goes with an audit row", async () => {
    const eric = await makeTech("Eric");
    const pin = await pinToken();
    const used = await groupOf(pin, `${TAG} Used`, { technicianIds: [eric.id] });
    const empty = await groupOf(pin, `${TAG} Empty`, { technicianIds: [eric.id] });
    expect((await fieldPost(eric.accessToken, `/hub/threads/${used}/messages`, { body: "Hello" })).status).toBe(201);

    const detail = (await request(app).get(`/hub/threads/${used}`).set(bearer(pin))).body;
    expect(detail.group.canDelete).toBe(false);
    expect(detail.group.deleteReason).toMatch(/history is kept/);
    const refused = await request(app).delete(`/hub/groups/${used}`).set(bearer(pin));
    expect(refused.status).toBe(409);
    expect(await prisma.hubThread.count({ where: { id: used } })).toBe(1);
    // Even after the message is deleted, its row is history: still no delete.
    const message = await prisma.hubMessage.findFirstOrThrow({ where: { threadId: used } });
    expect((await request(app).delete(`/hub/messages/${message.id}`).set(bearer(pin)).send({ reason: "typo" })).status).toBe(204);
    expect((await request(app).delete(`/hub/groups/${used}`).set(bearer(pin))).status).toBe(409);

    expect((await request(app).delete(`/hub/groups/${empty}`).set(bearer(pin))).status).toBe(204);
    expect(await prisma.hubThread.count({ where: { id: empty } })).toBe(0);
    expect(await prisma.hubThreadMember.count({ where: { threadId: empty } })).toBe(0);
    expect(await prisma.hubAuditLog.count({ where: { threadId: empty, action: "group_deleted" } })).toBe(1);
    // Only a group: no route deletes any other kind of thread.
    const team = await fieldGet(eric.accessToken, "/hub/threads");
    const teamId = (team.body.data.threads as Array<{ kind: string; threadId: string }>).find((t) => t.kind === "team")!.threadId;
    expect((await request(app).delete(`/hub/groups/${teamId}`).set(bearer(pin))).status).toBe(404);
    expect(await prisma.hubThread.count({ where: { id: teamId } })).toBe(1);
  });
});

describe("the agent door: a key sees and posts only in the groups it is a member of", () => {
  // W2 (Kyle 2026-11-23): a key's post in a group is published by its own "Team posts publish immediately" box (default ON). The tests that are about a
  // post WAITING for a person mint the key with the box off, which is the case they were written for.
  it("a member key with its Team posts box ON posts at once in the group, and the technician sees it", async () => {
    const eric = await makeTech("Eric");
    const bot = await mint();
    const id = await groupOf(await pinToken(), `${TAG} Crew`, { technicianIds: [eric.id], agentKeyIds: [bot.id] });
    const res = await request(app).post("/api/hub/messages").set(bearer(bot.key)).send({ thread_id: id, body: "Parts are in.", idempotency_key: `idem-${randomUUID()}` });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ threadId: id, status: "posted", channel: "in_app" });
    expect(JSON.stringify((await fieldGet(eric.accessToken, `/hub/threads/${id}/messages`)).body)).toContain("Parts are in.");
  });

  it("a member key (Team posts box off) lists the group, reads it and leaves a pending_approval in_app draft (the Team rule), scrubbed; the human's name is a first name", async () => {
    const eric = await makeTech("Eric");
    const bot = await mint({ teamPostsPublish: false });
    const pin = await pinToken();
    const id = await groupOf(pin, `${TAG} Crew 615-555-0142`, { technicianIds: [eric.id], agentKeyIds: [bot.id] });
    expect((await fieldPost(eric.accessToken, `/hub/threads/${id}/messages`, { body: "Call me on 615-555-0142" })).status).toBe(201);

    const list = await request(app).get("/api/hub/threads").set(bearer(bot.key));
    expect(list.status).toBe(200);
    const row = (list.body.threads as Array<{ id: string; kind: string; title: string }>).find((t) => t.id === id)!;
    expect(row.kind).toBe("group");
    expect(row.title).not.toMatch(/555/);
    const read = await request(app).get(`/api/hub/threads/${id}/messages`).set(bearer(bot.key));
    expect(read.status).toBe(200);
    expect(JSON.stringify(read.body)).not.toMatch(/555-0142/);

    const draft = await request(app).post("/api/hub/messages").set(bearer(bot.key)).send({ thread_id: id, body: "Noted, thanks.", idempotency_key: `idem-${randomUUID()}` });
    expect(draft.status).toBe(201);
    expect(draft.body).toMatchObject({ threadId: id, status: "pending_approval", channel: "in_app" });
    const row2 = await prisma.hubMessage.findFirstOrThrow({ where: { threadId: id, authorBotKeyId: bot.id } });
    expect(row2).toMatchObject({ status: "pending_approval", authorType: "ai_agent", channel: "in_app", direction: "internal" });
    // Nothing reaches a technician until a person approves it.
    const seen = await fieldGet(eric.accessToken, `/hub/threads/${id}/messages`);
    expect((seen.body.data.messages as Array<{ body: string }>).map((m) => m.body)).toEqual(["Call me on 615-555-0142"]);
  });

  it("a key that is NOT a member gets the very same not found as an id nobody has - listing, reading and posting - and never sees the group in its list", async () => {
    const eric = await makeTech("Eric");
    const member = await mint();
    const outsider = await mint(); // same scopes, no hubThreadKinds limit: only membership keeps it out
    const id = await groupOf(await pinToken(), `${TAG} Crew`, { technicianIds: [eric.id], agentKeyIds: [member.id] });
    const unknown = `cl${randomUUID().replace(/-/g, "").slice(0, 23)}`;
    const strip = (b: Record<string, unknown>) => {
      const { call_id: _c, callId: _c2, request_id: _r, requestId: _r2, ...rest } = b as Record<string, unknown>;
      return rest;
    };

    const list = await request(app).get("/api/hub/threads").set(bearer(outsider.key));
    expect((list.body.threads as Array<{ id: string }>).map((t) => t.id)).not.toContain(id);

    const readHidden = await request(app).get(`/api/hub/threads/${id}/messages`).set(bearer(outsider.key));
    const readUnknown = await request(app).get(`/api/hub/threads/${unknown}/messages`).set(bearer(outsider.key));
    expect(readHidden.status).toBe(404);
    expect(readUnknown.status).toBe(404);
    expect(strip(readHidden.body)).toEqual(strip(readUnknown.body));

    const body = (threadId: string) => ({ thread_id: threadId, body: "Let me in", idempotency_key: `idem-${randomUUID()}` });
    const postHidden = await request(app).post("/api/hub/messages").set(bearer(outsider.key)).send(body(id));
    const postUnknown = await request(app).post("/api/hub/messages").set(bearer(outsider.key)).send(body(unknown));
    expect(postHidden.status).toBe(404);
    expect(postUnknown.status).toBe(404);
    expect(strip(postHidden.body)).toEqual(strip(postUnknown.body));
    expect(await prisma.hubMessage.count({ where: { threadId: id } })).toBe(0);

    // A key limited to another kind, or with no team:reply, is also told "not found" while it is outside; a MEMBER without
    // the scope is told what the scope is (403), because it is allowed to know the group is there.
    // (A key that cannot reach groups is refused on add - see the REACH tests - so these two are added while they can, then
    // narrowed, the way a key changed after it was added would be.)
    const noScope = await mint();
    const training = await mint();
    await request(app).post(`/hub/groups/${id}/members`).set(bearer(await pinToken())).send({ technicianIds: [], agentKeyIds: [noScope.id, training.id] });
    await prisma.agentKey.update({ where: { id: noScope.id }, data: { scopes: ["hub:read", "hub:draft"] } });
    await prisma.agentKey.update({ where: { id: training.id }, data: { hubThreadKinds: ["training"], scopes: ["hub:read", "hub:draft", "team:reply", "training:read"] } });
    expect((await request(app).get(`/api/hub/threads/${id}/messages`).set(bearer(noScope.key))).status).toBe(403);
    expect((await request(app).get(`/api/hub/threads/${id}/messages`).set(bearer(training.key))).status).toBe(403);
  });

  it("removing the key from the group takes it away at once; the door and the hub agree with the table in shared/agentScopes.ts", async () => {
    const bot = await mint();
    const pin = await pinToken();
    const id = await groupOf(pin, `${TAG} Crew`, { agentKeyIds: [bot.id] });
    expect((await request(app).get(`/api/hub/threads/${id}/messages`).set(bearer(bot.key))).status).toBe(200);
    const removed = await request(app).delete(`/hub/groups/${id}/members`).set(bearer(pin)).send({ agentKeyId: bot.id });
    expect(removed.status).toBe(200);
    expect((await request(app).get(`/api/hub/threads/${id}/messages`).set(bearer(bot.key))).status).toBe(404);
    expect(HUB_KIND_SCOPES.group).toEqual({ read: ["team:read", "team:reply"], post: ["team:reply"] });
    // W1b: a job thread is the crew chat; an agent posts there with team:reply (an in-app crew post), not hub:draft (a message to the customer).
    expect(hubKindsFor(["team:reply"], "post")).toEqual(["job", "team", "group"]);
    expect(hubKindsFor(["hub:draft"], "post")).toEqual(["customer"]);
  });

  it("an agent's pending post is approved by the approver and lands in the group; a draft in a CLOSED group cannot be approved (and nothing reopens it)", async () => {
    const eric = await makeTech("Eric");
    const bot = await mint({ teamPostsPublish: false });
    const pin = await pinToken();
    const id = await groupOf(pin, `${TAG} Crew`, { technicianIds: [eric.id], agentKeyIds: [bot.id] });
    const send = (text: string) => request(app).post("/api/hub/messages").set(bearer(bot.key)).send({ thread_id: id, body: text, idempotency_key: `idem-${randomUUID()}` });
    const first = await send("Ready for the walkthrough.");
    expect(first.status).toBe(201);
    const second = await send("Another note.");
    expect(second.status).toBe(201);

    const approved = await request(app).post(`/hub/messages/${first.body.messageId}/approve`).set(bearer(pin));
    expect(approved.status).toBe(200);
    const eric1 = await fieldGet(eric.accessToken, `/hub/threads/${id}/messages`);
    expect((eric1.body.data.messages as Array<{ body: string; authorLabel: string }>).map((m) => m.body)).toEqual(["Ready for the walkthrough."]);

    expect((await request(app).patch(`/hub/threads/${id}`).set(bearer(pin)).send({ status: "closed" })).status).toBe(200);
    // Closing the group leaves the draft waiting: Approve is refused with the reason and posts nothing; the card is greyed with it.
    const refused = await request(app).post(`/hub/messages/${second.body.messageId}/approve`).set(bearer(pin));
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe(GROUP_DRAFT_CLOSED_REASON);
    expect((await prisma.hubMessage.findUniqueOrThrow({ where: { id: second.body.messageId } })).status).toBe("pending_approval");
    expect((await prisma.hubThread.findUniqueOrThrow({ where: { id } })).status).toBe("closed");
    // And the agent itself cannot post into a closed group it belongs to.
    const closedDraft = await send("Anyone?");
    expect(closedDraft.status).toBe(403);
    // The card is greyed with the very sentence the server refuses with, "Send my version" too, and Reject is still its exit.
    const cards = await request(app).get(`/hub/approvals?threadId=${id}`).set(bearer(pin));
    const card = (cards.body.cards as Array<{ id: string; approve: { blockedReason: string | null; editBlockedReason: string | null } }>).find((c) => c.id === second.body.messageId)!;
    expect(card.approve.blockedReason).toBe(GROUP_DRAFT_CLOSED_REASON);
    expect(card.approve.editBlockedReason).toBe(GROUP_DRAFT_CLOSED_REASON);
    const editRefused = await request(app).post(`/hub/messages/${second.body.messageId}/edit-approve`).set(bearer(pin)).send({ body: "My version" });
    expect(editRefused.status).toBe(409);
    expect(editRefused.body.error).toBe(GROUP_DRAFT_CLOSED_REASON);
    expect((await prisma.hubMessage.findUniqueOrThrow({ where: { id: second.body.messageId } })).status).toBe("pending_approval");
    // Reopen, and the same draft approves and posts.
    expect((await request(app).patch(`/hub/threads/${id}`).set(bearer(pin)).send({ status: "open" })).status).toBe(200);
    expect((await request(app).post(`/hub/messages/${second.body.messageId}/approve`).set(bearer(pin))).status).toBe(200);
    expect((await prisma.hubMessage.findUniqueOrThrow({ where: { id: second.body.messageId } })).status).toBe("posted");
  });

  it("a draft whose agent was taken out of the group cannot be approved or edit-approved, its card says why, and Reject clears it", async () => {
    const eric = await makeTech("Eric");
    const bot = await mint({ teamPostsPublish: false });
    const pin = await pinToken();
    const id = await groupOf(pin, `${TAG} Crew`, { technicianIds: [eric.id], agentKeyIds: [bot.id] });
    const draft = await request(app).post("/api/hub/messages").set(bearer(bot.key)).send({ thread_id: id, body: "Parts are in.", idempotency_key: `idem-${randomUUID()}` });
    expect(draft.status).toBe(201);
    expect((await request(app).delete(`/hub/groups/${id}/members`).set(bearer(pin)).send({ agentKeyId: bot.id })).status).toBe(200);

    const refused = await request(app).post(`/hub/messages/${draft.body.messageId}/approve`).set(bearer(pin));
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe(GROUP_DRAFT_LEFT_REASON);
    const editRefused = await request(app).post(`/hub/messages/${draft.body.messageId}/edit-approve`).set(bearer(pin)).send({ body: "Parts are in." });
    expect(editRefused.status).toBe(409);
    expect(editRefused.body.error).toBe(GROUP_DRAFT_LEFT_REASON);
    const cards = await request(app).get(`/hub/approvals?threadId=${id}`).set(bearer(pin));
    const card = (cards.body.cards as Array<{ id: string; approve: { blockedReason: string | null } }>).find((c) => c.id === draft.body.messageId)!;
    expect(card.approve.blockedReason).toBe(GROUP_DRAFT_LEFT_REASON);
    expect((await prisma.hubMessage.findUniqueOrThrow({ where: { id: draft.body.messageId } })).status).toBe("pending_approval");
    expect(JSON.stringify((await fieldGet(eric.accessToken, `/hub/threads/${id}/messages`)).body)).not.toContain("Parts are in.");

    const rejected = await request(app).post(`/hub/messages/${draft.body.messageId}/reject`).set(bearer(pin)).send({ reason: "Agent left the group" });
    expect(rejected.status).toBe(200);
    expect((await prisma.hubMessage.findUniqueOrThrow({ where: { id: draft.body.messageId } })).status).toBe("rejected");
  });
});

describe("an agent key that could never reach a group is not offered, not added, and not shown as a working member", () => {
  const picker = async (token: string) =>
    (await request(app).get("/hub/groups/choices").set(bearer(token))).body.agents as Array<{ id: string; canJoin: boolean; reason: string | null }>;

  it("the picker marks every key without team:reply, or with a kinds list that leaves out group, and gives the reason", async () => {
    const ok = await mint();
    const noScope = await mint({ agentRole: "inventory", scopes: ["inventory:read"] });
    const trainingOnly = await mint({ agentRole: "scout", hubThreadKinds: ["training"], scopes: ["training:read", "team:reply"] });
    const narrowed = await mint({ hubThreadKinds: ["customer", "job", "team"] });
    const agents = await picker(await pinToken());
    expect(agents.find((a) => a.id === ok.id)).toMatchObject({ canJoin: true, reason: null });
    for (const k of [noScope, trainingOnly, narrowed]) {
      expect(agents.find((a) => a.id === k.id)).toMatchObject({ canJoin: false, reason: GROUP_AGENT_CANNOT_REASON });
    }
    // It is the SAME rule the hub and the door use: what the picker calls joinable is exactly what hubKindsFor lets see a group.
    expect(hubKindsFor(["inventory:read"], "any")).not.toContain("group");
    expect(hubKindsFor(["training:read", "team:reply"], "any", ["training"])).not.toContain("group");
    expect(hubKindsFor(["hub:read", "hub:draft", "team:reply"], "any", ["customer", "job", "team"])).not.toContain("group");
  });

  it("creating a group with such a key, or adding it later, is refused with the reason, and nothing is made or added", async () => {
    const pin = await pinToken();
    const noScope = await mint({ agentRole: "inventory", scopes: ["inventory:read"] });
    const narrowed = await mint({ hubThreadKinds: ["customer", "job", "team"] });
    const created = await mkGroup(pin, `${TAG} Bad`, { agentKeyIds: [noScope.id] });
    expect(created.status).toBe(400);
    expect(created.body.error).toBe(GROUP_AGENT_CANNOT_REASON);
    expect(await prisma.hubThread.count({ where: { kind: "group", title: { startsWith: `${TAG} Bad` } } })).toBe(0);

    const id = await groupOf(pin, `${TAG} Crew`);
    for (const k of [noScope, narrowed]) {
      const added = await request(app).post(`/hub/groups/${id}/members`).set(bearer(pin)).send({ technicianIds: [], agentKeyIds: [k.id] });
      expect(added.status).toBe(400);
      expect(added.body.error).toBe(GROUP_AGENT_CANNOT_REASON);
    }
    expect(await prisma.hubThreadMember.count({ where: { threadId: id } })).toBe(0);
  });

  it("a member whose key is narrowed after it was added is flagged in the Members panel with the reason, not 'active'", async () => {
    const pin = await pinToken();
    const bot = await mint();
    const id = await groupOf(pin, `${TAG} Crew`, { agentKeyIds: [bot.id] });
    const member = async () => ((await request(app).get(`/hub/threads/${id}`).set(bearer(pin))).body.group.members as Array<{ id: string; active: boolean; reason: string | null }>).find((m) => m.id === bot.id)!;
    expect(await member()).toMatchObject({ active: true, reason: null });
    await prisma.agentKey.update({ where: { id: bot.id }, data: { scopes: ["hub:read", "hub:draft"] } });
    expect(await member()).toMatchObject({ active: false, reason: GROUP_AGENT_CANNOT_REASON });
    await prisma.agentKey.update({ where: { id: bot.id }, data: { scopes: ["hub:read", "hub:draft", "team:reply"], revokedAt: new Date() } });
    expect(await member()).toMatchObject({ active: false, reason: "switched off" });
  });
});

describe("a person's post in a group wakes the routed agent only when that agent is a member", () => {
  const teamEventsFor = (threadId: string) =>
    prisma.hubEvent.findMany({ where: { type: "message.team", payloadJson: { contains: threadId } } });
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  afterEach(async () => {
    const mine = await prisma.hubEvent.findMany({ where: { type: "message.team", payloadJson: { contains: '"kind":"group"' } }, select: { id: true } });
    await prisma.hubEventAttempt.deleteMany({ where: { eventId: { in: mine.map((e) => e.id) } } });
    await prisma.hubEvent.deleteMany({ where: { id: { in: mine.map((e) => e.id) } } });
  });
  /** Wait long enough for an event that WOULD be sent to have been recorded, then count. */
  async function settledCount(threadId: string): Promise<number> {
    await wait(500);
    return (await teamEventsFor(threadId)).length;
  }
  async function eventCount(threadId: string, want: number): Promise<number> {
    const end = Date.now() + 3000;
    while (Date.now() < end && (await teamEventsFor(threadId)).length < want) await wait(25);
    await wait(250);
    return (await teamEventsFor(threadId)).length;
  }

  it("an Admin member key gets exactly one message.team event naming the group's thread and message", async () => {
    const eric = await makeTech("Eric");
    const admin = await mint({ agentRole: "admin" });
    const id = await groupOf(await pinToken(), `${TAG} Crew`, { technicianIds: [eric.id], agentKeyIds: [admin.id] });
    const posted = await fieldPost(eric.accessToken, `/hub/threads/${id}/messages`, { body: "Panel is set." });
    expect(posted.status).toBe(201);
    expect(await eventCount(id, 1)).toBe(1);
    const row = (await teamEventsFor(id))[0];
    const payload = JSON.parse(row.payloadJson) as Record<string, unknown>;
    // W2-C (Kyle 2026-11-23 item 4): the event now carries the author's first name and the text (the old "ids only" rule is superseded for message.team).
    expect(payload).toMatchObject({ type: "message.team", thread_id: id, thread_kind: "group", author_type: "person", author_kind: "tech", text: "Panel is set.", reply_expected: true });
    expect(payload.context).toMatchObject({ kind: "group", id });
    expect(payload.summary).toBe("New team message");
    expect(row.target).toBe("admin");
  });

  // W2-C: the wake-up is no longer "the routed agent (Admin) only if it is a member". EVERY member agent whose key can read the group hears it
  // (one event per role); a group no agent is in still sends nothing, and an agent outside the group never hears of it.
  it("a group's wake-up goes to every member agent that can read it, in its own role's row, and to no agent outside the group", async () => {
    const eric = await makeTech("Eric");
    const inv = await mint({ agentRole: "inventory", scopes: ["team:reply"] });
    const outsider = await mint({ agentRole: "admin" });
    const id = await groupOf(await pinToken(), `${TAG} Crew`, { technicianIds: [eric.id], agentKeyIds: [inv.id] });
    expect((await fieldPost(eric.accessToken, `/hub/threads/${id}/messages`, { body: "Hello" })).status).toBe(201);
    expect(await eventCount(id, 1)).toBe(1);
    const rows = await teamEventsFor(id);
    expect(rows.map((r) => r.target)).toEqual(["inventory"]); // not Admin: Admin's key is not a member
    void outsider;
    // And a group with no agents at all.
    const plain = await groupOf(await pinToken(), `${TAG} Plain`, { technicianIds: [eric.id] });
    expect((await fieldPost(eric.accessToken, `/hub/threads/${plain}/messages`, { body: "Hello" })).status).toBe(201);
    expect(await settledCount(plain)).toBe(0);
  });

  it("an Admin member that is then removed gets no event for the next post", async () => {
    const eric = await makeTech("Eric");
    const admin = await mint({ agentRole: "admin" });
    const pin = await pinToken();
    const id = await groupOf(pin, `${TAG} Crew`, { technicianIds: [eric.id], agentKeyIds: [admin.id] });
    expect((await request(app).delete(`/hub/groups/${id}/members`).set(bearer(pin)).send({ agentKeyId: admin.id })).status).toBe(200);
    expect((await fieldPost(eric.accessToken, `/hub/threads/${id}/messages`, { body: "Anyone there?" })).status).toBe(201);
    expect(await settledCount(id)).toBe(0);
  });

  it("a switched-off Admin member is not woken either", async () => {
    const eric = await makeTech("Eric");
    const admin = await mint({ agentRole: "admin" });
    const id = await groupOf(await pinToken(), `${TAG} Crew`, { technicianIds: [eric.id], agentKeyIds: [admin.id] });
    await prisma.agentKey.update({ where: { id: admin.id }, data: { revokedAt: new Date() } });
    expect((await fieldPost(eric.accessToken, `/hub/threads/${id}/messages`, { body: "Hello" })).status).toBe(201);
    expect(await settledCount(id)).toBe(0);
  });
});

describe("the not-a-member note is the server's own reason", () => {
  it("a sign-in tied to no person is told it is not tied to a person - never to add itself - and adding itself changes nothing", async () => {
    const eric = await makeTech("Eric");
    const pin = await pinToken(); // no principal CRM login in this database: the PIN is tied to nobody
    const id = await groupOf(pin, `${TAG} Crew`, { technicianIds: [eric.id] });
    const detail = (await request(app).get(`/hub/threads/${id}`).set(bearer(pin))).body;
    expect(detail.group.youAreMember).toBe(false);
    expect(detail.postBlock).toMatch(/not tied to a person on the team/);
    expect(detail.postBlock).not.toMatch(/Add yourself/);
    const post = await crmPost(pin, id, "Hello");
    expect(post.status).toBe(403);
    expect(post.body.error).toBe(detail.postBlock);
  });
});

describe("the reader rule itself", () => {
  const agentReader = (agentKeyId: string, scopes: string[] = ["team:reply"], kinds: string[] = []): HubReader => ({
    key: `agent:${agentKeyId}`, kind: "agent", display: "Bot", technicianId: null, threadKinds: kinds, agentRole: "admin", agentKeyId, agentScopes: scopes, isKyle: false,
  });

  it("an agent reader sees a group only as a member, its other kinds exactly as before, and nothing when it has no id", async () => {
    const bot = await mint();
    const other = await mint();
    const id = await groupOf(await pinToken(), `${TAG} Crew`, { agentKeyIds: [bot.id] });
    const seesGroup = async (reader: HubReader) => (await prisma.hubThread.count({ where: { AND: [{ id }, visibleThreadWhere(reader)] } })) === 1;
    expect(await seesGroup(agentReader(bot.id))).toBe(true);
    expect(await seesGroup(agentReader(other.id))).toBe(false);
    expect(await seesGroup(agentReader(bot.id, ["hub:read"]))).toBe(false); // the scope does not open groups
    expect(await seesGroup(agentReader(bot.id, ["team:reply"], ["training"]))).toBe(false); // nor does a kind limit that leaves it out
    expect(visibleThreadWhere(agentReader(bot.id, ["hub:read"]))).toEqual({ kind: { in: ["customer", "job"] } });
    expect(await seesGroup({ ...agentReader(bot.id), agentKeyId: null })).toBe(false);
  });

  it("a person's reader key resolves for push: a login in the group is notifiable, the PIN session is the principal's person", async () => {
    const michael = await makeOffice("Michael");
    const found = await readerForKey(`user:${michael.loginId}`);
    expect(found?.reader.technicianId).toBe(michael.tech.id);
  });
});

describe("the marketing-text block", () => {
  it("reads 'Red Cedar never sends marketing by text' and still blocks", () => {
    expect(SEND_BLOCK_REASONS.marketing_not_opted_in).toBe("Red Cedar never sends marketing by text");
  });
});
