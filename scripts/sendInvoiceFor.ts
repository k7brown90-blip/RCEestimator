/**
 * Send the signed-invoice email for one estimate, by number — the backfill for
 * customers who signed before auto-send existed (Kyle, 2026-09-05, Robert
 * Tran). Same service the manual button and the sign doors use; the
 * invoice_sent event and system log are written by the service itself.
 *
 *   railway ssh "node dist/scripts/sendInvoiceFor.js --number 2026-1060 --apply"
 *
 * Without --apply it prints what would be sent and to whom, and sends nothing.
 */

import { PrismaClient } from "@prisma/client";
import { sendInvoiceEmail } from "../src/services/issuedEstimateSend";

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const i = process.argv.indexOf("--number");
  const number = i >= 0 ? process.argv[i + 1] : undefined;
  const apply = process.argv.includes("--apply");
  if (!number) {
    console.log("Usage: --number 2026-1060 [--apply]");
    return;
  }
  const est = await prisma.issuedEstimate.findFirst({
    where: { number },
    select: { id: true, customerName: true, customerEmail: true, signedAt: true },
  });
  if (!est) { console.log(`Estimate ${number} not found.`); return; }
  console.log(`${number} — ${est.customerName} · ${est.customerEmail ?? "NO EMAIL"} · signed ${est.signedAt ? "yes" : "NO"}`);
  if (!apply) { console.log("(dry run — --apply sends the signed invoice email)"); return; }
  const result = await sendInvoiceEmail(prisma, est.id, { sentBy: "kyle:backfill-cli" });
  console.log(result.ok ? `SENT to ${result.to}` : `REFUSED: ${result.reason}`);
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => void prisma.$disconnect());
