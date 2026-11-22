/**
 * The material database (2026-09-12, barcode/materials plan Unit 2). Server-side only — no UI
 * yet (Unit 6) and no barcode scanning yet (Unit 3). Mounted behind the operator session like
 * inventoryRouter. See src/services/materials.ts for the three-layer design (Material vs.
 * PriceBookAtomic vs. Assembly) and derived completion.
 */

import express from "express";
import { z } from "zod";
import { asyncHandler, readParam } from "../lib/routeHelpers";
import { prisma } from "../lib/prisma";
import { givesCostOrHours, hasKylePower, requireKylePower } from "../middleware/kylePowers";
import {
  createMaterial, linkMaterial, listMaterials, listUnassignedMaterials, promoteMaterial, updateMaterial,
} from "../services/materials";

export const materialsRouter = express.Router();

const nullableString = (max: number) => z.string().trim().min(1).max(max).nullable().optional();
const nullableNumber = z.number().nullable().optional();

const createSchema = z.object({
  upc: nullableString(64),
  sku: nullableString(64),
  supplier: nullableString(120),
  description: nullableString(500),
  packQty: nullableNumber,
  packUnit: nullableString(20),
  lastCost: nullableNumber,
  symbology: nullableString(40),
  itemId: nullableString(40),
});

const patchSchema = createSchema.partial();

// ── The list, and the actionable subset ─────────────────────────────────────

materialsRouter.get("/materials", asyncHandler(async (_req, res) => {
  res.json(await listMaterials(prisma));
}));

materialsRouter.get("/materials/unassigned", asyncHandler(async (_req, res) => {
  res.json(await listUnassignedMaterials(prisma));
}));

// ── Create / edit ────────────────────────────────────────────────────────────

materialsRouter.post("/materials", asyncHandler(async (req, res) => {
  const body = createSchema.parse(req.body);
  const result = await createMaterial(prisma, body);
  if (!result.ok) return res.status(409).json({ error: result.reason });
  res.status(201).json(result.material);
}));

materialsRouter.patch("/materials/:id", asyncHandler(async (req, res) => {
  const body = patchSchema.parse(req.body);
  const result = await updateMaterial(prisma, readParam(req, "id"), body);
  if (!result.ok) return res.status(409).json({ error: result.reason });
  res.json(result.material);
}));

// ── The two ways to complete a material ─────────────────────────────────────

materialsRouter.post("/materials/:id/link", asyncHandler(async (req, res) => {
  const body = z.object({ itemId: z.string().trim().min(1) }).parse(req.body);
  const result = await linkMaterial(prisma, readParam(req, "id"), body.itemId);
  if (!result.ok) return res.status(409).json({ error: result.reason });
  res.json(result.material);
}));

// Promoting creates a price-book item, so a cost or hours typed here is a Kyle-only price edit (HA3),
// exactly as on POST /price-book/catalog/items. A cost DERIVED from the material's lastCost/packQty is
// the same thing: lastCost is typed on the ungated POST /materials and PATCH /materials/:id, so it is
// derived only for a caller who holds price_book_edit; anyone else's promote creates the item with
// a null cost.
materialsRouter.post("/materials/:id/promote", requireKylePower("price_book_edit", givesCostOrHours), asyncHandler(async (req, res) => {
  const body = z.object({
    description: z.string().trim().min(1),
    category: z.string().trim().min(1),
    subCategory: nullableString(120),
    unitLabel: nullableString(20),
    sector: nullableString(60),
    rowType: z.string().trim().min(1),
    laborNormal: nullableNumber,
    laborDifficult: nullableNumber,
    laborVeryDifficult: nullableNumber,
    notes: nullableString(2000),
    itemId: nullableString(40),
    idPrefix: nullableString(10),
    companyCost: nullableNumber,
  }).parse(req.body);
  const result = await promoteMaterial(prisma, readParam(req, "id"), body, "owner", hasKylePower(req, "price_book_edit"));
  if (!result.ok) return res.status(409).json({ error: result.reason });
  res.status(201).json({ material: result.material, atomic: result.atomic });
}));
