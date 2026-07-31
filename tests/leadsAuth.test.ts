import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";

vi.mock("../src/services/twilio");
vi.mock("googleapis");

import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { hashPin } from "../src/middleware/pinAuth";

/**
 * `GET /leads` must require a session.
 *
 * `pinAuth.ts` exempted the exact path `/leads` from JWT auth, and `GET /leads`
 * is registered AFTER that middleware — so the entire lead list was readable
 * without logging in: every customer's name, phone, email and address, plus
 * `lostNotes`, which the schema marks "internal only, never shared". The webhook
 * `POST /leads` is registered ~750 lines earlier with its own secret check and
 * never needed the exemption.
 *
 * **This has to be its own file.** `fileParallelism: false` serializes files, but
 * tests within a file share the module-level `app`, and setting `PIN_HASH`
 * mid-file would 401 every other test in it. Both env vars are read per request
 * (pinAuth.ts:10, app.ts:435), not at import, so setting them here is safe.
 */

const JWT_SECRET = process.env.JWT_SECRET ?? "rce-dev-secret-change-me";

beforeAll(async () => {
  process.env.PIN_HASH = await hashPin("1234");
  process.env.WEBHOOK_SECRET = "leads-auth-test-secret";
});

afterAll(async () => {
  delete process.env.PIN_HASH;
  delete process.env.WEBHOOK_SECRET;
  await prisma.lead.deleteMany({ where: { name: { startsWith: "Auth Test" } } });
});

describe("GET /leads authentication", () => {
  it("refuses an unauthenticated request", async () => {
    // Before the fix this returned 200 with the whole table.
    await request(app).get("/api/leads").expect(401);
  });

  it("allows a signed-in request", async () => {
    const token = jwt.sign({ sub: "owner" }, JWT_SECRET, { expiresIn: "1h" });
    await request(app).get("/api/leads").set("Authorization", `Bearer ${token}`).expect(200);
  });

  it("refuses an expired session", async () => {
    const token = jwt.sign({ sub: "owner" }, JWT_SECRET, { expiresIn: "-1h" });
    await request(app).get("/api/leads").set("Authorization", `Bearer ${token}`).expect(401);
  });

  it("will not take a session token from the query string", async () => {
    // It used to, which put the token in server logs, browser history and the
    // Referer header of every navigation away from the page.
    const token = jwt.sign({ sub: "owner" }, JWT_SECRET, { expiresIn: "1h" });
    await request(app).get(`/api/leads?token=${token}`).expect(401);
  });

  it("keeps the manual-create route behind the same session", async () => {
    await request(app).post("/api/crm/leads").send({ name: "Unauthenticated" }).expect(401);
  });
});

describe("the intake webhook is untouched", () => {
  it("still accepts a lead with the shared secret", async () => {
    // The exemption removal must not break the phone/email intake, which is how
    // every lead arrived before manual entry existed.
    const res = await request(app)
      .post("/api/leads")
      .set("webhook_secret", process.env.WEBHOOK_SECRET!)
      .send({ name: "Auth Test Webhook Lead", source: "web" })
      .expect(201);
    expect(res.body.name ?? res.body.lead?.name).toBeTruthy();
  });

  it("still refuses a wrong secret", async () => {
    await request(app)
      .post("/api/leads")
      .set("webhook_secret", "wrong")
      .send({ name: "Auth Test Rejected" })
      .expect(401);
  });
});
