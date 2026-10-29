/**
 * Commit a new billed labour rate across the whole book — the command-line door.
 *
 * Kyle, 2026-09-01: "I want to drop the labor rate to $100 an hour. This is a better market rate for
 * this area and I want to commit to it now."
 * Kyle, 2026-10-27: "I want to be able to edit the chosen hourly rate in the app. This way we do not
 * need to code everytime we need to update." — the app now has the screen (Settings -> Billed labor
 * rate). This script and that screen call the SAME code, src/services/billedRateChange.ts; read its
 * header for the three places the rate lives and the PENNY / RATE-AS-MATERIAL / PER-DOLLAR / OTHER
 * safety classes. Nothing is decided here.
 *
 *   node dist/scripts/setLaborRate.js                 dry run at the rate already in the book
 *   node dist/scripts/setLaborRate.js --rate 100      dry run at an explicit rate
 *   node dist/scripts/setLaborRate.js --rate 100 --apply
 *   ... --apply --force      also overwrite rows of an unknown shape (OTHER) with the formula
 *
 * Unlike the screen, --apply refuses while OTHER rows exist unless --force is given.
 */

import { PrismaClient } from "@prisma/client";
import { applyBilledRate, billedRateProblem, previewBilledRate } from "../src/services/billedRateChange";

const prisma = new PrismaClient();
const EDITED_BY = "claude:labor-rate-script";
const SCRIPT_REV = "setLaborRate rev 2026-10-27"; // grep target so a deploy check cannot match an older build

const money = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `$${n.toFixed(2)}`);

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const force = process.argv.includes("--force");

  const cell = await prisma.priceBookRateConfig.findUnique({ where: { key: "billedLaborRate" } });
  const raw = arg("rate");
  const newRate = raw !== null ? Number(raw) : cell?.numberValue ?? NaN;
  const problem = billedRateProblem(newRate);
  if (problem) throw new Error(`Bad --rate ${raw ?? "(none, and the book has no rate)"}: ${problem}`);

  const preview = await previewBilledRate(prisma, newRate, { includeOther: force });
  console.log(`${apply ? "APPLYING labour rate change" : "DRY RUN — no writes (pass --apply to write)"}  [${SCRIPT_REV}]`);
  console.log(`Rate Config billedLaborRate: ${preview.currentRate === null ? "blank" : `$${preview.currentRate}/hr`} → $${newRate}/hr`);
  console.log("");
  console.log(`${preview.rowsInBook} rows in the book. ${preview.repriceCount} change (${preview.assemblyCount} of them assemblies); ${preview.unchangedCount} priced row(s) need no change.`);
  for (const c of preview.convertedRows) {
    console.log(`   ${c.kind.padEnd(17)} ${c.itemId.padEnd(48)} ${(c.description ?? "").slice(0, 36)}`);
  }
  console.log(force
    ? "--force: rows of an unknown shape (OTHER) are repriced with the plain formula too."
    : `${preview.untouchedCount} row(s) of an unknown shape (OTHER) — left as they are:`);
  for (const u of preview.untouched) console.log(`      ${u.itemId.padEnd(48)} ${(u.description ?? "").slice(0, 36).padEnd(36)} ${u.why}`);
  console.log("");
  console.log("Sample:");
  for (const s of preview.samples) {
    const cellOf = (c: { from: number | null; to: number | null } | null) => (c ? `${money(c.from)}→${money(c.to)}` : "·");
    console.log(`   ${s.itemId.padEnd(48)} ${(s.description ?? "").slice(0, 36).padEnd(36)} N ${cellOf(s.normal)}  D ${cellOf(s.difficult)}  VD ${cellOf(s.veryDifficult)}`);
  }
  console.log("");
  console.log(`${preview.openDrafts} open draft(s) will have their rate snapshot set to $${newRate}/hr (issued estimates untouched).`);
  console.log("");

  if (!apply) {
    console.log("Dry run complete.");
    return;
  }
  if (preview.untouchedCount > 0 && !force) {
    console.log("REFUSING to apply: rows of an unknown shape exist (OTHER above). Pass --force to overwrite them with the formula.");
    process.exitCode = 2;
    return;
  }

  const done = await applyBilledRate(prisma, newRate, EDITED_BY, { includeOther: force });
  console.log(`Rate Config billedLaborRate = ${done.newRate}`);
  console.log(`${done.rowsUpdated} row(s) updated; ${done.editsWritten} changed column(s) are in PriceBookEdit as ${EDITED_BY}.`);
  console.log(`${done.draftsResnapshotted} open draft(s) re-snapshotted at $${done.newRate}/hr.`);
  console.log("Done.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
