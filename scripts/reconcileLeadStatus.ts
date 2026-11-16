/**
 * Put every lead's Status and Call outcome back in step on "lost" (Kyle, 2026-11-15: "Rename to
 * Call outcome"; plan lead-intake-fixes, B4). Runs inside the container:
 *
 *   railway ssh -s RCEestimator "node dist/scripts/reconcileLeadStatus.js"          (dry — writes nothing)
 *   railway ssh -s RCEestimator "node dist/scripts/reconcileLeadStatus.js --apply"  (repairs them)
 *
 * THIS SCRIPT IS A WRITER with --apply. Dry by default. The logic lives in
 * src/services/leadStateRepair.ts (it applies the same reconcileLeadState rule the lead form's
 * save uses); this is only the printing.
 */

import { prisma } from "../src/lib/prisma";
import { repairLeadLostState } from "../src/services/leadStateRepair";

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  console.log(`Reconcile lead Status / Call outcome${apply ? " — APPLYING" : " (DRY RUN — nothing written)"} — ${new Date().toISOString()}`);

  const report = await repairLeadLostState({ apply });
  console.log(`  ${report.scanned} lead(s) scanned\n`);

  console.log(apply ? "REPAIRED:" : "WOULD REPAIR:");
  if (report.changes.length === 0) console.log("  (none)");
  for (const c of report.changes) {
    console.log(
      `  ${c.name}  [${c.id}]  status ${c.from.status} / outcome ${c.from.leadStatus}`
      + `  ->  status ${c.to.status} / outcome ${c.to.leadStatus}`,
    );
  }

  if (report.wonWithoutConversion.length > 0) {
    console.log("\nOUTCOME \"won\" BUT NOT CONVERTED (left as they are — you decide each one):");
    console.log("  Causes: Savannah's call-disposition tool writes \"won\"; deleting an account resets its");
    console.log("  converted leads to status new and leaves \"won\" behind.");
    for (const w of report.wonWithoutConversion) {
      console.log(`  ${w.name}  [${w.id}]  status ${w.status} / outcome ${w.leadStatus}`);
    }
  }

  console.log(`\n${apply ? "Repaired" : "Would repair"} ${report.changes.length} · \"won\" not converted ${report.wonWithoutConversion.length}`);
  if (!apply && report.changes.length > 0) console.log("Nothing was written. Run again with --apply to repair them.");
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
