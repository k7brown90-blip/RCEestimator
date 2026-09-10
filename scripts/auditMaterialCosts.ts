/**
 * Audit: which rung of THE MATERIAL RULE each job's material comes from, and
 * whether anything is counted twice.
 *
 * Kyle, 2026-09-03: "Do another check on all the material reporting and make
 * sure each one is making it into the financials reports." Kyle, 2026-09-09
 * (Build 4, the costing switch): "on future jobs I can label some stock as
 * truckstock and it won't double count the cost."
 *
 * Read-only. For every signed, non-void issued estimate it prints the frozen
 * taken-scope material, both linked visits (quoted-on and sign-created job),
 * every receipt on those visits (with the PO it rides, if any), every consume /
 * return the ledger holds against them, and the RUNG the P&L charges:
 *
 *   stock     — consume − return off a truck at the moving average
 *   receipts  — Visit.actualMaterialCost: confirmed materials receipts NOT on a PO
 *   estimate  — the signed estimate's frozen taken-scope material
 *   none      — nothing recorded
 *
 * Flags:
 *   ⚠ PO-RECEIPT COUNTED  a receipt on a PO is still inside actualMaterialCost
 *                         (inventory value counted as job cost — the backfill
 *                         script fixes it: scripts/backfillMaterialRule.ts)
 *   ⚠ NEVER-LANDED        a consume took stock a truck never had (the truck was
 *                         short at that moment — an allowNegative override or a
 *                         landing that was skipped)
 *   ⚠ NO LIVE CARD        material with no live job visit to land on
 *
 *   railway ssh "node dist/scripts/auditMaterialCosts.js"
 */

import { PrismaClient } from "@prisma/client";
import { estimateMaterialCost, stockMaterialByJob, resolveMaterialCost } from "../src/services/jobCosting";

const prisma = new PrismaClient();

const money = (n: number | null | undefined) => (n == null ? "null" : `$${n.toFixed(2)}`);
const r2 = (n: number) => Math.round(n * 100) / 100;

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
  const [visits, receipts, stockByVisit, movements] = await Promise.all([
    prisma.visit.findMany({
      where: { id: { in: visitIds } },
      select: { id: true, status: true, purpose: true, actualMaterialCost: true, completedAt: true },
    }),
    prisma.receipt.findMany({
      where: { jobId: { in: visitIds } },
      orderBy: { createdAt: "asc" },
      select: {
        id: true, jobId: true, source: true, status: true, category: true, amount: true, vendor: true, receivedAt: true, createdAt: true,
        purchaseOrderId: true, purchaseOrder: { select: { number: true } },
      },
    }),
    stockMaterialByJob(visitIds),
    prisma.stockMovement.findMany({
      where: { jobId: { in: visitIds }, kind: { in: ["consume", "return", "correction"] } },
      orderBy: [{ at: "asc" }, { createdAt: "asc" }],
    }),
  ]);
  const byId = new Map(visits.map((v) => [v.id, v]));
  const receiptsByVisit = new Map<string, typeof receipts>();
  for (const r of receipts) {
    if (!r.jobId) continue;
    receiptsByVisit.set(r.jobId, [...(receiptsByVisit.get(r.jobId) ?? []), r]);
  }
  const movementsByVisit = new Map<string, typeof movements>();
  for (const m of movements) {
    if (!m.jobId) continue;
    movementsByVisit.set(m.jobId, [...(movementsByVisit.get(m.jobId) ?? []), m]);
  }
  const confirmedNoPo = (visitId: string): number =>
    r2((receiptsByVisit.get(visitId) ?? [])
      .filter((r) => r.category === "materials" && r.status === "confirmed" && !r.purchaseOrderId)
      .reduce((s, r) => s + r.amount, 0));
  const confirmedOnPo = (visitId: string): number =>
    r2((receiptsByVisit.get(visitId) ?? [])
      .filter((r) => r.category === "materials" && r.status === "confirmed" && Boolean(r.purchaseOrderId))
      .reduce((s, r) => s + r.amount, 0));

  // Never-landed stock: replay the WHOLE ledger in order and note every consume
  // that took more than the truck held at that moment.
  const ledger = await prisma.stockMovement.findMany({
    orderBy: [{ at: "asc" }, { createdAt: "asc" }],
    select: { id: true, kind: true, itemId: true, name: true, qty: true, delta: true, fromLocationKey: true, toLocationKey: true, jobId: true, reason: true, actor: true, at: true },
  });
  const level = new Map<string, number>();
  const key = (loc: string, item: string) => `${loc}|${item}`;
  const neverLanded = new Map<string, Array<{ id: string; name: string; qty: number; had: number; at: Date; reason: string | null; actor: string }>>();
  for (const m of ledger) {
    const add = (loc: string | null, q: number) => { if (loc) level.set(key(loc, m.itemId), (level.get(key(loc, m.itemId)) ?? 0) + q); };
    switch (m.kind) {
      case "purchase_in": add(m.toLocationKey, m.qty); break;
      case "transfer": add(m.fromLocationKey, -m.qty); add(m.toLocationKey, m.qty); break;
      case "return": add(m.toLocationKey, m.qty); break;
      case "count": if (m.toLocationKey) level.set(key(m.toLocationKey, m.itemId), m.qty); break;
      case "correction": add(m.toLocationKey, m.delta ?? 0); add(m.fromLocationKey, -(m.delta ?? 0)); break;
      case "consume": {
        const had = m.fromLocationKey ? level.get(key(m.fromLocationKey, m.itemId)) ?? 0 : 0;
        if (had + 1e-9 < m.qty && m.jobId) {
          neverLanded.set(m.jobId, [...(neverLanded.get(m.jobId) ?? []), { id: m.id, name: m.name, qty: m.qty, had, at: m.at, reason: m.reason, actor: m.actor }]);
        }
        add(m.fromLocationKey, -m.qty);
        break;
      }
    }
  }

  const show = (id: string | null) => {
    if (!id) return "—";
    const v = byId.get(id);
    if (!v) return `${id} (MISSING)`;
    return `${id.slice(-6)} ${v.status}${v.completedAt ? "/done" : ""} actualMat=${money(v.actualMaterialCost)} receipts(noPO)=${money(confirmedNoPo(id))} receipts(onPO)=${money(confirmedOnPo(id))} stock=${money(stockByVisit.get(id)?.net ?? null)}`;
  };
  const showReceipts = (id: string | null) => {
    if (!id) return;
    for (const r of receiptsByVisit.get(id) ?? []) {
      const when = (r.receivedAt ?? r.createdAt).toISOString().slice(0, 10);
      console.log(
        `         receipt ${r.id.slice(-6)} ${when} ${r.source.padEnd(8)} ${r.status.padEnd(14)} ${r.category.padEnd(11)} $${r.amount.toFixed(2).padStart(9)}  ${r.vendor ?? "(no vendor)"}${r.purchaseOrderId ? `  on ${r.purchaseOrder?.number ?? "PO"} → inventory, not job cost` : ""}`,
      );
    }
  };
  const showMovements = (id: string | null) => {
    if (!id) return;
    for (const m of movementsByVisit.get(id) ?? []) {
      const q = m.kind === "correction" ? `Δ${m.delta ?? 0}` : `${m.qty}`;
      console.log(
        `         ${m.kind.padEnd(10)} ${m.at.toISOString().slice(0, 10)} ${q.padStart(8)} ${m.unit ?? ""} ${m.name} @ ${money(m.unitCost)} = ${money(r2((m.kind === "correction" ? (m.delta ?? 0) : m.qty) * (m.unitCost ?? 0)))}  ${m.actor}${m.reason ? ` — ${m.reason}` : ""}`,
      );
    }
  };

  let noCard = 0;
  let poCounted = 0;
  let neverLandedCount = 0;
  const rungs: Record<string, number> = { stock: 0, receipts: 0, estimate: 0, none: 0 };
  for (const est of signed) {
    const mat = estimateMaterialCost({
      selectedOptions: est.selectedOptions.map(String),
      lines: est.lines.map((l) => ({ option: String(l.option), materialCost: l.materialCost })),
    });
    // The key GET /jobs and the summary use.
    const cardKey = est.jobVisitId ?? est.visitId;
    const card = cardKey ? byId.get(cardKey) : null;
    const cardDead = !card || card.status === "cancelled";
    const problem = mat !== null && mat > 0 && cardDead;
    if (problem) noCard += 1;

    // The rung, exactly as materialCostForJobs resolves it: the chain's movements roll onto the card.
    const chain = [est.jobVisitId, est.visitId].filter((v): v is string => Boolean(v));
    const stockParts = chain.map((id) => stockByVisit.get(id)).filter((s): s is NonNullable<typeof s> => Boolean(s));
    const stockNet = stockParts.length ? r2(stockParts.reduce((s, p) => s + p.net, 0)) : null;
    const resolved = resolveMaterialCost(stockNet, card?.actualMaterialCost ?? null, mat);
    rungs[resolved.materialSource] += 1;

    console.log(
      `${problem ? "⚠ " : "  "}${est.number}  ${est.customerName.padEnd(20)} estMaterial=${money(mat)}  → rung: ${resolved.materialSource.toUpperCase()} ${money(resolved.materialCost)}`,
    );
    console.log(`      quoted-on: ${show(est.visitId)}`);
    showReceipts(est.visitId);
    showMovements(est.visitId);
    console.log(`      job:       ${show(est.jobVisitId)}`);
    showReceipts(est.jobVisitId);
    showMovements(est.jobVisitId);
    if (problem) {
      console.log("      ⚠ NO LIVE CARD: material has no live job visit to land on (no linked job visit, or it was cancelled).");
    }
    for (const id of chain) {
      const v = byId.get(id);
      if (!v) continue;
      const expected = confirmedNoPo(id);
      const stamped = v.actualMaterialCost ?? 0;
      if (Math.abs(expected - stamped) > 0.005) {
        const onPo = confirmedOnPo(id);
        if (onPo > 0 && Math.abs(expected + onPo - stamped) <= 0.005) {
          poCounted += 1;
          console.log(`      ⚠ PO-RECEIPT COUNTED: ${id.slice(-6)} actualMat=${money(stamped)} includes ${money(onPo)} of receipts on a PO — should be ${money(expected)}. Run scripts/backfillMaterialRule.ts.`);
        } else {
          console.log(`      ⚠ STALE: ${id.slice(-6)} actualMat=${money(stamped)} but confirmed materials receipts with no PO total ${money(expected)}. Run scripts/backfillMaterialRule.ts.`);
        }
      }
      for (const n of neverLanded.get(id) ?? []) {
        neverLandedCount += 1;
        console.log(`      ⚠ NEVER-LANDED: consume ${n.id.slice(-6)} ${n.at.toISOString().slice(0, 10)} took ${n.qty} × ${n.name} when the truck held ${r2(n.had)} (${n.actor}${n.reason ? ` — ${n.reason}` : ", no reason"}).`);
      }
    }
  }
  console.log(
    `\n${signed.length} signed estimate(s): rung stock=${rungs.stock} receipts=${rungs.receipts} estimate=${rungs.estimate} none=${rungs.none}; ` +
    `${noCard} with no live card; ${poCounted} with a PO receipt still counted; ${neverLandedCount} consume(s) of never-landed stock.`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
