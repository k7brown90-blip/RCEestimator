/**
 * Field approvals (work order agent-team, U10, default D1) and "Kyle only" made real.
 *
 * Pinned here:
 *   * the approver is the ONE approve_drafts power, never Technician.role: a technician whose role is "admin" but has no CRM
 *     login with the power gets an empty list (the chip never shows) and the power's sentence (403) on every decision;
 *     a technician linked to a login that holds the power, or to Kyle's principal login, sees the CRM's own cards and decides
 *     them through the same service (the same audit actor, the same email) - and a login that is turned off cannot;
 *   * the decisions are hubApproval.ts's: a second decision is a 409, a draft is sent once, Reject needs a reason, Edit sends the
 *     edited version and keeps the original; a card kind only the CRM decides is left out of the list and refused by id;
 *   * a technician's own message filter is NOT loosened: the draft is still hidden from their thread views;
 *   * nothing a tech route sends carries an access token;
 *   * GET /health-record-admin/technicians drops accessToken for every session that is not Kyle's, the AI admin and an
 *     owner-role login holding every grant included; PATCH of role or rotateToken (and creating a non-default role) is a 403 with
 *     "Only Kyle's PIN sign-in can change this." and changes nothing; other fields keep the gating they had.
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

import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { hashPin } from "../src/middleware/pinAuth";
import { ensureThreadFor, type HubReader } from "../src/services/hub";
import { createDraftMessage } from "../src/services/hubDrafts";
import { saveCrmLogin, setCrmLoginEnabled, setPowers, setPrincipal } from "../src/services/crmLogin";
import { saveAdminLogin } from "../src/services/adminLogin";
import { CRM_POWERS, TECH_TOKEN_ROLE_REASON } from "../shared/crmPowers";
import { cleanupCrmLoginFixtures, makePerson } from "./helpers/crmLoginFixture";

const PIN = "1234";
const PASS = "correct horse battery";
const AI_PASS = "another long password!";
const TAG = "HubFieldApproval";
const DOMAIN = `hubfield-${Date.now()}.example`;
const POWER = CRM_POWERS.approve_drafts.reason;
const AI: HubReader = { key: "ai-admin", kind: "ai-admin", display: "RCE Admin", technicianId: null, threadKinds: [], agentRole: null, agentKeyId: null, isKyle: false };

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const resendCalls = () => fetchMock.mock.calls.filter(([u]) => String(u).includes("api.resend.com"));

async function wipe() {
  const customers = await prisma.customer.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
  const ids = customers.map((c) => c.id);
  await prisma.hubThread.deleteMany({ where: { OR: [{ title: { startsWith: TAG } }, { customerId: { in: ids } }] } });
  await prisma.emailDelivery.deleteMany({ where: { to: { endsWith: `@${DOMAIN}` } } });
  if (ids.length > 0) await prisma.customer.deleteMany({ where: { id: { in: ids } } });
}

beforeAll(async () => {
  process.env.PIN_HASH = await hashPin(PIN);
  await wipe();
});
afterAll(async () => {
  delete process.env.PIN_HASH;
  await wipe();
  await cleanupCrmLoginFixtures();
});
beforeEach(async () => {
  await cleanupCrmLoginFixtures();
  fetchMock.mockReset();
  mail.sendMail.mockReset();
  mail.sendMail.mockResolvedValue({});
  fetchMock.mockImplementation(async () => new Response(JSON.stringify({ id: `re_${randomUUID()}` }), { status: 200 }));
});
afterEach(wipe);

/** A technician (the field app's person) with their bearer token. */
async function techPerson(name: string, role = "technician") {
  const p = await makePerson(`${TAG} ${name}`);
  await prisma.technician.update({ where: { id: p.id }, data: { role } });
  const row = await prisma.technician.findUniqueOrThrow({ where: { id: p.id } });
  return { id: p.id, token: row.accessToken, name: row.name };
}
/** The same person's CRM login: optionally holding approve_drafts, or Kyle's principal login. */
async function giveLogin(personId: string, opts: { powers?: string[]; principal?: boolean; username?: string } = {}) {
  const row = await saveCrmLogin(personId, { username: opts.username ?? `u-${personId.slice(-6)}`, role: "owner", password: PASS });
  if (opts.powers?.length) await setPowers(row.id, opts.powers as never);
  if (opts.principal) await setPrincipal(row.id);
  return row;
}

let seq = 0;
async function account() {
  const customer = await prisma.customer.create({ data: { name: `${TAG} Jane ${seq++}`, phone: "6155550101", email: `jane${seq}@${DOMAIN}` } });
  const thread = await ensureThreadFor({ customerId: customer.id });
  return { customer, thread };
}
async function emailDraft(threadId: string, over: Record<string, unknown> = {}) {
  return (await createDraftMessage(AI, { threadId, channel: "email", category: "thread_reply", subject: "Tuesday", body: "We can be there Tuesday.", ...over })).message;
}

const get = (token: string, path: string) => request(app).get(`/health-record${path}`).set(bearer(token));
const post = (token: string, path: string, body: object = {}) => request(app).post(`/health-record${path}`).set(bearer(token)).send(body);
const statusOf = async (id: string) => (await prisma.hubMessage.findUniqueOrThrow({ where: { id } })).status;

describe("who may decide from the field: the one approve_drafts power, never a role", () => {
  it("a technician whose ROLE is admin but whose person has no login with the power sees nothing and decides nothing", async () => {
    const { thread } = await account();
    const draft = await emailDraft(thread.id);
    const boss = await techPerson("Boss", "admin");

    const list = await get(boss.token, "/hub/approvals");
    expect(list.status).toBe(200);
    expect(list.body.data).toEqual({ cards: [], canApprove: false, approveReason: null });
    for (const [route, body] of [["approve", {}], ["edit-approve", { body: "mine" }], ["reject", { reason: "no thanks" }]] as const) {
      const r = await post(boss.token, `/hub/messages/${draft.id}/${route}`, body);
      expect(r.status, route).toBe(403);
      expect(r.body.error.message).toBe(POWER);
    }
    expect(await statusOf(draft.id)).toBe("pending_approval");
    expect(resendCalls()).toHaveLength(0);
  });

  it("a login that exists but does not hold the power is the same as no login", async () => {
    const { thread } = await account();
    const draft = await emailDraft(thread.id);
    const eric = await techPerson("Eric");
    await giveLogin(eric.id, { powers: [] });
    expect((await get(eric.token, "/hub/approvals")).body.data.canApprove).toBe(false);
    expect((await post(eric.token, `/hub/messages/${draft.id}/approve`)).status).toBe(403);
    expect(await statusOf(draft.id)).toBe("pending_approval");
  });

  it("a login that is turned off cannot approve, even holding the power", async () => {
    const { thread } = await account();
    const draft = await emailDraft(thread.id);
    const eric = await techPerson("Eric");
    const row = await giveLogin(eric.id, { powers: ["approve_drafts"] });
    expect((await get(eric.token, "/hub/approvals")).body.data.canApprove).toBe(true);
    await setCrmLoginEnabled(row.id, false);
    expect((await get(eric.token, "/hub/approvals")).body.data).toEqual({ cards: [], canApprove: false, approveReason: null });
    expect((await post(eric.token, `/hub/messages/${draft.id}/approve`)).status).toBe(403);
    expect(await statusOf(draft.id)).toBe("pending_approval");
  });

  it("another power does not make an approver", async () => {
    const eric = await techPerson("Eric");
    await giveLogin(eric.id, { powers: ["treasury", "price_book_edit"] });
    expect((await get(eric.token, "/hub/approvals")).body.data.canApprove).toBe(false);
  });
});

describe("an approver sees the CRM's cards and decides them through the one service", () => {
  it("lists the waiting drafts as cards, with the server's own words, and no token", async () => {
    const { customer, thread } = await account();
    const draft = await emailDraft(thread.id, { toAddress: customer.email, cc: [`pat@${DOMAIN}`] });
    const kyle = await techPerson("Kyle");
    await giveLogin(kyle.id, { principal: true });

    const list = await get(kyle.token, "/hub/approvals");
    expect(list.status).toBe(200);
    expect(list.body.data.canApprove).toBe(true);
    expect(list.body.data.approveReason).toBeNull();
    const card = list.body.data.cards.find((c: { id: string }) => c.id === draft.id);
    expect(card).toMatchObject({
      status: "pending_approval", channel: "email", draftedBy: "RCE Admin (AI)", recipientAddress: customer.email, cc: [`pat@${DOMAIN}`],
      approve: { label: "Approve and send", blockedReason: null },
    });
    expect(card.chip.text).toBe("This will email the customer");
    expect(list.text).not.toContain(kyle.token);
  });

  it("Approve and send: a login holding the power emails the customer once, and the audit names the PERSON's CRM login", async () => {
    const { customer, thread } = await account();
    const draft = await emailDraft(thread.id, { toAddress: customer.email });
    const eric = await techPerson("Eric");
    const login = await giveLogin(eric.id, { powers: ["approve_drafts"] });

    const r = await post(eric.token, `/hub/messages/${draft.id}/approve`);
    expect(r.status).toBe(200);
    expect(r.body.data.send).toEqual({ status: "sent", error: null });
    expect(r.body.data.card).toMatchObject({ id: draft.id, status: "sent" });
    expect(r.body.data.card.outcome.text).toBe(`Sent by ${eric.name}`);
    expect(resendCalls()).toHaveLength(1);
    expect(await prisma.emailDelivery.count({ where: { customerId: customer.id } })).toBe(1);
    const audit = await prisma.hubAuditLog.findFirstOrThrow({ where: { messageId: draft.id, action: "message_approved" } });
    expect(audit.actorKey).toBe(`user:${login.id}`);
    expect(r.text).not.toContain(eric.token);
    // Decided once: a second Approve is a 409 and sends nothing.
    const again = await post(eric.token, `/hub/messages/${draft.id}/approve`);
    expect(again.status).toBe(409);
    expect(resendCalls()).toHaveLength(1);
  });

  it("Kyle's principal login on his phone approves too", async () => {
    const { thread } = await account();
    const draft = await emailDraft(thread.id);
    const kyle = await techPerson("Kyle");
    await giveLogin(kyle.id, { principal: true });
    expect((await post(kyle.token, `/hub/messages/${draft.id}/approve`)).status).toBe(200);
    expect(await statusOf(draft.id)).toBe("sent");
  });

  it("Edit then Send my version: the edited words go, to the chosen To and CC, and the original stays on the record as edited", async () => {
    const { customer, thread } = await account();
    const draft = await emailDraft(thread.id);
    const eric = await techPerson("Eric");
    await giveLogin(eric.id, { powers: ["approve_drafts"] });

    const r = await post(eric.token, `/hub/messages/${draft.id}/edit-approve`, { body: "Eric's own wording.", subject: "Tuesday visit", cc: [`office@${DOMAIN}`] });
    expect(r.status).toBe(200);
    expect(r.body.data.card).toMatchObject({ status: "sent", body: "Eric's own wording.", subject: "Tuesday visit" });
    expect(await statusOf(draft.id)).toBe("edited");
    const delivery = await prisma.emailDelivery.findMany({ where: { customerId: customer.id } });
    expect(delivery).toHaveLength(1);
    expect(delivery[0]).toMatchObject({ subject: "Tuesday visit", cc: [`office@${DOMAIN}`] });
    expect((await post(eric.token, `/hub/messages/${draft.id}/edit-approve`, { body: "again" })).status).toBe(409);
    expect(resendCalls()).toHaveLength(1);
  });

  it("Reject needs a reason, keeps it, and sends nothing", async () => {
    const { thread } = await account();
    const draft = await emailDraft(thread.id);
    const eric = await techPerson("Eric");
    await giveLogin(eric.id, { powers: ["approve_drafts"] });

    expect((await post(eric.token, `/hub/messages/${draft.id}/reject`, { reason: "  " })).status).toBe(422);
    expect((await post(eric.token, `/hub/messages/${draft.id}/reject`, {})).status).toBe(422);
    expect(await statusOf(draft.id)).toBe("pending_approval");
    const r = await post(eric.token, `/hub/messages/${draft.id}/reject`, { reason: "wrong customer" });
    expect(r.status).toBe(200);
    expect(r.body.data.card.outcome.text).toBe("Rejected: wrong customer");
    expect(resendCalls()).toHaveLength(0);
    expect((await get(eric.token, "/hub/approvals")).body.data.cards.map((c: { id: string }) => c.id)).not.toContain(draft.id);
  });

  it("a card the field cannot approve says so with the server's sentence: greyed Approve comes from blockedReason, and the CRM-only kind is left out and refused", async () => {
    const { customer, thread } = await account();
    await prisma.customer.update({ where: { id: customer.id }, data: { email: null } });
    const noAddress = await emailDraft(thread.id);
    const eric = await techPerson("Eric");
    await giveLogin(eric.id, { powers: ["approve_drafts"] });
    const card = (await get(eric.token, "/hub/approvals")).body.data.cards.find((c: { id: string }) => c.id === noAddress.id);
    expect(card.approve.blockedReason).toBe("There is no email address on file for this customer. Edit the draft and type one.");
    expect(card.approve.editBlockedReason).toBeNull();

    // A "Call or email instead" card: decided on the CRM only.
    const crmOnly = (await createDraftMessage(AI, { threadId: thread.id, channel: "email", category: "thread_reply", subject: "x", body: "Call them", toAddress: `x@${DOMAIN}` })).message;
    await prisma.hubMessage.update({ where: { id: crmOnly.id }, data: { actionKind: "contact_instead" } });
    const ids = (await get(eric.token, "/hub/approvals")).body.data.cards.map((c: { id: string }) => c.id);
    expect(ids).toContain(noAddress.id);
    expect(ids).not.toContain(crmOnly.id);
    const refused = await post(eric.token, `/hub/messages/${crmOnly.id}/approve`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toBe("This kind of card is decided on the CRM.");
    expect(await statusOf(crmOnly.id)).toBe("pending_approval");
  });
});

describe("a technician's own view of the hub is not loosened", () => {
  it("an approver's thread screens still hide the drafts and never show a customer thread", async () => {
    const { thread } = await account();
    const draft = await emailDraft(thread.id);
    const kyle = await techPerson("Kyle");
    await giveLogin(kyle.id, { principal: true });
    // The customer thread is not theirs to open through the tech message routes, approver or not.
    expect((await get(kyle.token, `/hub/threads/${thread.id}/messages`)).status).toBe(403);
    const rows = (await get(kyle.token, "/hub/threads")).body.data.threads as Array<{ kind: string }>;
    expect(rows.every((r) => r.kind !== "customer")).toBe(true);
    expect((await get(kyle.token, "/hub/approvals")).body.data.cards.map((c: { id: string }) => c.id)).toContain(draft.id);
  });
});

describe("technician tokens are Kyle's alone", () => {
  async function michael() {
    const person = await makePerson(`${TAG} Michael`);
    const row = await saveCrmLogin(person.id, { username: "michael", role: "owner", password: PASS });
    await setPowers(row.id, ["van_clearance", "lle_verify", "level_gates", "training_publish", "price_book_edit", "treasury", "bot_keys", "approve_drafts"]);
    return (await request(app).post("/auth/login").send({ username: "michael", password: PASS })).body.token as string;
  }
  const pinToken = async () => (await request(app).post("/auth/pin").send({ pin: PIN })).body.token as string;
  const aiToken = async () => {
    await saveAdminLogin("grok-admin", AI_PASS);
    return (await request(app).post("/auth/login").send({ username: "grok-admin", password: AI_PASS })).body.token as string;
  };

  it("Kyle's PIN session lists the roster with each token", async () => {
    const eric = await techPerson("Eric");
    const res = await request(app).get("/health-record-admin/technicians").set(bearer(await pinToken()));
    expect(res.status).toBe(200);
    expect((res.body as Array<{ id: string; accessToken?: string }>).find((t) => t.id === eric.id)?.accessToken).toBe(eric.token);
  });

  it("an owner-role login holding every grant, and the AI admin, get the roster with NO token on any row, and the token appears nowhere in the response", async () => {
    const eric = await techPerson("Eric");
    for (const token of [await michael(), await aiToken()]) {
      const res = await request(app).get("/health-record-admin/technicians").set(bearer(token));
      expect(res.status).toBe(200);
      const rows = res.body as Array<Record<string, unknown>>;
      expect(rows.some((r) => r.id === eric.id)).toBe(true);
      for (const row of rows) expect(Object.keys(row)).not.toContain("accessToken");
      expect(res.text).not.toContain(eric.token);
    }
  });

  it("changing a role, or rotating a token, is a 403 with the sentence for every session but Kyle's, and nothing changes", async () => {
    const eric = await techPerson("Eric");
    for (const token of [await michael(), await aiToken()]) {
      for (const body of [{ role: "admin" }, { rotateToken: true }, { role: "supervisor", rotateToken: true }]) {
        const res = await request(app).patch(`/health-record-admin/technicians/${eric.id}`).set(bearer(token)).send(body);
        expect(res.status, JSON.stringify(body)).toBe(403);
        expect(res.body).toEqual({ error: TECH_TOKEN_ROLE_REASON });
      }
    }
    const after = await prisma.technician.findUniqueOrThrow({ where: { id: eric.id } });
    expect(after.role).toBe("technician");
    expect(after.accessToken).toBe(eric.token);
  });

  it("other fields keep the gating they had: a non-Kyle session can still rename, and the answer carries no token", async () => {
    const eric = await techPerson("Eric");
    const res = await request(app).patch(`/health-record-admin/technicians/${eric.id}`).set(bearer(await michael())).send({ employeeNumber: "RCE-77" });
    expect(res.status).toBe(200);
    expect(res.body.employeeNumber).toBe("RCE-77");
    expect(Object.keys(res.body)).not.toContain("accessToken");
    expect(res.text).not.toContain(eric.token);
  });

  it("Kyle can still change a role and rotate a token, and sees the new token", async () => {
    const eric = await techPerson("Eric");
    const res = await request(app).patch(`/health-record-admin/technicians/${eric.id}`).set(bearer(await pinToken())).send({ role: "supervisor", rotateToken: true });
    expect(res.status).toBe(200);
    expect(res.body.role).toBe("supervisor");
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.accessToken).not.toBe(eric.token);
  });

  it("creating a person: a non-Kyle session may add one at the default role and gets no token back, but cannot pick another role", async () => {
    const token = await michael();
    const refused = await request(app).post("/health-record-admin/technicians").set(bearer(token)).send({ name: `${TAG} New Admin`, role: "admin" });
    expect(refused.status).toBe(403);
    expect(refused.body).toEqual({ error: TECH_TOKEN_ROLE_REASON });
    expect(await prisma.technician.count({ where: { name: `${TAG} New Admin` } })).toBe(0);

    const made = await request(app).post("/health-record-admin/technicians").set(bearer(token)).send({ name: `${TAG} New Tech` });
    expect(made.status).toBe(201);
    expect(Object.keys(made.body)).not.toContain("accessToken");
    const stored = await prisma.technician.findFirstOrThrow({ where: { name: `${TAG} New Tech` } });
    expect(made.text).not.toContain(stored.accessToken);
    await prisma.technician.delete({ where: { id: stored.id } });

    const kyleMade = await request(app).post("/health-record-admin/technicians").set(bearer(await pinToken())).send({ name: `${TAG} Kyle Made`, role: "admin" });
    expect(kyleMade.status).toBe(201);
    expect(kyleMade.body.accessToken).toBeTruthy();
    await prisma.technician.delete({ where: { id: kyleMade.body.id } });
  });
});
