/**
 * Refresh Draft Item Snapshots
 *
 * After re-pricing the atomic catalog (filling in "PRICE TBD" rows with real
 * landed costs and re-seeding via `scripts/seedAtomicUnits.ts`), any
 * `EstimateItem` rows that were created BEFORE the price update still carry
 * their old `snapshotMaterialCost` (likely $0). The validator now treats
 * `ZERO_MATERIAL` as a blocking error, which would jam every in-flight draft.
 *
 * This script walks every `EstimateItem` belonging to a draft/review estimate
 * and, when its `snapshotMaterialCost` is below the current catalog
 * `baseMaterialCost`, rewrites the snapshot to match and recomputes the
 * per-item `materialCost` + `totalCost`. It then triggers `recalculateOption`
 * so option/estimate totals stay in sync.
 *
 * It does NOT touch sent/accepted estimates — those are locked.
 *
 * Run: `cd app && npx tsx scripts/refreshDraftItemSnapshots.ts`
 *      `--dry-run` to preview without writing.
 */

import { PrismaClient } from "@prisma/client";
import { EstimateService } from "../src/services/estimateService";

const prisma = new PrismaClient();
const service = new EstimateService(prisma);

const DRY_RUN = process.argv.includes("--dry-run");
const TARGET_STATUSES = ["draft", "review"];

async function main() {
  console.log(
    `${DRY_RUN ? "[DRY RUN] " : ""}Refreshing item snapshots on ${TARGET_STATUSES.join(", ")} estimates...\n`
  );

  const estimates = await prisma.estimate.findMany({
    where: { status: { in: TARGET_STATUSES } },
    select: { id: true, title: true, status: true },
    orderBy: { createdAt: "asc" },
  });
  console.log(`Found ${estimates.length} estimate(s) to scan.\n`);

  const touchedOptions = new Set<string>();
  let updatedItems = 0;
  let skippedItems = 0;

  for (const est of estimates) {
    const items = await prisma.estimateItem.findMany({
      where: { estimateOption: { estimateId: est.id } },
      include: { atomicUnit: true, modifiers: true },
    });
    for (const item of items) {
      const catalog = item.atomicUnit.baseMaterialCost;
      const snap = item.snapshotMaterialCost;
      // Only refresh when the catalog now carries a real price AND the
      // snapshot is materially below it (>5% gap). Don't touch items where
      // the snapshot was intentionally higher (e.g. resolver-injected cable
      // material) or already in sync.
      if (catalog <= 0) {
        skippedItems++;
        continue;
      }
      if (snap >= catalog * 0.95) {
        skippedItems++;
        continue;
      }
      const newSnap = catalog;
      let materialMult = 1.0;
      let laborMult = 1.0;
      for (const m of item.modifiers) {
        materialMult *= m.materialMult;
        laborMult *= m.laborMultiplier;
      }
      const resolvedCableMat = item.resolvedCableMaterialCost ?? 0;
      const resolvedCableLab = item.resolvedCableLaborCost ?? 0;
      const newMaterial = parseFloat(
        (newSnap * item.quantity * materialMult + resolvedCableMat).toFixed(2)
      );
      const newLabor = parseFloat(
        (
          item.snapshotLaborHrs * item.quantity * laborMult * item.snapshotLaborRate +
          resolvedCableLab
        ).toFixed(2)
      );
      const newTotal = parseFloat((newMaterial + newLabor).toFixed(2));
      console.log(
        `  [${est.title || est.id.slice(0, 8)}] ${item.atomicUnit.code} ` +
          `snap $${snap.toFixed(2)} -> $${newSnap.toFixed(2)} (mat $${item.materialCost.toFixed(2)} -> $${newMaterial.toFixed(2)})`
      );
      if (!DRY_RUN) {
        await prisma.estimateItem.update({
          where: { id: item.id },
          data: {
            snapshotMaterialCost: newSnap,
            materialCost: newMaterial,
            laborCost: newLabor,
            totalCost: newTotal,
          },
        });
        touchedOptions.add(item.estimateOptionId);
      }
      updatedItems++;
    }
  }

  if (!DRY_RUN) {
    for (const optionId of touchedOptions) {
      await service.recalculateOption(optionId);
    }
  }

  console.log(
    `\n${DRY_RUN ? "[DRY RUN] Would update" : "Updated"} ${updatedItems} item(s). ` +
      `Skipped ${skippedItems}. Recalculated ${touchedOptions.size} option(s).`
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
