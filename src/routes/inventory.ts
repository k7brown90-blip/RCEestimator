/**
 * Inventory, landing, tools, restock requests (Kyle, 2026-09-09, Build 3).
 *
 * "We need an inventory tab that tracks what is on the truck and what is at
 * the warehouse." Mounted behind the operator session like trucksRouter.
 * Every quantity and cost is correctable with a one-line reason and a trail —
 * the ledger is append-only (services/inventory.ts). Nothing here charges a
 * job; that is Build 4.
 */

import express from "express";
import { z } from "zod";
import { asyncHandler, readParam } from "./agent-helpers";
import {
  TOOL_CONDITIONS, WAREHOUSE_KEY, correctMovement, countStock, createStockRequest, createTool, declineStockRequest, fulfillStockRequest,
  inventoryOverview, landPurchaseOrder, landingDefaults, listMovements, listStockRequests, listTools, moveTool, searchItems, setParLevel,
  toolDetail, transferStock, truckLocationKey, updateTool,
} from "../services/inventory";

export const inventoryRouter = express.Router();

const reasonSchema = z.string().trim().min(1, "A reason is required").max(300);
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();
const locationKeySchema = z.string().trim().min(1).max(80);

// ── The picture ──────────────────────────────────────────────────────────────

inventoryRouter.get("/inventory", asyncHandler(async (_req, res) => {
  res.json(await inventoryOverview());
}));

inventoryRouter.get("/inventory/movements", asyncHandler(async (req, res) => {
  const q = z.object({
    itemId: z.string().optional(),
    locationKey: z.string().optional(),
    purchaseOrderId: z.string().optional(),
    limit: z.coerce.number().int().positive().max(500).optional(),
  }).parse(req.query);
  res.json(await listMovements(q));
}));

/** The book, picker-shaped — itemId / description / unit / last purchase price. */
inventoryRouter.get("/inventory/items", asyncHandler(async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q : "";
  res.json(await searchItems(q, 25));
}));

// ── Movements ────────────────────────────────────────────────────────────────

/** Warehouse → truck. FROM IS ALWAYS THE WAREHOUSE (Kyle's rule); the body names only the truck. */
inventoryRouter.post("/inventory/transfer", asyncHandler(async (req, res) => {
  const body = z.object({
    itemId: z.string().trim().min(1),
    qty: z.number().positive(),
    toTruckId: z.string().trim().min(1),
    reason: optionalText(300),
  }).parse(req.body);
  const movement = await transferStock({
    itemId: body.itemId, qty: body.qty, fromLocationKey: WAREHOUSE_KEY, toLocationKey: truckLocationKey(body.toTruckId),
    reason: body.reason ?? null, actor: "owner",
  });
  res.status(201).json(movement);
}));

/** A physical count at one location — reason required, one movement per line. */
inventoryRouter.post("/inventory/count", asyncHandler(async (req, res) => {
  const body = z.object({
    locationKey: locationKeySchema,
    reason: reasonSchema,
    lines: z.array(z.object({
      itemId: z.string().trim().min(1).max(80),
      name: optionalText(300),
      unit: optionalText(20),
      qty: z.number().nonnegative(),
      unitCost: z.number().nonnegative().nullable().optional(),
    })).min(1),
  }).parse(req.body);
  const movements = await countStock({ locationKey: body.locationKey, lines: body.lines, reason: body.reason, actor: "owner" });
  res.status(201).json(movements);
}));

/** A correction is a new movement that references the one it corrects. Reason required (400 without). */
inventoryRouter.post("/inventory/correction", asyncHandler(async (req, res) => {
  const body = z.object({
    correctsId: z.string().trim().min(1),
    delta: z.number(),
    unitCost: z.number().nonnegative().nullable().optional(),
    reason: z.string().trim().max(300).optional(),
  }).parse(req.body);
  if (!body.reason) { res.status(400).json({ error: "A reason is required for a correction." }); return; }
  const movement = await correctMovement({ correctsId: body.correctsId, delta: body.delta, unitCost: body.unitCost ?? null, reason: body.reason, actor: "owner" });
  res.status(201).json(movement);
}));

inventoryRouter.patch("/inventory/levels/:id", asyncHandler(async (req, res) => {
  const body = z.object({ parLevel: z.number().nonnegative().nullable() }).parse(req.body);
  res.json(await setParLevel(readParam(req, "id"), body.parLevel));
}));

// ── Landing a PO ─────────────────────────────────────────────────────────────

inventoryRouter.get("/purchase-orders/:id/landing", asyncHandler(async (req, res) => {
  res.json(await landingDefaults(readParam(req, "id")));
}));

inventoryRouter.post("/purchase-orders/:id/land", asyncHandler(async (req, res) => {
  const body = z.object({
    lines: z.array(z.object({ lineId: z.string().trim().min(1), qtyLanded: z.number().nonnegative(), unitCost: z.number().nonnegative() })),
    reason: optionalText(300),
  }).parse(req.body);
  const result = await landPurchaseOrder(readParam(req, "id"), body.lines, "owner", body.reason ?? null);
  res.json({ id: result.purchaseOrder.id, number: result.purchaseOrder.number, status: result.purchaseOrder.status, landedAt: result.purchaseOrder.landedAt, destination: result.destination, lines: result.lines });
}));

// ── Tools ────────────────────────────────────────────────────────────────────

inventoryRouter.get("/tools", asyncHandler(async (req, res) => {
  const locationKey = typeof req.query.locationKey === "string" && req.query.locationKey ? req.query.locationKey : undefined;
  res.json(await listTools({ locationKey }));
}));

inventoryRouter.post("/tools", asyncHandler(async (req, res) => {
  const body = z.object({
    name: z.string().trim().min(1).max(200),
    serial: optionalText(100),
    cost: z.number().nonnegative().nullable().optional(),
    locationKey: locationKeySchema,
    notes: optionalText(1000),
  }).parse(req.body);
  res.status(201).json(await createTool(body, "owner"));
}));

inventoryRouter.get("/tools/:id", asyncHandler(async (req, res) => {
  res.json(await toolDetail(readParam(req, "id")));
}));

inventoryRouter.patch("/tools/:id", asyncHandler(async (req, res) => {
  const body = z.object({
    reason: reasonSchema,
    name: z.string().trim().min(1).max(200).optional(),
    serial: optionalText(100),
    cost: z.number().nonnegative().nullable().optional(),
    condition: z.enum(TOOL_CONDITIONS).optional(),
    notes: optionalText(1000),
  }).parse(req.body);
  const { reason, ...patch } = body;
  res.json(await updateTool(readParam(req, "id"), patch, { actor: "owner", reason }));
}));

inventoryRouter.post("/tools/:id/move", asyncHandler(async (req, res) => {
  const body = z.object({ toLocationKey: locationKeySchema, reason: optionalText(300) }).parse(req.body);
  res.json(await moveTool(readParam(req, "id"), body.toLocationKey, { actor: "owner", reason: body.reason ?? null }));
}));

// ── Restock requests ─────────────────────────────────────────────────────────

inventoryRouter.get("/inventory/requests", asyncHandler(async (req, res) => {
  const status = typeof req.query.status === "string" && req.query.status ? req.query.status : undefined;
  res.json(await listStockRequests(status));
}));

/** The office can raise one too (a tech asked by phone). */
inventoryRouter.post("/inventory/requests", asyncHandler(async (req, res) => {
  const body = z.object({
    truckId: z.string().trim().min(1),
    itemId: optionalText(80),
    name: z.string().trim().min(1).max(300),
    qty: z.number().positive(),
    unit: optionalText(20),
    note: optionalText(500),
  }).parse(req.body);
  res.status(201).json(await createStockRequest(body));
}));

inventoryRouter.post("/inventory/requests/:id/fulfill", asyncHandler(async (req, res) => {
  const body = z.object({ itemId: optionalText(80) }).parse(req.body ?? {});
  res.json(await fulfillStockRequest(readParam(req, "id"), { actor: "owner", itemId: body.itemId ?? null }));
}));

inventoryRouter.post("/inventory/requests/:id/decline", asyncHandler(async (req, res) => {
  const body = z.object({ reason: z.string().trim().max(300).optional() }).parse(req.body ?? {});
  if (!body.reason) { res.status(400).json({ error: "A reason is required to decline a request." }); return; }
  res.json(await declineStockRequest(readParam(req, "id"), { actor: "owner", reason: body.reason }));
}));
