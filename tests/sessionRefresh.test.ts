import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import { app } from "../src/app";
import { hashPin } from "../src/middleware/pinAuth";
import { isPublicRoute } from "../src/middleware/publicRoutes";

/**
 * Sliding renewal (Kyle, 2026-11-15: "continual access to the CRM"). POST /auth/refresh trades a
 * still-valid session token for a fresh one so a session in use is not locked out at 8 hours.
 *
 * Its own file for the same reason as leadsAuth.test.ts: PIN_HASH is set for the whole file, which
 * would 401 every other test sharing it. The gate is a no-op without PIN_HASH in test.
 */

const JWT_SECRET = process.env.JWT_SECRET ?? "rce-dev-secret-change-me";

beforeAll(async () => {
  process.env.PIN_HASH = await hashPin("1234");
});

afterAll(() => {
  delete process.env.PIN_HASH;
});

function decode(token: string): { sub: string; iat: number; exp: number } {
  return jwt.verify(token, JWT_SECRET) as { sub: string; iat: number; exp: number };
}

describe("POST /auth/refresh", () => {
  it("is NOT a public route — it sits behind the session gate", () => {
    expect(isPublicRoute("POST", "/auth/refresh")).toBe(false);
    expect(isPublicRoute("POST", "/api/auth/refresh")).toBe(false);
  });

  it("trades a valid token for a fresh one with a later expiry", async () => {
    const now = Math.floor(Date.now() / 1000);
    // A token already an hour into its 8.
    const old = jwt.sign({ sub: "owner", iat: now - 3600 }, JWT_SECRET, { expiresIn: "8h" });

    const res = await request(app).post("/auth/refresh").set("Authorization", `Bearer ${old}`);

    expect(res.status).toBe(200);
    expect(res.body.expiresIn).toBe(8 * 60 * 60);
    const fresh = decode(res.body.token as string);
    expect(fresh.sub).toBe("owner");
    expect(fresh.exp).toBeGreaterThan(decode(old).exp);
  });

  it("works at the /api spelling too", async () => {
    const old = jwt.sign({ sub: "owner" }, JWT_SECRET, { expiresIn: "1h" });
    const res = await request(app).post("/api/auth/refresh").set("Authorization", `Bearer ${old}`);
    expect(res.status).toBe(200);
    expect(decode(res.body.token as string).sub).toBe("owner");
  });

  it("refuses a request with no token", async () => {
    expect((await request(app).post("/auth/refresh")).status).toBe(401);
  });

  it("refuses an expired token — the PIN is the only way to start a session", async () => {
    const expired = jwt.sign({ sub: "owner" }, JWT_SECRET, { expiresIn: -10 });
    const res = await request(app).post("/auth/refresh").set("Authorization", `Bearer ${expired}`);
    expect(res.status).toBe(401);
    expect(res.body.token).toBeUndefined();
  });

  it("refuses a garbage token", async () => {
    const res = await request(app).post("/auth/refresh").set("Authorization", "Bearer not-a-real-token");
    expect(res.status).toBe(401);
  });

  it("refuses a token signed with another secret", async () => {
    const forged = jwt.sign({ sub: "owner" }, "some-other-secret", { expiresIn: "1h" });
    const res = await request(app).post("/auth/refresh").set("Authorization", `Bearer ${forged}`);
    expect(res.status).toBe(401);
  });

  it("refuses a valid token for a different subject", async () => {
    const other = jwt.sign({ sub: "someone-else" }, JWT_SECRET, { expiresIn: "1h" });
    const res = await request(app).post("/auth/refresh").set("Authorization", `Bearer ${other}`);
    expect(res.status).toBe(401);
    expect(res.body.token).toBeUndefined();
  });

  it("will not take the token from the query string", async () => {
    const token = jwt.sign({ sub: "owner" }, JWT_SECRET, { expiresIn: "1h" });
    const res = await request(app).post(`/auth/refresh?token=${token}`);
    expect(res.status).toBe(401);
  });
});
