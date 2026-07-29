/**
 * Replay stored inspections through the finding ledger.
 *
 *   npx tsx scripts/backfillFindingLedger.ts [--dry-run]
 *
 * One-shot and manual — deliberately NOT wired into `npm start`, same convention
 * as scripts/backfillInspectionCounts.ts. Reconciling on every boot would make a
 * restart part of the audit trail.
 *
 * Records pushed before the PWA sent self-describing findings carry item ids and
 * nothing else, so those get their titles and citations from the frozen
 * catalogue snapshot. The snapshot describes what the checklist said when it was
 * generated, which is the closest honest answer available — anything the
 * catalogue can't name is opened with the id as its title and no citations, and
 * says so, rather than borrowing text from a check that has since changed.
 *
 * Oldest first, through the same reconcileInspection() the live push uses, so
 * history and future can't diverge. Idempotent: re-running reconciles the same
 * rows to the same state.
 */

import { prisma } from "../src/lib/prisma";
import { parseJsonArray } from "../src/lib/json";
import { reconcileInspection, type IncomingFinding } from "../src/services/findingLedger";
import { describeItem } from "./data/checklistCatalogSnapshot";

const LEDGERED = new Set(["FAIL", "MONITOR", "BELOW_STANDARD"]);
const ACTION_ALIAS: Record<string, string> = { ACTION: "FAIL" };

interface StoredItem {
  itemId?: unknown;
  result?: unknown;
  locationId?: unknown;
  gradedState?: unknown;
  note?: unknown;
  resolutionNote?: unknown;
}

/** Reconstruct findings from an inspection's stored items. */
function findingsFromItems(itemsJson: string): {
  findings: IncomingFinding[];
  passed: string[];
  na: string[];
  undescribed: string[];
} {
  const items = parseJsonArray<StoredItem>(itemsJson);
  const findings: IncomingFinding[] = [];
  const passed: string[] = [];
  const na: string[] = [];
  const undescribed: string[] = [];

  for (const item of items) {
    if (typeof item?.itemId !== "string" || typeof item?.result !== "string") continue;
    const itemId = item.itemId;
    const result = ACTION_ALIAS[item.result] ?? item.result;

    if (result === "PASS") { passed.push(itemId); continue; }
    if (result === "NA") { na.push(itemId); continue; }
    if (!LEDGERED.has(result)) continue;

    const described = describeItem(itemId);
    if (!described) undescribed.push(itemId);

    findings.push({
      itemId,
      locationKey: typeof item.locationId === "string" ? item.locationId : "_default",
      result: result as IncomingFinding["result"],
      ...(described
        ? { title: described.title, section: described.section, citations: described.citations, critical: described.bannerListed && result === "FAIL" }
        : {}),
      // No findingText: the prose is rendered in the PWA from measured values we
      // don't have here. The reconciler falls back to naming the result, which is
      // honest — inventing a sentence the customer never saw is not.
      gradedState: typeof item.gradedState === "string" ? item.gradedState : null,
      resolutionNote: typeof item.resolutionNote === "string" ? item.resolutionNote : null,
    });
  }

  return { findings, passed, na, undescribed };
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  const inspections = await prisma.healthInspection.findMany({
    orderBy: { inspectionDate: "asc" },
    select: {
      id: true, visitId: true, propertyId: true, customerId: true,
      jurisdictionId: true, inspectionDate: true, technicianId: true,
      itemsJson: true,
      technician: { select: { name: true } },
    },
  });

  console.log(`Replaying ${inspections.length} inspection(s)${dryRun ? " (dry run)" : ""}…`);

  const totals = { opened: 0, reobserved: 0, passObserved: 0, superseded: 0 };
  const unnamed = new Set<string>();

  for (const inspection of inspections) {
    const { findings, passed, na, undescribed } = findingsFromItems(inspection.itemsJson);
    undescribed.forEach((id) => unnamed.add(id));

    if (dryRun) {
      console.log(
        `  ${inspection.inspectionDate.toISOString().slice(0, 10)} ${inspection.id}: ` +
        `${findings.length} finding(s), ${passed.length} pass, ${na.length} n/a`,
      );
      continue;
    }

    const result = await reconcileInspection(
      {
        inspectionId: inspection.id,
        visitId: inspection.visitId,
        propertyId: inspection.propertyId,
        customerId: inspection.customerId,
        jurisdictionId: inspection.jurisdictionId,
        inspectionDate: inspection.inspectionDate,
        technicianId: inspection.technicianId,
        technicianName: inspection.technician?.name ?? "Backfill (historical record)",
        passedItemIds: passed,
        naItemIds: na,
      },
      findings,
    );

    totals.opened += result.opened;
    totals.reobserved += result.reobserved;
    totals.passObserved += result.passObserved;
    totals.superseded += result.superseded;
  }

  console.log(
    dryRun
      ? "Dry run complete — nothing written."
      : `Done. opened=${totals.opened} reobserved=${totals.reobserved} ` +
        `passObserved=${totals.passObserved} superseded=${totals.superseded}`,
  );
  if (unnamed.size > 0) {
    console.warn(
      `\n${unnamed.size} item id(s) are not in the catalogue snapshot: ${[...unnamed].sort().join(", ")}\n` +
      "Those findings carry the id as their title and no citations. They must not go on a " +
      "certificate until someone identifies them — regenerate the snapshot if the checklist has moved on.",
    );
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
