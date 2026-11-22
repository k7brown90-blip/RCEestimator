/**
 * THE one cross-egress no-secret test (work order agent-team, BA4; hub critic P1-5).
 *
 * "No tech token, QR link or secret in any hub payload or log" used to exist only in pieces. This file
 * seeds a LIVE Technician.accessToken, a JWT, the three customer capability links (/e/, /pay/ and the
 * field's /field/#t=), an agent key and the webhook secret into the free-text columns that feed each
 * way data leaves the process, then drives every egress that exists and asserts not one seed comes out.
 *
 * EGRESSES is the list. A unit that adds a new way out (the live stream U6, web push U7, the REST bot
 * door BA3/K-U7) adds ONE entry here; the assertions below run over every entry. Those three do not
 * exist yet; their it.todo lines below say so.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
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
vi.mock("../src/services/confirmationEmail", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/services/confirmationEmail")>();
  return { ...mod, sendBrandedEmail: vi.fn().mockResolvedValue(true), sendKyleNotificationEmail: vi.fn().mockResolvedValue(undefined) };
});

import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { hashPin } from "../src/middleware/pinAuth";
import { emitHubEvent, deliverEvent } from "../src/services/hubEvents";
import { agentRespond } from "../src/agentApi/respond";
import { messageReadSchema, projectMessageRead } from "../src/agentApi/profiles";
import { recordAgentCall } from "../src/agentApi/audit";
import { redactPath } from "../src/middleware/accessLog";

const TAG = "HubEgress";
const PIN = "1234";
const HUB_SECRET = "egress-hub-secret-value-9f3a1c";
const TECH_TOKEN = "Zk3pQ9vLr2TnXw8YbHd5CmEa7JsUfGq1"; // the shape of crypto.randomBytes(24).toString("base64url")
const HEX64 = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvd25lciJ9.c2lnbmF0dXJlLXNpZ25hdHVyZS1zaWc";
const AGENT_KEY = "rce_live_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789ABCDEFG";
const SEEDED_TEXT = [
  `token ${TECH_TOKEN}`, `jwt ${JWT}`, `see https://crm.example.com/e/${HEX64}`, `pay https://crm.example.com/pay/${HEX64}`,
  `field https://crm.example.com/field/#t=${TECH_TOKEN}`, `key ${AGENT_KEY}`, `secret ${HUB_SECRET}`,
].join(" | ");

/** Every value that must never appear in anything that leaves. */
const NEEDLES = [TECH_TOKEN, HEX64, JWT, AGENT_KEY, HUB_SECRET, "#t=Zk3p", "eyJhbGci", "rce_live_AbCd"];

function expectClean(where: string, strings: string[]) {
  const all = strings.join("\n");
  expect(all.length, `${where}: nothing was captured, so the check proves nothing`).toBeGreaterThan(0);
  for (const needle of NEEDLES) expect(all, `${where} leaked ${needle.slice(0, 12)}…`).not.toContain(needle);
}

let savedPin: string | undefined;
let savedSecret: string | undefined;
let savedUrl: string | undefined;
let techId: string;
const leadIds: string[] = [];
let customerId: string;
let propertyId: string;
let visitId: string;

beforeAll(async () => {
  savedPin = process.env.PIN_HASH;
  savedSecret = process.env.HUB_WEBHOOK_SECRET;
  savedUrl = process.env.HUB_AGENT_WEBHOOK_URL;
  process.env.PIN_HASH = await hashPin(PIN);
  process.env.HUB_WEBHOOK_SECRET = HUB_SECRET;
  delete process.env.HUB_AGENT_WEBHOOK_URL;
  const tech = await prisma.technician.create({ data: { name: `${TAG} Tech`, accessToken: TECH_TOKEN, isActive: true } });
  techId = tech.id;
  const customer = await prisma.customer.create({
    data: { name: `${TAG} Customer`, properties: { create: { name: "H", addressLine1: "5 Egress Way", city: "Smyrna", state: "TN", postalCode: "37167" } } },
    include: { properties: true },
  });
  customerId = customer.id;
  propertyId = customer.properties[0].id;
});
afterAll(async () => {
  const restore = (k: string, v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
  restore("PIN_HASH", savedPin);
  restore("HUB_WEBHOOK_SECRET", savedSecret);
  restore("HUB_AGENT_WEBHOOK_URL", savedUrl);
  await prisma.hubEventAttempt.deleteMany();
  await prisma.hubEvent.deleteMany();
  await prisma.lead.deleteMany({ where: { id: { in: leadIds } } });
  await prisma.visit.deleteMany({ where: { customerId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
  await prisma.technician.deleteMany({ where: { id: techId } });
});
beforeEach(async () => {
  await prisma.hubEventAttempt.deleteMany();
  await prisma.hubEvent.deleteMany();
});
afterEach(() => vi.restoreAllMocks());

async function seededLeadEvent() {
  const lead = await prisma.lead.create({ data: { name: `${TAG} Lead`, source: SEEDED_TEXT, platform: SEEDED_TEXT } });
  leadIds.push(lead.id);
  return emitHubEvent({ type: "lead.created", leadId: lead.id });
}
async function seededJobEvent() {
  const v = await prisma.visit.create({ data: { customerId, propertyId, mode: "onsite", jobType: SEEDED_TEXT, status: "completed" } });
  visitId = v.id;
  return emitHubEvent({ type: "job.completed", visitId: v.id });
}

// ── the egresses ─────────────────────────────────────────────────────────────────────────────────

interface Egress { name: string; run: () => Promise<string[]> }

const EGRESSES: Egress[] = [
  {
    name: "HubEvent.payloadJson (what is stored, and so what is ever sent)",
    run: async () => {
      const ids = [await seededLeadEvent(), await seededJobEvent()];
      const rows = await prisma.hubEvent.findMany({ where: { id: { in: ids } } });
      expect(rows).toHaveLength(2);
      return rows.map((r) => r.payloadJson);
    },
  },
  {
    name: "the signed POST on the wire (body and every header)",
    run: async () => {
      const seen: string[] = [];
      const server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (c) => { body += c; });
        req.on("end", () => { seen.push(body, JSON.stringify(req.headers), req.url ?? ""); res.statusCode = 200; res.end("ok"); });
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      process.env.HUB_AGENT_WEBHOOK_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
      try {
        const id = await seededLeadEvent();
        await prisma.hubEvent.update({ where: { id }, data: { status: "pending", nextAttemptAt: new Date() } }).catch(() => undefined);
        for (let i = 0; i < 80 && seen.length < 3; i += 1) {
          await deliverEvent(id);
          await new Promise((r) => setTimeout(r, 25));
        }
      } finally {
        delete process.env.HUB_AGENT_WEBHOOK_URL;
        server.closeAllConnections();
        await new Promise((r) => server.close(r));
      }
      // The signature header is an HMAC of the body, not the secret itself; the secret must not be in any header.
      return seen;
    },
  },
  {
    name: "GET /hub/events (the Agent events screen's own answer)",
    run: async () => {
      await seededLeadEvent();
      await seededJobEvent();
      const token = (await request(app).post("/auth/pin").send({ pin: PIN })).body.token as string;
      const res = await request(app).get("/hub/events").set("Authorization", `Bearer ${token}`).expect(200);
      expect(res.body.events.length).toBe(2);
      return [res.text];
    },
  },
  {
    name: "an agent's hub message read (the one response layer, every-key profile)",
    run: async () => {
      const thread = await prisma.hubThread.create({ data: { kind: "dev", title: `${TAG} dev` } });
      try {
        const msg = await prisma.hubMessage.create({
          data: { threadId: thread.id, authorType: "tech", authorDisplay: `${TAG} Tech`, channel: "in_app", direction: "internal", status: "posted", body: SEEDED_TEXT, subject: SEEDED_TEXT },
        });
        const profile = { name: "test.read_messages", profiles: [{ scope: "hub:read" as const, schema: messageReadSchema, withholdContact: true }] };
        const { data } = await agentRespond({ scopes: ["hub:read"] }, profile, projectMessageRead(msg, undefined, true));
        return [JSON.stringify(data)];
      } finally {
        await prisma.hubThread.delete({ where: { id: thread.id } });
      }
    },
  },
  {
    name: "the access log, for a request with the token in the path, the query and the Authorization header",
    run: async () => {
      const lines: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(" ")); });
      for (const path of [`/e/${HEX64}`, `/pay/${HEX64}`, `/pay/${HEX64}/checkout`, `/api/e/${HEX64}`, `/api/pay/${HEX64}`, `/sign/${HEX64}`, `/confirm/${HEX64}`, `/unsubscribe/${HEX64}`]) {
        await request(app).get(`${path}?t=${TECH_TOKEN}&jwt=${JWT}`).set("Authorization", `Bearer ${TECH_TOKEN}`).set("Cookie", `s=${TECH_TOKEN}`);
      }
      await request(app).get(`/health-record/visits/x/complete?token=${TECH_TOKEN}`).set("Authorization", `Bearer ${TECH_TOKEN}`);
      await request(app).get("/hub/events").set("Authorization", `Bearer ${JWT}`);
      spy.mockRestore();
      const access = lines.filter((l) => l.includes('"log":"access"'));
      expect(access.length).toBeGreaterThanOrEqual(8);
      return access;
    },
  },
  {
    name: "an AgentAuditLog row (the idempotency key is stored only as its hash)",
    run: async () => {
      const id = await recordAgentCall({
        agentKeyId: "key-egress", agentRole: "admin", tool: "get_lead", route: "/mcp", door: "mcp", scopeUsed: "crm:read",
        recordIds: ["lead_123", TAG], resultCode: "ok", status: 200, durationMs: 3, idempotencyKey: AGENT_KEY,
      });
      const row = await prisma.agentAuditLog.findUniqueOrThrow({ where: { id } });
      return [JSON.stringify(row)];
    },
  },
];

describe("nothing secret leaves by any egress", () => {
  for (const egress of EGRESSES) {
    it(egress.name, async () => {
      expectClean(egress.name, await egress.run());
    });
  }

  it("the seeds really are what the live system treats as secret (a live technician token, an env secret)", async () => {
    const { loadSecretValues } = await import("../src/agentApi/respond");
    const secrets = await loadSecretValues();
    expect(secrets).toContain(TECH_TOKEN);
    expect(secrets).toContain(HUB_SECRET);
  });

  it("an INACTIVE technician's token is not a protected exact value, but the shape pass still removes a token-shaped string", async () => {
    await prisma.technician.update({ where: { id: techId }, data: { isActive: false } });
    try {
      const id = await seededLeadEvent();
      const row = await prisma.hubEvent.findUniqueOrThrow({ where: { id } });
      expect(row.payloadJson).not.toContain(TECH_TOKEN);
    } finally {
      await prisma.technician.update({ where: { id: techId }, data: { isActive: true } });
    }
  });

  it("redactPath keeps every capability path's token out, with or without /api", () => {
    for (const path of [`/e/${HEX64}`, `/pay/${HEX64}`, `/pay/${HEX64}/qr.svg`, `/sign/${HEX64}`, `/confirm/${HEX64}`, `/unsubscribe/${HEX64}`, `/api/e/${HEX64}`, `/api/pay/${HEX64}/checkout`, `/api/unsubscribe/${HEX64}`]) {
      const out = redactPath(path);
      expect(out, path).not.toContain(HEX64);
      expect(out, path).toContain("<token>");
    }
    expect(redactPath("/pay")).toBe("/pay");
    expect(redactPath("/hub/events")).toBe("/hub/events");
  });

  // The ways out that do not exist yet. Each adds ONE entry to EGRESSES when it lands.
  it.todo("the live message stream (U6)");
  it.todo("a web push payload (U7)");
  it.todo("the REST bot door's responses (BA3 / K-U7)");
});
