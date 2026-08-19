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

describe("pointing at something to change", () => {
  /**
   * Kyle: *"I need a way to show you specifically what needs changed."* The build stamps every
   * host element with `data-rce-src`, the picker reads it off whatever he taps, and this pins the
   * part that has to survive the wire: the FILE AND LINE, and the instruction attached to it. If
   * the source location is lost in transit the feature is worth nothing — a change request with
   * no location is the round trip it was built to remove.
   */
  it("carries the source location and the instruction through to the log", async () => {
    await request(app).post("/debug/client-log").send(report({
      message: "1 change request(s) from /estimate-intake",
      entries: [{
        id: 1,
        at: "2026-08-18T21:05:00.000Z",
        kind: "pick",
        text: 'Move this above the total — on "Create job & schedule" [src/pages/PriceBookIntakePage.tsx:412]',
        data: {
          changeRequested: "Move this above the total",
          source: "src/pages/PriceBookIntakePage.tsx:412",
          element: "<button>",
          text: "Create job & schedule",
          classes: "btn btn-primary mt-3",
          page: "/estimate-intake",
        },
      }],
    }));

    const details = JSON.parse(created.at(-1)!.detailsJson as string);
    const pick = details.entries[0];
    expect(pick.kind).toBe("pick");
    expect(pick.data.source).toBe("src/pages/PriceBookIntakePage.tsx:412");
    expect(pick.data.changeRequested).toBe("Move this above the total");
    expect(pick.data.text).toBe("Create job & schedule");
  });

  it("still accepts a pick whose element carried no stamp", async () => {
    // A library element, or a stale cached bundle. The request is still worth having; what must
    // NOT happen is the client inventing a plausible-looking file and line.
    const res = await request(app).post("/debug/client-log").send(report({
      entries: [{
        id: 1, at: "2026-08-18T21:05:00.000Z", kind: "pick",
        text: "Make this bigger — on \"OK\" [unknown source]",
        data: { changeRequested: "Make this bigger", source: null, element: "<button>" },
      }],
    }));
    expect(res.status).toBe(201);
    expect(JSON.parse(created.at(-1)!.detailsJson as string).entries[0].data.source).toBeNull();
  });
});

describe("trimming never discards what a person deliberately said", () => {
  /**
   * 2026-08-19: Kyle pointed at eleven things and NINE arrived. The buffer was cut to its newest
   * 120 entries on the way out, and a `pick` was trimmed on exactly the same terms as a routine
   * `GET … → 200`, so his two earliest requests — the typed-out, deliberate ones — were the first
   * things thrown away. Twenty-six minutes of ordinary navigation outranked them.
   *
   * Context is a by-product; a pick or a note is a person choosing to say something. When room
   * runs out, the by-product goes.
   */
  it("keeps every pick even when context floods the buffer", async () => {
    const { trimForReport } = await import("../client/src/lib/debugBus");

    const noise = Array.from({ length: 400 }, (_, i) => ({
      id: i, at: "2026-08-19T11:00:00.000Z", kind: "network" as const, text: `GET /x/${i} → 200`,
    }));
    // Two picks at the very START — the exact position that lost Kyle's.
    const picks = [
      { id: 900, at: "2026-08-19T11:00:00.000Z", kind: "pick" as const, text: "first request" },
      { id: 901, at: "2026-08-19T11:00:01.000Z", kind: "pick" as const, text: "second request" },
    ];

    const trimmed = trimForReport([...picks, ...noise], 120);

    expect(trimmed).toHaveLength(120);
    expect(trimmed.filter((e) => e.kind === "pick")).toHaveLength(2);
    expect(trimmed.map((e) => e.text)).toContain("first request");
    expect(trimmed.map((e) => e.text)).toContain("second request");
  });

  it("keeps notes too, and drops the OLDEST context first", async () => {
    const { trimForReport } = await import("../client/src/lib/debugBus");
    const entries = [
      { id: 1, at: "t", kind: "note" as const, text: "what I expected" },
      ...Array.from({ length: 50 }, (_, i) => ({
        id: 100 + i, at: "t", kind: "log" as const, text: `line ${i}`,
      })),
    ];

    const trimmed = trimForReport(entries, 10);
    expect(trimmed.map((e) => e.text)).toContain("what I expected");
    // The survivors are the most recent context, not an arbitrary slice.
    expect(trimmed.map((e) => e.text)).toContain("line 49");
    expect(trimmed.map((e) => e.text)).not.toContain("line 0");
  });

  it("preserves chronological order after thinning the middle", async () => {
    const { trimForReport } = await import("../client/src/lib/debugBus");
    const entries = [
      { id: 1, at: "t", kind: "pick" as const, text: "A" },
      ...Array.from({ length: 20 }, (_, i) => ({ id: 10 + i, at: "t", kind: "log" as const, text: `n${i}` })),
      { id: 99, at: "t", kind: "pick" as const, text: "Z" },
    ];
    const ids = trimForReport(entries, 5).map((e) => e.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(ids[0]).toBe(1);
    expect(ids.at(-1)).toBe(99);
  });

  it("the server accepts a full-size report rather than 400-ing the fix away", async () => {
    // A server cap below the client's would silently undo all of the above.
    const entries = Array.from({ length: 240 }, (_, i) => ({
      id: i, at: "2026-08-19T11:00:00.000Z", kind: "network", text: "x",
    }));
    const res = await request(app)
      .post("/debug/client-log")
      .send(report({ entries, droppedContextLines: 12 }));
    expect(res.status).toBe(201);
    expect(JSON.parse(created.at(-1)!.detailsJson as string).droppedContextLines).toBe(12);
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
