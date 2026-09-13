/**
 * Observed prices, 90-day working set (2026-09-12, barcode/materials plan Unit 4).
 *
 * `MaterialPriceObservation` is one row per price actually paid — see the schema comment on the
 * model for the full picture. Two things this file is responsible for:
 *
 * 1. MATCHING a receipt line to a `Material` row, so the observation can be attributed at all.
 *    A parsed SKU is EVIDENCE, NOT GOSPEL: Vision misreads digits, and a mis-OCR'd SKU that
 *    happens to match another product would attach a price to the wrong material. A SKU match is
 *    only accepted when BOTH hold:
 *      - the receipt's vendor matches the material's own supplier (case-insensitive), and
 *      - the parsed line name is consistent with the material's description (bidirectional
 *        substring, same check the pre-existing drift card used).
 *    Failing either, the line falls back to name-matching (`matchMethod: "name_fuzzy"`) — the
 *    same bidirectional substring match, just now against `Material.description` instead of
 *    `PriceBookAtomic.description`, so every observation carries a `materialId`.
 *
 * 2. PACK-SIZE NORMALISATION. `unitCost` on this table is ALREADY divided by packQty
 *    (`perUnitCostFromPack`, reused from services/materials.ts — never reimplemented here) so a
 *    package price and a per-each price are directly comparable.
 *
 * RETENTION is a hard 90-day delete, not a rollup (see the schema comment — Kyle's ruling,
 * 2026-09-12: "90 days is enough to keep tabs on items that are high use"). `deleteExpiredObservations`
 * is the entire retention story; there is no summary table to keep in sync with it.
 *
 * GUARD, CARRIED FROM UNIT 1: an assembly (`rowType = "ASSEMBLY"`) is never a purchasable thing
 * and must never receive an observation. In practice `Material.itemId` can never point at an
 * assembly already (services/materials.ts guards both link and promote), so this is a defensive
 * second check, not the primary guard.
 */

import type { Material, PrismaClient } from "@prisma/client";
import { assertNotAssembly, AssemblyGuardError } from "./priceBookAssembly";
import { perUnitCostFromPack } from "./materials";

export type ObservationSource = "receipt_line" | "po_line" | "manual";
export type MatchMethod = "barcode" | "sku" | "name_fuzzy" | "manual";

/**
 * How confidently each method attaches an observation to a material. "barcode" (Unit 3's field
 * scan) and "sku" (verified against the material's own supplier below) are both an EXACT code
 * match, so they rank equally; "name_fuzzy" — a substring guess — ranks below both. "manual" is
 * Kyle typing the price in himself and ranks above all three. Unit 5's monthly proposal reads this
 * ranking to prefer the trustworthy rows over a name guess for the same item.
 */
export const MATCH_METHOD_RANK: Record<MatchMethod, number> = {
  manual: 3,
  barcode: 2,
  sku: 2,
  name_fuzzy: 1,
};

export function rankMatchMethod(method: MatchMethod): number {
  return MATCH_METHOD_RANK[method];
}

/** Bidirectional substring, case-insensitive — "12-2 Romex 250ft" should find "Romex 12-2" and
 * vice versa. Same check the pre-existing price-drift card used, now reused rather than
 * duplicated (financials.ts:756-800 before this unit). */
export function isDescriptionConsistent(receiptLineName: string | null | undefined, materialDescription: string | null | undefined): boolean {
  const a = (receiptLineName ?? "").trim().toLowerCase();
  const b = (materialDescription ?? "").trim().toLowerCase();
  if (!a || !b) return false;
  return a.includes(b) || b.includes(a);
}

export interface ReceiptLineForMatch {
  name: string;
  sku?: string | null;
}

export interface MaterialMatch {
  material: Material;
  matchMethod: "sku" | "name_fuzzy";
}

/**
 * Match one receipt line to a Material row.
 *
 * SKU path (only when the line carries a SKU and the receipt carries a vendor): candidates are
 * materials with that exact `(supplier, sku)` — the same unique pair Unit 2 enforces at write
 * time — found by comparing `vendor` to `Material.supplier` case-insensitively (a receipt's
 * vendor text and a hand-typed supplier field are not guaranteed to match case). A candidate is
 * only ACCEPTED when the parsed line name is also consistent with the candidate's description;
 * otherwise the match is refused (never silently accepted on the code alone) and the line falls
 * through to name matching.
 *
 * Name-fuzzy path: the pre-existing bidirectional substring match, now against
 * `Material.description` so every accepted match carries a `materialId`. Unscoped by vendor,
 * matching the card's existing (pre-Unit-4) behaviour.
 */
export async function matchReceiptLineToMaterial(
  prisma: PrismaClient,
  line: ReceiptLineForMatch,
  vendor: string | null | undefined,
): Promise<MaterialMatch | null> {
  const sku = line.sku?.trim();
  if (sku && vendor && vendor.trim()) {
    const candidates = await prisma.material.findMany({
      where: { sku, supplier: { equals: vendor.trim(), mode: "insensitive" } },
    });
    const accepted = candidates.find((m) => isDescriptionConsistent(line.name, m.description));
    if (accepted) return { material: accepted, matchMethod: "sku" };
    // SKU present but vendor didn't match any material carrying it, or the description was
    // inconsistent — REFUSED, not accepted on the code alone. Fall through to name matching.
  }

  const materials = await prisma.material.findMany({ where: { description: { not: null } } });
  const match = materials.find((m) => isDescriptionConsistent(line.name, m.description));
  if (match) return { material: match, matchMethod: "name_fuzzy" };

  return null;
}

// ─── Pack-size normalisation ────────────────────────────────────────────────────────────────

/**
 * The observation's `unitCost` — a package price is divided by packQty (Unit 2's
 * `perUnitCostFromPack`, reused here, never reimplemented). A material with no known pack size
 * (packQty null or non-positive) is assumed to already be priced per unit, e.g. a single item
 * with no pack breakdown.
 */
export function observedUnitCost(rawUnitCost: number, packQty: number | null | undefined): number {
  if (packQty !== null && packQty !== undefined && packQty > 0) {
    return perUnitCostFromPack(rawUnitCost, packQty);
  }
  return rawUnitCost;
}

// ─── Writing observations ───────────────────────────────────────────────────────────────────

export interface CreateObservationInput {
  materialId: string;
  itemId: string | null;
  supplier: string | null;
  observedAt: Date;
  qty: number;
  /** Already per-unit (post pack-size division) — callers that have a raw package price should
   * go through `observedUnitCost` first, or use `recordObservationsForReceipt` which does it. */
  unitCost: number;
  source: ObservationSource;
  matchMethod: MatchMethod;
  receiptId?: string | null;
  purchaseOrderLineId?: string | null;
}

/** The single writer. Guards against an assembly itemId defensively (Material.itemId should
 * never carry one already — services/materials.ts guards link and promote — but an observation
 * is exactly the kind of write that must never be the path that regresses that rule). */
export async function createPriceObservation(prisma: PrismaClient, input: CreateObservationInput) {
  if (input.itemId) {
    try {
      await assertNotAssembly(prisma, input.itemId, "receive a price observation");
    } catch (err) {
      if (err instanceof AssemblyGuardError) return { ok: false as const, reason: err.message };
      throw err;
    }
  }
  const row = await prisma.materialPriceObservation.create({
    data: {
      materialId: input.materialId,
      itemId: input.itemId,
      supplier: input.supplier,
      observedAt: input.observedAt,
      qty: input.qty,
      unitCost: input.unitCost,
      source: input.source,
      matchMethod: input.matchMethod,
      receiptId: input.receiptId ?? null,
      purchaseOrderLineId: input.purchaseOrderLineId ?? null,
    },
  });
  return { ok: true as const, observation: row };
}

interface ReceiptLineForIngest {
  name: string;
  qty: number | null;
  unit: string | null;
  unitCost: number | null;
  sku?: string | null;
}

/**
 * Ingest one confirmed receipt's parsed lines into `MaterialPriceObservation`, matching each
 * line to a Material (SKU-then-name, above) and normalising pack pricing to a per-unit cost.
 * A line with no readable unit cost, or that matches no material at all, is skipped — there is
 * nothing to attribute a price to yet (Kyle completes the material at the desk later; the
 * observation catches up the next time this receipt (or a later one for the same product) is
 * ingested).
 *
 * IDEMPOTENT: existing observations for this receipt are replaced wholesale rather than
 * appended, so re-running this (e.g. the financials price-drift card re-deriving on every
 * request) never duplicates rows.
 */
export async function recordObservationsForReceipt(
  prisma: PrismaClient,
  receipt: { id: string; vendor: string | null; lineItems: string | null; receivedAt: Date },
): Promise<{ created: number }> {
  let lines: ReceiptLineForIngest[] = [];
  if (receipt.lineItems) {
    try {
      const parsed = JSON.parse(receipt.lineItems);
      if (Array.isArray(parsed)) lines = parsed;
    } catch {
      lines = [];
    }
  }

  await prisma.materialPriceObservation.deleteMany({ where: { receiptId: receipt.id } });
  if (lines.length === 0) return { created: 0 };

  let created = 0;
  for (const line of lines) {
    if (typeof line.name !== "string" || !line.name.trim()) continue;
    if (typeof line.unitCost !== "number" || !(line.unitCost > 0)) continue;
    const match = await matchReceiptLineToMaterial(prisma, { name: line.name, sku: line.sku }, receipt.vendor);
    if (!match) continue;

    const unitCost = observedUnitCost(line.unitCost, match.material.packQty);
    const result = await createPriceObservation(prisma, {
      materialId: match.material.id,
      itemId: match.material.itemId,
      supplier: receipt.vendor ?? match.material.supplier ?? null,
      observedAt: receipt.receivedAt,
      qty: typeof line.qty === "number" && line.qty > 0 ? line.qty : 1,
      unitCost,
      source: "receipt_line",
      matchMethod: match.matchMethod,
      receiptId: receipt.id,
    });
    if (result.ok) created += 1;
  }
  return { created };
}

// ─── Retention — a hard 90-day delete, no rollup ───────────────────────────────────────────

export const OBSERVATION_RETENTION_DAYS = 90;

/**
 * Deletes every observation whose `observedAt` is older than the retention window. Nothing is
 * summarised or archived first — see the schema comment and Kyle's 2026-09-12 ruling: the PO
 * lines, receipts and issued estimates this was derived from already keep that record.
 */
export async function deleteExpiredObservations(
  prisma: PrismaClient,
  opts: { now?: Date; retentionDays?: number } = {},
): Promise<{ deleted: number }> {
  const now = opts.now ?? new Date();
  const retentionDays = opts.retentionDays ?? OBSERVATION_RETENTION_DAYS;
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);
  const result = await prisma.materialPriceObservation.deleteMany({ where: { observedAt: { lt: cutoff } } });
  return { deleted: result.count };
}

// ─── Reading — the best-ranked observation set per material, for the drift view ───────────

export interface MaterialObservationSummary {
  materialId: string;
  itemId: string | null;
  supplier: string | null;
  /** Average unitCost across only the HIGHEST-ranked matchMethod present for this material — a
   * barcode/sku-matched price and a name-guessed price for the same item are not averaged
   * together; the trustworthy one wins outright. */
  avgUnitCost: number;
  matchMethod: MatchMethod;
  count: number;
}

/**
 * Groups observations by material, keeping only the best-ranked `matchMethod` present for each
 * (barcode/sku beat name_fuzzy for the SAME item, per the plan) and averaging that group's
 * unitCost. Callers pass whichever observation rows they've already fetched (e.g. financials.ts
 * scopes to a set of receiptIds); this function does no querying itself.
 */
export interface ObservationForSummary {
  materialId: string;
  itemId: string | null;
  supplier: string | null;
  unitCost: number;
  matchMethod: string;
}

export function summarizeObservationsByMaterial(observations: ObservationForSummary[]): MaterialObservationSummary[] {
  const byMaterial = new Map<string, typeof observations>();
  for (const obs of observations) {
    const list = byMaterial.get(obs.materialId) ?? [];
    list.push(obs);
    byMaterial.set(obs.materialId, list);
  }
  const out: MaterialObservationSummary[] = [];
  for (const [materialId, rows] of byMaterial) {
    const bestRank = Math.max(...rows.map((r) => rankMatchMethod(r.matchMethod as MatchMethod)));
    const best = rows.filter((r) => rankMatchMethod(r.matchMethod as MatchMethod) === bestRank);
    const avg = best.reduce((sum, r) => sum + r.unitCost, 0) / best.length;
    out.push({
      materialId,
      itemId: best[0].itemId,
      supplier: best[0].supplier,
      avgUnitCost: Math.round(avg * 100) / 100,
      matchMethod: best[0].matchMethod as MatchMethod,
      count: best.length,
    });
  }
  return out;
}
