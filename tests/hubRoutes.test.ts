/**
 * The CRM's Messages routes (work order agent-team, U2 and U3): routes/hub.ts.
 *
 * Pinned here: the timeline asks for exactly one record; the thread list, its filters and unread counts;
 * read state and the badge arithmetic; posting to a job and a Team thread (and NOT to a customer thread,
 * which has one writer per kind of thing); an own message edits and deletes, someone else's does not
 * (except for Kyle) and a deleted one leaves a mark with its reason; rename and Close thread / Reopen;
 * there is NO route to make or delete a Team thread (team answer 9a); "Needs approval" and who can act;
 * no technician token in any hub response; and a technician's bearer token never reaches the routes.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

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
import { hashPin } from "../src/middleware/pinAuth";
import { createMessageRow, ensureTeamThread, ensureThreadFor } from "../src/services/hub";
import { saveCrmLogin, setPrincipal } from "../src/services/crmLogin";

const TAG = "HubRoutes";
const TOKEN = "hubroutes-secret-access-token-9f3a";
const techIds: string[] = [];

async function wipe() {
  // A login holds its person (onDelete Restrict): remove this file's logins before the people.
  await prisma.crmLogin.deleteMany({ where: { technicianId: { in: techIds } } });
  const customers = await prisma.customer.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
  const ids = customers.map((c) => c.id);
  await prisma.hubThread.deleteMany({ where: { OR: [{ title: { startsWith: TAG } }, { customerId: { in: ids } }, { technicianId: { in: techIds } }] } });
  if (ids.length > 0) {
    await prisma.visit.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.property.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.customer.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.technician.deleteMany({ where: { id: { in: techIds.splice(0) } } });
  await prisma.agentKey.deleteMany({ where: { name: { startsWith: TAG } } });
}
beforeAll(wipe);
beforeEach(wipe);
afterAll(wipe);

async function makeAccount(suffix: string) {
  const customer = await prisma.customer.create({
    data: { name: `${TAG} ${suffix}`, properties: { create: { name: "Home", addressLine1: "12 Main St", city: "Smyrna", state: "TN", postalCode: "37167" } } },
    include: { properties: true },
  });
  const visit = await prisma.visit.create({ data: { customerId: customer.id, propertyId: customer.properties[0]!.id, mode: "service_call", jobType: "Panel upgrade" } });
  return { customer, visit };
}

async function makeTech(name: string) {
  const t = await prisma.technician.create({ data: { name: `${TAG} ${name}`, accessToken: TOKEN + Math.random().toString(36).slice(2) } });
  techIds.push(t.id);
  return t;
}

/** A message from somebody other than the signed-in owner. */
async function fromTech(threadId: string, techId: string, body: string, over: Record<string, unknown> = {}) {
  return createMessageRow(prisma, {
    threadId, authorType: "tech", authorKey: `tech:${techId}`, authorTechnicianId: techId, authorDisplay: "Eric",
    channel: "in_app", direction: "internal", status: "posted", body, ...over,
  });
}

describe("GET /hub/timeline", () => {
  it("wants exactly one record", async () => {
    expect((await request(app).get("/hub/timeline")).status).toBe(400);
    expect((await request(app).get("/hub/timeline?customerId=a&visitId=b")).status).toBe(400);
  });

  it("answers for an account, 404s for one that is not there", async () => {
    const { customer } = await makeAccount("Timeline");
    const ok = await request(app).get(`/hub/timeline?customerId=${customer.id}`);
    expect(ok.status).toBe(200);
    expect(ok.body.scope.customerId).toBe(customer.id);
    expect(Array.isArray(ok.body.entries)).toBe(true);
    expect((await request(app).get("/hub/timeline?customerId=nope")).status).toBe(404);
  });
});

describe("the Messages list, read state and the badge", () => {
  it("lists a thread once somebody has spoken in it, with unread, and clears it when read", async () => {
    const { visit } = await makeAccount("List");
    const eric = await makeTech("Eric");
    const open = await request(app).post(`/hub/threads/job/${visit.id}`);
    expect(open.status).toBe(200);
    const threadId = open.body.id as string;
    expect(open.body.id).toBe((await request(app).post(`/hub/threads/job/${visit.id}`)).body.id);

    // An empty thread is not on the page.
    let list = await request(app).get("/hub/threads?kind=job");
    expect(list.body.threads.some((t: { id: string }) => t.id === threadId)).toBe(false);

    await fromTech(threadId, eric.id, "On site, panel is open.");
    list = await request(app).get("/hub/threads?kind=job");
    const row = list.body.threads.find((t: { id: string }) => t.id === threadId);
    expect(row).toMatchObject({ kind: "job", unread: 1, pending: 0, aiLast: false });
    expect(row.lastLine).toMatchObject({ authorDisplay: "Eric", text: "On site, panel is open." });

    const badge = await request(app).get("/hub/badge");
    expect(badge.status).toBe(200);
    expect(badge.body.unread).toBeGreaterThanOrEqual(1);
    expect(badge.body.total).toBe(badge.body.unread + (badge.body.canApprove ? badge.body.needsApproval : 0));

    // Opening the thread reads it.
    const detail = await request(app).get(`/hub/threads/${threadId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.lastReadAt).toBeNull();
    expect((await request(app).post(`/hub/threads/${threadId}/read`)).status).toBe(204);
    const after = await request(app).get(`/hub/threads/${threadId}`);
    expect(after.body.thread.unread).toBe(0);
    expect(after.body.lastReadAt).not.toBeNull();
  });

  it("filters by kind, by search and by closed, and finds words said inside a thread", async () => {
    const { visit, customer } = await makeAccount("Filters");
    const eric = await makeTech("Eric");
    const jobThread = await ensureThreadFor({ visitId: visit.id });
    const customerThread = await ensureThreadFor({ customerId: customer.id });
    await fromTech(jobThread.id, eric.id, "Need a 200 amp meter base");
    await fromTech(customerThread.id, eric.id, "Customer wants Tuesday");

    const ids = async (qs: string) => ((await request(app).get(`/hub/threads?${qs}`)).body.threads as Array<{ id: string }>).map((t) => t.id);
    expect(await ids("kind=job")).toContain(jobThread.id);
    expect(await ids("kind=job")).not.toContain(customerThread.id);
    expect(await ids("kind=customer")).toContain(customerThread.id);
    expect(await ids("q=meter%20base")).toEqual([jobThread.id]);
    expect(await ids(`q=${encodeURIComponent(TAG + " Filters")}`)).toEqual(expect.arrayContaining([jobThread.id, customerThread.id]));
    expect((await request(app).get("/hub/threads?kind=bogus")).status).toBe(400);
    expect((await request(app).get("/hub/threads?status=bogus")).status).toBe(400);

    // Close thread takes it off the default list; "all" and "closed" bring it back; Reopen restores it.
    expect((await request(app).patch(`/hub/threads/${jobThread.id}`).send({ status: "closed" })).status).toBe(200);
    expect(await ids("kind=job")).not.toContain(jobThread.id);
    expect(await ids("kind=job&status=all")).toContain(jobThread.id);
    expect(await ids("kind=job&status=closed")).toContain(jobThread.id);
    expect((await request(app).patch(`/hub/threads/${jobThread.id}`).send({ status: "open" })).status).toBe(200);
    expect(await ids("kind=job")).toContain(jobThread.id);
  });
});

describe("posting, editing and deleting", () => {
  it("posts to a job thread and a Team thread, never into a customer thread", async () => {
    const { visit, customer } = await makeAccount("Post");
    const kyle = await makeTech("Kyle");
    const job = await ensureThreadFor({ visitId: visit.id });
    const team = await ensureTeamThread(kyle.id);
    const customerThread = await ensureThreadFor({ customerId: customer.id });
    // Kyle's session (no sign-in gate here) posts as his principal login's person, so his own Team thread takes it.
    await setPrincipal((await saveCrmLogin(kyle.id, { username: `hr_post_${Math.random().toString(36).slice(2, 8)}`, role: "owner", password: "correct horse battery" })).id);

    for (const id of [job.id, team.id]) {
      const r = await request(app).post(`/hub/threads/${id}/messages`).send({ body: "  Hello crew  " });
      expect(r.status).toBe(201);
    }
    const detail = await request(app).get(`/hub/threads/${job.id}`);
    expect(detail.body.messages).toHaveLength(1);
    expect(detail.body.messages[0]).toMatchObject({ body: "Hello crew", mine: true, canEdit: true, canDelete: true, authorType: "office" });

    // A customer conversation takes a call note or an email: one writer for each.
    const refused = await request(app).post(`/hub/threads/${customerThread.id}/messages`).send({ body: "hi" });
    expect(refused.status).toBe(409);
    expect(await prisma.hubMessage.count({ where: { threadId: customerThread.id } })).toBe(0);

    expect((await request(app).post(`/hub/threads/${job.id}/messages`).send({ body: "   " })).status).toBe(400);
    expect((await request(app).post("/hub/threads/nope/messages").send({ body: "x" })).status).toBe(404);
  });

  it("edits your own message and refuses someone else's; edits show as edited", async () => {
    const { visit } = await makeAccount("Edit");
    const eric = await makeTech("Eric");
    const job = await ensureThreadFor({ visitId: visit.id });
    const mine = (await request(app).post(`/hub/threads/${job.id}/messages`).send({ body: "First try" })).body.id as string;
    const theirs = (await fromTech(job.id, eric.id, "Eric's words")).id;

    const edited = await request(app).patch(`/hub/messages/${mine}`).send({ body: "Second try" });
    expect(edited.status).toBe(200);
    expect(edited.body.editedAt).not.toBeNull();
    expect((await request(app).patch(`/hub/messages/${theirs}`).send({ body: "Rewritten" })).status).toBe(403);
    expect((await prisma.hubMessage.findUniqueOrThrow({ where: { id: theirs } })).body).toBe("Eric's words");
    const audit = await prisma.hubAuditLog.findFirst({ where: { action: "message_edited", messageId: mine } });
    expect(audit).toMatchObject({ beforeText: "First try", afterText: "Second try" });

    const detail = await request(app).get(`/hub/threads/${job.id}`);
    const rows = detail.body.messages as Array<{ id: string; canEdit: boolean; mine: boolean }>;
    expect(rows.find((m) => m.id === theirs)).toMatchObject({ mine: false, canEdit: false });
  });

  it("deletes with a reason and leaves a mark; Kyle may delete anyone's", async () => {
    const { visit } = await makeAccount("Delete");
    const eric = await makeTech("Eric");
    const job = await ensureThreadFor({ visitId: visit.id });
    const mine = (await request(app).post(`/hub/threads/${job.id}/messages`).send({ body: "Oops wrong job" })).body.id as string;
    const theirs = (await fromTech(job.id, eric.id, "Eric says so")).id;

    expect((await request(app).delete(`/hub/messages/${mine}`).send({})).status).toBe(400);
    expect((await request(app).delete(`/hub/messages/${mine}`).send({ reason: "Wrong job" })).status).toBe(204);
    expect((await request(app).delete(`/hub/messages/${theirs}`).send({ reason: "Not for the crew" })).status).toBe(204);

    const detail = await request(app).get(`/hub/threads/${job.id}`);
    const rows = detail.body.messages as Array<{ id: string; deleted: boolean; body: string | null; deletedBy: string | null; deletedReason: string | null; canEdit: boolean; canDelete: boolean }>;
    const gone = rows.find((m) => m.id === mine)!;
    expect(gone).toMatchObject({ deleted: true, body: null, deletedBy: "Kyle", deletedReason: "Wrong job", canEdit: false, canDelete: false });
    expect(JSON.stringify(detail.body)).not.toContain("Oops wrong job");
    // the text is kept in the audit, not on the screen
    expect((await prisma.hubAuditLog.findFirst({ where: { action: "message_deleted", messageId: mine } }))?.beforeText).toBe("Oops wrong job");
  });
});

describe("threads: rename, close, and no way to make or delete a Team thread", () => {
  it("renames a thread and writes the old name to the audit", async () => {
    const kyle = await makeTech("Kyle");
    const team = await ensureTeamThread(kyle.id);
    const r = await request(app).patch(`/hub/threads/${team.id}`).send({ title: `${TAG} Kyle and the team` });
    expect(r.status).toBe(200);
    expect(r.body.thread.title).toBe(`${TAG} Kyle and the team`);
    expect((await prisma.hubAuditLog.findFirst({ where: { action: "thread_renamed", threadId: team.id } }))?.beforeText).toBe(`${TAG} Kyle ↔ AI team`);
    expect((await request(app).patch(`/hub/threads/${team.id}`).send({ title: "  " })).status).toBe(400);
    expect((await request(app).patch(`/hub/threads/${team.id}`).send({})).status).toBe(400);
  });

  it("has no route to create a Team thread or delete any thread", async () => {
    const kyle = await makeTech("Kyle");
    const team = await ensureTeamThread(kyle.id);
    const created = await request(app).post("/hub/threads").send({ kind: "team", title: "Mine" });
    expect(created.status).toBeGreaterThanOrEqual(400);
    expect(created.status).toBeLessThan(500);
    const removed = await request(app).delete(`/hub/threads/${team.id}`);
    expect(removed.status).toBeGreaterThanOrEqual(400);
    expect(removed.status).toBeLessThan(500);
    expect(await prisma.hubThread.count({ where: { id: team.id } })).toBe(1);
    // a second ensure for the same person gives the same thread
    expect((await ensureTeamThread(kyle.id)).id).toBe(team.id);
  });
});

describe("Needs approval", () => {
  it("lists what is waiting, counts it, and adds it to the badge for someone who can approve", async () => {
    const { visit } = await makeAccount("Approval");
    const job = await ensureThreadFor({ visitId: visit.id });
    await createMessageRow(prisma, {
      threadId: job.id, authorType: "ai_agent", authorKey: "agent:key1", authorDisplay: "RCE Admin", channel: "in_app", direction: "internal",
      status: "pending_approval", body: "Draft: we can start Monday.",
    });
    const before = await request(app).get("/hub/threads?needs=approval");
    const row = (before.body.threads as Array<{ id: string; pending: number; aiLast: boolean }>).find((t) => t.id === job.id);
    expect(row).toMatchObject({ pending: 1, aiLast: true });
    expect(before.body.needsApproval).toBeGreaterThanOrEqual(1);
    expect(before.body.canApprove).toBe(true);

    // a draft waiting is not an unread message; it is counted once, as an approval
    const detail = await request(app).get(`/hub/threads/${job.id}`);
    expect(detail.body.thread.unread).toBe(0);
    expect(detail.body.messages[0]).toMatchObject({ status: "pending_approval", canEdit: false });

    const badge = (await request(app).get("/hub/badge")).body;
    expect(badge.total).toBe(badge.unread + badge.needsApproval);
    // not shown on the plain "Customers" chip's kind filter
    const jobsOnly = await request(app).get("/hub/threads?kind=customer&needs=approval");
    expect((jobsOnly.body.threads as Array<{ id: string }>).some((t) => t.id === job.id)).toBe(false);
  });
});

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const teamEvents = (threadId: string) => prisma.hubEvent.findMany({ where: { type: "message.team", payloadJson: { contains: threadId } } });

describe("a closed thread and the counts", () => {
  it("a message landing in a closed thread reopens it, and the audit says why", async () => {
    const { visit } = await makeAccount("Reopen");
    const job = await ensureThreadFor({ visitId: visit.id });
    expect((await request(app).patch(`/hub/threads/${job.id}`).send({ status: "closed" })).status).toBe(200);
    expect((await prisma.hubThread.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("closed");

    expect((await request(app).post(`/hub/threads/${job.id}/messages`).send({ body: "Still on this one" })).status).toBe(201);
    expect((await prisma.hubThread.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("open");
    const audits = await prisma.hubAuditLog.findMany({ where: { action: "thread_status", threadId: job.id }, orderBy: { at: "asc" } });
    expect(audits.map((a) => [a.beforeText, a.afterText])).toEqual([["open", "closed"], ["closed", "open"]]);
    expect(JSON.parse(audits[1]!.detailsJson ?? "{}").reason).toBe("message_arrived");
    const list = await request(app).get("/hub/threads?kind=job");
    expect((list.body.threads as Array<{ id: string }>).some((t) => t.id === job.id)).toBe(true);
  });

  it("the badge does not count unread messages in a closed thread, because the list does not show them", async () => {
    const { visit } = await makeAccount("Badge");
    const eric = await makeTech("Eric");
    const job = await ensureThreadFor({ visitId: visit.id });
    const base = (await request(app).get("/hub/badge")).body.unread as number;

    await fromTech(job.id, eric.id, "Two quick things");
    await fromTech(job.id, eric.id, "And a second");
    expect((await request(app).get("/hub/badge")).body.unread).toBe(base + 2);

    expect((await request(app).patch(`/hub/threads/${job.id}`).send({ status: "closed" })).status).toBe(200);
    expect((await request(app).get("/hub/badge")).body.unread).toBe(base);
    const shown = await request(app).get("/hub/threads");
    expect((shown.body.threads as Array<{ id: string }>).some((t) => t.id === job.id)).toBe(false);
    // The closed thread still keeps its own unread number when somebody ticks "Show closed threads".
    const closed = await request(app).get("/hub/threads?status=closed");
    expect((closed.body.threads as Array<{ id: string; unread: number }>).find((t) => t.id === job.id)?.unread).toBe(2);
  });

  it("'Needs approval' lists a draft whose thread was closed, and its count equals the rows it lists", async () => {
    const { visit } = await makeAccount("ClosedApproval");
    const job = await ensureThreadFor({ visitId: visit.id });
    await createMessageRow(prisma, {
      threadId: job.id, authorType: "ai_agent", authorKey: "agent:key1", authorDisplay: "RCE Admin", channel: "in_app", direction: "internal",
      status: "pending_approval", body: "Draft: we can start Monday.",
    });
    expect((await request(app).patch(`/hub/threads/${job.id}`).send({ status: "closed" })).status).toBe(200);

    // the default view of the queue ("open") and the page's explicit ones all show it
    for (const qs of ["needs=approval", "needs=approval&status=open", "needs=approval&status=all"]) {
      const r = await request(app).get(`/hub/threads?${qs}`);
      const rows = r.body.threads as Array<{ id: string; pending: number }>;
      expect(rows.some((t) => t.id === job.id), qs).toBe(true);
      expect(rows.reduce((n, t) => n + t.pending, 0), qs).toBe(r.body.needsApproval);
    }
    const badge = (await request(app).get("/hub/badge")).body;
    expect(badge.needsApproval).toBeGreaterThanOrEqual(1);
    // ... while the plain list still hides the closed thread
    const plain = await request(app).get("/hub/threads");
    expect((plain.body.threads as Array<{ id: string }>).some((t) => t.id === job.id)).toBe(false);
  });
});

describe("a Team thread takes posts only from its own person", () => {
  let savedPin: string | undefined;
  beforeAll(async () => { savedPin = process.env.PIN_HASH; process.env.PIN_HASH = await hashPin("1234"); });
  afterAll(() => { if (savedPin === undefined) delete process.env.PIN_HASH; else process.env.PIN_HASH = savedPin; });

  const PASS = "correct horse battery";
  const signIn = async (username: string) => {
    const r = await request(app).post("/auth/login").send({ username, password: PASS });
    expect(r.status).toBe(200);
    return { Authorization: `Bearer ${r.body.token as string}` };
  };
  const pinHeader = async () => {
    const r = await request(app).post("/auth/pin").send({ pin: "1234" });
    expect(r.status).toBe(200);
    return { Authorization: `Bearer ${r.body.token as string}` };
  };
  const uname = (n: string) => `hr_${n}_${Math.random().toString(36).slice(2, 8)}`;

  it("another person's login can read Kyle's thread but not post in it: 403, no message, no message.team event", async () => {
    const kyle = await makeTech("Kyle");
    const michael = await makeTech("Michael");
    const kyleThread = await ensureTeamThread(kyle.id);
    const michaelThread = await ensureTeamThread(michael.id);
    const mName = uname("michael");
    await saveCrmLogin(michael.id, { username: mName, role: "office", password: PASS });
    const as = await signIn(mName);

    // W2-C: a team message wakes the agents whose KEY can read it (not "Admin whatever"), so a live Admin key is what makes the control mean something.
    await prisma.agentKey.create({
      data: { name: `${TAG} admin`, agentRole: "admin", environment: "test", displayPrefix: "rce_test_hubr", secretHash: `${TAG}-${Math.random().toString(36).slice(2)}`, scopes: ["team:read", "team:reply"], createdBy: "owner" },
    });
    // Positive control: his own thread takes the post and wakes the team (so the "none" below means something).
    expect((await request(app).post(`/hub/threads/${michaelThread.id}/messages`).set(as).send({ body: "My own question" })).status).toBe(201);
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && (await teamEvents(michaelThread.id)).length === 0) await pause(25);
    expect(await teamEvents(michaelThread.id)).toHaveLength(1);

    const read = await request(app).get(`/hub/threads/${kyleThread.id}`).set(as);
    expect(read.status).toBe(200);
    expect(read.body.postBlock).toBe(`This is ${kyle.name}'s thread with the AI team — you can read it, not post in it.`);
    const own = await request(app).get(`/hub/threads/${michaelThread.id}`).set(as);
    expect(own.body.postBlock).toBeNull();

    const refused = await request(app).post(`/hub/threads/${kyleThread.id}/messages`).set(as).send({ body: "Sneaking into Kyle's channel" });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toContain("you can read it, not post in it");
    await pause(300);
    expect(await prisma.hubMessage.count({ where: { threadId: kyleThread.id } })).toBe(0);
    expect(await teamEvents(kyleThread.id)).toHaveLength(0);
  });

  it("Kyle's PIN session posts as his principal login's person: in his own thread, not in another's", async () => {
    const kyle = await makeTech("Kyle");
    const michael = await makeTech("Michael");
    const kyleThread = await ensureTeamThread(kyle.id);
    const michaelThread = await ensureTeamThread(michael.id);
    const as = await pinHeader();

    // No principal login yet: the PIN session is tied to nobody, so it posts in no Team thread.
    const unattached = await request(app).post(`/hub/threads/${kyleThread.id}/messages`).set(as).send({ body: "Hello" });
    expect(unattached.status).toBe(403);
    expect(unattached.body.error).toContain("not tied to a person");
    expect((await request(app).get(`/hub/threads/${kyleThread.id}`).set(as)).body.postBlock).toContain("not tied to a person");

    const kName = uname("kyle");
    const login = await saveCrmLogin(kyle.id, { username: kName, role: "owner", password: PASS });
    await setPrincipal(login.id);
    expect((await request(app).post(`/hub/threads/${kyleThread.id}/messages`).set(as).send({ body: "Hello team" })).status).toBe(201);
    expect((await request(app).get(`/hub/threads/${kyleThread.id}`).set(as)).body.postBlock).toBeNull();
    const other = await request(app).post(`/hub/threads/${michaelThread.id}/messages`).set(as).send({ body: "In Michael's thread" });
    expect(other.status).toBe(403);
    expect(await prisma.hubMessage.count({ where: { threadId: michaelThread.id } })).toBe(0);

    // Kyle's principal login is the same person and gets the same answer.
    const asLogin = await signIn(kName);
    expect((await request(app).post(`/hub/threads/${kyleThread.id}/messages`).set(asLogin).send({ body: "Again" })).status).toBe(201);
    expect((await request(app).post(`/hub/threads/${michaelThread.id}/messages`).set(asLogin).send({ body: "No" })).status).toBe(403);
  });
});

describe("what the routes never say, and who never reaches them", () => {
  it("puts no technician access token in any hub response", async () => {
    const { visit, customer } = await makeAccount("Secrets");
    const eric = await makeTech("Eric");
    const job = await ensureThreadFor({ visitId: visit.id });
    const team = await ensureTeamThread(eric.id);
    await fromTech(job.id, eric.id, "Done here");
    await fromTech(team.id, eric.id, "Question for the team");
    const bodies = [
      (await request(app).get("/hub/threads?status=all")).body,
      (await request(app).get(`/hub/threads/${job.id}`)).body,
      (await request(app).get(`/hub/threads/${team.id}`)).body,
      (await request(app).get(`/hub/timeline?visitId=${visit.id}`)).body,
      (await request(app).get(`/hub/timeline?customerId=${customer.id}`)).body,
      (await request(app).get("/hub/badge")).body,
    ];
    for (const b of bodies) expect(JSON.stringify(b)).not.toContain(TOKEN);
  });

  describe("with the sign-in gate on", () => {
    let savedPin: string | undefined;
    beforeAll(async () => { savedPin = process.env.PIN_HASH; process.env.PIN_HASH = await hashPin("1234"); });
    afterAll(() => { if (savedPin === undefined) delete process.env.PIN_HASH; else process.env.PIN_HASH = savedPin; });

    it("refuses a visitor, and a technician's bearer token is not a CRM session", async () => {
      const eric = await makeTech("Eric");
      for (const path of ["/hub/threads", "/hub/badge", "/hub/timeline?customerId=x"]) {
        expect((await request(app).get(path)).status).toBe(401);
        expect((await request(app).get(path).set("Authorization", `Bearer ${eric.accessToken}`)).status).toBe(401);
      }
      expect((await request(app).post("/hub/threads/x/messages").send({ body: "hi" })).status).toBe(401);
    });

    it("lets Kyle's PIN session through, as Kyle", async () => {
      const login = await request(app).post("/auth/pin").send({ pin: "1234" });
      expect(login.status).toBe(200);
      const token = login.body.token as string;
      const badge = await request(app).get("/hub/badge").set("Authorization", `Bearer ${token}`);
      expect(badge.status).toBe(200);
      expect(badge.body.canApprove).toBe(true);
    });
  });
});
