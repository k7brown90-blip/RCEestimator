/**
 * Plural → singular, for matching a tech's words against a catalog written in the singular.
 *
 * P021 / P019 finding F1. The price book says "Duplex Receptacle" and "Toggle Switch"; a tech
 * writes "5 duplex receptacles" and "(2) 3-way switches". A SQL `contains` on "receptacles"
 * cannot match "Receptacle", so P019 §2c reproduced the exact controlled pair — singular found
 * the item, plural returned UNMATCHED — and the old longest-token retry could not rescue it,
 * because the plural noun was itself the longest token.
 *
 * ── SCOPE OF THIS FUNCTION, DELIBERATELY SMALL ───────────────────────────────────────────────
 *
 * This is NOT a stemmer and must not become one. Stemming ("lighting" → "light", "wiring" →
 * "wire") changes what a word means in this trade and would widen matches in ways nobody
 * reviewed. This handles regular English plural endings and a short list of electrical words
 * where the regular rule gives the wrong answer.
 *
 * The caller matches on BOTH the original token and this result, so a false singularisation
 * cannot lose a match — it can only add a candidate. That is why the rules below are allowed to
 * be simple: their failure mode is a slightly wider candidate list, which the tech is reading
 * anyway. Never make this function authoritative on its own.
 */

/**
 * Words whose regular plural rule would produce a wrong or harmful stem.
 *
 * `-ss` words are the trap the naive `-s` rule falls into: "class", "boss", "bypass", and in this
 * trade "buss" (bus bar). Stripping the final s turns them into different words.
 */
const NEVER_STRIP = new Set([
  "gas", "bus", "buss", "class", "brass", "glass", "press", "less", "plus", "cross",
  // Trade words that already end in s and are not plurals.
  "nms", "emt", "pvc", "mc", "ac", "thhn", "romex", "gfci", "afci",
]);

/** Irregulars that matter here. Kept explicit rather than inferred. */
const IRREGULAR: Record<string, string> = {
  boxes: "box",
  bushes: "bush",
  feet: "foot",
  inches: "inch",
  branches: "branch",
  switches: "switch",
  benches: "bench",
};

/**
 * Return the singular form, or the input unchanged when no rule applies.
 * Case-insensitive in, lower-case out — the caller matches case-insensitively.
 */
export function singularize(raw: string): string {
  const w = raw.trim().toLowerCase();
  if (w.length < 4) return w; // "as", "is", "gas" — too short for a plural rule to be safe
  if (IRREGULAR[w]) return IRREGULAR[w];
  if (NEVER_STRIP.has(w)) return w;
  if (w.endsWith("ss")) return w; // class, bypass, buss

  // "batteries" → "battery", "assemblies" → "assembly"
  if (w.endsWith("ies") && w.length > 4) return `${w.slice(0, -3)}y`;

  // "switches" → "switch", "boxes" → "box", "bushes" → "bush", "dishes" → "dish"
  if (/(ch|sh|s|x|z)es$/.test(w)) return w.slice(0, -2);

  // "receptacles" → "receptacle", "lights" → "light", "conduits" → "conduit"
  if (w.endsWith("s")) return w.slice(0, -1);

  return w;
}
