/**
 * The live-update stream (work order agent-team, U6): GET /hub/stream (session) and
 * GET /health-record/hub/stream (technician bearer), services/hubStream.ts + services/hubBus.ts.
 *
 * Pinned here: no credentials is a 401 on both doors (and a technician's bearer is not a CRM session); the
 * stream is text/event-stream with the proxy-safe headers; a new message in a visible thread reaches the
 * subscriber with IDS ONLY; a technician on an unassigned job hears nothing about it; a draft waiting for
 * approval, an edit, a delete and a decision are announced from the one fan-out / decide path; a heartbeat
 * comment goes out; the server ends the stream at its cap and the listener is released (real timers with
 * the heartbeat and the cap shortened, because a fake clock cannot drive a socket).
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
import {
  announceThreadMoved, editOwnMessage, ensureTeamThread, ensureThreadFor, markThreadRead, postMessage, renameThread,
  setThreadStatus, softDeleteMessage, type HubReader,
} from "../src/services/hub";
import { announceDecision, hubListenerCount } from "../src/services/hubBus";
import { HUB_STREAM_TIMING } from "../src/services/hubStream";
import { techReader } from "../src/services/hubTech";

const TAG = "HubStream";
const techIds: string[] = [];
const PIN = "1234";

async function wipe() {
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

let server: http.Server;
let port = 0;
let savedPin: string | undefined;
const savedTiming = { ...HUB_STREAM_TIMING };

beforeAll(async () => {
  savedPin = process.env.PIN_HASH;
  process.env.PIN_HASH = await hashPin(PIN);
  await wipe();
  await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections?.(); });
  if (savedPin === undefined) delete process.env.PIN_HASH; else process.env.PIN_HASH = savedPin;
  await wipe();
});
beforeEach(wipe);
afterEach(() => { Object.assign(HUB_STREAM_TIMING, savedTiming); });

interface Open {
  status: number;
  headers: http.IncomingHttpHeaders;
  text(): string;
  events(): Array<{ name: string; data: Record<string, unknown> }>;
  waitFor(pred: (o: Open) => boolean, ms?: number): Promise<boolean>;
  ended(): boolean;
  close(): void;
}

/** A real streaming GET: supertest buffers the whole body, which a stream never finishes. */
function openStream(path: string, headers: Record<string, string> = {}): Promise<Open> {
  return new Promise((resolve, reject) => {
    let text = "";
    let ended = false;
    const req = http.get({ host: "127.0.0.1", port, path, headers }, (res) => {
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { text += chunk; });
      res.on("end", () => { ended = true; });
      res.on("close", () => { ended = true; });
      const open: Open = {
        status: res.statusCode ?? 0,
        headers: res.headers,
        text: () => text,
        events: () => text.split("\n\n").flatMap((block) => {
          const name = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          return name && data ? [{ name, data: JSON.parse(data) as Record<string, unknown> }] : [];
        }),
        waitFor: async (pred, ms = 3000) => {
          const until = Date.now() + ms;
          while (Date.now() < until) {
            if (pred(open)) return true;
            await new Promise((r) => setTimeout(r, 20));
          }
          return pred(open);
        },
        ended: () => ended,
        close: () => req.destroy(),
      };
      resolve(open);
    });
    req.on("error", reject);
  });
}

const pinHeader = async () => {
  const r = await request(app).post("/auth/pin").send({ pin: PIN });
  expect(r.status).toBe(200);
  return { Authorization: `Bearer ${r.body.token as string}` };
};

async function makeTech(name: string) {
  const t = await prisma.technician.create({ data: { name: `${TAG} ${name}`, accessToken: `hubstream-${name}-${Math.random().toString(36).slice(2)}` } });
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

const owner: HubReader = { key: "owner", kind: "owner", display: "Kyle", technicianId: null, threadKinds: [], agentRole: null, agentKeyId: null, isKyle: true };
const agent: HubReader = { key: "agent:scout", kind: "agent", display: "Scout", technicianId: null, threadKinds: [], agentRole: "admin", agentKeyId: "scout", isKyle: false };

describe("who may open a stream", () => {
  it("refuses a visitor on both doors, and a technician's bearer is not a CRM session", async () => {
    const eric = await makeTech("Eric");
    expect((await request(app).get("/hub/stream")).status).toBe(401);
    expect((await request(app).get("/hub/stream").set("Authorization", `Bearer ${eric.accessToken}`)).status).toBe(401);
    expect((await request(app).get("/health-record/hub/stream")).status).toBe(401);
    expect((await request(app).get("/health-record/hub/stream").set("Authorization", "Bearer nope")).status).toBe(401);
  });

  it("opens as text/event-stream with the proxy-safe headers, and says it is ready", async () => {
    const s = await openStream("/hub/stream", await pinHeader());
    try {
      expect(s.status).toBe(200);
      expect(s.headers["content-type"]).toContain("text/event-stream");
      expect(s.headers["cache-control"]).toContain("no-cache");
      expect(s.headers["x-accel-buffering"]).toBe("no");
      expect(await s.waitFor((o) => o.events().some((e) => e.name === "ready"))).toBe(true);
    } finally {
      s.close();
    }
  });

  it("never takes the session token in the URL: a token in ?token= opens nothing", async () => {
    const header = await pinHeader();
    const token = header.Authorization.replace("Bearer ", "");
    expect((await request(app).get(`/hub/stream?token=${token}`)).status).toBe(401);
  });
});

describe("what a subscriber hears", () => {
  it("delivers a new message to the office within 5 seconds, with ids only", async () => {
    const eric = await makeTech("Eric");
    const { visit } = await makeJob("Deliver", eric.id);
    const thread = await ensureThreadFor({ visitId: visit.id });
    const s = await openStream("/hub/stream", await pinHeader());
    try {
      await s.waitFor((o) => o.events().some((e) => e.name === "ready"));
      const message = await postMessage(techReader(eric), { threadId: thread.id, body: "Panel is open" });
      expect(await s.waitFor((o) => o.events().some((e) => e.name === "hub"), 5000)).toBe(true);
      const hub = s.events().find((e) => e.name === "hub")!;
      expect(hub.data).toEqual({ type: "message", threadId: thread.id, messageId: message.id });
      // Ids only: not the text, not a name.
      expect(s.text()).not.toContain("Panel is open");
      expect(s.text()).not.toContain(eric.name);
    } finally {
      s.close();
    }
  });

  it("delivers to an assigned technician and NOT to one on an unassigned job", async () => {
    const eric = await makeTech("Eric");
    const sam = await makeTech("Sam");
    const { visit } = await makeJob("Visible", eric.id);
    const thread = await ensureThreadFor({ visitId: visit.id });
    const ericStream = await openStream("/health-record/hub/stream", { Authorization: `Bearer ${eric.accessToken}` });
    const samStream = await openStream("/health-record/hub/stream", { Authorization: `Bearer ${sam.accessToken}` });
    try {
      await ericStream.waitFor((o) => o.events().some((e) => e.name === "ready"));
      await samStream.waitFor((o) => o.events().some((e) => e.name === "ready"));
      const message = await postMessage(owner, { threadId: thread.id, body: "Kyle here" });
      expect(await ericStream.waitFor((o) => o.events().some((e) => e.name === "hub"), 5000)).toBe(true);
      expect(ericStream.events().find((e) => e.name === "hub")!.data).toMatchObject({ threadId: thread.id, messageId: message.id });
      // Give Sam's stream the same time, then check it heard nothing about a thread it may not see.
      await new Promise((r) => setTimeout(r, 400));
      expect(samStream.events().filter((e) => e.name === "hub")).toEqual([]);
    } finally {
      ericStream.close();
      samStream.close();
    }
  });

  it("announces an agent's draft waiting for approval, an edit, a delete and a decision", async () => {
    const eric = await makeTech("Eric");
    const team = await ensureTeamThread(eric.id);
    const s = await openStream("/hub/stream", await pinHeader());
    const types = () => s.events().filter((e) => e.name === "hub").map((e) => e.data.type);
    try {
      await s.waitFor((o) => o.events().some((e) => e.name === "ready"));
      // A draft waiting for approval is a message too: the approval queue and the badge must move.
      const draft = await postMessage(agent, { threadId: team.id, body: "Reminder for Eric", status: "pending_approval" });
      expect(draft.status).toBe("pending_approval");
      expect(await s.waitFor(() => types().includes("message"), 3000)).toBe(true);

      const mine = await postMessage(techReader(eric), { threadId: team.id, body: "first" });
      await editOwnMessage(techReader(eric), mine.id, "second");
      expect(await s.waitFor(() => types().includes("changed"), 3000)).toBe(true);
      const before = types().filter((t) => t === "changed").length;
      await softDeleteMessage(techReader(eric), mine.id, "oops");
      expect(await s.waitFor(() => types().filter((t) => t === "changed").length > before, 3000)).toBe(true);

      announceDecision(draft.id);
      expect(await s.waitFor(() => types().includes("approval"), 3000)).toBe(true);
      expect(s.events().find((e) => e.name === "hub" && e.data.type === "approval")!.data).toMatchObject({ threadId: team.id, messageId: draft.id });
    } finally {
      s.close();
    }
  });
});

describe("every writer that changes what a screen shows says so", () => {
  it("announces close and reopen, a rename, a mark-read and a lead conversation merge (ids only), so no screen waits for the 10-minute reconnect", async () => {
    const eric = await makeTech("Eric");
    const team = await ensureTeamThread(eric.id);
    const s = await openStream("/hub/stream", await pinHeader());
    const changed = () => s.events().filter((e) => e.name === "hub" && e.data.type === "changed" && e.data.threadId === team.id);
    try {
      await s.waitFor((o) => o.events().some((e) => e.name === "ready"));
      let seen = 0;
      const next = async (what: string) => {
        expect(await s.waitFor(() => changed().length > seen, 3000), what).toBe(true);
        seen = changed().length;
      };
      await setThreadStatus(owner, team.id, "closed");
      await next("close");
      await setThreadStatus(owner, team.id, "open");
      await next("reopen");
      await renameThread(owner, team.id, `${TAG} renamed`);
      await next("rename");
      await markThreadRead(owner, team.id);
      await next("mark read");
      // A merge runs inside the caller's transaction, so the caller announces it once committed (convert a lead, link a lead, return it).
      announceThreadMoved({ threadId: team.id });
      await next("merge");
      for (const e of changed()) expect(Object.keys(e.data).sort()).toEqual(["messageId", "threadId", "type"]);
    } finally {
      s.close();
    }
  });

  it("says nothing for a merge that moved nothing", () => {
    const before = hubListenerCount();
    announceThreadMoved({ threadId: null });
    expect(hubListenerCount()).toBe(before);
  });
});

describe("heartbeat, cap and cleanup", () => {
  it("sends a heartbeat comment, ends the stream at the cap, and stops listening", async () => {
    HUB_STREAM_TIMING.heartbeatMs = 40;
    HUB_STREAM_TIMING.capMs = 400;
    const before = hubListenerCount();
    const s = await openStream("/hub/stream", await pinHeader());
    await s.waitFor((o) => o.events().some((e) => e.name === "ready"));
    expect(hubListenerCount()).toBe(before + 1);
    expect(await s.waitFor((o) => o.text().includes(": heartbeat"), 1500)).toBe(true);
    // The server closes it on its own at the cap (10 minutes in production).
    expect(await s.waitFor((o) => o.ended(), 3000)).toBe(true);
    expect(hubListenerCount()).toBe(before);
  });

  it("releases the listener when the client goes away", async () => {
    const before = hubListenerCount();
    const s = await openStream("/hub/stream", await pinHeader());
    await s.waitFor((o) => o.events().some((e) => e.name === "ready"));
    expect(hubListenerCount()).toBe(before + 1);
    s.close();
    const until = Date.now() + 2000;
    while (hubListenerCount() !== before && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    expect(hubListenerCount()).toBe(before);
  });
});
