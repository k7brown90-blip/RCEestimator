/**
 * Fill missing line items on stored receipts by running the vision parser over
 * the photo already in the database (Kyle, 2026-09-10: seed the truck stock
 * from what the receipts say was bought — but office-typed receipts carry a
 * total and no lines, so the seed had almost nothing to read).
 *
 *   railway ssh "node dist/scripts/parseReceiptLines.js"            # dry run: parse and print
 *   railway ssh "node dist/scripts/parseReceiptLines.js --apply"    # write lineItems where empty
 *   railway ssh "node dist/scripts/parseReceiptLines.js --receipt 6ea282 --apply"
 *
 * Only receipts with category "materials", status "confirmed", NO lineItems and
 * a stored image are touched. Amount, vendor, status, job and PO are never
 * changed — only `lineItems`. A parse whose total disagrees with the typed
 * amount by more than 5% is printed with a warning and still written (the
 * lines are the itemization; the typed amount stays the money).
 */

import { PrismaClient } from "@prisma/client";
import { parseReceiptImage } from "../src/services/receiptVision";

const prisma = new PrismaClient();
const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const i = argv.indexOf("--receipt");
const ONLY = i >= 0 ? argv[i + 1] : null;

async function main(): Promise<void> {
  if (!process.env.OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY is not set — the vision parser cannot run here.");
    process.exitCode = 2;
    return;
  }
  const receipts = await prisma.receipt.findMany({
    where: { category: "materials", status: "confirmed", lineItems: null, imageData: { not: null } },
    orderBy: { createdAt: "asc" },
    select: { id: true, vendor: true, amount: true, receivedAt: true, imageMime: true, imageData: true, jobId: true },
  });
  const targets = receipts.filter((r) => !ONLY || r.id === ONLY || r.id.endsWith(ONLY));
  console.log(`${targets.length} receipt(s) with a photo and no line items${ONLY ? ` matching "${ONLY}"` : ""}.`);
  let written = 0;
  for (const r of targets) {
    console.log(`\n${r.id.slice(-6)}  ${r.receivedAt.toISOString().slice(0, 10)}  ${r.vendor ?? "(no vendor)"}  typed $${r.amount.toFixed(2)}`);
    const parsed = await parseReceiptImage(Buffer.from(r.imageData!), r.imageMime ?? "image/jpeg");
    if (!parsed) { console.log("   parser returned nothing — leave for hand entry"); continue; }
    console.log(`   parsed vendor ${parsed.vendor ?? "?"} · total ${parsed.total != null ? `$${parsed.total.toFixed(2)}` : "?"} · ${parsed.lineItems.length} line(s)`);
    for (const li of parsed.lineItems) {
      console.log(`     ${String(li.qty ?? 1).padStart(6)} ${(li.unit ?? "").padEnd(5)} ${li.name}${li.unitCost != null ? `  @ $${Number(li.unitCost).toFixed(2)}` : ""}`);
    }
    if (parsed.total != null && Math.abs(parsed.total - r.amount) > Math.max(1, r.amount * 0.05)) {
      console.log(`   ⚠ parsed total $${parsed.total.toFixed(2)} differs from the typed $${r.amount.toFixed(2)} — the typed amount stays; check the lines`);
    }
    if (parsed.lineItems.length === 0) { console.log("   no lines read — leave for hand entry"); continue; }
    if (APPLY) {
      await prisma.receipt.update({ where: { id: r.id }, data: { lineItems: JSON.stringify(parsed.lineItems) } });
      written += 1;
      console.log("   WRITTEN lineItems");
    }
  }
  console.log(APPLY ? `\nWrote line items on ${written} receipt(s).` : "\nDry run — add --apply to write line items.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
