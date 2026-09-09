/**
 * Inventory ledger and tool register (Kyle, 2026-09-09, Build 3).
 *
 * "We need an inventory tab that tracks what is on the truck and what is at
 * the warehouse so on future jobs I can label some stock as truckstock and it
 * won't double count the cost." "Warehouse items will only be used to transfer
 * material to truck stock." "There is only one warehouse for now it is my home
 * location."
 *
 * The shape: StockLevel is the running balance per item per location; the
 * ONLY writer is applyMovement. StockMovement is the append-only ledger — a
 * correction is a new movement that references the one it corrects ("We need
 * to be able to edit manually in case there are errors found"). Cost method is
 * moving average per item per location. Opening stock is a physical count
 * valued at the last purchase price.
 *
 * Tools: "some tools will not stay on a truck but will be used between trucks
 * as the jobs demand. The tools can be assigned to the warehouse and also to a
 * truck. When they are used and stored the stock will be updated as to where
 * the tool is currently at."
 *
 * JOB COSTING IS UNCHANGED IN THIS BUILD. "consume" and "return" exist in the
 * ledger with the same math, but nothing here charges a job — that switch is
 * Build 4 (services/jobCosting.ts, receiptCosting.ts and the P&L are untouched).
 */

import type { Prisma, PurchaseOrder, StockLevel, StockMovement, Tool } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { logSystemEvent } from "./systemEvents";
import { PO_LIST_INCLUDE, closePurchaseOrderForLanding, serializePurchaseOrder, type PoPurpose } from "./purchaseOrders";

type Tx = Prisma.TransactionClient;

// ─── Locations ───────────────────────────────────────────────────────────────

/** Kyle, 2026-09-09: "There is only one warehouse for now it is my home location." */
export const WAREHOUSE_KEY = "warehouse";
export const truckLocationKey = (truckId: string) => `truck:${truckId}`;

export type ParsedLocation = { type: "warehouse" } | { type: "truck"; truckId: string };

export function parseLocationKey(key: string): ParsedLocation {
  if (key === WAREHOUSE_KEY) return { type: "warehouse" };
  if (key.startsWith("truck:") && key.length > 6) return { type: "truck", truckId: key.slice(6) };
  throw new InventoryError(`Unknown location "${key}" — use "warehouse" or "truck:<truckId>".`, 400);
}

/** A location key the ledger will accept: the warehouse, or a truck that exists. */
export async function assertLocation(db: Tx, key: string): Promise<ParsedLocation> {
  const parsed = parseLocationKey(key);
  if (parsed.type === "truck") {
    const truck = await db.truck.findUnique({ where: { id: parsed.truckId }, select: { id: true } });
    if (!truck) throw new InventoryError(`Truck ${parsed.truckId} not found`, 404);
  }
  return parsed;
}

export class InventoryError extends Error {
  constructor(message: string, public readonly statusCode: number) {
    super(message);
    this.name = "InventoryError";
  }
}

export const MOVEMENT_KINDS = ["purchase_in", "transfer", "consume", "return", "count", "correction"] as const;
export type MovementKind = (typeof MOVEMENT_KINDS)[number];

const r4 = (n: number) => Math.round(n * 10000) / 10000;
const r6 = (n: number) => Math.round(n * 1000000) / 1000000;

/**
 * A PO line with no book itemId still has to be tracked once it lands — the
 * level keys off a slug of the name so the same free-text item merges with
 * itself the next time it is bought or counted.
 */
export function adhocItemId(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return `adhoc:${slug || "item"}`;
}

/** The book's last purchase price for an item — what a count is valued at when the level is new. */
export async function lastPurchasePrice(db: Tx, itemId: string): Promise<number> {
  if (itemId.startsWith("adhoc:")) return 0;
  const row = await db.priceBookAtomic.findUnique({ where: { itemId }, select: { purchasePrice: true, costBasisUsed: true } });
  return row?.purchasePrice ?? row?.costBasisUsed ?? 0;
}

// ─── The one writer ───────────────────────────────────────────────────────────

export interface MovementInput {
  kind: MovementKind;
  itemId: string;
  name: string;
  unit?: string | null;
  /** Positive. For "count" the counted quantity; for "correction" |delta|. */
  qty: number;
  /** correction only: the signed quantity change to apply. */
  delta?: number;
  /** purchase_in: the purchase price. count (new level) / correction: the avg to set. */
  unitCost?: number | null;
  fromLocationKey?: string | null;
  toLocationKey?: string | null;
  purchaseOrderId?: string | null;
  purchaseOrderLineId?: string | null;
  jobId?: string | null;
  correctsId?: string | null;
  reason?: string | null;
  actor: string;
  /** Never from the UI — lets a scripted fix drive a level below zero. */
  allowNegative?: boolean;
  at?: Date;
}

async function levelFor(tx: Tx, locationKey: string, itemId: string): Promise<StockLevel | null> {
  return tx.stockLevel.findUnique({ where: { locationKey_itemId: { locationKey, itemId } } });
}

/** Merge `qty` at `unitCost` into a location — the moving-average step. */
async function mergeIn(tx: Tx, locationKey: string, m: MovementInput, qty: number, unitCost: number): Promise<StockLevel> {
  const existing = await levelFor(tx, locationKey, m.itemId);
  if (!existing) {
    return tx.stockLevel.create({
      data: { locationKey, itemId: m.itemId, name: m.name, unit: m.unit ?? null, qtyOnHand: r4(qty), avgUnitCost: r6(unitCost) },
    });
  }
  const newQty = existing.qtyOnHand + qty;
  // Guarded: a level at or below zero takes the incoming cost outright — averaging
  // against a negative or empty balance would produce nonsense.
  const avg = existing.qtyOnHand <= 0 || newQty <= 0
    ? unitCost
    : (existing.qtyOnHand * existing.avgUnitCost + qty * unitCost) / newQty;
  return tx.stockLevel.update({
    where: { id: existing.id },
    data: { qtyOnHand: r4(newQty), avgUnitCost: r6(avg), ...(existing.unit == null && m.unit ? { unit: m.unit } : {}) },
  });
}

/** Take `qty` out of a location at its moving average. Returns the cost applied. */
async function takeOut(tx: Tx, locationKey: string, m: MovementInput, qty: number): Promise<{ level: StockLevel; unitCost: number }> {
  const existing = await levelFor(tx, locationKey, m.itemId);
  const onHand = existing?.qtyOnHand ?? 0;
  if (onHand - qty < -1e-9 && !m.allowNegative) {
    const where = parseLocationKey(locationKey).type === "warehouse" ? "the warehouse" : "that truck";
    throw new InventoryError(`Only ${r4(onHand)} ${m.unit ?? ""} of ${m.name} on hand at ${where} — ${qty} would go negative.`.replace(/\s+—/, " —"), 409);
  }
  if (!existing) {
    const level = await tx.stockLevel.create({
      data: { locationKey, itemId: m.itemId, name: m.name, unit: m.unit ?? null, qtyOnHand: r4(-qty), avgUnitCost: r6(m.unitCost ?? 0) },
    });
    return { level, unitCost: m.unitCost ?? 0 };
  }
  const level = await tx.stockLevel.update({ where: { id: existing.id }, data: { qtyOnHand: r4(existing.qtyOnHand - qty) } });
  return { level, unitCost: existing.avgUnitCost };
}

/**
 * applyMovement — the only writer of StockLevel. Every kind lands one
 * StockMovement row and adjusts the level(s) it names:
 *
 *   purchase_in  to += qty at unitCost; avg = (oldQty·oldAvg + qty·unitCost) / (oldQty + qty)
 *   transfer     from −= qty at from's avg; to merges at that cost. FROM IS ALWAYS
 *                THE WAREHOUSE (Kyle: "Warehouse items will only be used to
 *                transfer material to truck stock").
 *   consume      from (a truck) −= qty at its avg, toward jobId. No job costing here.
 *   return       to (a truck) += qty from jobId at unitCost ?? the truck's avg.
 *   count        sets the location's on-hand to qty; delta = qty − old; avg unchanged
 *                (a NEW level takes unitCost ?? the book's last purchase price).
 *   correction   references correctsId; applies the signed delta to the location(s)
 *                named; unitCost, if given, resets that level's avg. Reason REQUIRED.
 *
 * Negative on-hand is refused (409) for transfer and consume unless allowNegative.
 */
export async function applyMovement(tx: Tx, m: MovementInput): Promise<StockMovement> {
  if (!MOVEMENT_KINDS.includes(m.kind)) throw new InventoryError(`Unknown movement kind "${m.kind}"`, 400);
  if (!m.itemId.trim()) throw new InventoryError("itemId is required", 400);
  if (!Number.isFinite(m.qty) || m.qty < 0) throw new InventoryError("qty must be a non-negative number", 400);
  if (m.kind !== "count" && m.kind !== "correction" && m.qty <= 0) throw new InventoryError("qty must be positive", 400);

  let unitCostApplied: number | null = m.unitCost ?? null;
  let delta: number | null = m.delta ?? null;
  let from = m.fromLocationKey ?? null;
  let to = m.toLocationKey ?? null;

  switch (m.kind) {
    case "purchase_in": {
      if (!to) throw new InventoryError("purchase_in needs a toLocationKey", 400);
      await assertLocation(tx, to);
      const cost = m.unitCost ?? 0;
      await mergeIn(tx, to, m, m.qty, cost);
      unitCostApplied = cost;
      delta = m.qty;
      break;
    }
    case "transfer": {
      if (!from || !to) throw new InventoryError("transfer needs fromLocationKey and toLocationKey", 400);
      if (from !== WAREHOUSE_KEY) {
        throw new InventoryError("Stock transfers start at the warehouse — Kyle's rule: warehouse items only move to truck stock.", 409);
      }
      if (to === from) throw new InventoryError("A transfer needs two different locations", 400);
      await assertLocation(tx, to);
      const out = await takeOut(tx, from, m, m.qty);
      await mergeIn(tx, to, m, m.qty, out.unitCost);
      unitCostApplied = out.unitCost;
      delta = m.qty;
      break;
    }
    case "consume": {
      if (!from) throw new InventoryError("consume needs a fromLocationKey", 400);
      await assertLocation(tx, from);
      const out = await takeOut(tx, from, m, m.qty);
      unitCostApplied = out.unitCost;
      delta = -m.qty;
      break;
    }
    case "return": {
      if (!to) throw new InventoryError("return needs a toLocationKey", 400);
      await assertLocation(tx, to);
      const existing = await levelFor(tx, to, m.itemId);
      const cost = m.unitCost ?? existing?.avgUnitCost ?? 0;
      await mergeIn(tx, to, m, m.qty, cost);
      unitCostApplied = cost;
      delta = m.qty;
      break;
    }
    case "count": {
      if (!to) throw new InventoryError("count needs a toLocationKey (the location counted)", 400);
      await assertLocation(tx, to);
      const existing = await levelFor(tx, to, m.itemId);
      if (existing) {
        delta = r4(m.qty - existing.qtyOnHand);
        await tx.stockLevel.update({
          where: { id: existing.id },
          data: { qtyOnHand: r4(m.qty), ...(existing.unit == null && m.unit ? { unit: m.unit } : {}) },
        });
        unitCostApplied = existing.avgUnitCost;
      } else {
        const cost = m.unitCost ?? (await lastPurchasePrice(tx, m.itemId));
        await tx.stockLevel.create({
          data: { locationKey: to, itemId: m.itemId, name: m.name, unit: m.unit ?? null, qtyOnHand: r4(m.qty), avgUnitCost: r6(cost) },
        });
        delta = r4(m.qty);
        unitCostApplied = cost;
      }
      break;
    }
    case "correction": {
      if (!m.correctsId) throw new InventoryError("A correction must name the movement it corrects (correctsId)", 400);
      if (!m.reason?.trim()) throw new InventoryError("A reason is required for a correction", 400);
      const original = await tx.stockMovement.findUnique({ where: { id: m.correctsId } });
      if (!original) throw new InventoryError("The movement being corrected was not found", 404);
      const signed = m.delta ?? 0;
      if (!Number.isFinite(signed)) throw new InventoryError("delta must be a number", 400);
      from = from ?? original.fromLocationKey;
      to = to ?? original.toLocationKey;
      if (!from && !to) throw new InventoryError("A correction needs a location to apply to", 400);
      // The signed delta reads from the receiving side: +delta adds to `to` and
      // takes the same from `from`, exactly as the original movement did.
      if (to) {
        await assertLocation(tx, to);
        const level = await levelFor(tx, to, m.itemId);
        if (level) {
          await tx.stockLevel.update({
            where: { id: level.id },
            data: { qtyOnHand: r4(level.qtyOnHand + signed), ...(m.unitCost != null ? { avgUnitCost: r6(m.unitCost) } : {}) },
          });
        } else {
          await tx.stockLevel.create({
            data: { locationKey: to, itemId: m.itemId, name: m.name, unit: m.unit ?? null, qtyOnHand: r4(signed), avgUnitCost: r6(m.unitCost ?? original.unitCost ?? 0) },
          });
        }
      }
      if (from) {
        await assertLocation(tx, from);
        const level = await levelFor(tx, from, m.itemId);
        if (level) {
          await tx.stockLevel.update({
            where: { id: level.id },
            data: { qtyOnHand: r4(level.qtyOnHand - signed), ...(m.unitCost != null && !to ? { avgUnitCost: r6(m.unitCost) } : {}) },
          });
        } else {
          await tx.stockLevel.create({
            data: { locationKey: from, itemId: m.itemId, name: m.name, unit: m.unit ?? null, qtyOnHand: r4(-signed), avgUnitCost: r6(m.unitCost ?? original.unitCost ?? 0) },
          });
        }
      }
      delta = r4(signed);
      unitCostApplied = m.unitCost ?? null;
      break;
    }
  }

  return tx.stockMovement.create({
    data: {
      kind: m.kind,
      itemId: m.itemId,
      name: m.name,
      unit: m.unit ?? null,
      qty: m.kind === "correction" ? Math.abs(delta ?? 0) : r4(m.qty),
      delta,
      unitCost: unitCostApplied == null ? null : r6(unitCostApplied),
      fromLocationKey: from,
      toLocationKey: to,
      purchaseOrderId: m.purchaseOrderId ?? null,
      purchaseOrderLineId: m.purchaseOrderLineId ?? null,
      jobId: m.jobId ?? null,
      correctsId: m.correctsId ?? null,
      reason: m.reason?.trim() || null,
      actor: m.actor,
      ...(m.at ? { at: m.at } : {}),
    },
  });
}

// ─── Landing a PO ─────────────────────────────────────────────────────────────

const LANDING_INCLUDE = {
  lines: { orderBy: { sortOrder: "asc" as const } },
  receipts: { select: { id: true, amount: true, imageMime: true, imageUrl: true } },
  truck: { select: { id: true, name: true } },
} satisfies Prisma.PurchaseOrderInclude;

type LandingPo = Prisma.PurchaseOrderGetPayload<{ include: typeof LANDING_INCLUDE }>;

/** Where this PO's material lands. Throws when a truck PO has lost its truck. */
export function destinationKeyOf(po: Pick<PurchaseOrder, "destinationType" | "truckId" | "number">): string {
  if (po.destinationType === "warehouse") return WAREHOUSE_KEY;
  if (!po.truckId) throw new InventoryError(`${po.number} points at no truck — set one before landing it.`, 409);
  return truckLocationKey(po.truckId);
}

/** Why a PO cannot land right now, or null when it can. */
export function landingBlocker(po: Pick<PurchaseOrder, "status" | "number" | "landedAt" | "afterTheFact">, hasReceiptPhoto: boolean): string | null {
  if (po.landedAt) return `${po.number} already landed.`;
  if (po.status === "open") return `${po.number} is still open — purchase first, then land it.`;
  if (po.status === "closed" || po.status === "cancelled") return `${po.number} is ${po.status}; it cannot land.`;
  if (po.afterTheFact && !hasReceiptPhoto) return `${po.number} was drafted after the fact — attach the receipt photo before landing it.`;
  return null;
}

export interface LandingLineDefault {
  lineId: string;
  itemId: string | null;
  name: string;
  unit: string | null;
  qtyExpected: number;
  qtyLandedDefault: number;
  unitCostDefault: number;
  /** Where the default came from — shown beside the editable field. */
  costSource: "receipt" | "line" | "book" | "none";
  bookPurchasePrice: number | null;
}

/**
 * The defaults the landing panel shows, all editable. Unit cost: when the PO
 * has a receipt with an amount and every line has a quantity, the receipt
 * total is prorated across lines by expected qty × the book's purchase price
 * (equal split when the book has no price for one of them); otherwise the
 * line's keyed unit cost, else the book price, else 0.
 */
export async function landingDefaults(id: string) {
  const po = await prisma.purchaseOrder.findUnique({ where: { id }, include: { ...LANDING_INCLUDE, ...PO_LIST_INCLUDE } });
  if (!po) throw new InventoryError("Purchase order not found", 404);
  const hasPhoto = po.receipts.some((r) => r.imageMime || r.imageUrl);
  const receiptTotal = Math.round(po.receipts.reduce((s, r) => s + (r.amount ?? 0), 0) * 100) / 100;
  const itemIds = po.lines.map((l) => l.itemId).filter((x): x is string => Boolean(x));
  const book = itemIds.length
    ? await prisma.priceBookAtomic.findMany({ where: { itemId: { in: itemIds } }, select: { itemId: true, purchasePrice: true, costBasisUsed: true, unit: true, unitLabel: true } })
    : [];
  const bookById = new Map(book.map((b) => [b.itemId, b]));
  const bookPrice = (itemId: string | null) => {
    const b = itemId ? bookById.get(itemId) : undefined;
    return b?.purchasePrice ?? b?.costBasisUsed ?? null;
  };

  const allHaveQty = po.lines.length > 0 && po.lines.every((l) => Number.isFinite(l.qty) && l.qty > 0);
  const prorate = receiptTotal > 0 && allHaveQty;
  const allPriced = po.lines.every((l) => bookPrice(l.itemId) != null);
  const weights = po.lines.map((l) => (prorate && allPriced ? l.qty * (bookPrice(l.itemId) ?? 0) : 1));
  const weightSum = weights.reduce((s, w) => s + w, 0);

  const lines: LandingLineDefault[] = po.lines.map((l, i) => {
    const price = bookPrice(l.itemId);
    let unitCostDefault = 0;
    let costSource: LandingLineDefault["costSource"] = "none";
    if (prorate && weightSum > 0) {
      unitCostDefault = (receiptTotal * (weights[i] / weightSum)) / l.qty;
      costSource = "receipt";
    } else if (l.unitCost != null) {
      unitCostDefault = l.unitCost;
      costSource = "line";
    } else if (price != null) {
      unitCostDefault = price;
      costSource = "book";
    }
    return {
      lineId: l.id,
      itemId: l.itemId,
      name: l.name,
      unit: l.unit ?? (l.itemId ? bookById.get(l.itemId)?.unitLabel ?? bookById.get(l.itemId)?.unit ?? null : null),
      qtyExpected: l.qty,
      qtyLandedDefault: l.qtyLanded ?? l.qty,
      unitCostDefault: Math.round(unitCostDefault * 10000) / 10000,
      costSource,
      bookPurchasePrice: price,
    };
  });

  let destinationKey: string | null = null;
  try { destinationKey = destinationKeyOf(po); } catch { destinationKey = null; }
  return {
    purchaseOrder: serializePurchaseOrder(po),
    destinationKey,
    destinationLabel: po.destinationType === "warehouse" ? "Warehouse (home)" : po.truck?.name ?? "truck",
    receiptTotal,
    receiptCount: po.receipts.length,
    hasReceiptPhoto: hasPhoto,
    blocker: landingBlocker(po, hasPhoto) ?? (destinationKey ? null : `${po.number} points at no truck.`),
    lines,
  };
}

export interface LandingLineInput {
  lineId: string;
  qtyLanded: number;
  unitCost: number;
}

/**
 * Land a purchased/verified PO: truck_stock and warehouse POs write one
 * purchase_in per line to the PO's destination; a tool PO creates qtyLanded
 * Tool rows there. Lines then carry qtyLanded / unitCost / landedAt, the PO
 * closes (through verified, one "status" event, reason "landed"), landedAt is
 * stamped, and a "landed" event holds the lines. Landing twice → 409.
 */
export async function landPurchaseOrder(id: string, lines: LandingLineInput[], actor: string, reason?: string | null) {
  const po = await prisma.purchaseOrder.findUnique({ where: { id }, include: LANDING_INCLUDE });
  if (!po) throw new InventoryError("Purchase order not found", 404);
  const hasPhoto = po.receipts.some((r) => r.imageMime || r.imageUrl);
  const blocker = landingBlocker(po, hasPhoto);
  if (blocker) throw new InventoryError(blocker, 409);
  const destination = destinationKeyOf(po);
  const purpose = po.purpose as PoPurpose;
  const byLineId = new Map(po.lines.map((l) => [l.id, l]));
  for (const input of lines) {
    if (!byLineId.has(input.lineId)) throw new InventoryError(`Line ${input.lineId} is not on ${po.number}`, 404);
    if (!Number.isFinite(input.qtyLanded) || input.qtyLanded < 0) throw new InventoryError("qtyLanded must be zero or more", 400);
    if (!Number.isFinite(input.unitCost) || input.unitCost < 0) throw new InventoryError("unitCost must be zero or more", 400);
  }

  return prisma.$transaction(async (tx) => {
    await assertLocation(tx, destination);
    const now = new Date();
    const landed: Array<{ lineId: string; itemId: string; name: string; qtyLanded: number; unitCost: number; movementId?: string; toolIds?: string[] }> = [];
    for (const input of lines) {
      const line = byLineId.get(input.lineId)!;
      const itemId = line.itemId ?? adhocItemId(line.name);
      const entry: (typeof landed)[number] = { lineId: line.id, itemId, name: line.name, qtyLanded: input.qtyLanded, unitCost: input.unitCost };
      if (purpose === "tool") {
        const count = Math.round(input.qtyLanded);
        const ids: string[] = [];
        for (let i = 0; i < count; i++) {
          const tool = await tx.tool.create({
            data: {
              name: line.name,
              cost: input.unitCost,
              purchasedAt: po.purchasedAt ?? now,
              purchaseOrderId: po.id,
              locationKey: destination,
              notes: line.partNumber ? `Part #${line.partNumber} · ${po.number}` : po.number,
            },
          });
          ids.push(tool.id);
        }
        entry.toolIds = ids;
      } else if (input.qtyLanded > 0) {
        const mv = await applyMovement(tx, {
          kind: "purchase_in",
          itemId,
          name: line.name,
          unit: line.unit,
          qty: input.qtyLanded,
          unitCost: input.unitCost,
          toLocationKey: destination,
          purchaseOrderId: po.id,
          purchaseOrderLineId: line.id,
          reason: reason ?? null,
          actor,
          at: now,
        });
        entry.movementId = mv.id;
      }
      await tx.purchaseOrderLine.update({
        where: { id: line.id },
        data: { qtyLanded: input.qtyLanded, unitCost: input.unitCost, landedAt: now },
      });
      landed.push(entry);
    }
    await closePurchaseOrderForLanding(tx, po, { actor });
    const updated = await tx.purchaseOrder.update({ where: { id: po.id }, data: { landedAt: now } });
    await tx.purchaseOrderEvent.create({
      data: {
        purchaseOrderId: po.id,
        actor,
        kind: "landed",
        reason: reason ?? null,
        after: JSON.stringify({ destination, purpose, lines: landed }),
      },
    });
    return { purchaseOrder: updated, destination, lines: landed };
  });
}

// ─── Reads ───────────────────────────────────────────────────────────────────

export function serializeLevel(l: StockLevel) {
  return {
    id: l.id,
    locationKey: l.locationKey,
    itemId: l.itemId,
    name: l.name,
    unit: l.unit,
    qtyOnHand: l.qtyOnHand,
    avgUnitCost: l.avgUnitCost,
    value: Math.round(l.qtyOnHand * l.avgUnitCost * 100) / 100,
    parLevel: l.parLevel,
    low: l.parLevel != null && l.qtyOnHand < l.parLevel,
    updatedAt: l.updatedAt,
  };
}
export type StockLevelView = ReturnType<typeof serializeLevel>;

export function serializeMovement(m: StockMovement) {
  return {
    id: m.id, kind: m.kind, itemId: m.itemId, name: m.name, unit: m.unit, qty: m.qty, delta: m.delta, unitCost: m.unitCost,
    fromLocationKey: m.fromLocationKey, toLocationKey: m.toLocationKey, purchaseOrderId: m.purchaseOrderId,
    purchaseOrderLineId: m.purchaseOrderLineId, jobId: m.jobId, correctsId: m.correctsId, reason: m.reason, actor: m.actor, at: m.at,
  };
}

const valueOf = (levels: StockLevel[]) => Math.round(levels.reduce((s, l) => s + l.qtyOnHand * l.avgUnitCost, 0) * 100) / 100;

/** The whole picture: warehouse, every active truck, open requests, and POs waiting to land. */
export async function inventoryOverview() {
  const [trucks, levels, requests, unlanded] = await Promise.all([
    prisma.truck.findMany({ where: { isActive: true }, orderBy: { createdAt: "asc" }, select: { id: true, name: true, technicianId: true, technician: { select: { name: true } } } }),
    prisma.stockLevel.findMany({ orderBy: [{ name: "asc" }] }),
    prisma.stockRequest.findMany({ where: { status: "open" }, orderBy: { createdAt: "asc" }, include: { truck: { select: { id: true, name: true } } } }),
    prisma.purchaseOrder.findMany({
      where: { status: { in: ["purchased", "verified"] }, landedAt: null },
      orderBy: { openedAt: "asc" },
      include: PO_LIST_INCLUDE,
    }),
  ]);
  const warehouseLevels = levels.filter((l) => l.locationKey === WAREHOUSE_KEY);
  return {
    warehouse: { locationKey: WAREHOUSE_KEY, levels: warehouseLevels.map(serializeLevel), value: valueOf(warehouseLevels) },
    trucks: trucks.map((t) => {
      const key = truckLocationKey(t.id);
      const mine = levels.filter((l) => l.locationKey === key);
      const views = mine.map(serializeLevel);
      return {
        truck: { id: t.id, name: t.name, technicianId: t.technicianId, technicianName: t.technician?.name ?? null },
        locationKey: key,
        levels: views,
        value: valueOf(mine),
        lowStock: views.filter((l) => l.low),
      };
    }),
    openRequests: requests.map(serializeStockRequest),
    unlandedPos: unlanded.map((po) => {
      const v = serializePurchaseOrder(po);
      return { id: v.id, number: v.number, supplier: v.supplier, status: v.status, purpose: v.purpose, truckId: v.truckId, truckName: v.truckName, purchasedAt: v.purchasedAt, receiptCount: v.receiptCount, lineCount: v.lines.length };
    }),
  };
}

/** Per-truck rollups for the Trucks page (additive). */
export async function truckInventoryRollups(): Promise<Map<string, { stockValue: number; toolCount: number }>> {
  const [levels, tools] = await Promise.all([
    prisma.stockLevel.findMany({ where: { locationKey: { startsWith: "truck:" } }, select: { locationKey: true, qtyOnHand: true, avgUnitCost: true } }),
    prisma.tool.groupBy({ by: ["locationKey"], where: { locationKey: { startsWith: "truck:" }, condition: { not: "retired" } }, _count: { _all: true } }),
  ]);
  const out = new Map<string, { stockValue: number; toolCount: number }>();
  const get = (key: string) => {
    const truckId = key.slice(6);
    const row = out.get(truckId) ?? { stockValue: 0, toolCount: 0 };
    out.set(truckId, row);
    return row;
  };
  for (const l of levels) get(l.locationKey).stockValue += l.qtyOnHand * l.avgUnitCost;
  for (const t of tools) get(t.locationKey).toolCount = t._count._all;
  for (const row of out.values()) row.stockValue = Math.round(row.stockValue * 100) / 100;
  return out;
}

export async function listMovements(filter: { itemId?: string; locationKey?: string; purchaseOrderId?: string; limit?: number }) {
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 500);
  const rows = await prisma.stockMovement.findMany({
    where: {
      ...(filter.itemId ? { itemId: filter.itemId } : {}),
      ...(filter.purchaseOrderId ? { purchaseOrderId: filter.purchaseOrderId } : {}),
      ...(filter.locationKey ? { OR: [{ fromLocationKey: filter.locationKey }, { toLocationKey: filter.locationKey }] } : {}),
    },
    orderBy: [{ at: "desc" }, { createdAt: "desc" }],
    take: limit,
  });
  return rows.map(serializeMovement);
}

/** The book, picker-shaped: id, description, unit, and the last purchase price. */
export async function searchItems(q: string, limit = 25) {
  const term = q.trim();
  const rows = await prisma.priceBookAtomic.findMany({
    where: {
      retiredAt: null,
      ...(term ? { OR: [{ itemId: { contains: term, mode: "insensitive" } }, { description: { contains: term, mode: "insensitive" } }] } : {}),
    },
    orderBy: [{ itemId: "asc" }],
    take: Math.min(limit, 100),
    select: { itemId: true, description: true, unit: true, unitLabel: true, purchasePrice: true, costBasisUsed: true, category: true },
  });
  return rows.map((r) => ({
    itemId: r.itemId,
    description: r.description,
    unit: r.unitLabel ?? r.unit,
    category: r.category,
    purchasePrice: r.purchasePrice,
    costBasisUsed: r.costBasisUsed,
    lastCost: r.purchasePrice ?? r.costBasisUsed ?? null,
  }));
}

// ─── Writes the routes call ───────────────────────────────────────────────────

/** Name + unit for an itemId when the caller did not send them: the level, then the book. */
async function describeItem(db: Tx, itemId: string, name?: string | null, unit?: string | null): Promise<{ name: string; unit: string | null }> {
  if (name?.trim()) return { name: name.trim(), unit: unit?.trim() || null };
  const level = await db.stockLevel.findFirst({ where: { itemId }, select: { name: true, unit: true } });
  if (level) return { name: level.name, unit: unit?.trim() || level.unit };
  const book = await db.priceBookAtomic.findUnique({ where: { itemId }, select: { description: true, unit: true, unitLabel: true } });
  if (book) return { name: book.description ?? itemId, unit: unit?.trim() || book.unitLabel || book.unit || null };
  return { name: itemId, unit: unit?.trim() || null };
}

/** Warehouse → truck. The API only takes a truck; the from side is Kyle's rule. */
export async function transferStock(input: { itemId: string; qty: number; fromLocationKey?: string; toLocationKey: string; reason?: string | null; actor: string }) {
  const from = input.fromLocationKey ?? WAREHOUSE_KEY;
  if (from !== WAREHOUSE_KEY) {
    throw new InventoryError("Stock transfers start at the warehouse — Kyle's rule: warehouse items only move to truck stock.", 409);
  }
  return prisma.$transaction(async (tx) => {
    const { name, unit } = await describeItem(tx, input.itemId);
    return applyMovement(tx, {
      kind: "transfer", itemId: input.itemId, name, unit, qty: input.qty,
      fromLocationKey: from, toLocationKey: input.toLocationKey, reason: input.reason ?? null, actor: input.actor,
    });
  });
}

export interface CountLineInput { itemId: string; name?: string | null; unit?: string | null; qty: number; unitCost?: number | null }

/** A physical count at one location — one "count" movement per line, all under one reason. */
export async function countStock(input: { locationKey: string; lines: CountLineInput[]; reason: string; actor: string }) {
  if (!input.reason.trim()) throw new InventoryError("A reason is required for a count", 400);
  if (input.lines.length === 0) throw new InventoryError("Nothing to count", 400);
  return prisma.$transaction(async (tx) => {
    await assertLocation(tx, input.locationKey);
    const out: StockMovement[] = [];
    for (const line of input.lines) {
      const { name, unit } = await describeItem(tx, line.itemId, line.name, line.unit);
      out.push(await applyMovement(tx, {
        kind: "count", itemId: line.itemId, name, unit, qty: line.qty, unitCost: line.unitCost ?? null,
        toLocationKey: input.locationKey, reason: input.reason, actor: input.actor,
      }));
    }
    return out;
  });
}

/** A correction is a new movement referencing the one it corrects; the reason is required. */
export async function correctMovement(input: { correctsId: string; delta: number; unitCost?: number | null; reason: string; actor: string }) {
  if (!input.reason?.trim()) throw new InventoryError("A reason is required for a correction", 400);
  const original = await prisma.stockMovement.findUnique({ where: { id: input.correctsId } });
  if (!original) throw new InventoryError("The movement being corrected was not found", 404);
  return prisma.$transaction((tx) => applyMovement(tx, {
    kind: "correction", itemId: original.itemId, name: original.name, unit: original.unit, qty: Math.abs(input.delta), delta: input.delta,
    unitCost: input.unitCost ?? null, correctsId: original.id, purchaseOrderId: original.purchaseOrderId, jobId: original.jobId,
    reason: input.reason, actor: input.actor,
  }));
}

export async function setParLevel(levelId: string, parLevel: number | null) {
  const level = await prisma.stockLevel.findUnique({ where: { id: levelId } });
  if (!level) throw new InventoryError("Stock level not found", 404);
  return serializeLevel(await prisma.stockLevel.update({ where: { id: levelId }, data: { parLevel } }));
}

// ─── Tools ───────────────────────────────────────────────────────────────────

export const TOOL_CONDITIONS = ["good", "needs_repair", "retired"] as const;
export type ToolCondition = (typeof TOOL_CONDITIONS)[number];

export function serializeTool(t: Tool & { purchaseOrder?: { number: string } | null }) {
  return {
    id: t.id, name: t.name, serial: t.serial, cost: t.cost, purchasedAt: t.purchasedAt, purchaseOrderId: t.purchaseOrderId,
    purchaseOrderNumber: t.purchaseOrder?.number ?? null, condition: t.condition, locationKey: t.locationKey, notes: t.notes, createdAt: t.createdAt,
  };
}

export async function listTools(filter: { locationKey?: string } = {}) {
  const rows = await prisma.tool.findMany({
    where: filter.locationKey ? { locationKey: filter.locationKey } : {},
    orderBy: [{ condition: "asc" }, { name: "asc" }],
    include: { purchaseOrder: { select: { number: true } } },
  });
  return rows.map(serializeTool);
}

export async function createTool(input: { name: string; serial?: string | null; cost?: number | null; locationKey: string; notes?: string | null; purchasedAt?: Date | null }, actor: string) {
  await assertLocation(prisma, input.locationKey);
  const tool = await prisma.tool.create({
    data: {
      name: input.name.trim(), serial: input.serial?.trim() || null, cost: input.cost ?? null, locationKey: input.locationKey,
      notes: input.notes?.trim() || null, purchasedAt: input.purchasedAt ?? null,
    },
    include: { purchaseOrder: { select: { number: true } } },
  });
  logSystemEvent("info", "inventory", `Tool added by hand: ${tool.name} at ${tool.locationKey}`, { toolId: tool.id, actor });
  return serializeTool(tool);
}

/** Header edits leave their reason in the system log (no separate tool-edit table). */
export async function updateTool(
  id: string,
  patch: { name?: string; serial?: string | null; cost?: number | null; condition?: ToolCondition; notes?: string | null },
  meta: { actor: string; reason: string },
) {
  if (!meta.reason.trim()) throw new InventoryError("A reason is required", 400);
  const before = await prisma.tool.findUnique({ where: { id } });
  if (!before) throw new InventoryError("Tool not found", 404);
  const data: Prisma.ToolUpdateInput = {};
  if (patch.name !== undefined) data.name = patch.name.trim();
  if (patch.serial !== undefined) data.serial = patch.serial?.trim() || null;
  if (patch.cost !== undefined) data.cost = patch.cost;
  if (patch.condition !== undefined) data.condition = patch.condition;
  if (patch.notes !== undefined) data.notes = patch.notes?.trim() || null;
  const tool = await prisma.tool.update({ where: { id }, data, include: { purchaseOrder: { select: { number: true } } } });
  logSystemEvent("info", "inventory", `Tool edited: ${tool.name} — ${meta.reason}`, {
    toolId: id, actor: meta.actor, reason: meta.reason,
    before: { name: before.name, serial: before.serial, cost: before.cost, condition: before.condition, notes: before.notes },
    after: { name: tool.name, serial: tool.serial, cost: tool.cost, condition: tool.condition, notes: tool.notes },
  });
  return serializeTool(tool);
}

/** "When they are used and stored the stock will be updated as to where the tool is currently at." */
export async function moveTool(id: string, toLocationKey: string, meta: { actor: string; reason?: string | null }) {
  const tool = await prisma.tool.findUnique({ where: { id } });
  if (!tool) throw new InventoryError("Tool not found", 404);
  await assertLocation(prisma, toLocationKey);
  if (tool.locationKey === toLocationKey) throw new InventoryError(`${tool.name} is already there.`, 409);
  return prisma.$transaction(async (tx) => {
    const movement = await tx.toolMovement.create({
      data: { toolId: id, fromLocationKey: tool.locationKey, toLocationKey, actor: meta.actor, reason: meta.reason?.trim() || null },
    });
    const updated = await tx.tool.update({ where: { id }, data: { locationKey: toLocationKey }, include: { purchaseOrder: { select: { number: true } } } });
    return { tool: serializeTool(updated), movement };
  });
}

export async function toolDetail(id: string) {
  const tool = await prisma.tool.findUnique({
    where: { id },
    include: { purchaseOrder: { select: { number: true } }, movements: { orderBy: { at: "desc" }, take: 100 } },
  });
  if (!tool) throw new InventoryError("Tool not found", 404);
  return { ...serializeTool(tool), movements: tool.movements };
}

// ─── Stock requests ──────────────────────────────────────────────────────────

type StockRequestRow = Prisma.StockRequestGetPayload<{ include: { truck: { select: { id: true; name: true } } } }>;

export function serializeStockRequest(r: StockRequestRow) {
  return {
    id: r.id, truckId: r.truckId, truckName: r.truck.name, itemId: r.itemId, name: r.name, qty: r.qty, unit: r.unit, note: r.note,
    status: r.status, requestedByTechnicianId: r.requestedByTechnicianId, createdAt: r.createdAt, resolvedAt: r.resolvedAt,
  };
}

export async function createStockRequest(input: { truckId: string; itemId?: string | null; name: string; qty: number; unit?: string | null; note?: string | null; requestedByTechnicianId?: string | null }) {
  const truck = await prisma.truck.findUnique({ where: { id: input.truckId }, select: { id: true } });
  if (!truck) throw new InventoryError("Truck not found", 404);
  if (!Number.isFinite(input.qty) || input.qty <= 0) throw new InventoryError("qty must be positive", 400);
  const row = await prisma.stockRequest.create({
    data: {
      truckId: input.truckId, itemId: input.itemId?.trim() || null, name: input.name.trim(), qty: input.qty, unit: input.unit?.trim() || null,
      note: input.note?.trim() || null, requestedByTechnicianId: input.requestedByTechnicianId ?? null,
    },
    include: { truck: { select: { id: true, name: true } } },
  });
  return serializeStockRequest(row);
}

export async function listStockRequests(status?: string) {
  const rows = await prisma.stockRequest.findMany({
    where: status ? { status } : {},
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    take: 200,
    include: { truck: { select: { id: true, name: true } } },
  });
  return rows.map(serializeStockRequest);
}

/** Fulfill = the warehouse → truck transfer for the request's qty. 409 when the warehouse is short. */
export async function fulfillStockRequest(id: string, meta: { actor: string; itemId?: string | null }) {
  const req = await prisma.stockRequest.findUnique({ where: { id }, include: { truck: { select: { id: true, name: true } } } });
  if (!req) throw new InventoryError("Stock request not found", 404);
  if (req.status !== "open") throw new InventoryError(`This request is already ${req.status}.`, 409);
  const itemId = meta.itemId?.trim() || req.itemId || adhocItemId(req.name);
  return prisma.$transaction(async (tx) => {
    const movement = await applyMovement(tx, {
      kind: "transfer", itemId, name: req.name, unit: req.unit, qty: req.qty,
      fromLocationKey: WAREHOUSE_KEY, toLocationKey: truckLocationKey(req.truckId),
      reason: `Restock request from ${req.truck.name}${req.note ? ` — ${req.note}` : ""}`, actor: meta.actor,
    });
    const updated = await tx.stockRequest.update({
      where: { id }, data: { status: "fulfilled", resolvedAt: new Date(), ...(req.itemId ? {} : { itemId }) },
      include: { truck: { select: { id: true, name: true } } },
    });
    return { request: serializeStockRequest(updated), movement: serializeMovement(movement) };
  });
}

export async function declineStockRequest(id: string, meta: { actor: string; reason: string }) {
  if (!meta.reason?.trim()) throw new InventoryError("A reason is required to decline a request", 400);
  const req = await prisma.stockRequest.findUnique({ where: { id } });
  if (!req) throw new InventoryError("Stock request not found", 404);
  if (req.status !== "open") throw new InventoryError(`This request is already ${req.status}.`, 409);
  const updated = await prisma.stockRequest.update({
    where: { id },
    data: { status: "declined", resolvedAt: new Date(), note: [req.note, `Declined: ${meta.reason.trim()}`].filter(Boolean).join(" · ") },
    include: { truck: { select: { id: true, name: true } } },
  });
  logSystemEvent("info", "inventory", `Restock request declined — ${meta.reason.trim()}`, { requestId: id, actor: meta.actor });
  return serializeStockRequest(updated);
}
