/**
 * The material database (2026-09-12, barcode/materials plan Unit 2).
 *
 * THREE LAYERS, NOT TWO — see the schema comment on `Material` for the full picture. A Material is
 * a purchasable PRODUCT as a supplier sells it ("Leviton 5320-W, 10-pack, UPC 078477123456, $11.97
 * a pack") and carries NO labour. `PriceBookAtomic` is the estimating unit ("Duplex receptacle,
 * each, 0.25 hrs"). Kyle, verbatim: "when I scan a new item it still needs assigned labor units" —
 * a scan gives a price and a pack size, never labour, so a material is not quotable until it is
 * LINKED to an atomic that already carries labour, or PROMOTED into a brand new one.
 *
 * COMPLETION IS DERIVED, NEVER STORED. Computed fresh from the material row and its linked
 * atomic's live labour every time — a stored flag would drift the moment the atomic's labour was
 * edited. `materialCompletion` names WHICH part is missing (no link / no labour / no cost) because
 * "this one is incomplete" is not actionable on its own.
 *
 * PACK SIZE DOES TWO CONVERSIONS, both required (Kyle: "the system will still know what one unit
 * costs... and the overall inventory stock can be updated"):
 *   1. Cost:  package price ÷ packQty = the per-unit cost comparable to the book's per-each/
 *      per-foot figure (`perUnitCostFromPack`).
 *   2. Stock: buying `n` packs of `packQty` raises StockLevel.qtyOnHand by packQty × n, not n — the
 *      ledger counts units, not packages (`stockQtyFromPacks`). Wiring this into the actual
 *      purchase flow is Unit 3; this function is the tested primitive it will call.
 *
 * GUARD, CARRIED FROM UNIT 1: an assembly (`rowType = "ASSEMBLY"`) is not a purchasable thing and
 * must never be the target of a material link or promotion. Link and update both run
 * `assertNotAssembly()` (priceBookAssembly.ts) before touching `itemId`. Promotion is safe by
 * construction: it always goes through `createAtomic`, which already refuses `rowType: "ASSEMBLY"`
 * at creation (Unit 1 guard) — so a promoted material can never create an assembly row.
 */

import { Prisma, type Material, type PrismaClient } from "@prisma/client";
import { assertNotAssembly, AssemblyGuardError } from "./priceBookAssembly";
import { createAtomic, type CreateAtomicInput } from "./priceBookCatalog";

const round2 = (n: number) => Math.round(n * 100) / 100;

// ─── Pack-size conversions ──────────────────────────────────────────────────────────────────

/**
 * Conversion 1 — COST. package price ÷ packQty = the per-unit cost, comparable to the price
 * book's per-each/per-foot `companyCost`. Throws on a non-positive packQty rather than dividing
 * by zero or silently producing a negative/undefined per-unit figure.
 */
export function perUnitCostFromPack(packPrice: number, packQty: number): number {
  if (!(packQty > 0)) throw new Error("packQty must be a positive number to convert a pack price to a per-unit cost.");
  return round2(packPrice / packQty);
}

/**
 * Conversion 2 — STOCK. Buying `packsPurchased` packs of `packQty` each raises
 * `StockLevel.qtyOnHand` by `packQty × packsPurchased`, never by `packsPurchased` alone — the
 * ledger counts units, not packages. Wiring this into the purchase flow (calling
 * `services/inventory.ts` `applyMovement` with the returned quantity) is Unit 3's job; this is the
 * tested conversion it will call.
 */
export function stockQtyFromPacks(packQty: number, packsPurchased: number): number {
  if (!(packQty > 0)) throw new Error("packQty must be a positive number to convert to a stock quantity.");
  if (!(packsPurchased > 0)) throw new Error("packsPurchased must be a positive number.");
  return packQty * packsPurchased;
}

// ─── Derived completion ─────────────────────────────────────────────────────────────────────

export type MaterialCompletionReason = "no_link" | "no_labor" | "no_cost";

export interface MaterialCompletion {
  assigned: boolean;
  /** Every reason the material is unassigned, empty when `assigned` is true. */
  missing: MaterialCompletionReason[];
}

interface AtomicLaborFacts {
  laborNormal: number | null;
  laborDifficult: number | null;
  laborVeryDifficult: number | null;
}

/** True when the atomic publishes labour on at least one tier. A fully-null atomic (e.g. an
 * unresolved NECA row) supplies no labour at all, same as having no link. */
function atomicHasLabor(atomic: AtomicLaborFacts | null): boolean {
  if (!atomic) return false;
  return atomic.laborNormal !== null || atomic.laborDifficult !== null || atomic.laborVeryDifficult !== null;
}

/**
 * Derive completion from live facts — never read a stored flag. `linkedAtomic` is the atomic
 * named by `material.itemId`, already fetched by the caller (null when there is no link, or the
 * link is stale/unknown).
 */
export function materialCompletion(
  material: { itemId: string | null; lastCost: number | null },
  linkedAtomic: AtomicLaborFacts | null,
): MaterialCompletion {
  const missing: MaterialCompletionReason[] = [];
  if (!material.itemId) missing.push("no_link");
  else if (!atomicHasLabor(linkedAtomic)) missing.push("no_labor");
  if (material.lastCost === null || material.lastCost === undefined) missing.push("no_cost");
  return { assigned: missing.length === 0, missing };
}

export interface MaterialWithCompletion {
  material: Material;
  completion: MaterialCompletion;
}

/** One material's completion, fetching its linked atomic's labour live. */
export async function getMaterialCompletion(prisma: PrismaClient, material: Material): Promise<MaterialCompletion> {
  let atomic: AtomicLaborFacts | null = null;
  if (material.itemId) {
    atomic = await prisma.priceBookAtomic.findUnique({
      where: { itemId: material.itemId },
      select: { laborNormal: true, laborDifficult: true, laborVeryDifficult: true },
    });
  }
  return materialCompletion(material, atomic);
}

/** Every material with its derived completion, one batched lookup for all linked atomics. */
export async function listMaterials(prisma: PrismaClient): Promise<MaterialWithCompletion[]> {
  const materials = await prisma.material.findMany({ orderBy: { lastSeenAt: "desc" } });
  const itemIds = [...new Set(materials.map((m) => m.itemId).filter((id): id is string => id !== null))];
  const atomics = itemIds.length
    ? await prisma.priceBookAtomic.findMany({
        where: { itemId: { in: itemIds } },
        select: { itemId: true, laborNormal: true, laborDifficult: true, laborVeryDifficult: true },
      })
    : [];
  const atomicById = new Map(atomics.map((a) => [a.itemId, a]));
  return materials.map((material) => ({
    material,
    completion: materialCompletion(material, material.itemId ? (atomicById.get(material.itemId) ?? null) : null),
  }));
}

/** Just the incomplete ones — the actionable worklist, each tagged with what is missing. */
export async function listUnassignedMaterials(prisma: PrismaClient): Promise<MaterialWithCompletion[]> {
  return (await listMaterials(prisma)).filter((m) => !m.completion.assigned);
}

// ─── Unique-constraint reporting ────────────────────────────────────────────────────────────

/** Translate a P2002 into a reason naming which identifier collided; rethrows anything else. */
function explainUniqueViolation(err: unknown): string {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
    const target = (err.meta?.target as string[] | undefined) ?? [];
    if (target.includes("upc")) return "A material with this UPC already exists — UPC identifies the same product no matter where it was bought.";
    if (target.includes("supplier") && target.includes("sku")) {
      return "This supplier already has a material with this SKU.";
    }
    return "A material with these identifiers already exists.";
  }
  throw err;
}

// ─── CRUD ───────────────────────────────────────────────────────────────────────────────────

export interface CreateMaterialInput {
  upc?: string | null;
  sku?: string | null;
  supplier?: string | null;
  description?: string | null;
  packQty?: number | null;
  packUnit?: string | null;
  lastCost?: number | null;
  symbology?: string | null;
  itemId?: string | null;
}

/** Runs the assembly guard when `itemId` is present; returns its reason on failure rather than throwing. */
async function guardItemId(prisma: PrismaClient, itemId: string | null | undefined): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!itemId) return { ok: true };
  try {
    await assertNotAssembly(prisma, itemId, "be linked to a material");
    return { ok: true };
  } catch (err) {
    if (err instanceof AssemblyGuardError) return { ok: false, reason: err.message };
    throw err;
  }
}

export async function createMaterial(
  prisma: PrismaClient,
  input: CreateMaterialInput,
): Promise<{ ok: true; material: Material } | { ok: false; reason: string }> {
  const guard = await guardItemId(prisma, input.itemId);
  if (!guard.ok) return guard;
  try {
    const material = await prisma.material.create({
      data: {
        upc: input.upc ?? null,
        sku: input.sku ?? null,
        supplier: input.supplier ?? null,
        description: input.description ?? null,
        packQty: input.packQty ?? null,
        packUnit: input.packUnit ?? null,
        lastCost: input.lastCost ?? null,
        symbology: input.symbology ?? null,
        itemId: input.itemId ?? null,
      },
    });
    return { ok: true, material };
  } catch (err) {
    return { ok: false, reason: explainUniqueViolation(err) };
  }
}

export type MaterialPatch = Partial<{
  upc: string | null;
  sku: string | null;
  supplier: string | null;
  description: string | null;
  packQty: number | null;
  packUnit: string | null;
  lastCost: number | null;
  symbology: string | null;
  itemId: string | null;
}>;

export async function updateMaterial(
  prisma: PrismaClient,
  id: string,
  patch: MaterialPatch,
): Promise<{ ok: true; material: Material } | { ok: false; reason: string }> {
  const existing = await prisma.material.findUnique({ where: { id } });
  if (!existing) return { ok: false, reason: `Material ${id} not found.` };
  if ("itemId" in patch) {
    const guard = await guardItemId(prisma, patch.itemId);
    if (!guard.ok) return guard;
  }
  try {
    const material = await prisma.material.update({ where: { id }, data: patch });
    return { ok: true, material };
  } catch (err) {
    return { ok: false, reason: explainUniqueViolation(err) };
  }
}

// ─── The two ways to complete a material ───────────────────────────────────────────────────

/** LINK — join an existing price book item (e.g. the 10-pack joins the atomic that already has
 * 0.25 hrs). Refuses an unknown itemId and, via the shared guard, an assembly itemId. */
export async function linkMaterial(
  prisma: PrismaClient,
  id: string,
  itemId: string,
): Promise<{ ok: true; material: Material } | { ok: false; reason: string }> {
  const atomic = await prisma.priceBookAtomic.findUnique({ where: { itemId }, select: { itemId: true } });
  if (!atomic) return { ok: false, reason: `Item ${itemId} not found.` };
  return updateMaterial(prisma, id, { itemId });
}

export interface PromoteMaterialInput {
  description: string;
  category: string;
  subCategory?: string | null;
  unitLabel?: string | null;
  sector?: string | null;
  rowType: string;
  laborNormal?: number | null;
  laborDifficult?: number | null;
  laborVeryDifficult?: number | null;
  notes?: string | null;
  itemId?: string | null; // explicit new atomic id, or auto-numbered when absent
  idPrefix?: string | null;
  /** Explicit override for the new atomic's companyCost. When omitted, it is derived from the
   * material's own lastCost/packQty via `perUnitCostFromPack` (when both are set). */
  companyCost?: number | null;
}

/** PROMOTE — create a brand new price book item for a material with no counterpart in the book.
 * Reuses `createAtomic` (services/priceBookCatalog.ts) rather than a second creation path;
 * `createAtomic` itself refuses `rowType: "ASSEMBLY"`, so a promoted material can never become an
 * assembly. */
export async function promoteMaterial(
  prisma: PrismaClient,
  id: string,
  input: PromoteMaterialInput,
  editedBy: string,
): Promise<{ ok: true; material: Material; atomic: unknown } | { ok: false; reason: string }> {
  const material = await prisma.material.findUnique({ where: { id } });
  if (!material) return { ok: false, reason: `Material ${id} not found.` };
  if (material.itemId) return { ok: false, reason: `Material ${id} is already linked to ${material.itemId}. Unlink it before promoting.` };

  let companyCost = input.companyCost ?? null;
  if (companyCost === null && material.lastCost !== null && material.packQty !== null) {
    companyCost = perUnitCostFromPack(material.lastCost, material.packQty);
  }

  const createInput: CreateAtomicInput = {
    itemId: input.itemId ?? null,
    idPrefix: input.idPrefix ?? null,
    description: input.description,
    category: input.category,
    subCategory: input.subCategory ?? null,
    unitLabel: input.unitLabel ?? null,
    sector: input.sector ?? null,
    rowType: input.rowType,
    companyCost,
    laborNormal: input.laborNormal ?? null,
    laborDifficult: input.laborDifficult ?? null,
    laborVeryDifficult: input.laborVeryDifficult ?? null,
    notes: input.notes ?? null,
  };
  const created = await createAtomic(prisma, createInput, editedBy);
  if (!created.ok) return created;

  const newItemId = (created.atomic as { itemId: string }).itemId;
  const updated = await prisma.material.update({ where: { id }, data: { itemId: newItemId } });
  return { ok: true, material: updated, atomic: created.atomic };
}
