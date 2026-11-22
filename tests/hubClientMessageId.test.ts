/**
 * The server-side duplicate guard and the photo-ownership rule on postMessage (work order agent-team, C4 carry-overs a and b).
 *
 * (a) HubMessage.clientMessageId, unique per author: the screen that composes a message makes ONE id and sends it again on every
 *     retry, and a repeat answers 200 with the message that already exists instead of making a second. Pinned on both doors
 *     (the technician's route and the CRM's), for two sends at once, for a retry whose photos the first try already took, and
 *     for the things that must NOT collide (another author, a message with no id).
 * (b) postMessage claims only the photos the POSTER staged (stagedPhotoIds, the attachment_added audit row's actor): never
 *     another person's staged photo on a Training thread, whoever the poster is (a person or an agent). A refusal is a 409
 *     with a sentence, and the photo stays where it was.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
import { hashPin } from "../src/middleware/pinAuth";
import { ensureTeamThread, ensureThreadFor, postMessage, type HubReader } from "../src/services/hub";
import { saveCrmLogin } from "../src/services/crmLogin";
import { cleanupCrmLoginFixtures, makePerson } from "./helpers/crmLoginFixture";

const PIN = "1234";
const PASS = "correct horse battery";
const TAG = "HubClientId";
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

async function wipe() {
  const customers = await prisma.customer.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
  const ids = customers.map((c) => c.id);
  await prisma.hubThread.deleteMany({ where: { OR: [{ title: { startsWith: TAG } }, { customerId: { in: ids } }] } });
  if (ids.length > 0) {
    await prisma.visit.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.property.deleteMany({ where: { customerId: { in: ids } } });
    await prisma.customer.deleteMany({ where: { id: { in: ids } } });
  }
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
});
afterEach(wipe);

async function tech(name: string) {
  const p = await makePerson(`${TAG} ${name}`);
  const row = await prisma.technician.findUniqueOrThrow({ where: { id: p.id } });
  return { id: p.id, token: row.accessToken };
}
const techGet = (token: string, path: string) => request(app).get(`/health-record${path}`).set(bearer(token));
const techPost = (token: string, path: string, body: object = {}) => request(app).post(`/health-record${path}`).set(bearer(token)).send(body);
const pinToken = async () => (await request(app).post("/auth/pin").send({ pin: PIN })).body.token as string;
const jpeg = () => sharp({ create: { width: 8, height: 8, channels: 3, background: "#cc3300" } }).jpeg().toBuffer();
const techUpload = async (token: string, threadId: string) =>
  request(app).post(`/health-record/hub/threads/${threadId}/attachments`).set(bearer(token)).set("Content-Type", "image/jpeg").send(await jpeg());

async function job(suffix: string, assignTo?: string) {
  const customer = await prisma.customer.create({
    data: { name: `${TAG} ${suffix}`, properties: { create: { name: "Home", addressLine1: "12 Main St", city: "Smyrna", state: "TN", postalCode: "37167" } } },
    include: { properties: true },
  });
  const visit = await prisma.visit.create({ data: { customerId: customer.id, propertyId: customer.properties[0]!.id, mode: "service_call", jobType: "Panel upgrade" } });
  if (assignTo) await prisma.visitAssignment.create({ data: { visitId: visit.id, technicianId: assignTo } });
  const thread = await ensureThreadFor({ visitId: visit.id });
  return { customer, visit, thread };
}
const messagesIn = (threadId: string) => prisma.hubMessage.findMany({ where: { threadId, deletedAt: null }, orderBy: { createdAt: "asc" } });

describe("a repeat of the same composed message is the same message (carry-over a)", () => {
  it("the technician's door: the first send is 201, a retry with the same id is 200 with the same message, and there is one row", async () => {
    const eric = await tech("Eric");
    const team = await ensureTeamThread(eric.id);
    const id = "11111111-aaaa-bbbb-cccc-000000000001";

    const first = await techPost(eric.token, `/hub/threads/${team.id}/messages`, { body: "On site", clientMessageId: id });
    expect(first.status).toBe(201);
    const retry = await techPost(eric.token, `/hub/threads/${team.id}/messages`, { body: "On site", clientMessageId: id });
    expect(retry.status).toBe(200);
    expect(retry.body.data.id).toBe(first.body.data.id);
    expect(await messagesIn(team.id)).toHaveLength(1);
    expect((await prisma.hubMessage.findUniqueOrThrow({ where: { id: first.body.data.id } })).clientMessageId).toBe(id);
    // A replay writes and announces nothing new: one created audit row, not two.
    expect(await prisma.hubAuditLog.count({ where: { messageId: first.body.data.id, action: "message_created" } })).toBe(1);
  });

  it("the CRM's door: the same, for the Thread drawer's post", async () => {
    const { thread } = await job("Crm");
    const token = await pinToken();
    const id = "22222222-aaaa-bbbb-cccc-000000000002";
    const first = await request(app).post(`/hub/threads/${thread.id}/messages`).set(bearer(token)).send({ body: "Bring the 200 amp base", clientMessageId: id });
    expect(first.status).toBe(201);
    const retry = await request(app).post(`/hub/threads/${thread.id}/messages`).set(bearer(token)).send({ body: "Bring the 200 amp base", clientMessageId: id });
    expect(retry.status).toBe(200);
    expect(retry.body.id).toBe(first.body.id);
    expect(await messagesIn(thread.id)).toHaveLength(1);
  });

  it("two sends of one message at the SAME time make one row: the unique key keeps one and the loser is answered with it", async () => {
    const eric = await tech("Eric");
    const team = await ensureTeamThread(eric.id);
    const id = "33333333-aaaa-bbbb-cccc-000000000003";
    const sends = await Promise.all([1, 2, 3, 4].map(() => techPost(eric.token, `/hub/threads/${team.id}/messages`, { body: "Racing", clientMessageId: id })));
    expect(sends.map((s) => s.status).sort()).toEqual([200, 200, 200, 201]);
    expect(new Set(sends.map((s) => s.body.data.id)).size).toBe(1);
    expect(await messagesIn(team.id)).toHaveLength(1);
  });

  it("a retry whose photos the first try already took is still answered with the message, not a 'photo removed' refusal", async () => {
    const eric = await tech("Eric");
    const team = await ensureTeamThread(eric.id);
    const photo = await techUpload(eric.token, team.id);
    expect(photo.status).toBe(201);
    const id = "44444444-aaaa-bbbb-cccc-000000000004";
    const body = { body: "Here is the panel", attachmentIds: [photo.body.data.id], clientMessageId: id };
    const first = await techPost(eric.token, `/hub/threads/${team.id}/messages`, body);
    expect(first.status).toBe(201);
    const retry = await techPost(eric.token, `/hub/threads/${team.id}/messages`, body);
    expect(retry.status).toBe(200);
    expect(retry.body.data.id).toBe(first.body.data.id);
    expect(await prisma.hubAttachment.count({ where: { messageId: first.body.data.id } })).toBe(1);
  });

  it("is scoped to the author: two people may use the same id, and a message with no id never collides with another", async () => {
    const eric = await tech("Eric");
    const sam = await tech("Sam");
    const ericTeam = await ensureTeamThread(eric.id);
    const samTeam = await ensureTeamThread(sam.id);
    const id = "55555555-aaaa-bbbb-cccc-000000000005";
    expect((await techPost(eric.token, `/hub/threads/${ericTeam.id}/messages`, { body: "mine", clientMessageId: id })).status).toBe(201);
    expect((await techPost(sam.token, `/hub/threads/${samTeam.id}/messages`, { body: "also mine", clientMessageId: id })).status).toBe(201);
    // No id at all: two identical messages are two messages (nothing to deduplicate by).
    expect((await techPost(eric.token, `/hub/threads/${ericTeam.id}/messages`, { body: "same words" })).status).toBe(201);
    expect((await techPost(eric.token, `/hub/threads/${ericTeam.id}/messages`, { body: "same words" })).status).toBe(201);
    expect(await messagesIn(ericTeam.id)).toHaveLength(3);
  });

  it("an id already used in another conversation is refused, and an id too short to be one fails validation", async () => {
    const eric = await tech("Eric");
    const team = await ensureTeamThread(eric.id);
    const { thread } = await job("Elsewhere", eric.id);
    const id = "66666666-aaaa-bbbb-cccc-000000000006";
    expect((await techPost(eric.token, `/hub/threads/${team.id}/messages`, { body: "hello", clientMessageId: id })).status).toBe(201);
    const wrong = await techPost(eric.token, `/hub/threads/${thread.id}/messages`, { body: "hello", clientMessageId: id });
    expect(wrong.status).toBe(409);
    expect(wrong.body.error.message).toBe("That message id was already used in a different conversation.");
    expect(await messagesIn(thread.id)).toHaveLength(0);
    expect((await techPost(eric.token, `/hub/threads/${team.id}/messages`, { body: "hello", clientMessageId: "x" })).status).toBe(422);
  });

  it("the unique key is real: the same author and id cannot be stored twice, and an author with no id can store many", async () => {
    const eric = await tech("Eric");
    const team = await ensureTeamThread(eric.id);
    const row = { threadId: team.id, authorType: "tech", authorKey: `tech:${eric.id}`, authorDisplay: "Eric", channel: "in_app", direction: "internal", status: "posted", body: "x" };
    await prisma.hubMessage.create({ data: { ...row, clientMessageId: "dup-0000-0001" } });
    await expect(prisma.hubMessage.create({ data: { ...row, clientMessageId: "dup-0000-0001" } })).rejects.toMatchObject({ code: "P2002" });
    await prisma.hubMessage.create({ data: { ...row } });
    await prisma.hubMessage.create({ data: { ...row } });
  });
});

describe("a photo goes only in the message of the person who added it (carry-over b)", () => {
  async function trainingFor(techId: string) {
    return prisma.hubThread.create({ data: { kind: "training", title: `${TAG} training`, technicianId: techId } });
  }
  async function officeLogin() {
    const person = await makePerson(`${TAG} Michael`);
    await saveCrmLogin(person.id, { username: "michael", role: "owner", password: PASS });
    return (await request(app).post("/auth/login").send({ username: "michael", password: PASS })).body.token as string;
  }
  const officeUpload = async (token: string, threadId: string) =>
    request(app).post(`/hub/threads/${threadId}/attachments`).set(bearer(token)).set("Content-Type", "image/jpeg").send(await jpeg());

  it("an apprentice cannot claim a photo the office staged on their Training thread: a 409 with a sentence, and the photo stays staged", async () => {
    const eric = await tech("Eric");
    const training = await trainingFor(eric.id);
    const michael = await officeLogin();
    const staged = await officeUpload(michael, training.id);
    expect(staged.status).toBe(201);

    const claim = await techPost(eric.token, `/hub/threads/${training.id}/messages`, { body: "look at this", attachmentIds: [staged.body.id] });
    expect(claim.status).toBe(409);
    expect(claim.body.error.message).toBe("That photo was added by someone else, so it cannot go in your message.");
    expect(await messagesIn(training.id)).toHaveLength(0);
    expect((await prisma.hubAttachment.findUniqueOrThrow({ where: { id: staged.body.id } })).messageId).toBeNull();

    // The one who added it can send it.
    const mine = await request(app).post(`/hub/threads/${training.id}/messages`).set(bearer(michael)).send({ body: "here is the lesson photo", attachmentIds: [staged.body.id] });
    expect(mine.status).toBe(201);
    expect((await prisma.hubAttachment.findUniqueOrThrow({ where: { id: staged.body.id } })).messageId).toBe(mine.body.id);
  });

  it("the apprentice's own photo on the same thread still goes", async () => {
    const eric = await tech("Eric");
    const training = await trainingFor(eric.id);
    const own = await techUpload(eric.token, training.id);
    expect(own.status).toBe(201);
    const sent = await techPost(eric.token, `/hub/threads/${training.id}/messages`, { body: "my work", attachmentIds: [own.body.data.id] });
    expect(sent.status).toBe(201);
    expect((await prisma.hubAttachment.findUniqueOrThrow({ where: { id: own.body.data.id } })).messageId).toBe(sent.body.data.id);
  });

  it("a photo that is not in this thread, or is already on a message, keeps the existing refusal", async () => {
    const eric = await tech("Eric");
    const team = await ensureTeamThread(eric.id);
    const training = await trainingFor(eric.id);
    const own = await techUpload(eric.token, team.id);
    const wrongThread = await techPost(eric.token, `/hub/threads/${training.id}/messages`, { body: "wrong thread", attachmentIds: [own.body.data.id] });
    expect(wrongThread.status).toBe(409);
    expect(wrongThread.body.error.message).toBe("A photo was removed before the message was sent. Add it again.");
    const sent = await techPost(eric.token, `/hub/threads/${team.id}/messages`, { body: "first", attachmentIds: [own.body.data.id] });
    expect(sent.status).toBe(201);
    const reuse = await techPost(eric.token, `/hub/threads/${team.id}/messages`, { body: "again", attachmentIds: [own.body.data.id] });
    expect(reuse.status).toBe(409);
    expect(reuse.body.error.message).toBe("A photo was removed before the message was sent. Add it again.");
  });

  it("an agent can never claim a person's staged photo either", async () => {
    const eric = await tech("Eric");
    const training = await trainingFor(eric.id);
    const own = await techUpload(eric.token, training.id);
    const scout: HubReader = { key: "agent:scout", kind: "agent", display: "Scout", technicianId: null, threadKinds: ["training"], agentRole: "scout", agentKeyId: "k1", isKyle: false };
    await expect(postMessage(scout, { threadId: training.id, body: "borrowed", attachmentIds: [own.body.data.id] })).rejects.toMatchObject({ status: 409 });
    expect((await prisma.hubAttachment.findUniqueOrThrow({ where: { id: own.body.data.id } })).messageId).toBeNull();
  });
});
