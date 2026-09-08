/**
 * Audit: does every signed estimate's material cost reach a live job card?
 * (Kyle, 2026-09-03: "Do another check on all the material reporting and make
 * sure each one is making it into the financials reports.")
 *
 * Read-only by default. For every signed, non-void issued estimate it prints
 * the frozen taken-scope material cost, both linked visits (quoted-on and
 * sign-created job) with their status and typed actualMaterialCost, every
 * receipt on those visits (source / status / amount / vendor / date), and the
 * verdict: which visit's card the P&L fallback lands on, and whether the
 * stamped actualMaterialCost agrees with the confirmed material receipts.
 *
 *   railway ssh "node dist/scripts/auditMaterialCosts.js"
 *   railway ssh "node dist/scripts/auditMaterialCosts.js --reroll"          # preview re-stamps
 *   railway ssh "node dist/scripts/auditMaterialCosts.js --reroll --apply"  # write them
 *
 * --reroll recomputes actualMaterialCost from confirmed material receipts on
 * every visit named by a signed estimate (Kyle, 2026-09-08: Daughdrill's
 * office-uploaded receipts landed confirmed but the job was never re-rolled).
 */

import { PrismaClient } from "@prisma/client";
import { estimateMaterialCost } from "../src/services/jobCosting";

const prisma = new PrismaClient();
const argv = process.argv.slice(2);
const REROLL = argv.includes("--reroll");
const APPLY = argv.includes("--apply");

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
  const [visits, receipts] = await Promise.all([
    prisma.visit.findMany({
      where: { id: { in: visitIds } },
      select: { id: true, status: true, purpose: true, actualMaterialCost: true, completedAt: true },
    }),
    prisma.receipt.findMany({
      where: { jobId: { in: visitIds } },
      orderBy: { createdAt: "asc" },
      select: { id: true, jobId: true, source: true, status: true, category: true, amount: true, vendor: true, receivedAt: true, createdAt: true },
    }),
  ]);
  const byId = new Map(visits.map((v) => [v.id, v]));
  const receiptsByVisit = new Map<string, typeof receipts>();
  for (const r of receipts) {
    if (!r.jobId) continue;
    receiptsByVisit.set(r.jobId, [...(receiptsByVisit.get(r.jobId) ?? []), r]);
  }
  const confirmedMaterial = (visitId: string): number =>
    Math.round(
      (receiptsByVisit.get(visitId) ?? [])
        .filter((r) => r.category === "materials" && r.status === "confirmed")
        .reduce((s, r) => s + r.amount, 0) * 100,
    ) / 100;

  const show = (id: string | null) => {
    if (!id) return "—";
    const v = byId.get(id);
    if (!v) return `${id} (MISSING)`;
    return `${id.slice(-6)} ${v.status}${v.completedAt ? "/done" : ""} actualMat=${v.actualMaterialCost ?? "null"} confirmedReceipts=$${confirmedMaterial(id).toFixed(2)}`;
  };
  const showReceipts = (id: string | null) => {
    if (!id) return;
    for (const r of receiptsByVisit.get(id) ?? []) {
      const when = (r.receivedAt ?? r.createdAt).toISOString().slice(0, 10);
      console.log(
        `         receipt ${r.id.slice(-6)} ${when} ${r.source.padEnd(8)} ${r.status.padEnd(14)} ${r.category.padEnd(11)} $${r.amount.toFixed(2).padStart(9)}  ${r.vendor ?? "(no vendor)"}`,
      );
    }
  };

  let flagged = 0;
  let stale = 0;
  const rerolls: Array<{ id: string; from: number | null; to: number }> = [];
  for (const est of signed) {
    const mat = estimateMaterialCost({
      selectedOptions: est.selectedOptions.map(String),
      lines: est.lines.map((l) => ({ option: String(l.option), materialCost: l.materialCost })),
    });
    // The key GET /jobs and the summary use for the fallback.
    const cardKey = est.jobVisitId ?? est.visitId;
    const card = cardKey ? byId.get(cardKey) : null;
    const cardDead = !card || card.status === "cancelled";
    const problem = mat !== null && mat > 0 && cardDead;
    if (problem) flagged += 1;
    console.log(
      `${problem ? "⚠ " : "  "}${est.number}  ${est.customerName.padEnd(20)} estMaterial=${mat === null ? "null" : `$${mat.toFixed(2)}`}`,
    );
    console.log(`      quoted-on: ${show(est.visitId)}`);
    showReceipts(est.visitId);
    console.log(`      job:       ${show(est.jobVisitId)}`);
    showReceipts(est.jobVisitId);
    if (problem) {
      console.log(
        "      → PROBLEM: material has no live card to land on (no linked job visit, or it was cancelled).",
      );
    }
    for (const id of [est.visitId, est.jobVisitId]) {
      if (!id) continue;
      const v = byId.get(id);
      if (!v) continue;
      const expected = confirmedMaterial(id);
      const stamped = v.actualMaterialCost ?? 0;
      if (Math.abs(expected - stamped) > 0.005) {
        stale += 1;
        console.log(`      → STALE: ${id.slice(-6)} actualMat=${stamped} but confirmed material receipts total $${expected.toFixed(2)}`);
        if (REROLL && !rerolls.some((r) => r.id === id)) rerolls.push({ id, from: v.actualMaterialCost, to: expected });
      }
    }
  }
  console.log(`\n${signed.length} signed estimate(s); ${flagged} with material not reaching a live card; ${stale} visit(s) with a stale actualMaterialCost.`);

  if (REROLL) {
    if (rerolls.length === 0) {
      console.log("Nothing to re-roll.");
    } else {
      for (const r of rerolls) {
        console.log(`${APPLY ? "RE-ROLLED" : "would re-roll"} ${r.id.slice(-6)}: ${r.from ?? "null"} → ${r.to.toFixed(2)}`);
        if (APPLY) await prisma.visit.update({ where: { id: r.id }, data: { actualMaterialCost: r.to } });
      }
      if (!APPLY) console.log("Dry run — add --apply to write.");
    }
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
