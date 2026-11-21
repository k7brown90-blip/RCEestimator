import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";

vi.mock("../src/services/twilio");
vi.mock("googleapis");

import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { publicRouteFor } from "../src/middleware/publicRoutes";

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

afterAll(async () => {
  delete process.env.WEBHOOK_SECRET;
  await prisma.bookingChat.deleteMany({ where: { srcParam: TAG } });
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

describe("the website booking chat routes (webhook_secret, called by the website's server)", () => {
  // They run an AI conversation, write Leads and a calendar hold, and take image uploads, so an
  // open door here is a way to spend OpenAI money and fill the calendar.
  const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 1)]);

  it("refuses all three without the shared secret", async () => {
    await request(app).post("/booking-chat/start").send({}).expect(401);
    await request(app).post("/booking-chat/anytoken/message").send({ text: "hi" }).expect(401);
    await request(app).post("/booking-chat/anytoken/photo").set("Content-Type", "image/jpeg").send(JPEG_BYTES).expect(401);
  });

  it("refuses a wrong secret", async () => {
    await request(app).post("/booking-chat/start").set("webhook_secret", "nope").send({}).expect(401);
  });

  it("lets the secret holder through (a missing chat is 404, not 401)", async () => {
    const started = await request(app).post("/booking-chat/start").set("webhook_secret", SECRET).set("x-visitor-ip", "198.51.100.7").send({ src: TAG });
    expect(started.status).toBe(201);
    expect(typeof started.body.token).toBe("string");
    const msg = await request(app).post("/booking-chat/no-such-chat/message").set("webhook_secret", SECRET).send({ text: "hi" });
    expect(msg.status).toBe(404);
    const photo = await request(app).post("/booking-chat/no-such-chat/photo").set("webhook_secret", SECRET).set("Content-Type", "image/jpeg").send(JPEG_BYTES);
    expect(photo.status).toBe(404);
  });

  it("is listed in the public allowlist as webhook_secret header, so it cannot silently become session-only or open", () => {
    for (const [method, path] of [["POST", "/booking-chat/start"], ["POST", "/booking-chat/abc123/message"], ["POST", "/booking-chat/abc123/photo"]] as const) {
      expect(publicRouteFor(method, path)?.credential, `${method} ${path}`).toBe("webhook_secret header");
    }
    // GET on the same prefix is not public.
    expect(publicRouteFor("GET", "/booking-chat/abc123/message")).toBeNull();
  });
});
