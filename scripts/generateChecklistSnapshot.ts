/**
 * Regenerate scripts/data/checklistCatalogSnapshot.ts from the live PWA checklist.
 *
 *   npx tsx scripts/generateChecklistSnapshot.ts
 *
 * The snapshot exists for one job: backfilling the finding ledger from records
 * pushed before the PWA started sending self-describing findings. Those rows
 * carry item ids and nothing else, and the server has no checklist of its own.
 *
 * Run this deliberately, commit the result, and read the diff. If a title or a
 * citation changes here, historical findings backfilled afterwards will be
 * described with the new text — which is exactly the re-derivation the ledger
 * exists to prevent. Once a record has been backfilled it keeps its snapshot;
 * this file only ever describes what hasn't been reconciled yet.
 */

import { writeFileSync } from "node:fs";
import path from "node:path";
import { checklist } from "../field/src/data/checklist";
import { RETIRED_ITEM_TITLES } from "../field/src/domain/compat";
import { bannerListedItemIds } from "../field/src/data/criticalItems";

const entries = checklist.map((item) => ({
  id: item.id,
  title: item.title,
  section: item.section,
  citations: item.citations,
  bannerListed: item.bannerListed,
  phase: item.phase,
}));

// Retired ids still appear in stored itemsJson, so the catalogue has to name
// them. Their citations are gone with the checks, and we say so rather than
// borrowing the merged item's — the finding was written under the old check.
const retired = Object.entries(RETIRED_ITEM_TITLES).map(([id, title]) => ({
  id,
  title,
  section: "C — Grounding & Bonding",
  citations: [] as string[],
  bannerListed: bannerListedItemIds.includes(id),
  phase: 1 as const,
}));

const all = [...entries, ...retired].sort((a, b) => a.id.localeCompare(b.id));

const body = `/**
 * Frozen description of every checklist item, for backfilling the finding ledger
 * from records that predate self-describing pushes.
 *
 * GENERATED — run \`npx tsx scripts/generateChecklistSnapshot.ts\` to regenerate.
 * Do not hand-edit: the point of a snapshot is that it is a snapshot.
 *
 * Generated ${new Date().toISOString().slice(0, 10)} from field/src/data/checklist.ts.
 */

export interface CatalogEntry {
  id: string;
  title: string;
  section: string;
  citations: string[];
  bannerListed: boolean;
  phase: 1 | 2;
}

export const CHECKLIST_CATALOG: Record<string, CatalogEntry> = ${JSON.stringify(
  Object.fromEntries(all.map((entry) => [entry.id, entry])),
  null,
  2,
)};

/** Description for an id, or null when the catalogue has never heard of it. */
export function describeItem(itemId: string): CatalogEntry | null {
  return CHECKLIST_CATALOG[itemId] ?? null;
}
`;

const out = path.join(__dirname, "data", "checklistCatalogSnapshot.ts");
writeFileSync(out, body, "utf8");
console.log(`Wrote ${all.length} catalogue entries to ${out}`);
