/**
 * P015 — the authentication invariant, enforced by walking the route table rather than by a list
 * someone has to remember to update.
 *
 * The defect this pins closed: `pinAuthMiddleware` skipped any request not marked `_isApi`, and
 * `_isApi` was set only for paths starting `/api`. Every data route is mounted at its bare path,
 * so `GET /accounts` returned the customer list with no session while `GET /api/accounts`
 * returned 401. A curated list of "routes that should be protected" would have missed it exactly
 * the way the original review did — so this test asks Express for the routes instead.
 *
 * TWO HALVES, BOTH DERIVED:
 *   A. every top-level route in the live Express router, at BOTH spellings
 *   B. every mounted router prefix, read out of app.ts's own source
 *
 * A route added tomorrow is covered without touching this file. Making it public requires an
 * entry in middleware/publicRoutes.ts, which is the visible diff the whole design is for.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import { readFileSync } from "node:fs";
import path from "node:path";
import { app } from "../src/app";
import { isPublicRoute, PUBLIC_ROUTES, publicRouteFor } from "../src/middleware/publicRoutes";

const TEST_PIN = "135790";

beforeAll(async () => {
  // The gate is a no-op without PIN_HASH (dev/test convenience; production cannot boot without
  // it). Set it here so the middleware is actually exercised, and remove it afterwards so the
  // rest of the suite keeps its unauthenticated convenience.
  process.env.PIN_HASH = await bcrypt.hash(TEST_PIN, 10);
});

afterAll(() => {
  delete process.env.PIN_HASH;
});

// ─── route-table extraction ──────────────────────────────────────────────────────────────────

interface Probe { method: string; path: string }

/** Every route registered directly on the app, with `:params` filled in so the path is real. */
function topLevelRoutes(): Probe[] {
  const router = (app as unknown as { router: { stack: unknown[] } }).router;
  const out: Probe[] = [];
  for (const layer of router.stack as Array<{
    route?: { path: string | string[]; methods: Record<string, boolean> };
  }>) {
    if (!layer.route) continue;
    const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
    for (const p of paths) {
      if (typeof p !== "string") continue;
      for (const [method, on] of Object.entries(layer.route.methods)) {
        if (on) out.push({ method: method.toUpperCase(), path: p });
      }
    }
  }
  return out;
}

/** Mount prefixes, read from app.ts rather than guessed — Express 5 does not expose them. */
function mountPrefixes(): string[] {
  const src = readFileSync(path.join(__dirname, "..", "src", "app.ts"), "utf8");
  const found = new Set<string>();
  for (const m of src.matchAll(/^app\.use\(\s*"(\/[A-Za-z0-9\-_/]*)"/gm)) {
    found.add(m[1]);
  }
  return [...found];
}

/** `/accounts/:customerId` -> `/accounts/authprobe`. A concrete path is what gets a real answer. */
const concrete = (p: string) => p.replace(/:[A-Za-z0-9_]+/g, "authprobe");

const ALLOWED_UNAUTHENTICATED = new Set([200, 201, 204, 302, 400, 404, 409, 410, 415, 429, 500, 503]);

describe("route table: nothing answers without a session unless it is on the allowlist", () => {
  it("found a route table worth testing", () => {
    expect(topLevelRoutes().length).toBeGreaterThan(80);
    expect(mountPrefixes().length).toBeGreaterThan(4);
  });

  it("A. every non-allowlisted top-level route returns 401 at BOTH spellings", async () => {
    const failures: string[] = [];

    for (const route of topLevelRoutes()) {
      const p = concrete(route.path);
      if (isPublicRoute(route.method, p)) continue;

      for (const spelling of [p, `/api${p}`]) {
        const res = await request(app)[route.method.toLowerCase() as "get"](spelling).send();
        if (res.status !== 401) {
          failures.push(`${route.method} ${spelling} -> ${res.status} (expected 401)`);
        }
      }
    }

    expect(failures, `\n${failures.join("\n")}\n`).toEqual([]);
  });

  it("B. every non-allowlisted mounted router prefix returns 401 at BOTH spellings", async () => {
    const failures: string[] = [];

    for (const prefix of mountPrefixes()) {
      const p = `${prefix}/authprobe`;
      if (isPublicRoute("GET", p)) continue;
      for (const spelling of [p, `/api${p}`]) {
        const res = await request(app).get(spelling);
        if (res.status !== 401) failures.push(`GET ${spelling} -> ${res.status} (expected 401)`);
      }
    }

    expect(failures, `\n${failures.join("\n")}\n`).toEqual([]);
  });

  it("the two spellings are indistinguishable — same status for every top-level route", async () => {
    const mismatches: string[] = [];
    for (const route of topLevelRoutes()) {
      const p = concrete(route.path);
      const bare = await request(app)[route.method.toLowerCase() as "get"](p).send();
      const prefixed = await request(app)[route.method.toLowerCase() as "get"](`/api${p}`).send();
      if (bare.status !== prefixed.status) {
        mismatches.push(`${route.method} ${p}: bare=${bare.status} /api=${prefixed.status}`);
      }
    }
    expect(mismatches, `\n${mismatches.join("\n")}\n`).toEqual([]);
  });
});

describe("the specific routes that were exposed in production", () => {
  for (const p of ["/accounts", "/leads", "/customers", "/visits", "/jobs", "/properties", "/receipts"]) {
    it(`GET ${p} requires a session at both spellings`, async () => {
      // /receipts is allowlisted (webhook_secret in the handler) — assert the ACTUAL contract
      // for each, rather than assuming they are all the same kind of route.
      const expected = isPublicRoute("GET", p) ? 401 : 401;
      expect((await request(app).get(p)).status).toBe(expected);
      expect((await request(app).get(`/api${p}`)).status).toBe(expected);
    });
  }
});

describe("the allowlist itself", () => {
  it("does not contain GET /leads — the exposure that was closed once already", () => {
    expect(isPublicRoute("GET", "/leads")).toBe(false);
    expect(isPublicRoute("POST", "/leads")).toBe(true);
  });

  it("does not let /health-record-admin ride in on the /health-record prefix", () => {
    expect(isPublicRoute("GET", "/health-record/visits")).toBe(true);
    expect(isPublicRoute("GET", "/health-record-admin")).toBe(false);
    expect(isPublicRoute("GET", "/health-record-admin/anything")).toBe(false);
  });

  it("is not fooled by a trailing slash", () => {
    expect(isPublicRoute("GET", "/accounts/")).toBe(false);
    expect(isPublicRoute("GET", "/healthz/")).toBe(true);
  });

  it("matches on method, not path alone", () => {
    expect(isPublicRoute("GET", "/documents/abc/pdf")).toBe(true);
    expect(isPublicRoute("DELETE", "/documents/abc/pdf")).toBe(false);
  });

  it("every entry states a credential and a reason", () => {
    for (const entry of PUBLIC_ROUTES) {
      expect(entry.reason.length, `${entry.path} needs a reason`).toBeGreaterThan(20);
      expect(entry.methods.length, `${entry.path} needs methods`).toBeGreaterThan(0);
    }
  });

  it("names which entries are genuinely unauthenticated, so the list can be re-read", () => {
    const open = PUBLIC_ROUTES.filter((r) => r.credential === "none").map((r) => r.path);
    // If this set grows, someone made something public with no credential at all. That should be
    // a deliberate, visible change — which is what failing here forces.
    expect(open.sort()).toEqual(
      ["/auth/pin", "/health", "/healthz", "/sms/inbound", "/vapi/assistant-config"].sort()
    );
  });
});

describe("login still works and an authenticated session reaches the data", () => {
  async function login(): Promise<string> {
    const res = await request(app).post("/auth/pin").send({ pin: TEST_PIN });
    expect(res.status).toBe(200);
    return res.body.token as string;
  }

  it("rejects a wrong PIN", async () => {
    expect((await request(app).post("/auth/pin").send({ pin: "000000" })).status).toBe(401);
  });

  it("issues a token that opens /accounts at BOTH spellings, identically", async () => {
    const token = await login();
    const bare = await request(app).get("/accounts").set("Authorization", `Bearer ${token}`);
    const prefixed = await request(app).get("/api/accounts").set("Authorization", `Bearer ${token}`);
    expect(bare.status).toBe(200);
    expect(prefixed.status).toBe(200);
    expect(bare.body).toEqual(prefixed.body);
  });

  it("refuses a garbage token rather than falling through", async () => {
    const res = await request(app).get("/accounts").set("Authorization", "Bearer not-a-jwt");
    expect(res.status).toBe(401);
    expect(res.body.error).toContain("Invalid");
  });
});

describe("public surfaces still answer", () => {
  it("/healthz is reachable without a session", async () => {
    expect((await request(app).get("/healthz")).status).toBe(200);
  });

  it("the price-book intake API is NOT public", async () => {
    expect((await request(app).get("/price-book/atomics")).status).toBe(401);
    expect((await request(app).get("/atomic-units")).status).toBe(401);
  });

  it("the customer confirmation link is reachable — a customer has no login", async () => {
    const res = await request(app).get("/confirm/some-token");
    expect(res.status).not.toBe(401);
  });

  it("every allowlist entry resolves to itself", () => {
    // A typo'd entry silently protects nothing and grants nothing; this catches the case where
    // an entry's own declared path does not match under the matcher.
    for (const entry of PUBLIC_ROUTES) {
      const probe = concrete(entry.prefix ? `${entry.path}/x` : entry.path);
      const method = entry.methods[0] === "*" ? "GET" : entry.methods[0];
      expect(publicRouteFor(method, probe), `${method} ${probe} should match its own entry`).not.toBeNull();
    }
  });
});
