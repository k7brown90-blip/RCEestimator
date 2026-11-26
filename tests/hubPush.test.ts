/**
 * Web push for the Messages hub (work order agent-team, U7): services/hubPush.ts (transport),
 * services/hubNotifier.ts (who hears, what it says) and the subscription routes on both doors.
 * web-push is mocked: nothing here reaches a push service.
 *
 * Pinned here: with the three VAPID variables unset nothing throws and nothing is sent, and the key route says
 * why; a device's endpoint must be a real push service over https (the server never calls an address a client
 * chose); the payload has a title, one generic line, a tap URL and a tag - NO customer name, address, phone or
 * message text; a draft waiting for approval goes to the approvers only (Kyle, and a login granted
 * approve_drafts), not to a plain technician or a plain login, and (W2-D) an approver technician's field phone is told too, with a tap that
 * opens the field's approval list; a new message goes to the people who may see its thread
 * except its author, and a technician's tap opens the field thread; a 404 or 410 from the push service removes
 * the subscription and another failure keeps it with a note; the tech door subscribes and unsubscribes too.
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
const sendNotification = vi.fn();
const setVapidDetails = vi.fn();
vi.mock("web-push", () => ({ default: { sendNotification: (...a: unknown[]) => sendNotification(...a), setVapidDetails: (...a: unknown[]) => setVapidDetails(...a) } }));

import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { saveCrmLogin, setPowers, setPrincipal } from "../src/services/crmLogin";
import { ensureTeamThread, ensureThreadFor, postMessage, createMessageRow, type HubReader } from "../src/services/hub";
import { waitingDraft } from "./helpers/waitingDraft"; // Kyle 2026-11-24: an agent message now SENDS when posted; these tests need a card already waiting (a pre-deploy one)
import { techReader } from "../src/services/hubTech";
import { isAllowedPushEndpoint, pushConfig, saveSubscription, sendPush, PUSH_NOT_CONFIGURED_REASON } from "../src/services/hubPush";
import { notifyApprovers, notifyNewMessage } from "../src/services/hubNotifier";

const TAG = "HubPush";
const techIds: string[] = [];
const RUN = Math.random().toString(36).slice(2, 8);
const endpoint = (name: string) => `https://fcm.googleapis.com/fcm/send/${TAG}-${RUN}-${name}`;
const keys = { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" };
const myEndpoints = (): string[] => (sendNotification.mock.calls as Array<[{ endpoint: string }, string]>).map((c) => c[0].endpoint).filter((e) => e.includes(`${TAG}-${RUN}`));
const myPayloads = (): Array<{ endpoint: string; payload: Record<string, string> }> =>
  (sendNotification.mock.calls as Array<[{ endpoint: string }, string]>)
    .filter((c) => c[0].endpoint.includes(`${TAG}-${RUN}`))
    .map((c) => ({ endpoint: c[0].endpoint, payload: JSON.parse(c[1]) as Record<string, string> }));

const VAPID = { VAPID_PUBLIC_KEY: "BPublicKeyForTests", VAPID_PRIVATE_KEY: "privateKeyForTests", VAPID_SUBJECT: "mailto:test@example.com" } as const;
const saved: Record<string, string | undefined> = {};
const setVapid = (on: boolean) => {
  for (const [k, v] of Object.entries(VAPID)) { if (on) process.env[k] = v; else delete process.env[k]; }
};

async function wipe() {
  await prisma.hubPushSubscription.deleteMany({ where: { endpoint: { contains: `${TAG}-${RUN}` } } });
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
beforeAll(() => { for (const k of Object.keys(VAPID)) saved[k] = process.env[k]; });
afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await wipe();
});
beforeEach(async () => {
  await wipe();
  sendNotification.mockReset();
  sendNotification.mockResolvedValue({ statusCode: 201 });
  setVapid(true);
});

async function makeTech(name: string) {
  const t = await prisma.technician.create({ data: { name: `${TAG} ${name}`, accessToken: `hubpush-${name}-${Math.random().toString(36).slice(2)}` } });
  techIds.push(t.id);
  return t;
}
async function makeLogin(name: string, powers: string[] = []) {
  const t = await makeTech(name);
  const login = await saveCrmLogin(t.id, { username: `hp_${RUN}_${name.toLowerCase()}`, role: "office", password: "correct horse battery" });
  if (powers.length > 0) await setPowers(login.id, powers as never);
  return { tech: t, loginId: login.id };
}
async function makeJob(suffix: string, assignTo: string[] = []) {
  const customer = await prisma.customer.create({
    data: { name: `${TAG} Secretcustomer ${suffix}`, phone: "6155559876", properties: { create: { name: "Home", addressLine1: "4321 Hidden Lane", city: "Smyrna", state: "TN", postalCode: "37167" } } },
    include: { properties: true },
  });
  const visit = await prisma.visit.create({ data: { customerId: customer.id, propertyId: customer.properties[0]!.id, mode: "service_call", jobType: "Panel upgrade" } });
  for (const technicianId of assignTo) await prisma.visitAssignment.create({ data: { visitId: visit.id, technicianId } });
  return { customer, visit };
}
const subscribe = (readerKey: string, name: string) => saveSubscription(readerKey, { endpoint: endpoint(name), keys }, "test-agent");
const agent: HubReader = { key: "agent:scout", kind: "agent", display: "Scout", technicianId: null, threadKinds: [], agentRole: "admin", agentKeyId: "scout", agentScopes: ["hub:read", "hub:draft", "team:reply", "dev:read", "training:read", "training:write"], isKyle: false };
const settle = () => new Promise((r) => setTimeout(r, 150));

describe("when notifications are not set up", () => {
  it("says why, refuses a subscription, sends nothing and throws nothing", async () => {
    setVapid(false);
    expect(pushConfig()).toEqual({ configured: false, publicKey: null, reason: PUSH_NOT_CONFIGURED_REASON });
    await expect(subscribe("owner", "off")).rejects.toMatchObject({ status: 409 });
    expect(await sendPush([{ readerKey: "owner", payload: { title: "t", body: "b", url: "/messages", tag: "x" } }])).toBe(0);
    const eric = await makeTech("Eric");
    const { visit } = await makeJob("Off", [eric.id]);
    const thread = await ensureThreadFor({ visitId: visit.id });
    await postMessage(techReader(eric), { threadId: thread.id, body: "hello" });
    await settle();
    expect(sendNotification).not.toHaveBeenCalled();
    const key = await request(app).get("/hub/push/key");
    expect(key.status).toBe(200);
    expect(key.body).toMatchObject({ configured: false, publicKey: null, reason: PUSH_NOT_CONFIGURED_REASON });
    const post = await request(app).post("/hub/push/subscription").send({ endpoint: endpoint("off"), keys });
    expect(post.status).toBe(409);
  });
});

describe("a device's address", () => {
  it("must be a real push service over https", () => {
    for (const ok of ["https://fcm.googleapis.com/fcm/send/abc", "https://updates.push.services.mozilla.com/wpush/v2/abc", "https://web.push.apple.com/abc", "https://wns2-par02p.notify.windows.com/w/?token=x"]) {
      expect(isAllowedPushEndpoint(ok), ok).toBe(true);
    }
    for (const bad of [
      "http://fcm.googleapis.com/x", "https://evil.example.com/x", "https://fcm.googleapis.com.evil.com/x", "https://localhost/x",
      "https://169.254.169.254/latest", "https://user:pw@fcm.googleapis.com/x", "https://fcm.googleapis.com:8443/x", "not a url", "",
    ]) {
      expect(isAllowedPushEndpoint(bad), bad).toBe(false);
    }
  });

  it("is refused by the route when it is not one, and when the keys are not keys", async () => {
    const evil = await request(app).post("/hub/push/subscription").send({ endpoint: "https://evil.example.com/x", keys });
    expect(evil.status).toBe(400);
    const badKeys = await request(app).post("/hub/push/subscription").send({ endpoint: endpoint("k"), keys: { p256dh: "!!", auth: "!!" } });
    expect(badKeys.status).toBe(400);
    expect(await prisma.hubPushSubscription.count({ where: { endpoint: { contains: `${TAG}-${RUN}` } } })).toBe(0);
  });
});

describe("the subscription routes", () => {
  it("lets the office turn it on and off for a device, and reports it", async () => {
    const key = await request(app).get("/hub/push/key");
    expect(key.body).toMatchObject({ configured: true, publicKey: VAPID.VAPID_PUBLIC_KEY, subscribed: false });
    expect((await request(app).post("/hub/push/subscription").send({ endpoint: endpoint("desk"), keys })).status).toBe(201);
    expect((await request(app).get("/hub/push/key")).body.subscribed).toBe(true);
    expect((await prisma.hubPushSubscription.findUniqueOrThrow({ where: { endpoint: endpoint("desk") } })).readerKey).toBe("owner");
    expect((await request(app).delete("/hub/push/subscription").send({ endpoint: endpoint("desk") })).status).toBe(200);
    expect(await prisma.hubPushSubscription.count({ where: { endpoint: endpoint("desk") } })).toBe(0);
  });

  it("lets a technician do the same on the field door, as themselves, and not undo anyone else's", async () => {
    const eric = await makeTech("Eric");
    const sam = await makeTech("Sam");
    const auth = (t: { accessToken: string }) => ({ Authorization: `Bearer ${t.accessToken}` });
    expect((await request(app).get("/health-record/hub/push/key").set(auth(eric))).body.data).toMatchObject({ configured: true, subscribed: false });
    expect((await request(app).post("/health-record/hub/push/subscription").set(auth(eric)).send({ endpoint: endpoint("eric"), keys })).status).toBe(201);
    expect((await prisma.hubPushSubscription.findUniqueOrThrow({ where: { endpoint: endpoint("eric") } })).readerKey).toBe(`tech:${eric.id}`);
    // Sam asking to remove Eric's device removes nothing.
    await request(app).delete("/health-record/hub/push/subscription").set(auth(sam)).send({ endpoint: endpoint("eric") });
    expect(await prisma.hubPushSubscription.count({ where: { endpoint: endpoint("eric") } })).toBe(1);
    await request(app).delete("/health-record/hub/push/subscription").set(auth(eric)).send({ endpoint: endpoint("eric") });
    expect(await prisma.hubPushSubscription.count({ where: { endpoint: endpoint("eric") } })).toBe(0);
    expect((await request(app).post("/health-record/hub/push/subscription").send({ endpoint: endpoint("x"), keys })).status).toBe(401);
  });
});

describe("a draft waiting for approval", () => {
  it("goes to the approvers only: Kyle and a login granted approve_drafts, not a technician or a plain login", async () => {
    const eric = await makeTech("Eric");
    const plain = await makeLogin("Plain");
    const granted = await makeLogin("Granted", ["approve_drafts"]);
    const { customer } = await makeJob("Draft", [eric.id]);
    await subscribe("owner", "kyle");
    await subscribe(`tech:${eric.id}`, "eric");
    await subscribe(`user:${plain.loginId}`, "plain");
    await subscribe(`user:${granted.loginId}`, "granted");
    const thread = await ensureThreadFor({ customerId: customer.id });

    await waitingDraft(agent, { threadId: thread.id, channel: "email", subject: "Hello", body: "Hi Secretcustomer at 4321 Hidden Lane, call 6155559876", toAddress: "x@example.com" });
    await settle();
    const sent = myPayloads();
    expect(sent.map((s) => s.endpoint).sort()).toEqual([endpoint("granted"), endpoint("kyle")].sort());
    for (const { payload } of sent) {
      expect(Object.keys(payload).sort()).toEqual(["body", "tag", "title", "url"]);
      expect(payload.body).toBe("1 message needs approval");
      expect(payload.url).toBe(`/messages?thread=${thread.id}`);
      const text = JSON.stringify(payload);
      for (const secret of ["Secretcustomer", "Hidden Lane", "6155559876", "Hi Secretcustomer"]) expect(text).not.toContain(secret);
    }
  });
});

// W2-D (Kyle 2026-11-23 item 6): "approval pushes reach an approver's field phone and open the approval list". A field phone's
// subscription is saved as tech:<id>; it counts as an approver's only through the ONE approver rule (the person's linked CRM login is
// Kyle's principal login or holds approve_drafts). The words carry no text; the tap goes to /field/?approvals=1, never to a customer
// thread a technician cannot open. A plain technician is never told, and the office's pushes are unchanged.
describe("a draft waiting for approval, on a field phone (W2-D)", () => {
  it("reaches an approver technician's field phone with the approvals address and no text, and never a plain technician's", async () => {
    const eric = await makeTech("Eric");
    const michael = await makeLogin("Michael", ["approve_drafts"]);
    const kyle = await makeLogin("KylePerson");
    await setPrincipal(kyle.loginId);
    const noPower = await makeLogin("NoPower");
    const { customer } = await makeJob("FieldDraft", [eric.id]);
    await subscribe(`tech:${eric.id}`, "eric");
    await subscribe(`tech:${michael.tech.id}`, "michael-field");
    await subscribe(`tech:${kyle.tech.id}`, "kyle-field");
    await subscribe(`tech:${noPower.tech.id}`, "nopower-field");
    await subscribe("owner", "kyle-desk");
    await subscribe(`user:${michael.loginId}`, "michael-desk");
    const thread = await ensureThreadFor({ customerId: customer.id });

    await waitingDraft(agent, { threadId: thread.id, channel: "email", subject: "Hello", body: "Hi Secretcustomer at 4321 Hidden Lane, call 6155559876", toAddress: "x@example.com" });
    await settle();
    const sent = myPayloads();
    expect(sent.map((s) => s.endpoint).sort()).toEqual(
      [endpoint("michael-field"), endpoint("kyle-field"), endpoint("kyle-desk"), endpoint("michael-desk")].sort(),
    );
    for (const { endpoint: e, payload } of sent) {
      expect(Object.keys(payload).sort()).toEqual(["body", "tag", "title", "url"]);
      expect(payload.body).toBe("1 message needs approval");
      const field = e === endpoint("michael-field") || e === endpoint("kyle-field");
      // The field phone opens its own approval list; the desk opens the conversation, exactly as before.
      expect(payload.url).toBe(field ? "/field/?approvals=1" : `/messages?thread=${thread.id}`);
      if (field) expect(payload.url).not.toContain(thread.id);
      const text = JSON.stringify(payload);
      for (const secret of ["Secretcustomer", "Hidden Lane", "6155559876", "Hi Secretcustomer", "token"]) expect(text).not.toContain(secret);
    }
  });

  it("the re-notify reaches an approver's field phone with the same address, and not a plain technician's", async () => {
    const eric = await makeTech("Eric");
    const michael = await makeLogin("Michael", ["approve_drafts"]);
    await subscribe(`tech:${eric.id}`, "eric");
    await subscribe(`tech:${michael.tech.id}`, "michael-field");
    const sent = await notifyApprovers(2, "some-customer-thread");
    expect(sent).toBe(1);
    expect(myPayloads()).toEqual([
      { endpoint: endpoint("michael-field"), payload: { title: "Red Cedar Messages", body: "2 messages need approval", url: "/field/?approvals=1", tag: "approvals" } },
    ]);
  });

  it("a technician whose login is turned off, or who has gone inactive, is not told", async () => {
    const off = await makeLogin("Off", ["approve_drafts"]);
    const gone = await makeLogin("Gone", ["approve_drafts"]);
    await prisma.crmLogin.update({ where: { id: off.loginId }, data: { enabled: false } });
    await prisma.technician.update({ where: { id: gone.tech.id }, data: { isActive: false } });
    await subscribe(`tech:${off.tech.id}`, "off-field");
    await subscribe(`tech:${gone.tech.id}`, "gone-field");
    expect(await notifyApprovers(1, "some-thread")).toBe(0);
    expect(myEndpoints()).toEqual([]);
  });
});

describe("a new message", () => {
  it("goes to the people who may see its thread except its author, and a technician's tap opens the field thread", async () => {
    const eric = await makeTech("Eric");
    const sam = await makeTech("Sam");
    const lou = await makeTech("Lou");
    const { visit } = await makeJob("Crew", [eric.id, sam.id]);
    const thread = await ensureThreadFor({ visitId: visit.id });
    await subscribe("owner", "kyle");
    await subscribe(`tech:${eric.id}`, "eric");
    await subscribe(`tech:${sam.id}`, "sam");
    await subscribe(`tech:${lou.id}`, "lou");

    await postMessage(techReader(eric), { threadId: thread.id, body: "Panel is open, 4321 Hidden Lane" });
    await settle();
    const sent = myPayloads();
    expect(sent.map((s) => s.endpoint).sort()).toEqual([endpoint("kyle"), endpoint("sam")].sort());
    const toSam = sent.find((s) => s.endpoint === endpoint("sam"))!.payload;
    expect(toSam).toMatchObject({ body: "New message on a job thread", url: `/field/?thread=${thread.id}`, tag: `thread:${thread.id}` });
    const toKyle = sent.find((s) => s.endpoint === endpoint("kyle"))!.payload;
    expect(toKyle.url).toBe(`/messages?thread=${thread.id}`);
    for (const { payload } of sent) {
      const text = JSON.stringify(payload);
      for (const secret of ["Secretcustomer", "Hidden Lane", "6155559876", "Panel is open"]) expect(text).not.toContain(secret);
    }
  });

  it("is not announced to a technician when it is a text to the customer, and not to anyone when it went OUT to a customer", async () => {
    const eric = await makeTech("Eric");
    const { visit } = await makeJob("Out", [eric.id]);
    const thread = await ensureThreadFor({ visitId: visit.id });
    await subscribe("owner", "kyle");
    await subscribe(`tech:${eric.id}`, "eric");
    const text = await createMessageRow(prisma, {
      threadId: thread.id, authorType: "customer", authorDisplay: "Customer", channel: "sms", direction: "inbound", status: "received", body: "Running late?",
    });
    await notifyNewMessage(text, thread);
    expect(myPayloads().map((s) => s.endpoint)).toEqual([endpoint("kyle")]);

    sendNotification.mockClear();
    const out = await createMessageRow(prisma, {
      threadId: thread.id, authorType: "office", authorKey: "owner", authorDisplay: "Kyle", channel: "sms", direction: "outbound", status: "sent",
      body: "See you at 9", category: "visit_reminder", toPhone: "6155550100",
    });
    await notifyNewMessage(out, thread);
    expect(myEndpoints()).toEqual([]);
  });

  it("in a Team thread reaches the thread's own person and the office, never another technician", async () => {
    const eric = await makeTech("Eric");
    const sam = await makeTech("Sam");
    const team = await ensureTeamThread(eric.id);
    await subscribe("owner", "kyle");
    await subscribe(`tech:${eric.id}`, "eric");
    await subscribe(`tech:${sam.id}`, "sam");
    // The AI admin writes into Eric's Team thread.
    const aiAdmin: HubReader = { key: "ai-admin", kind: "ai-admin", display: "AI admin", technicianId: null, threadKinds: [], agentRole: null, agentKeyId: null, isKyle: false };
    await postMessage(aiAdmin, { threadId: team.id, body: "Here is your reminder" });
    await settle();
    expect(myPayloads().map((s) => s.endpoint).sort()).toEqual([endpoint("eric"), endpoint("kyle")].sort());
    expect(myPayloads().find((s) => s.endpoint === endpoint("eric"))!.payload.body).toBe("New message in a Team thread");
  });
});

describe("a device that is gone", () => {
  it("is forgotten on 404 and 410, and kept (with a note, no address in it) on another failure", async () => {
    await subscribe("owner", "gone");
    await subscribe("owner", "flaky");
    await subscribe("owner", "fine");
    sendNotification.mockImplementation(async (sub: { endpoint: string }) => {
      if (sub.endpoint === endpoint("gone")) throw Object.assign(new Error("gone"), { statusCode: 410 });
      if (sub.endpoint === endpoint("flaky")) throw Object.assign(new Error("boom https://secret"), { statusCode: 500 });
      return { statusCode: 201 };
    });
    const delivered = await sendPush([{ readerKey: "owner", payload: { title: "t", body: "b", url: "/messages", tag: "x" } }]);
    expect(delivered).toBeGreaterThanOrEqual(1);
    expect(await prisma.hubPushSubscription.count({ where: { endpoint: endpoint("gone") } })).toBe(0);
    const flaky = await prisma.hubPushSubscription.findUniqueOrThrow({ where: { endpoint: endpoint("flaky") } });
    expect(flaky.lastError).toBe("push failed (500)");
    expect((await prisma.hubPushSubscription.findUniqueOrThrow({ where: { endpoint: endpoint("fine") } })).lastOkAt).not.toBeNull();
    // A 404 is the same.
    await subscribe("owner", "missing");
    sendNotification.mockImplementation(async (sub: { endpoint: string }) => {
      if (sub.endpoint === endpoint("missing")) throw Object.assign(new Error("nf"), { statusCode: 404 });
      return { statusCode: 201 };
    });
    await sendPush([{ readerKey: "owner", payload: { title: "t", body: "b", url: "/messages", tag: "x" } }]);
    expect(await prisma.hubPushSubscription.count({ where: { endpoint: endpoint("missing") } })).toBe(0);
  });
});

// ── review fixes (batch C4) ───────────────────────────────────────────────────────────────────────────

describe("a rotated technician token cuts the old phone off from notifications", () => {
  it("deletes that technician's subscriptions on rotate, and only theirs", async () => {
    const eric = await makeTech("Eric");
    const sam = await makeTech("Sam");
    await subscribe(`tech:${eric.id}`, "eric-phone");
    await subscribe(`tech:${eric.id}`, "eric-tablet");
    await subscribe(`tech:${sam.id}`, "sam-phone");
    // A patch that does NOT rotate the token leaves the devices alone.
    expect((await request(app).patch(`/health-record-admin/technicians/${eric.id}`).send({ name: `${TAG} Eric` })).status).toBe(200);
    expect(await prisma.hubPushSubscription.count({ where: { readerKey: `tech:${eric.id}` } })).toBe(2);
    const before = (await prisma.technician.findUniqueOrThrow({ where: { id: eric.id } })).accessToken;
    expect((await request(app).patch(`/health-record-admin/technicians/${eric.id}`).send({ rotateToken: true })).status).toBe(200);
    expect((await prisma.technician.findUniqueOrThrow({ where: { id: eric.id } })).accessToken).not.toBe(before);
    expect(await prisma.hubPushSubscription.count({ where: { readerKey: `tech:${eric.id}` } })).toBe(0);
    expect(await prisma.hubPushSubscription.count({ where: { readerKey: `tech:${sam.id}` } })).toBe(1);
    // Nothing is pushed to the old phone any more.
    await sendPush([{ readerKey: `tech:${eric.id}`, payload: { title: "t", body: "b", url: "/", tag: "x" } }]);
    expect(myEndpoints()).toEqual([]);
  });
});

describe("'on' means THIS device belongs to THIS person", () => {
  it("answers per device on both doors, and Turn off from someone who does not own the device removes nothing", async () => {
    const eric = await makeTech("Eric");
    const auth = { Authorization: `Bearer ${eric.accessToken}` };
    // Kyle has the desk PC subscribed, and Eric has a different phone: neither is "on" for the other's device.
    await subscribe("owner", "desk");
    await subscribe(`tech:${eric.id}`, "phone");
    const here = (ep: string) => request(app).post("/hub/push/subscription/status").send({ endpoint: ep });
    const hereTech = (ep: string) => request(app).post("/health-record/hub/push/subscription/status").set(auth).send({ endpoint: ep });
    expect((await here(endpoint("desk"))).body).toEqual({ subscribedHere: true });
    expect((await here(endpoint("phone"))).body).toEqual({ subscribedHere: false });
    expect((await here(endpoint("never-saved"))).body).toEqual({ subscribedHere: false });
    expect((await hereTech(endpoint("phone"))).body.data).toEqual({ subscribedHere: true });
    expect((await hereTech(endpoint("desk"))).body.data).toEqual({ subscribedHere: false });
    // The person still "has a device" on the key answer, which is exactly why that is not enough to say THIS one is on.
    expect((await request(app).get("/hub/push/key")).body.subscribed).toBe(true);

    // Removing a device that is not yours reports removed:false (so the browser keeps its own subscription) and removes nothing.
    const notMine = await request(app).delete("/hub/push/subscription").send({ endpoint: endpoint("phone") });
    expect(notMine.body).toMatchObject({ removed: false });
    expect(await prisma.hubPushSubscription.count({ where: { endpoint: endpoint("phone") } })).toBe(1);
    const mine = await request(app).delete("/health-record/hub/push/subscription").set(auth).send({ endpoint: endpoint("phone") });
    expect(mine.body.data).toMatchObject({ removed: true });
    expect((await request(app).post("/health-record/hub/push/subscription/status").send({ endpoint: endpoint("phone"), keys })).status).toBe(401);
  });
});
