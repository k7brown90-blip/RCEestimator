/**
 * The agents' REST door onto the Messages hub (work order agent-team, K-U7 = BA3): GET /api/hub/threads,
 * GET /api/hub/threads/:id and POST /api/hub/messages on the CRM's OWN hub routes, behind the one agent gate.
 *
 * C6 review fixes pinned in the second half (per-kind scopes, no search, first-name titles, scrub-then-cut last
 * line, the contract path, the corrected-retry draft id, the transaction timeout, the Scout profile, the BA8 offer
 * and the hub fan-out).
 *
 * Pinned here: each route works with its scope and is 403 without it; a status of approved or sent is 403
 * and writes no row; a missing status is pending_approval and 'draft' is kept; author, class and purpose
 * never come from the body; a recipient or cc is a 400; thread_id OR exactly one record link (two links, or
 * a link that disagrees with thread_id, is a 400; jobId lands on the ACCOUNT thread tagged with the job);
 * Scout is limited to existing training threads (403 elsewhere, and it can never make a thread); an agent
 * key on any route the table does not list (GET /accounts, an approve route) is 401; the kill switch
 * (read_only refuses the draft, off refuses everything); no phone, email, street address, toAddress or cc in
 * any answer; an idempotent retry returns the same draft; and hubSend is still unreachable from agent code.
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
const sent = vi.hoisted(() => ({ emails: [] as unknown[] }));
const offered = vi.hoisted(() => ({ messageIds: [] as string[] }));
// The BA8 offer is watched, not replaced: the real rule still runs (every category is off in the test database).
vi.mock("../src/services/hubAutoSend", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/services/hubAutoSend")>();
  return {
    ...mod,
    maybeAutoApprove: vi.fn(async (...a: Parameters<typeof mod.maybeAutoApprove>) => { offered.messageIds.push(a[0]); return mod.maybeAutoApprove(...a); }),
  };
});
vi.mock("../src/services/confirmationEmail", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/services/confirmationEmail")>();
  return {
    ...mod,
    sendBrandedEmail: vi.fn(async (...a: unknown[]) => { sent.emails.push(a); return true; }),
    sendKyleNotificationEmail: vi.fn().mockResolvedValue(undefined),
  };
});

import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { hashPin } from "../src/middleware/pinAuth";
import { mintAgentKey, type MintAgentKeyInput } from "../src/agentApi/keys";
import { AGENT_KEY_ROUTES } from "../src/agentApi/gate";
import { IDEMPOTENT_TX_TIMEOUT_MS, withIdempotency } from "../src/agentApi/idempotency";
import { ensureThreadFor, findVisibleThread, readerFor, type HubReader } from "../src/services/hub";
import { createDraftMessage } from "../src/services/hubDrafts";
import { subscribeHub, type HubBusEvent } from "../src/services/hubBus";
import { DEFAULT_SCOPES_BY_ROLE, type AgentScope } from "../shared/agentScopes";

const TAG = "HubBotDoor";
const PIN = "1234";
const PHONE = "(615) 555-0142";
const EMAIL = `${TAG.toLowerCase()}@homeowner.example`;
const STREET = "88 Cedar Hollow Court";
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const key = () => `idem-${randomUUID()}`;
const SCOUT_SCOPES: AgentScope[] = ["hub:read", "hub:draft", "training:read", "training:write"];

let savedPin: string | undefined;
let savedPepper: string | undefined;
let savedEnvName: string | undefined;
let customerId = "";
let propertyId = "";
let visitId = "";
let leadId = "";
let estimateId = "";
let draftId = "";
let techId = "";
let trainingThreadId = "";
let teamThreadId = "";
let devThreadId = "";
const keyIds: string[] = [];

async function mint(overrides: Partial<MintAgentKeyInput> = {}) {
  const made = await mintAgentKey({
    name: `${TAG} ${randomUUID().slice(0, 6)}`, agentRole: "admin", createdBy: "owner", writesEnabled: true,
    scopes: ["hub:read", "hub:draft"], hubThreadKinds: [], ...overrides,
  });
  keyIds.push(made.row.id);
  return made.key;
}

async function setMode(mode: "on" | "read_only" | "off") {
  const valueJson = JSON.stringify({ mode, changedAt: null, changedBy: null });
  await prisma.companySetting.upsert({ where: { key: "agentAccess" }, create: { key: "agentAccess", valueJson }, update: { valueJson } });
}

const countMessages = () => prisma.hubMessage.count({ where: { thread: { OR: [{ customerId }, { id: { in: [trainingThreadId, teamThreadId, devThreadId] } }] } } });
const draftBody = (extra: Record<string, unknown> = {}) => ({
  customerId, channel: "email", body: "Hello, your panel quote is ready to review.", subject: "Your quote", idempotency_key: key(), ...extra,
});
const post = (token: string, body: Record<string, unknown>) => request(app).post("/api/hub/messages").set(bearer(token)).send(body);

beforeAll(async () => {
  savedPin = process.env.PIN_HASH;
  savedPepper = process.env.AGENT_KEY_PEPPER;
  savedEnvName = process.env.RAILWAY_ENVIRONMENT_NAME;
  process.env.PIN_HASH = await hashPin(PIN);
  process.env.AGENT_KEY_PEPPER = "test-pepper-for-the-hub-bot-door-suite";
  delete process.env.RAILWAY_ENVIRONMENT_NAME;
  const customer = await prisma.customer.create({
    data: {
      name: `${TAG} Jane Homeowner`, email: EMAIL, phone: PHONE,
      properties: { create: { name: "Home", addressLine1: STREET, city: "Smyrna", state: "TN", postalCode: "37167" } },
    },
    include: { properties: true },
  });
  customerId = customer.id;
  propertyId = customer.properties[0]!.id;
  const visit = await prisma.visit.create({ data: { customerId, propertyId, mode: "service_diagnostic", purpose: `${TAG} job`, status: "contracted" } });
  visitId = visit.id;
  const lead = await prisma.lead.create({ data: { name: `${TAG} Lead Person`, email: `lead-${EMAIL}`, phone: "(615) 555-0177" } });
  leadId = lead.id;
  await prisma.priceBookSupplier.create({ data: { id: `${TAG}-SUP`, name: `${TAG} Supply`, quotable: "YES" } });
  draftId = (await prisma.priceBookDraftEstimate.create({ data: { title: `${TAG} draft`, supplierId: `${TAG}-SUP` } })).id;
  const est = await prisma.issuedEstimate.create({
    data: {
      number: `0000-${TAG}`, token: `${TAG}${Date.now().toString(16)}`.padEnd(64, "0"), status: "sent", draftId, customerId,
      serviceAddressId: propertyId, customerName: `${TAG} Jane Homeowner`, customerEmail: EMAIL, serviceAddress: `${STREET}, Smyrna, TN`,
      title: "Panel upgrade", scopeText: "Panel upgrade.", workSubtotal: 925, tripCharge: 75, total: 1000, sentAt: new Date(), sentTo: EMAIL,
      options: { create: [{ option: "A", label: "Panel", subtotal: 925, lineCount: 1 }] },
    },
  });
  estimateId = est.id;
  const tech = await prisma.technician.create({ data: { name: `${TAG} Apprentice`, accessToken: `${TAG}-tok-${randomUUID()}`, isActive: true } });
  techId = tech.id;
  trainingThreadId = (await prisma.hubThread.create({ data: { kind: "training", title: `${TAG} training`, technicianId: techId } })).id;
  teamThreadId = (await prisma.hubThread.create({ data: { kind: "team", title: `${TAG} team` } })).id;
  devThreadId = (await prisma.hubThread.create({ data: { kind: "dev", title: `${TAG} dev` } })).id;
  await prisma.hubMessage.create({
    data: {
      threadId: trainingThreadId, authorType: "tech", authorDisplay: `${TAG} Apprentice`, channel: "in_app", direction: "internal",
      status: "posted", body: `Went to ${customer.name} at ${STREET}, call ${PHONE}.`,
    },
  });
  await prisma.hubMessage.create({
    data: { threadId: teamThreadId, authorType: "office", authorDisplay: "Kyle Smith", channel: "in_app", direction: "internal", status: "posted", body: "Team note." },
  });
});

afterAll(async () => {
  if (savedPin === undefined) delete process.env.PIN_HASH; else process.env.PIN_HASH = savedPin;
  if (savedPepper === undefined) delete process.env.AGENT_KEY_PEPPER; else process.env.AGENT_KEY_PEPPER = savedPepper;
  if (savedEnvName === undefined) delete process.env.RAILWAY_ENVIRONMENT_NAME; else process.env.RAILWAY_ENVIRONMENT_NAME = savedEnvName;
  await prisma.companySetting.deleteMany({ where: { key: "agentAccess" } });
  await prisma.agentIdempotency.deleteMany({ where: { agentKeyId: { in: keyIds } } });
  await prisma.hubThread.deleteMany({ where: { OR: [{ customerId }, { leadId }, { id: { in: [trainingThreadId, teamThreadId, devThreadId] } }] } });
  await prisma.agentKey.deleteMany({ where: { id: { in: keyIds } } });
  await prisma.issuedEstimate.deleteMany({ where: { id: estimateId } });
  await prisma.priceBookDraftEstimate.deleteMany({ where: { id: draftId } });
  await prisma.priceBookSupplier.deleteMany({ where: { id: `${TAG}-SUP` } });
  await prisma.visit.deleteMany({ where: { id: visitId } });
  await prisma.lead.deleteMany({ where: { id: leadId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
  await prisma.technician.deleteMany({ where: { id: techId } });
});

beforeEach(async () => {
  await setMode("on");
  sent.emails.length = 0;
});

/** No contact detail may ever be in an answer. */
function expectNoContact(text: string) {
  expect(text).not.toContain(PHONE);
  expect(text).not.toContain("555-0142");
  expect(text).not.toContain(EMAIL);
  expect(text).not.toContain(STREET);
  expect(text).not.toContain("Cedar Hollow");
  for (const k of ["toAddress", "toPhone", "\"cc\"", "toMasked", "\"phone\"", "accessToken"]) expect(text, k).not.toContain(k);
}

describe("GET /api/hub/threads and GET /api/hub/threads/:id", () => {
  it("answers a key with hub:read, and a key without it is 403 scope_denied", async () => {
    const ok = await mint();
    const res = await request(app).get("/api/hub/threads").set(bearer(ok)).expect(200);
    expect(Array.isArray(res.body.threads)).toBe(true);
    const noScope = await mint({ scopes: ["hub:draft"] });
    const denied = await request(app).get("/api/hub/threads").set(bearer(noScope));
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe("scope_denied");
  });

  it("reads one thread: the text passes withhold the customer's phone, email and street, and no recipient field exists", async () => {
    const thread = await prisma.hubThread.upsert({
      where: { kind_customerId: { kind: "customer", customerId } }, update: {}, create: { kind: "customer", title: `${TAG} Jane Homeowner`, customerId },
    });
    await prisma.hubMessage.create({
      data: {
        threadId: thread.id, authorType: "office", authorDisplay: "Kyle Smith", channel: "email", direction: "outbound", status: "sent",
        body: `Call ${PHONE} or write ${EMAIL}; we will be at ${STREET}.`, subject: `About ${STREET}`, toAddress: EMAIL, cc: [`cc-${EMAIL}`], toPhone10: "6155550142",
      },
    });
    const token = await mint();
    const res = await request(app).get(`/api/hub/threads/${thread.id}/messages`).set(bearer(token)).expect(200);
    expect(res.body.messages.length).toBeGreaterThan(0);
    expect(res.body.messages[0].body).toContain("[withheld]");
    expectNoContact(res.text);
    // A first name is a ceiling: never the full name of the office author.
    expect(res.body.messages[0].authorFirstName).toBe("Kyle");
    expect(res.text).not.toContain("Kyle Smith");
    const list = await request(app).get("/api/hub/threads").set(bearer(token)).expect(200);
    expectNoContact(list.text);
    expect(list.body.threads.some((t: { id: string }) => t.id === thread.id)).toBe(true);
  });

  it("a thread nobody knows is 404, and a key's kind limit makes a thread of another kind 403 (not hidden)", async () => {
    const admin = await mint();
    expect((await request(app).get("/api/hub/threads/does-not-exist/messages").set(bearer(admin))).status).toBe(404);
    const scout = await mint({ agentRole: "scout", scopes: SCOUT_SCOPES, hubThreadKinds: ["training"] });
    const team = await request(app).get(`/api/hub/threads/${teamThreadId}/messages`).set(bearer(scout));
    expect(team.status).toBe(403);
    expect(team.body.code).toBe("forbidden");
    expect((await request(app).get(`/api/hub/threads/${devThreadId}/messages`).set(bearer(scout))).status).toBe(403);
    expect((await request(app).get("/api/hub/threads?kind=customer").set(bearer(scout))).status).toBe(403);
  });

  it("Scout reads a training thread; the customer's name and street in an apprentice's note are withheld", async () => {
    const scout = await mint({ agentRole: "scout", scopes: SCOUT_SCOPES, hubThreadKinds: ["training"] });
    await prisma.visitAssignment.create({ data: { visitId, technicianId: techId, role: "primary" } });
    try {
      const res = await request(app).get(`/api/hub/threads/${trainingThreadId}/messages`).set(bearer(scout)).expect(200);
      expect(res.body.messages).toHaveLength(1);
      expect(res.text).not.toContain("Jane Homeowner");
      expectNoContact(res.text);
      const list = await request(app).get("/api/hub/threads").set(bearer(scout)).expect(200);
      expect(list.body.threads.every((t: { kind: string }) => t.kind === "training")).toBe(true);
      expect(list.body.threads.some((t: { id: string }) => t.id === trainingThreadId)).toBe(true);
    } finally {
      await prisma.visitAssignment.deleteMany({ where: { visitId, technicianId: techId } });
    }
  });
});

describe("POST /api/hub/messages", () => {
  it("leaves a pending_approval draft by default, authored by the KEY and never by the body, and sends nothing", async () => {
    const token = await mint();
    const before = await countMessages();
    const res = await post(token, draftBody({
      category: "thread_reply", authorType: "office", authorDisplay: "Kyle", authorKey: "owner", messageClass: "internal", purposeKey: "x", status: undefined,
    }));
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("pending_approval");
    const row = await prisma.hubMessage.findUniqueOrThrow({ where: { id: res.body.messageId } });
    expect(row.status).toBe("pending_approval");
    expect(row.authorType).toBe("ai_agent");
    expect(row.authorKey).toMatch(/^agent:/);
    expect(row.authorBotKeyId).toBeTruthy();
    expect(row.authorDisplay).not.toBe("Kyle");
    expect(row.messageClass).toBe("transactional");
    expect(row.purposeKey).toBe("thread_reply");
    expect(await countMessages()).toBe(before + 1);
    expect(sent.emails).toHaveLength(0);
    expect(res.body.body).toBeUndefined();
    expectNoContact(res.text);
  });

  it("keeps an explicit 'draft' and refuses every other status with 403 and NO row", async () => {
    const token = await mint();
    const draft = await post(token, draftBody({ status: "draft" }));
    expect(draft.status).toBe(201);
    expect(draft.body.status).toBe("draft");
    for (const status of ["approved", "sent", "posted", "received", "approving", "rejected"]) {
      const before = await countMessages();
      const res = await post(token, draftBody({ status }));
      expect(res.status, status).toBe(403);
      expect(res.body.code).toBe("forbidden");
      expect(res.body.reason).toBe("Agents can only create drafts.");
      expect(await countMessages(), status).toBe(before);
    }
    expect(sent.emails).toHaveLength(0);
  });

  it("needs hub:draft and a key with writes on, and says so", async () => {
    const readOnlyScope = await mint({ scopes: ["hub:read"] });
    const denied = await post(readOnlyScope, draftBody());
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe("scope_denied");
    const noWrites = await mint({ writesEnabled: false });
    const off = await post(noWrites, draftBody());
    expect(off.status).toBe(403);
    expect(off.body.code).toBe("writes_disabled");
  });

  it("refuses a recipient or cc (400) and writes nothing", async () => {
    const token = await mint();
    const before = await countMessages();
    for (const extra of [{ toAddress: "x@y.example" }, { cc: ["x@y.example"] }, { to: "x@y.example" }, { toPhone: "6155550000" }]) {
      const res = await post(token, draftBody(extra));
      expect(res.status, JSON.stringify(extra)).toBe(400);
      expect(res.body.code).toBe("bad_request");
    }
    expect(await countMessages()).toBe(before);
  });

  it("validates the send type and the tags, and a text needs a send type", async () => {
    const token = await mint();
    expect((await post(token, draftBody({ category: "nope" }))).status).toBe(400);
    expect((await post(token, draftBody({ category: "internal_alert" }))).status).toBe(400);
    expect((await post(token, draftBody({ channel: "sms" }))).status).toBe(400);
    expect((await post(token, draftBody({ tags: ["whatever"] }))).status).toBe(400);
    const ok = await post(token, draftBody({ channel: "sms", category: "thread_reply", tags: ["possible_opt_out"] }));
    expect(ok.status).toBe(201);
    const row = await prisma.hubMessage.findUniqueOrThrow({ where: { id: ok.body.messageId } });
    expect(row.tags).toEqual(["possible_opt_out"]);
    expect(row.messageClass).toBe("transactional");
  });

  it("takes thread_id OR exactly one record link: none or two is 400, and a link that disagrees with thread_id is 400", async () => {
    const token = await mint();
    const { customerId: _omit, ...noLink } = draftBody();
    expect((await post(token, noLink)).status).toBe(400);
    expect((await post(token, draftBody({ leadId }))).status).toBe(400); // customerId + leadId
    const thread = await prisma.hubThread.findFirstOrThrow({ where: { kind: "customer", customerId } }).catch(async () => {
      const made = await post(token, draftBody());
      return prisma.hubThread.findUniqueOrThrow({ where: { id: made.body.threadId } });
    });
    const other = await prisma.customer.create({ data: { name: `${TAG} Other` } });
    try {
      const mismatch = await post(token, { thread_id: thread.id, customerId: other.id, channel: "email", body: "x", idempotency_key: key() });
      expect(mismatch.status).toBe(400);
      const agree = await post(token, { thread_id: thread.id, customerId, channel: "email", body: "Same conversation.", idempotency_key: key() });
      expect(agree.status).toBe(201);
      const byId = await post(token, { thread_id: thread.id, channel: "email", body: "By id.", idempotency_key: key() });
      expect(byId.status).toBe(201);
    } finally {
      await prisma.hubThread.deleteMany({ where: { customerId: other.id } });
      await prisma.customer.delete({ where: { id: other.id } });
    }
  });

  it("jobId lands on the ACCOUNT thread tagged with the job, never the crew job thread; estimateId stores the estimate; leadId uses the lead's thread", async () => {
    const token = await mint();
    const job = await post(token, draftBody({ customerId: undefined, jobId: visitId }));
    expect(job.status).toBe(201);
    const jobRow = await prisma.hubMessage.findUniqueOrThrow({ where: { id: job.body.messageId }, include: { thread: true } });
    expect(jobRow.thread.kind).toBe("customer");
    expect(jobRow.thread.customerId).toBe(customerId);
    expect(jobRow.visitId).toBe(visitId);
    expect(await prisma.hubThread.count({ where: { kind: "job", visitId } })).toBe(0);

    const est = await post(token, draftBody({ customerId: undefined, estimateId }));
    expect(est.status).toBe(201);
    const estRow = await prisma.hubMessage.findUniqueOrThrow({ where: { id: est.body.messageId }, include: { thread: true } });
    expect(estRow.issuedEstimateId).toBe(estimateId);
    expect(estRow.thread.customerId).toBe(customerId);

    const lead = await post(token, draftBody({ customerId: undefined, leadId }));
    expect(lead.status).toBe(201);
    const leadRow = await prisma.hubMessage.findUniqueOrThrow({ where: { id: lead.body.messageId }, include: { thread: true } });
    expect(leadRow.thread.kind).toBe("customer");
    expect(leadRow.thread.leadId).toBe(leadId);

    expect((await post(token, draftBody({ customerId: undefined, jobId: "nope" }))).status).toBe(404);
  });

  it("answers a retry of the same idempotency_key with the SAME draft and writes no second one; a different body is 409", async () => {
    const token = await mint();
    const k = key();
    const first = await post(token, draftBody({ idempotency_key: k }));
    expect(first.status).toBe(201);
    const before = await countMessages();
    const again = await post(token, draftBody({ idempotency_key: k }));
    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);
    expect(await countMessages()).toBe(before);
    const changed = await post(token, draftBody({ idempotency_key: k, body: "A different message." }));
    expect(changed.status).toBe(409);
    expect(changed.body.code).toBe("idempotency_conflict");
    const missing = await post(token, { ...draftBody(), idempotency_key: undefined });
    expect(missing.status).toBe(400);
  });

  it("writes ONE audit row per call, naming the declared route, never a body", async () => {
    const token = await mint();
    const keyRow = await prisma.agentKey.findFirstOrThrow({ where: { id: { in: keyIds } }, orderBy: { createdAt: "desc" } });
    const res = await post(token, draftBody());
    expect(res.status).toBe(201);
    const rows = await prisma.agentAuditLog.findMany({ where: { agentKeyId: keyRow.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.endpoint).toBe("POST /hub/messages");
    expect(rows[0]!.action).toBe("hub.messages.draft");
    expect(rows[0]!.scopeUsed).toBe("hub:draft");
    expect(rows[0]!.entityType).toBe("draft");
    expect(JSON.stringify(rows[0])).not.toContain("Hello, your panel quote");
  });

  it("a dev thread is refused here, and a record link can make a customer thread only: an agent never makes a team thread", async () => {
    const token = await mint({ scopes: ["hub:read", "hub:draft", "team:reply", "dev:read"] });
    const dev = await post(token, { thread_id: devThreadId, body: "x", idempotency_key: key() });
    expect(dev.status).toBe(403);
    const before = await prisma.hubThread.count({ where: { kind: "team" } });
    const team = await post(token, { thread_id: teamThreadId, body: "A reply into an existing team thread.", idempotency_key: key() });
    expect(team.status).toBe(201);
    // W2 (Kyle 2026-11-23): a Team post by a key whose "Team posts publish immediately" box is on (the default) is posted at once.
    expect(team.body.status).toBe("posted");
    expect(team.body.channel).toBe("in_app");
    expect(await prisma.hubThread.count({ where: { kind: "team" } })).toBe(before);
  });
});

describe("Scout writes only into existing training threads", () => {
  it("posts into a training thread as pending_approval, and is 403 on a customer record link (no thread made)", async () => {
    const scout = await mint({ agentRole: "scout", scopes: SCOUT_SCOPES, hubThreadKinds: ["training"] });
    const ok = await post(scout, { thread_id: trainingThreadId, body: "Good question: check the neutral first.", idempotency_key: key() });
    expect(ok.status).toBe(201);
    expect(ok.body.status).toBe("pending_approval");
    const threadsBefore = await prisma.hubThread.count({ where: { customerId } });
    const link = await post(scout, draftBody());
    expect(link.status).toBe(403);
    expect(await prisma.hubThread.count({ where: { customerId } })).toBe(threadsBefore);
    expect((await post(scout, { thread_id: teamThreadId, body: "x", idempotency_key: key() })).status).toBe(403);
    expect((await post(scout, { thread_id: devThreadId, body: "x", idempotency_key: key() })).status).toBe(403);
  });
});

describe("what an agent key cannot reach, and the kill switch", () => {
  it("the same key on a route the table does not list is 401 (GET /accounts, and every decision route)", async () => {
    const token = await mint({ scopes: ["hub:read", "hub:draft", "crm:read"] });
    const accounts = await request(app).get("/api/accounts").set(bearer(token));
    expect(accounts.status).toBe(401);
    expect(accounts.body.code).toBe("agent_key_not_accepted");
    expect((await request(app).get("/accounts").set(bearer(token))).status).toBe(401);
    for (const url of ["/api/hub/messages/abc/approve", "/api/hub/messages/abc/edit-approve", "/api/hub/messages/abc/reject"]) {
      expect((await request(app).post(url).set(bearer(token)).send({})).status, url).toBe(401);
    }
    for (const url of ["/api/hub/audit", "/api/hub/approvals", "/api/hub/stream", "/api/hub/badge", "/api/hub/timeline?customerId=x"]) {
      expect((await request(app).get(url).set(bearer(token))).status, url).toBe(401);
    }
    expect((await request(app).patch(`/api/hub/threads/${trainingThreadId}`).set(bearer(token)).send({ status: "closed" })).status).toBe(401);
    expect((await request(app).post(`/api/hub/threads/${trainingThreadId}/messages`).set(bearer(token)).send({ body: "x" })).status).toBe(401);
    // W2: still exactly three hub routes; each now opens for ANY scope that opens some kind of thread (tests/agentKeyGate.test.ts lists the scopes).
    // W2-B: plus the agents' /mcp door (tests/agentMcpW2.test.ts).
    expect(AGENT_KEY_ROUTES.map((r) => `${r.methods.join("|")} ${r.path}`)).toEqual([
      "GET /hub/threads", "GET /hub/threads/:id/messages", "POST /hub/messages", "GET|POST|DELETE /mcp",
    ]);
  });

  it("a CRM session on POST /hub/messages is 403: a person does not leave an agent draft", async () => {
    const pin = (await request(app).post("/auth/pin").send({ pin: PIN })).body.token as string;
    const res = await request(app).post("/hub/messages").set(bearer(pin)).send(draftBody());
    expect(res.status).toBe(403);
  });

  it("read_only refuses the draft POST and still answers reads; off refuses everything", async () => {
    const token = await mint();
    await setMode("read_only");
    const before = await countMessages();
    const refused = await post(token, draftBody());
    expect(refused.status).toBe(503);
    expect(refused.body.code).toBe("agents_read_only");
    expect(await countMessages()).toBe(before);
    expect((await request(app).get("/api/hub/threads").set(bearer(token))).status).toBe(200);
    await setMode("off");
    expect((await request(app).get("/api/hub/threads").set(bearer(token))).status).toBe(503);
    expect((await post(token, draftBody())).status).toBe(503);
  });
});

describe("hubSend stays unreachable from the agent door", () => {
  it("no agent-door or hub-route file imports hubSend, the approval functions or a decision", () => {
    const root = path.resolve(__dirname, "..", "src");
    for (const file of ["agentApi/hubDoor.ts", "agentApi/gate.ts", "agentApi/respond.ts", "routes/hub.ts"]) {
      const text = fs.readFileSync(path.join(root, file), "utf8");
      expect(text, file).not.toMatch(/import\s*\{[^}]*\bhubSend\b[^}]*\}\s*from/);
    }
    const door = fs.readFileSync(path.join(root, "agentApi/hubDoor.ts"), "utf8");
    for (const m of door.matchAll(/^import[\s\S]*?from\s+"([^"]+)";/gm)) {
      expect(m[1], "an import in hubDoor.ts").not.toMatch(/hubSend|hubApproval|hubActions/);
    }
  });
});

// ── C6 review fixes ──────────────────────────────────────────────────────────────────────────────

const lastKeyId = () => keyIds[keyIds.length - 1]!;
const auditRows = (agentKeyId: string) => prisma.agentAuditLog.findMany({ where: { agentKeyId }, orderBy: { createdAt: "asc" } });
const getMessages = (token: string, threadId: string) => request(app).get(`/api/hub/threads/${threadId}/messages`).set(bearer(token));

describe("the questions an agent may not ask (search, bad filters) are refused in the agent shape and audited", () => {
  it("q is refused with 400 bad_request 'Search is not available to agent keys', and the call is audited; a CRM session still searches", async () => {
    const token = await mint();
    const keyId = lastKeyId();
    const res = await request(app).get("/api/hub/threads?q=555-0142").set(bearer(token));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ code: "bad_request", reason: "Search is not available to agent keys.", retryable: false });
    const rows = await auditRows(keyId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ endpoint: "GET /hub/threads", responseStatus: 400, resultCode: "bad_request" });
    expect(rows[0]!.payloadJson ?? "").not.toContain("555-0142");
    // The same key without q still works, and a person at the CRM can still search.
    expect((await request(app).get("/api/hub/threads").set(bearer(token))).status).toBe(200);
    const pin = (await request(app).post("/auth/pin").send({ pin: PIN })).body.token as string;
    expect((await request(app).get("/hub/threads?q=zzz-nothing").set(bearer(pin))).status).toBe(200);
  });

  it("a bogus kind, status or since is the agent error shape with its audit row (not the CRM's { error })", async () => {
    const token = await mint();
    const keyId = lastKeyId();
    const kind = await request(app).get("/api/hub/threads?kind=bogus").set(bearer(token));
    expect(kind.status).toBe(400);
    expect(kind.body).toMatchObject({ code: "bad_request", retryable: false });
    expect(kind.body.error).toBeUndefined();
    const status = await request(app).get("/api/hub/threads?status=bogus").set(bearer(token));
    expect(status.status).toBe(400);
    expect(status.body.code).toBe("bad_request");
    for (const since of ["yesterday", "2026-01-01", "2026-01-01T00:00:00"]) {
      const bad = await request(app).get(`/api/hub/threads?since=${encodeURIComponent(since)}`).set(bearer(token));
      expect(bad.status, since).toBe(400);
      expect(bad.body.code, since).toBe("bad_time");
    }
    const rows = await auditRows(keyId);
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.responseStatus === 400 && r.endpoint === "GET /hub/threads")).toBe(true);
  });
});

describe("the contract path GET /api/hub/threads/:id/messages, and since", () => {
  let accountId = "";
  let threadId = "";

  beforeAll(async () => {
    const c = await prisma.customer.create({ data: { name: `Sincefirst Sincelast${randomUUID().slice(0, 6)}` } });
    accountId = c.id;
    const t = await ensureThreadFor({ customerId: c.id });
    threadId = t.id;
    await prisma.hubMessage.create({
      data: { threadId, authorType: "customer", authorDisplay: c.name, channel: "sms", direction: "inbound", status: "received", body: "old message" },
    });
    await prisma.hubThread.update({ where: { id: threadId }, data: { lastMessageAt: new Date("2020-06-01T12:00:00Z") } });
  });
  afterAll(async () => {
    await prisma.hubThread.deleteMany({ where: { customerId: accountId } });
    await prisma.customer.deleteMany({ where: { id: accountId } });
  });

  it("an agent reads the thread at /hub/threads/:id/messages; the CRM path /hub/threads/:id is not an agent route", async () => {
    const token = await mint();
    const ok = await getMessages(token, threadId);
    expect(ok.status).toBe(200);
    expect(ok.body.thread.id).toBe(threadId);
    const crmPath = await request(app).get(`/api/hub/threads/${threadId}`).set(bearer(token));
    expect(crmPath.status).toBe(401);
    expect(crmPath.body.code).toBe("agent_key_not_accepted");
    // The CRM keeps /hub/threads/:id; the contract path is the agents' alone.
    const pin = (await request(app).post("/auth/pin").send({ pin: PIN })).body.token as string;
    const crm = await request(app).get(`/hub/threads/${threadId}`).set(bearer(pin));
    expect(crm.status).toBe(200);
    expect(crm.body.messages[0].body).toBe("old message");
    expect((await request(app).get(`/hub/threads/${threadId}/messages`).set(bearer(pin))).status).toBe(404);
  });

  it("since keeps only threads with a message after it", async () => {
    const token = await mint();
    const after = await request(app).get(`/api/hub/threads?since=${encodeURIComponent("2026-01-01T00:00:00Z")}`).set(bearer(token)).expect(200);
    expect(after.body.threads.some((t: { id: string }) => t.id === threadId)).toBe(false);
    const before = await request(app).get(`/api/hub/threads?since=${encodeURIComponent("2020-01-01T00:00:00-06:00")}`).set(bearer(token)).expect(200);
    expect(before.body.threads.some((t: { id: string }) => t.id === threadId)).toBe(true);
    const exact = await request(app).get(`/api/hub/threads?since=${encodeURIComponent("2020-06-01T12:00:00Z")}`).set(bearer(token)).expect(200);
    expect(exact.body.threads.some((t: { id: string }) => t.id === threadId)).toBe(false); // strictly after
  });
});

describe("thread titles are a first name, never the stored title", () => {
  const last = `Testwell${randomUUID().slice(0, 6)}`;
  const leadLast = `Leadlast${randomUUID().slice(0, 6)}`;
  const street = "5 Elmwood Terrace";
  let acct = ""; let prop = ""; let visit = ""; let leadRow = "";
  let customerThread = ""; let jobThread = ""; let leadThread = "";

  beforeAll(async () => {
    const c = await prisma.customer.create({
      data: { name: `Janelle ${last}`, properties: { create: { name: "Home", addressLine1: street, city: "Smyrna", state: "TN", postalCode: "37167" } } },
      include: { properties: true },
    });
    acct = c.id; prop = c.properties[0]!.id;
    visit = (await prisma.visit.create({ data: { customerId: acct, propertyId: prop, mode: "service_diagnostic", purpose: `${TAG} titles`, status: "contracted" } })).id;
    leadRow = (await prisma.lead.create({ data: { name: `Marcus ${leadLast}` } })).id;
    customerThread = (await ensureThreadFor({ customerId: acct })).id;
    jobThread = (await ensureThreadFor({ visitId: visit })).id;
    leadThread = (await ensureThreadFor({ leadId: leadRow })).id;
    for (const threadId of [customerThread, jobThread, leadThread]) {
      await prisma.hubMessage.create({
        data: { threadId, authorType: "office", authorDisplay: "Kyle Smith", channel: "in_app", direction: "internal", status: "posted", body: "Noted." },
      });
    }
  });
  afterAll(async () => {
    await prisma.hubThread.deleteMany({ where: { id: { in: [customerThread, jobThread, leadThread] } } });
    await prisma.visit.deleteMany({ where: { id: visit } });
    await prisma.lead.deleteMany({ where: { id: leadRow } });
    await prisma.property.deleteMany({ where: { id: prop } });
    await prisma.customer.deleteMany({ where: { id: acct } });
  });

  const titleOf = (body: { threads: Array<{ id: string; title: string | null }> }, id: string) => body.threads.find((t) => t.id === id)?.title;

  it("an Admin key sees 'Janelle' and 'Marcus' in the list and the detail, and the full name and street appear nowhere", async () => {
    // The stored titles really are the full name and "name - street": that is what must not reach the agent.
    expect((await prisma.hubThread.findUniqueOrThrow({ where: { id: customerThread } })).title).toBe(`Janelle ${last}`);
    expect((await prisma.hubThread.findUniqueOrThrow({ where: { id: jobThread } })).title).toBe(`Janelle ${last} — ${street}`);
    const token = await mint({ agentRole: "admin" });
    const list = await request(app).get("/api/hub/threads").set(bearer(token)).expect(200);
    expect(titleOf(list.body, customerThread)).toBe("Janelle");
    expect(titleOf(list.body, jobThread)).toBe("Janelle");
    expect(titleOf(list.body, leadThread)).toBe("Marcus");
    for (const id of [customerThread, jobThread, leadThread]) {
      const detail = await getMessages(token, id).expect(200);
      expect(detail.text).not.toContain(last);
      expect(detail.text).not.toContain(leadLast);
      expect(detail.text).not.toContain("Elmwood");
    }
    expect((await getMessages(token, jobThread)).body.thread.title).toBe("Janelle");
    expect(list.text).not.toContain(last);
    expect(list.text).not.toContain(leadLast);
    expect(list.text).not.toContain("Elmwood");
  });

  it("an Inventory key (no names allowed) sees a null title", async () => {
    const token = await mint({ agentRole: "inventory", scopes: ["inventory:read", "hub:read"] });
    const list = await request(app).get("/api/hub/threads").set(bearer(token)).expect(200);
    for (const id of [customerThread, jobThread, leadThread]) expect(titleOf(list.body, id)).toBeNull();
    const ours = JSON.stringify(list.body.threads.filter((t: { id: string }) => [customerThread, jobThread, leadThread].includes(t.id)));
    expect(ours).not.toContain("Janelle");
    expect(ours).not.toContain("Marcus");
  });
});

describe("which kinds of thread a key may read or draft in come from its scopes (HUB_KIND_SCOPES)", () => {
  it("the default scopes still give Admin team:reply, Scout training:read/write and Claude Code dev:read", () => {
    expect(DEFAULT_SCOPES_BY_ROLE.admin).toContain("team:reply");
    expect(DEFAULT_SCOPES_BY_ROLE.scout).toEqual(expect.arrayContaining(["training:read", "training:write"]));
    expect(DEFAULT_SCOPES_BY_ROLE.claude_code).toContain("dev:read");
  });

  it("hub:read alone reads customer and job threads only: a Team, Dev or Training thread is 403 and is not listed", async () => {
    const token = await mint({ agentRole: "inventory", scopes: ["inventory:read", "hub:read"] });
    for (const id of [teamThreadId, devThreadId, trainingThreadId]) {
      const res = await getMessages(token, id);
      expect(res.status, id).toBe(403);
      expect(res.body.code).toBe("forbidden");
    }
    const list = await request(app).get("/api/hub/threads?status=all").set(bearer(token)).expect(200);
    const ids = list.body.threads.map((t: { id: string }) => t.id);
    for (const id of [teamThreadId, devThreadId, trainingThreadId]) expect(ids).not.toContain(id);
    expect(list.body.threads.every((t: { kind: string }) => t.kind === "customer" || t.kind === "job")).toBe(true);
    for (const kind of ["team", "dev", "training"]) expect((await request(app).get(`/api/hub/threads?kind=${kind}`).set(bearer(token))).status, kind).toBe(403);
  });

  it("team:reply opens Team threads, dev:read opens Dev threads, training:read or training:write opens Training threads", async () => {
    const team = await mint({ scopes: ["hub:read", "team:reply"] });
    expect((await getMessages(team, teamThreadId)).status).toBe(200);
    expect((await getMessages(team, devThreadId)).status).toBe(403);
    const dev = await mint({ scopes: ["hub:read", "dev:read"] });
    expect((await getMessages(dev, devThreadId)).status).toBe(200);
    expect((await getMessages(dev, teamThreadId)).status).toBe(403);
    for (const scope of ["training:read", "training:write"] as const) {
      const training = await mint({ scopes: ["hub:read", scope] });
      expect((await getMessages(training, trainingThreadId)).status, scope).toBe(200);
    }
    const teamList = await request(app).get("/api/hub/threads?kind=team").set(bearer(team)).expect(200);
    expect(teamList.body.threads.some((t: { id: string }) => t.id === teamThreadId)).toBe(true);
  });

  it("hubThreadKinds still narrows on top of the scopes", async () => {
    const token = await mint({ scopes: ["hub:read", "team:reply", "dev:read"], hubThreadKinds: ["team"] });
    expect((await getMessages(token, teamThreadId)).status).toBe(200);
    const dev = await getMessages(token, devThreadId);
    expect(dev.status).toBe(403);
    expect(dev.body.reason).toBe("This key may only use team threads. Change the limit on Settings → Agent keys.");
  });

  it("a draft needs the posting scope for the kind: hub:draft for a customer, team:reply for Team, training:write for Training, and Dev is never drafted here", async () => {
    const before = await countMessages();
    // Team thread: hub:draft alone is not enough.
    const noTeam = await mint({ scopes: ["hub:read", "hub:draft"] });
    expect((await post(noTeam, { thread_id: teamThreadId, body: "x", idempotency_key: key() })).status).toBe(403);
    // Training thread: reading it is not drafting in it.
    const readOnlyTraining = await mint({ scopes: ["hub:read", "hub:draft", "training:read"] });
    expect((await post(readOnlyTraining, { thread_id: trainingThreadId, body: "x", idempotency_key: key() })).status).toBe(403);
    // Dev thread: dev:read reads it; no scope drafts into it through this door.
    const dev = await mint({ scopes: ["hub:read", "hub:draft", "dev:read", "team:reply", "training:write"] });
    const refusedDev = await post(dev, { thread_id: devThreadId, body: "x", idempotency_key: key() });
    expect(refusedDev.status).toBe(403);
    expect(refusedDev.body.reason).toBe("Dev threads are written through the dev door, not here.");
    expect(await countMessages()).toBe(before);
    // With the right scopes the other kinds work.
    expect((await post(dev, { thread_id: teamThreadId, body: "Team reply allowed.", idempotency_key: key() })).status).toBe(201);
    expect((await post(dev, { thread_id: trainingThreadId, body: "Training reply allowed.", idempotency_key: key() })).status).toBe(201);
  });

  it("an agent reader built without scopes sees nothing (fail closed), and the scopes in a request's key become the reader's", async () => {
    const bare: HubReader = { key: "agent:bare", kind: "agent", display: "Bare", technicianId: null, threadKinds: [], agentRole: "admin", agentKeyId: "bare", isKyle: false };
    for (const id of [teamThreadId, devThreadId, trainingThreadId]) expect(await findVisibleThread(bare, id)).toBeNull();
    const principal = { keyId: "K1", name: "Key", role: "admin", hubThreadKinds: [] as string[], scopes: ["hub:read", "team:reply"] };
    const reader = readerFor({ agentPrincipal: principal } as never)!;
    expect(reader.agentScopes).toEqual(["hub:read", "team:reply"]);
    expect(await findVisibleThread(reader, teamThreadId)).not.toBeNull();
    expect(await findVisibleThread(reader, devThreadId)).toBeNull();
  });
});

describe("a last line is scrubbed whole and THEN cut", () => {
  it("a phone number that straddles the 140-character cut is withheld, in the list and in the detail", async () => {
    const c = await prisma.customer.create({ data: { name: `Cutfirst Cutlast${randomUUID().slice(0, 6)}` } });
    const t = await ensureThreadFor({ customerId: c.id });
    try {
      // The number starts at character 129 and runs past 140: cut first, only "(615) 555-01" would be left for the patterns.
      const body = `${"z".repeat(128)} (615) 555-0199 and then some more words after it so the line is long`;
      await prisma.hubMessage.create({
        data: { threadId: t.id, authorType: "office", authorDisplay: "Kyle Smith", channel: "in_app", direction: "internal", status: "posted", body },
      });
      const token = await mint();
      const list = await request(app).get("/api/hub/threads").set(bearer(token)).expect(200);
      const row = list.body.threads.find((x: { id: string }) => x.id === t.id);
      expect(row.lastLine.text).toContain("[withheld]");
      expect(row.lastLine.text).not.toMatch(/\(615\)|555-01|0199/);
      expect(row.lastLine.text.length).toBeLessThanOrEqual(141); // 140 plus the ellipsis
      const detail = await getMessages(token, t.id).expect(200);
      expect(detail.body.thread.lastLine.text).toContain("[withheld]");
      expect(detail.text).not.toMatch(/\(615\)|555-01|0199/);
    } finally {
      await prisma.hubThread.deleteMany({ where: { id: t.id } });
      await prisma.customer.deleteMany({ where: { id: c.id } });
    }
  });
});

describe("the Scout key is answered with the Scout training profile", () => {
  it("a message is exactly messageId, threadId, apprenticeFirstName, authorType, createdAt and text; a thread row has no customerId, leadId or visitId", async () => {
    const scout = await mint({ agentRole: "scout", scopes: SCOUT_SCOPES, hubThreadKinds: ["training"] });
    const detail = await getMessages(scout, trainingThreadId).expect(200);
    expect(Object.keys(detail.body.messages[0]).sort()).toEqual(["apprenticeFirstName", "authorType", "createdAt", "messageId", "text", "threadId"]);
    expect(detail.body.messages[0].apprenticeFirstName).toBe(TAG);
    for (const k of ["customerId", "leadId", "visitId"]) expect(detail.body.thread, k).not.toHaveProperty(k);
    const list = await request(app).get("/api/hub/threads").set(bearer(scout)).expect(200);
    for (const row of list.body.threads) for (const k of ["customerId", "leadId", "visitId"]) expect(row, k).not.toHaveProperty(k);
    expect(list.body.threads.some((t: { id: string }) => t.id === trainingThreadId)).toBe(true);
  });

  it("any other key reads the SAME message through the one every-key projection (no second one)", async () => {
    const token = await mint({ scopes: ["hub:read", "team:reply"] });
    const res = await getMessages(token, teamThreadId).expect(200);
    expect(Object.keys(res.body.messages[0]).sort()).toEqual([
      "authorFirstName", "authorType", "body", "channel", "createdAt", "direction", "editedAt", "id", "messageClass", "status", "subject", "threadId",
    ]);
  });

  it("every Scout post in a training thread is pending_approval, even when it asks for 'draft'", async () => {
    const scout = await mint({ agentRole: "scout", scopes: SCOUT_SCOPES, hubThreadKinds: ["training"] });
    const res = await post(scout, { thread_id: trainingThreadId, body: "Try the neutral bar first.", status: "draft", idempotency_key: key() });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("pending_approval");
    expect((await prisma.hubMessage.findUniqueOrThrow({ where: { id: res.body.messageId } })).status).toBe("pending_approval");
    // Everywhere else 'draft' is still kept.
    const admin = await mint({ scopes: ["hub:read", "hub:draft", "team:reply"] });
    const keep = await post(admin, { thread_id: teamThreadId, body: "A held team note.", status: "draft", idempotency_key: key() });
    expect(keep.body.status).toBe("draft");
    // And anything but draft or pending_approval is still refused in a training thread.
    const refused = await post(scout, { thread_id: trainingThreadId, body: "x", status: "approved", idempotency_key: key() });
    expect(refused.status).toBe(403);
  });
});

describe("a draft's duplicate guard follows the request, not just the key", () => {
  const customerThreadFor = async () => (await ensureThreadFor({ customerId })).id;
  const countOn = (threadId: string) => prisma.hubMessage.count({ where: { threadId } });

  it("a true retry whose idempotency row is gone finds the SAME draft and writes no second one", async () => {
    const token = await mint();
    const keyId = lastKeyId();
    const k = key();
    const first = await post(token, draftBody({ idempotency_key: k }));
    expect(first.status).toBe(201);
    const threadId = await customerThreadFor();
    const before = await countOn(threadId);
    await prisma.agentIdempotency.deleteMany({ where: { agentKeyId: keyId } });
    const again = await post(token, draftBody({ idempotency_key: k }));
    expect(again.status).toBe(201);
    expect(again.body.messageId).toBe(first.body.messageId);
    expect(await countOn(threadId)).toBe(before);
    const audits = await auditRows(keyId);
    expect(audits.at(-1)!.resultCode).toBe("replayed");
  });

  it("the same key with a different body after the 24 hours is a NEW draft, never the old one", async () => {
    const token = await mint();
    const keyId = lastKeyId();
    const k = key();
    const first = await post(token, draftBody({ idempotency_key: k, body: "Original wording of the quote note." }));
    expect(first.status).toBe(201);
    await prisma.agentIdempotency.updateMany({ where: { agentKeyId: keyId }, data: { expiresAt: new Date(Date.now() - 60_000) } });
    const second = await post(token, draftBody({ idempotency_key: k, body: "Corrected wording of the quote note." }));
    expect(second.status).toBe(201);
    expect(second.body.messageId).not.toBe(first.body.messageId);
    const row = await prisma.hubMessage.findUniqueOrThrow({ where: { id: second.body.messageId } });
    expect(row.body).toBe("Corrected wording of the quote note.");
  });

  it("a reused key on ANOTHER thread after the window is a new draft there, not a 'message id already used' 400", async () => {
    const token = await mint();
    const keyId = lastKeyId();
    const k = key();
    const other = await prisma.customer.create({ data: { name: `${TAG} Elsewhere` } });
    try {
      expect((await post(token, draftBody({ idempotency_key: k }))).status).toBe(201);
      await prisma.agentIdempotency.updateMany({ where: { agentKeyId: keyId }, data: { expiresAt: new Date(Date.now() - 60_000) } });
      const elsewhere = await post(token, draftBody({ idempotency_key: k, customerId: other.id }));
      expect(elsewhere.status).toBe(201);
      const row = await prisma.hubMessage.findUniqueOrThrow({ where: { id: elsewhere.body.messageId }, include: { thread: true } });
      expect(row.thread.customerId).toBe(other.id);
    } finally {
      await prisma.hubThread.deleteMany({ where: { customerId: other.id } });
      await prisma.customer.delete({ where: { id: other.id } });
    }
  });

  it("two calls racing on one clientMessageId leave ONE row (the unique key keeps one, the loser gets the winner's)", async () => {
    const threadId = await customerThreadFor();
    const reader: HubReader = {
      key: `agent:race-${randomUUID().slice(0, 6)}`, kind: "agent", display: "Race", technicianId: null, threadKinds: [], agentRole: "admin", agentKeyId: null,
      agentScopes: ["hub:read", "hub:draft"], isKyle: false,
    };
    const input = { threadId, channel: "email" as const, body: "One draft only.", subject: "Race", clientMessageId: `idem-race-${randomUUID()}` };
    const results = await Promise.all([1, 2, 3, 4].map(() => createDraftMessage(reader, input)));
    expect(new Set(results.map((r) => r.message.id)).size).toBe(1);
    expect(await prisma.hubMessage.count({ where: { authorKey: reader.key, clientMessageId: input.clientMessageId } })).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
  });
});

describe("the idempotency transaction has room for slow effects", () => {
  it("an operation that runs longer than Prisma's default 5 seconds still commits with its idempotency record", async () => {
    expect(IDEMPOTENT_TX_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
    await mint();
    const keyId = lastKeyId();
    const k = key();
    const out = await withIdempotency({ keyId, role: "admin" }, "test.slow", k, { a: 1 }, async (tx) => {
      await new Promise((resolve) => setTimeout(resolve, 5_600));
      await tx.$queryRaw`SELECT 1`;
      return { ok: true };
    });
    expect(out).toEqual({ result: { ok: true }, replayed: false });
    const again = await withIdempotency({ keyId, role: "admin" }, "test.slow", k, { a: 1 }, async () => ({ ok: false }));
    expect(again).toEqual({ result: { ok: true }, replayed: true });
  }, 30_000);
});

describe("an agent draft is announced and offered to the auto-send rule", () => {
  it("fires the hub fan-out for the new draft, runs the BA8 evaluation, and with every category off it stays pending_approval and sends nothing", async () => {
    const token = await mint();
    const events: HubBusEvent[] = [];
    const stop = subscribeHub((e) => events.push(e));
    offered.messageIds.length = 0;
    try {
      const res = await post(token, draftBody({ category: "thread_reply" }));
      expect(res.status).toBe(201);
      const id = res.body.messageId as string;
      expect(events).toContainEqual({ type: "message", threadId: res.body.threadId, messageId: id });
      expect(offered.messageIds).toEqual([id]);
      const row = await prisma.hubMessage.findUniqueOrThrow({ where: { id } });
      expect(row.status).toBe("pending_approval");
      expect(await prisma.hubAuditLog.count({ where: { messageId: id, action: "message_auto_approved" } })).toBe(0);
      expect(sent.emails).toHaveLength(0);
    } finally {
      stop();
    }
  });
});
