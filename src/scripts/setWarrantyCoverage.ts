/**
 * Record warranty coverage on an unsigned issued estimate from the shell — the
 * same write PATCH /issued-estimates/:id/warranty makes, for the night Kyle went
 * to bed with the RELY authorization in hand (2026-09-09: claim 343467219,
 * auth45978673, $370 on 2026-1065) and asked for it to be ready in the morning.
 *
 *   railway ssh "node dist/src/scripts/setWarrantyCoverage.js --number 2026-1065 --claim 343467219 --auth auth45978673 --amount 370 [--company 'RELY Home'] [--note '...'] [--apply]"
 *
 * Dry run unless --apply. Refuses a signed or void estimate and a covered amount
 * above what the estimate bills, exactly like the route.
 */

import { PrismaClient } from "@prisma/client";
import { billedTotalOf, parseWarrantyJson } from "../services/stripePayments";

const prisma = new PrismaClient();
const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const APPLY = argv.includes("--apply");

async function main(): Promise<void> {
  const number = arg("--number");
  const claimNumber = arg("--claim");
  const amount = Number(arg("--amount"));
  const company = arg("--company") ?? "RELY Home";
  const authNumber = arg("--auth") ?? null;
  const note = arg("--note") ?? null;
  if (!number || !claimNumber || !Number.isFinite(amount) || amount <= 0) {
    console.error("usage: --number 2026-1065 --claim <claim> --amount <dollars> [--auth <auth>] [--company <name>] [--note <text>] [--apply]");
    process.exitCode = 2;
    return;
  }

  // Latest revision of that number, the one the customer will sign.
  const est = await prisma.issuedEstimate.findFirst({
    where: { number },
    orderBy: { revision: "desc" },
    include: { options: { select: { option: true, subtotal: true } } },
  });
  if (!est) { console.error(`Estimate ${number} not found`); process.exitCode = 1; return; }
  console.log(`${est.number} rev ${est.revision} · ${est.customerName} · status ${est.status} · signed ${est.signedAt ? est.signedAt.toISOString() : "no"} · total $${est.total.toFixed(2)}`);
  const existing = parseWarrantyJson(est.warrantyJson);
  if (existing) console.log(`  currently: ${existing.company} claim ${existing.claimNumber} auth ${existing.authNumber ?? "-"} $${existing.coveredAmount.toFixed(2)}`);
  if (est.status === "void" || est.voidedAt) { console.error("Refusing: estimate is void."); process.exitCode = 1; return; }
  if (est.signedAt) { console.error("Refusing: estimate is signed — revise it to change coverage."); process.exitCode = 1; return; }

  const money = {
    total: est.total,
    tripCharge: est.tripCharge,
    selectedOptions: est.selectedOptions as string[],
    comboCapJson: est.comboCapJson,
    discountJson: est.discountJson,
    warrantyJson: null,
    optionsSubtotals: est.options.map((o) => ({ option: o.option, subtotal: o.subtotal })),
  };
  const preCoverage = billedTotalOf(money);
  const coveredAmount = Math.round(amount * 100) / 100;
  if (coveredAmount > preCoverage + 0.005) {
    console.error(`Refusing: $${coveredAmount.toFixed(2)} is more than the estimate bills ($${preCoverage.toFixed(2)}).`);
    process.exitCode = 1;
    return;
  }
  const claim = { company, claimNumber, authNumber, coveredAmount, note, setAt: new Date().toISOString() };
  const warrantyJson = JSON.stringify(claim);
  const homeowner = billedTotalOf({ ...money, warrantyJson });
  const detail =
    `Warranty coverage set — ${company} claim ${claimNumber}${authNumber ? ` auth ${authNumber}` : ""} ` +
    `covering $${coveredAmount.toFixed(2)} of $${preCoverage.toFixed(2)}; homeowner share $${homeowner.toFixed(2)}`;
  console.log(`  ${APPLY ? "WRITING" : "would write"}: ${detail}`);
  console.log(`  deposit (1/3 of homeowner share): $${(Math.round((homeowner / 3) * 100) / 100).toFixed(2)}`);
  if (!APPLY) { console.log("Dry run — add --apply to write."); return; }

  await prisma.$transaction(async (tx) => {
    await tx.issuedEstimate.update({ where: { id: est.id }, data: { warrantyJson } });
    await tx.issuedEstimateEvent.create({
      data: { estimateId: est.id, type: "warranty_set", actor: "script:setWarrantyCoverage", detail },
    });
    await tx.systemEvent.create({
      data: { level: "info", source: "issued-estimate", message: `Estimate ${est.number}: ${detail}`, detailsJson: JSON.stringify({ estimateId: est.id, via: "scripts/setWarrantyCoverage" }) },
    });
  });
  console.log("Written.");
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => void prisma.$disconnect());
