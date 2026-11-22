/**
 * The field app's Messages (work order agent-team, U5): the technician's routes on healthRecordTechRouter
 * (routes/hubTechRoutes.ts + services/hubTech.ts), and the one photo store (services/hubAttachments.ts,
 * amendment 9b).
 *
 * Pinned here: a technician lists Team (made on first use), their own Training thread and the jobs they are
 * on - not another job; a job thread opens only for a job they are assigned to; a thread that is not theirs
 * (an unassigned job, a customer thread, another person's Team thread, any Dev thread) is a 403, never the
 * messages; they send, edit and delete their OWN messages, and the author reads as the technician's name; no
 * response ever carries an access token; a text or email to a customer in a job's thread is not shown or
 * counted, and an AI draft waiting for approval (Scout's, in Training) is hidden until approved; a Team photo is
 * held on its message as ONE HubAttachment, served only to people who may see the thread, and goes with its
 * message when the message is deleted; a job photo is the job's VisitPhoto and nothing else.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import sharp from "sharp";

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
import { createMessageRow, ensureTeamThread, ensureThreadFor } from "../src/services/hub";
import { saveCrmLogin, setPrincipal } from "../src/services/crmLogin";
import { hashPin } from "../src/middleware/pinAuth";

const TAG = "HubTech";
const techIds: string[] = [];

async function wipe() {
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
}
beforeAll(wipe);
beforeEach(wipe);
afterAll(wipe);

async function makeTech(name: string) {
  const t = await prisma.technician.create({ data: { name: `${TAG} ${name}`, accessToken: `hubtech-secret-${name}-${Math.random().toString(36).slice(2)}` } });
  techIds.push(t.id);
  return t;
}

async function makeJob(suffix: string, assignTo?: string) {
  const customer = await prisma.customer.create({
    data: { name: `${TAG} ${suffix}`, properties: { create: { name: "Home", addressLine1: "12 Main St", city: "Smyrna", state: "TN", postalCode: "37167" } } },
    include: { properties: true },
  });
  const visit = await prisma.visit.create({ data: { customerId: customer.id, propertyId: customer.properties[0]!.id, mode: "service_call", jobType: "Panel upgrade" } });
  if (assignTo) await prisma.visitAssignment.create({ data: { visitId: visit.id, technicianId: assignTo } });
  return { customer, visit };
}

const as = (token: string) => ({ Authorization: `Bearer ${token}` });
const get = (token: string, path: string) => request(app).get(`/health-record${path}`).set(as(token));
const post = (token: string, path: string, body: object = {}) => request(app).post(`/health-record${path}`).set(as(token)).send(body);

async function jpeg(): Promise<Buffer> {
  return sharp({ create: { width: 8, height: 8, channels: 3, background: "#cc3300" } }).jpeg().toBuffer();
}

describe("the Messages list", () => {
  it("makes the Team thread on first use, lists the jobs the technician is on and not another one", async () => {
    const eric = await makeTech("Eric");
    const mine = await makeJob("Mine", eric.id);
    await makeJob("NotMine");
    const res = await get(eric.accessToken, "/hub/threads");
    expect(res.status).toBe(200);
    const rows = res.body.data.threads as Array<{ key: string; kind: string; threadId: string | null; visitId: string | null }>;
    expect(rows.map((r) => r.key)).toEqual(["team", `job:${mine.visit.id}`]);
    expect(rows[0]).toMatchObject({ kind: "team" });
    expect(rows[0]!.threadId).toBeTruthy();
    // A job nobody has written in has no thread yet: opened by visit id.
    expect(rows[1]).toMatchObject({ kind: "job", threadId: null, visitId: mine.visit.id });
    expect(await prisma.hubThread.count({ where: { kind: "team", technicianId: eric.id } })).toBe(1);
    // Twice is still one Team thread.
    await get(eric.accessToken, "/hub/threads");
    expect(await prisma.hubThread.count({ where: { kind: "team", technicianId: eric.id } })).toBe(1);
  });

  it("shows the tech's own Training thread when one exists, and nobody else's", async () => {
    const eric = await makeTech("Eric");
    const sam = await makeTech("Sam");
    await prisma.hubThread.create({ data: { kind: "training", title: `${TAG} Eric training`, technicianId: eric.id } });
    expect((await get(eric.accessToken, "/hub/threads")).body.data.threads.map((r: { key: string }) => r.key)).toContain("training");
    expect((await get(sam.accessToken, "/hub/threads")).body.data.threads.map((r: { key: string }) => r.key)).not.toContain("training");
  });

  it("never carries an access token, in any response", async () => {
    const eric = await makeTech("Eric");
    const { visit } = await makeJob("Token", eric.id);
    const opened = await post(eric.accessToken, `/hub/job/${visit.id}/thread`);
    await post(eric.accessToken, `/hub/threads/${opened.body.data.id}/messages`, { body: "hello crew" });
    const bodies = [
      (await get(eric.accessToken, "/hub/threads")).text,
      (await get(eric.accessToken, `/hub/threads/${opened.body.data.id}/messages`)).text,
      (await get(eric.accessToken, "/hub/badge")).text,
    ];
    for (const text of bodies) expect(text).not.toContain(eric.accessToken);
  });
});

describe("who may open which thread", () => {
  it("opens a job's thread only for a technician assigned to it", async () => {
    const eric = await makeTech("Eric");
    const sam = await makeTech("Sam");
    const { visit } = await makeJob("Crew", eric.id);
    expect((await post(eric.accessToken, `/hub/job/${visit.id}/thread`)).status).toBe(200);
    expect((await post(sam.accessToken, `/hub/job/${visit.id}/thread`)).status).toBe(403);
  });

  it("403s on an unassigned job's thread, a customer thread, another person's Team thread and a Dev thread", async () => {
    const eric = await makeTech("Eric");
    const sam = await makeTech("Sam");
    const { customer, visit } = await makeJob("Locked", sam.id);
    const jobThread = await ensureThreadFor({ visitId: visit.id });
    const customerThread = await ensureThreadFor({ customerId: customer.id });
    const samTeam = await ensureTeamThread(sam.id);
    const dev = await prisma.hubThread.create({ data: { kind: "dev", title: `${TAG} dev` } });
    for (const id of [jobThread.id, customerThread.id, samTeam.id, dev.id]) {
      const read = await get(eric.accessToken, `/hub/threads/${id}/messages`);
      expect(read.status, `read ${id}`).toBe(403);
      expect(read.text).not.toContain("messages\":[");
      expect((await post(eric.accessToken, `/hub/threads/${id}/messages`, { body: "let me in" })).status, `post ${id}`).toBe(403);
      expect((await post(eric.accessToken, `/hub/threads/${id}/read`)).status, `read mark ${id}`).toBe(403);
    }
    expect((await get(eric.accessToken, "/hub/threads/does-not-exist/messages")).status).toBe(404);
    expect(await prisma.hubMessage.count({ where: { threadId: { in: [jobThread.id, customerThread.id, samTeam.id, dev.id] } } })).toBe(0);
  });

  it("refuses a bad or missing token", async () => {
    expect((await request(app).get("/health-record/hub/threads")).status).toBe(401);
    expect((await request(app).get("/health-record/hub/threads").set(as("nope"))).status).toBe(401);
  });
});

describe("sending, editing and deleting", () => {
  it("sends as the technician's name, edits and deletes only their own, and a deleted one leaves a mark", async () => {
    const eric = await makeTech("Eric");
    const sam = await makeTech("Sam");
    const { visit } = await makeJob("Say", eric.id);
    await prisma.visitAssignment.create({ data: { visitId: visit.id, technicianId: sam.id, role: "helper" } });
    const thread = (await post(eric.accessToken, `/hub/job/${visit.id}/thread`)).body.data.id as string;

    const sent = await post(eric.accessToken, `/hub/threads/${thread}/messages`, { body: "Panel is open" });
    expect(sent.status).toBe(201);
    const stored = await prisma.hubMessage.findUniqueOrThrow({ where: { id: sent.body.data.id } });
    expect(stored).toMatchObject({ authorType: "tech", authorTechnicianId: eric.id, authorKey: `tech:${eric.id}`, status: "posted", channel: "in_app", direction: "internal" });

    const ericView = (await get(eric.accessToken, `/hub/threads/${thread}/messages`)).body.data;
    expect(ericView.messages[0]).toMatchObject({ body: "Panel is open", authorLabel: `${TAG} Eric`, mine: true, canEdit: true, canDelete: true });
    const samView = (await get(sam.accessToken, `/hub/threads/${thread}/messages`)).body.data;
    expect(samView.messages[0]).toMatchObject({ body: "Panel is open", mine: false, canEdit: false, canDelete: false });

    // Sam can read Eric's message, not change it.
    expect((await request(app).patch(`/health-record/hub/messages/${sent.body.data.id}`).set(as(sam.accessToken)).send({ body: "x" })).status).toBe(403);
    expect((await request(app).delete(`/health-record/hub/messages/${sent.body.data.id}`).set(as(sam.accessToken)).send({})).status).toBe(403);

    expect((await request(app).patch(`/health-record/hub/messages/${sent.body.data.id}`).set(as(eric.accessToken)).send({ body: "Panel is open, cover off" })).status).toBe(200);
    const edited = (await get(eric.accessToken, `/hub/threads/${thread}/messages`)).body.data.messages[0];
    expect(edited).toMatchObject({ body: "Panel is open, cover off" });
    expect(edited.editedAt).toBeTruthy();

    expect((await request(app).delete(`/health-record/hub/messages/${sent.body.data.id}`).set(as(eric.accessToken)).send({ reason: "wrong job" })).status).toBe(200);
    const gone = (await get(sam.accessToken, `/hub/threads/${thread}/messages`)).body.data.messages[0];
    expect(gone).toMatchObject({ deleted: true, body: null });
    // The row stays; the text is in the audit.
    expect(await prisma.hubMessage.count({ where: { id: sent.body.data.id } })).toBe(1);
  });

  it("refuses an empty message, and a message in a closed thread reopens it", async () => {
    const eric = await makeTech("Eric");
    const team = await ensureTeamThread(eric.id);
    expect((await post(eric.accessToken, `/hub/threads/${team.id}/messages`, { body: "   " })).status).toBe(400);
    await prisma.hubThread.update({ where: { id: team.id }, data: { status: "closed" } });
    expect((await post(eric.accessToken, `/hub/threads/${team.id}/messages`, { body: "still here" })).status).toBe(201);
    expect((await prisma.hubThread.findUniqueOrThrow({ where: { id: team.id } })).status).toBe("open");
  });
});

describe("what a technician is shown", () => {
  it("hides a text to a customer, and an AI draft waiting for approval, until it is approved and posted", async () => {
    const eric = await makeTech("Eric");
    const { visit } = await makeJob("Hide", eric.id);
    const job = await ensureThreadFor({ visitId: visit.id });
    const training = await prisma.hubThread.create({ data: { kind: "training", title: `${TAG} train`, technicianId: eric.id } });
    const base = { authorType: "ai_agent", authorKey: "agent:scout", authorDisplay: "Scout", channel: "in_app", direction: "internal", body: "" } as const;
    await createMessageRow(prisma, { ...base, threadId: training.id, status: "pending_approval", body: "draft waiting" });
    await createMessageRow(prisma, { ...base, threadId: training.id, status: "rejected", body: "rejected one" });
    await createMessageRow(prisma, { ...base, threadId: training.id, status: "draft", body: "just a draft" });
    await createMessageRow(prisma, { ...base, threadId: training.id, status: "posted", body: "approved lesson" });
    await createMessageRow(prisma, {
      threadId: job.id, authorType: "office", authorKey: "owner", authorDisplay: "Kyle", channel: "sms", direction: "outbound",
      status: "sent", body: "We will be there at 9", category: "visit_reminder", toPhone: "6155550100",
    });

    const t = (await get(eric.accessToken, `/hub/threads/${training.id}/messages`)).body.data;
    expect(t.messages.map((m: { body: string }) => m.body)).toEqual(["approved lesson"]);
    expect(t.messages[0].authorLabel).toBe("Scout (AI)");
    const j = (await get(eric.accessToken, `/hub/threads/${job.id}/messages`)).body.data;
    expect(j.messages).toEqual([]);
    // Neither the hidden draft nor the customer text is counted as unread.
    const list = (await get(eric.accessToken, "/hub/threads")).body.data;
    expect(list.threads.find((r: { key: string }) => r.key === "training").unread).toBe(1);
    expect(list.threads.find((r: { key: string }) => r.key === `job:${visit.id}`).unread).toBe(0);
    expect(list.unread).toBe(1);
    expect((await get(eric.accessToken, "/hub/badge")).body.data.unread).toBe(1);
  });

  it("counts a message from someone else as unread until the thread is marked read", async () => {
    const eric = await makeTech("Eric");
    const team = await ensureTeamThread(eric.id);
    await createMessageRow(prisma, {
      threadId: team.id, authorType: "office", authorKey: "owner", authorDisplay: "Kyle", channel: "in_app", direction: "internal", status: "posted", body: "morning",
    });
    expect((await get(eric.accessToken, "/hub/badge")).body.data.unread).toBe(1);
    expect((await post(eric.accessToken, `/hub/threads/${team.id}/read`)).status).toBe(200);
    expect((await get(eric.accessToken, "/hub/badge")).body.data.unread).toBe(0);
  });
});

describe("photos: the one HubAttachment store, and a job's own VisitPhoto", () => {
  it("holds a Team photo on its message, serves it to the owner of the thread and to the office, and not to another technician", async () => {
    const eric = await makeTech("Eric");
    const sam = await makeTech("Sam");
    const team = await ensureTeamThread(eric.id);
    const up = await request(app).post(`/health-record/hub/threads/${team.id}/attachments`).set(as(eric.accessToken)).set("Content-Type", "image/jpeg").send(await jpeg());
    expect(up.status).toBe(201);
    expect(up.body.data).toMatchObject({ mimeType: "image/jpeg" });
    const attachmentId = up.body.data.id as string;
    // Added, not sent: unattached.
    expect((await prisma.hubAttachment.findUniqueOrThrow({ where: { id: attachmentId } })).messageId).toBeNull();

    const sent = await post(eric.accessToken, `/hub/threads/${team.id}/messages`, { body: "", attachmentIds: [attachmentId] });
    expect(sent.status).toBe(201);
    expect((await prisma.hubAttachment.findUniqueOrThrow({ where: { id: attachmentId } })).messageId).toBe(sent.body.data.id);
    expect(await prisma.hubAttachment.count({ where: { threadId: team.id } })).toBe(1);

    const view = (await get(eric.accessToken, `/hub/threads/${team.id}/messages`)).body.data.messages[0];
    expect(view.attachments).toEqual([{ id: attachmentId, mimeType: "image/jpeg" }]);
    expect((await get(eric.accessToken, "/hub/threads")).body.data.threads[0].lastLine.text).toBe("Photo");

    const mine = await get(eric.accessToken, `/hub/attachments/${attachmentId}`);
    expect(mine.status).toBe(200);
    expect(mine.headers["content-type"]).toContain("image/jpeg");
    // The office reads it with the session; another technician, and no credentials, cannot.
    expect((await request(app).get(`/hub/attachments/${attachmentId}`)).status).toBe(200);
    expect((await get(sam.accessToken, `/hub/attachments/${attachmentId}`)).status).toBe(404);
    expect((await request(app).get(`/health-record/hub/attachments/${attachmentId}`)).status).toBe(401);
  });

  it("refuses a photo on a job thread (it is the job's), on another person's Team thread, and a file that is not a picture", async () => {
    const eric = await makeTech("Eric");
    const sam = await makeTech("Sam");
    const { visit } = await makeJob("NoPhoto", eric.id);
    const job = await ensureThreadFor({ visitId: visit.id });
    const samTeam = await ensureTeamThread(sam.id);
    const upload = (token: string, threadId: string, body: Buffer | string, type = "image/jpeg") =>
      request(app).post(`/health-record/hub/threads/${threadId}/attachments`).set(as(token)).set("Content-Type", type).send(body);
    expect((await upload(eric.accessToken, job.id, await jpeg())).status).toBe(409);
    expect((await upload(eric.accessToken, samTeam.id, await jpeg())).status).toBe(403);
    const mine = await ensureTeamThread(eric.id);
    expect((await upload(eric.accessToken, mine.id, "this is not a picture")).status).toBe(415);
    expect(await prisma.hubAttachment.count()).toBe(0);
  });

  it("takes back an unsent photo, refuses a removed one on a message, and a message's Delete removes its photos", async () => {
    const eric = await makeTech("Eric");
    const team = await ensureTeamThread(eric.id);
    const add = async () => (await request(app).post(`/health-record/hub/threads/${team.id}/attachments`).set(as(eric.accessToken)).set("Content-Type", "image/jpeg").send(await jpeg())).body.data.id as string;
    const first = await add();
    expect((await request(app).delete(`/health-record/hub/attachments/${first}`).set(as(eric.accessToken))).status).toBe(200);
    expect((await get(eric.accessToken, `/hub/attachments/${first}`)).status).toBe(404);
    // A removed photo cannot be sent.
    expect((await post(eric.accessToken, `/hub/threads/${team.id}/messages`, { body: "x", attachmentIds: [first] })).status).toBe(409);

    const second = await add();
    const sent = await post(eric.accessToken, `/hub/threads/${team.id}/messages`, { body: "look", attachmentIds: [second] });
    // On a message it leaves with the message, not on its own.
    expect((await request(app).delete(`/health-record/hub/attachments/${second}`).set(as(eric.accessToken))).status).toBe(409);
    await request(app).delete(`/health-record/hub/messages/${sent.body.data.id}`).set(as(eric.accessToken)).send({ reason: "oops" });
    expect((await prisma.hubAttachment.findUniqueOrThrow({ where: { id: second } })).deletedAt).not.toBeNull();
    expect((await get(eric.accessToken, `/hub/attachments/${second}`)).status).toBe(404);
  });

  it("sends a job photo as the job's VisitPhoto id, and refuses one filed on another job or sent on a Team thread", async () => {
    const eric = await makeTech("Eric");
    const a = await makeJob("PhotoA", eric.id);
    const b = await makeJob("PhotoB", eric.id);
    const photoOnA = await prisma.visitPhoto.create({ data: { id: crypto.randomUUID(), visitId: a.visit.id, technicianId: eric.id, mimeType: "image/jpeg", sizeBytes: 3, data: Buffer.from([1, 2, 3]) } });
    const threadA = (await post(eric.accessToken, `/hub/job/${a.visit.id}/thread`)).body.data.id as string;
    const threadB = (await post(eric.accessToken, `/hub/job/${b.visit.id}/thread`)).body.data.id as string;
    const ok = await post(eric.accessToken, `/hub/threads/${threadA}/messages`, { body: "", photoIds: [photoOnA.id] });
    expect(ok.status).toBe(201);
    expect((await get(eric.accessToken, `/hub/threads/${threadA}/messages`)).body.data.messages[0].photoIds).toEqual([photoOnA.id]);
    expect((await post(eric.accessToken, `/hub/threads/${threadB}/messages`, { body: "", photoIds: [photoOnA.id] })).status).toBe(400);
    const team = await ensureTeamThread(eric.id);
    expect((await post(eric.accessToken, `/hub/threads/${team.id}/messages`, { body: "", photoIds: [photoOnA.id] })).status).toBe(400);
    // The job's photo store is untouched: still one VisitPhoto, and no HubAttachment made for it.
    expect(await prisma.visitPhoto.count({ where: { visitId: a.visit.id } })).toBe(1);
    expect(await prisma.hubAttachment.count()).toBe(0);
  });

  it("lets the CRM add and read a photo on the person's Team thread through the session routes, only on their own", async () => {
    const eric = await makeTech("Eric");
    const sam = await makeTech("Sam");
    const team = await ensureTeamThread(eric.id);
    const samTeam = await ensureTeamThread(sam.id);
    const up = (threadId: string, body: Buffer) => request(app).post(`/hub/threads/${threadId}/attachments`).set("Content-Type", "image/jpeg").send(body);
    // With no principal login there is no person to hold the photo for (the gate-off session is Kyle, not a person on the team).
    expect((await up(team.id, await jpeg())).status).toBe(403);
    const login = await saveCrmLogin(eric.id, { username: `ht_${Math.random().toString(36).slice(2, 8)}`, role: "owner", password: "correct horse battery" });
    await setPrincipal(login.id);
    const mine = await up(team.id, await jpeg());
    expect(mine.status).toBe(201);
    // Not on another person's Team thread.
    expect((await up(samTeam.id, await jpeg())).status).toBe(403);
    // Sent with the message, read back with the session; and the field door reads the same photo for Eric.
    const sent = await request(app).post(`/hub/threads/${team.id}/messages`).send({ body: "", attachmentIds: [mine.body.id] });
    expect(sent.status).toBe(201);
    const detail = await request(app).get(`/hub/threads/${team.id}`);
    expect(detail.body.messages[0].attachments).toEqual([{ id: mine.body.id, mimeType: "image/jpeg" }]);
    expect((await request(app).get(`/hub/attachments/${mine.body.id}`)).status).toBe(200);
    expect((await get(eric.accessToken, `/hub/attachments/${mine.body.id}`)).status).toBe(200);
    expect(await prisma.hubAttachment.count({ where: { threadId: team.id } })).toBe(1);
    await prisma.crmLogin.deleteMany({ where: { id: login.id } });
  });
});

// ── review fixes (batch C4) ───────────────────────────────────────────────────────────────────────────

/** A signed-in office login that is NOT Kyle: a dispatcher. Returns its session header. */
async function dispatcher(name: string) {
  // Kyle's own principal login first: the dispatcher is then a plain login (isKyle false), not the first/only one.
  const kyle = await makeTech("KyleLogin");
  const kyleLogin = await saveCrmLogin(kyle.id, { username: `ht_kyle_${Math.random().toString(36).slice(2, 8)}`, role: "owner", password: "correct horse battery" });
  await setPrincipal(kyleLogin.id);
  const person = await makeTech(name);
  const username = `ht_${name.toLowerCase()}_${Math.random().toString(36).slice(2, 8)}`;
  const login = await saveCrmLogin(person.id, { username, role: "office", password: "correct horse battery" });
  const res = await request(app).post("/auth/login").send({ username, password: "correct horse battery" });
  expect(res.status).toBe(200);
  return { person, loginId: login.id, header: { Authorization: `Bearer ${res.body.token as string}` } };
}

describe("a photo is the property of the person who added it", () => {
  // A signed-in office login only means something with the sign-in gate on (it is off when no PIN is configured).
  let savedPin: string | undefined;
  beforeAll(async () => { savedPin = process.env.PIN_HASH; process.env.PIN_HASH = await hashPin("1234"); });
  afterAll(() => { if (savedPin === undefined) delete process.env.PIN_HASH; else process.env.PIN_HASH = savedPin; });
  it("lets an office login remove the photo it added to a technician's Training thread, and not the technician's; and each counts only against its own person", async () => {
    const eric = await makeTech("Eric");
    const dis = await dispatcher("Dana");
    const training = await prisma.hubThread.create({ data: { kind: "training", title: `${TAG} training`, technicianId: eric.id } });
    const officeUp = async () => request(app).post(`/hub/threads/${training.id}/attachments`).set(dis.header).set("Content-Type", "image/jpeg").send(await jpeg());
    const techUp = async () => request(app).post(`/health-record/hub/threads/${training.id}/attachments`).set(as(eric.accessToken)).set("Content-Type", "image/jpeg").send(await jpeg());

    const added = await officeUp();
    expect(added.status).toBe(201);
    const ericOwn = await techUp();
    expect(ericOwn.status).toBe(201);

    // The detail hands each person back only what THEY are holding, so a photo is never stranded out of sight.
    expect((await request(app).get(`/hub/threads/${training.id}`).set(dis.header)).body.staged).toEqual([{ id: added.body.id, mimeType: "image/jpeg" }]);
    expect((await get(eric.accessToken, `/hub/threads/${training.id}/messages`)).body.data.staged).toEqual([{ id: ericOwn.body.data.id, mimeType: "image/jpeg" }]);

    // The technician may not take back the office's photo, nor the office the technician's.
    expect((await request(app).delete(`/health-record/hub/attachments/${added.body.id}`).set(as(eric.accessToken))).status).toBe(403);
    expect((await request(app).delete(`/hub/attachments/${ericOwn.body.data.id}`).set(dis.header)).status).toBe(403);
    // The office's own Remove works.
    expect((await request(app).delete(`/hub/attachments/${added.body.id}`).set(dis.header)).status).toBe(204);
    expect((await prisma.hubAttachment.findUniqueOrThrow({ where: { id: added.body.id } })).deletedAt).not.toBeNull();

    // The six-at-a-time limit is per person: the office filling its six does not stop the technician.
    for (let i = 0; i < 6; i += 1) expect((await officeUp()).status).toBe(201);
    expect((await officeUp()).status).toBe(409);
    expect((await techUp()).status).toBe(201);
    await prisma.crmLogin.deleteMany({ where: { id: dis.loginId } });
  });
});

describe("a photo added and never sent is never stranded", () => {
  it("comes back in the thread so it can be removed, and goes when it is sent or removed", async () => {
    const eric = await makeTech("Eric");
    const team = await ensureTeamThread(eric.id);
    const add = async () => (await request(app).post(`/health-record/hub/threads/${team.id}/attachments`).set(as(eric.accessToken)).set("Content-Type", "image/jpeg").send(await jpeg())).body.data.id as string;
    const staged = async () => ((await get(eric.accessToken, `/hub/threads/${team.id}/messages`)).body.data.staged as Array<{ id: string }>).map((s) => s.id);

    // Six are added and abandoned (a reload, "← Messages", a discarded message): they are all listed, so each has its Remove.
    const ids: string[] = [];
    for (let i = 0; i < 6; i += 1) ids.push(await add());
    expect((await staged()).sort()).toEqual([...ids].sort());
    // At the limit a seventh is refused, and the reason is something the person can act on.
    const seventh = await request(app).post(`/health-record/hub/threads/${team.id}/attachments`).set(as(eric.accessToken)).set("Content-Type", "image/jpeg").send(await jpeg());
    expect(seventh.status).toBe(409);
    // Taking one back frees the place again.
    expect((await request(app).delete(`/health-record/hub/attachments/${ids[0]}`).set(as(eric.accessToken))).status).toBe(200);
    expect(await staged()).not.toContain(ids[0]);
    expect((await add()).length).toBeGreaterThan(0);
    // Sending takes them off the held list.
    const held = await staged();
    expect((await post(eric.accessToken, `/hub/threads/${team.id}/messages`, { body: "all of them", attachmentIds: held.slice(0, 6) })).status).toBe(201);
    expect(await staged()).toEqual([]);
  });
});

describe("unread counts the moment a message became readable", () => {
  it("counts an AI post approved after the technician last opened the thread, and shows when it became readable", async () => {
    const eric = await makeTech("Eric");
    const training = await prisma.hubThread.create({ data: { kind: "training", title: `${TAG} approve later`, technicianId: eric.id } });
    // Scout drafts at 9:00 ...
    const draft = await createMessageRow(prisma, {
      threadId: training.id, authorType: "ai_agent", authorKey: "agent:scout", authorDisplay: "Scout", channel: "in_app",
      direction: "internal", status: "pending_approval", body: "Lesson on GFCI",
    });
    await prisma.hubMessage.update({ where: { id: draft.id }, data: { createdAt: new Date(Date.now() - 3 * 3600_000) } });
    // ... the technician opens the thread at 9:30 (hidden draft: nothing to read) ...
    expect((await post(eric.accessToken, `/hub/threads/${training.id}/read`)).status).toBe(200);
    expect((await get(eric.accessToken, "/hub/badge")).body.data.unread).toBe(0);
    // ... and Kyle approves it later: the post becomes readable now (what settleSent writes).
    await prisma.hubMessage.update({ where: { id: draft.id }, data: { status: "posted", sentAt: new Date() } });
    expect((await get(eric.accessToken, "/hub/badge")).body.data.unread).toBe(1);
    const detail = (await get(eric.accessToken, `/hub/threads/${training.id}/messages`)).body.data;
    expect(detail.messages[0].at > detail.lastReadAt).toBe(true);
    expect(detail.messages[0].createdAt < detail.lastReadAt).toBe(true);
    // Reading it clears the badge again.
    await post(eric.accessToken, `/hub/threads/${training.id}/read`);
    expect((await get(eric.accessToken, "/hub/badge")).body.data.unread).toBe(0);
  });
});
