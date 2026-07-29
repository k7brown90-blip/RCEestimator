/**
 * Safe readers for the JSON-in-a-String columns this schema uses throughout
 * (itemsJson, criticalFindingsJson, items, valueJson, …).
 *
 * These columns are written by several producers — the PWA, the voice agents,
 * webhooks — so a malformed value is a data problem, not a reason to 500 a page
 * that's mostly about something else. Read paths degrade to empty; write paths
 * should still validate with zod.
 */

/** Parse a JSON array column, yielding [] on null/garbage. */
export function parseJsonArray<T = unknown>(raw: string | null | undefined): T[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

/** Length of a JSON array column without materialising the elements' types. */
export function parseJsonArrayLength(raw: string | null | undefined): number {
  return parseJsonArray(raw).length;
}

/** Parse a JSON array column expected to hold strings, dropping non-strings. */
export function parseJsonStringArray(raw: string | null | undefined): string[] {
  return parseJsonArray(raw).filter((v): v is string => typeof v === "string");
}

/** Parse a JSON object column, yielding null on null/garbage. */
export function parseJsonObject<T extends object = Record<string, unknown>>(
  raw: string | null | undefined,
): T | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as T) : null;
  } catch {
    return null;
  }
}
