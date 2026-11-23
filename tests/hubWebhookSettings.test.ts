/**
 * Webhook delivery settings (work order C6b, the Grok team's request of 2026-11-22), against a real
 * local HTTP receiver: custom headers per agent (validated, encrypted at rest, masked in every answer,
 * sent on every delivery, retry, Resend and test), a per-agent HMAC signing secret (shown once,
 * regenerated, one signing rule with Admin's HUB_WEBHOOK_SECRET fallback), "Send test event" (a signed
 * test.ping, recorded, never retried, never routed) and the per-agent filter on the Agent events log.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createDecipheriv, createHmac, hkdfSync, randomUUID } from "node:crypto";
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
  return { google: { auth: { OAuth2: MockOAuth2 }, calendar: () => ({ freebusy: { query: vi.fn() }, events: { list: vi.fn(), delete: vi.fn() } }) } };
});

import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { hashPin } from "../src/middleware/pinAuth";
import { saveAdminLogin } from "../src/services/adminLogin";
import { saveCrmLogin, setPowers } from "../src/services/crmLogin";
import { mintAgentKey } from "../src/agentApi/keys";
import { _setDeliveryTimeoutMsForTests, deliverDueEvents, deliverEvent, emitHubEvent, resendEvent } from "../src/services/hubEvents";
import {
  SETTING_SECRETS_INFO, SettingSecretsError, decryptSecret, encryptSecret, generateSigningSecret, maskSecret, settingSecretsAvailable,
} from "../src/services/settingSecrets";
import { DEFAULT_EVENT_ROUTES, HUB_EVENT_TYPES, HUB_TEST_EVENT_TYPE, TEST_RESEND_REASON, splitWireBody } from "../shared/hub/events";
import { cleanupCrmLoginFixtures, makePerson } from "./helpers/crmLoginFixture";

const TAG = "HubWh";
const ENV_SECRET = "env-secret-0123456789";
const PEPPER = "test-pepper-for-the-webhook-settings";
const PIN = "1234";
const PASS = "correct horse battery";
const AI_PASS = "another long password!";
const AUTH_VALUE = "Bearer sk-live-abcdef0123456789WXYZ";
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const PEPPER_REASON = "Set AGENT_KEY_PEPPER in Railway first.";

// ── a real receiver ──────────────────────────────────────────────────────────────────────────────

interface Received { headers: http.IncomingHttpHeaders; body: string }
interface Receiver { url: string; requests: Received[]; status: number; delayMs: number; close: () => Promise<void> }

async function startReceiver(): Promise<Receiver> {
  const r: Receiver = { url: "", requests: [], status: 200, delayMs: 0, close: async () => undefined };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      r.requests.push({ headers: req.headers, body });
      setTimeout(() => { res.statusCode = r.status; res.end("ok"); }, r.delayMs);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  r.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
  r.close = () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
  return r;
}

/**
 * The W2 receiver recipe (Kyle 2026-11-23): the signed text is the payload WITHOUT the timestamp and signature members that end the wire
 * body (cut at the last `,"timestamp":`, add `}`); the headers carry the same timestamp and signature.
 */
function verify(req: Received, secret: string): boolean {
  const ts = String(req.headers["x-rce-timestamp"] ?? "");
  const wire = splitWireBody(req.body);
  if (!wire || wire.timestamp !== ts || wire.signature !== req.headers["x-rce-signature"]) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(`${ts}.${wire.payloadJson}`).digest("hex")}`;
  return req.headers["x-rce-signature"] === expected;
}

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────────

let savedPin: string | undefined;
let savedPepper: string | undefined;
let savedSecret: string | undefined;
let savedUrl: string | undefined;
let admin: Receiver;
let inventory: Receiver;
let logged: string[] = [];

async function wipe() {
  await prisma.hubEventAttempt.deleteMany();
  await prisma.hubEvent.deleteMany();
  await prisma.companySetting.deleteMany({ where: { key: "agentWebhooks" } });
  await prisma.systemEvent.deleteMany({ where: { source: "agent_events" } });
}

beforeAll(async () => {
  savedPin = process.env.PIN_HASH;
  savedPepper = process.env.AGENT_KEY_PEPPER;
  savedSecret = process.env.HUB_WEBHOOK_SECRET;
  savedUrl = process.env.HUB_AGENT_WEBHOOK_URL;
  process.env.PIN_HASH = await hashPin(PIN);
});
afterAll(async () => {
  const restore = (k: string, v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
  restore("PIN_HASH", savedPin);
  restore("AGENT_KEY_PEPPER", savedPepper);
  restore("HUB_WEBHOOK_SECRET", savedSecret);
  restore("HUB_AGENT_WEBHOOK_URL", savedUrl);
  await wipe();
  await prisma.agentKey.deleteMany({ where: { name: { startsWith: TAG } } });
  await prisma.lead.deleteMany({ where: { name: { startsWith: TAG } } });
  await cleanupCrmLoginFixtures();
});
beforeEach(async () => {
  await wipe();
  await cleanupCrmLoginFixtures();
  admin = await startReceiver();
  inventory = await startReceiver();
  process.env.AGENT_KEY_PEPPER = PEPPER;
  process.env.HUB_WEBHOOK_SECRET = ENV_SECRET;
  delete process.env.HUB_AGENT_WEBHOOK_URL;
  _setDeliveryTimeoutMsForTests(10_000);
  logged = [];
  for (const fn of ["log", "info", "warn", "error"] as const) {
    vi.spyOn(console, fn).mockImplementation((...args: unknown[]) => { logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")); });
  }
});
afterEach(async () => {
  vi.restoreAllMocks();
  await new Promise((r) => setTimeout(r, 60));
  await admin.close();
  await inventory.close();
});

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

type HeaderIn = { name: string; value?: string };
type TargetIn = { url?: string | null; enabled?: boolean; headers?: HeaderIn[] };
function body(a: TargetIn = {}, i: TargetIn = {}, routes: Record<string, string> = {}) {
  const t = (id: string, x: TargetIn) => ({
    id, url: x.url === undefined ? null : x.url, enabled: x.enabled ?? true, ...(x.headers ? { headers: x.headers } : {}),
  });
  return { targets: [t("admin", a), t("inventory", i)], routes };
}
const put = (token: string, b: unknown) => request(app).put("/owner-settings/agentWebhooks").set(bearer(token)).send(b as object);
const read = async (token: string) => (await request(app).get("/owner-settings/agentWebhooks").set(bearer(token)).expect(200)).body;

/** A due, undelivered event for a target, made without going through the emitter (so nothing is sent while it is built). */
async function rawEvent(target: "admin" | "inventory"): Promise<string> {
  const id = randomUUID();
  await prisma.hubEvent.create({
    data: {
      id, eventKey: randomUUID(), type: "lead.created", target, status: "pending", nextAttemptAt: new Date(),
      payloadJson: JSON.stringify({ event_id: id, type: "lead.created", occurred_at: "2026-11-22T10:00:00-06:00", lead_id: "x", summary: "New lead from web" }),
    },
  });
  return id;
}

// ── the encryption module ────────────────────────────────────────────────────────────────────────

describe("services/settingSecrets", () => {
  beforeEach(() => { process.env.AGENT_KEY_PEPPER = PEPPER; });

  it("round-trips a value, with a fresh random IV each time and nothing readable in the stored text", () => {
    const a = encryptSecret(AUTH_VALUE);
    const b = encryptSecret(AUTH_VALUE);
    expect(a).not.toBe(b);
    expect(a).not.toContain("sk-live");
    expect(decryptSecret(a)).toBe(AUTH_VALUE);
    expect(decryptSecret(b)).toBe(AUTH_VALUE);
    const parts = a.split(".");
    expect(parts[0]).toBe("v1");
    expect(Buffer.from(parts[1], "base64url")).toHaveLength(12); // IV
    expect(Buffer.from(parts[2], "base64url")).toHaveLength(16); // GCM auth tag
  });

  it("is AES-256-GCM under an HKDF-SHA256 key from AGENT_KEY_PEPPER with its own info label", () => {
    const stored = encryptSecret("plain-text-value");
    const [, iv, tag, ct] = stored.split(".");
    const key = Buffer.from(hkdfSync("sha256", PEPPER, Buffer.from("rce-setting-secrets-salt-v1"), SETTING_SECRETS_INFO, 32));
    expect(SETTING_SECRETS_INFO).toBe("rce-webhook-secrets-v1");
    const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
    d.setAuthTag(Buffer.from(tag, "base64url"));
    expect(Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8")).toBe("plain-text-value");
  });

  it("refuses a tampered value and a different pepper, and fails closed with no pepper", () => {
    const stored = encryptSecret("hello world value");
    const [v, iv, tag, ct] = stored.split(".");
    const flipped = Buffer.from(ct, "base64url");
    flipped[0] ^= 1;
    expect(() => decryptSecret([v, iv, tag, flipped.toString("base64url")].join("."))).toThrow(SettingSecretsError);
    expect(() => decryptSecret("not-a-stored-secret")).toThrow(SettingSecretsError);
    process.env.AGENT_KEY_PEPPER = "another pepper";
    expect(() => decryptSecret(stored)).toThrow(SettingSecretsError);
    delete process.env.AGENT_KEY_PEPPER;
    expect(settingSecretsAvailable()).toBe(false);
    expect(() => encryptSecret("x")).toThrow(PEPPER_REASON);
    expect(() => decryptSecret(stored)).toThrow(PEPPER_REASON);
  });

  it("makes a 32-byte base64url signing secret and masks to the last four (bullets only when too short)", () => {
    const s = generateSigningSecret();
    expect(s).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateSigningSecret()).not.toBe(s);
    expect(maskSecret(AUTH_VALUE)).toBe("••••WXYZ");
    expect(maskSecret("abc")).toBe("••••");
  });
});

// ── custom headers ───────────────────────────────────────────────────────────────────────────────

describe("custom headers: what a save accepts and refuses", () => {
  it.each([
    ["an X-RCE header", "X-RCE-Anything"],
    ["a lower-case x-rce header", "x-rce-signature"],
    ["Content-Type", "Content-Type"],
    ["content-length in lower case", "content-length"],
    ["HOST in capitals", "HOST"],
    ["Transfer-Encoding", "Transfer-Encoding"],
    ["Connection", "connection"],
    // Node's fetch throws on these before sending anything, which would fail every delivery.
    ["Keep-Alive", "Keep-Alive"],
    ["Upgrade", "upgrade"],
    ["Expect", "EXPECT"],
  ])("refuses %s as a name", async (_label, name) => {
    const kyle = await pinToken();
    const res = await put(kyle, body({ url: admin.url, headers: [{ name, value: "v-value-123" }] }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/set by the CRM itself/);
    expect(await prisma.companySetting.findUnique({ where: { key: "agentWebhooks" } })).toBeNull();
  });

  it.each([
    ["a name with a space", "Bad Name"],
    ["a name with a colon", "Bad:Name"],
    ["an empty name", ""],
    ["a name with a line break", "Bad\r\nName"],
  ])("refuses %s", async (_label, name) => {
    const kyle = await pinToken();
    expect((await put(kyle, body({ url: admin.url, headers: [{ name, value: "v-value-123" }] }))).status).toBe(400);
  });

  it.each([
    ["a line feed", "ok\nX-Injected: 1"],
    ["a carriage return", "ok\rX-Injected: 1"],
    ["a CRLF pair", "ok\r\nX-Injected: 1"],
    ["a NUL", "ok\u0000more"],
    ["a tab", "ok\tmore"],
    ["a non-ASCII character", "okay-é-more"],
    ["an empty value", ""],
    ["a value over 2000 characters", "x".repeat(2001)],
  ])("refuses a value with %s (header injection)", async (_label, value) => {
    const kyle = await pinToken();
    const res = await put(kyle, body({ url: admin.url, headers: [{ name: "Authorization", value }] }));
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain("X-Injected");
    expect(await prisma.companySetting.findUnique({ where: { key: "agentWebhooks" } })).toBeNull();
  });

  it("allows five headers and refuses a sixth, and the same name twice (any case)", async () => {
    const kyle = await pinToken();
    const five = ["A-One", "A-Two", "A-Three", "A-Four", "A-Five"].map((name) => ({ name, value: "value-12345" }));
    await put(kyle, body({ url: admin.url, headers: five })).expect(200);
    const six = [...five, { name: "A-Six", value: "value-12345" }];
    const res = await put(kyle, body({ url: admin.url, headers: six }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/At most 5/);
    const dup = await put(kyle, body({ url: admin.url, headers: [{ name: "X-Key", value: "value-12345" }, { name: "x-key", value: "value-67890" }] }));
    expect(dup.status).toBe(400);
    expect(dup.body.error).toMatch(/once/);
  });

  it("refuses a header with no value when there is nothing stored under that name", async () => {
    const kyle = await pinToken();
    const res = await put(kyle, body({ url: admin.url, headers: [{ name: "Authorization" }] }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Enter a value for the "Authorization" header/);
  });

  it("a header stored under a name that is reserved today keeps the row readable, is skipped when sending, can be kept or removed, and cannot be added again", async () => {
    const kyle = await pinToken();
    await put(kyle, body({ url: admin.url, headers: [{ name: "Legacy-One", value: "legacy-value-123" }] })).expect(200);
    const stored = await prisma.companySetting.findUniqueOrThrow({ where: { key: "agentWebhooks" } });
    expect(stored.valueJson).toContain('"name":"Legacy-One"');
    await prisma.companySetting.update({ where: { key: "agentWebhooks" }, data: { valueJson: stored.valueJson.replace('"name":"Legacy-One"', '"name":"Keep-Alive"') } });
    // The row still reads: the address and the header are not wiped back to the defaults.
    const got = await read(kyle);
    expect(got.value.targets[0].url).toBe(admin.url);
    expect(got.value.targets[0].headers).toEqual([{ name: "Keep-Alive", masked: "••••-123" }]);
    // A delivery goes out (the refused name is skipped, so fetch does not throw) and carries no such header.
    const id = await rawEvent("admin");
    await deliverEvent(id);
    expect((await prisma.hubEvent.findUniqueOrThrow({ where: { id } })).status).toBe("delivered");
    expect(admin.requests[0].headers["keep-alive"]).toBeUndefined();
    // Saving another header leaves the old one alone; the same reserved name cannot be entered anew.
    await put(kyle, body({ url: admin.url, headers: [{ name: "Keep-Alive" }, { name: "Authorization", value: AUTH_VALUE }] })).expect(200);
    expect((await read(kyle)).value.targets[0].headers.map((h: { name: string }) => h.name)).toEqual(["Keep-Alive", "Authorization"]);
    expect((await put(kyle, body({ url: admin.url, headers: [{ name: "Keep-Alive", value: "new-value-123" }] }))).status).toBe(400);
    // Remove header (the exit) works.
    await put(kyle, body({ url: admin.url, headers: [{ name: "Authorization" }] })).expect(200);
    expect((await read(kyle)).value.targets[0].headers.map((h: { name: string }) => h.name)).toEqual(["Authorization"]);
  });

  it("fails closed with no AGENT_KEY_PEPPER: a new value and a new signing secret are refused, addresses still save", async () => {
    const kyle = await pinToken();
    delete process.env.AGENT_KEY_PEPPER;
    const refused = await put(kyle, body({ url: admin.url, headers: [{ name: "Authorization", value: AUTH_VALUE }] }));
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe(PEPPER_REASON);
    const gen = await request(app).post("/hub/webhooks/admin/signing-secret").set(bearer(kyle));
    expect(gen.status).toBe(409);
    expect(gen.body.error).toBe(PEPPER_REASON);
    await put(kyle, body({ url: admin.url })).expect(200);
    expect((await read(kyle)).status).toEqual({ pepperSet: false });
    process.env.AGENT_KEY_PEPPER = PEPPER;
    expect((await read(kyle)).status).toEqual({ pepperSet: true });
  });
});

describe("custom headers: stored encrypted, masked in every answer", () => {
  it("never returns the value or the ciphertext: PUT and GET show the name and •••• + last four", async () => {
    const kyle = await pinToken();
    const saved = await put(kyle, body({ url: admin.url, headers: [{ name: "Authorization", value: AUTH_VALUE }] })).expect(200);
    const got = await read(kyle);
    for (const answer of [saved.body, got]) {
      expect(answer.value.targets[0].headers).toEqual([{ name: "Authorization", masked: "••••WXYZ" }]);
      const text = JSON.stringify(answer);
      expect(text).not.toContain("sk-live");
      expect(text).not.toContain(AUTH_VALUE);
      expect(text).not.toContain('"enc"');
      expect(text).not.toContain(PEPPER);
    }
    // At rest: ciphertext only.
    const row = await prisma.companySetting.findUniqueOrThrow({ where: { key: "agentWebhooks" } });
    expect(row.valueJson).not.toContain("sk-live");
    expect(row.valueJson).toContain('"enc"');
    // The open settings list never carries it either.
    expect(JSON.stringify((await request(app).get("/crm/settings").set(bearer(kyle)).expect(200)).body)).not.toContain("Authorization");
  });

  it("keeps a header whose value is not re-entered, replaces one that is, and removes one that is left out", async () => {
    const kyle = await pinToken();
    await put(kyle, body({ url: admin.url, headers: [{ name: "Authorization", value: AUTH_VALUE }, { name: "X-Api-Key", value: "key-value-AAAA1111" }] })).expect(200);
    // Same names, no values (any case): both kept.
    await put(kyle, body({ url: admin.url, headers: [{ name: "authorization" }, { name: "X-Api-Key" }] })).expect(200);
    // No `headers` at all (a plain address save): kept.
    await put(kyle, body({ url: admin.url, enabled: true })).expect(200);
    let id = await rawEvent("admin");
    await deliverEvent(id);
    expect(admin.requests[0].headers.authorization).toBe(AUTH_VALUE);
    expect(admin.requests[0].headers["x-api-key"]).toBe("key-value-AAAA1111");
    // Edit the value (re-enter it).
    await put(kyle, body({ url: admin.url, headers: [{ name: "Authorization", value: "Bearer replaced-value-QQQQ" }, { name: "X-Api-Key" }] })).expect(200);
    expect((await read(kyle)).value.targets[0].headers).toEqual([{ name: "Authorization", masked: "••••QQQQ" }, { name: "X-Api-Key", masked: "••••1111" }]);
    id = await rawEvent("admin");
    await deliverEvent(id);
    expect(admin.requests[1].headers.authorization).toBe("Bearer replaced-value-QQQQ");
    // Remove one (the exit): left out of the list.
    await put(kyle, body({ url: admin.url, headers: [{ name: "X-Api-Key" }] })).expect(200);
    id = await rawEvent("admin");
    await deliverEvent(id);
    expect(admin.requests[2].headers.authorization).toBeUndefined();
    expect(admin.requests[2].headers["x-api-key"]).toBe("key-value-AAAA1111");
    // Remove all.
    await put(kyle, body({ url: admin.url, headers: [] })).expect(200);
    expect((await read(kyle)).value.targets[0].headers).toEqual([]);
  });

  it("keeps each agent's headers apart", async () => {
    const kyle = await pinToken();
    await put(kyle, body({ url: admin.url, headers: [{ name: "Authorization", value: "Bearer admin-token-1111" }] }, { url: inventory.url, headers: [{ name: "Authorization", value: "Bearer inventory-token-2222" }] })).expect(200);
    await request(app).post("/hub/webhooks/inventory/signing-secret").set(bearer(kyle)).expect(200);
    await deliverEvent(await rawEvent("admin"));
    await deliverEvent(await rawEvent("inventory"));
    expect(admin.requests[0].headers.authorization).toBe("Bearer admin-token-1111");
    expect(inventory.requests[0].headers.authorization).toBe("Bearer inventory-token-2222");
  });
});

describe("custom headers: sent on every delivery, retry and Resend, beside the X-RCE headers", () => {
  it("carries them on the first try, the retry and a Resend; the signature still verifies and a header can never replace it", async () => {
    const kyle = await pinToken();
    await put(kyle, body({ url: admin.url, headers: [{ name: "Authorization", value: AUTH_VALUE }] })).expect(200);
    const id = await rawEvent("admin");
    admin.status = 503;
    await deliverEvent(id);
    admin.status = 200;
    await deliverEvent(id, prisma, new Date(Date.now() + 60_000));
    expect((await prisma.hubEvent.findUniqueOrThrow({ where: { id } })).status).toBe("delivered");
    expect(admin.requests).toHaveLength(2);
    for (const r of admin.requests) {
      expect(r.headers.authorization).toBe(AUTH_VALUE);
      expect(r.headers["x-rce-event-id"]).toBe(id);
      expect(r.headers["content-type"]).toBe("application/json");
      expect(verify(r, ENV_SECRET)).toBe(true);
      expect(r.body).not.toContain("sk-live");
    }
    // Resend (a dead one) carries it too.
    const dead = await rawEvent("admin");
    admin.status = 400;
    await deliverEvent(dead);
    admin.status = 200;
    await resendEvent(dead);
    expect(admin.requests.at(-1)?.headers.authorization).toBe(AUTH_VALUE);
  });

  it("with the pepper gone it sends nothing, counts no attempt, and says why without any value", async () => {
    const kyle = await pinToken();
    await put(kyle, body({ url: admin.url, headers: [{ name: "Authorization", value: AUTH_VALUE }] })).expect(200);
    const id = await rawEvent("admin");
    delete process.env.AGENT_KEY_PEPPER;
    await deliverEvent(id);
    const row = await prisma.hubEvent.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ status: "pending", attempts: 0, lastError: "A custom header could not be read - is AGENT_KEY_PEPPER set?" });
    expect(admin.requests).toHaveLength(0);
  });
});

// ── the signing secret ───────────────────────────────────────────────────────────────────────────

describe("the per-agent signing secret", () => {
  it("is shown once on create, kept encrypted, masked afterwards, and signs the agent's events", async () => {
    const kyle = await pinToken();
    await put(kyle, body({ url: admin.url })).expect(200);
    expect((await read(kyle)).value.targets[0]).toMatchObject({ signingSecret: null, secretSource: "env" });

    const made = await request(app).post("/hub/webhooks/admin/signing-secret").set(bearer(kyle)).expect(200);
    const secret = made.body.secret as string;
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    expect(made.body).toMatchObject({ masked: `••••${secret.slice(-4)}`, replaced: false });
    expect(made.headers["cache-control"]).toBe("no-store");

    const got = await read(kyle);
    expect(got.value.targets[0]).toMatchObject({ secretSource: "own", signingSecret: { masked: `••••${secret.slice(-4)}` } });
    expect(JSON.stringify(got)).not.toContain(secret);
    expect(JSON.stringify(await request(app).put("/owner-settings/agentWebhooks").set(bearer(kyle)).send(body({ url: admin.url })).then((r) => r.body))).not.toContain(secret);
    const row = await prisma.companySetting.findUniqueOrThrow({ where: { key: "agentWebhooks" } });
    expect(row.valueJson).not.toContain(secret);

    // A plain save did not lose it; the event is signed with it, not with HUB_WEBHOOK_SECRET.
    await deliverEvent(await rawEvent("admin"));
    expect(verify(admin.requests[0], secret)).toBe(true);
    expect(verify(admin.requests[0], ENV_SECRET)).toBe(false);
  });

  it("Regenerate replaces it at once: the old one stops signing, the new one signs", async () => {
    const kyle = await pinToken();
    await put(kyle, body({ url: admin.url })).expect(200);
    const first = (await request(app).post("/hub/webhooks/admin/signing-secret").set(bearer(kyle)).expect(200)).body.secret as string;
    const second = await request(app).post("/hub/webhooks/admin/signing-secret").set(bearer(kyle)).expect(200);
    expect(second.body.replaced).toBe(true);
    expect(second.body.secret).not.toBe(first);
    await deliverEvent(await rawEvent("admin"));
    expect(verify(admin.requests[0], second.body.secret)).toBe(true);
    expect(verify(admin.requests[0], first)).toBe(false);
  });

  it("Admin with none signs with HUB_WEBHOOK_SECRET; removing the own secret goes back to it; the card says which is in use", async () => {
    const kyle = await pinToken();
    await put(kyle, body({ url: admin.url })).expect(200);
    await request(app).post("/hub/webhooks/admin/signing-secret").set(bearer(kyle)).expect(200);
    expect((await request(app).delete("/hub/webhooks/admin/signing-secret").set(bearer(kyle)).expect(200)).body).toEqual({ removed: true });
    expect((await read(kyle)).value.targets[0]).toMatchObject({ signingSecret: null, secretSource: "env" });
    await deliverEvent(await rawEvent("admin"));
    expect(verify(admin.requests[0], ENV_SECRET)).toBe(true);
    // No env secret and none of its own: kept, not sent.
    delete process.env.HUB_WEBHOOK_SECRET;
    expect((await read(kyle)).value.targets[0].secretSource).toBe("none");
    const id = await rawEvent("admin");
    await deliverEvent(id);
    expect(await prisma.hubEvent.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "pending", attempts: 0, lastError: "HUB_WEBHOOK_SECRET not set" });
    expect(admin.requests).toHaveLength(1);
  });

  it("Inventory has no fallback: with no secret of its own its events are kept, not sent, until it has one", async () => {
    const kyle = await pinToken();
    await put(kyle, body({}, { url: inventory.url })).expect(200);
    expect((await read(kyle)).value.targets[1]).toMatchObject({ secretSource: "none" });
    const id = await rawEvent("inventory");
    await deliverEvent(id);
    expect(await prisma.hubEvent.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "pending", attempts: 0, lastError: "No signing secret is set for Inventory" });
    expect(inventory.requests).toHaveLength(0);
    const secret = (await request(app).post("/hub/webhooks/inventory/signing-secret").set(bearer(kyle)).expect(200)).body.secret as string;
    await resendEvent(id);
    expect(inventory.requests).toHaveLength(1);
    expect(verify(inventory.requests[0], secret)).toBe(true);
    expect((await prisma.hubEvent.findUniqueOrThrow({ where: { id } })).status).toBe("delivered");
  });
});

// ── the test event ───────────────────────────────────────────────────────────────────────────────

describe("Send test event", () => {
  it("delivers one signed test.ping with the custom headers, answers the status and time, and logs it as a HubEvent", async () => {
    const kyle = await pinToken();
    await put(kyle, body({ url: admin.url, headers: [{ name: "Authorization", value: AUTH_VALUE }] })).expect(200);
    const res = await request(app).post("/hub/webhooks/admin/test").set(bearer(kyle)).expect(200);
    expect(res.body).toMatchObject({ statusCode: 200, error: null });
    expect(typeof res.body.ms).toBe("number");
    expect(res.body.event).toMatchObject({ type: "test.ping", status: "delivered", target: "admin", attempts: 1, lastStatusCode: 200 });

    expect(admin.requests).toHaveLength(1);
    const sent = admin.requests[0];
    const payload = JSON.parse(sent.body);
    // W2: the wire body carries the signature and timestamp as well; the STORED payload is still exactly the four fields.
    expect(Object.keys(payload).sort()).toEqual(["event_id", "occurred_at", "signature", "target", "timestamp", "type"]);
    expect(Object.keys(JSON.parse(splitWireBody(sent.body)!.payloadJson)).sort()).toEqual(["event_id", "occurred_at", "target", "type"]);
    expect(payload).toMatchObject({ type: "test.ping", target: "admin", event_id: res.body.event.id });
    expect(payload.occurred_at).toMatch(/[+-]\d{2}:\d{2}$/);
    expect(sent.headers["x-rce-event-id"]).toBe(payload.event_id);
    expect(sent.headers.authorization).toBe(AUTH_VALUE);
    expect(verify(sent, ENV_SECRET)).toBe(true);

    const row = await prisma.hubEvent.findUniqueOrThrow({ where: { id: payload.event_id } });
    expect(row).toMatchObject({ type: "test.ping", target: "admin", status: "delivered" });
    const log = await request(app).get("/hub/events?target=admin").set(bearer(kyle)).expect(200);
    expect(log.body.events[0]).toMatchObject({ id: payload.event_id, type: "test.ping", summary: "Test event (ids only)", attempts: 1 });
    expect(log.body.events[0].attemptLog).toHaveLength(1);
  });

  it("goes to that agent only, and Inventory's test is signed with Inventory's own secret", async () => {
    const kyle = await pinToken();
    await put(kyle, body({ url: admin.url }, { url: inventory.url })).expect(200);
    const secret = (await request(app).post("/hub/webhooks/inventory/signing-secret").set(bearer(kyle)).expect(200)).body.secret as string;
    await request(app).post("/hub/webhooks/inventory/test").set(bearer(kyle)).expect(200);
    expect(admin.requests).toHaveLength(0);
    expect(inventory.requests).toHaveLength(1);
    expect(verify(inventory.requests[0], secret)).toBe(true);
  });

  it("is one try: a 500 or a timeout ends dead, shows the status or error, and the worker never retries it", async () => {
    const kyle = await pinToken();
    await put(kyle, body({ url: admin.url })).expect(200);
    admin.status = 500;
    const five = await request(app).post("/hub/webhooks/admin/test").set(bearer(kyle)).expect(200);
    expect(five.body).toMatchObject({ statusCode: 500, event: { status: "dead", attempts: 1, nextAttemptAt: null } });
    expect(five.body.error).toMatch(/HTTP 500/);

    _setDeliveryTimeoutMsForTests(120);
    admin.status = 200;
    admin.delayMs = 700;
    const slow = await request(app).post("/hub/webhooks/admin/test").set(bearer(kyle)).expect(200);
    expect(slow.body).toMatchObject({ statusCode: null, event: { status: "dead" } });
    expect(slow.body.error).toMatch(/Timed out/);

    const before = admin.requests.length;
    expect(await deliverDueEvents(prisma, new Date(Date.now() + 7 * 24 * 3600_000))).toBe(0);
    await new Promise((r) => setTimeout(r, 50));
    expect(admin.requests).toHaveLength(before);
  });

  it("a test row left pending (a crash mid-send) is still never picked up by the worker", async () => {
    const kyle = await pinToken();
    await put(kyle, body({ url: admin.url })).expect(200);
    const id = randomUUID();
    await prisma.hubEvent.create({
      data: { id, eventKey: randomUUID(), type: HUB_TEST_EVENT_TYPE, target: "admin", status: "pending", nextAttemptAt: new Date(Date.now() - 1000), payloadJson: JSON.stringify({ event_id: id, type: HUB_TEST_EVENT_TYPE }) },
    });
    expect(await deliverDueEvents(prisma, new Date())).toBe(0);
    expect(admin.requests).toHaveLength(0);
  });

  it("cannot be resent (409 with the reason)", async () => {
    const kyle = await pinToken();
    await put(kyle, body({ url: admin.url })).expect(200);
    const id = (await request(app).post("/hub/webhooks/admin/test").set(bearer(kyle)).expect(200)).body.event.id as string;
    const res = await request(app).post(`/hub/events/${id}/resend`).set(bearer(kyle));
    expect(res.status).toBe(409);
    expect(res.body.error).toBe(TEST_RESEND_REASON);
    expect(admin.requests).toHaveLength(1);
  });

  it("is refused 409, with the reason, and records nothing, when the agent has no address, is Off, or has nothing to sign with", async () => {
    const kyle = await pinToken();
    await put(kyle, body({})).expect(200);
    const noUrl = await request(app).post("/hub/webhooks/admin/test").set(bearer(kyle));
    expect(noUrl.status).toBe(409);
    expect(noUrl.body.error).toMatch(/no receiving address/);

    await put(kyle, body({ url: admin.url, enabled: false })).expect(200);
    expect((await request(app).post("/hub/webhooks/admin/test").set(bearer(kyle))).body.error).toMatch(/turned Off/);

    await put(kyle, body({ url: admin.url }, { url: inventory.url })).expect(200);
    const noSecret = await request(app).post("/hub/webhooks/inventory/test").set(bearer(kyle));
    expect(noSecret.status).toBe(409);
    expect(noSecret.body.error).toBe("No signing secret is set for Inventory");
    delete process.env.HUB_WEBHOOK_SECRET;
    expect((await request(app).post("/hub/webhooks/admin/test").set(bearer(kyle))).body.error).toBe("HUB_WEBHOOK_SECRET not set");

    expect(await prisma.hubEvent.count()).toBe(0);
    expect(admin.requests.length + inventory.requests.length).toBe(0);
    expect((await request(app).post("/hub/webhooks/nobody/test").set(bearer(kyle))).status).toBe(400);
  });

  it("test.ping is not a routable type: not in the type list, not in the default routes, refused in the routes table", async () => {
    const kyle = await pinToken();
    expect((HUB_EVENT_TYPES as readonly string[]).includes(HUB_TEST_EVENT_TYPE)).toBe(false);
    expect(Object.keys(DEFAULT_EVENT_ROUTES)).not.toContain(HUB_TEST_EVENT_TYPE);
    expect((await put(kyle, body({ url: admin.url }, {}, { "test.ping": "admin" }))).status).toBe(400);
  });
});

// ── the delivery log, filtered per agent ─────────────────────────────────────────────────────────

describe("GET /hub/events?target=", () => {
  it("is the same log filtered to one agent; an unknown agent is a 400", async () => {
    const kyle = await pinToken();
    const a = await rawEvent("admin");
    const i = await rawEvent("inventory");
    const only = async (q: string) => (await request(app).get(`/hub/events?${q}`).set(bearer(kyle)).expect(200)).body.events.map((e: { id: string }) => e.id);
    expect((await only("")).sort()).toEqual([a, i].sort());
    expect(await only("target=admin")).toEqual([a]);
    expect(await only("target=inventory")).toEqual([i]);
    expect(await only("target=inventory&status=delivered")).toEqual([]);
    expect((await request(app).get("/hub/events?target=nobody").set(bearer(kyle))).status).toBe(400);
  });
});

// ── who may, and what is never logged ────────────────────────────────────────────────────────────

describe("access and secrecy", () => {
  it("only Kyle may generate, remove or test: a login with bot_keys, the AI admin and an agent key are refused", async () => {
    const kyle = await pinToken();
    await put(kyle, body({ url: admin.url })).expect(200);
    const michael = await personToken("michael-wh", ["bot_keys", "approve_drafts"]);
    const ai = await aiAdminToken();
    for (const token of [michael, ai]) {
      expect((await request(app).post("/hub/webhooks/admin/signing-secret").set(bearer(token))).status).toBe(403);
      expect((await request(app).delete("/hub/webhooks/admin/signing-secret").set(bearer(token))).status).toBe(403);
      expect((await request(app).post("/hub/webhooks/admin/test").set(bearer(token))).status).toBe(403);
      expect((await request(app).get("/owner-settings/agentWebhooks").set(bearer(token))).status).toBe(403);
    }
    const { key } = await mintAgentKey({ name: `${TAG} key`, agentRole: "admin", createdBy: "owner" });
    expect((await request(app).post("/hub/webhooks/admin/test").set(bearer(key))).status).toBe(401);
    expect((await request(app).post("/hub/webhooks/admin/signing-secret").set(bearer(key))).status).toBe(401);
    expect(admin.requests).toHaveLength(0);
  });

  it("no header value and no signing secret reaches a log line, a SystemEvent, an attempt error, an event row or a payload", async () => {
    const kyle = await pinToken();
    await put(kyle, body({ url: admin.url, headers: [{ name: "Authorization", value: AUTH_VALUE }] })).expect(200);
    const secret = (await request(app).post("/hub/webhooks/admin/signing-secret").set(bearer(kyle)).expect(200)).body.secret as string;
    await request(app).post("/hub/webhooks/admin/test").set(bearer(kyle)).expect(200);
    admin.status = 500;
    await request(app).post("/hub/webhooks/admin/test").set(bearer(kyle)).expect(200);
    const lead = await prisma.lead.create({ data: { name: `${TAG} lead`, phone: "6155550123", email: "x@example.com", source: "web" } });
    admin.status = 200;
    await emitHubEvent({ type: "lead.created", leadId: lead.id });
    await new Promise((r) => setTimeout(r, 300));
    delete process.env.AGENT_KEY_PEPPER;
    await deliverEvent(await rawEvent("admin"));
    process.env.AGENT_KEY_PEPPER = PEPPER;
    await request(app).delete("/hub/webhooks/admin/signing-secret").set(bearer(kyle)).expect(200);
    await new Promise((r) => setTimeout(r, 200));

    const needles = [AUTH_VALUE, "sk-live-abcdef", secret];
    const everything = [
      logged.join("\n"),
      JSON.stringify(await prisma.systemEvent.findMany()),
      JSON.stringify(await prisma.hubEvent.findMany()),
      JSON.stringify(await prisma.hubEventAttempt.findMany()),
      ...admin.requests.map((r) => r.body),
    ].join("\n");
    for (const n of needles) expect(everything).not.toContain(n);
    // The settings change was logged by name and count only.
    const audit = await prisma.systemEvent.findMany({ where: { source: "agent_events", message: "Agent webhook addresses changed" } });
    expect(JSON.stringify(audit.map((a) => JSON.parse(a.detailsJson ?? "{}").targets))).toContain('"headers":1');
  });
});

// W2-C review: a CRM tab still on the pre-W2 bundle sends only admin and inventory. The six newer agents' stored address, header and
// encrypted signing secret must survive that save (a target missing from the body is kept as stored, never wiped).
describe("a save from an older CRM tab (only admin and inventory in the body)", () => {
  it("keeps every stored target it did not send: address, header and signing secret", async () => {
    const kyle = await pinToken();
    const full = body({ url: admin.url }, { url: inventory.url });
    full.targets.push({ id: "facebook", url: "https://facebook.example.com/hook", enabled: true, headers: [{ name: "Authorization", value: "Bearer fb-token-9999" }] } as never);
    await put(kyle, full).expect(200);
    const gen = await request(app).post("/hub/webhooks/facebook/signing-secret").set(bearer(kyle)).expect(200);
    const before = (await read(kyle)).value.targets.find((t: { id: string }) => t.id === "facebook");
    expect(before).toMatchObject({ url: "https://facebook.example.com/hook", headers: [{ name: "Authorization" }], signingSecret: { masked: expect.any(String) } });

    // The old tab edits Admin's address and sends only the two agents it knows.
    await put(kyle, body({ url: "https://admin.example.com/changed" }, { url: inventory.url })).expect(200);
    const after = await read(kyle);
    expect(after.value.targets.find((t: { id: string }) => t.id === "admin").url).toBe("https://admin.example.com/changed");
    expect(after.value.targets.find((t: { id: string }) => t.id === "facebook")).toEqual(before);
    // The kept secret is the same one: the stored value still decrypts and signs (the generate answer's masked tail matches).
    expect(before.signingSecret.masked.endsWith((gen.body.secret as string).slice(-4))).toBe(true);
    const stored = await prisma.companySetting.findUnique({ where: { key: "agentWebhooks" } });
    expect(JSON.stringify(stored)).not.toContain("fb-token-9999");
  });
});
