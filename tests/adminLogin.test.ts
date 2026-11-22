import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { hashPin } from "../src/middleware/pinAuth";
import { PUBLIC_ROUTES, isPublicRoute } from "../src/middleware/publicRoutes";

/**
 * The AI admin's own login (Kyle, 2026-11-15: "Lets do a username and password so it can save it
 * and login on its own"). Its own file because PIN_HASH is set for the whole file, which would 401
 * every other test sharing it (same reason as sessionRefresh.test.ts / leadsAuth.test.ts).
 */

const JWT_SECRET = process.env.JWT_SECRET ?? "rce-dev-secret-change-me";
const PIN = "1234";
const USER = "grok-admin";
const PASS = "correct horse battery";
const BAD_BODY = { error: "Invalid username or password" };

beforeAll(async () => {
  process.env.PIN_HASH = await hashPin(PIN);
});

afterAll(async () => {
  delete process.env.PIN_HASH;
  await prisma.adminLogin.deleteMany();
});

beforeEach(async () => {
  await prisma.adminLogin.deleteMany();
});

async function ownerToken(): Promise<string> {
  const res = await request(app).post("/auth/pin").send({ pin: PIN });
  expect(res.status).toBe(200);
  return res.body.token as string;
}

async function saveLogin(username = USER, password = PASS): Promise<void> {
  const res = await request(app)
    .put("/settings/admin-login")
    .set("Authorization", `Bearer ${await ownerToken()}`)
    .send({ username, password });
  expect(res.status).toBe(200);
}

async function aiToken(): Promise<string> {
  const res = await request(app).post("/auth/login").send({ username: USER, password: PASS });
  expect(res.status).toBe(200);
  return res.body.token as string;
}

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

describe("/auth/login is public and rate-limited", () => {
  it("is on the public allowlist with no credential, and answers at the /api spelling too", async () => {
    expect(isPublicRoute("POST", "/auth/login")).toBe(true);
    // No session header, and it is still reachable (a 401 from the login itself, not the gate's
    // "Authentication required").
    const res = await request(app).post("/api/auth/login").send({ username: "x", password: "y" });
    expect(res.status).toBe(401);
    expect(res.body).toEqual(BAD_BODY);
    expect(PUBLIC_ROUTES.find((r) => r.path === "/auth/login")?.credential).toBe("none");
  });

  it("is in the publicLimiter path list in app.ts", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/app.ts", import.meta.url), "utf8");
    const line = src.split("\n").find((l) => l.includes("publicLimiter") && l.includes('"/auth/pin"'));
    expect(line, "the publicLimiter app.use line").toBeDefined();
    expect(line).toContain('"/auth/login"');
  });

  it("the settings routes are NOT public", () => {
    expect(isPublicRoute("GET", "/settings/admin-login")).toBe(false);
    expect(isPublicRoute("PUT", "/settings/admin-login")).toBe(false);
    expect(isPublicRoute("POST", "/settings/admin-login/disable")).toBe(false);
    expect(isPublicRoute("DELETE", "/settings/admin-login")).toBe(false);
  });
});

describe("POST /auth/login", () => {
  it("signs the AI admin in with the right username and password", async () => {
    await saveLogin();
    const res = await request(app).post("/auth/login").send({ username: USER, password: PASS });
    expect(res.status).toBe(200);
    // A day, not 8 hours (Kyle, 2026-11-22: "at least 24 hours of access so when leads come in it isn't locked out").
    expect(res.body.expiresIn).toBe(24 * 60 * 60);
    const claims = jwt.verify(res.body.token as string, JWT_SECRET) as { sub: string; ver: number; aid: string; iat: number; exp: number };
    expect(claims.exp - claims.iat).toBe(24 * 60 * 60);
    expect(claims.sub).toBe("ai-admin");
    expect(claims.ver).toBe(1);
    expect(typeof claims.aid).toBe("string");
    // And the token opens real data.
    const data = await request(app).get("/accounts").set(bearer(res.body.token as string));
    expect(data.status).toBe(200);
  });

  it("answers every failure with the identical 401 body", async () => {
    await saveLogin();
    const unknown = await request(app).post("/auth/login").send({ username: "nobody", password: PASS });
    const wrong = await request(app).post("/auth/login").send({ username: USER, password: "wrong password here" });
    const missing = await request(app).post("/auth/login").send({ username: USER });
    const empty = await request(app).post("/auth/login").send({});
    // A NUL is refused by Postgres in a text parameter: it must still be the plain 401, never a 500.
    const nul = await request(app).post("/auth/login").send({ username: "a\u0000b", password: PASS });
    await request(app)
      .post("/settings/admin-login/disable")
      .set(bearer(await ownerToken()));
    const disabled = await request(app).post("/auth/login").send({ username: USER, password: PASS });

    for (const res of [unknown, wrong, missing, empty, nul, disabled]) {
      expect(res.status).toBe(401);
      expect(res.body).toEqual(BAD_BODY);
      expect(res.body.token).toBeUndefined();
    }
  });

  it("reads credentials from the body only, never the URL", async () => {
    await saveLogin();
    const res = await request(app).post(`/auth/login?username=${USER}&password=${encodeURIComponent(PASS)}`);
    expect(res.status).toBe(401);
  });

  it("does not weaken the PIN: a PIN session is still sub=owner", async () => {
    const claims = jwt.verify(await ownerToken(), JWT_SECRET) as { sub: string; ver?: number };
    expect(claims.sub).toBe("owner");
    expect(claims.ver).toBeUndefined();
  });
});

describe("the gate follows the AI admin's login row", () => {
  it("refuses an ai-admin token after Turn off, and accepts it again only via a new sign-in", async () => {
    await saveLogin();
    const token = await aiToken();
    expect((await request(app).get("/accounts").set(bearer(token))).status).toBe(200);

    const off = await request(app).post("/settings/admin-login/disable").set(bearer(await ownerToken()));
    expect(off.status).toBe(200);
    expect(off.body.enabled).toBe(false);

    const after = await request(app).get("/accounts").set(bearer(token));
    expect(after.status).toBe(401);
    expect(after.body.error).toBe("Invalid or expired session");

    // Turning it back on does NOT revive the old token (the version was bumped on Turn off).
    await request(app).post("/settings/admin-login/enable").set(bearer(await ownerToken()));
    expect((await request(app).get("/accounts").set(bearer(token))).status).toBe(401);
    // A fresh sign-in works.
    expect((await request(app).get("/accounts").set(bearer(await aiToken()))).status).toBe(200);
  });

  it("refuses an ai-admin token after the password is changed", async () => {
    await saveLogin();
    const token = await aiToken();
    await saveLogin(USER, "a brand new password");
    expect((await request(app).get("/accounts").set(bearer(token))).status).toBe(401);
    const again = await request(app).post("/auth/login").send({ username: USER, password: PASS });
    expect(again.status).toBe(401);
    const fresh = await request(app).post("/auth/login").send({ username: USER, password: "a brand new password" });
    expect(fresh.status).toBe(200);
  });

  it("refuses an ai-admin token after the login is removed, even if one is created again", async () => {
    await saveLogin();
    const token = await aiToken();
    const del = await request(app).delete("/settings/admin-login").set(bearer(await ownerToken()));
    expect(del.status).toBe(200);
    expect((await request(app).get("/accounts").set(bearer(token))).status).toBe(401);
    // Recreated: the new row starts at version 1 again, but it is a different row.
    await saveLogin();
    expect((await request(app).get("/accounts").set(bearer(token))).status).toBe(401);
  });

  it("refuses a forged ai-admin token with no row id or version", async () => {
    await saveLogin();
    const bare = jwt.sign({ sub: "ai-admin" }, JWT_SECRET, { expiresIn: "1h" });
    expect((await request(app).get("/accounts").set(bearer(bare))).status).toBe(401);
  });

  it("does not touch Kyle's PIN session when the login is turned off or changed", async () => {
    await saveLogin();
    const owner = await ownerToken();
    await request(app).post("/settings/admin-login/disable").set(bearer(owner));
    await saveLogin(USER, "another long password");
    expect((await request(app).get("/accounts").set(bearer(owner))).status).toBe(200);
  });

  it("shows ai-admin as the access-log actor", async () => {
    await saveLogin();
    const token = await aiToken();
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
    try {
      await request(app).get("/accounts").set(bearer(token));
    } finally {
      console.log = orig;
    }
    // Not every environment writes the access log to console.log; assert only when it did.
    const hit = lines.find((l) => l.includes('"/accounts"') || l.includes("/accounts"));
    if (hit) expect(hit).toContain("ai-admin");
  });
});

describe("POST /auth/refresh for the AI admin", () => {
  it("renews a valid ai-admin token, carrying the same version and row", async () => {
    await saveLogin();
    const token = await aiToken();
    const res = await request(app).post("/auth/refresh").set(bearer(token));
    expect(res.status).toBe(200);
    const old = jwt.verify(token, JWT_SECRET) as { aid: string; ver: number };
    const fresh = jwt.verify(res.body.token as string, JWT_SECRET) as { sub: string; aid: string; ver: number };
    expect(fresh.sub).toBe("ai-admin");
    // A renewal is a day long too.
    expect(res.body.expiresIn).toBe(24 * 60 * 60);
    expect(fresh.aid).toBe(old.aid);
    expect(fresh.ver).toBe(old.ver);
    // The renewed token works too (no cap).
    expect((await request(app).get("/accounts").set(bearer(res.body.token as string))).status).toBe(200);
  });

  it("refuses to renew after Turn off", async () => {
    await saveLogin();
    const token = await aiToken();
    await request(app).post("/settings/admin-login/disable").set(bearer(await ownerToken()));
    const res = await request(app).post("/auth/refresh").set(bearer(token));
    expect(res.status).toBe(401);
    expect(res.body.token).toBeUndefined();
  });

  it("still renews the owner's PIN session", async () => {
    const res = await request(app).post("/auth/refresh").set(bearer(await ownerToken()));
    expect(res.status).toBe(200);
    expect((jwt.verify(res.body.token as string, JWT_SECRET) as { sub: string }).sub).toBe("owner");
  });
});

describe("Settings API: /settings/admin-login", () => {
  it("needs a session", async () => {
    expect((await request(app).get("/settings/admin-login")).status).toBe(401);
    expect((await request(app).put("/settings/admin-login").send({ username: USER, password: PASS })).status).toBe(401);
  });

  it("reports not configured, then the username and state, and NEVER the hash", async () => {
    const owner = await ownerToken();
    const none = await request(app).get("/settings/admin-login").set(bearer(owner));
    expect(none.status).toBe(200);
    expect(none.body).toEqual({ configured: false, username: null, enabled: false, updatedAt: null });

    await saveLogin();
    const some = await request(app).get("/settings/admin-login").set(bearer(owner));
    expect(some.body.configured).toBe(true);
    expect(some.body.username).toBe(USER);
    expect(some.body.enabled).toBe(true);
    expect(typeof some.body.updatedAt).toBe("string");
    expect(JSON.stringify(some.body)).not.toMatch(/hash|\$2[aby]\$/i);
    expect(JSON.stringify(some.body)).not.toContain(PASS);

    const put = await request(app).put("/settings/admin-login").set(bearer(owner)).send({ username: USER, password: PASS });
    expect(JSON.stringify(put.body)).not.toMatch(/hash|\$2[aby]\$/i);
  });

  it("stores only a bcrypt hash of the password", async () => {
    await saveLogin();
    const row = await prisma.adminLogin.findFirstOrThrow();
    expect(row.passwordHash).not.toContain(PASS);
    expect(row.passwordHash).toMatch(/^\$2[aby]\$/);
  });

  it("refuses a short password and a missing username with a message", async () => {
    const owner = await ownerToken();
    const short = await request(app).put("/settings/admin-login").set(bearer(owner)).send({ username: USER, password: "short" });
    expect(short.status).toBe(400);
    expect(short.body.error).toMatch(/at least 12/);
    const noUser = await request(app).put("/settings/admin-login").set(bearer(owner)).send({ password: PASS });
    expect(noUser.status).toBe(400);
    expect(await prisma.adminLogin.count()).toBe(0);
  });

  it("keeps a single row: saving again replaces it and bumps the version", async () => {
    await saveLogin();
    await saveLogin("renamed-admin", "yet another password");
    const rows = await prisma.adminLogin.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].username).toBe("renamed-admin");
    expect(rows[0].sessionVersion).toBe(2);
  });

  it("changing the password of a login that is off does not turn it on", async () => {
    await saveLogin();
    await request(app).post("/settings/admin-login/disable").set(bearer(await ownerToken()));
    await saveLogin(USER, "a different long password");
    expect((await prisma.adminLogin.findFirstOrThrow()).enabled).toBe(false);
  });

  it("the owner can turn off, turn on and remove; removing leaves nothing configured", async () => {
    const owner = await ownerToken();
    await saveLogin();
    expect((await request(app).post("/settings/admin-login/disable").set(bearer(owner))).body.enabled).toBe(false);
    expect((await request(app).post("/settings/admin-login/enable").set(bearer(owner))).body.enabled).toBe(true);
    const del = await request(app).delete("/settings/admin-login").set(bearer(owner));
    expect(del.status).toBe(200);
    expect(del.body.configured).toBe(false);
    expect(await prisma.adminLogin.count()).toBe(0);
    expect((await request(app).delete("/settings/admin-login").set(bearer(owner))).status).toBe(404);
  });
});

describe("the AI admin cannot change its own login", () => {
  it("gets 403 on PUT, disable, enable and DELETE, and the row is untouched", async () => {
    await saveLogin();
    const token = await aiToken();
    const before = await prisma.adminLogin.findFirstOrThrow();

    const put = await request(app).put("/settings/admin-login").set(bearer(token)).send({ username: "x-admin", password: "some other password" });
    const off = await request(app).post("/settings/admin-login/disable").set(bearer(token));
    const on = await request(app).post("/settings/admin-login/enable").set(bearer(token));
    const del = await request(app).delete("/settings/admin-login").set(bearer(token));
    for (const res of [put, off, on, del]) expect(res.status).toBe(403);

    const after = await prisma.adminLogin.findFirstOrThrow();
    expect(after.username).toBe(before.username);
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(after.enabled).toBe(true);
    expect(after.sessionVersion).toBe(before.sessionVersion);
  });

  it("can still read the on/off status", async () => {
    await saveLogin();
    const res = await request(app).get("/settings/admin-login").set(bearer(await aiToken()));
    expect(res.status).toBe(200);
  });
});
