/**
 * Where an item's labour hours came from, written ONCE for the server and the CRM (Kyle, 2026-11-25: "The agents have the neca
 * units in their libraries to look through, they can type the hours in themselves").
 *
 * An agent types the three per-unit tiers and may send a reference for them (edition, page, table, row). The server stores that
 * reference in the one column that already says where an item's hours came from, `PriceBookAtomic.laborUnitBasisRaw`, as
 * `E [<reference>]` (E = per-unit, divisor 1: the agent already converted per-100 / per-1000 to per unit). The CRM item drawer
 * shows the text between the brackets as "Labour source". Every other writer keeps the plain in-app text below, which says
 * nothing a person needs to read, so the drawer shows no "Labour source" line for those rows.
 */

/** What every in-app write (the editor, an assembly, an agent item with no reference) stores in laborUnitBasisRaw. */
export const IN_APP_LABOR_BASIS_RAW = "E [in-app editor — per-unit hours, already resolved]";

/** The longest reference stored. Longer is cut, never refused: the agent's hours matter more than its citation. */
export const LABOR_SOURCE_MAX = 300;

/** The text a reference is stored as, or the plain in-app text when there is none. Brackets and line breaks in the reference are flattened. */
export function laborBasisRawFor(reference: string | null | undefined): string {
  const clean = (reference ?? "").replace(/[\r\n\t]+/g, " ").replace(/[\[\]]/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, LABOR_SOURCE_MAX).trim();
  return clean ? `E [${clean}]` : IN_APP_LABOR_BASIS_RAW;
}

/** The "Labour source" a row shows: the reference between the brackets, or null for a row that carries none (imported, in-app editor, assembly). */
export function laborSourceText(raw: string | null | undefined): string | null {
  if (!raw || raw === IN_APP_LABOR_BASIS_RAW) return null;
  const m = /^E \[(.+)\]$/s.exec(raw);
  return m ? m[1]!.trim() || null : null;
}
