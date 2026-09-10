/**
 * Job materials — the costing switch (Kyle, 2026-09-09, Build 4).
 *
 * "On future jobs I can label some stock as truckstock and it won't double
 * count the cost." Materials land on a truck or in the warehouse, never on a
 * job; "anything in a truck can be assigned to a job." A job is charged ONLY
 * when stock is consumed from a truck, at the truck's moving-average unit
 * cost, and each unit of stock is charged once. A return puts it back and
 * credits the job at the cost it was charged.
 *
 * This file is the writer of consume/return rows for jobs (through
 * applyMovement, the ledger's one writer) and the reader behind the "Materials
 * used" step at close-out: the suggested lines off the signed estimate, the
 * truck's on-hand beside each, what has been consumed so far, and the receipts
 * on the job with the ones riding a PO flagged "inventory, not job cost".
 * Costing itself lives in services/jobCosting.ts (materialCostForJobs).
 */

import type { StockMovement } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { InventoryError, adhocItemId, applyMovement, serializeMovement, truckLocationKey } from "./inventory";
import { defaultTruckId } from "./purchaseOrders";
import { estimateMaterialCost, materialCostForJobs, type MaterialCostResult } from "./jobCosting";

const round2 = (n: number) => Math.round(n * 100) / 100;
const r4 = (n: number) => Math.round(n * 10000) / 10000;

export interface ConsumeLineInput {
  itemId: string;
  name?: string | null;
  qty: number;
  unit?: string | null;
}

// ─── On-hand ─────────────────────────────────────────────────────────────────

export interface OnHand { qty: number; unit: string | null; avgUnitCost: number | null }

/** The truck's on-hand for a set of items — every requested id answers, 0 when the truck has none. */
export async function onHandFor(truckId: string, itemIds: string[]): Promise<Record<string, OnHand>> {
  const ids = [...new Set(itemIds.map((i) => i.trim()).filter(Boolean))];
  const out: Record<string, OnHand> = {};
  if (ids.length === 0) return out;
  const [levels, book] = await Promise.all([
    prisma.stockLevel.findMany({ where: { locationKey: truckLocationKey(truckId), itemId: { in: ids } } }),
    prisma.priceBookAtomic.findMany({ where: { itemId: { in: ids } }, select: { itemId: true, unit: true, unitLabel: true } }),
  ]);
  const bookById = new Map(book.map((b) => [b.itemId, b]));
  for (const id of ids) out[id] = { qty: 0, unit: bookById.get(id)?.unitLabel ?? bookById.get(id)?.unit ?? null, avgUnitCost: null };
  for (const l of levels) out[l.itemId] = { qty: l.qtyOnHand, unit: l.unit ?? out[l.itemId]?.unit ?? null, avgUnitCost: l.avgUnitCost };
  return out;
}

// ─── Suggested lines from the signed estimate ────────────────────────────────

export interface SuggestedLine {
  itemId: string;
  name: string;
  qty: number;
  unit: string | null;
  /** On the truck right now. */
  onHand: number;
  avgUnitCost: number | null;
  /** Already consumed for this job (so a second close-out pass does not double up). */
  consumedQty: number;
}

/** The signed estimate behind a job (either side of the chain), newest first. */
async function signedEstimateForJob(jobId: string) {
  return prisma.issuedEstimate.findFirst({
    where: { signedAt: { not: null }, voidedAt: null, status: { not: "void" }, OR: [{ jobVisitId: jobId }, { visitId: jobId }] },
    orderBy: { createdAt: "desc" },
    select: {
      id: true, number: true, title: true, visitId: true, jobVisitId: true, selectedOptions: true,
      lines: {
        orderBy: { sortOrder: "asc" },
        select: { itemId: true, description: true, quantity: true, option: true, materialCost: true, materialSell: true, atomic: { select: { unit: true, unitLabel: true } } },
      },
    },
  });
}

type SignedEstimate = NonNullable<Awaited<ReturnType<typeof signedEstimateForJob>>>;

/** The TAKEN lines that carry material — what the tech is expected to have pulled off the truck. */
function materialLinesOf(est: SignedEstimate) {
  const taken = new Set(est.selectedOptions.map(String));
  const lines = taken.size > 0 ? est.lines.filter((l) => taken.has(String(l.option))) : est.lines;
  return lines.filter((l) => (l.materialCost ?? 0) > 0 || (l.materialSell ?? 0) > 0);
}

/** The other visit on the job's chain (quoted-on ↔ sold job), when there is one. */
function chainOf(jobId: string, est: SignedEstimate | null): string[] {
  if (!est) return [];
  return [est.visitId, est.jobVisitId].filter((v): v is string => Boolean(v) && v !== jobId);
}

/**
 * Suggested consume lines: the signed estimate's taken material lines, grouped
 * by item (an estimate may carry the same atomic twice), with the truck's
 * on-hand beside each. The tech edits the quantities and confirms.
 */
export async function suggestedLinesForJob(jobId: string, truckId: string): Promise<{ estimate: { id: string; number: string; title: string } | null; lines: SuggestedLine[] }> {
  const est = await signedEstimateForJob(jobId);
  if (!est) return { estimate: null, lines: [] };
  const grouped = new Map<string, { name: string; qty: number; unit: string | null }>();
  for (const l of materialLinesOf(est)) {
    const row = grouped.get(l.itemId) ?? { name: l.description, qty: 0, unit: l.atomic.unitLabel ?? l.atomic.unit ?? null };
    row.qty = r4(row.qty + l.quantity);
    grouped.set(l.itemId, row);
  }
  const ids = [...grouped.keys()];
  const [onHand, consumed] = await Promise.all([
    onHandFor(truckId, ids),
    prisma.stockMovement.findMany({
      where: { jobId: { in: [jobId, ...chainOf(jobId, est)] }, kind: { in: ["consume", "return"] }, itemId: { in: ids } },
      select: { itemId: true, kind: true, qty: true },
    }),
  ]);
  const consumedById = new Map<string, number>();
  for (const m of consumed) consumedById.set(m.itemId, r4((consumedById.get(m.itemId) ?? 0) + (m.kind === "consume" ? m.qty : -m.qty)));
  return {
    estimate: { id: est.id, number: est.number, title: est.title },
    lines: ids.map((itemId) => {
      const g = grouped.get(itemId)!;
      const oh = onHand[itemId];
      return { itemId, name: g.name, qty: g.qty, unit: oh?.unit ?? g.unit, onHand: oh?.qty ?? 0, avgUnitCost: oh?.avgUnitCost ?? null, consumedQty: consumedById.get(itemId) ?? 0 };
    }),
  };
}

/**
 * The close-out warning (never a block — Kyle: "We do not want to lock
 * ourselves out of closing a job"): a signed estimate with material lines and
 * no consume recorded means the job's material will fall back to receipts or
 * the estimate's frozen figure.
 */
export async function closeOutMaterialWarning(jobId: string): Promise<string | null> {
  const est = await signedEstimateForJob(jobId);
  if (!est || materialLinesOf(est).length === 0) return null;
  const consumed = await prisma.stockMovement.count({ where: { jobId: { in: [jobId, ...chainOf(jobId, est)] }, kind: "consume" } });
  if (consumed > 0) return null;
  return "No materials recorded from truck stock — job material will fall back to receipts/estimate.";
}

// ─── Consume / return ────────────────────────────────────────────────────────

async function resolveTruck(truckId: string | null | undefined): Promise<{ id: string; name: string }> {
  const id = truckId?.trim() || (await defaultTruckId());
  const truck = await prisma.truck.findUnique({ where: { id }, select: { id: true, name: true } });
  if (!truck) throw new InventoryError(`Truck ${id} not found`, 404);
  return truck;
}

function validateLines(lines: ConsumeLineInput[]): void {
  if (!Array.isArray(lines) || lines.length === 0) throw new InventoryError("Nothing to record — add at least one line.", 400);
  for (const l of lines) {
    if (!l.itemId?.trim() && !l.name?.trim()) throw new InventoryError("Each line needs an itemId or a name.", 400);
    if (!Number.isFinite(l.qty) || l.qty <= 0) throw new InventoryError(`Quantity for ${l.name ?? l.itemId} must be positive.`, 400);
  }
}

/** Name + unit for an item: the caller's words, else the truck's level, else the book. */
async function describe(itemId: string, name?: string | null, unit?: string | null): Promise<{ name: string; unit: string | null }> {
  if (name?.trim()) return { name: name.trim(), unit: unit?.trim() || null };
  const level = await prisma.stockLevel.findFirst({ where: { itemId }, select: { name: true, unit: true } });
  if (level) return { name: level.name, unit: unit?.trim() || level.unit };
  const book = await prisma.priceBookAtomic.findUnique({ where: { itemId }, select: { description: true, unit: true, unitLabel: true } });
  if (book) return { name: book.description ?? itemId, unit: unit?.trim() || book.unitLabel || book.unit || null };
  return { name: itemId, unit: unit?.trim() || null };
}

export interface ConsumeInput {
  jobId: string;
  truckId?: string | null;
  lines: ConsumeLineInput[];
  reason?: string | null;
  actor: string;
  /**
   * Kyle's manual override from the CRM ONLY — lets a truck go negative when
   * the count is known to be behind. Recorded: the reason rides every movement.
   */
  allowNegative?: boolean;
}

/**
 * One consume movement per line, truck → job, at the truck's moving average.
 * 409 when the truck is short (the message names the item and its on-hand)
 * unless allowNegative, which needs a reason.
 */
export async function consumeForJob(input: ConsumeInput): Promise<StockMovement[]> {
  validateLines(input.lines);
  if (input.allowNegative && !input.reason?.trim()) throw new InventoryError("Going negative on a truck needs a reason.", 400);
  const job = await prisma.visit.findUnique({ where: { id: input.jobId }, select: { id: true } });
  if (!job) throw new InventoryError("Job not found", 404);
  const truck = await resolveTruck(input.truckId);
  const from = truckLocationKey(truck.id);
  const described = await Promise.all(input.lines.map(async (l) => {
    const itemId = l.itemId?.trim() || adhocItemId(l.name ?? "");
    return { itemId, qty: l.qty, ...(await describe(itemId, l.name, l.unit)) };
  }));
  return prisma.$transaction(async (tx) => {
    const out: StockMovement[] = [];
    for (const line of described) {
      out.push(await applyMovement(tx, {
        kind: "consume", itemId: line.itemId, name: line.name, unit: line.unit, qty: line.qty,
        fromLocationKey: from, jobId: input.jobId, reason: input.reason ?? null, actor: input.actor,
        allowNegative: Boolean(input.allowNegative),
      }));
    }
    return out;
  });
}

export interface ReturnInput {
  jobId: string;
  truckId?: string | null;
  lines: ConsumeLineInput[];
  reason?: string | null;
  actor: string;
}

/**
 * Job → truck. The credit is at the cost the job was CHARGED for that item
 * (the weighted average of its consumes), so a unit taken and put back nets to
 * zero on the job even if the truck's average moved in between; an item the job
 * never consumed returns at the truck's average.
 */
export async function returnForJob(input: ReturnInput): Promise<StockMovement[]> {
  validateLines(input.lines);
  const job = await prisma.visit.findUnique({ where: { id: input.jobId }, select: { id: true } });
  if (!job) throw new InventoryError("Job not found", 404);
  const truck = await resolveTruck(input.truckId);
  const to = truckLocationKey(truck.id);
  const described = await Promise.all(input.lines.map(async (l) => {
    const itemId = l.itemId?.trim() || adhocItemId(l.name ?? "");
    return { itemId, qty: l.qty, ...(await describe(itemId, l.name, l.unit)) };
  }));
  const consumes = await prisma.stockMovement.findMany({
    where: { jobId: input.jobId, kind: "consume", itemId: { in: described.map((d) => d.itemId) } },
    select: { itemId: true, qty: true, unitCost: true },
  });
  const chargedAvg = new Map<string, number>();
  for (const itemId of new Set(consumes.map((c) => c.itemId))) {
    const mine = consumes.filter((c) => c.itemId === itemId);
    const qty = mine.reduce((s, c) => s + c.qty, 0);
    if (qty > 0) chargedAvg.set(itemId, mine.reduce((s, c) => s + c.qty * (c.unitCost ?? 0), 0) / qty);
  }
  return prisma.$transaction(async (tx) => {
    const out: StockMovement[] = [];
    for (const line of described) {
      out.push(await applyMovement(tx, {
        kind: "return", itemId: line.itemId, name: line.name, unit: line.unit, qty: line.qty,
        unitCost: chargedAvg.get(line.itemId) ?? null,
        toLocationKey: to, jobId: input.jobId, reason: input.reason ?? null, actor: input.actor,
      }));
    }
    return out;
  });
}

// ─── The read behind the close-out step and the CRM panel ───────────────────

export interface JobMaterialLine {
  movementId: string;
  kind: string;
  itemId: string;
  name: string;
  unit: string | null;
  qty: number;
  unitCost: number | null;
  /** Signed: a consume charges, a return credits. */
  cost: number;
  reason: string | null;
  actor: string;
  at: Date;
  /** Set when the row lives on the chain's other visit (the appointment the job was quoted on). */
  onVisitId: string | null;
}

export interface JobMaterialsView {
  jobId: string;
  truck: { id: string; name: string };
  estimate: { id: string; number: string; title: string } | null;
  suggested: SuggestedLine[];
  lines: JobMaterialLine[];
  stock: MaterialCostResult["stock"];
  receipts: Array<{
    id: string; vendor: string | null; amount: number; category: string; status: string; receivedAt: Date;
    purchaseOrderId: string | null; purchaseOrderNumber: string | null;
    /** Confirmed materials receipt with no PO — the receipt rung counts it. */
    countsTowardJob: boolean;
    /** Why it does not count, when it does not. */
    note: string | null;
  }>;
  materialCost: number;
  materialSource: MaterialCostResult["materialSource"];
  /** The signed estimate's frozen taken-scope material — the estimate rung. */
  estimateMaterial: number | null;
  /** Visit.actualMaterialCost — the receipt rung. */
  receiptMaterial: number | null;
}

export async function jobMaterials(jobId: string, truckId?: string | null): Promise<JobMaterialsView> {
  const visit = await prisma.visit.findUnique({ where: { id: jobId }, select: { id: true, actualMaterialCost: true } });
  if (!visit) throw new InventoryError("Job not found", 404);
  const truck = await resolveTruck(truckId);
  const est = await signedEstimateForJob(jobId);
  const chain = chainOf(jobId, est);
  const [suggested, movements, receipts, costs] = await Promise.all([
    suggestedLinesForJob(jobId, truck.id),
    prisma.stockMovement.findMany({
      where: { jobId: { in: [jobId, ...chain] }, kind: { in: ["consume", "return", "correction"] } },
      orderBy: [{ at: "asc" }, { createdAt: "asc" }],
    }),
    prisma.receipt.findMany({
      where: { jobId: { in: [jobId, ...chain] } },
      orderBy: { receivedAt: "desc" },
      select: { id: true, vendor: true, amount: true, category: true, status: true, receivedAt: true, purchaseOrderId: true, purchaseOrder: { select: { number: true } } },
    }),
    materialCostForJobs([{
      visitId: jobId, chainVisitIds: chain, actualMaterialCost: visit.actualMaterialCost,
      estimatedMaterialCost: est ? estimateMaterialCost({ selectedOptions: est.selectedOptions.map(String), lines: est.lines.map((l) => ({ option: String(l.option), materialCost: l.materialCost })) }) : null,
    }]),
  ]);
  const cost = costs.get(jobId)!;
  const byId = new Map(movements.map((m) => [m.id, m]));
  const lines: JobMaterialLine[] = movements.flatMap((m) => {
    let signed: number;
    if (m.kind === "consume") signed = m.qty * (m.unitCost ?? 0);
    else if (m.kind === "return") signed = -(m.qty * (m.unitCost ?? 0));
    else {
      const original = m.correctsId ? byId.get(m.correctsId) : undefined;
      if (!original || (original.kind !== "consume" && original.kind !== "return")) return [];
      signed = (m.delta ?? 0) * (m.unitCost ?? original.unitCost ?? 0) * (original.kind === "consume" ? 1 : -1);
    }
    const v = serializeMovement(m);
    return [{
      movementId: v.id, kind: v.kind, itemId: v.itemId, name: v.name, unit: v.unit, qty: m.kind === "correction" ? (m.delta ?? 0) : v.qty,
      unitCost: v.unitCost, cost: round2(signed), reason: v.reason, actor: v.actor, at: v.at, onVisitId: m.jobId && m.jobId !== jobId ? m.jobId : null,
    }];
  });
  return {
    jobId,
    truck,
    estimate: suggested.estimate,
    suggested: suggested.lines,
    lines,
    stock: cost.stock,
    receipts: receipts.map((r) => {
      const materials = r.category === "materials";
      const onPo = Boolean(r.purchaseOrderId);
      const confirmed = r.status === "confirmed";
      const counts = materials && confirmed && !onPo;
      return {
        id: r.id, vendor: r.vendor, amount: r.amount, category: r.category, status: r.status, receivedAt: r.receivedAt,
        purchaseOrderId: r.purchaseOrderId, purchaseOrderNumber: r.purchaseOrder?.number ?? null,
        countsTowardJob: counts,
        note: counts ? null
          : onPo && materials ? `On ${r.purchaseOrder?.number ?? "a PO"} — inventory, not job cost (the job pays when stock is consumed)`
          : !materials ? `${r.category} — not material`
          : "needs review — not counted yet",
      };
    }),
    materialCost: cost.materialCost,
    materialSource: cost.materialSource,
    estimateMaterial: est ? estimateMaterialCost({ selectedOptions: est.selectedOptions.map(String), lines: est.lines.map((l) => ({ option: String(l.option), materialCost: l.materialCost })) }) : null,
    receiptMaterial: visit.actualMaterialCost,
  };
}
