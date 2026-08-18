/**
 * P031 — the walkthrough matches on the NAME, and every row can be added to the quote.
 *
 * Kyle, 2026-08-18, from his own test:
 *
 *   *"You built this wrong. It shows a potential match then logs as a question. This makes no
 *    sense… Instead of logging as a question it needs to be add to quote… I want it to match on
 *    the name only. No quantity matching at all."*
 *
 * The row he photographed had typed **"NM-B 12/3 cable 100 feet"** — an item plainly in his book —
 * and reported no match. These pin why that happened and that it cannot happen again.
 */

import { describe, expect, it } from "vitest";
import { nameTokens, rankCandidates, stripQuantity } from "../src/services/walkthroughMatch";

/** Real rows from Kyle's catalog. */
const CATALOG = [
  { itemId: "nm-b-12-3-w-grd-per-ft", description: "NM-B 12/3 w/Grd — per ft" },
  { itemId: "nm-b-12-2-w-grd-per-ft", description: "NM-B 12/2 w/Grd — per ft" },
  { itemId: "nm-b-14-2-w-grd-per-ft", description: "NM-B 14/2 w/Grd — per ft" },
  { itemId: "decora-switch-single-pole-per-switch", description: "Decora Switch, Single-Pole — per switch" },
  { itemId: "decora-switch-3-way-per-switch", description: "Decora Switch, 3-Way — per switch" },
  { itemId: "1-gang-nail-on-box-new-work-per-box", description: "1-Gang Nail-On Box, New Work — per box" },
  { itemId: "2-gang-nail-on-box-new-work-per-box", description: "2-Gang Nail-On Box, New Work — per box" },
  { itemId: "fan-box-old-new-work-rated-per-box", description: "Fan Box, Old/New Work Rated — per box" },
  { itemId: "decora-receptacle-tamper-resistant-20a-per-receptacle", description: "Decora Receptacle, Tamper-Resistant, 20A — per receptacle" },
  { itemId: "decora-receptacle-tamper-resistant-15a-per-receptacle", description: "Decora Receptacle, Tamper-Resistant, 15A — per receptacle" },
  { itemId: "ground-rod-5-8-x-8-ft", description: "Ground Rod, 5/8-inch x 8-ft, Copper-Bonded Steel, WITH ACORN CLAMP — driven, per rod" },
  { itemId: "ground-rod-clamp-acorn-1-2", description: "Ground Rod Clamp (Acorn), 1/2-inch, Bronze — per clamp" },
  { itemId: "diagnostics-troubleshooting-circuit-tracing", description: "Diagnostics / Troubleshooting / Circuit Tracing" },
];

/** What the resolver does: strip the quantity, tokenise the name, rank the catalog. */
function match(raw: string) {
  const { term, quantity } = stripQuantity(raw);
  const tokens = nameTokens(term);
  return { term, quantity, tokens, hits: rankCandidates(CATALOG, tokens) };
}

// ─── The row Kyle photographed ─────────────────────────────────────────────────

describe("the line that came back UNMATCHED", () => {
  it('matches "NM-B 12/3 cable 100 feet" to his 12/3 row', () => {
    const r = match("NM-B 12/3 cable 100 feet");
    expect(r.hits.length).toBeGreaterThan(0);
    expect(r.hits[0].description).toBe("NM-B 12/3 w/Grd — per ft");
  });

  it("takes the quantity out of the matching entirely", () => {
    // 100 and "feet" must not reach the catalog query — they named nothing.
    const r = match("NM-B 12/3 cable 100 feet");
    expect(r.quantity).toBe(100);
    expect(r.tokens).not.toContain("100");
    expect(r.tokens).not.toContain("feet");
    expect(r.term).not.toMatch(/100|feet/i);
  });

  it("matches the same item whatever quantity is written", () => {
    const forms = ["NM-B 12/3", "100 ft of NM-B 12/3", "NM-B 12/3 cable 250 feet", "12/3 romex"];
    for (const f of forms) {
      const top = match(f).hits[0];
      expect(top?.description, `"${f}" should find the 12/3 row`).toBe("NM-B 12/3 w/Grd — per ft");
    }
  });
});

// ─── One unfamiliar word must not erase a good match ───────────────────────────

describe("scoring, not AND-ing", () => {
  it('finds NM-B from "romex", the word his book never uses', () => {
    const r = match("100 ft 12/2 romex");
    expect(r.hits[0].description).toBe("NM-B 12/2 w/Grd — per ft");
  });

  it("ranks by how many of the tech's words a row hits", () => {
    const r = match("decora switch single pole");
    // Single-Pole hits all four; 3-Way hits three; the 12/3 cable hits none.
    expect(r.hits[0].description).toBe("Decora Switch, Single-Pole — per switch");
    expect(r.hits.map((h) => h.description)).not.toContain("NM-B 12/3 w/Grd — per ft");
  });

  it("offers every genuine tie rather than pretending one is the answer", () => {
    // "new work box" describes BOTH "1-Gang Nail-On Box, New Work" and "Fan Box, Old/New Work
    // Rated" — each contains all three words. There is no basis in the text for preferring one,
    // so both are offered and Kyle taps the one he means. Ranking decides what is SHOWN; it has
    // never decided what is chosen.
    const shown = match("new work box").hits.map((h) => h.description);
    expect(shown).toContain("1-Gang Nail-On Box, New Work — per box");
    expect(shown).toContain("Fan Box, Old/New Work Rated — per box");
  });

  it("drops rows that match nothing rather than padding the list", () => {
    expect(match("lightning protection system").hits).toHaveLength(0);
  });
});

// ─── A number glued to a letter is a spec, not a count ─────────────────────────

describe("quantity stripping knows a spec when it sees one", () => {
  it('keeps the amperage in "20a receptacle"', () => {
    const r = match("20a receptacle");
    expect(r.term.toLowerCase()).toContain("20a");
    expect(r.quantity).toBeNull();
    expect(r.hits[0].description).toContain("20A");
  });

  it('keeps the gauge in "12/2" and "14/2"', () => {
    expect(match("12/2").tokens).toContain("12/2");
    expect(match("250 ft of 14/2").hits[0].description).toBe("NM-B 14/2 w/Grd — per ft");
  });

  it("reads a real leading count, and the unit it was counted in", () => {
    expect(stripQuantity("100 ft of 12/2").quantity).toBe(100);
    expect(stripQuantity("2 ground rods").quantity).toBe(2);
    expect(stripQuantity("3x decora switch").quantity).toBe(3);
    expect(stripQuantity("3 x decora switch").quantity).toBe(3);
  });

  it("keeps product nouns as match words even though they double as units", () => {
    // "boxes" is a unit in "4 boxes" and the product in "New Work Box". Dropping it as a unit
    // lost the word naming half of Kyle's box sections.
    expect(nameTokens("new work boxes")).toContain("boxes");
    const shown = match("4 new work boxes").hits.map((h) => h.description);
    expect(shown).toContain("1-Gang Nail-On Box, New Work — per box");
    expect(shown).toContain("2-Gang Nail-On Box, New Work — per box");
  });
});

// ─── Kyle's two named service lines ────────────────────────────────────────────

describe("his service lines match the way he talks", () => {
  it('"troubleshoot dead outlets in the kitchen" finds Diagnostics', () => {
    expect(match("troubleshoot dead outlets in the kitchen").hits[0].description)
      .toBe("Diagnostics / Troubleshooting / Circuit Tracing");
  });

  it('"2 hours diagnostics" finds it too, and reads the 2 as a quantity', () => {
    const r = match("2 hours diagnostics");
    expect(r.quantity).toBe(2);
    expect(r.hits[0].description).toBe("Diagnostics / Troubleshooting / Circuit Tracing");
  });
});
