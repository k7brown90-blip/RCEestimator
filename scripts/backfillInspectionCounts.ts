/**
 * One-shot backfill: populate the per-result counts on v1 HealthInspection rows.
 *
 * v1 records stored only a headline score, so the CRM's list views have nothing
 * to show once the score is gone. This parses each row's itemsJson and counts
 * the results, normalising the retired `ACTION` state to `FAIL` as it goes.
 *
 * Rows stay at schemaVersion 'v1' — their PDFs still render with the score they
 * were delivered with. This only gives the list views something uniform to show.
 *
 * Run manually after deploying the health_inspection_v2 migration:
 *     npx tsx scripts/backfillInspectionCounts.ts
 * Deliberately NOT wired into the start script: it's a one-time data fix, not
 * something that should re-run on every deploy.
 */

import { prisma } from "../src/lib/prisma";
import { parseJsonArray } from "../src/lib/json";

/** `ACTION` was renamed `FAIL`; stored rows still say ACTION. */
function normalizeResult(raw: unknown): string {
  const value = typeof raw === "string" ? raw : "";
  return value === "ACTION" ? "FAIL" : value;
}

async function main(): Promise<void> {
  const inspections = await prisma.healthInspection.findMany({
    select: { id: true, itemsJson: true, schemaVersion: true },
  });

  let updated = 0;
  let skipped = 0;

  for (const inspection of inspections) {
    const items = parseJsonArray<{ result?: unknown }>(inspection.itemsJson);
    if (items.length === 0) {
      skipped += 1;
      continue;
    }

    const counts = { failCount: 0, monitorCount: 0, passCount: 0, belowStandardCount: 0, naCount: 0 };
    for (const item of items) {
      switch (normalizeResult(item.result)) {
        case "FAIL": counts.failCount += 1; break;
        case "MONITOR": counts.monitorCount += 1; break;
        case "PASS": counts.passCount += 1; break;
        case "BELOW_STANDARD": counts.belowStandardCount += 1; break;
        case "NA": counts.naCount += 1; break;
        default: break; // unrecognised state — counted nowhere rather than guessed
      }
    }

    await prisma.healthInspection.update({ where: { id: inspection.id }, data: counts });
    updated += 1;
  }

  console.log(
    `[backfillInspectionCounts] ${updated} inspection(s) updated, ${skipped} skipped (no parseable items).`,
  );
}

main()
  .catch((error) => {
    console.error("[backfillInspectionCounts] failed:", error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
