/**
 * Which code jurisdiction governs an address.
 *
 * This used to be guessed on the technician's phone by fuzzy-matching the city
 * name against a label list, with an unrecognised city silently falling through
 * to Rutherford — meaning a Nashville property could be inspected against the
 * 2017 NEC without anyone noticing. Jurisdiction determines which code edition
 * applies, so it's an office decision, not a field guess.
 *
 * Resolution order, most specific first:
 *   1. Property.jurisdictionId  — explicit per-address override
 *   2. CompanySetting.territories, matched on ZIP
 *   3. A small city map for the areas Red Cedar actually works
 *   4. Default — reported as `source: "default"` so the PWA can say so out loud
 *
 * The full jurisdiction profiles (NEC edition, citation overrides, amendments)
 * live in field/src/data/jurisdictions.ts; this only resolves the id.
 */

import { prisma } from "../lib/prisma";
import { parseJsonArray } from "../lib/json";

export type JurisdictionSource = "property" | "territory" | "city" | "default";

export interface ResolvedJurisdiction {
  jurisdictionId: string;
  source: JurisdictionSource;
}

/** Must stay in step with field/src/data/jurisdictions.ts. */
export const KNOWN_JURISDICTION_IDS = [
  "murfreesboro",
  "brentwood",
  "rutherford",
  "franklin",
  "nashville",
] as const;

export type JurisdictionId = (typeof KNOWN_JURISDICTION_IDS)[number];

export const DEFAULT_JURISDICTION_ID: JurisdictionId = "rutherford";

/**
 * Cities Red Cedar works, normalised. Deliberately an explicit map rather than a
 * substring match: "Franklin" must not match "Franklin County", and an unknown
 * city must fall through to the default so it gets flagged.
 */
const CITY_TO_JURISDICTION: Record<string, JurisdictionId> = {
  murfreesboro: "murfreesboro",
  smyrna: "rutherford",
  "la vergne": "rutherford",
  lavergne: "rutherford",
  eagleville: "rutherford",
  christiana: "rutherford",
  brentwood: "brentwood",
  franklin: "franklin",
  nashville: "nashville",
  antioch: "nashville",
  hermitage: "nashville",
  madison: "nashville",
  "old hickory": "nashville",
};

interface TerritoryRow {
  zip?: unknown;
  jurisdictionId?: unknown;
}

export function isKnownJurisdiction(value: unknown): value is JurisdictionId {
  return typeof value === "string" && (KNOWN_JURISDICTION_IDS as readonly string[]).includes(value);
}

/** ZIP → jurisdiction from the owner-editable territories setting. */
async function territoryJurisdictions(): Promise<Map<string, JurisdictionId>> {
  const row = await prisma.companySetting.findUnique({ where: { key: "territories" } });
  const map = new Map<string, JurisdictionId>();
  for (const entry of parseJsonArray<TerritoryRow>(row?.valueJson)) {
    const zip = typeof entry.zip === "string" ? entry.zip.trim() : "";
    const jurisdictionId = entry.jurisdictionId;
    if (zip && isKnownJurisdiction(jurisdictionId)) {
      map.set(zip, jurisdictionId);
    }
  }
  return map;
}

export interface ResolvableProperty {
  jurisdictionId?: string | null;
  city: string;
  state: string;
  postalCode: string;
}

export async function resolveJurisdiction(property: ResolvableProperty): Promise<ResolvedJurisdiction> {
  if (isKnownJurisdiction(property.jurisdictionId)) {
    return { jurisdictionId: property.jurisdictionId, source: "property" };
  }

  // ZIP beats city: ZIPs don't collide, city names do, and the territories row
  // is where the owner already records the code cycle for an area.
  const zip = property.postalCode?.trim().slice(0, 5);
  if (zip) {
    const byZip = await territoryJurisdictions();
    const match = byZip.get(zip);
    if (match) return { jurisdictionId: match, source: "territory" };
  }

  const city = property.city?.trim().toLowerCase();
  const byCity = city ? CITY_TO_JURISDICTION[city] : undefined;
  if (byCity) return { jurisdictionId: byCity, source: "city" };

  return { jurisdictionId: DEFAULT_JURISDICTION_ID, source: "default" };
}

/**
 * Resolve several properties without re-reading the territories setting per row.
 * Used by the assignments endpoint, which returns a technician's whole queue.
 */
export async function resolveJurisdictions<T extends ResolvableProperty>(
  properties: T[],
): Promise<Map<T, ResolvedJurisdiction>> {
  const byZip = await territoryJurisdictions();
  const results = new Map<T, ResolvedJurisdiction>();

  for (const property of properties) {
    if (isKnownJurisdiction(property.jurisdictionId)) {
      results.set(property, { jurisdictionId: property.jurisdictionId, source: "property" });
      continue;
    }
    const zip = property.postalCode?.trim().slice(0, 5);
    const zipMatch = zip ? byZip.get(zip) : undefined;
    if (zipMatch) {
      results.set(property, { jurisdictionId: zipMatch, source: "territory" });
      continue;
    }
    const city = property.city?.trim().toLowerCase();
    const cityMatch = city ? CITY_TO_JURISDICTION[city] : undefined;
    results.set(property, cityMatch
      ? { jurisdictionId: cityMatch, source: "city" }
      : { jurisdictionId: DEFAULT_JURISDICTION_ID, source: "default" });
  }

  return results;
}
