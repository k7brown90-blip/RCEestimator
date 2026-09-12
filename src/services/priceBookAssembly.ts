/**
 * "Create assembly" (2026-09-12, barcode/materials plan Unit 1).
 *
 * Kyle builds sellable products by hand — "Hardwired EV Charger" = breaker + raceway + wire +
 * labour. One line on the estimate; the full material list retained underneath for shopping and
 * purchase orders.
 *
 * THE CORE DECISION, ALREADY MADE: an assembly IS a `PriceBookAtomic` row, `rowType =
 * "ASSEMBLY"`, not a `PriceBookAssembly`. See the comment at PriceBookAtomic.assemblyItems in
 * schema.prisma for why — `PriceBookDraftLine.itemId` / `IssuedEstimateLine.itemId` are FKs to
 * PriceBookAtomic and nowhere else. This module is the only writer of
 * `PriceBookItemComponent` and the only place an assembly's derived cost/labour are computed.
 *
 * THE TRAP THIS FILE EXISTS TO AVOID: summing component `companyPrice` (already marked up)
 * instead of `companyCost`. That silently double-marks-up every assembly and the bug is
 * invisible in code — it only shows up as quotes that are quietly too high. Every rollup below
 * reads `companyCost` and nothing else for the cost side.
 *
 * LABOUR: Σ(component labour × component quantity) per tier, independently — normals to
 * normal, difficults to difficult, very-difficults to very-difficult — using the same
 * qty×value/divisor arithmetic `laborHoursFor` uses elsewhere (atomicEstimateEngine.ts), because
 * an in-app component's hours are per-unit (E, divisor 1) but nothing stops a workbook-sourced
 * component (C or M basis) from being attached too. A component with a null labour value for a
 * tier, OR a null unit-basis divisor, makes THAT TIER incomplete for the whole assembly — it is
 * never summed as zero (schema: "a blank labour cell... is a finding, not a zero").
 *
 * OVERRIDES: Kyle can overwrite any tier. Stored as its own explicit boolean flag
 * (laborNormalOverridden etc.) — never inferred by comparing the stored value to the computed
 * sum, because an override that happens to equal the sum would then look "auto" again and
 * silently resume tracking a component change later.
 */

import type { PrismaClient } from "@prisma/client";
import { computePricing, loadPricingContext, resolveNewItemId } from "./priceBookCatalog";

export const ASSEMBLY_ROW_TYPE = "ASSEMBLY";

export const LABOR_TIERS = ["laborNormal", "laborDifficult", "laborVeryDifficult"] as const;
export type LaborTier = (typeof LABOR_TIERS)[number];

const OVERRIDE_FIELD: Record<LaborTier, "laborNormalOverridden" | "laborDifficultOverridden" | "laborVeryDifficultOverridden"> = {
  laborNormal: "laborNormalOverridden",
  laborDifficult: "laborDifficultOverridden",
  laborVeryDifficult: "laborVeryDifficultOverridden",
};

const round2 = (n: number) => Math.round(n * 100) / 100;
const round4 = (n: number) => Math.round(n * 10000) / 10000;

export function isAssemblyRowType(rowType: string | null | undefined): boolean {
  return (rowType ?? "").toUpperCase() === ASSEMBLY_ROW_TYPE;
}

// ─── Guards — an assembly is not a purchasable thing ───────────────────────────────────────
//
// It shares an ID space with real materials, so every path that assumes a real product must be
// kept from ever resolving one. Wired in:
//   - StockLevel     — src/services/inventory.ts applyMovement(), the ONE writer of StockLevel.
//   - PriceBookSupplierPrice — scripts/price-book/importPriceBook.ts, the workbook import lane.
// NOT YET WIRED (belong to units not yet built — noted here so they are not forgotten):
//   - MaterialBarcode / UPC mapping (Unit 2).
//   - The monthly supplier-price refresh (Unit 5) must skip rowType = "ASSEMBLY" rows.

export class AssemblyGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssemblyGuardError";
  }
}

/**
 * Minimal shape the guard needs — deliberately narrower than `PrismaClient` so it accepts a
 * `Prisma.TransactionClient` too (inventory.ts calls it from inside applyMovement's transaction).
 */
type AtomicLookup = {
  priceBookAtomic: {
    findUnique(args: { where: { itemId: string }; select: { rowType: true } }): Promise<{ rowType: string | null } | null>;
  };
};

/** Throws if `itemId` names an ASSEMBLY row. Silent (no throw) for a real material or an unknown id. */
export async function assertNotAssembly(
  prisma: AtomicLookup,
  itemId: string,
  context: string,
): Promise<void> {
  const row = await prisma.priceBookAtomic.findUnique({ where: { itemId }, select: { rowType: true } });
  if (row && isAssemblyRowType(row.rowType)) {
    throw new AssemblyGuardError(`${itemId} is an assembly, not a purchasable item — it cannot ${context}.`);
  }
}

// ─── Rollup ─────────────────────────────────────────────────────────────────────────────────

export interface ComponentAtomicFacts {
  itemId: string;
  description: string | null;
  rowType: string | null;
  companyCost: number | null;
  laborNormal: number | null;
  laborDifficult: number | null;
  laborVeryDifficult: number | null;
  laborUnitDivisor: number | null;
}

export interface ComponentInput {
  childItemId: string;
  quantity: number;
}

export interface TierRollup {
  /** Null when incomplete — never a summed zero. */
  value: number | null;
  complete: boolean;
  /** Which components are missing a value (or a unit basis) for this tier. */
  missingItemIds: string[];
}

export interface ComponentRollup {
  companyCost: number | null;
  costComplete: boolean;
  unpricedComponentItemIds: string[];
  labor: Record<LaborTier, TierRollup>;
}

/**
 * The per-unit labour hours a single component contributes for one tier: qty × value / divisor
 * (laborHoursFor's own formula, atomicEstimateEngine.ts). Null when the tier's value is blank OR
 * the component's unit basis is unverified — both are gaps, not zero.
 */
function componentTierHours(atomic: ComponentAtomicFacts, quantity: number, tier: LaborTier): number | null {
  const value = atomic[tier];
  if (value === null || value === undefined) return null;
  if (atomic.laborUnitDivisor === null || atomic.laborUnitDivisor === undefined || atomic.laborUnitDivisor <= 0) return null;
  return (quantity * value) / atomic.laborUnitDivisor;
}

/**
 * Sum components' companyCost × quantity (NEVER companyPrice — see file header) and labour per
 * tier. Pure function: caller supplies the already-fetched child rows so this stays unit
 * testable without a database.
 */
export function computeComponentRollup(
  components: ComponentInput[],
  childByItemId: Map<string, ComponentAtomicFacts>,
): ComponentRollup {
  let costSum = 0;
  let costComplete = true;
  const unpricedComponentItemIds: string[] = [];

  const labor = {} as Record<LaborTier, TierRollup>;
  for (const tier of LABOR_TIERS) {
    let sum = 0;
    let complete = true;
    const missingItemIds: string[] = [];
    for (const c of components) {
      const atomic = childByItemId.get(c.childItemId);
      if (!atomic) continue; // validated elsewhere; a rollup over an unknown child just can't complete
      const hours = componentTierHours(atomic, c.quantity, tier);
      if (hours === null) {
        complete = false;
        missingItemIds.push(c.childItemId);
      } else {
        sum += hours;
      }
    }
    labor[tier] = { value: complete ? round4(sum) : null, complete, missingItemIds };
  }

  for (const c of components) {
    const atomic = childByItemId.get(c.childItemId);
    if (!atomic || atomic.companyCost === null || atomic.companyCost === undefined) {
      costComplete = false;
      if (atomic) unpricedComponentItemIds.push(c.childItemId);
      continue;
    }
    costSum += atomic.companyCost * c.quantity;
  }

  return {
    companyCost: costComplete ? round2(costSum) : null,
    costComplete,
    unpricedComponentItemIds,
    labor,
  };
}

/** Fetch the child facts a rollup needs, keyed by itemId. */
async function fetchComponentFacts(prisma: PrismaClient, childItemIds: string[]): Promise<Map<string, ComponentAtomicFacts>> {
  const rows = await prisma.priceBookAtomic.findMany({
    where: { itemId: { in: childItemIds } },
    select: {
      itemId: true, description: true, rowType: true, companyCost: true,
      laborNormal: true, laborDifficult: true, laborVeryDifficult: true, laborUnitDivisor: true,
    },
  });
  return new Map(rows.map((r) => [r.itemId, r]));
}

/** Nesting rejection + existence check. Returns the fetched facts so the caller doesn't re-query. */
async function validateComponents(
  prisma: PrismaClient,
  parentItemId: string | null, // null while creating — the parent doesn't exist yet
  components: ComponentInput[],
): Promise<{ ok: true; facts: Map<string, ComponentAtomicFacts> } | { ok: false; reason: string }> {
  const seen = new Set<string>();
  for (const c of components) {
    if (!c.childItemId || !c.childItemId.trim()) return { ok: false, reason: "Every component needs an item." };
    if (!Number.isFinite(c.quantity) || c.quantity <= 0) return { ok: false, reason: `Component ${c.childItemId}: quantity must be a positive number.` };
    if (parentItemId && c.childItemId === parentItemId) return { ok: false, reason: "An assembly cannot contain itself." };
    if (seen.has(c.childItemId)) return { ok: false, reason: `Component ${c.childItemId} is attached twice — combine into one line.` };
    seen.add(c.childItemId);
  }
  if (components.length === 0) return { ok: true, facts: new Map() };

  const facts = await fetchComponentFacts(prisma, [...seen]);
  for (const c of components) {
    const atomic = facts.get(c.childItemId);
    if (!atomic) return { ok: false, reason: `Item ${c.childItemId} not found.` };
    // NO NESTING. Kyle: "the assembly is its own line item." Rejected at write time, not
    // merely hidden in the picker.
    if (isAssemblyRowType(atomic.rowType)) {
      return { ok: false, reason: `${c.childItemId} is itself an assembly — an assembly cannot contain another assembly. Compose them as two lines on the estimate instead.` };
    }
  }
  return { ok: true, facts };
}

// ─── Effective labour (auto or overridden) ─────────────────────────────────────────────────

export interface EffectiveLaborTier {
  value: number | null;
  overridden: boolean;
  /** Only present when overridden AND the live component total differs from the stored value. */
  driftFromComputed: number | null;
}

/** What an assembly's stored tier value means: Kyle's number (overridden) or the live rollup. */
export function effectiveLaborTier(
  storedValue: number | null,
  overridden: boolean,
  rollupValue: number | null,
): EffectiveLaborTier {
  if (!overridden) return { value: rollupValue, overridden: false, driftFromComputed: null };
  const drift =
    rollupValue === null || storedValue === null ? null : round4(storedValue - rollupValue);
  return { value: storedValue, overridden: true, driftFromComputed: drift !== null && Math.abs(drift) > 1e-6 ? drift : null };
}

// ─── Create ─────────────────────────────────────────────────────────────────────────────────

export interface CreateAssemblyInput {
  itemId?: string | null;
  idPrefix?: string | null;
  description: string;
  category: string;
  subCategory?: string | null;
  unitLabel?: string | null;
  notes?: string | null;
  components: ComponentInput[];
  /** Explicit tier overrides at creation. Absent tiers default to the auto-summed value. */
  laborOverrides?: Partial<Record<LaborTier, number>>;
}

export async function createAssembly(
  prisma: PrismaClient,
  input: CreateAssemblyInput,
  editedBy: string,
): Promise<{ ok: true; atomic: unknown } | { ok: false; reason: string }> {
  const validated = await validateComponents(prisma, null, input.components);
  if (!validated.ok) return validated;

  const resolvedId = await resolveNewItemId(prisma, input.itemId, input.idPrefix ?? "ASM");
  if (!resolvedId.ok) return resolvedId;
  const itemId = resolvedId.itemId;

  const rollup = computeComponentRollup(input.components, validated.facts);
  const laborData: Record<string, number | null | boolean> = {};
  for (const tier of LABOR_TIERS) {
    const override = input.laborOverrides?.[tier];
    if (override !== undefined && override !== null) {
      laborData[tier] = override;
      laborData[OVERRIDE_FIELD[tier]] = true;
    } else {
      laborData[tier] = rollup.labor[tier].value;
      laborData[OVERRIDE_FIELD[tier]] = false;
    }
  }

  const { tiers, rate } = await loadPricingContext(prisma);
  const computed = computePricing(
    {
      rowType: ASSEMBLY_ROW_TYPE,
      companyCost: rollup.companyCost,
      laborNormal: laborData.laborNormal as number | null,
      laborDifficult: laborData.laborDifficult as number | null,
      laborVeryDifficult: laborData.laborVeryDifficult as number | null,
    },
    tiers,
    rate,
  );

  const atomic = await prisma.$transaction(async (tx) => {
    const created = await tx.priceBookAtomic.create({
      data: {
        itemId,
        description: input.description,
        category: input.category,
        subCategory: input.subCategory ?? null,
        unitLabel: input.unitLabel ?? null,
        rowType: ASSEMBLY_ROW_TYPE,
        companyCost: rollup.companyCost,
        notes: input.notes ?? null,
        source: "in-app",
        // Same convention every in-app row uses: hours are per-unit, already resolved.
        laborUnitBasis: "E",
        laborUnitDivisor: 1,
        laborUnitBasisRaw: "E [in-app editor — per-unit hours, already resolved]",
        laborStatus: "IN-APP",
        laborNormal: laborData.laborNormal as number | null,
        laborDifficult: laborData.laborDifficult as number | null,
        laborVeryDifficult: laborData.laborVeryDifficult as number | null,
        laborNormalOverridden: laborData.laborNormalOverridden as boolean,
        laborDifficultOverridden: laborData.laborDifficultOverridden as boolean,
        laborVeryDifficultOverridden: laborData.laborVeryDifficultOverridden as boolean,
        ...computed,
      },
    });
    if (input.components.length > 0) {
      await tx.priceBookItemComponent.createMany({
        data: input.components.map((c) => ({ parentItemId: itemId, childItemId: c.childItemId, quantity: c.quantity })),
      });
    }
    await tx.priceBookEdit.create({
      data: { itemId, field: "created", oldValue: null, newValue: `assembly: ${input.description}`, editedBy },
    });
    return created;
  });
  return { ok: true, atomic };
}

// ─── Update components (replace the list) ──────────────────────────────────────────────────

export async function setAssemblyComponents(
  prisma: PrismaClient,
  itemId: string,
  components: ComponentInput[],
  editedBy: string,
): Promise<{ ok: true; atomic: unknown; rollup: ComponentRollup } | { ok: false; reason: string }> {
  const existing = await prisma.priceBookAtomic.findUnique({ where: { itemId } });
  if (!existing) return { ok: false, reason: `Item ${itemId} not found.` };
  if (!isAssemblyRowType(existing.rowType)) return { ok: false, reason: `${itemId} is not an assembly.` };

  const validated = await validateComponents(prisma, itemId, components);
  if (!validated.ok) return validated;

  const rollup = computeComponentRollup(components, validated.facts);
  const data: Record<string, number | null | boolean> = { companyCost: rollup.companyCost };
  for (const tier of LABOR_TIERS) {
    const overridden = (existing as Record<string, unknown>)[OVERRIDE_FIELD[tier]] as boolean;
    if (!overridden) data[tier] = rollup.labor[tier].value; // follows components — Kyle's ruling
    // else: leave the stored override untouched; drift is reported, not applied.
  }

  const { tiers, rate } = await loadPricingContext(prisma);
  const computed = computePricing(
    {
      rowType: ASSEMBLY_ROW_TYPE,
      companyCost: data.companyCost as number | null,
      laborNormal: (data.laborNormal ?? existing.laborNormal) as number | null,
      laborDifficult: (data.laborDifficult ?? existing.laborDifficult) as number | null,
      laborVeryDifficult: (data.laborVeryDifficult ?? existing.laborVeryDifficult) as number | null,
    },
    tiers,
    rate,
  );

  const atomic = await prisma.$transaction(async (tx) => {
    await tx.priceBookItemComponent.deleteMany({ where: { parentItemId: itemId } });
    if (components.length > 0) {
      await tx.priceBookItemComponent.createMany({
        data: components.map((c) => ({ parentItemId: itemId, childItemId: c.childItemId, quantity: c.quantity })),
      });
    }
    const updated = await tx.priceBookAtomic.update({ where: { itemId }, data: { ...data, ...computed } });
    await tx.priceBookEdit.create({
      data: { itemId, field: "components", oldValue: null, newValue: `${components.length} component(s)`, editedBy },
    });
    return updated;
  });
  return { ok: true, atomic, rollup };
}

// ─── Labour override ────────────────────────────────────────────────────────────────────────

/** Set (a number) or clear (null — revert to auto-sum) one tier's override. */
export async function setLaborOverride(
  prisma: PrismaClient,
  itemId: string,
  tier: LaborTier,
  value: number | null,
  editedBy: string,
): Promise<{ ok: true; atomic: unknown } | { ok: false; reason: string }> {
  const existing = await prisma.priceBookAtomic.findUnique({ where: { itemId } });
  if (!existing) return { ok: false, reason: `Item ${itemId} not found.` };
  if (!isAssemblyRowType(existing.rowType)) return { ok: false, reason: `${itemId} is not an assembly.` };

  const components = await prisma.priceBookItemComponent.findMany({ where: { parentItemId: itemId } });
  const facts = await fetchComponentFacts(prisma, components.map((c) => c.childItemId));
  const rollup = computeComponentRollup(
    components.map((c) => ({ childItemId: c.childItemId, quantity: c.quantity })),
    facts,
  );

  const data: Record<string, number | null | boolean> = {};
  if (value === null) {
    data[tier] = rollup.labor[tier].value;
    data[OVERRIDE_FIELD[tier]] = false;
  } else {
    data[tier] = value;
    data[OVERRIDE_FIELD[tier]] = true;
  }

  const { tiers, rate } = await loadPricingContext(prisma);
  const merged: Record<LaborTier, number | null> = {
    laborNormal: existing.laborNormal, laborDifficult: existing.laborDifficult, laborVeryDifficult: existing.laborVeryDifficult,
  };
  merged[tier] = data[tier] as number | null;
  const computed = computePricing(
    { rowType: ASSEMBLY_ROW_TYPE, companyCost: existing.companyCost, ...merged },
    tiers,
    rate,
  );

  const atomic = await prisma.$transaction(async (tx) => {
    const updated = await tx.priceBookAtomic.update({ where: { itemId }, data: { ...data, ...computed } });
    await tx.priceBookEdit.create({
      data: {
        itemId, field: tier,
        oldValue: existing[tier] === null ? null : String(existing[tier]),
        newValue: value === null ? `${data[tier]} (auto)` : String(value),
        editedBy,
        note: value === null ? "override cleared — reverted to component sum" : "manual override",
      },
    });
    return updated;
  });
  return { ok: true, atomic };
}

// ─── Detail (for the editor drawer) ────────────────────────────────────────────────────────

export async function getAssemblyDetail(prisma: PrismaClient, itemId: string) {
  const atomic = await prisma.priceBookAtomic.findUnique({ where: { itemId } });
  if (!atomic || !isAssemblyRowType(atomic.rowType)) return null;

  const componentRows = await prisma.priceBookItemComponent.findMany({
    where: { parentItemId: itemId },
    include: { child: { select: { itemId: true, description: true, unitLabel: true, companyCost: true, laborNormal: true, laborDifficult: true, laborVeryDifficult: true, laborUnitDivisor: true, rowType: true } } },
  });
  const facts = new Map(componentRows.map((r) => [r.childItemId, r.child as ComponentAtomicFacts]));
  const inputs = componentRows.map((r) => ({ childItemId: r.childItemId, quantity: r.quantity }));
  const rollup = computeComponentRollup(inputs, facts);

  const labor = {} as Record<LaborTier, EffectiveLaborTier>;
  for (const tier of LABOR_TIERS) {
    const overridden = (atomic as Record<string, unknown>)[OVERRIDE_FIELD[tier]] as boolean;
    labor[tier] = effectiveLaborTier(atomic[tier], overridden, rollup.labor[tier].value);
  }

  return { atomic, components: componentRows, rollup, labor };
}

// ─── Material list aggregation ──────────────────────────────────────────────────────────────

export interface MaterialListLine {
  /** An estimate line's itemId — either a plain material or an assembly. */
  itemId: string;
  /** The line's own quantity (PriceBookDraftLine.quantity). */
  quantity: number;
}

export interface MaterialListEntry {
  itemId: string;
  quantity: number;
}

/**
 * Expand estimate lines into one shopping list. "EV Charger ×1" plus "50 Amp Circuit THHN ×3"
 * yields one list with the wire summed across both — an assembly line expands to its
 * components × (component quantity × line quantity); a plain material line contributes itself.
 *
 * Pure function: `componentsByParent` is supplied by the caller (already fetched), so this is
 * unit-testable without a database and reusable once the estimate UI wires it in (a later unit).
 */
export function aggregateMaterialList(
  lines: MaterialListLine[],
  componentsByParent: Map<string, ComponentInput[]>,
): MaterialListEntry[] {
  const totals = new Map<string, number>();
  for (const line of lines) {
    const components = componentsByParent.get(line.itemId);
    if (components && components.length > 0) {
      for (const c of components) {
        totals.set(c.childItemId, (totals.get(c.childItemId) ?? 0) + c.quantity * line.quantity);
      }
    } else {
      totals.set(line.itemId, (totals.get(line.itemId) ?? 0) + line.quantity);
    }
  }
  return [...totals.entries()].map(([itemId, quantity]) => ({ itemId, quantity: round4(quantity) }));
}
