/**
 * Matching a walkthrough line to Kyle's catalog. Name only. (P031)
 *
 * Kyle, 2026-08-18, after testing against his own book:
 *
 *   *"I want it to match on the name only. No quantity matching at all. The quantity will be
 *    handled during the review step."*
 *
 * WHAT WAS BROKEN. He typed **"NM-B 12/3 cable 100 feet"** — an item that is literally in his
 * catalog as `NM-B 12/3 w/Grd — per ft` — and got UNMATCHED. Two causes, both in the old matcher:
 *
 *   1. **Quantity words became match terms.** `100` and `feet` were tokenised alongside the name,
 *      and every token had to appear in the catalog row. "feet" does not appear in "NM-B 12/3
 *      w/Grd — per ft", so the row lost on a word that was never part of the item's name.
 *   2. **AND across all tokens.** One unknown word killed the whole line. His book says "NM-B",
 *      the trade says "romex" — so "100 ft 12/2 romex" returned nothing despite "12/2" being an
 *      exact hit.
 *
 * WHAT REPLACES IT. The quantity is stripped out before matching and never consulted again, and
 * the remaining name text is SCORED rather than required: a row that hits more of the words the
 * tech wrote ranks higher. One unfamiliar word can no longer erase a good match.
 *
 * STILL NO GUESSING. This returns ranked CANDIDATES; the tech taps the one they meant. Scoring
 * changes what gets offered, never what gets chosen — the property P019 established when a
 * "longest token" retry started offering load centers for a wall sconce.
 */

import { singularize } from "./singularize";

/**
 * Units that can follow a NUMBER, used only to decide whether that number is a quantity.
 *
 * Deliberately NOT the token filter. "box" is a unit in "4 boxes" and a product noun in "New Work
 * Box" — dropping it from the tokens lost the word that names half of Kyle's box sections.
 */
const MEASURE_UNITS = new Set([
  "ft", "feet", "foot", "in", "inch", "inches", "lf", "yd", "yard", "yards",
  "ea", "each", "pc", "pcs", "piece", "pieces", "box", "boxes", "roll", "rolls",
  "stick", "sticks", "coil", "coils", "pack", "packs", "hr", "hrs", "hour", "hours",
  "rod", "rods", "switch", "switches", "receptacle", "receptacles",
]);

/** Words that carry no product meaning in any position. */
const STOP_WORDS = new Set(["of", "and", "the", "a", "an", "with", "w", "x", "qty", "quantity", "to"]);

export interface StrippedLine {
  /** The item NAME as typed, with quantities and their units removed. */
  term: string;
  /** What the tech appears to have asked for, kept for display only — never used to match. */
  quantity: number | null;
}

/**
 * Pull the quantity out of a typed line and hand back the name.
 *
 * The quantity is EXTRACTED but not used for matching — Kyle sets it in Review. It is returned
 * only so the row can show what he typed.
 *
 * A NUMBER GLUED TO A LETTER IS A SPEC, NOT A COUNT. "20a receptacle" means a 20-amp receptacle;
 * an earlier version stripped the 20 and searched for "a receptacle", throwing away the very
 * thing that identified the part. So a leading number only counts as a quantity when a space (or
 * an explicit `x`) follows it.
 */
export function stripQuantity(raw: string): StrippedLine {
  const text = raw.trim();
  let quantity: number | null = null;
  let term = text;

  // "3x decora switch" / "3 x decora switch"
  const times = /^\s*(\d+(?:\.\d+)?)\s*x\s+/i.exec(term);
  // "100 ft of 12/2", "2 ground rods" — a space is required, so "20a" is left alone.
  const leading = /^\s*(\d+(?:\.\d+)?)\s+/.exec(term);

  if (times) {
    quantity = Number(times[1]);
    term = term.slice(times[0].length);
  } else if (leading) {
    quantity = Number(leading[1]);
    term = term.slice(leading[0].length);
    // Drop the unit the count was expressed in: "100 ft of 12/2" -> "12/2".
    const unit = /^([a-z]{1,6})\.?\s*/i.exec(term);
    if (unit && MEASURE_UNITS.has(unit[1].toLowerCase())) term = term.slice(unit[0].length);
  }

  // Trailing measure: "NM-B 12/3 cable 100 feet" -> "NM-B 12/3 cable"
  const trailing = /\s+(\d+(?:\.\d+)?)\s*([a-z]{1,6})?\s*$/i.exec(term);
  if (trailing) {
    const unit = (trailing[2] ?? "").toLowerCase();
    if (unit === "" || MEASURE_UNITS.has(unit)) {
      if (quantity === null) quantity = Number(trailing[1]);
      term = term.slice(0, trailing.index);
    }
  }

  return { term: term.trim() || text, quantity };
}

/**
 * The words that actually name the thing.
 *
 * Only genuine stop words are dropped. Unit-ish nouns stay, because in Kyle's book they ARE the
 * product: "boxes" is the difference between his six New Work Box rows and everything else.
 */
export function nameTokens(term: string): string[] {
  return term
    .split(/[\s,]+/)
    .map((t) => t.replace(/[^A-Za-z0-9/.#-]/g, "").trim())
    .filter((t) => t.length >= 2 && !/^\d+$/.test(t) && !STOP_WORDS.has(t.toLowerCase()))
    .slice(0, 8);
}

export interface Scorable {
  itemId: string;
  description: string | null;
}

/**
 * Rank catalog rows against the tech's words, weighting RARE words heavily.
 *
 * This is P019's own F2 recommendation, finally implemented: *"ranked by how few rows it hits (a
 * rare word is distinctive; a common one is not)."* P021 removed the broken "longest token" retry
 * and left ranking for later; this is later.
 *
 * Why rarity rather than a plain count of hits: "light" appears in dozens of Kyle's rows and tells
 * you almost nothing, while "troubleshoot" appears in one and tells you everything. Scoring both
 * as 1 lets a pile of generic rows outrank the single row that actually named the thing. So each
 * token is worth `1 / (rows containing it)` — a word matching one row is worth a full point, a
 * word matching forty is worth a fortieth.
 *
 * Ties break toward the SHORTER description: a shorter row matching the same words is the more
 * specific answer.
 *
 * IT STILL NEVER SELECTS. Ranking decides what is offered and in what order; the tech taps the row
 * they meant. That property has survived every change to this matcher and is the reason widening
 * it is safe.
 */
export function rankCandidates<T extends Scorable>(rows: T[], tokens: string[]): T[] {
  if (tokens.length === 0) return [];
  const forms = tokens.map((t) => [...new Set([t.toLowerCase(), singularize(t.toLowerCase())])]);
  const hay = rows.map((row) => `${row.itemId} ${row.description ?? ""}`.toLowerCase());

  // How many rows each token reaches — its distinctiveness within this result pool.
  const reach = forms.map((variants) => hay.filter((h) => variants.some((v) => h.includes(v))).length);

  const scored = rows.map((row, i) => {
    let score = 0;
    forms.forEach((variants, t) => {
      if (variants.some((v) => hay[i].includes(v))) score += 1 / Math.max(reach[t], 1);
    });
    return { row, score, len: (row.description ?? row.itemId).length };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.len - b.len)
    .map((s) => s.row);
}
