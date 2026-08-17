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

describe("F2 — the longest-token retry is gone", () => {
  it('"exterior sconce light" never returns load-center rows again', async () => {
    const [row] = await resolve(["exterior sconce light"]);
    const loadCenters = ids(row).filter((id) => /^A0/.test(id));
    expect(loadCenters, `A0xx rows are the P019 §2b failure: ${ids(row).join(", ")}`).toEqual([]);
  });

  it('"egress sconce light" no longer matches on "egress" alone', async () => {
    const [row] = await resolve(["egress sconce light"]);
    // EM007 came only from the single-word retry on "egress"; with the retry gone the
    // all-token pass decides, and it must not invent a match.
    if (row.status !== "UNMATCHED") {
      expect(ids(row)).not.toContain("EM007");
    }
  });

  it("every match is now an all-token match", async () => {
    const rows = await resolve(["duplex receptacle", "ceiling fan", "circuit breaker"]);
    for (const r of rows) expect(r.matchedOn).toBe("all words");
  });

  it("a phrase with no all-token match is UNMATCHED, not a guess", async () => {
    const [row] = await resolve(["zzqq widget flange"]);
    expect(row.status).toBe("UNMATCHED");
    expect(row.candidates).toEqual([]);
  });
});

describe("what Tier 1 must NOT change", () => {
  it('"12 ft x 12 ft" still parses quantity 12 — qty parsing is P023, not Tier 1', async () => {
    const [row] = await resolve(["12 ft x 12 ft"]);
    expect(row.parsedQuantity).toBe(12);
  });

  it('"4 LED wafer lights" stays UNMATCHED — "wafer" is a vocabulary gap, not a plural one', async () => {
    const [row] = await resolve(["4 LED wafer lights"]);
    expect(row.status).toBe("UNMATCHED");
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
