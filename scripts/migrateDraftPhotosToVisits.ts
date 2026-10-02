/**
 * Move the retired estimate-draft photos onto their jobs (plan A4, Kyle 2026-10-02: "The photos
 * in production will have to migrate to their estimate visits.").
 *
 * A SCRIPT, NOT A PRISMA MIGRATION, on purpose: a migration file runs unattended inside
 * `npm start` on every deploy, and these are photographs that cannot be retaken. Kyle runs this
 * deliberately, reads the counts, and only then takes the irreversible step (dropping the
 * `DraftPhoto` table, which is NOT done here or by any migration yet).
 *
 * DRY RUN BY DEFAULT. Nothing is written until `--apply` is passed, and even then nothing is
 * deleted — every `DraftPhoto` row stays. Re-running is safe: a photo already copied is counted
 * as "already done", never written twice. The rules for every awkward case are in
 * src/services/draftPhotoMigration.ts.
 *
 * Usage (against production):
 *   railway ssh -s RCEestimator "node dist/scripts/migrateDraftPhotosToVisits.js"
 *   railway ssh -s RCEestimator "node dist/scripts/migrateDraftPhotosToVisits.js --apply"
 */

import { PrismaClient } from "@prisma/client";
import { formatDraftPhotoReport, migrateDraftPhotos } from "../src/services/draftPhotoMigration";

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const report = await migrateDraftPhotos(prisma, { apply });
  console.log(formatDraftPhotoReport(report));
  if (!apply) console.log("\nRe-run with --apply to write the VisitPhoto rows listed above.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
