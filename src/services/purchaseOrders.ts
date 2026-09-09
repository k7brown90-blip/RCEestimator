/**
 * Purchase orders — the document (Kyle, 2026-09-09).
 *
 * "Purchasing needs to start with a P.O. number then the purchase and photo
 * verification of the receipt." Every PO gets PO-YYYY-NNNN at creation, a
 * chosen purpose ("Truck Stock, Warehouse, or Tool purchase ... The default
 * will be truck stock"), a destination that is a truck or the warehouse —
 * never a job — and an edit trail ("We need to be able to edit manually in
 * case there are errors found").
 *
 * Job costing is NOT changed by this build: a receipt attached to a PO still
 * counts toward the job it sits on (services/receiptCosting.ts). Consuming
 * truck stock onto jobs is a later build.
 */

import type { Prisma, PurchaseOrder } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { rerollJobsMaterialCost } from "./receiptCosting";

export const PO_PURPOSES = ["truck_stock", "warehouse", "tool"] as const;
export type PoPurpose = (typeof PO_PURPOSES)[number];
export const PO_STATUSES = ["open", "purchased", "verified", "closed", "cancelled"] as const;
export type PoStatus = (typeof PO_STATUSES)[number];
export type PoDestination = "truck" | "warehouse";

/** The chain: open → purchased → verified → closed; cancel from open/purchased; closed/cancelled are terminal. */
const TRANSITIONS: Record<PoStatus, PoStatus[]> = {
  open: ["purchased", "cancelled"],
  purchased: ["verified", "cancelled"],
  verified: ["closed"],
  closed: [],
  cancelled: [],
};

const STATUS_STAMP: Partial<Record<PoStatus, "purchasedAt" | "verifiedAt" | "closedAt" | "cancelledAt">> = {
  purchased: "purchasedAt",
  verified: "verifiedAt",
  closed: "closedAt",
  cancelled: "cancelledAt",
};

class PoError extends Error {
  constructor(message: string, public readonly statusCode: number) {
    super(message);
    this.name = "PurchaseOrderError";
  }
}

type Tx = Prisma.TransactionClient;

/** Warehouse POs land in the warehouse; everything else lands on a truck. */
export function destinationFor(purpose: PoPurpose): PoDestination {
  return purpose === "warehouse" ? "warehouse" : "truck";
}

/**
 * The oldest active truck — Kyle's "Truck 1". Created if none exists so a fresh
 * database (tests) still has somewhere for truck stock to land.
 */
export async function defaultTruckId(): Promise<string> {
  const existing = await prisma.truck.findFirst({ where: { isActive: true }, orderBy: { createdAt: "asc" }, select: { id: true } });
  if (existing) return existing.id;
  const created = await prisma.truck.create({ data: { name: "Truck 1" }, select: { id: true } });
  return created.id;
}

/** The truck assigned to this technician, else the default truck. */
export async function truckIdForTechnician(technicianId: string): Promise<string> {
  const mine = await prisma.truck.findFirst({ where: { technicianId, isActive: true }, orderBy: { createdAt: "asc" }, select: { id: true } });
  return mine?.id ?? defaultTruckId();
}

/** The year a PO is numbered under — Central time, the company's clock. */
function poYear(at: Date): number {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", year: "numeric" }).format(at));
}

/**
 * Next PO-YYYY-NNNN. The counter row is upserted with a row lock inside the
 * caller's transaction, so concurrent creates serialize on it and each gets a
 * distinct sequence. A number handed out is never reused, even if the create
 * rolls back — that only burns a sequence, which is the cheap failure.
 */
export async function nextPoNumber(tx: Tx, year: number): Promise<string> {
  const rows = await tx.$queryRaw<{ next: number }[]>`
    INSERT INTO "PurchaseOrderCounter" ("year", "next") VALUES (${year}, 2)
    ON CONFLICT ("year") DO UPDATE SET "next" = "PurchaseOrderCounter"."next" + 1
    RETURNING "next"
  `;
  const next = rows[0]?.next;
  if (!next) throw new Error("PO counter did not return a sequence");
  return `PO-${year}-${String(next - 1).padStart(4, "0")}`;
}

export interface PoLineInput {
  itemId?: string | null;
  name: string;
  qty: number;
  unit?: string | null;
  partNumber?: string | null;
  unitCost?: number | null;
}

export interface CreatePurchaseOrderInput {
  supplier: string;
  purpose?: PoPurpose;
  destinationType?: PoDestination;
  truckId?: string | null;
  jobId?: string | null;
  notes?: string | null;
  lines?: PoLineInput[];
  openedBy: "owner" | "tech";
  openedByTechnicianId?: string | null;
  /** Service-level only (tests): number under this date's year. */
  openedAt?: Date;
  actor: string;
}

function lineData(line: PoLineInput, sortOrder: number) {
  return {
    itemId: line.itemId ?? null,
    name: line.name.trim(),
    qty: line.qty,
    unit: line.unit?.trim() || null,
    partNumber: line.partNumber?.trim() || null,
    unitCost: line.unitCost ?? null,
    sortOrder,
  };
}

export async function createPurchaseOrder(input: CreatePurchaseOrderInput): Promise<PurchaseOrder> {
  const purpose = input.purpose ?? "truck_stock";
  const destinationType = input.destinationType ?? destinationFor(purpose);
  // A warehouse PO points at no truck; a truck PO needs one.
  const truckId = destinationType === "warehouse" ? null : (input.truckId ?? (await defaultTruckId()));
  if (truckId) {
    const truck = await prisma.truck.findUnique({ where: { id: truckId }, select: { id: true } });
    if (!truck) throw new PoError("Truck not found", 404);
  }
  if (input.jobId) {
    const job = await prisma.visit.findUnique({ where: { id: input.jobId }, select: { id: true } });
    if (!job) throw new PoError("Job not found", 404);
  }
  const openedAt = input.openedAt ?? new Date();
  const lines = (input.lines ?? []).filter((l) => l.name.trim() && Number.isFinite(l.qty) && l.qty > 0);

  return prisma.$transaction(async (tx) => {
    const number = await nextPoNumber(tx, poYear(openedAt));
    const po = await tx.purchaseOrder.create({
      data: {
        number,
        purpose,
        destinationType,
        truckId,
        jobId: input.jobId ?? null,
        supplier: input.supplier.trim(),
        status: "open",
        notes: input.notes?.trim() || null,
        openedBy: input.openedBy,
        openedByTechnicianId: input.openedByTechnicianId ?? null,
        openedAt,
        lines: { create: lines.map((l, i) => lineData(l, i)) },
      },
    });
    await tx.purchaseOrderEvent.create({
      data: {
        purchaseOrderId: po.id,
        actor: input.actor,
        kind: "created",
        after: JSON.stringify({ number, purpose, destinationType, truckId, jobId: po.jobId, supplier: po.supplier, lines: lines.length }),
      },
    });
    return po;
  });
}

export interface PoPatch {
  supplier?: string;
  purpose?: PoPurpose;
  destinationType?: PoDestination;
  truckId?: string | null;
  notes?: string | null;
  jobId?: string | null;
}

async function loadPo(id: string) {
  const po = await prisma.purchaseOrder.findUnique({ where: { id } });
  if (!po) throw new PoError("Purchase order not found", 404);
  return po;
}

function assertEditable(po: PurchaseOrder) {
  if (po.status === "closed" || po.status === "cancelled") {
    throw new PoError(`${po.number} is ${po.status} — reopen is not a thing; open a new PO.`, 409);
  }
}

/** Header edits. Every one writes an "edited" event with before/after and the reason. */
export async function updatePurchaseOrder(
  id: string,
  patch: PoPatch,
  meta: { actor: string; reason: string },
): Promise<PurchaseOrder> {
  const po = await loadPo(id);
  assertEditable(po);
  const data: Prisma.PurchaseOrderUpdateInput = {};
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};

  if (patch.supplier !== undefined && patch.supplier.trim() !== po.supplier) {
    before.supplier = po.supplier; after.supplier = patch.supplier.trim(); data.supplier = patch.supplier.trim();
  }
  if (patch.notes !== undefined && (patch.notes?.trim() || null) !== po.notes) {
    before.notes = po.notes; after.notes = patch.notes?.trim() || null; data.notes = patch.notes?.trim() || null;
  }
  // Purpose and destination move together: a warehouse PO has no truck.
  const purpose = patch.purpose ?? (po.purpose as PoPurpose);
  const destinationType = patch.destinationType ?? (patch.purpose ? destinationFor(patch.purpose) : (po.destinationType as PoDestination));
  let truckId = patch.truckId !== undefined ? patch.truckId : po.truckId;
  if (destinationType === "warehouse") truckId = null;
  else if (!truckId) truckId = await defaultTruckId();
  if (purpose !== po.purpose) { before.purpose = po.purpose; after.purpose = purpose; data.purpose = purpose; }
  if (destinationType !== po.destinationType) { before.destinationType = po.destinationType; after.destinationType = destinationType; data.destinationType = destinationType; }
  if (truckId !== po.truckId) {
    if (truckId) {
      const truck = await prisma.truck.findUnique({ where: { id: truckId }, select: { id: true } });
      if (!truck) throw new PoError("Truck not found", 404);
    }
    before.truckId = po.truckId; after.truckId = truckId;
    data.truck = truckId ? { connect: { id: truckId } } : { disconnect: true };
  }
  if (patch.jobId !== undefined && patch.jobId !== po.jobId) {
    if (patch.jobId) {
      const job = await prisma.visit.findUnique({ where: { id: patch.jobId }, select: { id: true } });
      if (!job) throw new PoError("Job not found", 404);
    }
    before.jobId = po.jobId; after.jobId = patch.jobId;
    data.job = patch.jobId ? { connect: { id: patch.jobId } } : { disconnect: true };
  }

  if (Object.keys(after).length === 0) return po;
  return prisma.$transaction(async (tx) => {
    const updated = await tx.purchaseOrder.update({ where: { id }, data });
    await tx.purchaseOrderEvent.create({
      data: { purchaseOrderId: id, actor: meta.actor, kind: "edited", reason: meta.reason, before: JSON.stringify(before), after: JSON.stringify(after) },
    });
    return updated;
  });
}

export async function addPurchaseOrderLine(id: string, line: PoLineInput, meta: { actor: string; reason?: string }) {
  const po = await loadPo(id);
  assertEditable(po);
  const last = await prisma.purchaseOrderLine.aggregate({ where: { purchaseOrderId: id }, _max: { sortOrder: true } });
  const data = lineData(line, (last._max.sortOrder ?? -1) + 1);
  return prisma.$transaction(async (tx) => {
    const created = await tx.purchaseOrderLine.create({ data: { ...data, purchaseOrderId: id } });
    await tx.purchaseOrderEvent.create({
      data: { purchaseOrderId: id, actor: meta.actor, kind: "line_added", reason: meta.reason ?? null, after: JSON.stringify(created) },
    });
    return created;
  });
}

export async function editPurchaseOrderLine(
  id: string,
  lineId: string,
  patch: Partial<PoLineInput> & { qtyLanded?: number | null },
  meta: { actor: string; reason: string },
) {
  const po = await loadPo(id);
  assertEditable(po);
  const line = await prisma.purchaseOrderLine.findFirst({ where: { id: lineId, purchaseOrderId: id } });
  if (!line) throw new PoError("Line not found on this purchase order", 404);
  const data: Prisma.PurchaseOrderLineUpdateInput = {};
  if (patch.name !== undefined) data.name = patch.name.trim();
  if (patch.qty !== undefined) data.qty = patch.qty;
  if (patch.unit !== undefined) data.unit = patch.unit?.trim() || null;
  if (patch.partNumber !== undefined) data.partNumber = patch.partNumber?.trim() || null;
  if (patch.unitCost !== undefined) data.unitCost = patch.unitCost;
  if (patch.qtyLanded !== undefined) data.qtyLanded = patch.qtyLanded;
  if (patch.itemId !== undefined) data.itemId = patch.itemId;
  return prisma.$transaction(async (tx) => {
    const updated = await tx.purchaseOrderLine.update({ where: { id: lineId }, data });
    await tx.purchaseOrderEvent.create({
      data: { purchaseOrderId: id, actor: meta.actor, kind: "line_edited", reason: meta.reason, before: JSON.stringify(line), after: JSON.stringify(updated) },
    });
    return updated;
  });
}

export async function removePurchaseOrderLine(id: string, lineId: string, meta: { actor: string; reason: string }) {
  const po = await loadPo(id);
  assertEditable(po);
  const line = await prisma.purchaseOrderLine.findFirst({ where: { id: lineId, purchaseOrderId: id } });
  if (!line) throw new PoError("Line not found on this purchase order", 404);
  await prisma.$transaction(async (tx) => {
    await tx.purchaseOrderLine.delete({ where: { id: lineId } });
    await tx.purchaseOrderEvent.create({
      data: { purchaseOrderId: id, actor: meta.actor, kind: "line_removed", reason: meta.reason, before: JSON.stringify(line) },
    });
  });
}

/** The status chain, enforced. Refusals are 409s the routes pass straight through. */
export async function transitionPurchaseOrder(
  id: string,
  to: PoStatus,
  meta: { actor: string; reason?: string | null },
): Promise<PurchaseOrder> {
  const po = await loadPo(id);
  return transitionLoaded(prisma, po, to, meta);
}

async function transitionLoaded(
  db: Tx | typeof prisma,
  po: PurchaseOrder,
  to: PoStatus,
  meta: { actor: string; reason?: string | null },
): Promise<PurchaseOrder> {
  const from = po.status as PoStatus;
  if (!TRANSITIONS[from]?.includes(to)) {
    throw new PoError(`${po.number} is ${from}; it cannot go to ${to}.`, 409);
  }
  const stamp = STATUS_STAMP[to];
  const updated = await db.purchaseOrder.update({
    where: { id: po.id },
    data: { status: to, ...(stamp ? { [stamp]: new Date() } : {}) },
  });
  await db.purchaseOrderEvent.create({
    data: {
      purchaseOrderId: po.id,
      actor: meta.actor,
      kind: "status",
      reason: meta.reason ?? null,
      before: JSON.stringify({ status: from }),
      after: JSON.stringify({ status: to }),
    },
  });
  return updated;
}

/**
 * The receipt is the verification. Attaching sets receipt.purchaseOrderId; a
 * receipt with no job inherits the PO's job so the job's material keeps
 * rolling (costing rule unchanged); an open PO moves to purchased — a receipt
 * means the purchase happened.
 */
export async function attachReceiptToPurchaseOrder(receiptId: string, poId: string, actor: string) {
  const receipt = await prisma.receipt.findUnique({
    where: { id: receiptId },
    select: { id: true, jobId: true, purchaseOrderId: true, vendor: true, amount: true, category: true },
  });
  if (!receipt) throw new PoError("Receipt not found", 404);
  const po = await loadPo(poId);
  if (po.status === "cancelled") throw new PoError(`${po.number} is cancelled; attach the receipt to a live PO.`, 409);
  if (po.status === "closed") throw new PoError(`${po.number} is closed; attach the receipt to a live PO.`, 409);

  const newJobId = receipt.jobId ?? po.jobId ?? null;
  await prisma.$transaction(async (tx) => {
    await tx.receipt.update({
      where: { id: receiptId },
      data: { purchaseOrderId: poId, ...(newJobId !== receipt.jobId ? { jobId: newJobId } : {}) },
    });
    await tx.purchaseOrderEvent.create({
      data: {
        purchaseOrderId: poId,
        actor,
        kind: "receipt_attached",
        after: JSON.stringify({ receiptId, vendor: receipt.vendor, amount: receipt.amount, category: receipt.category, jobId: newJobId }),
      },
    });
    if (po.status === "open") await transitionLoaded(tx, po, "purchased", { actor, reason: "Receipt attached" });
  });
  await rerollJobsMaterialCost([receipt.jobId, newJobId]);
  return { receiptId, purchaseOrderId: poId, jobId: newJobId };
}

export async function detachReceiptFromPurchaseOrder(receiptId: string, actor: string) {
  const receipt = await prisma.receipt.findUnique({
    where: { id: receiptId },
    select: { id: true, jobId: true, purchaseOrderId: true, vendor: true, amount: true },
  });
  if (!receipt) throw new PoError("Receipt not found", 404);
  if (!receipt.purchaseOrderId) return;
  const poId = receipt.purchaseOrderId;
  await prisma.$transaction(async (tx) => {
    await tx.receipt.update({ where: { id: receiptId }, data: { purchaseOrderId: null } });
    await tx.purchaseOrderEvent.create({
      data: {
        purchaseOrderId: poId,
        actor,
        kind: "receipt_detached",
        before: JSON.stringify({ receiptId, vendor: receipt.vendor, amount: receipt.amount }),
      },
    });
  });
}

// ─── Read shapes shared by the CRM and field routes ──────────────────────────

export const PO_LIST_INCLUDE = {
  lines: { orderBy: { sortOrder: "asc" as const } },
  truck: { select: { id: true, name: true } },
  job: {
    select: {
      id: true, jobType: true, purpose: true,
      customer: { select: { id: true, name: true } },
      property: { select: { addressLine1: true, city: true } },
    },
  },
  _count: { select: { receipts: true } },
} satisfies Prisma.PurchaseOrderInclude;

type PoListRow = Prisma.PurchaseOrderGetPayload<{ include: typeof PO_LIST_INCLUDE }>;

export function jobLabelOf(job: PoListRow["job"]): string | null {
  if (!job) return null;
  return `${job.jobType || job.purpose || "Job"} — ${job.property.addressLine1}, ${job.property.city}`;
}

export function serializePurchaseOrder(po: PoListRow) {
  return {
    id: po.id,
    number: po.number,
    purpose: po.purpose,
    destinationType: po.destinationType,
    truckId: po.truckId,
    truckName: po.truck?.name ?? null,
    jobId: po.jobId,
    jobLabel: jobLabelOf(po.job),
    accountId: po.job?.customer.id ?? null,
    accountName: po.job?.customer.name ?? null,
    supplier: po.supplier,
    status: po.status,
    notes: po.notes,
    openedBy: po.openedBy,
    openedByTechnicianId: po.openedByTechnicianId,
    openedAt: po.openedAt,
    purchasedAt: po.purchasedAt,
    verifiedAt: po.verifiedAt,
    closedAt: po.closedAt,
    cancelledAt: po.cancelledAt,
    sentAt: po.sentAt,
    createdAt: po.createdAt,
    receiptCount: po._count.receipts,
    lines: po.lines.map((l) => ({
      id: l.id, itemId: l.itemId, name: l.name, qty: l.qty, unit: l.unit, partNumber: l.partNumber,
      unitCost: l.unitCost, qtyLanded: l.qtyLanded, sortOrder: l.sortOrder,
    })),
  };
}

export type PurchaseOrderView = ReturnType<typeof serializePurchaseOrder>;

/** Parse "open,purchased" into a status filter; unknown values are dropped. */
export function parseStatusFilter(raw: unknown): PoStatus[] | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const list = raw.split(",").map((s) => s.trim()).filter((s): s is PoStatus => (PO_STATUSES as readonly string[]).includes(s));
  return list.length ? list : undefined;
}
