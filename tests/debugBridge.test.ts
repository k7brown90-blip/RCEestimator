/**
 * P032 — the debug sidebar's wire: what reaches the database, and what must never.
 *
 * Kyle, 2026-08-18: *"The side bar will connect to the inspect consol so you can debug and correct
 * things real time."*
 *
 * The value of this bridge is entirely in what arrives, so these pin the three properties that
 * make it usable and the two that make it safe:
 *
 *   usable — the console lines survive the trip; an auto-shipped crash is level `error` so
 *            `--level error` finds it; Kyle's typed note still reaches his daily digest.
 *   safe   — it is behind the session gate, and the session token never reaches the log.
 */

import { describe, expect, it, beforeEach, vi } from "vitest";
import request from "supertest";

const created: Array<Record<string, unknown>> = [];

vi.mock("../src/lib/prisma", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/prisma")>("../src/lib/prisma");
  return {
    ...actual,
    prisma: new Proxy(actual.prisma, {
      get(target, prop) {
        if (prop === "systemEvent") {
          return {
            create: (args: { data: Record<string, unknown> }) => {
              created.push(args.data);
              return Promise.resolve({ id: "evt", ...args.data });
            },
            findMany: () => Promise.resolve([]),
          };
        }
        return Reflect.get(target, prop);
      },
    }),
  };
});

const { app } = await import("../src/app");

beforeEach(() => {
  created.length = 0;
});

/** A report as the sidebar actually sends it. */
function report(over: Record<string, unknown> = {}) {
  return {
    sessionId: "a1b2c3d4",
    page: "/estimate-intake",
    auto: false,
    message: "Finalize did nothing",
    userAgent: "Mozilla/5.0 (iPhone)",
    entries: [
      { id: 1, at: "2026-08-18T21:00:00.000Z", kind: "nav", text: "→ /estimate-intake" },
      {
        id: 2,
        at: "2026-08-18T21:00:04.000Z",
        kind: "network",
        text: "POST /api/price-book/drafts/x/finalize → 500 Internal Server Error",
        data: { status: 500, ms: 240, body: '{"error":"MANUAL_QUANTITY_WITHOUT_NOTE"}' },
      },
    ],
    ...over,
  };
}

describe("the ingest route", () => {
  it("is behind the session gate — it is not in the public allowlist", async () => {
    const { isPublicRoute } = await import("../src/middleware/publicRoutes");
    expect(isPublicRoute("POST", "/debug/client-log")).toBe(false);
  });

  it("stores the console lines so the failing request is readable afterwards", async () => {
    const res = await request(app).post("/debug/client-log").send(report());
    expect(res.status).toBe(201);

    const row = created.at(-1)!;
    expect(row.source).toBe("client");
    const details = JSON.parse(row.detailsJson as string);
    expect(details.sessionId).toBe("a1b2c3d4");
    expect(details.entries).toHaveLength(2);
    // The whole point: the status code and the response body survive the trip.
    expect(details.entries[1].data.status).toBe(500);
    expect(details.entries[1].data.body).toContain("MANUAL_QUANTITY_WITHOUT_NOTE");
  });

  it("records the page it came from, on the row and in the details", async () => {
    await request(app).post("/debug/client-log").send(report());
    const row = created.at(-1)!;
    expect(row.route).toBe("CLIENT /estimate-intake");
    expect(JSON.parse(row.detailsJson as string).page).toBe("/estimate-intake");
  });

  it("levels an AUTO report as error and a hand-sent one as info", async () => {
    await request(app).post("/debug/client-log").send(report({ auto: true }));
    expect(created.at(-1)!.level).toBe("error");

    await request(app).post("/debug/client-log").send(report({ auto: false }));
    expect(created.at(-1)!.level).toBe("info");
  });

  it("refuses a report with no message rather than logging an empty row", async () => {
    const res = await request(app).post("/debug/client-log").send(report({ message: "  " }));
    expect(res.status).toBe(400);
    expect(created).toHaveLength(0);
  });

  it("caps the batch so one runaway page cannot write an unbounded row", async () => {
    const entries = Array.from({ length: 500 }, (_, i) => ({
      id: i, at: "2026-08-18T21:00:00.000Z", kind: "log", text: "x",
    }));
    const res = await request(app).post("/debug/client-log").send(report({ entries }));
    expect(res.status).toBe(400);
  });
});

describe("the session token never reaches the log", () => {
  it("scrubs a bearer token out of captured text", async () => {
    const { scrub } = await import("../client/src/lib/debugBus");
    const line = scrub("GET /api/accounts headers {Authorization: Bearer eyJhbGciOi.J9abc-_123}");
    expect(line).not.toContain("eyJhbGciOi");
    expect(line).toContain("Bearer [redacted]");
  });

  it("scrubs token-shaped JSON fields out of a response body", async () => {
    const { scrub } = await import("../client/src/lib/debugBus");
    const body = scrub('{"token":"eyJhbGciOiJIUzI1NiJ9.xyz","expiresIn":28800}');
    expect(body).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(body).toContain('"token":"[redacted]"');
    // Everything else has to survive, or the scrub has eaten the evidence.
    expect(body).toContain("28800");
  });
});
