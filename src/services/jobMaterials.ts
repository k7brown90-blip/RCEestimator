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
 * This file writes the hand-recorded consume/return rows for jobs (through
 * applyMovement, the ledger's one writer; since 2026-09-15 landPurchaseOrder in
 * services/inventory.ts also writes a consume for every line of a job-tagged PO
 * as it lands) and is the reader behind the "Materials
 * used" step at close-out: the suggested lines off the signed estimate, the
 * truck's on-hand beside each, what has been consumed so far, and the receipts
 * on the job with the ones riding a PO flagged "inventory, not job cost".
 * Costing itself lives in services/jobCosting.ts (materialCostForJobs).
 */

import type { StockMovement } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { InventoryError, WAREHOUSE_KEY, adhocItemId, applyMovement, serializeMovement, truckLocationKey } from "./inventory";
import { defaultTruckId } from "./purchaseOrders";
import { estimateMaterialCost, materialCostForJobs, stockMaterialByJob, type MaterialCostResult, type StockMaterial } from "./jobCosting";
import { aggregateMaterialList, isAssemblyRowType, type ComponentInput, type MaterialListEntry, type MaterialListLine } from "./priceBookAssembly";

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

// ─── Shortages — what the job still needs, for one complete P.O. (Kyle, 2026-09-16 / Unit P) ──
//
// "This should not be line item specific... When the estimate is signed then on the job page and
// in the field app it will say create a p.o. and be able to add the items to the p.o. from
// there." A NEW computation, deliberately separate from suggestedLinesForJob above (which also
// feeds the consume/close-out screens and must keep its existing output byte-for-byte).

export interface ShortageLine {
  itemId: string;
  name: string;
  unit: string | null;
  /** The signed scope's quantity, assemblies expanded to their real components, summed across
   *  every signed estimate on the job (the original AND any change order — see below). */
  neededQty: number;
  consumedQty: number;
  /** On the ONE truck this view was built for — same basis as `SuggestedLine.onHand`. */
  onHand: number;
  /** This item's quantity on the job's open (not cancelled, not yet landed) purchase orders —
   *  so a second P.O. does not re-order material already on its way. */
  qtyOnOpenPOs: number;
  /** max(0, (neededQty - consumedQty) - onHand - qtyOnOpenPOs). Only positive shortages are
   *  returned — this list IS the pre-fill for "Create P.O.". */
  shortBy: number;
}

/** Open = ordered but not yet landed. Landing closes a PO (purchaseOrders.ts,
 *  closePurchaseOrderForLanding), and its material is by then already counted in onHand /
 *  consumedQty, so "closed" is deliberately excluded here alongside "cancelled". */
const OPEN_PO_STATUSES = ["open", "purchased", "verified"] as const;

/**
 * Every signed, non-void, non-superseded estimate on this job's chain.
 *
 * Unlike `signedEstimateForJob` above (newest only — correct for "what should the tech have
 * pulled off the truck right now"), a signed CHANGE ORDER is a separate `IssuedEstimate` row from
 * the original: `POST /issued-estimates/:id/change-order` (app.ts) seeds the new draft's
 * `visitId` with the original's `jobVisitId ?? visitId` (the job), but the new estimate's own
 * `jobVisitId` starts null — `createJobFromSignedEstimate` (accountSpine.ts) checks exactly that
 * column and, finding it empty, creates its OWN new Visit when the change order is signed. So a
 * change order's signed estimate is linked to this job only through `visitId`, while the
 * original's is linked through `jobVisitId` — both satisfy the `OR` below, but `findFirst`
 * (signedEstimateForJob) returns only the newer of the two, silently dropping the other's
 * material. For the job's total material NEED, both must count. `supersededBy: null` drops a
 * stale revision of an estimate that has since been re-issued (issuedEstimateService.ts
 * reviseEstimate — a signed estimate CAN be revised; the old row keeps its signature but is no
 * longer the live scope), matching the filter `GET /jobs` open-invoice reader already uses
 * (app.ts:4914).
 */
async function allSignedEstimatesForJob(jobId: string) {
  return prisma.issuedEstimate.findMany({
    where: { signedAt: { not: null }, voidedAt: null, status: { not: "void" }, supersededBy: null, OR: [{ jobVisitId: jobId }, { visitId: jobId }] },
    orderBy: { createdAt: "asc" },
    select: {
      id: true, number: true, title: true, visitId: true, jobVisitId: true, selectedOptions: true,
      lines: {
        orderBy: { sortOrder: "asc" },
        select: { itemId: true, description: true, quantity: true, option: true, materialCost: true, materialSell: true, atomic: { select: { unit: true, unitLabel: true } } },
      },
    },
  });
}

/**
 * The job's material NEED, before stock/consumed/on-order are subtracted: the TAKEN lines of
 * every signed, non-void, non-superseded estimate on the job (original and change orders),
 * assemblies expanded to their real components. Shared by `shortagesForJob` (which subtracts
 * stock to find what's still short) and `materialNeedListForJob` (Unit L, 2026-09-17 — the
 * materials-list PDF, which shows the need list as-is). Compute this ONCE; do not re-derive it.
 */
async function materialNeedForJob(jobId: string): Promise<{
  ests: Awaited<ReturnType<typeof allSignedEstimatesForJob>>;
  expanded: MaterialListEntry[];
  grouped: Map<string, { name: string; qty: number; unit: string | null }>;
  bookById: Map<string, { itemId: string; description: string | null; unit: string | null; unitLabel: string | null }>;
} | null> {
  const ests = await allSignedEstimatesForJob(jobId);
  if (ests.length === 0) return null;

  // Every taken material line across every estimate on the job, grouped by item — a change
  // order's added lines and the original's both count.
  const grouped = new Map<string, { name: string; qty: number; unit: string | null }>();
  for (const est of ests) {
    for (const l of materialLinesOf(est)) {
      const row = grouped.get(l.itemId) ?? { name: l.description, qty: 0, unit: l.atomic.unitLabel ?? l.atomic.unit ?? null };
      row.qty = r4(row.qty + l.quantity);
      grouped.set(l.itemId, row);
    }
  }
  if (grouped.size === 0) return { ests, expanded: [], grouped, bookById: new Map() };

  // Expand assemblies to their real components. `suggestedLinesForJob` groups an assembly line
  // under the assembly's own itemId, which is never stocked (assertNotAssembly) — it would read
  // fully short forever and its real components would never appear. An assembly must NEVER reach
  // a PO line.
  const lineIds = [...grouped.keys()];
  const lineAtomics = await prisma.priceBookAtomic.findMany({ where: { itemId: { in: lineIds } }, select: { itemId: true, rowType: true } });
  const assemblyIds = new Set(lineAtomics.filter((a) => isAssemblyRowType(a.rowType)).map((a) => a.itemId));
  const componentsByParent = new Map<string, ComponentInput[]>();
  if (assemblyIds.size > 0) {
    const componentRows = await prisma.priceBookItemComponent.findMany({
      where: { parentItemId: { in: [...assemblyIds] } },
      select: { parentItemId: true, childItemId: true, quantity: true },
    });
    for (const r of componentRows) {
      const list = componentsByParent.get(r.parentItemId) ?? [];
      list.push({ childItemId: r.childItemId, quantity: r.quantity });
      componentsByParent.set(r.parentItemId, list);
    }
  }
  const materialListLines: MaterialListLine[] = lineIds.map((itemId) => ({ itemId, quantity: grouped.get(itemId)!.qty }));
  const expanded = aggregateMaterialList(materialListLines, componentsByParent)
    // Defensive, not expected to fire: the CRM refuses to save an assembly with an empty
    // component list (constants.md), which is the only way aggregateMaterialList's "no
    // components" branch would otherwise pass an assembly's own itemId straight through.
    .filter((e) => !assemblyIds.has(e.itemId));
  if (expanded.length === 0) return { ests, expanded: [], grouped, bookById: new Map() };

  const realIds = expanded.map((e) => e.itemId);
  const bookRows = await prisma.priceBookAtomic.findMany({
    where: { itemId: { in: realIds } },
    select: { itemId: true, description: true, unit: true, unitLabel: true },
  });
  const bookById = new Map(bookRows.map((b) => [b.itemId, b]));

  return { ests, expanded, grouped, bookById };
}

export interface MaterialNeedLine {
  itemId: string;
  name: string;
  unit: string | null;
  qty: number;
}

export interface MaterialNeedList {
  estimates: { id: string; number: string; title: string }[];
  lines: MaterialNeedLine[];
}

/**
 * The job's full material need for the materials-list PDF (Kyle, 2026-09-17, Unit L): "should show
 * the materials from the line items used to quote the job." The TAKEN lines of every signed
 * estimate on the job, assemblies expanded to their component materials — item, description,
 * quantity, unit. Deliberately NO cost fields; this is a shopping/reference list, not a priced
 * document. Built on `materialNeedForJob`, the same pre-stock computation `shortagesForJob` uses —
 * not a second computation.
 */
export async function materialNeedListForJob(jobId: string): Promise<MaterialNeedList> {
  const need = await materialNeedForJob(jobId);
  if (!need) return { estimates: [], lines: [] };
  const { ests, expanded, grouped, bookById } = need;
  const lines: MaterialNeedLine[] = expanded.map(({ itemId, quantity }) => {
    const original = grouped.get(itemId);
    const book = bookById.get(itemId);
    return {
      itemId,
      name: original?.name ?? book?.description ?? itemId,
      unit: original?.unit ?? book?.unitLabel ?? book?.unit ?? null,
      qty: quantity,
    };
  });
  return {
    estimates: ests.map((e) => ({ id: e.id, number: e.number, title: e.title })),
    lines,
  };
}

/**
 * The job's material shortage: everything the signed scope (every signed estimate on the job,
 * assemblies expanded to their real components) still needs beyond what a truck already holds,
 * what has already been consumed, and what is already on order.
 */
export async function shortagesForJob(jobId: string, truckId: string): Promise<ShortageLine[]> {
  const need = await materialNeedForJob(jobId);
  if (!need || need.expanded.length === 0) return [];
  const { ests, expanded, grouped, bookById } = need;

  const realIds = expanded.map((e) => e.itemId);
  const chain = [...new Set(ests.flatMap((est) => chainOf(jobId, est)))];
  const [onHand, consumedMovements, openPoLines] = await Promise.all([
    onHandFor(truckId, realIds),
    prisma.stockMovement.findMany({
      where: { jobId: { in: [jobId, ...chain] }, kind: { in: ["consume", "return"] }, itemId: { in: realIds } },
      select: { itemId: true, kind: true, qty: true },
    }),
    prisma.purchaseOrderLine.findMany({
      where: { itemId: { in: realIds }, purchaseOrder: { jobId: { in: [jobId, ...chain] }, status: { in: [...OPEN_PO_STATUSES] } } },
      select: { itemId: true, qty: true },
    }),
  ]);
  const consumedById = new Map<string, number>();
  for (const m of consumedMovements) consumedById.set(m.itemId, r4((consumedById.get(m.itemId) ?? 0) + (m.kind === "consume" ? m.qty : -m.qty)));
  const onOrderById = new Map<string, number>();
  for (const l of openPoLines) {
    if (!l.itemId) continue;
    onOrderById.set(l.itemId, r4((onOrderById.get(l.itemId) ?? 0) + l.qty));
  }

  const out: ShortageLine[] = [];
  for (const { itemId, quantity } of expanded) {
    const book = bookById.get(itemId);
    const original = grouped.get(itemId); // set only when this itemId was already a plain (unexpanded) estimate line
    const oh = onHand[itemId];
    const consumedQty = consumedById.get(itemId) ?? 0;
    const qtyOnOpenPOs = onOrderById.get(itemId) ?? 0;
    const onHandQty = oh?.qty ?? 0;
    const shortBy = r4(Math.max(0, quantity - consumedQty - onHandQty - qtyOnOpenPOs));
    if (shortBy <= 0) continue;
    out.push({
      itemId,
      name: original?.name ?? book?.description ?? itemId,
      unit: oh?.unit ?? original?.unit ?? book?.unitLabel ?? book?.unit ?? null,
      neededQty: quantity,
      consumedQty,
      onHand: onHandQty,
      qtyOnOpenPOs,
      shortBy,
    });
  }
  return out;
}

/**
 * The close-out warning (never a block — Kyle: "We do not want to lock
 * ourselves out of closing a job"): a signed estimate with material lines and
 * no consume recorded means the truck count is still carrying what the job
 * used. (Since 2026-09-19 this is about the inventory count only — the job's
 * cost comes from its P.O.s, not from what was consumed.)
 */
export async function closeOutMaterialWarning(jobId: string): Promise<string | null> {
  // A test job never uses material, so "you recorded none" is not news.
  const job = await prisma.visit.findUnique({
    where: { id: jobId },
    select: { customer: { select: { isTestAccount: true } } },
  });
  if (job?.customer.isTestAccount) return null;

  const est = await signedEstimateForJob(jobId);
  if (!est || materialLinesOf(est).length === 0) return null;
  const consumed = await prisma.stockMovement.count({ where: { jobId: { in: [jobId, ...chainOf(jobId, est)] }, kind: "consume" } });
  if (consumed > 0) return null;
  return "No materials recorded from truck stock — the truck count still carries what this job used.";
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
  /**
   * True routes the return to the warehouse instead of a truck — Kyle's
   * ruling 2026-09-15: "counted to the truck or warehouse." Truck stays the
   * default so every existing caller (the visit-page ReturnForm, the field
   * app's /visits/:id/return) is unaffected.
   */
  warehouse?: boolean;
  lines: ConsumeLineInput[];
  reason?: string | null;
  actor: string;
}

/**
 * Job → truck (or, since 2026-09-15, the warehouse). The credit is at the
 * cost the job was CHARGED for that item (the weighted average of its
 * consumes), so a unit taken and put back nets to zero on the job even if the
 * truck's average moved in between; an item the job never consumed returns at
 * the truck's average.
 *
 * Guard added 2026-09-15 for the close-out count: an item this job actually
 * consumed cannot be returned past what is still outstanding (consumed minus
 * already returned) — the count step lets Kyle type a number, and nothing
 * downstream re-checks it. An item the job never consumed keeps the older,
 * permissive behaviour (priced at the truck's average) rather than being
 * refused outright, since that path predates this guard and nothing here
 * documented it as wrong.
 */
export async function returnForJob(input: ReturnInput): Promise<StockMovement[]> {
  validateLines(input.lines);
  const job = await prisma.visit.findUnique({ where: { id: input.jobId }, select: { id: true } });
  if (!job) throw new InventoryError("Job not found", 404);
  const truck = input.warehouse ? null : await resolveTruck(input.truckId);
  const to = input.warehouse ? WAREHOUSE_KEY : truckLocationKey(truck!.id);
  const described = await Promise.all(input.lines.map(async (l) => {
    const itemId = l.itemId?.trim() || adhocItemId(l.name ?? "");
    return { itemId, qty: l.qty, ...(await describe(itemId, l.name, l.unit)) };
  }));
  const priorMovements = await prisma.stockMovement.findMany({
    where: { jobId: input.jobId, kind: { in: ["consume", "return"] }, itemId: { in: described.map((d) => d.itemId) } },
    select: { itemId: true, kind: true, qty: true, unitCost: true },
  });
  const chargedAvg = new Map<string, number>();
  const netOutstanding = new Map<string, number>();
  for (const itemId of new Set(priorMovements.map((c) => c.itemId))) {
    const mine = priorMovements.filter((c) => c.itemId === itemId);
    const consumed = mine.filter((c) => c.kind === "consume");
    const consumedQty = consumed.reduce((s, c) => s + c.qty, 0);
    if (consumedQty > 0) {
      chargedAvg.set(itemId, consumed.reduce((s, c) => s + c.qty * (c.unitCost ?? 0), 0) / consumedQty);
      const returnedQty = mine.filter((c) => c.kind === "return").reduce((s, c) => s + c.qty, 0);
      netOutstanding.set(itemId, r4(consumedQty - returnedQty));
    }
  }
  for (const line of described) {
    if (!chargedAvg.has(line.itemId)) continue; // never consumed by this job — the older, permissive path
    const available = netOutstanding.get(line.itemId) ?? 0;
    if (line.qty > available + 1e-9) {
      throw new InventoryError(`${line.name} — this job only has ${r4(available)} ${line.unit ?? ""} outstanding, can't return ${line.qty}.`, 409);
    }
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
  /** What the job still needs beyond on-hand, consumed, and what's already on order — the
   *  pre-fill for "Create P.O." (Unit P, 2026-09-17). Only positive shortages. */
  shortages: ShortageLine[];
  lines: JobMaterialLine[];
  /** What the ledger says the job drew off the truck — inventory, not cost (Kyle, 2026-09-19). */
  stock: StockMaterial | null;
  receipts: Array<{
    id: string; vendor: string | null; amount: number; category: string; status: string; receivedAt: Date;
    purchaseOrderId: string | null; purchaseOrderNumber: string | null;
    /** A photo or PDF is on it — it proves its P.O. */
    hasFile: boolean;
    /** What the receipt is doing here; a receipt is never money. */
    note: string | null;
  }>;
  /** THE MONEY: card charges + typed not-on-card amounts on the P.O.s tagged to this job (and its quote visit). */
  materialCost: number;
  materialSource: MaterialCostResult["materialSource"];
  po: MaterialCostResult["po"];
  /** The signed estimate's frozen taken-scope material — display only, never cost. */
  estimateMaterial: number | null;
}

export async function jobMaterials(jobId: string, truckId?: string | null): Promise<JobMaterialsView> {
  const visit = await prisma.visit.findUnique({ where: { id: jobId }, select: { id: true } });
  if (!visit) throw new InventoryError("Job not found", 404);
  const truck = await resolveTruck(truckId);
  const est = await signedEstimateForJob(jobId);
  const chain = chainOf(jobId, est);
  const [suggested, shortages, movements, receipts, costs, stockByVisit] = await Promise.all([
    suggestedLinesForJob(jobId, truck.id),
    shortagesForJob(jobId, truck.id),
    prisma.stockMovement.findMany({
      where: { jobId: { in: [jobId, ...chain] }, kind: { in: ["consume", "return", "correction"] } },
      orderBy: [{ at: "asc" }, { createdAt: "asc" }],
    }),
    prisma.receipt.findMany({
      where: { jobId: { in: [jobId, ...chain] } },
      orderBy: { receivedAt: "desc" },
      select: { id: true, vendor: true, amount: true, category: true, status: true, receivedAt: true, imageMime: true, imageUrl: true, purchaseOrderId: true, purchaseOrder: { select: { number: true } } },
    }),
    materialCostForJobs([{ visitId: jobId, chainVisitIds: chain }]),
    stockMaterialByJob([jobId, ...chain]),
  ]);
  const cost = costs.get(jobId)!;
  const stockParts = [jobId, ...chain].map((id) => stockByVisit.get(id)).filter((s): s is StockMaterial => Boolean(s));
  const stock: StockMaterial | null = stockParts.length === 0
    ? null
    : {
      consumed: round2(stockParts.reduce((s, p) => s + p.consumed, 0)),
      returned: round2(stockParts.reduce((s, p) => s + p.returned, 0)),
      net: round2(stockParts.reduce((s, p) => s + p.net, 0)),
      movementCount: stockParts.reduce((s, p) => s + p.movementCount, 0),
    };
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
    shortages,
    lines,
    stock,
    receipts: receipts.map((r) => {
      const hasFile = Boolean(r.imageMime || r.imageUrl);
      return {
        id: r.id, vendor: r.vendor, amount: r.amount, category: r.category, status: r.status, receivedAt: r.receivedAt,
        purchaseOrderId: r.purchaseOrderId, purchaseOrderNumber: r.purchaseOrder?.number ?? null,
        hasFile,
        note: r.purchaseOrderId
          ? `proof on ${r.purchaseOrder?.number ?? "its PO"}${hasFile ? "" : " — no photo or PDF attached"}`
          : "no PO — proves nothing yet",
      };
    }),
    materialCost: cost.materialCost,
    materialSource: cost.materialSource,
    po: cost.po,
    estimateMaterial: est ? estimateMaterialCost({ selectedOptions: est.selectedOptions.map(String), lines: est.lines.map((l) => ({ option: String(l.option), materialCost: l.materialCost })) }) : null,
  };
}
