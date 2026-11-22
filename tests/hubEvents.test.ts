/**
 * The signed agent-event outbox (work order agent-team, BA4), its Agent events screen routes (BA5)
 * and the per-event-type target table (TC4), against a real local HTTP receiver.
 *
 * Pinned: the receiver verifies the HMAC over the raw bytes and the timestamp it was given; a fresh
 * timestamp on every attempt (an attempt an hour later still verifies, the first attempt's old one
 * would not) while the body and event_id never change; 408/429/5xx/timeout/connection error walk the
 * schedule and go dead after the 6th; any other 4xx is dead after exactly one attempt; 2xx is
 * delivered; no address means no_target and Resend delivers it once an address is set; with no secret
 * nothing is sent; two overlapping runs send once; Resend refuses a delivered event; the payload is
 * the closed shape (no name, link, phone, email or free text); the routes are bot_keys-gated; the
 * agentWebhooks setting is Kyle's alone and validates its addresses; one team post reaches Admin only
 * and material.used reaches Inventory.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createHmac } from "node:crypto";
import request from "supertest";

process.env.GOOGLE_CLIENT_ID = "test_id";
process.env.GOOGLE_CLIENT_SECRET = "test_secret";
process.env.GOOGLE_REFRESH_TOKEN = "test_token";
delete process.env.OPENAI_API_KEY;
delete process.env.STRIPE_SECRET_KEY;
// A test can queue the ids randomUUID hands out next (the id an event is given); anything else is the real one.
const uuidQueue = vi.hoisted(() => ({ next: [] as string[] }));
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, default: actual, randomUUID: () => uuidQueue.next.shift() ?? actual.randomUUID() };
});
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

import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { hashPin } from "../src/middleware/pinAuth";
import { saveAdminLogin } from "../src/services/adminLogin";
import { saveCrmLogin, setPowers } from "../src/services/crmLogin";
import { mintAgentKey } from "../src/agentApi/keys";
import {
  _setDeliveryTimeoutMsForTests, deliverDueEvents, deliverEvent, emitHubEvent, resendEvent, signEvent,
} from "../src/services/hubEvents";
import { ensureTeamThread, postMessage, type HubReader } from "../src/services/hub";
import { scrub } from "../src/agentApi/respond";
import { HUB_EVENT_MAX_ATTEMPTS, HUB_EVENT_RETRY_SECONDS, HUB_EVENT_TYPES, RESEND_DELIVERED_REASON } from "../shared/hub/events";
import { cleanupCrmLoginFixtures, makePerson } from "./helpers/crmLoginFixture";

const TAG = "HubEv";
const SECRET = "hub-test-secret-0123456789";
const PIN = "1234";
const PASS = "correct horse battery";
const AI_PASS = "another long password!";
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

// ── a real receiver ──────────────────────────────────────────────────────────────────────────────

interface Received { headers: http.IncomingHttpHeaders; body: string; at: number }
interface Receiver {
  url: string;
  requests: Received[];
  status: number;
  delayMs: number;
  close: () => Promise<void>;
}

async function startReceiver(): Promise<Receiver> {
  const r: Receiver = { url: "", requests: [], status: 200, delayMs: 0, close: async () => undefined };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      r.requests.push({ headers: req.headers, body, at: Date.now() });
      setTimeout(() => { res.statusCode = r.status; res.end("ok"); }, r.delayMs);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  r.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
  r.close = () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
  return r;
}

/** What a careful receiver does: reject a timestamp more than 5 minutes from its own clock, then recompute the HMAC over the raw body. */
function verify(req: Received, secret = SECRET, nowMs = Date.now()): { ok: boolean; why?: string } {
  const ts = String(req.headers["x-rce-timestamp"] ?? "");
  if (!/^\d{10}$/.test(ts)) return { ok: false, why: "timestamp is not Unix seconds" };
  if (Math.abs(nowMs / 1000 - Number(ts)) > 300) return { ok: false, why: "timestamp more than 5 minutes off" };
  const expected = `sha256=${createHmac("sha256", secret).update(`${ts}.${req.body}`).digest("hex")}`;
  return req.headers["x-rce-signature"] === expected ? { ok: true } : { ok: false, why: "bad signature" };
}

const waitFor = async (fn: () => boolean | Promise<boolean>, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timed out waiting");
};

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────────

let savedPin: string | undefined;
let savedPepper: string | undefined;
let savedSecret: string | undefined;
let savedUrl: string | undefined;
let receiver: Receiver;
const techIds: string[] = [];

async function wipeEvents() {
  await prisma.hubEventAttempt.deleteMany();
  await prisma.hubEvent.deleteMany();
}
async function wipe() {
  await wipeEvents();
  await prisma.companySetting.deleteMany({ where: { key: "agentWebhooks" } });
  await prisma.hubThread.deleteMany({ where: { OR: [{ title: { startsWith: TAG } }, { technicianId: { in: techIds } }] } });
  await prisma.lead.deleteMany({ where: { name: { startsWith: TAG } } });
  await prisma.technician.deleteMany({ where: { id: { in: techIds.splice(0) } } });
}

beforeAll(async () => {
  savedPin = process.env.PIN_HASH;
  savedPepper = process.env.AGENT_KEY_PEPPER;
  savedSecret = process.env.HUB_WEBHOOK_SECRET;
  savedUrl = process.env.HUB_AGENT_WEBHOOK_URL;
  process.env.PIN_HASH = await hashPin(PIN);
  process.env.AGENT_KEY_PEPPER = "test-pepper-for-the-hub-events";
});
afterAll(async () => {
  const restore = (k: string, v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
  restore("PIN_HASH", savedPin);
  restore("AGENT_KEY_PEPPER", savedPepper);
  restore("HUB_WEBHOOK_SECRET", savedSecret);
  restore("HUB_AGENT_WEBHOOK_URL", savedUrl);
  await wipe();
  await prisma.agentKey.deleteMany({ where: { name: { startsWith: TAG } } });
  await cleanupCrmLoginFixtures();
});
beforeEach(async () => {
  await wipe();
  await cleanupCrmLoginFixtures();
  receiver = await startReceiver();
  process.env.HUB_WEBHOOK_SECRET = SECRET;
  process.env.HUB_AGENT_WEBHOOK_URL = receiver.url;
  _setDeliveryTimeoutMsForTests(10_000);
});
afterEach(async () => {
  vi.useRealTimers();
  // Let any send this test started and did not wait for finish before its receiver goes away.
  await new Promise((r) => setTimeout(r, 60));
  await receiver.close();
});

async function makeLead(suffix = "lead") {
  return prisma.lead.create({ data: { name: `${TAG} ${suffix}`, phone: "6155550123", email: "secret.person@example.com", source: "web" } });
}

/** A due, undelivered event whose body is a real lead.created payload. Made with no address so nothing is sent while it is built. */
async function dueEvent(): Promise<string> {
  const saved = process.env.HUB_AGENT_WEBHOOK_URL;
  delete process.env.HUB_AGENT_WEBHOOK_URL;
  const lead = await makeLead(`due ${Math.random().toString(36).slice(2, 7)}`);
  const id = await emitHubEvent({ type: "lead.created", leadId: lead.id });
  process.env.HUB_AGENT_WEBHOOK_URL = saved;
  await prisma.hubEvent.update({ where: { id }, data: { status: "pending", nextAttemptAt: new Date(), lastError: null } });
  return id;
}

const FAR = () => new Date(Date.now() + 8 * 3600_000);

const pinToken = async () => (await request(app).post("/auth/pin").send({ pin: PIN })).body.token as string;
async function personToken(username: string, powers: string[] = []) {
  const person = await makePerson(`${TAG} ${username}`);
  const login = await saveCrmLogin(person.id, { username, role: "owner", password: PASS });
  if (powers.length) await setPowers(login.id, powers);
  const res = await request(app).post("/auth/login").send({ username, password: PASS });
  expect(res.status).toBe(200);
  return res.body.token as string;
}
async function aiAdminToken() {
  await saveAdminLogin("grok-admin", AI_PASS);
  return (await request(app).post("/auth/login").send({ username: "grok-admin", password: AI_PASS })).body.token as string;
}

// ── delivery ─────────────────────────────────────────────────────────────────────────────────────

describe("a signed delivery", () => {
  it("POSTs the stored body byte for byte; the receiver verifies timestamp, signature and event id", async () => {
    const lead = await makeLead();
    const id = await emitHubEvent({ type: "lead.created", leadId: lead.id });
    await waitFor(() => receiver.requests.some((r) => r.headers["x-rce-event-id"] === id));
    const got = receiver.requests.find((r) => r.headers["x-rce-event-id"] === id)!;
    expect(verify(got)).toEqual({ ok: true });
    expect(got.headers["content-type"]).toBe("application/json");
    expect(got.headers["x-rce-event-id"]).toBe(id);
    const row = await prisma.hubEvent.findUniqueOrThrow({ where: { id } });
    expect(got.body).toBe(row.payloadJson);
    const payload = JSON.parse(got.body);
    expect(payload.event_id).toBe(id);
    expect(payload.type).toBe("lead.created");
    expect(payload.occurred_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    await waitFor(async () => (await prisma.hubEvent.findUniqueOrThrow({ where: { id } })).status === "delivered");
    const done = await prisma.hubEvent.findUniqueOrThrow({ where: { id }, include: { attemptLog: true } });
    expect(done).toMatchObject({ attempts: 1, lastStatusCode: 200, lastError: null });
    expect(done.attemptLog).toHaveLength(1);
  });

  it("signs exactly `${timestamp}.${raw body}` with the one secret", () => {
    const sig = signEvent("s3cret", "1700000000", '{"a":1}');
    expect(sig).toBe(`sha256=${createHmac("sha256", "s3cret").update('1700000000.{"a":1}').digest("hex")}`);
    expect(signEvent("other", "1700000000", '{"a":1}')).not.toBe(sig);
    expect(signEvent("s3cret", "1700000001", '{"a":1}')).not.toBe(sig);
  });

  it("takes a FRESH timestamp each attempt: an attempt an hour later verifies, the first one's would not", async () => {
    receiver.status = 500;
    const id = await dueEvent();
    expect(await deliverEvent(id)).toBe("retrying");
    expect(receiver.requests).toHaveLength(1);
    const first = receiver.requests[0];

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.now() + 3600_000));
    receiver.status = 200;
    await prisma.hubEvent.update({ where: { id }, data: { nextAttemptAt: new Date() } });
    expect(await deliverEvent(id, prisma, new Date())).toBe("delivered");
    const second = receiver.requests[1];

    expect(second.body).toBe(first.body);
    expect(second.headers["x-rce-event-id"]).toBe(first.headers["x-rce-event-id"]);
    expect(second.headers["x-rce-timestamp"]).not.toBe(first.headers["x-rce-timestamp"]);
    const now = Date.now(); // the faked clock, an hour on
    expect(verify(second, SECRET, now)).toEqual({ ok: true });
    // The first attempt's timestamp, replayed an hour later, is what the 5-minute rule refuses.
    expect(verify(first, SECRET, now)).toEqual({ ok: false, why: "timestamp more than 5 minutes off" });
    expect(JSON.parse(first.body).occurred_at).toBe(JSON.parse(second.body).occurred_at);
  });
});

describe("what is retried and what is dead", () => {
  it("walks +30s, 2m, 10m, 1h, 6h on a 500 and is dead after the 6th failure", async () => {
    receiver.status = 500;
    const id = await dueEvent();
    const seen: number[] = [];
    for (let attempt = 1; attempt <= HUB_EVENT_MAX_ATTEMPTS; attempt += 1) {
      const status = await deliverEvent(id, prisma, FAR());
      const row = await prisma.hubEvent.findUniqueOrThrow({ where: { id } });
      expect(row.attempts).toBe(attempt);
      if (attempt < HUB_EVENT_MAX_ATTEMPTS) {
        expect(status).toBe("retrying");
        seen.push(Math.round((row.nextAttemptAt!.getTime() - Date.now()) / 1000));
      } else {
        expect(status).toBe("dead");
        expect(row.nextAttemptAt).toBeNull();
        expect(row.lastStatusCode).toBe(500);
      }
    }
    seen.forEach((got, i) => expect(Math.abs(got - HUB_EVENT_RETRY_SECONDS[i])).toBeLessThanOrEqual(5));
    expect(receiver.requests).toHaveLength(6);
    expect(await prisma.hubEventAttempt.count({ where: { eventId: id } })).toBe(6);
    // A dead event is never picked up again by the worker.
    expect(await deliverDueEvents(prisma, FAR())).toBe(0);
  });

  it.each([408, 429, 502, 503])("retries an HTTP %i", async (code) => {
    receiver.status = code;
    const id = await dueEvent();
    expect(await deliverEvent(id)).toBe("retrying");
    expect((await prisma.hubEvent.findUniqueOrThrow({ where: { id } })).lastStatusCode).toBe(code);
  });

  it("retries a timeout and a connection error", async () => {
    _setDeliveryTimeoutMsForTests(150);
    receiver.delayMs = 600;
    const slow = await dueEvent();
    expect(await deliverEvent(slow)).toBe("retrying");
    expect((await prisma.hubEvent.findUniqueOrThrow({ where: { id: slow } })).lastError).toBe("Timed out after 10 seconds");
    expect((await prisma.hubEvent.findUniqueOrThrow({ where: { id: slow } })).lastStatusCode).toBeNull();

    const refused = await dueEvent();
    await receiver.close();
    expect(await deliverEvent(refused)).toBe("retrying");
    const row = await prisma.hubEvent.findUniqueOrThrow({ where: { id: refused } });
    expect(row.lastError).toBe("Could not connect to the receiving address");
    // The error text never names the address.
    expect(row.lastError).not.toContain("127.0.0.1");
    receiver = await startReceiver();
  });

  it.each([400, 401, 403, 404, 410, 422, 302])("is dead after EXACTLY one attempt on an HTTP %i", async (code) => {
    receiver.status = code;
    const id = await dueEvent();
    expect(await deliverEvent(id)).toBe("dead");
    const row = await prisma.hubEvent.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ attempts: 1, lastStatusCode: code, nextAttemptAt: null, lastError: `Receiver refused (HTTP ${code}) — not retried` });
    expect(receiver.requests).toHaveLength(1);
    expect(await deliverEvent(id)).toBeNull();
  });

  it.each([200, 201, 202, 204])("counts an HTTP %i as delivered", async (code) => {
    receiver.status = code;
    const id = await dueEvent();
    expect(await deliverEvent(id)).toBe("delivered");
    expect((await prisma.hubEvent.findUniqueOrThrow({ where: { id } })).deliveredAt).not.toBeNull();
  });
});

describe("no address, no secret, two workers", () => {
  it("records no_target with no address, then Resend delivers it once an address is set (same event, history kept)", async () => {
    delete process.env.HUB_AGENT_WEBHOOK_URL;
    const lead = await makeLead("noaddr");
    const id = await emitHubEvent({ type: "lead.created", leadId: lead.id });
    let row = await prisma.hubEvent.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ status: "no_target", target: "admin", attempts: 0, nextAttemptAt: null, lastError: "No receiving address is set" });
    expect(await deliverDueEvents(prisma, FAR())).toBe(0);
    expect(receiver.requests).toHaveLength(0);

    process.env.HUB_AGENT_WEBHOOK_URL = receiver.url;
    const out = await resendEvent(id);
    expect(out).toMatchObject({ id, status: "delivered", attempts: 1 });
    row = await prisma.hubEvent.findUniqueOrThrow({ where: { id } });
    expect(row.payloadJson).toBe(receiver.requests[0].body);
    expect(receiver.requests[0].headers["x-rce-event-id"]).toBe(id);
  });

  it("never sends unsigned: with HUB_WEBHOOK_SECRET unset the event stays pending, no attempt is counted", async () => {
    delete process.env.HUB_WEBHOOK_SECRET;
    const id = await dueEvent();
    expect(await deliverEvent(id)).toBe("pending");
    const row = await prisma.hubEvent.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ status: "pending", attempts: 0, lastError: "HUB_WEBHOOK_SECRET not set" });
    expect(receiver.requests).toHaveLength(0);
    expect(await prisma.hubEventAttempt.count({ where: { eventId: id } })).toBe(0);
    // Set it, and the next pass delivers it.
    process.env.HUB_WEBHOOK_SECRET = SECRET;
    expect(await deliverDueEvents(prisma, FAR())).toBe(1);
    expect(receiver.requests).toHaveLength(1);
  });

  it("sends once when two worker runs overlap", async () => {
    receiver.delayMs = 150;
    const id = await dueEvent();
    const [a, b] = await Promise.all([deliverDueEvents(), deliverDueEvents()]);
    expect(a + b).toBe(1);
    expect(receiver.requests).toHaveLength(1);
    expect((await prisma.hubEvent.findUniqueOrThrow({ where: { id } })).status).toBe("delivered");
  });

  it("keeps event_id identical across attempts and after Resend", async () => {
    receiver.status = 500;
    const id = await dueEvent();
    await deliverEvent(id);
    await deliverEvent(id, prisma, FAR());
    receiver.status = 200;
    const out = await resendEvent(id);
    expect(out.id).toBe(id);
    expect(new Set(receiver.requests.map((r) => r.headers["x-rce-event-id"]))).toEqual(new Set([id]));
    expect(new Set(receiver.requests.map((r) => JSON.parse(r.body).event_id))).toEqual(new Set([id]));
    expect(new Set(receiver.requests.map((r) => r.body)).size).toBe(1);
    expect(await prisma.hubEventAttempt.count({ where: { eventId: id } })).toBe(3);
  });

  it("can Resend a dead event: one more try, history kept", async () => {
    receiver.status = 400;
    const id = await dueEvent();
    await deliverEvent(id);
    receiver.status = 200;
    const out = await resendEvent(id);
    expect(out.status).toBe("delivered");
    expect(await prisma.hubEventAttempt.count({ where: { eventId: id } })).toBe(2);
  });

  it("refuses to Resend a delivered event", async () => {
    const id = await dueEvent();
    await deliverEvent(id);
    await expect(resendEvent(id)).rejects.toMatchObject({ status: 409, message: RESEND_DELIVERED_REASON });
    expect(receiver.requests).toHaveLength(1);
  });
});

// ── the payload ──────────────────────────────────────────────────────────────────────────────────

describe("the payload is a closed shape", () => {
  it("is exactly event_id, type, occurred_at, ids and a summary: no name, link, phone, email or text", async () => {
    const lead = await prisma.lead.create({
      data: {
        name: `${TAG} Jane Q. Customer`, phone: "(615) 555-0188", email: "jane.q@example.com", address: "44 Secret Street, Franklin, TN 37064",
        notes: "Call after 5, the gate code is 4471", source: "web", platform: "google",
      },
    });
    const id = await emitHubEvent({ type: "lead.created", leadId: lead.id });
    const row = await prisma.hubEvent.findUniqueOrThrow({ where: { id } });
    const payload = JSON.parse(row.payloadJson) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(["event_id", "lead_id", "occurred_at", "platform", "source", "summary", "type", "urgent"]);
    for (const leaked of ["Jane", "Customer", "555-0188", "5550188", "jane.q", "example.com", "Secret Street", "gate code", "4471", "http", "/e/", "link"]) {
      expect(row.payloadJson).not.toContain(leaked);
    }
    expect(payload.summary).toBe("New lead from web");
  });

  it("keeps event_id exactly as the row id and the X-RCE-Event-Id header, even when the id's digits look like a phone number", async () => {
    // The scrubber reads the run 3714448041 in this UUID as a phone number: scrubbing the whole payload
    // used to turn the body's event_id into "...98a1-[withheld]b4" while the header kept the real one.
    const awkward = "9ed87cef-4366-4494-98a1-3714448041b4";
    expect((scrub({ event_id: awkward }, { withholdContact: true }) as { event_id: string }).event_id).not.toBe(awkward);
    uuidQueue.next.push(awkward);
    const lead = await makeLead("awkward id");
    const id = await emitHubEvent({ type: "lead.created", leadId: lead.id });
    expect(id).toBe(awkward);
    const row = await prisma.hubEvent.findUniqueOrThrow({ where: { id } });
    expect(JSON.parse(row.payloadJson).event_id).toBe(awkward);
    await waitFor(() => receiver.requests.some((r) => r.headers["x-rce-event-id"] === awkward));
    const got = receiver.requests.find((r) => r.headers["x-rce-event-id"] === awkward)!;
    expect(JSON.parse(got.body).event_id).toBe(got.headers["x-rce-event-id"]);
  });

  it("sends a lead's source and platform only from their closed lists, never the typed text", async () => {
    const lead = await prisma.lead.create({
      data: { name: `${TAG} Typed source`, source: "Referred by John Smith, gate code 4471", platform: "Mrs Jones next door" },
    });
    const id = await emitHubEvent({ type: "lead.created", leadId: lead.id });
    const row = await prisma.hubEvent.findUniqueOrThrow({ where: { id } });
    const payload = JSON.parse(row.payloadJson);
    expect(payload).toMatchObject({ source: "other", platform: null, summary: "New lead from other" });
    for (const leaked of ["John", "Smith", "gate code", "Jones", "Referred"]) expect(row.payloadJson).not.toContain(leaked);
    // A listed value still goes through as it is.
    const listed = await prisma.lead.create({ data: { name: `${TAG} Listed source`, source: "referral", platform: "google" } });
    const row2 = await prisma.hubEvent.findUniqueOrThrow({ where: { id: await emitHubEvent({ type: "lead.web_chat", leadId: listed.id }) } });
    expect(JSON.parse(row2.payloadJson)).toMatchObject({ source: "referral", platform: "google" });
  });

  it("never carries the reject reason or an edited text on approval.decided", async () => {
    const tech = await prisma.technician.create({ data: { name: `${TAG} Person`, accessToken: `hubev-${Math.random().toString(36).slice(2)}` } });
    techIds.push(tech.id);
    const thread = await ensureTeamThread(tech.id);
    const row = await prisma.hubMessage.create({
      data: {
        threadId: thread.id, authorType: "ai_agent", authorDisplay: "RCE Admin (AI)", channel: "sms", direction: "outbound", status: "rejected",
        body: "Hi Jane at 44 Secret Street", rejectedReason: "wrong customer, call 615-555-0199", actionKind: "customer_message",
      },
    });
    const id = await emitHubEvent({ type: "approval.decided", messageId: row.id, status: "rejected", resultIds: { messageId: row.id } });
    const ev = await prisma.hubEvent.findUniqueOrThrow({ where: { id } });
    const payload = JSON.parse(ev.payloadJson);
    expect(Object.keys(payload).sort()).toEqual(["action_kind", "event_id", "message_id", "occurred_at", "result_ids", "status", "summary", "thread_id", "type"]);
    expect(payload).toMatchObject({ action_kind: "customer_message", status: "rejected", message_id: row.id });
    for (const leaked of ["wrong customer", "555-0199", "Secret Street", "Jane"]) expect(ev.payloadJson).not.toContain(leaked);
  });

  it("carries a team message as ids only, with the context and no text", async () => {
    const tech = await prisma.technician.create({ data: { name: `${TAG} Eric Ward`, accessToken: `hubev-${Math.random().toString(36).slice(2)}` } });
    techIds.push(tech.id);
    const thread = await ensureTeamThread(tech.id);
    const reader: HubReader = { key: `tech:${tech.id}`, kind: "tech", display: "Eric", technicianId: tech.id, threadKinds: [], agentRole: null, agentKeyId: null, isKyle: false };
    const msg = await postMessage(reader, { threadId: thread.id, body: "Used 40 ft of 12 THHN at 12 Main St, call 615-555-0100" });
    await waitFor(async () => (await prisma.hubEvent.count({ where: { type: "message.team" } })) === 1);
    const ev = await prisma.hubEvent.findFirstOrThrow({ where: { type: "message.team" } });
    const payload = JSON.parse(ev.payloadJson);
    expect(Object.keys(payload).sort()).toEqual(["attachment_ids", "author_id", "author_type", "context", "event_id", "message_id", "occurred_at", "summary", "thread_id", "type"]);
    expect(payload).toMatchObject({ message_id: msg.id, thread_id: thread.id, author_type: "tech", author_id: tech.id, context: { kind: "team", id: thread.id }, attachment_ids: [] });
    for (const leaked of ["THHN", "Main St", "555-0100", "Eric"]) expect(ev.payloadJson).not.toContain(leaked);
  });

  it("has a builder for every event type in the shared list", () => {
    expect(HUB_EVENT_TYPES.length).toBe(12);
  });
});

// ── where each event goes (TC4) ──────────────────────────────────────────────────────────────────

describe("the per-event-type target table", () => {
  it("sends one team post to the Admin address and none to Inventory; material.used goes to Inventory", async () => {
    const inventory = await startReceiver();
    try {
      const token = await pinToken();
      await request(app).put("/owner-settings/agentWebhooks").set(bearer(token)).send({
        targets: [{ id: "admin", url: receiver.url, enabled: true }, { id: "inventory", url: inventory.url, enabled: true }], routes: {},
      }).expect(200);
      delete process.env.HUB_AGENT_WEBHOOK_URL;

      const tech = await prisma.technician.create({ data: { name: `${TAG} Poster`, accessToken: `hubev-${Math.random().toString(36).slice(2)}` } });
      techIds.push(tech.id);
      const thread = await ensureTeamThread(tech.id);
      const reader: HubReader = { key: `tech:${tech.id}`, kind: "tech", display: "P", technicianId: tech.id, threadKinds: [], agentRole: null, agentKeyId: null, isKyle: false };
      await postMessage(reader, { threadId: thread.id, body: "hello team" });
      await waitFor(() => receiver.requests.length === 1);
      expect(inventory.requests).toHaveLength(0);
      expect(JSON.parse(receiver.requests[0].body).type).toBe("message.team");
      expect(verify(receiver.requests[0])).toEqual({ ok: true });

      // material.used needs a real job; make one.
      const customer = await prisma.customer.create({ data: { name: `${TAG} Cust`, properties: { create: { name: "H", addressLine1: "1 A St", city: "X", state: "TN", postalCode: "37000" } } }, include: { properties: true } });
      const job = await prisma.visit.create({ data: { customerId: customer.id, propertyId: customer.properties[0].id, mode: "service_call" } });
      await emitHubEvent({ type: "material.used", jobId: job.id, movementIds: ["m1", "m2"], truckId: "t1" });
      await waitFor(() => inventory.requests.length === 1);
      expect(receiver.requests).toHaveLength(1);
      expect(JSON.parse(inventory.requests[0].body)).toMatchObject({ type: "material.used", job_id: job.id, movement_ids: ["m1", "m2"], line_count: 2 });
      expect(verify(inventory.requests[0])).toEqual({ ok: true });
      await prisma.hubEvent.deleteMany({ where: { type: "material.used" } }).catch(() => undefined);
      await prisma.visit.deleteMany({ where: { id: job.id } });
      await prisma.property.deleteMany({ where: { customerId: customer.id } });
      await prisma.customer.deleteMany({ where: { id: customer.id } });
    } finally {
      await inventory.close();
    }
  });

  it("records no_target without an error when the target has no address or is turned Off", async () => {
    const token = await pinToken();
    delete process.env.HUB_AGENT_WEBHOOK_URL;
    await request(app).put("/owner-settings/agentWebhooks").set(bearer(token)).send({
      targets: [{ id: "admin", url: receiver.url, enabled: false }, { id: "inventory", url: null, enabled: true }], routes: {},
    }).expect(200);
    const lead = await makeLead("off");
    const off = await emitHubEvent({ type: "lead.created", leadId: lead.id });
    expect(await prisma.hubEvent.findUniqueOrThrow({ where: { id: off } })).toMatchObject({ status: "no_target", lastError: "This agent is turned Off" });
    const customer = await prisma.customer.create({ data: { name: `${TAG} C2`, properties: { create: { name: "H", addressLine1: "1 A St", city: "X", state: "TN", postalCode: "37000" } } }, include: { properties: true } });
    const job = await prisma.visit.create({ data: { customerId: customer.id, propertyId: customer.properties[0].id, mode: "service_call" } });
    const none = await emitHubEvent({ type: "material.used", jobId: job.id, movementIds: ["m1"] });
    expect(await prisma.hubEvent.findUniqueOrThrow({ where: { id: none } })).toMatchObject({ status: "no_target", target: "inventory", lastError: "No receiving address is set" });
    expect(receiver.requests).toHaveLength(0);
    await prisma.hubEvent.deleteMany({ where: { id: { in: [none] } } });
    await prisma.visit.deleteMany({ where: { id: job.id } });
    await prisma.property.deleteMany({ where: { customerId: customer.id } });
    await prisma.customer.deleteMany({ where: { id: customer.id } });
  });

  it("follows a route Kyle changed", async () => {
    const token = await pinToken();
    delete process.env.HUB_AGENT_WEBHOOK_URL;
    const inventory = await startReceiver();
    try {
      await request(app).put("/owner-settings/agentWebhooks").set(bearer(token)).send({
        targets: [{ id: "admin", url: receiver.url, enabled: true }, { id: "inventory", url: inventory.url, enabled: true }],
        routes: { "lead.created": "inventory" },
      }).expect(200);
      const lead = await makeLead("rerouted");
      await emitHubEvent({ type: "lead.created", leadId: lead.id });
      await waitFor(() => inventory.requests.length === 1);
      expect(receiver.requests).toHaveLength(0);
    } finally {
      await inventory.close();
    }
  });
});

describe("the agentWebhooks setting", () => {
  it("is Kyle's alone: a login without his power and the AI admin are refused, an agent key never gets in", async () => {
    const kyle = await pinToken();
    const body = { targets: [{ id: "admin", url: "https://agents.example.com/hook", enabled: true }], routes: {} };
    await request(app).put("/owner-settings/agentWebhooks").set(bearer(kyle)).send(body).expect(200);
    const read = await request(app).get("/owner-settings/agentWebhooks").set(bearer(kyle)).expect(200);
    expect(read.body.value.targets[0].url).toBe("https://agents.example.com/hook");

    const michael = await personToken("michael-hook", ["bot_keys", "approve_drafts"]);
    expect((await request(app).put("/owner-settings/agentWebhooks").set(bearer(michael)).send(body)).status).toBe(403);
    expect((await request(app).get("/owner-settings/agentWebhooks").set(bearer(michael))).status).toBe(403);
    const ai = await aiAdminToken();
    expect((await request(app).put("/owner-settings/agentWebhooks").set(bearer(ai)).send(body)).status).toBe(403);
    expect((await request(app).get("/owner-settings/agentWebhooks").set(bearer(ai))).status).toBe(403);

    const { key } = await mintAgentKey({ name: `${TAG} key`, agentRole: "admin", createdBy: "owner" });
    const withKey = await request(app).get("/owner-settings/agentWebhooks").set(bearer(key));
    expect(withKey.status).toBe(401);
    expect(withKey.body.code).toBe("agent_key_not_accepted");
  });

  it.each([
    ["a javascript: address", "javascript:alert(1)"],
    ["an ftp address", "ftp://agents.example.com/x"],
    ["an address with a user name and password", "https://user:pass@agents.example.com/x"],
    ["plain text", "not a url"],
  ])("refuses %s", async (_label, url) => {
    const kyle = await pinToken();
    const res = await request(app).put("/owner-settings/agentWebhooks").set(bearer(kyle))
      .send({ targets: [{ id: "admin", url, enabled: true }], routes: {} });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/https:\/\//);
  });

  it("refuses an unknown event type or target, and an address over http in production", async () => {
    const kyle = await pinToken();
    expect((await request(app).put("/owner-settings/agentWebhooks").set(bearer(kyle)).send({ targets: [], routes: { "made.up": "admin" } })).status).toBe(400);
    expect((await request(app).put("/owner-settings/agentWebhooks").set(bearer(kyle)).send({ targets: [], routes: { "lead.created": "nobody" } })).status).toBe(400);
    expect((await request(app).put("/owner-settings/agentWebhooks").set(bearer(kyle)).send({ targets: [{ id: "admin", url: null, enabled: true }, { id: "admin", url: null, enabled: true }], routes: {} })).status).toBe(400);
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expect((await request(app).put("/owner-settings/agentWebhooks").set(bearer(kyle)).send({ targets: [{ id: "admin", url: "http://agents.example.com/x", enabled: true }], routes: {} })).status).toBe(400);
    } finally {
      process.env.NODE_ENV = saved;
    }
  });

  it("is NOT reachable through the open /crm/settings route (it is not on that allowlist)", async () => {
    const kyle = await pinToken();
    const put = await request(app).put("/crm/settings/agentWebhooks").set(bearer(kyle)).send({ targets: [{ id: "admin", url: "https://agents.example.com/x", enabled: true }], routes: {} });
    expect(put.status).toBe(400);
    expect(await prisma.companySetting.findUnique({ where: { key: "agentWebhooks" } })).toBeNull();
    // And once Kyle HAS saved addresses, the open list of settings never carries them.
    await request(app).put("/owner-settings/agentWebhooks").set(bearer(kyle)).send({ targets: [{ id: "admin", url: "https://agents.example.com/private", enabled: true }], routes: {} }).expect(200);
    const open = await request(app).get("/crm/settings").set(bearer(kyle)).expect(200);
    expect(open.body).not.toHaveProperty("agentWebhooks");
    expect(JSON.stringify(open.body)).not.toContain("agents.example.com");
  });

  it("is written by one function only: nothing else in src writes a HubEvent row, and the setting has no second writer", async () => {
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const creators: string[] = [];
    const settingWriters: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) { walk(full); continue; }
        if (!full.endsWith(".ts")) continue;
        const text = readFileSync(full, "utf8");
        if (/hubEvent\.(create|createMany|upsert)/.test(text) && !full.endsWith(join("services", "hubEvents.ts"))) creators.push(full);
        if (/agentWebhooks/.test(text) && /companySetting\.(upsert|create|update)/.test(text) && !full.endsWith(join("services", "ownerSettings.ts"))) settingWriters.push(full);
      }
    };
    walk(join(__dirname, "..", "src"));
    expect(creators).toEqual([]);
    expect(settingWriters).toEqual([]);
  });

  it("clears an address (the exit) and the target reads 'no address' again", async () => {
    const kyle = await pinToken();
    delete process.env.HUB_AGENT_WEBHOOK_URL;
    await request(app).put("/owner-settings/agentWebhooks").set(bearer(kyle)).send({ targets: [{ id: "admin", url: "https://agents.example.com/hook", enabled: true }], routes: {} }).expect(200);
    await request(app).put("/owner-settings/agentWebhooks").set(bearer(kyle)).send({ targets: [{ id: "admin", url: "", enabled: true }], routes: {} }).expect(200);
    const cfg = await request(app).get("/hub/events/config").set(bearer(kyle)).expect(200);
    expect(cfg.body).toMatchObject({ urlSet: false, secretSet: true });
  });
});

// ── the Agent events routes (BA5) ────────────────────────────────────────────────────────────────

describe("GET /hub/events, /hub/events/config and POST /hub/events/:id/resend", () => {
  it("lists newest first with the attempt history, filters by status and type, and pages", async () => {
    const kyle = await pinToken();
    receiver.status = 400;
    const dead = await dueEvent();
    await deliverEvent(dead);
    receiver.status = 200;
    const ok = await dueEvent();
    await deliverEvent(ok);
    delete process.env.HUB_AGENT_WEBHOOK_URL;
    const lead = await makeLead("nt");
    const noTarget = await emitHubEvent({ type: "lead.web_chat", leadId: lead.id });

    const all = await request(app).get("/hub/events").set(bearer(kyle)).expect(200);
    expect(all.body.events.map((e: { id: string }) => e.id)).toEqual([noTarget, ok, dead]);
    expect(all.body.events[2]).toMatchObject({ type: "lead.created", status: "dead", attempts: 1, lastStatusCode: 400, summary: "New lead from web" });
    expect(all.body.events[2].attemptLog).toHaveLength(1);
    expect(all.body.events[2].attemptLog[0]).toMatchObject({ statusCode: 400 });
    expect(all.body.events[0].createdAt).toMatch(/[+-]\d{2}:\d{2}$/);

    const only = async (q: string) => (await request(app).get(`/hub/events?${q}`).set(bearer(kyle)).expect(200)).body.events.map((e: { id: string }) => e.id);
    expect(await only("status=dead")).toEqual([dead]);
    expect(await only("status=delivered")).toEqual([ok]);
    expect(await only("status=no_target")).toEqual([noTarget]);
    expect(await only("status=retrying")).toEqual([]);
    expect(await only("type=lead.web_chat")).toEqual([noTarget]);
    const page = await request(app).get("/hub/events?limit=2").set(bearer(kyle)).expect(200);
    expect(page.body.events).toHaveLength(2);
    expect(page.body.nextBefore).toBeTruthy();
    expect((await request(app).get("/hub/events?status=bogus").set(bearer(kyle))).status).toBe(400);
    expect((await request(app).get("/hub/events?type=bogus").set(bearer(kyle))).status).toBe(400);
  });

  it("never returns the address or the secret from the config route, only two booleans", async () => {
    const kyle = await pinToken();
    process.env.HUB_AGENT_WEBHOOK_URL = "https://secret-agents.example.com/very/private/path";
    const res = await request(app).get("/hub/events/config").set(bearer(kyle)).expect(200);
    expect(res.body).toEqual({ urlSet: true, secretSet: true, adminEnvUrlSet: true, adminEnvUrlRefused: false });
    expect(JSON.stringify(res.body)).not.toContain("secret-agents");
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
    delete process.env.HUB_WEBHOOK_SECRET;
    expect((await request(app).get("/hub/events/config").set(bearer(kyle)).expect(200)).body.secretSet).toBe(false);
  });

  it("Resend on a dead event delivers it and appends an attempt; on a delivered one it is a 409 with the reason", async () => {
    const kyle = await pinToken();
    receiver.status = 410;
    const id = await dueEvent();
    await deliverEvent(id);
    receiver.status = 200;
    const res = await request(app).post(`/hub/events/${id}/resend`).set(bearer(kyle)).expect(200);
    expect(res.body.event).toMatchObject({ id, status: "delivered", attempts: 2 });
    expect(res.body.event.attemptLog).toHaveLength(2);
    const again = await request(app).post(`/hub/events/${id}/resend`).set(bearer(kyle));
    expect(again.status).toBe(409);
    expect(again.body.error).toBe(RESEND_DELIVERED_REASON);
    expect((await request(app).post("/hub/events/nope/resend").set(bearer(kyle))).status).toBe(404);
  });

  it("is behind bot_keys: Kyle and a login he gave the power pass; a plain login, the AI admin and an agent key do not", async () => {
    const kyle = await pinToken();
    expect((await request(app).get("/hub/events").set(bearer(kyle))).status).toBe(200);
    const granted = await personToken("granted", ["bot_keys"]);
    expect((await request(app).get("/hub/events").set(bearer(granted))).status).toBe(200);
    const plain = await personToken("plain");
    expect((await request(app).get("/hub/events").set(bearer(plain))).status).toBe(403);
    expect((await request(app).get("/hub/events/config").set(bearer(plain))).status).toBe(403);
    expect((await request(app).post("/hub/events/x/resend").set(bearer(plain))).status).toBe(403);
    const ai = await aiAdminToken();
    expect((await request(app).get("/hub/events").set(bearer(ai))).status).toBe(403);
    expect((await request(app).get("/hub/events")).status).toBe(401);
    const { key } = await mintAgentKey({ name: `${TAG} key2`, agentRole: "admin", createdBy: "owner" });
    const withKey = await request(app).get("/hub/events").set(bearer(key));
    expect(withKey.status).toBe(401);
    expect(withKey.body.code).toBe("agent_key_not_accepted");
    expect((await request(app).post("/hub/events/x/resend").set(bearer(key))).status).toBe(401);
  });
});


// ── the receiving address: the Railway variable gets the same rules as the setting ──────────────────

describe("HUB_AGENT_WEBHOOK_URL", () => {
  it("is refused when it carries a user name and password: nothing is sent, the event is kept with the reason", async () => {
    process.env.HUB_AGENT_WEBHOOK_URL = "https://agent:hunter2@receiver.example.com/hook";
    const lead = await makeLead("env creds");
    const id = await emitHubEvent({ type: "lead.created", leadId: lead.id });
    const row = await prisma.hubEvent.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ status: "no_target", lastError: "HUB_AGENT_WEBHOOK_URL is not an allowed https address", nextAttemptAt: null });
    expect(receiver.requests).toHaveLength(0);
    const kyle = await pinToken();
    const cfg = await request(app).get("/hub/events/config").set(bearer(kyle)).expect(200);
    expect(cfg.body).toEqual({ urlSet: false, secretSet: true, adminEnvUrlSet: false, adminEnvUrlRefused: true });
    expect(JSON.stringify(cfg.body)).not.toContain("hunter2");
  });

  it("is refused as plain http in production, and allowed as https", async () => {
    const savedEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = "production";
      process.env.HUB_AGENT_WEBHOOK_URL = "http://receiver.example.com/hook";
      const lead = await makeLead("env http");
      const id = await emitHubEvent({ type: "lead.created", leadId: lead.id });
      expect(await prisma.hubEvent.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "no_target" });
      process.env.HUB_AGENT_WEBHOOK_URL = "https://receiver.example.com/hook";
      const kyle = await pinToken();
      const cfg = await request(app).get("/hub/events/config").set(bearer(kyle)).expect(200);
      expect(cfg.body).toMatchObject({ urlSet: true, adminEnvUrlSet: true, adminEnvUrlRefused: false });
    } finally {
      if (savedEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = savedEnv;
    }
  });

  it("is still reported as a boolean when an Admin address is also saved (the card needs it for its Remove wording)", async () => {
    const kyle = await pinToken();
    await request(app).put("/owner-settings/agentWebhooks").set(bearer(kyle)).send({ targets: [{ id: "admin", url: "https://agents.example.com/hook", enabled: true }], routes: {} }).expect(200);
    const cfg = await request(app).get("/hub/events/config").set(bearer(kyle)).expect(200);
    expect(cfg.body).toEqual({ urlSet: true, secretSet: true, adminEnvUrlSet: true, adminEnvUrlRefused: false });
  });
});

describe("the no-address banner follows Admin, not Inventory", () => {
  it("reports urlSet false when only the Inventory address is saved", async () => {
    const kyle = await pinToken();
    delete process.env.HUB_AGENT_WEBHOOK_URL;
    await request(app).put("/owner-settings/agentWebhooks").set(bearer(kyle))
      .send({ targets: [{ id: "inventory", url: "https://inventory.example.com/hook", enabled: true }], routes: {} }).expect(200);
    const cfg = await request(app).get("/hub/events/config").set(bearer(kyle)).expect(200);
    expect(cfg.body).toEqual({ urlSet: false, secretSet: true, adminEnvUrlSet: false, adminEnvUrlRefused: false });
    // And an Admin event really is kept with no address.
    const lead = await makeLead("inv only");
    const id = await emitHubEvent({ type: "lead.created", leadId: lead.id });
    expect((await prisma.hubEvent.findUniqueOrThrow({ where: { id } })).status).toBe("no_target");
  });
});

// ── Resend while an attempt is on the wire ───────────────────────────────────────────────────────

describe("an attempt that has been taken over", () => {
  it("does not overwrite the newer status: a delivered event is not shown Retrying by the slower attempt's 5xx", async () => {
    const id = await dueEvent();
    receiver.status = 503;
    receiver.delayMs = 300;
    const slow = deliverEvent(id);
    await waitFor(() => receiver.requests.length === 1);
    // While that POST is out, another attempt (a Resend) delivers the event.
    await prisma.hubEvent.update({ where: { id }, data: { status: "delivered", nextAttemptAt: null, deliveredAt: new Date(), lastError: null, lastStatusCode: 200, attempts: 1 } });
    expect(await slow).toBe("delivered");
    const row = await prisma.hubEvent.findUniqueOrThrow({ where: { id }, include: { attemptLog: true } });
    expect(row).toMatchObject({ status: "delivered", lastStatusCode: 200, lastError: null });
    expect(row.nextAttemptAt).toBeNull();
    expect(row.attemptLog).toHaveLength(1); // the slower attempt is still logged
  });

  it("refuses a Resend while that event's POST is in flight (409), so it cannot be sent twice at once", async () => {
    const id = await dueEvent();
    receiver.delayMs = 300;
    const slow = deliverEvent(id);
    await waitFor(() => receiver.requests.length === 1);
    await expect(resendEvent(id)).rejects.toMatchObject({ status: 409, message: expect.stringContaining("being sent right now") });
    expect(await slow).toBe("delivered");
    expect(receiver.requests).toHaveLength(1);
  });
});
