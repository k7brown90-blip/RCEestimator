/**
 * The in-app price book editor (Kyle, 2026-08-30 — Option A ratified: "We can
 * add a new tab that is labeled 'Price Book' that will be the full in-app
 * editor.").
 *
 * The app is the book now. This service is the ONLY writer to PriceBookAtomic
 * outside the (final) import lane, and it holds three promises:
 *
 *  1. THE WORKBOOK'S MATH, EXACTLY. Sell prices recompute the way Kyle's tab
 *     computed them and the import parity-asserted them:
 *       companyPrice = companyCost × tier multiplier   (Rate Config tiers)
 *       sell_d       = round(laborHours_d × billed rate + companyPrice, 2)
 *     The rate is Rate Config `billedLaborRate` ($100/hr from 2026-09-01; $150 before).
 *     Changing it recomputes every sell column — scripts/setLaborRate.ts, audited.
 *     A labour-only row carries no material — $0, not a missing number.
 *  2. EVERY EDIT HAS A STORY. Append-only PriceBookEdit rows: who, when,
 *     field, old, new. A price a customer asks about must be explainable.
 *  3. RETIRE, NEVER DELETE. Draft and issued lines reference itemId; a used
 *     item disappears from pickers, never from history.
 */

import type { PrismaClient } from "@prisma/client";
import { markupMultiplierFor, markupTierFor, type MarkupTiers } from "./priceBookPricing";
import { loadBilledLaborRate } from "./laborRate";
import { isAssemblyRowType } from "./priceBookAssembly";

const round2 = (n: number) => Math.round(n * 100) / 100;

export async function loadMarkupTiers(prisma: PrismaClient): Promise<MarkupTiers> {
  const rows = await prisma.priceBookRateConfig.findMany({
    where: { key: { in: ["markupTier1", "markupTier2", "markupTier3", "markupTier4", "markupTier5"] } },
  });
  const byKey = new Map(rows.map((r) => [r.key, r.numberValue ?? 0]));
  return {
    tier1: byKey.get("markupTier1") ?? 0,
    tier2: byKey.get("markupTier2") ?? 0,
    tier3: byKey.get("markupTier3") ?? 0,
    tier4: byKey.get("markupTier4") ?? 0,
    tier5: byKey.get("markupTier5") ?? 0,
  };
}

interface PricingInput {
  rowType: string | null;
  companyCost: number | null;
  laborNormal: number | null;
  laborDifficult: number | null;
  laborVeryDifficult: number | null;
}

export interface ComputedPricing {
  markupTier: string;
  companyPrice: number | null;
  sellNormal: number | null;
  sellDifficult: number | null;
  sellVeryDifficult: number | null;
}

/** Tiers and the live billed rate together — every price the editor writes comes from these. */
export async function loadPricingContext(prisma: PrismaClient): Promise<{ tiers: MarkupTiers; rate: number }> {
  const [tiers, rate] = await Promise.all([loadMarkupTiers(prisma), loadBilledLaborRate(prisma)]);
  return { tiers, rate };
}

export interface SellInputs {
  rowType: string | null;
  companyPrice: number | null;
  laborNormal: number | null;
  laborDifficult: number | null;
  laborVeryDifficult: number | null;
}

/**
 * The sell columns alone, from a row's marked-up material and hours:
 * sell_d = hours_d × rate + material. This is the half of the formula a rate change moves —
 * material is untouched by it — so setLaborRate.ts rebuilds rows through here and
 * computePricing composes it.
 */
export function sellsAtRate(
  row: SellInputs,
  rate: number,
): Pick<ComputedPricing, "sellNormal" | "sellDifficult" | "sellVeryDifficult"> {
  const type = (row.rowType ?? "").toUpperCase();
  const materialOnly = type.includes("MATERIAL ONLY");
  const material = type.includes("LABOR ONLY") ? 0 : (row.companyPrice ?? 0);
  const sellFor = (hours: number | null): number | null => {
    if (materialOnly) return row.companyPrice; // material rows sell the marked-up material, no labour line
    if (hours === null || hours === undefined) return null;
    return round2(hours * rate + material);
  };
  return {
    sellNormal: sellFor(row.laborNormal),
    sellDifficult: sellFor(row.laborDifficult),
    sellVeryDifficult: sellFor(row.laborVeryDifficult),
  };
}

/** The workbook's formulas, verbatim, at the given billed rate — see kylesTabMapping's parity assertion. */
export function computePricing(input: PricingInput, tiers: MarkupTiers, rate: number): ComputedPricing {
  const laborOnly = (input.rowType ?? "").toUpperCase().includes("LABOR ONLY");
  const cost = laborOnly ? null : input.companyCost;
  const mult = markupMultiplierFor(cost ?? null, tiers);
  const companyPrice = cost !== null && cost !== undefined && mult !== null ? round2(cost * mult) : null;
  return {
    markupTier: markupTierFor(cost ?? null),
    companyPrice,
    ...sellsAtRate({ ...input, companyPrice }, rate),
  };
}

/** Fields the editor may write. itemId, source and provenance never move. */
const EDITABLE_FIELDS = [
  "description", "category", "subCategory", "unitLabel", "notes", "sector", "rowType",
  "companyCost", "laborNormal", "laborDifficult", "laborVeryDifficult",
] as const;
type EditableField = (typeof EDITABLE_FIELDS)[number];
const PRICING_FIELDS: ReadonlySet<string> = new Set([
  "companyCost", "laborNormal", "laborDifficult", "laborVeryDifficult", "rowType",
]);

export type AtomicPatch = Partial<Record<EditableField, string | number | null>>;

/** The write side of an update: the row patch and its edit-trail rows, ready for
 * `tx.priceBookAtomic.update` + `tx.priceBookEdit.createMany`. */
export interface AtomicUpdatePlan {
  data: Record<string, unknown>;
  audits: Array<{ field: string; oldValue: string | null; newValue: string | null }>;
}

export type AtomicUpdatePlanResult =
  | { ok: true; noop: true; atomic: unknown }
  | { ok: true; noop: false; plan: AtomicUpdatePlan }
  | { ok: false; reason: string };

/**
 * All of `updateAtomic`'s guards and pricing recomputation, with no write. Split out so a caller
 * that already holds an open transaction (the price-refresh cascade, priceBookRefresh.ts, which
 * must update a component and every assembly containing it atomically) can build the identical
 * plan and apply it inside ITS OWN transaction — a Prisma interactive-transaction client cannot
 * itself open a nested `$transaction`, so `updateAtomic` opening one internally cannot be reused
 * as-is from inside another. `updateAtomic` below is unchanged in behavior: build the plan, then
 * apply it in one `$transaction`, exactly as before this split.
 */
export async function planAtomicUpdate(
  prisma: PrismaClient,
  itemId: string,
  patch: AtomicPatch,
): Promise<AtomicUpdatePlanResult> {
  const existing = await prisma.priceBookAtomic.findUnique({ where: { itemId } });
  if (!existing) return { ok: false, reason: `Item ${itemId} not found.` };

  const existingIsAssembly = isAssemblyRowType((existing as { rowType: string | null }).rowType);

  // rowType integrity, both directions:
  //  - An assembly's rowType is load-bearing for every other guard in this file and in
  //    priceBookAssembly.ts (component rollup, no-nesting, inventory exclusion). Letting it
  //    change would silently de-assemble the row — its PriceBookItemComponent rows stay behind,
  //    orphaned, and its derived cost freezes as a now-typed-editable value. Refuse outright
  //    rather than let the generic catalog drawer touch it.
  //  - The mirror case: patching an ordinary row's rowType to "ASSEMBLY" would produce a nominal
  //    assembly with a stale typed cost/labour and zero components. Assemblies are created
  //    through POST /price-book/catalog/assemblies, which builds the component list and derives
  //    cost from it — never through this generic patch path.
  if (existingIsAssembly && "rowType" in patch) {
    return {
      ok: false,
      reason:
        `${itemId} is an assembly — rowType cannot be changed through this endpoint. ` +
        `De-assembling it would orphan its component list (PriceBookItemComponent) and freeze its ` +
        `derived cost as a stale typed value.`,
    };
  }
  if (!existingIsAssembly && "rowType" in patch && isAssemblyRowType(patch.rowType as string | null)) {
    return {
      ok: false,
      reason:
        `Cannot set rowType to ASSEMBLY through this endpoint. Assemblies are created through ` +
        `POST /price-book/catalog/assemblies, which builds the component list and derives cost from it.`,
    };
  }

  // An assembly's cost and labour are DERIVED from its components (priceBookAssembly.ts) — never
  // typed, never patched directly through the generic catalog path. A typed value here would
  // silently disagree with the assembly's own material list, which is the exact failure this
  // whole design exists to prevent. Refuse loudly rather than silently dropping the field.
  if (existingIsAssembly) {
    if ("companyCost" in patch) {
      return {
        ok: false,
        reason:
          `${itemId} is an assembly — its companyCost is derived from its components' costs, ` +
          `not typed directly. Edit the component list (PUT /price-book/catalog/assemblies/${itemId}/components) instead.`,
      };
    }
    const laborFields = ["laborNormal", "laborDifficult", "laborVeryDifficult"] as const;
    const patchedLaborField = laborFields.find((f) => f in patch);
    if (patchedLaborField) {
      return {
        ok: false,
        reason:
          `${itemId} is an assembly — ${patchedLaborField} is auto-summed from its components, ` +
          `not patched directly. Use PUT /price-book/catalog/assemblies/${itemId}/labor-override ` +
          `to set an explicit override (it records the override flag so it is never silently inferred).`,
      };
    }
  }

  const data: Record<string, unknown> = {};
  const audits: Array<{ field: string; oldValue: string | null; newValue: string | null }> = [];
  for (const field of EDITABLE_FIELDS) {
    if (!(field in patch)) continue;
    const next = patch[field] ?? null;
    const prev = (existing as Record<string, unknown>)[field] ?? null;
    if (String(prev ?? "") === String(next ?? "")) continue;
    data[field] = next;
    audits.push({ field, oldValue: prev === null ? null : String(prev), newValue: next === null ? null : String(next) });
  }
  if (audits.length === 0) return { ok: true, noop: true, atomic: existing };

  // Editing hours on a row with no unit basis (in-app items created before the
  // 2026-08-30 fix): heal the basis so laborHoursFor can read what was typed.
  const touchesHours = audits.some((a) => a.field.startsWith("labor"));
  if (touchesHours && (existing as { laborUnitDivisor: number | null }).laborUnitDivisor === null) {
    data["laborUnitBasis"] = "E";
    data["laborUnitDivisor"] = 1;
    data["laborUnitBasisRaw"] = "E [in-app editor — per-unit hours, already resolved]";
    audits.push({ field: "laborUnitDivisor", oldValue: null, newValue: "1" });
  }

  // Any pricing input changed → recompute tier and sells the workbook's way.
  if (audits.some((a) => PRICING_FIELDS.has(a.field))) {
    const { tiers, rate } = await loadPricingContext(prisma);
    // `in data` not `??` — clearing a value to null is an edit, not an absence.
    const pick = <K extends keyof PricingInput>(k: K): PricingInput[K] =>
      (k in data ? data[k] : (existing as Record<string, unknown>)[k]) as PricingInput[K];
    const merged: PricingInput = {
      rowType: pick("rowType"),
      companyCost: pick("companyCost"),
      laborNormal: pick("laborNormal"),
      laborDifficult: pick("laborDifficult"),
      laborVeryDifficult: pick("laborVeryDifficult"),
    };
    const computed = computePricing(merged, tiers, rate);
    for (const [k, v] of Object.entries(computed)) {
      const prev = (existing as Record<string, unknown>)[k] ?? null;
      if (String(prev ?? "") !== String(v ?? "")) {
        data[k] = v;
        audits.push({ field: k, oldValue: prev === null ? null : String(prev), newValue: v === null ? null : String(v) });
      }
    }
  }

  return { ok: true, noop: false, plan: { data, audits } };
}

/**
 * Apply a plan built by `planAtomicUpdate` — the row update plus its `PriceBookEdit` rows — using
 * whatever client the caller passes (a plain `PrismaClient`, or a `Prisma.TransactionClient` when
 * this write must be atomic with other writes the caller is making, e.g. the price-refresh
 * cascade). Does not open a transaction of its own; the caller decides that scope.
 */
export async function applyAtomicUpdatePlan(
  tx: PrismaClient,
  itemId: string,
  plan: AtomicUpdatePlan,
  editedBy: string,
): Promise<unknown> {
  const updated = await tx.priceBookAtomic.update({ where: { itemId }, data: plan.data });
  await tx.priceBookEdit.createMany({
    data: plan.audits.map((a) => ({ itemId, ...a, editedBy })),
  });
  return updated;
}

export async function updateAtomic(
  prisma: PrismaClient,
  itemId: string,
  patch: AtomicPatch,
  editedBy: string,
): Promise<{ ok: true; atomic: unknown } | { ok: false; reason: string }> {
  const planResult = await planAtomicUpdate(prisma, itemId, patch);
  if (!planResult.ok) return planResult;
  if (planResult.noop) return { ok: true, atomic: planResult.atomic };

  const atomic = await prisma.$transaction(async (tx) =>
    applyAtomicUpdatePlan(tx as unknown as PrismaClient, itemId, planResult.plan, editedBy),
  );
  return { ok: true, atomic };
}

export interface CreateAtomicInput {
  itemId?: string | null; // explicit ID, or null → generated from prefix
  idPrefix?: string | null; // e.g. "A" → next free A-number
  description: string;
  category: string;
  subCategory?: string | null;
  unitLabel?: string | null;
  sector?: string | null;
  rowType: string;
  companyCost?: number | null;
  laborNormal?: number | null;
  laborDifficult?: number | null;
  laborVeryDifficult?: number | null;
  notes?: string | null;
}

/**
 * Resolve the ID an item will be created under: the caller's explicit ID, uppercased, or the
 * next free number after a prefix (the book's own scheme). Shared with priceBookAssembly.ts so
 * an assembly's auto ID follows the identical rule rather than a second implementation of it.
 */
export async function resolveNewItemId(
  prisma: PrismaClient,
  itemId: string | null | undefined,
  idPrefix: string | null | undefined,
): Promise<{ ok: true; itemId: string } | { ok: false; reason: string }> {
  let id = (itemId ?? "").trim().toUpperCase();
  if (!id) {
    const prefix = (idPrefix ?? "APP").trim().toUpperCase().replace(/[^A-Z]/g, "") || "APP";
    const siblings = await prisma.priceBookAtomic.findMany({
      where: { itemId: { startsWith: prefix } },
      select: { itemId: true },
    });
    const pattern = new RegExp(`^${prefix}(\\d+)$`);
    const max = siblings.reduce((best, row) => {
      const m = pattern.exec(row.itemId);
      return m ? Math.max(best, Number(m[1])) : best;
    }, 0);
    id = `${prefix}${String(max + 1).padStart(3, "0")}`;
  }
  const clash = await prisma.priceBookAtomic.findUnique({ where: { itemId: id }, select: { itemId: true } });
  if (clash) return { ok: false, reason: `Item ID ${id} already exists.` };
  return { ok: true, itemId: id };
}

export async function createAtomic(
  prisma: PrismaClient,
  input: CreateAtomicInput,
  editedBy: string,
): Promise<{ ok: true; atomic: unknown } | { ok: false; reason: string }> {
  // Assemblies are created through the assembly path (createAssembly / POST
  // /price-book/catalog/assemblies), which builds the component list and derives cost from it.
  // A row with rowType "ASSEMBLY" created here would carry a hand-typed cost and zero components,
  // bypassing the derived-cost design at creation instead of update.
  if (isAssemblyRowType(input.rowType)) {
    return {
      ok: false,
      reason:
        "Cannot create a row with rowType ASSEMBLY through createAtomic. Use " +
        "POST /price-book/catalog/assemblies, which builds the component list and derives cost from it.",
    };
  }
  const resolved = await resolveNewItemId(prisma, input.itemId, input.idPrefix);
  if (!resolved.ok) return resolved;
  const itemId = resolved.itemId;

  const { tiers, rate } = await loadPricingContext(prisma);
  const computed = computePricing(
    {
      rowType: input.rowType,
      companyCost: input.companyCost ?? null,
      laborNormal: input.laborNormal ?? null,
      laborDifficult: input.laborDifficult ?? null,
      laborVeryDifficult: input.laborVeryDifficult ?? null,
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
        sector: input.sector ?? null,
        rowType: input.rowType,
        companyCost: input.companyCost ?? null,
        laborNormal: input.laborNormal ?? null,
        laborDifficult: input.laborDifficult ?? null,
        laborVeryDifficult: input.laborVeryDifficult ?? null,
        notes: input.notes ?? null,
        source: "in-app",
        /*
          THE ENGINE WILL NOT READ HOURS WITHOUT A UNIT BASIS. laborHoursFor
          blocks on a null divisor by design (E vs C is a 100× error), so an
          item created without these fields prices its labour as $0 and the
          whole sell lands in the material column — Kyle's GENERAL LABOR item
          did exactly that on 2026-08-30. Editor hours are per-unit by
          definition, so E / divisor 1 is correct, same as the importers.
        */
        laborUnitBasis: "E",
        laborUnitDivisor: 1,
        laborUnitBasisRaw: "E [in-app editor — per-unit hours, already resolved]",
        laborStatus: "IN-APP",
        ...computed,
      },
    });
    await tx.priceBookEdit.create({
      data: { itemId, field: "created", oldValue: null, newValue: input.description, editedBy },
    });
    return created;
  });
  return { ok: true, atomic };
}

export async function retireAtomic(prisma: PrismaClient, itemId: string, editedBy: string, restore = false) {
  const existing = await prisma.priceBookAtomic.findUnique({ where: { itemId }, select: { itemId: true, retiredAt: true } });
  if (!existing) return { ok: false as const, reason: `Item ${itemId} not found.` };
  const atomic = await prisma.$transaction(async (tx) => {
    const updated = await tx.priceBookAtomic.update({
      where: { itemId },
      data: { retiredAt: restore ? null : new Date() },
    });
    await tx.priceBookEdit.create({
      data: { itemId, field: restore ? "restored" : "retired", oldValue: null, newValue: null, editedBy },
    });
    return updated;
  });
  return { ok: true as const, atomic };
}

/** Rename a category card — follows every item and the order row. */
export async function renameCategory(prisma: PrismaClient, from: string, to: string, editedBy: string) {
  const count = await prisma.priceBookAtomic.count({ where: { category: from } });
  if (count === 0) return { ok: false as const, reason: `No items carry the category "${from}".` };
  await prisma.$transaction(async (tx) => {
    const items = await tx.priceBookAtomic.findMany({ where: { category: from }, select: { itemId: true } });
    await tx.priceBookAtomic.updateMany({ where: { category: from }, data: { category: to } });
    await tx.priceBookEdit.createMany({
      data: items.map((i) => ({ itemId: i.itemId, field: "category", oldValue: from, newValue: to, editedBy })),
    });
    const meta = await tx.priceBookCategoryMeta.findUnique({ where: { name: from } });
    if (meta) {
      await tx.priceBookCategoryMeta.delete({ where: { name: from } });
      await tx.priceBookCategoryMeta.upsert({
        where: { name: to },
        create: { name: to, sortOrder: meta.sortOrder },
        update: { sortOrder: meta.sortOrder },
      });
    }
  });
  return { ok: true as const, renamed: count };
}

/** The category cards, in display order, with live counts.
 *
 * `subCategories` is additive (2026-09-16, Unit 1 of the card-grid plan) — the
 * existing `{ name, count, sortOrder }` shape, its values, and the array's sort
 * order are unchanged, since `exportPriceBookXlsx` (priceBookExport.ts) depends
 * on that contract to build its sheet order. Most items have no sub-category;
 * that null/blank bucket is real data (not a bug) and is sorted last, never
 * given a placeholder name that could be mistaken for one. */
export async function listCategories(prisma: PrismaClient) {
  const [groups, subGroups, meta] = await Promise.all([
    prisma.priceBookAtomic.groupBy({
      by: ["category"],
      where: { retiredAt: null, category: { not: null } },
      _count: { _all: true },
    }),
    prisma.priceBookAtomic.groupBy({
      by: ["category", "subCategory"],
      where: { retiredAt: null, category: { not: null } },
      _count: { _all: true },
    }),
    prisma.priceBookCategoryMeta.findMany(),
  ]);
  const orderByName = new Map(meta.map((m) => [m.name, m.sortOrder]));
  const subByCategory = new Map<string, Array<{ name: string | null; count: number }>>();
  for (const g of subGroups) {
    const cat = g.category as string;
    const arr = subByCategory.get(cat) ?? [];
    arr.push({ name: (g.subCategory as string | null) ?? null, count: g._count._all });
    subByCategory.set(cat, arr);
  }
  for (const arr of subByCategory.values()) {
    arr.sort((a, b) => {
      if (a.name === null || a.name === "") return 1;
      if (b.name === null || b.name === "") return -1;
      return a.name.localeCompare(b.name);
    });
  }
  return groups
    .map((g) => ({
      name: g.category as string,
      count: g._count._all,
      sortOrder: orderByName.get(g.category as string) ?? 9999,
      subCategories: subByCategory.get(g.category as string) ?? [],
    }))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
}

export async function setCategoryOrder(prisma: PrismaClient, names: string[]) {
  await prisma.$transaction(
    names.map((name, index) =>
      prisma.priceBookCategoryMeta.upsert({
        where: { name },
        create: { name, sortOrder: index },
        update: { sortOrder: index },
      }),
    ),
  );
  return { ok: true as const };
}
