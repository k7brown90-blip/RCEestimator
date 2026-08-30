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
 *       sell_d       = round(laborHours_d × $150 + companyPrice, 2)
 *     A labour-only row carries no material — $0, not a missing number.
 *  2. EVERY EDIT HAS A STORY. Append-only PriceBookEdit rows: who, when,
 *     field, old, new. A price a customer asks about must be explainable.
 *  3. RETIRE, NEVER DELETE. Draft and issued lines reference itemId; a used
 *     item disappears from pickers, never from history.
 */

import type { PrismaClient } from "@prisma/client";
import { markupMultiplierFor, markupTierFor, type MarkupTiers } from "./priceBookPricing";
import { RATE } from "../../scripts/price-book/kylesTabMapping";

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

/** The workbook's formulas, verbatim — see kylesTabMapping's parity assertion. */
export function computePricing(input: PricingInput, tiers: MarkupTiers): ComputedPricing {
  const laborOnly = (input.rowType ?? "").toUpperCase().includes("LABOR ONLY");
  const materialOnly = (input.rowType ?? "").toUpperCase().includes("MATERIAL ONLY");
  const cost = laborOnly ? null : input.companyCost;
  const mult = markupMultiplierFor(cost ?? null, tiers);
  const companyPrice = cost !== null && cost !== undefined && mult !== null ? round2(cost * mult) : null;
  const sellFor = (hours: number | null): number | null => {
    if (materialOnly) return companyPrice; // material rows sell the marked-up material, no labour line
    if (hours === null || hours === undefined) return null;
    return round2(hours * RATE + (companyPrice ?? 0));
  };
  return {
    markupTier: markupTierFor(cost ?? null),
    companyPrice,
    sellNormal: sellFor(input.laborNormal),
    sellDifficult: sellFor(input.laborDifficult),
    sellVeryDifficult: sellFor(input.laborVeryDifficult),
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

export async function updateAtomic(
  prisma: PrismaClient,
  itemId: string,
  patch: AtomicPatch,
  editedBy: string,
): Promise<{ ok: true; atomic: unknown } | { ok: false; reason: string }> {
  const existing = await prisma.priceBookAtomic.findUnique({ where: { itemId } });
  if (!existing) return { ok: false, reason: `Item ${itemId} not found.` };

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
  if (audits.length === 0) return { ok: true, atomic: existing };

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
    const tiers = await loadMarkupTiers(prisma);
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
    const computed = computePricing(merged, tiers);
    for (const [k, v] of Object.entries(computed)) {
      const prev = (existing as Record<string, unknown>)[k] ?? null;
      if (String(prev ?? "") !== String(v ?? "")) {
        data[k] = v;
        audits.push({ field: k, oldValue: prev === null ? null : String(prev), newValue: v === null ? null : String(v) });
      }
    }
  }

  const atomic = await prisma.$transaction(async (tx) => {
    const updated = await tx.priceBookAtomic.update({ where: { itemId }, data });
    await tx.priceBookEdit.createMany({
      data: audits.map((a) => ({ itemId, ...a, editedBy })),
    });
    return updated;
  });
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

export async function createAtomic(
  prisma: PrismaClient,
  input: CreateAtomicInput,
  editedBy: string,
): Promise<{ ok: true; atomic: unknown } | { ok: false; reason: string }> {
  let itemId = (input.itemId ?? "").trim().toUpperCase();
  if (!itemId) {
    // Continue the book's own scheme: prefix + zero-padded next number.
    const prefix = (input.idPrefix ?? "APP").trim().toUpperCase().replace(/[^A-Z]/g, "") || "APP";
    const siblings = await prisma.priceBookAtomic.findMany({
      where: { itemId: { startsWith: prefix } },
      select: { itemId: true },
    });
    const pattern = new RegExp(`^${prefix}(\\d+)$`);
    const max = siblings.reduce((best, row) => {
      const m = pattern.exec(row.itemId);
      return m ? Math.max(best, Number(m[1])) : best;
    }, 0);
    itemId = `${prefix}${String(max + 1).padStart(3, "0")}`;
  }
  const clash = await prisma.priceBookAtomic.findUnique({ where: { itemId }, select: { itemId: true } });
  if (clash) return { ok: false, reason: `Item ID ${itemId} already exists.` };

  const tiers = await loadMarkupTiers(prisma);
  const computed = computePricing(
    {
      rowType: input.rowType,
      companyCost: input.companyCost ?? null,
      laborNormal: input.laborNormal ?? null,
      laborDifficult: input.laborDifficult ?? null,
      laborVeryDifficult: input.laborVeryDifficult ?? null,
    },
    tiers,
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

/** The category cards, in display order, with live counts. */
export async function listCategories(prisma: PrismaClient) {
  const [groups, meta] = await Promise.all([
    prisma.priceBookAtomic.groupBy({
      by: ["category"],
      where: { retiredAt: null, category: { not: null } },
      _count: { _all: true },
    }),
    prisma.priceBookCategoryMeta.findMany(),
  ]);
  const orderByName = new Map(meta.map((m) => [m.name, m.sortOrder]));
  return groups
    .map((g) => ({
      name: g.category as string,
      count: g._count._all,
      sortOrder: orderByName.get(g.category as string) ?? 9999,
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
