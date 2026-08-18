import { createHash } from "node:crypto";

/**
 * The pure half of the Kyle's-tab import: keys, units, and the parity assertion. (P030)
 *
 * Extracted for the same reason P018 extracted `quotable.ts` — `importKylesTab.ts` runs `main()`
 * when it is loaded, so a test importing it to check `slugify` would try to run an import against
 * whatever database happened to be configured. The rules live here; the script orchestrates them.
 */

/** Kyle's own labour rate, the one his sheet's formulas use. */
export const RATE = 150;

/** Excel gives numbers, strings, or nothing. Anything unparseable is null — never 0. */
export function toNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v).trim().replace(/[$,]/g, "");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export interface KyleItem {
  key: string;
  name: string;
  section: string;
  unitLabel: string | null;
  laborNormal: number | null;
  laborDifficult: number | null;
  laborVeryDifficult: number | null;
  companyCost: number | null;
  companyPrice: number | null;
  sellNormal: number | null;
  sellDifficult: number | null;
  sellVeryDifficult: number | null;
  row: number;
}

/**
 * A readable, stable key derived from the item's name.
 *
 * Kyle's 2026-08-17 reorganization ruling asks for readable keys. Same name → same key, so a
 * re-import updates rather than duplicating; the row number is deliberately NOT part of it,
 * because inserting a row above an item must not re-key it.
 */
const KEY_MAX = 72;

export function slugify(name: string): string {
  const full = name
    .normalize("NFKD")
    .replace(/[‐-―−]/g, "-") // the various dashes Excel produces
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (full.length <= KEY_MAX) return full;

  /*
    TRUNCATION MUST NOT COST UNIQUENESS, AND MUST NOT COST STABILITY.

    Kyle's longest item name is 365 characters and slugs to 339 — unusable as a key that shows up
    in URLs and logs. But naive truncation is worse than long keys: two of his load centers differ
    only in the suffix "SURFACE MOUNT" vs "RECESSED/FLUSH MOUNT", so cutting at 80 collapsed them
    into one key. The importer's duplicate gate caught it, which is the gate working, but the fix
    belongs here.

    So: cap the readable head, then append 6 hex of a digest OF THE FULL NAME. The suffix depends
    on nothing but the name, which is what keeps `same name -> same key` true across re-imports —
    a disambiguator that depended on what ELSE was in the sheet would re-key existing items the
    day Kyle adds a row.
  */
  const digest = createHash("sha1").update(name.trim()).digest("hex").slice(0, 6);
  return `${full.slice(0, KEY_MAX).replace(/-+$/g, "")}-${digest}`;
}

/**
 * The unit Kyle embeds in his item names: "… — per ft", "… — per 10-ft stick".
 *
 * His names often carry prose after the unit — "— per breaker. labor = standard breaker + NECA
 * adder", "— per bushing (2-pack unit cost)" — so the capture stops at the first punctuation
 * rather than swallowing the sentence. Cosmetic by design: this labels the quantity field, and a
 * null (35 distinct units, a handful of rows phrased differently) costs nothing but a generic
 * label. Nothing prices off it.
 */
export function unitFromName(name: string): string | null {
  const m = name.match(/[‐-―−-]\s*(per\s+[^.,;(]+)/i);
  if (!m) return null;
  const unit = m[1].trim().toLowerCase().replace(/\s+/g, " ");
  return unit || null;
}



// ─── The parity assertion ───────────────────────────────────────────────────────

export interface ParityRow { key: string; name: string; row: number; tag: string; labor: number; material: number; sell: number; expected: number; ok: boolean }

/**
 * `sell == round(labour x 150 + companyPrice, 2)` at every difficulty the row carries.
 *
 * A LABOUR-ONLY row (Diagnostics) has no companyPrice, and that is not a missing number — it buys
 * nothing, so material is genuinely zero and the sheet's own sell column confirms it
 * ($150 = 1.0 hr x $150 + $0). Treating it as zero is reading the row, not inventing a value.
 * A row missing the SELL, or missing labour where a sell exists, is a different thing entirely
 * and fails.
 */
export function checkParity(items: KyleItem[]): { rows: ParityRow[]; failures: ParityRow[] } {
  const rows: ParityRow[] = [];
  for (const it of items) {
    const trios: Array<[number | null, number | null, string]> = [
      [it.laborNormal, it.sellNormal, "N"],
      [it.laborDifficult, it.sellDifficult, "D"],
      [it.laborVeryDifficult, it.sellVeryDifficult, "VD"],
    ];
    for (const [labor, sell, tag] of trios) {
      if (labor === null && sell === null) continue; // difficulty not offered on this row
      const material = it.companyPrice ?? 0;
      const l = labor ?? 0;
      /*
        COMPARE UNROUNDED, TO THE CENT — do not round one side only.

        Kyle's sheet stores the full float: "Decora Switch, 3-Way" carries sell 82.005, which is
        exactly 0.4375 hr x $150 + $16.38. Rounding the expectation to 82.01 and comparing it to a
        stored 82.005 manufactures a half-cent failure out of a row that is precisely right, and
        would have stopped an import over the agent's own arithmetic rather than over Kyle's data.
        The claim being asserted is "sell equals labour x rate + material to the cent", so both
        sides stay unrounded and the tolerance is half a cent.
      */
      const raw = l * RATE + material;
      const expected = Math.round(raw * 100) / 100;
      const ok = sell !== null && Math.abs(raw - sell) <= 0.005;
      rows.push({ key: it.key, name: it.name, row: it.row, tag, labor: l, material, sell: sell ?? NaN, expected, ok });
    }
  }
  return { rows, failures: rows.filter((r) => !r.ok) };
}

