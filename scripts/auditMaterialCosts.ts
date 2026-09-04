/**
 * Audit: does every signed estimate's material cost reach a live job card?
 * (Kyle, 2026-09-03: "Do another check on all the material reporting and make
 * sure each one is making it into the financials reports.")
 *
 * Read-only. For every signed, non-void issued estimate it prints the frozen
 * taken-scope material cost, both linked visits (quoted-on and sign-created
 * job) with their status and typed actualMaterialCost, and the verdict: which
 * visit's card the P&L fallback lands on, and whether that card is one the
 * financials actually show.
 *
 *   railway ssh "node dist/scripts/auditMaterialCosts.js"
 */

import { PrismaClient } from "@prisma/client";
import { estimateMaterialCost } from "../src/services/jobCosting";

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const signed = await prisma.issuedEstimate.findMany({
    where: { signedAt: { not: null }, voidedAt: null, status: { not: "void" } },
    orderBy: { createdAt: "asc" },
    select: {
      number: true, customerName: true, visitId: true, jobVisitId: true,
      selectedOptions: true,
      lines: { select: { option: true, materialCost: true } },
    },
  });

  const visitIds = [
    ...new Set(signed.flatMap((e) => [e.visitId, e.jobVisitId]).filter((v): v is string => Boolean(v))),
  ];
  const visits = await prisma.visit.findMany({
    where: { id: { in: visitIds } },
    select: { id: true, status: true, purpose: true, actualMaterialCost: true, completedAt: true },
  });
  const byId = new Map(visits.map((v) => [v.id, v]));
  const show = (id: string | null) => {
    if (!id) return "—";
    const v = byId.get(id);
    if (!v) return `${id} (MISSING)`;
    return `${id.slice(-6)} ${v.status}${v.completedAt ? "/done" : ""} actualMat=${v.actualMaterialCost ?? "null"}`;
  };

  let flagged = 0;
  for (const est of signed) {
    const mat = estimateMaterialCost({
      selectedOptions: est.selectedOptions.map(String),
      lines: est.lines.map((l) => ({ option: String(l.option), materialCost: l.materialCost })),
    });
    // The key GET /jobs and the summary use for the fallback.
    const cardKey = est.jobVisitId ?? est.visitId;
    const card = cardKey ? byId.get(cardKey) : null;
    const cardDead = !card || card.status === "cancelled";
    // Rule since the 2026-09-03 fix: a POSITIVE typed actual wins; zero/null
    // falls back to the estimate. The only remaining failure is a dead card.
    const problem = mat !== null && mat > 0 && cardDead;
    if (problem) flagged += 1;
    console.log(
      `${problem ? "⚠ " : "  "}${est.number}  ${est.customerName.padEnd(20)} estMaterial=${mat === null ? "null" : `$${mat.toFixed(2)}`}`,
    );
    console.log(`      quoted-on: ${show(est.visitId)}`);
    console.log(`      job:       ${show(est.jobVisitId)}`);
    if (problem) {
      console.log(
        "      → PROBLEM: material has no live card to land on (no linked job visit, or it was cancelled).",
      );
    }
  }
  console.log(`\n${signed.length} signed estimate(s); ${flagged} with material not reaching a live card.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
