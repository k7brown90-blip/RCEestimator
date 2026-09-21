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

/**
 * GET /leads/:leadId (2026-09-20 drawers plan, Phase 0) is registered AFTER
 * /leads/follow-ups-due and /leads/loss-report — both literal paths, both
 * webhook-authenticated. Registering :leadId before them would make Express
 * match "follow-ups-due" and "loss-report" as a lead id instead (trap 5 in the
 * plan). These pin that the literal routes still answer as themselves.
 */
describe("route ordering — /leads/:leadId must not shadow the literal routes above it", () => {
  it("GET /leads/follow-ups-due still answers as the automation pull, not a lead lookup", async () => {
    const res = await request(app)
      .get("/api/leads/follow-ups-due")
      .set("webhook_secret", process.env.WEBHOOK_SECRET!)
      .expect(200);
    // The automation shape (`{ count, leads }`), never a 404 "Lead not found".
    expect(res.body).toHaveProperty("count");
    expect(res.body).toHaveProperty("leads");
  });

  it("GET /leads/loss-report still answers as the automation pull, not a lead lookup", async () => {
    const res = await request(app)
      .get("/api/leads/loss-report")
      .set("webhook_secret", process.env.WEBHOOK_SECRET!)
      .expect(200);
    expect(res.body).toHaveProperty("total");
    expect(res.body).toHaveProperty("lossReasons");
  });

  it("GET /leads/:leadId requires a session, same as the list", async () => {
    await request(app).get("/api/leads/does-not-exist").expect(401);
  });

  it("a signed-in request gets one lead, 404s on an unknown id", async () => {
    const created = await request(app)
      .post("/api/leads")
      .set("webhook_secret", process.env.WEBHOOK_SECRET!)
      .send({ name: "Auth Test Single Lead", source: "web" })
      .expect(201);

    const token = jwt.sign({ sub: "owner" }, JWT_SECRET, { expiresIn: "1h" });
    const res = await request(app)
      .get(`/api/leads/${created.body.id}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(res.body.id).toBe(created.body.id);
    expect(res.body.name).toBe("Auth Test Single Lead");
    // Same shape GET /leads returns — post-processed through attachLinkedVisits.
    expect(res.body).toHaveProperty("linkedVisit");

    await request(app)
      .get("/api/leads/does-not-exist")
      .set("Authorization", `Bearer ${token}`)
      .expect(404);
  });
});
