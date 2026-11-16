/**
 * Sliding session renewal (Kyle, 2026-11-15: "continual access to the CRM"). `request<T>` swaps a
 * session token that is more than halfway through its life for a fresh one via POST /auth/refresh.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";

const LIFE = 8 * 60 * 60;

/** An unsigned JWT-shaped string; the client only reads the payload's iat/exp. */
function tokenAged(ageSeconds: number): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = { sub: "owner", iat: now - ageSeconds, exp: now - ageSeconds + LIFE };
  const b64url = (o: object) =>
    btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url(payload)}.sig`;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

let refreshCalls: Array<{ auth: string | null }>;

function stubFetch(refreshResponse: () => Response | Promise<Response>) {
  refreshCalls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/auth/refresh") {
        refreshCalls.push({ auth: (init?.headers as Record<string, string>)?.Authorization ?? null });
        return refreshResponse();
      }
      return json([]);
    }),
  );
}

/** Let the non-blocking refresh finish. */
async function settle() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("session renewal in request()", () => {
  it("past half-life: one refresh call, storage updated, and the request still goes out", async () => {
    const old = tokenAged(LIFE * 0.6);
    localStorage.setItem("rce_token", old);
    stubFetch(() => json({ token: "fresh-token", expiresIn: LIFE }));

    await expect(api.invoices()).resolves.toEqual([]);
    await settle();

    expect(refreshCalls).toHaveLength(1);
    expect(refreshCalls[0].auth).toBe(`Bearer ${old}`);
    expect(localStorage.getItem("rce_token")).toBe("fresh-token");
    // The request that rode along still sent the old, valid token.
    const sent = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.find(
      ([u]) => u === "/api/invoices",
    )!;
    expect((sent[1] as RequestInit).headers).toMatchObject({ Authorization: `Bearer ${old}` });
  });

  it("fresh token: no refresh", async () => {
    const fresh = tokenAged(60);
    localStorage.setItem("rce_token", fresh);
    stubFetch(() => json({ token: "should-not-happen" }));

    await api.invoices();
    await settle();

    expect(refreshCalls).toHaveLength(0);
    expect(localStorage.getItem("rce_token")).toBe(fresh);
  });

  it("no token at all: no refresh", async () => {
    stubFetch(() => json({ token: "should-not-happen" }));
    await api.invoices();
    await settle();
    expect(refreshCalls).toHaveLength(0);
  });

  it("a token that cannot be decoded is left alone", async () => {
    localStorage.setItem("rce_token", "not-a-jwt");
    stubFetch(() => json({ token: "should-not-happen" }));
    await api.invoices();
    await settle();
    expect(refreshCalls).toHaveLength(0);
    expect(localStorage.getItem("rce_token")).toBe("not-a-jwt");
  });

  it("two concurrent requests share one refresh", async () => {
    localStorage.setItem("rce_token", tokenAged(LIFE * 0.75));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    stubFetch(async () => {
      await gate;
      return json({ token: "fresh-token" });
    });

    const both = Promise.all([api.invoices(), api.jobs()]);
    release();
    await both;
    await settle();

    expect(refreshCalls).toHaveLength(1);
    expect(localStorage.getItem("rce_token")).toBe("fresh-token");
  });

  it("a refused refresh leaves the token unchanged and does not throw", async () => {
    const old = tokenAged(LIFE * 0.9);
    localStorage.setItem("rce_token", old);
    stubFetch(() => json({ error: "Invalid or expired session" }, 401));

    await expect(api.invoices()).resolves.toEqual([]);
    await settle();

    expect(refreshCalls).toHaveLength(1);
    expect(localStorage.getItem("rce_token")).toBe(old);
  });

  it("a refresh that fails on the network does not throw either", async () => {
    const old = tokenAged(LIFE * 0.9);
    localStorage.setItem("rce_token", old);
    stubFetch(() => Promise.reject(new TypeError("network down")));

    await expect(api.invoices()).resolves.toEqual([]);
    await settle();

    expect(localStorage.getItem("rce_token")).toBe(old);
  });
});
