/**
 * W2 batch E (Kyle, 2026-11-23, item 7): "@Coding" asks Claude Code to change the app. A person's message in a Team, group or crew chat that
 * mentions @Coding becomes ONE CodingRun and one GitHub repository_dispatch; the Coding key's reply closes it.
 *
 * Everything here is REAL except the one GitHub HTTP call (global fetch is stubbed for api.github.com only, and the request is asserted).
 * The gate is ON (PIN_HASH set): with the gate off every request is "Kyle", which would make "only Kyle or someone he allowed" pass for anyone.
 *
 * Pinned:
 *   - who may ask: Kyle's PIN session, Kyle's field phone (a technician linked to his principal login), a technician whose linked CRM login holds
 *     coding_requests; refused (line in the thread, row refused, audit coding_refused, NO GitHub call) for a login without the power, a plain
 *     technician and a turned-off login;
 *   - who never asks: an agent key (Coding's own "@Coding" included), the AI admin session, an approver's edit-approved copy of an agent's draft;
 *   - the dispatch itself (URL, method, headers, event_type, client_payload keys, the text through the ONE scrub), the run row and the audit rows;
 *   - one open run per thread (a second @Coding is told so; two at the same instant leave exactly one dispatched), "@Coding cancel", the 60-minute sweep;
 *   - what is missing is named: no Coding key, Allow writes off, a group the key is not in;
 *   - a failed dispatch says so in fixed words and no token, body or error text reaches any row, line, audit entry or log;
 *   - Coding's reply closes the run and records the pull request link.
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
vi.mock("../src/services/confirmationEmail", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/services/confirmationEmail")>();
  return { ...mod, sendBrandedEmail: vi.fn().mockResolvedValue(true), sendKyleNotificationEmail: vi.fn().mockResolvedValue(undefined) };
});

import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { hashPin } from "../src/middleware/pinAuth";
import { mintAgentKey } from "../src/agentApi/keys";
import { saveCrmLogin, setCrmLoginEnabled, setPowers, setPrincipal } from "../src/services/crmLogin";
import { saveAdminLogin } from "../src/services/adminLogin";
import { readerForKey } from "../src/services/hub";
import { listAudit } from "../src/services/hubAuditView";
import {
  CODING_LINES, CODING_RUN_TIMEOUT_MS, CODING_TEXT_CAP, CODING_TEXT_CUT_NOTE, GITHUB_API_VERSION, GITHUB_CODING_REPO,
  GITHUB_DISPATCH_URL, handleCodingRequest, isCancelRequest, sweepCodingRuns,
} from "../src/services/hubCoding";
import { CRM_POWERS } from "../shared/crmPowers";
import { HUB_AUDIT_ACTION_LABELS } from "../shared/hub/auditLabels";

const TAG = "CodingW2E";
const RUN = Math.random().toString(36).slice(2, 8);
const PIN = "1234";
const PASS = "correct horse battery";
const AI_PASS = "another long password!";
const DISPATCH_TOKEN = "ghp_W2eDispatchTokenValue0123456789";
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const idem = () => `idem-${randomUUID()}`;

type Person = { id: string; name: string; token: string };
const techIds: string[] = [];
const keyIds: string[] = [];
let pinToken = "";
let kyle: Person;
let michael: Person;
let eric: Person;
let kyleTeam = "";
let michaelTeam = "";
let ericTeam = "";
let codingKey: { id: string; secret: string };
const saved: Record<string, string | undefined> = {};

// ── the one stubbed call: GitHub ─────────────────────────────────────────────────────────────────
interface GhCall { url: string; init: RequestInit; payload: { event_type: string; client_payload: Record<string, unknown> } }
let ghCalls: GhCall[] = [];
let ghAnswer: () => Response | Promise<Response> = () => new Response(null, { status: 204 });
const realFetch = globalThis.fetch;

async function wipe() {
  await prisma.codingRun.deleteMany({ where: { thread: { OR: [{ title: { startsWith: TAG } }, { technicianId: { in: techIds } }] } } });
  await prisma.hubThread.deleteMany({ where: { OR: [{ title: { startsWith: TAG } }, { technicianId: { in: techIds } }] } });
  await prisma.companySetting.deleteMany({ where: { key: "agentAccess" } });
  await prisma.hubEventAttempt.deleteMany();
  await prisma.hubEvent.deleteMany();
  await prisma.crmLogin.deleteMany({ where: { technicianId: { in: techIds } } });
  await prisma.agentIdempotency.deleteMany({ where: { agentKeyId: { in: keyIds } } });
  await prisma.agentKey.deleteMany({ where: { id: { in: keyIds.splice(0) } } });
  await prisma.technician.deleteMany({ where: { id: { in: techIds.splice(0) } } });
}

async function person(name: string): Promise<Person> {
  const t = await prisma.technician.create({ data: { name, isActive: true, accessToken: `${TAG}-${name}-${randomUUID()}` } });
  techIds.push(t.id);
  return { id: t.id, name: t.name, token: t.accessToken };
}
async function teamThread(p: Person): Promise<string> {
  return (await prisma.hubThread.create({ data: { kind: "team", title: `${TAG} ${p.name} team`, technicianId: p.id } })).id;
}
async function mintCoding(over: { writesEnabled?: boolean; scopes?: string[] } = {}) {
  const made = await mintAgentKey({ name: `${TAG} Coding ${randomUUID().slice(0, 5)}`, agentRole: "claude_code", createdBy: "owner", writesEnabled: over.writesEnabled ?? true, scopes: over.scopes });
  keyIds.push(made.row.id);
  return { id: made.row.id, secret: made.key };
}

beforeAll(async () => {
  for (const k of ["PIN_HASH", "AGENT_KEY_PEPPER", "RAILWAY_ENVIRONMENT_NAME", "GITHUB_DISPATCH_TOKEN"]) saved[k] = process.env[k];
  process.env.PIN_HASH = await hashPin(PIN);
  process.env.AGENT_KEY_PEPPER = "test-pepper-for-the-w2e-coding-suite";
  delete process.env.RAILWAY_ENVIRONMENT_NAME;
  await wipe();
  pinToken = (await request(app).post("/auth/pin").send({ pin: PIN })).body.token as string;
});
afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await prisma.adminLogin.deleteMany({ where: { username: `${TAG.toLowerCase()}-ai-${RUN}` } });
  await wipe();
});
beforeEach(async () => {
  await wipe();
  process.env.GITHUB_DISPATCH_TOKEN = DISPATCH_TOKEN;
  ghCalls = [];
  ghAnswer = () => new Response(null, { status: 204 });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    if (url.startsWith("https://api.github.com/")) {
      ghCalls.push({ url, init: init ?? {}, payload: JSON.parse(String(init?.body ?? "{}")) });
      return ghAnswer();
    }
    return realFetch(input as never, init);
  });
  kyle = await person("Kyle");
  michael = await person("Michael");
  eric = await person("Eric");
  // Kyle's own login is the principal one; Michael has a login with NO power; Eric has no login at all.
  const kyleLogin = await saveCrmLogin(kyle.id, { username: `${TAG.toLowerCase()}-kyle-${RUN}`, role: "owner", password: PASS });
  await setPrincipal(kyleLogin.id);
  await saveCrmLogin(michael.id, { username: `${TAG.toLowerCase()}-michael-${RUN}`, role: "owner", password: PASS });
  kyleTeam = await teamThread(kyle);
  michaelTeam = await teamThread(michael);
  ericTeam = await teamThread(eric);
  codingKey = await mintCoding();
});
afterEach(() => vi.restoreAllMocks());

// ── doing things ─────────────────────────────────────────────────────────────────────────────────
/** A technician's post from the field app. Returns the message id. */
async function fieldPost(p: Person, threadId: string, body: string): Promise<string> {
  const res = await request(app).post(`/health-record/hub/threads/${threadId}/messages`).set(bearer(p.token)).send({ body, clientMessageId: `field-${randomUUID()}` });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data.id as string;
}
/** Kyle's PIN session posting from the CRM. */
async function pinPost(threadId: string, body: string): Promise<string> {
  const res = await request(app).post(`/hub/threads/${threadId}/messages`).set(bearer(pinToken)).send({ body, clientMessageId: `crm-${randomUUID()}` });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
}
const agentPost = (secret: string, threadId: string, body: string) =>
  request(app).post("/api/hub/messages").set(bearer(secret)).send({ thread_id: threadId, body, idempotency_key: idem() });

const runFor = (messageId: string) => prisma.codingRun.findUnique({ where: { triggerMessageId: messageId } });
/** The run row for this message, once the fire-and-forget handling has finished with it (it is no longer just "requested"). */
const settledRun = (messageId: string) => vi.waitFor(async () => {
  const run = await runFor(messageId);
  expect(run).not.toBeNull();
  expect(run!.status).not.toBe("requested");
  return run!;
}, { timeout: 8000, interval: 50 });
const lines = async (threadId: string): Promise<string[]> =>
  (await prisma.hubMessage.findMany({ where: { threadId, authorType: "system" }, orderBy: { createdAt: "asc" } })).map((m) => m.body);
const lineCount = (threadId: string, n: number) => vi.waitFor(async () => { expect((await lines(threadId)).length).toBeGreaterThanOrEqual(n); }, { timeout: 8000, interval: 50 });
const quiet = () => new Promise((r) => setTimeout(r, 400));
const auditFor = (threadId: string) => prisma.hubAuditLog.findMany({ where: { threadId, action: { startsWith: "coding_" } }, orderBy: { at: "asc" } });
async function grantMichael() {
  const login = await prisma.crmLogin.findFirstOrThrow({ where: { technicianId: michael.id } });
  await setPowers(login.id, ["coding_requests"]);
}

// ── who may ask ──────────────────────────────────────────────────────────────────────────────────
describe("who may ask Claude Code, decided from the stored author key", () => {
  it("Kyle at the CRM (PIN session) in his Team thread: one run, one dispatch to GitHub, the thread told, the audit written", async () => {
    const id = await pinPost(kyleTeam, "@Coding add a comment to the README. Call 615-555-0199 or jane@homeowner.example, token " + DISPATCH_TOKEN);
    const run = await settledRun(id);
    expect(run).toMatchObject({ status: "dispatched", githubStatus: 204, requestedByKey: "owner", requestedByDisplay: "Kyle", threadId: kyleTeam });
    expect(run.dispatchedAt).not.toBeNull();

    // The ONE GitHub call, exactly as the research names it.
    expect(ghCalls).toHaveLength(1);
    const call = ghCalls[0];
    expect(call.url).toBe(GITHUB_DISPATCH_URL);
    expect(call.url).toBe(`https://api.github.com/repos/${GITHUB_CODING_REPO}/dispatches`);
    expect(call.init.method).toBe("POST");
    expect(call.init.redirect).toBe("manual");
    expect(call.init.headers).toEqual({
      Authorization: `Bearer ${DISPATCH_TOKEN}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": GITHUB_API_VERSION,
      "User-Agent": "rce-crm", "Content-Type": "application/json",
    });
    expect(call.payload.event_type).toBe("hub_coding_request");
    const payload = call.payload.client_payload;
    expect(Object.keys(payload).sort()).toEqual(["author", "author_type", "created_at", "message_id", "run_id", "text", "thread_id"]);
    expect(payload).toMatchObject({ run_id: run.id, thread_id: kyleTeam, message_id: id, author: "Kyle", author_type: "person" });
    // The text went through the ONE scrub: contact details withheld, the dispatch token itself removed.
    const text = String(payload.text);
    expect(text).toContain("@Coding add a comment to the README.");
    expect(text).not.toContain("615-555-0199");
    expect(text).not.toContain("jane@homeowner.example");
    expect(text).not.toContain(DISPATCH_TOKEN);
    expect(text).toContain("[withheld]");

    await lineCount(kyleTeam, 1);
    expect(await lines(kyleTeam)).toEqual([CODING_LINES.started]);
    const audit = await auditFor(kyleTeam);
    expect(audit.map((a) => a.action)).toEqual(["coding_requested", "coding_dispatched"]);
    expect(audit[0]).toMatchObject({ actorKey: "owner", actorDisplay: "Kyle", entityType: "coding_run", entityId: run.id });
    expect(audit[1]).toMatchObject({ actorKey: "system" });
    expect(JSON.parse(audit[1].detailsJson ?? "{}")).toEqual({ runId: run.id, threadId: kyleTeam, githubStatus: 204 });
    // Ids and a status number only: never the text, never the token.
    for (const a of audit) {
      expect(`${a.detailsJson}${a.beforeText}${a.afterText}`).not.toContain(DISPATCH_TOKEN);
      expect(`${a.detailsJson}${a.beforeText}${a.afterText}`).not.toContain("README");
    }
  });

  it("the system lines show on the technician's own phone (the field thread read) and the audit labels read plainly on the Message audit log", async () => {
    await fieldPost(kyle, kyleTeam, "@Coding what is in the README");
    await lineCount(kyleTeam, 1);
    const read = await request(app).get(`/health-record/hub/threads/${kyleTeam}/messages`).set(bearer(kyle.token));
    expect(read.status).toBe(200);
    const system = (read.body.data.messages as Array<{ authorType: string; body: string }>).filter((m) => m.authorType === "system");
    expect(system.map((m) => m.body)).toEqual([CODING_LINES.started]);

    const view = await listAudit({ threadId: kyleTeam });
    const labels = view.entries.map((e) => e.actionLabel);
    expect(labels).toContain(HUB_AUDIT_ACTION_LABELS.coding_requested);
    expect(labels).toContain(HUB_AUDIT_ACTION_LABELS.coding_dispatched);
    for (const action of ["coding_requested", "coding_refused", "coding_dispatched", "coding_dispatch_failed", "coding_replied", "coding_cancelled", "coding_timed_out"]) {
      expect(HUB_AUDIT_ACTION_LABELS[action], action).toBeTruthy();
    }
  });

  it("Kyle on his field phone (a technician linked to his principal login) is Kyle", async () => {
    const id = await fieldPost(kyle, kyleTeam, "@Coding rename a variable");
    expect((await settledRun(id)).status).toBe("dispatched");
    expect(ghCalls).toHaveLength(1);
    expect(ghCalls[0].payload.client_payload.author).toBe("Kyle");
  });

  it("Michael WITHOUT the power: a line says only someone Kyle allowed can ask, the run is refused, GitHub hears nothing", async () => {
    const id = await fieldPost(michael, michaelTeam, "@Coding change the invoice colours");
    const run = await settledRun(id);
    expect(run).toMatchObject({ status: "refused", refusedReason: "not_allowed", requestedByKey: `tech:${michael.id}` });
    await lineCount(michaelTeam, 1);
    expect(await lines(michaelTeam)).toEqual([CODING_LINES.notAllowed]);
    expect(CODING_LINES.notAllowed).toBe("Only someone Kyle has allowed can ask Claude Code to change the app (Team → CRM login → Ask Claude Code to change the app).");
    const audit = await auditFor(michaelTeam);
    expect(audit.map((a) => a.action)).toEqual(["coding_refused"]);
    expect(audit[0]).toMatchObject({ actorKey: `tech:${michael.id}` });
    expect(ghCalls).toHaveLength(0);
  });

  it("Michael WITH coding_requests (granted on Team -> CRM login) asking from his phone: dispatched. Take the power away and he is refused again", async () => {
    await grantMichael();
    const id = await fieldPost(michael, michaelTeam, "@Coding add a loading spinner");
    expect((await settledRun(id)).status).toBe("dispatched");
    expect(ghCalls).toHaveLength(1);
    expect(ghCalls[0].payload.client_payload).toMatchObject({ author: "Michael", message_id: id });

    await prisma.codingRun.deleteMany({ where: { threadId: michaelTeam } }); // his run ends, so the next ask is judged on the power alone
    const login = await prisma.crmLogin.findFirstOrThrow({ where: { technicianId: michael.id } });
    await setPowers(login.id, []);
    const again = await fieldPost(michael, michaelTeam, "@Coding and another thing");
    expect((await settledRun(again)).status).toBe("refused");
    expect(ghCalls).toHaveLength(1);
  });

  it("a plain technician with no login, and a person whose login Kyle turned off, are refused", async () => {
    const e = await fieldPost(eric, ericTeam, "@Coding please");
    expect(await settledRun(e)).toMatchObject({ status: "refused", refusedReason: "not_allowed" });

    await grantMichael();
    const login = await prisma.crmLogin.findFirstOrThrow({ where: { technicianId: michael.id } });
    await setCrmLoginEnabled(login.id, false);
    const m = await fieldPost(michael, michaelTeam, "@Coding please");
    expect(await settledRun(m)).toMatchObject({ status: "refused", refusedReason: "not_allowed" });
    expect(ghCalls).toHaveLength(0);
  });

  it("readerForKey reports coding_requests from the stored login: owner yes, principal yes, granted yes, otherwise no (a technician follows the linked login)", async () => {
    await grantMichael();
    expect((await readerForKey("owner"))?.canAskCoding).toBe(true);
    expect((await readerForKey(`tech:${kyle.id}`))?.canAskCoding).toBe(true);
    expect((await readerForKey(`tech:${michael.id}`))?.canAskCoding).toBe(true);
    expect((await readerForKey(`tech:${eric.id}`))?.canAskCoding).toBe(false);
    const login = await prisma.crmLogin.findFirstOrThrow({ where: { technicianId: michael.id } });
    expect((await readerForKey(`user:${login.id}`))?.canAskCoding).toBe(true);
    expect(CRM_POWERS.coding_requests.label).toBe("Ask Claude Code to change the app");
  });
});

describe("who never asks", () => {
  it("an agent's post that says @Coding triggers nothing: not Coding's own, not another agent's, not the AI admin session", async () => {
    // Coding's own reply mentions @Coding (it is an agent author, so it asks nothing).
    const own = await agentPost(codingKey.secret, kyleTeam, "@Coding I am on it");
    expect(own.status, JSON.stringify(own.body)).toBe(201);
    // Another agent.
    const other = await mintAgentKey({ name: `${TAG} Admin`, agentRole: "admin", createdBy: "owner", writesEnabled: true });
    keyIds.push(other.row.id);
    expect((await agentPost(other.key, kyleTeam, "Handing this to @Coding")).status).toBe(201);
    // The AI admin's own CRM session writes ai_agent posts.
    const aiUser = `${TAG.toLowerCase()}-ai-${RUN}`;
    await saveAdminLogin(aiUser, AI_PASS);
    const ai = (await request(app).post("/auth/login").send({ username: aiUser, password: AI_PASS })).body.token as string;
    const aiRes = await request(app).post(`/hub/threads/${kyleTeam}/messages`).set(bearer(ai)).send({ body: "@Coding please do this", clientMessageId: `ai-${randomUUID()}` });
    expect(aiRes.status, JSON.stringify(aiRes.body)).toBe(201);

    await quiet();
    expect(await prisma.codingRun.count({ where: { threadId: kyleTeam } })).toBe(0);
    expect(ghCalls).toHaveLength(0);
    expect(await lines(kyleTeam)).toEqual([]);
  });

  it("an approver's edit-approved copy of an AGENT's draft that mentions @Coding is the agent's words: no run, no GitHub, no line", async () => {
    const draftKey = await mintAgentKey({ name: `${TAG} Drafty`, agentRole: "admin", createdBy: "owner", writesEnabled: true, teamPostsPublish: false });
    keyIds.push(draftKey.row.id);
    const made = await agentPost(draftKey.key, kyleTeam, "Eric asked for a change.");
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body.status).toBe("pending_approval");
    const edited = await request(app).post(`/hub/messages/${made.body.messageId}/edit-approve`).set(bearer(pinToken)).send({ body: "@Coding make the change Eric asked for" });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    const copy = await prisma.hubMessage.findFirstOrThrow({ where: { threadId: kyleTeam, editedFromId: made.body.messageId } });
    expect(copy.authorType).toBe("office"); // re-authored as the approver...
    await quiet();
    expect(await prisma.codingRun.count({ where: { threadId: kyleTeam } })).toBe(0); // ...but the words were the agent's
    expect(ghCalls).toHaveLength(0);
    expect(await lines(kyleTeam)).toEqual([]);
  });

  it("a message that does not mention @Coding (or only has it inside an email address) starts nothing", async () => {
    await fieldPost(kyle, kyleTeam, "Send it to bob@coding.example and ask the Coding people");
    await quiet();
    expect(await prisma.codingRun.count()).toBe(0);
    expect(ghCalls).toHaveLength(0);
  });
});

// ── one run per thread, and the ways out ─────────────────────────────────────────────────────────
describe("one open run per thread, cancel, timeout", () => {
  it("a second @Coding while one is open is told so and sends nothing; \"@Coding cancel\" closes it; with none open it says so; then asking works again", async () => {
    const first = await fieldPost(kyle, kyleTeam, "@Coding first request");
    expect((await settledRun(first)).status).toBe("dispatched");
    await lineCount(kyleTeam, 1);

    const second = await fieldPost(kyle, kyleTeam, "@Coding second request");
    expect(await settledRun(second)).toMatchObject({ status: "refused", refusedReason: "already_running" });
    await lineCount(kyleTeam, 2);
    const busy = (await lines(kyleTeam))[1];
    expect(busy).toMatch(/^Claude Code is still working on the last request in this conversation \(asked \d{1,2}:\d{2} (AM|PM)\)\. Say "@Coding cancel" to stop waiting\.$/);
    expect(ghCalls).toHaveLength(1);

    const cancel = await fieldPost(kyle, kyleTeam, "@coding CANCEL ");
    await lineCount(kyleTeam, 3);
    expect((await lines(kyleTeam))[2]).toBe(CODING_LINES.cancelled);
    expect(await prisma.codingRun.findUniqueOrThrow({ where: { triggerMessageId: first } })).toMatchObject({ status: "cancelled", cancelledByKey: `tech:${kyle.id}` });
    expect(await runFor(cancel)).toBeNull(); // the cancel is a command, not a request
    const audit = await auditFor(kyleTeam);
    expect(audit.map((a) => a.action)).toEqual(["coding_requested", "coding_dispatched", "coding_refused", "coding_cancelled"]);
    expect(audit[3]).toMatchObject({ actorKey: `tech:${kyle.id}` });

    await fieldPost(kyle, kyleTeam, "@Coding cancel");
    await lineCount(kyleTeam, 4);
    expect((await lines(kyleTeam))[3]).toBe("Nothing to cancel.");

    const third = await fieldPost(kyle, kyleTeam, "@Coding try again");
    expect((await settledRun(third)).status).toBe("dispatched");
    expect(ghCalls).toHaveLength(2);
  });

  it("cancel by someone who may not ask is refused like any other @Coding", async () => {
    const open = await fieldPost(kyle, kyleTeam, "@Coding going");
    await settledRun(open);
    const sneak = await fieldPost(eric, ericTeam, "@Coding cancel");
    expect((await settledRun(sneak)).status).toBe("refused");
    expect((await prisma.codingRun.findUniqueOrThrow({ where: { triggerMessageId: open } })).status).toBe("dispatched");
  });

  it("two @Coding posts in one thread at the same instant: exactly one is dispatched, the other is told one is running (the lock holder uses only its own transaction)", async () => {
    const ids = await Promise.all([
      fieldPost(kyle, kyleTeam, "@Coding request A"),
      pinPost(kyleTeam, "@Coding request B"),
      fieldPost(kyle, kyleTeam, "@Coding request C"),
    ]);
    const runs = await Promise.all(ids.map((id) => settledRun(id)));
    expect(runs.filter((r) => r.status === "dispatched")).toHaveLength(1);
    expect(runs.filter((r) => r.status === "refused" && r.refusedReason === "already_running")).toHaveLength(2);
    expect(ghCalls).toHaveLength(1);
  });

  it("the 60-minute sweep closes a run that never answered, tells the thread, and leaves a fresh run alone", async () => {
    const id = await fieldPost(kyle, kyleTeam, "@Coding slow one");
    const run = await settledRun(id);
    await lineCount(kyleTeam, 1);
    expect(await sweepCodingRuns(prisma)).toBe(0);
    expect((await runFor(id))!.status).toBe("dispatched");

    await prisma.codingRun.update({ where: { id: run.id }, data: { createdAt: new Date(Date.now() - CODING_RUN_TIMEOUT_MS - 60_000) } });
    expect(await sweepCodingRuns(prisma)).toBe(1);
    expect(await sweepCodingRuns(prisma)).toBe(0); // once
    expect(await runFor(id)).toMatchObject({ status: "timed_out" });
    await lineCount(kyleTeam, 2);
    expect((await lines(kyleTeam))[1]).toBe(CODING_LINES.timedOut);
    expect((await auditFor(kyleTeam)).map((a) => a.action)).toEqual(["coding_requested", "coding_dispatched", "coding_timed_out"]);
    // The thread can ask again.
    expect((await settledRun(await fieldPost(kyle, kyleTeam, "@Coding again"))).status).toBe("dispatched");
  });
});

// ── what is missing is named ─────────────────────────────────────────────────────────────────────
describe("a request that cannot be answered says what to fix and where", () => {
  it("no Coding key at all, then Allow writes off, then a key that cannot post", async () => {
    await prisma.agentKey.update({ where: { id: codingKey.id }, data: { revokedAt: new Date() } });
    const a = await fieldPost(kyle, kyleTeam, "@Coding one");
    expect(await settledRun(a)).toMatchObject({ status: "refused", refusedReason: "no_coding_key" });
    await lineCount(kyleTeam, 1);
    expect((await lines(kyleTeam))[0]).toBe(CODING_LINES.noKey);
    expect(CODING_LINES.noKey).toContain("Create the Coding key on Settings → Agent keys (Agent: Claude Code) and tick Allow writes");

    const off = await mintCoding({ writesEnabled: false });
    const b = await fieldPost(kyle, kyleTeam, "@Coding two");
    expect(await settledRun(b)).toMatchObject({ status: "refused", refusedReason: "no_coding_key" });
    await lineCount(kyleTeam, 2);
    expect((await lines(kyleTeam))[1]).toBe(CODING_LINES.writesOff);

    await prisma.agentKey.update({ where: { id: off.id }, data: { writesEnabled: true, scopes: ["team:read"] } });
    const c = await fieldPost(kyle, kyleTeam, "@Coding three");
    expect(await settledRun(c)).toMatchObject({ status: "refused", refusedReason: "no_coding_key" });
    await lineCount(kyleTeam, 3);
    expect((await lines(kyleTeam))[2]).toBe(CODING_LINES.keyScopes);
    expect(ghCalls).toHaveLength(0);
    expect((await auditFor(kyleTeam)).map((a) => a.action)).toEqual(["coding_refused", "coding_refused", "coding_refused"]);
  });

  it("a GROUP chat needs Claude Code to be a member: refused with \"Add Claude Code to this group\", then dispatched once it is added", async () => {
    const created = await request(app).post("/hub/groups").set(bearer(pinToken)).send({ name: `${TAG} Install crew`, technicianIds: [kyle.id], agentKeyIds: [] });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const groupId = (created.body.thread?.id ?? created.body.id) as string;
    expect(groupId).toBeTruthy();

    const a = await fieldPost(kyle, groupId, "@Coding in the group");
    expect(await settledRun(a)).toMatchObject({ status: "refused", refusedReason: "not_a_member" });
    await lineCount(groupId, 1);
    expect((await lines(groupId))[0]).toContain("Add Claude Code to this group");
    expect(ghCalls).toHaveLength(0);

    const added = await request(app).post(`/hub/groups/${groupId}/members`).set(bearer(pinToken)).send({ technicianIds: [], agentKeyIds: [codingKey.id] });
    expect(added.status, JSON.stringify(added.body)).toBeLessThan(300);
    const b = await fieldPost(kyle, groupId, "@Coding now it is in");
    expect((await settledRun(b)).status).toBe("dispatched");
    expect(ghCalls).toHaveLength(1);
  });

  it("a job's crew chat works too, and the customer's own address in the text is withheld", async () => {
    const customer = await prisma.customer.create({
      data: { name: `${TAG} Jane`, properties: { create: { name: "Home", addressLine1: "88 Cedar Hollow Court", city: "Smyrna", state: "TN", postalCode: "37167" } } },
    });
    const property = await prisma.property.findFirstOrThrow({ where: { customerId: customer.id } });
    const visit = await prisma.visit.create({ data: { customerId: customer.id, propertyId: property.id, mode: "service_diagnostic", purpose: `${TAG} job`, status: "contracted" } });
    const thread = await prisma.hubThread.create({ data: { kind: "job", title: `${TAG} crew chat`, visitId: visit.id } });
    try {
      const id = await pinPost(thread.id, "@Coding the panel at 88 Cedar Hollow Court needs a label template");
      expect((await settledRun(id)).status).toBe("dispatched");
      expect(String(ghCalls[0].payload.client_payload.text)).not.toContain("88 Cedar Hollow Court");
      expect(String(ghCalls[0].payload.client_payload.text)).toContain("needs a label template");
    } finally {
      await prisma.codingRun.deleteMany({ where: { threadId: thread.id } });
      await prisma.hubThread.delete({ where: { id: thread.id } });
      await prisma.visit.delete({ where: { id: visit.id } });
      await prisma.property.deleteMany({ where: { customerId: customer.id } });
      await prisma.customer.delete({ where: { id: customer.id } });
    }
  });
});

// ── a failed dispatch ────────────────────────────────────────────────────────────────────────────
describe("a dispatch that fails says so in fixed words and leaks nothing", () => {
  async function everythingStored(): Promise<string> {
    const [runs, messages, audit, events] = await Promise.all([
      prisma.codingRun.findMany(), prisma.hubMessage.findMany({ where: { threadId: { in: [kyleTeam, michaelTeam, ericTeam] } } }),
      prisma.hubAuditLog.findMany({ where: { action: { startsWith: "coding_" } } }),
      prisma.systemEvent.findMany({ where: { createdAt: { gt: new Date(Date.now() - 5 * 60_000) } } }),
    ]);
    return JSON.stringify({ runs, messages, audit, events });
  }

  it("GitHub answers 401: the status number is kept, the body and the token are not, and the next ask can retry", async () => {
    const logged: string[] = [];
    for (const m of ["log", "warn", "error", "info"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(" ")); });
    ghAnswer = () => new Response(`{"message":"Bad credentials for ${DISPATCH_TOKEN}"}`, { status: 401 });
    const id = await fieldPost(kyle, kyleTeam, "@Coding secret request text zzqq");
    expect(await settledRun(id)).toMatchObject({ status: "dispatch_failed", githubStatus: 401 });
    await lineCount(kyleTeam, 1);
    expect(await lines(kyleTeam)).toEqual(["Claude Code could not be started (GitHub answered 401)."]);
    const audit = await auditFor(kyleTeam);
    expect(audit.map((a) => a.action)).toEqual(["coding_requested", "coding_dispatch_failed"]);
    expect(JSON.parse(audit[1].detailsJson ?? "{}")).toEqual({ runId: (await runFor(id))!.id, threadId: kyleTeam, githubStatus: 401 });
    const stored = await everythingStored();
    expect(stored).not.toContain(DISPATCH_TOKEN);
    expect(stored).not.toContain("Bad credentials");
    expect(logged.join("\n")).not.toContain(DISPATCH_TOKEN);
    // A failed run is not open: asking again goes out.
    ghAnswer = () => new Response(null, { status: 204 });
    expect((await settledRun(await fieldPost(kyle, kyleTeam, "@Coding retry"))).status).toBe("dispatched");
  });

  it("a network error whose own text carries the token: fixed words, no token anywhere", async () => {
    const logged: string[] = [];
    for (const m of ["log", "warn", "error", "info"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(" ")); });
    ghAnswer = () => { throw new Error(`connect ECONNRESET Authorization: Bearer ${DISPATCH_TOKEN}`); };
    const id = await fieldPost(kyle, kyleTeam, "@Coding network");
    expect(await settledRun(id)).toMatchObject({ status: "dispatch_failed", githubStatus: null });
    await lineCount(kyleTeam, 1);
    expect(await lines(kyleTeam)).toEqual(["Claude Code could not be started (GitHub could not be reached)."]);
    expect(await everythingStored()).not.toContain(DISPATCH_TOKEN);
    expect(logged.join("\n")).not.toContain(DISPATCH_TOKEN);
  });

  it("GITHUB_DISPATCH_TOKEN not set on Railway: no call is made and the line says which variable", async () => {
    delete process.env.GITHUB_DISPATCH_TOKEN;
    const id = await fieldPost(kyle, kyleTeam, "@Coding no token");
    expect(await settledRun(id)).toMatchObject({ status: "dispatch_failed", githubStatus: null });
    await lineCount(kyleTeam, 1);
    expect(await lines(kyleTeam)).toEqual(["Claude Code could not be started (GITHUB_DISPATCH_TOKEN is not set on Railway)."]);
    expect(ghCalls).toHaveLength(0);
  });
});

// ── the answer ───────────────────────────────────────────────────────────────────────────────────
describe("Coding's reply closes the run", () => {
  it("a reply through POST /api/hub/messages with a pull request link: run replied, prUrl and branch recorded, the reply is posted, and its own @Coding starts nothing", async () => {
    const id = await fieldPost(kyle, kyleTeam, "@Coding add a comment to the README saying hub test");
    const run = await settledRun(id);
    expect(run.status).toBe("dispatched");
    const pr = `https://github.com/${GITHUB_CODING_REPO}/pull/123`;
    // The workflow's real reply format (.github/workflows/hub-coding.yml): the run on the first line, then the pull request and the branch.
    const reply = await agentPost(codingKey.secret, kyleTeam, `Claude Code run ${run.id}\n\nPull request: ${pr}\nBranch: hub/coding-${run.id}\n\nAsk @Coding again if you want changes.`);
    expect(reply.status, JSON.stringify(reply.body)).toBe(201);
    expect(reply.body.status).toBe("posted"); // teamPostsPublish: no Approve needed

    const closed = await vi.waitFor(async () => {
      const r = await prisma.codingRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(r.status).toBe("replied");
      return r;
    }, { timeout: 8000, interval: 50 });
    expect(closed).toMatchObject({ prUrl: pr, branch: `hub/coding-${run.id}`, replyMessageId: reply.body.messageId });
    expect(closed.finishedAt).not.toBeNull();
    const audit = await auditFor(kyleTeam);
    expect(audit.map((a) => a.action)).toEqual(["coding_requested", "coding_dispatched", "coding_replied"]);
    expect(audit[2].actorDisplay).toContain("Coding");

    await quiet();
    expect(await prisma.codingRun.count({ where: { threadId: kyleTeam } })).toBe(1); // its "@Coding" asked nothing
    expect(ghCalls).toHaveLength(1);
    // The person reads the reply on the phone.
    const read = await request(app).get(`/health-record/hub/threads/${kyleTeam}/messages`).set(bearer(kyle.token));
    const bodies = (read.body.data.messages as Array<{ body: string }>).map((m) => m.body);
    expect(bodies.some((b) => b.includes(pr))).toBe(true);
  });

  it("a link to some OTHER repository is not recorded as the pull request", async () => {
    const id = await fieldPost(kyle, kyleTeam, "@Coding anything");
    const run = await settledRun(id);
    await agentPost(codingKey.secret, kyleTeam, `Claude Code run ${run.id}\n\nSee https://github.com/someone-else/elsewhere/pull/9 for ideas.`);
    const closed = await vi.waitFor(async () => {
      const r = await prisma.codingRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(r.status).toBe("replied");
      return r;
    }, { timeout: 8000, interval: 50 });
    expect(closed.prUrl).toBeNull();
  });
});

// ── the reply is matched to its run (review fix: a late answer from a cancelled run must not close the next one) ──
describe("a reply closes ONLY the run it names", () => {
  const prOf = (n: number) => `https://github.com/${GITHUB_CODING_REPO}/pull/${n}`;

  it("cancel A, ask B, then A's late reply arrives: B stays open with no pull request, a third @Coding is still told one is running, and B's own reply closes B", async () => {
    const a = await settledRun(await fieldPost(kyle, kyleTeam, "@Coding request A"));
    await fieldPost(kyle, kyleTeam, "@Coding cancel");
    await lineCount(kyleTeam, 2);
    expect(await prisma.codingRun.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ status: "cancelled" });
    const b = await settledRun(await fieldPost(kyle, kyleTeam, "@Coding request B"));
    expect(b.status).toBe("dispatched");

    // A's GitHub job (the cancel line warns it may still finish) posts its answer.
    const late = await agentPost(codingKey.secret, kyleTeam, `Claude Code run ${a.id}\n\nPull request: ${prOf(41)}\nBranch: hub/coding-${a.id}\n\nDone.`);
    expect(late.status, JSON.stringify(late.body)).toBe(201);
    await quiet();
    expect(await prisma.codingRun.findUniqueOrThrow({ where: { id: b.id } })).toMatchObject({ status: "dispatched", prUrl: null, branch: null, replyMessageId: null });
    expect(await prisma.codingRun.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ status: "cancelled", prUrl: null }); // a cancelled run stays cancelled

    // The thread still has ONE open run, so a third ask is refused and sends nothing.
    const c = await fieldPost(kyle, kyleTeam, "@Coding request C");
    expect(await settledRun(c)).toMatchObject({ status: "refused", refusedReason: "already_running" });
    expect(ghCalls).toHaveLength(2); // A and B only

    // B's own reply closes B with B's own pull request.
    const own = await agentPost(codingKey.secret, kyleTeam, `Claude Code run ${b.id}\n\nPull request: ${prOf(42)}\nBranch: hub/coding-${b.id}`);
    await vi.waitFor(async () => {
      expect(await prisma.codingRun.findUniqueOrThrow({ where: { id: b.id } })).toMatchObject({
        status: "replied", prUrl: prOf(42), branch: `hub/coding-${b.id}`, replyMessageId: own.body.messageId,
      });
    }, { timeout: 8000, interval: 50 });
    const audit = (await auditFor(kyleTeam)).filter((x) => x.action === "coding_replied");
    expect(audit).toHaveLength(1); // only B's reply was recorded as a reply
    expect(JSON.parse(audit[0].detailsJson ?? "{}").runId).toBe(b.id);
  });

  it("a reply that names no run (a hand-written post), or only mentions a run further down the text, closes nothing; a run in ANOTHER thread cannot be closed from here", async () => {
    const run = await settledRun(await fieldPost(kyle, kyleTeam, "@Coding anything"));
    await agentPost(codingKey.secret, kyleTeam, `Pull request: ${prOf(7)} (no run named)`);
    await agentPost(codingKey.secret, kyleTeam, `All done.
Claude Code run ${run.id}
not on the first line`);
    await quiet();
    expect(await prisma.codingRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ status: "dispatched", prUrl: null });
    // Naming a run that belongs to a different conversation changes nothing here.
    const trigger = await prisma.hubMessage.create({
      data: { threadId: michaelTeam, authorType: "office", authorKey: "owner", authorDisplay: "Kyle", channel: "in_app", direction: "internal", status: "posted", body: "@Coding in another thread" },
    });
    const elsewhere = await prisma.codingRun.create({
      data: { threadId: michaelTeam, triggerMessageId: trigger.id, requestedByKey: "owner", requestedByDisplay: "Kyle", status: "dispatched", dispatchedAt: new Date() },
    });
    await agentPost(codingKey.secret, kyleTeam, `Claude Code run ${elsewhere.id}

Pull request: ${prOf(8)}`);
    await quiet();
    expect(await prisma.codingRun.findUniqueOrThrow({ where: { id: elsewhere.id } })).toMatchObject({ status: "dispatched", prUrl: null });
  });

  it("an approver's edit-approved copy of Coding's own draft closes the run too (the key's Team posts publish immediately is off), even when the edit dropped the run line; no 'did not answer' follows", async () => {
    const draftKey = await mintAgentKey({ name: `${TAG} CodingDraft`, agentRole: "claude_code", createdBy: "owner", writesEnabled: true, teamPostsPublish: false });
    keyIds.push(draftKey.row.id);
    const run = await settledRun(await fieldPost(kyle, kyleTeam, "@Coding make a small change"));
    const made = await agentPost(draftKey.key, kyleTeam, `Claude Code run ${run.id}\n\nPull request: ${prOf(55)}\nBranch: hub/coding-${run.id}`);
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body.status).toBe("pending_approval");
    await quiet();
    expect((await prisma.codingRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe("dispatched"); // a draft closes nothing

    const edited = await request(app).post(`/hub/messages/${made.body.messageId}/edit-approve`).set(bearer(pinToken))
      .send({ body: `I opened ${prOf(55)} for you. Branch hub/coding-${run.id}.` }); // the edit dropped the run line
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    const closed = await vi.waitFor(async () => {
      const r = await prisma.codingRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(r.status).toBe("replied");
      return r;
    }, { timeout: 8000, interval: 50 });
    const copy = await prisma.hubMessage.findFirstOrThrow({ where: { threadId: kyleTeam, editedFromId: made.body.messageId } });
    expect(closed).toMatchObject({ prUrl: prOf(55), branch: `hub/coding-${run.id}`, replyMessageId: copy.id });
    const replied = (await auditFor(kyleTeam)).filter((x) => x.action === "coding_replied");
    expect(replied).toHaveLength(1);
    expect(replied[0].actorDisplay).toContain("CodingDraft"); // the Coding key, not the approver
    // An hour later the sweep has nothing to close and says nothing.
    expect(await sweepCodingRuns(prisma, new Date(Date.now() + CODING_RUN_TIMEOUT_MS + 60_000))).toBe(0);
    expect((await lines(kyleTeam)).some((l) => l === CODING_LINES.timedOut)).toBe(false);
  });
});

// ── the owner's kill switch (review fix) ─────────────────────────────────────────────────────────
describe("Agent access Off or Read only: the request is refused up front, naming where to turn it on", () => {
  for (const mode of ["off", "read_only"] as const) {
    it(`Agent access ${mode}: no run is dispatched, the thread says so, GitHub hears nothing, and turning it On works again`, async () => {
      await prisma.companySetting.create({ data: { key: "agentAccess", valueJson: JSON.stringify({ mode, changedAt: null, changedBy: null }) } });
      const id = await fieldPost(kyle, kyleTeam, "@Coding please change something");
      expect(await settledRun(id)).toMatchObject({ status: "refused", refusedReason: "agents_not_on" });
      await lineCount(kyleTeam, 1);
      expect((await lines(kyleTeam))[0]).toBe(CODING_LINES.agentAccessNotOn);
      expect(CODING_LINES.agentAccessNotOn).toContain("Settings → Agent keys");
      expect((await auditFor(kyleTeam)).map((a) => a.action)).toEqual(["coding_refused"]);
      expect(ghCalls).toHaveLength(0);

      await prisma.companySetting.deleteMany({ where: { key: "agentAccess" } }); // no row = On
      expect((await settledRun(await fieldPost(kyle, kyleTeam, "@Coding try again"))).status).toBe("dispatched");
      expect(ghCalls).toHaveLength(1);
    });
  }
});


// ── small pieces ─────────────────────────────────────────────────────────────────────────────────
describe("the pieces", () => {
  it("isCancelRequest: the word cancel once the @Coding mention is taken out, any case, trimmed, and nothing else", () => {
    for (const yes of ["@Coding cancel", "  @coding   CANCEL  ", "cancel @Coding", "@Coding\ncancel"]) expect(isCancelRequest(yes), yes).toBe(true);
    for (const no of ["@Coding cancel the invoice change", "@Coding", "@Coding cancelled", "@Coding please cancel", "@Admin cancel"]) expect(isCancelRequest(no), no).toBe(false);
  });

  it("the request text is cut at 20,000 characters and the payload says so", async () => {
    const row = await prisma.hubMessage.create({
      data: {
        threadId: kyleTeam, authorType: "office", authorKey: "owner", authorDisplay: "Kyle", channel: "in_app", direction: "internal", status: "posted",
        body: `@Coding ${"word ".repeat(5000)}`,
      },
    });
    await handleCodingRequest(row.id, prisma);
    expect(ghCalls).toHaveLength(1);
    const text = String(ghCalls[0].payload.client_payload.text);
    expect(text.length).toBe(CODING_TEXT_CAP + CODING_TEXT_CUT_NOTE.length);
    expect(text.endsWith(CODING_TEXT_CUT_NOTE)).toBe(true);
    // Handing the same message in again is a no-op (one run per message).
    await handleCodingRequest(row.id, prisma);
    expect(ghCalls).toHaveLength(1);
    expect(await prisma.codingRun.count({ where: { triggerMessageId: row.id } })).toBe(1);
  });
});
