/**
 * Trucks, cards, and card spend (Kyle, 2026-09-09).
 *
 * "Each tech will have their own card for material and gas through stripe and
 * I will have to set up a financial account for each." A truck is the ledger
 * its card spends against: gas and maintenance are per-truck overhead, never a
 * job; materials on the card go looking for their PO (services/cardSpend.ts).
 *
 * Mounted behind the operator session like financialsRouter. Every edit takes
 * a one-line reason and leaves a trail.
 */

import express from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { asyncHandler, readParam } from "./agent-helpers";
import {
  CARD_SPEND_INCLUDE, CARD_SPEND_KINDS, listIssuingCards, readBalances, receiptCategoriesFor, serializeCardSpend,
  syncCardSpend, truckSpendRollups, updateCardSpend,
} from "../services/cardSpend";
import { PO_LIST_INCLUDE, defaultTruckId, serializePurchaseOrder } from "../services/purchaseOrders";
import { truckInventoryRollups } from "../services/inventory";

export const trucksRouter = express.Router();

const reasonSchema = z.string().trim().min(1, "A reason is required").max(300);
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();

const TRUCK_SELECT = {
  id: true, name: true, technicianId: true, isActive: true, createdAt: true,
  stripeCardId: true, cardLast4: true, stripeFinancialAccountId: true, notes: true,
  technician: { select: { id: true, name: true } },
} as const;

function yearOf(raw: unknown): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 2000 && n < 2100 ? n : new Date().getFullYear();
}

async function assertTechnician(technicianId: string | null | undefined) {
  if (!technicianId) return;
  const tech = await prisma.technician.findUnique({ where: { id: technicianId }, select: { id: true } });
  if (!tech) throw Object.assign(new Error("Technician not found"), { statusCode: 404 });
}

// ── Trucks ───────────────────────────────────────────────────────────────────

/** Every truck with its tech, card, financial account balance, MTD spend by kind and unmatched count. */
trucksRouter.get("/trucks", asyncHandler(async (_req, res) => {
  await defaultTruckId();
  const [trucks, rollups, balances, inventory] = await Promise.all([
    prisma.truck.findMany({ orderBy: [{ isActive: "desc" }, { createdAt: "asc" }], select: TRUCK_SELECT }),
    truckSpendRollups(),
    readBalances(),
    truckInventoryRollups(),
  ]);
  const faById = new Map(balances.financialAccounts.map((fa) => [fa.id, fa]));
  res.json({
    balancesAvailable: balances.available,
    balancesReason: balances.reason ?? null,
    trucks: trucks.map((t) => {
      const r = rollups.get(t.id) ?? { fuel: 0, maintenance: 0, materials: 0, tool: 0, other: 0, unmatched: 0 };
      const fa = t.stripeFinancialAccountId ? faById.get(t.stripeFinancialAccountId) ?? null : null;
      return {
        id: t.id,
        name: t.name,
        technicianId: t.technicianId,
        technicianName: t.technician?.name ?? null,
        isActive: t.isActive,
        stripeCardId: t.stripeCardId,
        cardLast4: t.cardLast4,
        stripeFinancialAccountId: t.stripeFinancialAccountId,
        notes: t.notes,
        balance: fa ? { cashUsd: fa.cashUsd, inboundPending: fa.inboundPending, outboundPending: fa.outboundPending, status: fa.status } : null,
        mtd: { fuel: r.fuel, maintenance: r.maintenance, materials: r.materials, tool: r.tool, other: r.other },
        unmatchedMaterials: r.unmatched,
        // Kyle, 2026-09-09 (Build 3): what the truck is carrying — stock at moving-average cost, and its tools.
        stockValue: inventory.get(t.id)?.stockValue ?? 0,
        toolCount: inventory.get(t.id)?.toolCount ?? 0,
      };
    }),
    // Spend on a card no truck claims — Kyle sees it here so it never hides.
    unassigned: rollups.get(null) ?? null,
  });
}));

/** The Issuing cards, for the picker. Graceful when the key lacks scope. */
trucksRouter.get("/trucks/stripe-cards", asyncHandler(async (_req, res) => {
  res.json(await listIssuingCards());
}));

trucksRouter.post("/trucks", asyncHandler(async (req, res) => {
  const body = z.object({
    name: z.string().trim().min(1).max(100),
    technicianId: z.string().nullable().optional(),
  }).parse(req.body);
  await assertTechnician(body.technicianId);
  const truck = await prisma.truck.create({ data: { name: body.name, technicianId: body.technicianId ?? null }, select: TRUCK_SELECT });
  res.status(201).json(truck);
}));

trucksRouter.patch("/trucks/:id", asyncHandler(async (req, res) => {
  const body = z.object({
    name: z.string().trim().min(1).max(100).optional(),
    technicianId: z.string().nullable().optional(),
    stripeCardId: optionalText(100),
    cardLast4: optionalText(4),
    stripeFinancialAccountId: optionalText(100),
    notes: optionalText(1000),
    isActive: z.boolean().optional(),
  }).parse(req.body);
  const id = readParam(req, "id");
  const existing = await prisma.truck.findUnique({ where: { id }, select: { id: true } });
  if (!existing) { res.status(404).json({ error: "Truck not found" }); return; }
  await assertTechnician(body.technicianId);
  if (body.stripeCardId) {
    const taken = await prisma.truck.findUnique({ where: { stripeCardId: body.stripeCardId }, select: { id: true, name: true } });
    if (taken && taken.id !== id) { res.status(409).json({ error: `That card is already on ${taken.name}. One card, one truck.` }); return; }
  }
  // Kyle, 2026-09-10: "need to be able to delete truck 1. This should be editable and trucks
  // retired." Retiring hides the truck from every picker and the default-truck rule, but it
  // cannot leave stock, tools or open purchases stranded on a truck nobody drives.
  if (body.isActive === false) {
    const blockers = await truckBlockers(id);
    if (blockers.length > 0) {
      res.status(409).json({ error: `Move these off the truck first, then retire it: ${blockers.join("; ")}.`, blockers });
      return;
    }
  }
  const truck = await prisma.truck.update({
    where: { id },
    data: {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.technicianId !== undefined ? { technicianId: body.technicianId } : {}),
      ...(body.stripeCardId !== undefined ? { stripeCardId: body.stripeCardId || null } : {}),
      ...(body.cardLast4 !== undefined ? { cardLast4: body.cardLast4 || null } : {}),
      ...(body.stripeFinancialAccountId !== undefined ? { stripeFinancialAccountId: body.stripeFinancialAccountId || null } : {}),
      ...(body.notes !== undefined ? { notes: body.notes || null } : {}),
      ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
    },
    select: TRUCK_SELECT,
  });
  // A card just mapped to this truck claims the spend that arrived unrouted on it.
  if (body.stripeCardId) {
    await prisma.cardSpend.updateMany({ where: { stripeCardId: body.stripeCardId, truckId: null }, data: { truckId: id } });
  }
  res.json(truck);
}));

/** What would be stranded if this truck were retired: stock on hand, tools on it, open purchases. */
async function truckBlockers(truckId: string): Promise<string[]> {
  const key = `truck:${truckId}`;
  const [levels, tools, openPos] = await Promise.all([
    prisma.stockLevel.findMany({ where: { locationKey: key, qtyOnHand: { gt: 0 } }, select: { name: true, qtyOnHand: true, unit: true } }),
    prisma.tool.count({ where: { locationKey: key, condition: { not: "retired" } } }),
    prisma.purchaseOrder.count({ where: { truckId, status: { in: ["open", "purchased", "verified"] } } }),
  ]);
  const out: string[] = [];
  if (levels.length > 0) {
    out.push(`${levels.length} stock item(s) on hand (${levels.slice(0, 3).map((l) => `${l.qtyOnHand} ${l.unit ?? ""} ${l.name}`.trim()).join(", ")}${levels.length > 3 ? ", …" : ""})`);
  }
  if (tools > 0) out.push(`${tools} tool(s) on the register`);
  if (openPos > 0) out.push(`${openPos} purchase order(s) not yet landed or closed`);
  return out;
}

/**
 * Delete a truck outright — only when nothing in the books ever pointed at it.
 * A truck with history keeps its rows and is retired instead (Kyle, 2026-09-10).
 */
trucksRouter.delete("/trucks/:id", asyncHandler(async (req, res) => {
  const id = readParam(req, "id");
  const truck = await prisma.truck.findUnique({ where: { id }, select: { id: true, name: true } });
  if (!truck) { res.status(404).json({ error: "Truck not found" }); return; }
  const key = `truck:${id}`;
  const [pos, spend, movements, levels, tools, requests] = await Promise.all([
    prisma.purchaseOrder.count({ where: { truckId: id } }),
    prisma.cardSpend.count({ where: { truckId: id } }),
    prisma.stockMovement.count({ where: { OR: [{ fromLocationKey: key }, { toLocationKey: key }] } }),
    prisma.stockLevel.count({ where: { locationKey: key } }),
    prisma.tool.count({ where: { locationKey: key } }),
    prisma.stockRequest.count({ where: { truckId: id } }),
  ]);
  const history: string[] = [];
  if (pos) history.push(`${pos} purchase order(s)`);
  if (spend) history.push(`${spend} card transaction(s)`);
  if (movements) history.push(`${movements} stock movement(s)`);
  if (levels) history.push(`${levels} stock level(s)`);
  if (tools) history.push(`${tools} tool(s)`);
  if (requests) history.push(`${requests} restock request(s)`);
  if (history.length > 0) {
    res.status(409).json({ error: `${truck.name} has history (${history.join(", ")}) — retire it instead so the books keep pointing at it.`, history });
    return;
  }
  const active = await prisma.truck.count({ where: { isActive: true, id: { not: id } } });
  if (active === 0) { res.status(409).json({ error: "That is the only active truck. Add the replacement first." }); return; }
  await prisma.truck.delete({ where: { id } });
  res.status(204).end();
}));

/** The ledger: this year's card spend grouped by kind, the truck's POs, and its balance. */
trucksRouter.get("/trucks/:id", asyncHandler(async (req, res) => {
  const id = readParam(req, "id");
  const year = yearOf(req.query.year);
  const from = new Date(`${year}-01-01`);
  const to = new Date(`${year + 1}-01-01`);
  const truck = await prisma.truck.findUnique({ where: { id }, select: TRUCK_SELECT });
  if (!truck) { res.status(404).json({ error: "Truck not found" }); return; }
  const [spend, orders, balances, inventory] = await Promise.all([
    prisma.cardSpend.findMany({
      where: { truckId: id, occurredAt: { gte: from, lt: to } },
      orderBy: { occurredAt: "desc" },
      include: CARD_SPEND_INCLUDE,
    }),
    prisma.purchaseOrder.findMany({
      where: { truckId: id, openedAt: { gte: from, lt: to } },
      orderBy: { openedAt: "desc" },
      take: 300,
      include: PO_LIST_INCLUDE,
    }),
    readBalances(),
    truckInventoryRollups(),
  ]);
  const rows = spend.map(serializeCardSpend);
  const byKind = CARD_SPEND_KINDS.map((kind) => {
    const mine = rows.filter((r) => r.kind === kind);
    const counted = mine.filter((r) => r.status !== "ignored");
    return { kind, total: Math.round(counted.reduce((s, r) => s + r.amount, 0) * 100) / 100, rows: mine };
  });
  const fa = truck.stripeFinancialAccountId ? balances.financialAccounts.find((f) => f.id === truck.stripeFinancialAccountId) ?? null : null;
  res.json({
    truck,
    year,
    ledger: byKind,
    needingReceipt: rows.filter((r) => r.kind === "materials" && r.status === "unmatched" && !r.receiptId && r.amount > 0),
    purchaseOrders: orders.map(serializePurchaseOrder),
    balance: fa ? { cashUsd: fa.cashUsd, inboundPending: fa.inboundPending, outboundPending: fa.outboundPending, status: fa.status } : null,
    balancesAvailable: balances.available,
    balancesReason: balances.reason ?? null,
    stockValue: inventory.get(id)?.stockValue ?? 0,
    toolCount: inventory.get(id)?.toolCount ?? 0,
  });
}));

// ── Card spend ───────────────────────────────────────────────────────────────

trucksRouter.get("/card-spend", asyncHandler(async (req, res) => {
  const q = z.object({
    status: z.enum(["unmatched", "matched", "ignored"]).optional(),
    kind: z.enum(CARD_SPEND_KINDS).optional(),
    truckId: z.string().optional(),
    year: z.string().optional(),
  }).parse(req.query);
  const year = q.year ? yearOf(q.year) : null;
  const rows = await prisma.cardSpend.findMany({
    where: {
      ...(q.status ? { status: q.status } : {}),
      ...(q.kind ? { kind: q.kind } : {}),
      ...(q.truckId ? { truckId: q.truckId === "none" ? null : q.truckId } : {}),
      ...(year ? { occurredAt: { gte: new Date(`${year}-01-01`), lt: new Date(`${year + 1}-01-01`) } } : {}),
    },
    orderBy: { occurredAt: "desc" },
    take: 500,
    include: CARD_SPEND_INCLUDE,
  });
  res.json(rows.map(serializeCardSpend));
}));

/** Reason required (Kyle: "everything editable with a one-line reason and a trail"). */
trucksRouter.patch("/card-spend/:id", asyncHandler(async (req, res) => {
  const body = z.object({
    reason: reasonSchema,
    kind: z.enum(CARD_SPEND_KINDS).optional(),
    truckId: z.string().nullable().optional(),
    purchaseOrderId: z.string().nullable().optional(),
    receiptId: z.string().nullable().optional(),
    status: z.enum(["ignored", "unmatched"]).optional(),
  }).parse(req.body);
  const { reason, ...patch } = body;
  const id = readParam(req, "id");
  await updateCardSpend(id, patch, { actor: "owner", reason });
  const full = await prisma.cardSpend.findUniqueOrThrow({ where: { id }, include: CARD_SPEND_INCLUDE });
  res.json(serializeCardSpend(full));
}));

/**
 * Receipts that could itemize this spend, for the "Attach receipt" picker:
 * no card match yet, a category this kind can have, within two weeks of the
 * swipe, closest amount first. Any status — a photo waiting for review still
 * proves the purchase.
 */
trucksRouter.get("/card-spend/:id/receipt-candidates", asyncHandler(async (req, res) => {
  const spend = await prisma.cardSpend.findUnique({ where: { id: readParam(req, "id") } });
  if (!spend) { res.status(404).json({ error: "Card transaction not found" }); return; }
  const day = 24 * 60 * 60 * 1000;
  const receipts = await prisma.receipt.findMany({
    where: {
      cardSpend: null,
      category: { in: receiptCategoriesFor(spend.kind) },
      receivedAt: { gte: new Date(spend.occurredAt.getTime() - 14 * day), lte: new Date(spend.occurredAt.getTime() + 14 * day) },
    },
    select: {
      id: true, vendor: true, amount: true, category: true, status: true, receivedAt: true, jobId: true, imageMime: true,
      purchaseOrderId: true, purchaseOrder: { select: { number: true } },
    },
    take: 100,
  });
  res.json(
    receipts
      .sort((a, b) => Math.abs(a.amount - spend.amount) - Math.abs(b.amount - spend.amount))
      .slice(0, 25)
      .map((r) => ({
        id: r.id, vendor: r.vendor, amount: r.amount, category: r.category, status: r.status, receivedAt: r.receivedAt,
        jobId: r.jobId, purchaseOrderId: r.purchaseOrderId, purchaseOrderNumber: r.purchaseOrder?.number ?? null,
        hasImage: Boolean(r.imageMime), exact: Math.abs(r.amount - spend.amount) <= 0.01,
      })),
  );
}));

trucksRouter.post("/card-spend/sync", asyncHandler(async (req, res) => {
  const body = z.object({ days: z.number().int().positive().max(365).default(30) }).parse(req.body ?? {});
  // Kyle, 2026-09-10: the ••••3805 card is issued by the Financial Account, not
  // classic Issuing — syncCardSpend reads the v2 money-management feed first and
  // only asks Issuing while this account still has it.
  const result = await syncCardSpend(body.days);
  if (!result.available) { res.json(result); return; }
  const { transactions: _rows, feeds: _feeds, ...counts } = result;
  res.json(counts);
}));
