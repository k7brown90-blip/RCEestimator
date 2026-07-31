import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";

vi.mock("../src/services/twilio");
vi.mock("googleapis");

import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";

/**
 * Which endpoints are reachable without a session, and which aren't.
 *
 * Written after `GET /leads` turned out to be world-readable for months. The
 * point of pinning it here is that "is this route public?" stops being something
 * you work out by reading middleware registration order.
 */

const TAG = "PubEP";
const SECRET = "public-endpoint-test-secret";

beforeAll(() => {
  process.env.WEBHOOK_SECRET = SECRET;
});

afterEach(() => {
  delete process.env.AGENT_ENDPOINTS_REQUIRE_SECRET;
});

afterAll(async () => {
  delete process.env.WEBHOOK_SECRET;
  delete process.env.AGENT_ENDPOINTS_REQUIRE_SECRET;
  await prisma.lead.deleteMany({ where: { name: { startsWith: TAG } } });
  await prisma.customer.deleteMany({ where: { name: { startsWith: TAG } } });
});

describe("GET /calls/daily-summary", () => {
  it("refuses without the shared secret", async () => {
    // Returns today's leads with names, phone numbers, addresses and notes.
    await request(app).get("/calls/daily-summary").expect(401);
  });

  it("allows the secret holder", async () => {
    await request(app).get("/calls/daily-summary").set("webhook_secret", SECRET).expect(200);
  });

  it("refuses a wrong secret", async () => {
    await request(app).get("/calls/daily-summary").set("webhook_secret", "nope").expect(401);
  });
});

describe("the agent endpoints, behind one flag", () => {
  // The phone agent's tool definitions live in the Vapi dashboard, outside this
  // repo, so these cannot be locked in the same commit that updates their caller.
  // Off by default; the log names whichever endpoint is still called bare.
  const AGENT_ENDPOINTS = [
    ["get", "/customer/lookup?phone=6155550000"],
    ["get", "/calendar/availability"],
  ] as const;

  it("all answer unauthenticated while the flag is off", async () => {
    for (const [method, path] of AGENT_ENDPOINTS) {
      const res = await request(app)[method](path);
      expect(res.status, `${method.toUpperCase()} ${path}`).not.toBe(401);
    }
  });

  it("all refuse unauthenticated once the flag is on", async () => {
    process.env.AGENT_ENDPOINTS_REQUIRE_SECRET = "true";
    for (const [method, path] of AGENT_ENDPOINTS) {
      await request(app)[method](path).expect(401);
    }
  });

  it("all allow the secret holder once the flag is on", async () => {
    process.env.AGENT_ENDPOINTS_REQUIRE_SECRET = "true";
    for (const [method, path] of AGENT_ENDPOINTS) {
      const res = await request(app)[method](path).set("webhook_secret", SECRET);
      expect(res.status, `${method.toUpperCase()} ${path}`).not.toBe(401);
    }
  });

  it("covers booking, which writes to the calendar and sends messages", async () => {
    // The one with teeth: it puts a real event on the calendar, takes the slot,
    // and sends SMS and email to whatever contact details the request supplies.
    process.env.AGENT_ENDPOINTS_REQUIRE_SECRET = "true";
    await request(app)
      .post("/calendar/book")
      .send({
        date: "2026-09-01", startTime: "9:00 AM", customerName: "Nobody",
        description: "Unauthorized", address: "1 Nowhere",
      })
      .expect(401);
  });
});

describe("GET /customer/lookup", () => {

  it("will not enumerate the customer base from a one-letter name", async () => {
    await prisma.customer.create({ data: { name: `${TAG} Enumerable`, phone: "6155551234" } });
    const res = await request(app).get("/customer/lookup?name=a").expect(200);
    expect(res.body.found).toBe(false);
  });

  it("still finds a customer by a real name", async () => {
    await prisma.customer.create({ data: { name: `${TAG} Findable`, phone: "6155551235" } });
    const res = await request(app).get(`/customer/lookup?name=${TAG} Findable`).expect(200);
    expect(res.body.found).toBe(true);
  });
});

describe("the phone agent stops creating duplicate accounts", () => {
  it("finds the caller's account however their number was stored", async () => {
    // The agent matched on the normalized form only, so a customer stored as
    // "(615) 555-0199" got a fresh account on every call.
    const existing = await prisma.customer.create({
      data: { name: `${TAG} Stored Formatted`, phone: "(615) 555-0199" },
    });

    await request(app)
      .post("/agent/savannah/owner-question")
      .set("Authorization", `Bearer ${process.env.AGENT_API_TOKEN ?? "dev-agent-token"}`)
      .send({
        customer_name: `${TAG} Stored Formatted`,
        callback_phone: "615-555-0199",
        question: "Can you look at my panel?",
      });

    // Whatever the route replied, it must not have opened a second account.
    const accounts = await prisma.customer.findMany({
      where: { name: { startsWith: `${TAG} Stored Formatted` } },
    });
    expect(accounts.length).toBe(1);
    expect(accounts[0].id).toBe(existing.id);
  });
});
