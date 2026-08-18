/**
 * P021 — Matcher Tier 1: plurals (F1) and the removal of the longest-token retry (F2).
 *
 * The fixture is Kyle's actual sunroom walkthrough from 2026-08-16, reproduced in P019 §2. These
 * tests pin the two failures Tier 1 fixes and, just as importantly, pin the ones it must NOT
 * touch — "12 ft x 12 ft" still parses as quantity 12, because quantity parsing is P023's design
 * space and a Tier 1 that grows is how scope dies.
 *
 * Requires the imported catalog in the test database.
 */

import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { singularize } from "../src/services/singularize";

interface ResolvedRow {
  raw: string;
  parsedQuantity: number | null;
  searchTerm: string;
  status: "MATCHED" | "AMBIGUOUS" | "UNMATCHED";
  matchedOn: string;
  candidates: Array<{ itemId: string; description: string | null }>;
}

async function resolve(rows: string[]): Promise<ResolvedRow[]> {
  const res = await request(app)
    .post("/price-book/resolve-walkthrough")
    .send({ rows: rows.map((raw) => ({ raw })) });
  expect(res.status).toBe(200);
  return res.body.rows as ResolvedRow[];
}

const ids = (r: ResolvedRow) => r.candidates.map((c) => c.itemId);

beforeAll(async () => {
  // These assertions are meaningless against an empty catalog — fail loudly rather than pass
  // vacuously, which is exactly the trap P019 §5 caught me in.
  const n = await prisma.priceBookAtomic.count({ where: { retiredAt: null } });
  expect(n, "the test database needs the imported catalog for these fixtures").toBeGreaterThan(100);
});

describe("F1 — plurals resolve to the singular catalog entry", () => {
  it('"toggle switches" now finds the toggle switches', async () => {
    const [row] = await resolve(["toggle switches"]);
    expect(row.status, "was UNMATCHED before P021").not.toBe("UNMATCHED");
    expect(ids(row)).toEqual(expect.arrayContaining(["R004"]));
  });

  it('"5 duplex receptacles" now finds the duplex receptacles', async () => {
    const [row] = await resolve(["5 duplex receptacles"]);
    expect(row.status).not.toBe("UNMATCHED");
    expect(ids(row)).toEqual(expect.arrayContaining(["R001", "R002"]));
    expect(row.parsedQuantity).toBe(5);
  });

  it('"(2) 3-way switches" now finds the 3-way switch', async () => {
    const [row] = await resolve(["(2) 3-way switches"]);
    expect(row.status).not.toBe("UNMATCHED");
    expect(ids(row)).toEqual(expect.arrayContaining(["R005"]));
  });

  it("singular and plural give the same candidates — the pair that proved the defect", async () => {
    const [sing, plur] = await resolve(["duplex receptacle", "duplex receptacles"]);
    expect(ids(plur).sort()).toEqual(ids(sing).sort());
  });
});

/*
  P021's ALL-TOKEN CONTRACT WAS SUPERSEDED BY KYLE ON 2026-08-18.

  P021 replaced a broken "longest token" retry with a strict AND across every token, and pinned
  "no all-token match -> UNMATCHED, not a guess". That was right at the time: the retry had been
  offering six load-center rows for a wall sconce, and a nonsense list teaches an operator to stop
  reading lists.

  Then Kyle tested against his own book and hit the cost of the AND. He typed "NM-B 12/3 cable 100
  feet" — an item plainly in his catalog — and got UNMATCHED, because `100` and `feet` were being
  matched as if they named the product. His instruction:

    "I want it to match on the name only. No quantity matching at all. The quantity will be
     handled during the review step."

  So the quantity is stripped before matching, and tokens are SCORED by rarity rather than
  required — P019's own F2 recommendation, which P021 deferred. What survives unchanged is the
  property that actually protected him: **the matcher offers candidates and never selects one.**

  The load-center test below still holds and still matters — it is the concrete P019 §2b failure.
*/
describe("F2 — ranking replaced the retry, and the sconce failure stays fixed", () => {
  it('"exterior sconce light" never returns load-center rows again', async () => {
    const [row] = await resolve(["exterior sconce light"]);
    const loadCenters = ids(row).filter((id) => /^A0/.test(id));
    expect(loadCenters, `A0xx rows are the P019 §2b failure: ${ids(row).join(", ")}`).toEqual([]);
  });

  it("rare words outrank common ones, so a distinctive match leads the list", async () => {
    // "receptacle" is everywhere in the catalog; "duplex" narrows it to seven rows. Whatever the
    // ordering among them, the top of the list must actually be duplex receptacles.
    const [row] = await resolve(["duplex receptacle"]);
    expect(row.candidates.length).toBeGreaterThan(0);
    for (const c of row.candidates.slice(0, 3)) {
      expect(c.description, `${c.itemId} led the list for "duplex receptacle"`).toMatch(/duplex/i);
    }
  });

  it("reports that it matched on the name", async () => {
    const rows = await resolve(["duplex receptacle", "ceiling fan", "circuit breaker"]);
    for (const r of rows) expect(r.matchedOn).toBe("name");
  });

  it("a phrase matching nothing at all is still UNMATCHED — ranking never invents a row", async () => {
    // Every word here appears in zero catalog rows. ("flange", used in the original version of
    // this test, appears in one — so that phrase was legitimately matching.)
    const [row] = await resolve(["zzqq qqzz xxyy"]);
    expect(row.status).toBe("UNMATCHED");
    expect(row.candidates).toEqual([]);
  });
});

describe("what Tier 1 must NOT change", () => {
  it('"12 ft x 12 ft" still parses quantity 12 — qty parsing is P023, not Tier 1', async () => {
    const [row] = await resolve(["12 ft x 12 ft"]);
    expect(row.parsedQuantity).toBe(12);
  });

  it('"4 LED wafer lights" now offers lighting rows rather than nothing', async () => {
    /*
      P021 pinned this as UNMATCHED, because under the AND contract one unknown word ("wafer",
      which appears nowhere in the catalog) killed the line. Kyle's 2026-08-18 instruction changed
      what should happen: he wants something he can add, and "led" and "lights" are real words that
      do name lighting rows.

      The vocabulary gap itself is unchanged and still real — his book says "Canless", the trade
      says "wafer" — and it stays a workbook/synonym question. What changed is that the screen no
      longer answers a near-miss with a dead end.
    */
    const [row] = await resolve(["4 LED wafer lights"]);
    expect(row.status).not.toBe("UNMATCHED");
    expect(row.candidates.length).toBeGreaterThan(0);
    // The quantity is read for display but plays no part in matching.
    expect(row.parsedQuantity).toBe(4);
  });

  it("cable rows still resolve", async () => {
    const rows = await resolve(["100 ft 14/2 NM", "30 ft 14/3 NM"]);
    expect(ids(rows[0])).toEqual(expect.arrayContaining(["N001"]));
    expect(ids(rows[1])).toEqual(expect.arrayContaining(["SD004"]));
    expect(rows[0].parsedQuantity).toBe(100);
    expect(rows[1].parsedQuantity).toBe(30);
  });
});

describe("singularize is a plural rule, not a stemmer", () => {
  it("handles the regular endings", () => {
    expect(singularize("receptacles")).toBe("receptacle");
    expect(singularize("switches")).toBe("switch");
    expect(singularize("boxes")).toBe("box");
    expect(singularize("lights")).toBe("light");
    expect(singularize("batteries")).toBe("battery");
  });

  it("leaves -ss words and trade words alone", () => {
    for (const w of ["bypass", "class", "brass", "romex", "emt", "gfci"]) {
      expect(singularize(w), w).toBe(w);
    }
  });

  it("does not stem — a verb-ish word keeps its meaning", () => {
    // "lighting" and "wiring" mean different things from "light" and "wire" in this trade.
    expect(singularize("lighting")).toBe("lighting");
    expect(singularize("wiring")).toBe("wiring");
  });

  it("is a no-op on short tokens and singulars", () => {
    expect(singularize("box")).toBe("box");
    expect(singularize("14/2")).toBe("14/2");
    expect(singularize("fan")).toBe("fan");
  });
});
