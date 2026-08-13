/**
 * Service entry points for atomic-first custom estimates (Phase 2.0).
 *
 * Headless-callable: create a draft, add/edit/remove lines, compute, finalize. No HTTP and no
 * UI — the Phase 2.0 prompt puts screens in a later task, after Kyle rules on whether
 * assemblies survive as seed templates.
 *
 * Everything priced here goes through `atomicEstimateEngine`, which goes through the Phase 1
 * `priceBookPricing` module. One arithmetic, verified once.
 */

import { PrismaClient, type PriceBookDifficulty, type PriceBookQuantitySource } from "@prisma/client";
import {
  computeEstimate,
  finalizeEstimate,
  resolveCatalogAtSupplier,
  type ComputedEstimate,
  type Difficulty,
  type DraftLineInput,
  type EngineAtomic,
  type FinalizeResult,
  type QuantitySource,
} from "./atomicEstimateEngine";
import type { MarkupTiers, RateConfig, SupplierPriceRow } from "./priceBookPricing";

/** Kyle's ruled company-wide billed rate. decisions/2026-08-11-billed-rate-and-no-memberships.md */
export const RULED_BILLED_RATE = 150;

export interface RateContext {
  rc: RateConfig;
  provisional: boolean;
  provisionalReason: string | null;
}

/**
 * Read Rate Config out of the imported catalog and decide whether it is provisional.
 * Identical rule to Phase 1: compare, report, never override.
 */
export async function loadRateContext(prisma: PrismaClient): Promise<RateContext> {
  const rows = await prisma.priceBookRateConfig.findMany();
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const n = (k: string) => byKey.get(k)?.numberValue ?? null;
  const t = (k: string) => byKey.get(k)?.textValue ?? null;

  const tiers: MarkupTiers = {
    tier1: n("markupTier1") ?? 0,
    tier2: n("markupTier2") ?? 0,
    tier3: n("markupTier3") ?? 0,
    tier4: n("markupTier4") ?? 0,
    tier5: n("markupTier5") ?? 0,
  };

  const billed = n("billedLaborRate");
  let provisional = false;
  let provisionalReason: string | null = null;
  if (billed === null) {
    provisional = true;
    provisionalReason = "Rate Config B2 is blank — no labour rate is available.";
  } else if (Math.abs(billed - RULED_BILLED_RATE) > 1e-9) {
    provisional = true;
    provisionalReason =
      `Rate Config B2 reads $${billed.toFixed(2)}/hr. Kyle's standing ruling is ` +
      `$${RULED_BILLED_RATE.toFixed(2)}/hr. Imported as found; not overridden.`;
  }

  return {
    rc: {
      billedLaborRate: billed,
      inspectionCoordination: n("inspectionCoordination"),
      inspectionFolded: n("inspectionFolded"),
      utilityStandby: n("utilityStandby"),
      permitFee: n("permitFee"),
      jobFixedCost: n("jobFixedCost"),
      activeSupplier: t("activeSupplier"),
      markupTiers: tiers,
    },
    provisional,
    provisionalReason,
  };
}

/**
 * Load the atomic catalog with cost resolved at ONE supplier — the one the tech picked.
 * No fallback to any other supplier is possible from here, by construction.
 */
export async function loadCatalogAtSupplier(
  prisma: PrismaClient,
  supplierId: string,
  tiers: MarkupTiers
): Promise<Map<string, EngineAtomic>> {
  const atomics = await prisma.priceBookAtomic.findMany({
    where: { retiredAt: null },
    select: {
      itemId: true,
      description: true,
      unit: true,
      rowType: true,
      laborNormal: true,
      laborDifficult: true,
      laborVeryDifficult: true,
      laborUnitBasis: true,
      laborUnitDivisor: true,
      laborUnitBasisRaw: true,
      necaUnitBasis: true,
    },
  });

  const prices = await prisma.priceBookSupplierPrice.findMany({
    select: { itemId: true, supplierId: true, unitCost: true, quotable: true, quotableKey: true },
  });
  const supplierPrices: SupplierPriceRow[] = prices.map((p) => ({
    itemId: p.itemId,
    supplierId: p.supplierId,
    unitCost: p.unitCost,
    quotable: p.quotable as SupplierPriceRow["quotable"],
    quotableKey: p.quotableKey,
  }));

  const engineAtomics: EngineAtomic[] = atomics.map((a) => ({
    ...a,
    costBasisUsed: null,
    sellPricePerUnit: null,
  }));

  return resolveCatalogAtSupplier(engineAtomics, supplierPrices, supplierId, tiers);
}

// ─── Draft CRUD ─────────────────────────────────────────────────────────────────

export interface CreateDraftInput {
  title: string;
  supplierId: string;
  jobDescription?: string | null;
  scenarioRef?: string | null;
  notes?: string | null;
}

export async function createDraft(prisma: PrismaClient, input: CreateDraftInput) {
  const supplier = await prisma.priceBookSupplier.findUnique({ where: { id: input.supplierId } });
  if (!supplier) {
    throw new Error(
      `Supplier ${input.supplierId} is not in the imported registry. A draft cannot be priced ` +
        `against a supplier the book does not know.`
    );
  }
  // The quarantine reaches this far forward: an estimate may not even be OPENED against a
  // non-quotable account. Structural, not a late check at finalize time.
  if (supplier.quotable !== "YES") {
    throw new Error(
      `Supplier ${input.supplierId} is not quotable (${supplier.quotableRaw ?? supplier.quotable}). ` +
        `Employer-account and no-account suppliers are quarantined and cannot price customer work.`
    );
  }

  const { rc, provisional, provisionalReason } = await loadRateContext(prisma);
  return prisma.priceBookDraftEstimate.create({
    data: {
      title: input.title,
      supplierId: input.supplierId,
      jobDescription: input.jobDescription ?? null,
      scenarioRef: input.scenarioRef ?? null,
      notes: input.notes ?? null,
      billedLaborRate: rc.billedLaborRate,
      rateProvisional: provisional,
      provisionalReason,
    },
  });
}

export interface AddLineInput {
  itemId: string;
  quantity: number;
  quantitySource: QuantitySource;
  difficulty?: Difficulty;
  location?: string | null;
  note?: string | null;
  sortOrder?: number;
}

export async function addLine(prisma: PrismaClient, draftId: string, line: AddLineInput) {
  const draft = await prisma.priceBookDraftEstimate.findUnique({ where: { id: draftId } });
  if (!draft) throw new Error(`Draft ${draftId} not found.`);
  if (draft.status !== "draft") {
    throw new Error(`Draft ${draftId} is ${draft.status}; finalized estimates are not edited in place.`);
  }
  if (!Number.isFinite(line.quantity) || line.quantity <= 0) {
    throw new Error(
      `Quantity for ${line.itemId} must be a positive number (got ${line.quantity}). A zero or ` +
        `negative quantity is not a priced line.`
    );
  }
  const atomic = await prisma.priceBookAtomic.findUnique({ where: { itemId: line.itemId } });
  if (!atomic) {
    throw new Error(
      `${line.itemId} is not in the atomic catalog. If this is a NECA-backed item with no atomic ` +
        `row yet, it must be created in the workbook first — the app does not invent catalog rows.`
    );
  }

  return prisma.priceBookDraftLine.create({
    data: {
      draftId,
      itemId: line.itemId,
      quantity: line.quantity,
      quantitySource: line.quantitySource as PriceBookQuantitySource,
      difficulty: (line.difficulty ?? "NORMAL") as PriceBookDifficulty,
      location: line.location ?? null,
      note: line.note ?? null,
      sortOrder: line.sortOrder ?? 0,
    },
  });
}

export async function editLine(
  prisma: PrismaClient,
  lineId: string,
  patch: Partial<Omit<AddLineInput, "itemId">>
) {
  const existing = await prisma.priceBookDraftLine.findUnique({
    where: { id: lineId },
    include: { draft: true },
  });
  if (!existing) throw new Error(`Line ${lineId} not found.`);
  if (existing.draft.status !== "draft") {
    throw new Error(`Draft ${existing.draftId} is ${existing.draft.status}; its lines are not editable.`);
  }
  if (patch.quantity !== undefined && (!Number.isFinite(patch.quantity) || patch.quantity <= 0)) {
    throw new Error(`Quantity must be a positive number (got ${patch.quantity}).`);
  }
  return prisma.priceBookDraftLine.update({
    where: { id: lineId },
    data: {
      quantity: patch.quantity,
      quantitySource: patch.quantitySource as PriceBookQuantitySource | undefined,
      difficulty: patch.difficulty as PriceBookDifficulty | undefined,
      location: patch.location,
      note: patch.note,
      sortOrder: patch.sortOrder,
    },
  });
}

export async function removeLine(prisma: PrismaClient, lineId: string) {
  return prisma.priceBookDraftLine.delete({ where: { id: lineId } });
}

// ─── Compute / finalize ─────────────────────────────────────────────────────────

export async function computeDraft(
  prisma: PrismaClient,
  draftId: string
): Promise<{ computed: ComputedEstimate; rate: RateContext; atomics: Map<string, EngineAtomic> }> {
  const draft = await prisma.priceBookDraftEstimate.findUnique({
    where: { id: draftId },
    include: { lines: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] } },
  });
  if (!draft) throw new Error(`Draft ${draftId} not found.`);

  const rate = await loadRateContext(prisma);
  const atomics = await loadCatalogAtSupplier(prisma, draft.supplierId, rate.rc.markupTiers);

  const inputs: DraftLineInput[] = draft.lines.map((l) => ({
    id: l.id,
    itemId: l.itemId,
    quantity: l.quantity,
    quantitySource: l.quantitySource as QuantitySource,
    difficulty: l.difficulty as Difficulty,
    location: l.location,
    note: l.note,
  }));

  return {
    computed: computeEstimate(inputs, atomics, rate.rc, draft.supplierId),
    rate,
    atomics,
  };
}

export async function finalizeDraft(
  prisma: PrismaClient,
  draftId: string,
  context: "customer" | "internal" = "customer"
): Promise<FinalizeResult> {
  const { computed, rate, atomics } = await computeDraft(prisma, draftId);
  const result = finalizeEstimate(computed, atomics, {
    context,
    rateProvisional: rate.provisional,
    provisionalReason: rate.provisionalReason,
  });

  // Only a genuinely clean, customer-context finalize changes state. An internal computation
  // is a look, not a commitment.
  if (result.finalized && context === "customer") {
    await prisma.priceBookDraftEstimate.update({
      where: { id: draftId },
      data: { status: "finalized", finalizedAt: new Date() },
    });
  }
  return result;
}
