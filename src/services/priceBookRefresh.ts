/**
 * The monthly supplier-price refresh (2026-09-12, barcode/materials plan Unit 5).
 *
 * THE GOVERNING RULE: the price book is NEVER written automatically. Kyle, 2026-09-12:
 * "Automatic as in it will review and give me a monthly proposal that I review." A scheduled job
 * PROPOSES a candidate cost per (item, supplier); Kyle ACCEPTS one proposal line at a time through
 * `acceptPriceProposalLine`, which is the only writer this file has to `PriceBookAtomic`.
 * `buildPriceProposal` / `runMonthlyPriceRefresh` never call `.create`, `.update` or `.upsert` on
 * `priceBookAtomic` — only `.findMany`/`.findUnique` — so a dry run is structural, not a flag
 * someone can forget to pass.
 *
 * RETARGETED 2026-09-13 (Kyle's ruling). This file originally wrote
 * `PriceBookSupplierPrice.unitCost` on accept. That is the wrong number for Kyle's book:
 * `atomicEstimateService.ts` resolves an item's cost as `costBasisUsed: a.companyCost ?? null` —
 * "Kyle's rows arrive already priced by his own sheet; everything else resolves at the supplier
 * below" — so `companyCost` wins whenever it is set, which is every item Kyle creates through
 * "+ New item." `computeComponentRollup` (priceBookAssembly.ts) reads `companyCost` and nothing
 * else, so assemblies are driven entirely by it too. Writing `PriceBookSupplierPrice` therefore
 * changed NONE of Kyle's actual prices. Accepting now writes `companyCost`, through
 * `updateAtomic`'s guarded, book-math-aware path (priceBookCatalog.ts) — never a raw Prisma
 * update — so `companyPrice` and the three `sell*` columns are recomputed the same way every other
 * edit recomputes them. `PriceBookSupplierPrice` is no longer written anywhere in this file; the
 * assembly guard Unit 5 was told to add there is therefore moot (that table still has no runtime
 * writer in src/), but `assertNotAssembly` stays on the accept path regardless — an assembly must
 * never be typed a cost directly (priceBookCatalog.ts's own guard would refuse it besides).
 *
 * THE CASCADE. An assembly's `companyCost` is STORED, not computed on read (`createAssembly` /
 * `setAssemblyComponents` write `rollup.companyCost` once; nothing recomputes it when a
 * COMPONENT's cost changes on its own). So accepting a component's new price must, in the SAME
 * transaction as the component's own update, find every assembly containing it
 * (`PriceBookItemComponent.childItemId`), recompute each with `computeComponentRollup` (imported,
 * never reimplemented), and persist the new `companyCost` AND `sell*` columns — otherwise the book
 * would contradict itself, quoting a stale assembly price with nothing to show it. Nesting is
 * impossible (Unit 1 rejects an assembly as a component), so this is exactly one level deep; no
 * recursion. `computeAssemblySnapshot` below is the ONE function that does this arithmetic — both
 * the preview (`findAssemblyImpacts`) and the actual cascade (inside `acceptPriceProposalLine`'s
 * transaction) call it, so "accepting this moves 3 assemblies, by $X" is a promise, not an
 * estimate computed a second way.
 *
 * THE TABLE IS NOT WARM ON ITS OWN. Nothing populates `MaterialPriceObservation` on a schedule
 * (see the schema comment and services/materialPriceObservations.ts) — it only fills today when
 * someone opens the Financials page. `runMonthlyPriceRefresh` therefore ingests confirmed
 * receipts in the window itself, via `recordObservationsForReceipt` (Unit 4's idempotent-per-
 * receipt writer), BEFORE summarising. `source: "po_line"` has no producer yet (`PurchaseOrderLine`
 * carries `itemId`/`unitCost` but no `materialId`) — this file does not invent one; it works with
 * receipt-derived observations only, same as the rest of Unit 4.
 *
 * MEDIAN, NOT MEAN, PLUS A MINIMUM COUNT. `MIN_OBSERVATIONS_FOR_PROPOSAL = 3`: the smallest count
 * for which a median is the untouched MIDDLE value and so is structurally immune to a single
 * outlier at either extreme (a mis-parsed Vision line reading $1,197 for $11.97 cannot become the
 * median of 3+ real observations sitting near $11.97, no matter which position it lands in once
 * sorted). Fewer than 3 observations produces no proposal line at all — there is nothing to
 * average safely.
 *
 * BARCODE/SKU OUTRANKS NAME_FUZZY. Reuses `MATCH_METHOD_RANK` from materialPriceObservations.ts
 * (never a second ranking): within a group, only the observations sharing the single
 * highest-ranked `matchMethod` present count toward the minimum and the median — an item with
 * exact-code evidence never has its number diluted by a substring guess.
 *
 * THE ASSEMBLY GUARD. `assertNotAssembly` (priceBookAssembly.ts) is reused, never reimplemented,
 * in `acceptPriceProposalLine`, and `buildPriceProposal` independently skips any itemId that
 * resolves to an ASSEMBLY row before it ever reaches the median step — an assembly must never be
 * proposed a cost in the first place, not merely refused at accept time.
 */

import type { PrismaClient } from "@prisma/client";
import {
  MATCH_METHOD_RANK,
  OBSERVATION_RETENTION_DAYS,
  recordObservationsForReceipt,
  type MatchMethod,
} from "./materialPriceObservations";
import {
  assertNotAssembly,
  AssemblyGuardError,
  computeComponentRollup,
  isAssemblyRowType,
  LABOR_TIERS,
  ASSEMBLY_ROW_TYPE,
  type ComponentAtomicFacts,
  type ComponentInput,
  type LaborTier,
} from "./priceBookAssembly";
import {
  applyAtomicUpdatePlan,
  computePricing,
  loadPricingContext,
  planAtomicUpdate,
} from "./priceBookCatalog";
import type { MarkupTiers } from "./priceBookPricing";

export const MIN_OBSERVATIONS_FOR_PROPOSAL = 3;

const round2 = (n: number) => Math.round(n * 100) / 100;

function rankOf(method: string): number {
  return MATCH_METHOD_RANK[method as MatchMethod] ?? 0;
}

/** The untouched middle value once sorted — never an average of two values that straddle an
 * outlier by more than one position, which is what makes it resistant at n=3 (see file header). */
export function median(values: number[]): number {
  if (values.length === 0) throw new Error("median() requires at least one value.");
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) return round2((sorted[mid - 1] + sorted[mid]) / 2);
  return round2(sorted[mid]);
}

// ─── Ingest — the table is not warm on its own ─────────────────────────────────────────────

export interface IngestResult {
  receiptsIngested: number;
  observationsCreated: number;
}

/**
 * Populate `MaterialPriceObservation` from every CONFIRMED receipt whose `receivedAt` falls in
 * the window, via Unit 4's idempotent `recordObservationsForReceipt`. Must run before
 * `buildPriceProposal` — nothing else fills this table on a schedule.
 */
export async function ingestConfirmedReceiptsInWindow(
  prisma: PrismaClient,
  windowStart: Date,
  windowEnd: Date,
): Promise<IngestResult> {
  const receipts = await prisma.receipt.findMany({
    where: { status: "confirmed", receivedAt: { gte: windowStart, lte: windowEnd } },
    select: { id: true, vendor: true, lineItems: true, receivedAt: true },
  });
  let observationsCreated = 0;
  for (const receipt of receipts) {
    const result = await recordObservationsForReceipt(prisma, receipt);
    observationsCreated += result.created;
  }
  return { receiptsIngested: receipts.length, observationsCreated };
}

// ─── Assembly cascade / preview — ONE computation shared by both ───────────────────────────

async function fetchFactsMap(prisma: PrismaClient, itemIds: string[]): Promise<Map<string, ComponentAtomicFacts>> {
  if (itemIds.length === 0) return new Map();
  const rows = await prisma.priceBookAtomic.findMany({
    where: { itemId: { in: itemIds } },
    select: {
      itemId: true, description: true, rowType: true, companyCost: true,
      laborNormal: true, laborDifficult: true, laborVeryDifficult: true, laborUnitDivisor: true,
    },
  });
  return new Map(rows.map((r) => [r.itemId, r as ComponentAtomicFacts]));
}

export interface AssemblyPricingSnapshot {
  /** Null = incomplete (a component is unpriced) — never a summed zero, same rule as Unit 1. */
  companyCost: number | null;
  costComplete: boolean;
  markupTier: string;
  companyPrice: number | null;
  sellNormal: number | null;
  sellDifficult: number | null;
  sellVeryDifficult: number | null;
  laborNormal: number | null;
  laborDifficult: number | null;
  laborVeryDifficult: number | null;
}

interface AssemblySnapshotResult {
  parent: { itemId: string; description: string | null; companyCost: number | null };
  snapshot: AssemblyPricingSnapshot;
}

/**
 * The full rollup + book-pricing recompute for one assembly, optionally substituting a
 * companyCost for one or more components without touching the database (`componentOverrides`).
 * This is the SINGLE function both `findAssemblyImpacts` (a preview, called with an override) and
 * `acceptPriceProposalLine`'s cascade (called with no override, reading the component's
 * already-updated live value from inside the same transaction) use — "accepting this moves 3
 * assemblies, by $X" is therefore computed identically to what accepting actually does, never a
 * second implementation of the same arithmetic.
 *
 * Returns null when `parentItemId` does not name a live ASSEMBLY row (defensive: no-nesting
 * already guarantees a parent found via PriceBookItemComponent.parentItemId is a real assembly,
 * but a membership row could in principle outlive its parent).
 */
async function computeAssemblySnapshot(
  prisma: PrismaClient,
  parentItemId: string,
  componentOverrides: Map<string, number>,
  tiers: MarkupTiers,
  rate: number,
): Promise<AssemblySnapshotResult | null> {
  const parent = await prisma.priceBookAtomic.findUnique({ where: { itemId: parentItemId } });
  if (!parent || !isAssemblyRowType(parent.rowType)) return null;

  const componentRows = await prisma.priceBookItemComponent.findMany({
    where: { parentItemId },
    select: { childItemId: true, quantity: true },
  });
  const inputs: ComponentInput[] = componentRows.map((c) => ({ childItemId: c.childItemId, quantity: c.quantity }));
  const facts = await fetchFactsMap(prisma, componentRows.map((c) => c.childItemId));
  for (const [itemId, companyCost] of componentOverrides) {
    const fact = facts.get(itemId);
    if (fact) facts.set(itemId, { ...fact, companyCost });
  }

  const rollup = computeComponentRollup(inputs, facts);

  // Labour follows the components UNLESS Kyle has overridden that tier (priceBookAssembly.ts's
  // own convention — the override flag is never inferred, only ever read).
  const laborFinal: Record<LaborTier, number | null> = {
    laborNormal: parent.laborNormal,
    laborDifficult: parent.laborDifficult,
    laborVeryDifficult: parent.laborVeryDifficult,
  };
  for (const tier of LABOR_TIERS) {
    const overridden = (parent as Record<string, unknown>)[`${tier}Overridden`] as boolean;
    if (!overridden) laborFinal[tier] = rollup.labor[tier].value;
  }

  const computed = computePricing(
    { rowType: ASSEMBLY_ROW_TYPE, companyCost: rollup.companyCost, ...laborFinal },
    tiers,
    rate,
  );

  return {
    parent: { itemId: parent.itemId, description: parent.description, companyCost: parent.companyCost },
    snapshot: {
      companyCost: rollup.companyCost,
      costComplete: rollup.costComplete,
      ...computed,
      ...laborFinal,
    },
  };
}

export interface AssemblyImpact {
  assemblyItemId: string;
  assemblyDescription: string | null;
  currentCost: number | null;
  projectedCost: number | null;
  delta: number | null;
  currentCompanyPrice: number | null;
  projectedCompanyPrice: number | null;
  currentSellNormal: number | null;
  projectedSellNormal: number | null;
  currentSellDifficult: number | null;
  projectedSellDifficult: number | null;
  currentSellVeryDifficult: number | null;
  projectedSellVeryDifficult: number | null;
}

/**
 * Every assembly containing `changedItemId` as a component, current vs. a preview with that
 * component's companyCost swapped for `candidateUnitCost`. Reuses `computeAssemblySnapshot` for
 * both sides — this function only decides WHICH assemblies to look at and shapes the diff; it
 * does no rollup or pricing arithmetic of its own.
 */
export async function findAssemblyImpacts(
  prisma: PrismaClient,
  changedItemId: string,
  candidateUnitCost: number,
): Promise<AssemblyImpact[]> {
  const memberships = await prisma.priceBookItemComponent.findMany({
    where: { childItemId: changedItemId },
    select: { parentItemId: true },
  });
  const parentIds = [...new Set(memberships.map((m) => m.parentItemId))];
  if (parentIds.length === 0) return [];

  const { tiers, rate } = await loadPricingContext(prisma);
  const impacts: AssemblyImpact[] = [];
  for (const parentItemId of parentIds) {
    const current = await computeAssemblySnapshot(prisma, parentItemId, new Map(), tiers, rate);
    if (!current) continue;
    const projected = await computeAssemblySnapshot(
      prisma,
      parentItemId,
      new Map([[changedItemId, candidateUnitCost]]),
      tiers,
      rate,
    );
    if (!projected) continue;

    impacts.push({
      assemblyItemId: parentItemId,
      assemblyDescription: current.parent.description,
      currentCost: current.snapshot.companyCost,
      projectedCost: projected.snapshot.companyCost,
      delta:
        current.snapshot.companyCost !== null && projected.snapshot.companyCost !== null
          ? round2(projected.snapshot.companyCost - current.snapshot.companyCost)
          : null,
      currentCompanyPrice: current.snapshot.companyPrice,
      projectedCompanyPrice: projected.snapshot.companyPrice,
      currentSellNormal: current.snapshot.sellNormal,
      projectedSellNormal: projected.snapshot.sellNormal,
      currentSellDifficult: current.snapshot.sellDifficult,
      projectedSellDifficult: projected.snapshot.sellDifficult,
      currentSellVeryDifficult: current.snapshot.sellVeryDifficult,
      projectedSellVeryDifficult: projected.snapshot.sellVeryDifficult,
    });
  }
  return impacts;
}

// ─── Building the proposal — read-only, never writes PriceBookAtomic ──────────────────────

export interface ProposalLine {
  itemId: string;
  itemDescription: string | null;
  supplierName: string;
  observationCount: number;
  matchMethod: MatchMethod;
  windowStart: Date;
  windowEnd: Date;
  candidateUnitCost: number;
  /** The item's current PriceBookAtomic.companyCost — the number this proposal would actually
   * change on accept (2026-09-13 retarget). Null when the item has never been priced. */
  currentCompanyCost: number | null;
  /** candidateUnitCost - currentCompanyCost, null when there is no current cost to compare against. */
  delta: number | null;
  /** false only when a current cost exists and is already within a cent of the candidate. */
  changed: boolean;
  affectedAssemblies: AssemblyImpact[];
}

export interface PriceProposal {
  generatedAt: Date;
  windowStart: Date;
  windowEnd: Date;
  minObservations: number;
  lines: ProposalLine[];
  /** itemIds skipped because they resolved to an ASSEMBLY row — an assembly is never purchasable
   * and must never be proposed a cost directly (Unit 1's fourth guard, closed here). */
  skippedAssemblyItemIds: string[];
}

export interface BuildProposalOptions {
  now?: Date;
  windowDays?: number;
}

/**
 * Read-only. Groups the window's observations by (itemId, supplier name), keeps only the
 * highest-ranked matchMethod present per group, requires MIN_OBSERVATIONS_FOR_PROPOSAL of those,
 * and computes the median. Never touches `priceBookAtomic` beyond `findUnique`/`findMany`.
 */
export async function buildPriceProposal(prisma: PrismaClient, opts: BuildProposalOptions = {}): Promise<PriceProposal> {
  const windowEnd = opts.now ?? new Date();
  const windowDays = opts.windowDays ?? OBSERVATION_RETENTION_DAYS;
  const windowStart = new Date(windowEnd.getTime() - windowDays * 86_400_000);

  const observations = await prisma.materialPriceObservation.findMany({
    where: { observedAt: { gte: windowStart, lte: windowEnd }, itemId: { not: null }, supplier: { not: null } },
    select: { itemId: true, supplier: true, unitCost: true, matchMethod: true },
  });

  type GroupRow = { unitCost: number; matchMethod: string };
  const groups = new Map<string, { itemId: string; supplierName: string; rows: GroupRow[] }>();
  for (const obs of observations) {
    if (!obs.itemId || !obs.supplier) continue;
    const supplierName = obs.supplier.trim();
    if (!supplierName) continue;
    const key = `${obs.itemId}::${supplierName.toLowerCase()}`;
    const g = groups.get(key) ?? { itemId: obs.itemId, supplierName, rows: [] };
    g.rows.push({ unitCost: obs.unitCost, matchMethod: obs.matchMethod });
    groups.set(key, g);
  }

  const lines: ProposalLine[] = [];
  const skippedAssemblyItemIds = new Set<string>();

  for (const { itemId, supplierName, rows } of groups.values()) {
    const atomic = await prisma.priceBookAtomic.findUnique({
      where: { itemId },
      select: { description: true, rowType: true, companyCost: true },
    });
    // GUARD: an assembly must never be proposed a cost directly. Skipped before the median step,
    // not merely refused at accept time.
    if (atomic && isAssemblyRowType(atomic.rowType)) {
      skippedAssemblyItemIds.add(itemId);
      continue;
    }

    const bestRank = Math.max(...rows.map((r) => rankOf(r.matchMethod)));
    const best = rows.filter((r) => rankOf(r.matchMethod) === bestRank);
    if (best.length < MIN_OBSERVATIONS_FOR_PROPOSAL) continue;

    const candidateUnitCost = median(best.map((r) => r.unitCost));
    const currentCompanyCost = atomic?.companyCost ?? null;
    const delta = currentCompanyCost !== null ? round2(candidateUnitCost - currentCompanyCost) : null;
    const changed = currentCompanyCost === null || Math.abs(delta ?? 0) > 0.005;

    const affectedAssemblies = await findAssemblyImpacts(prisma, itemId, candidateUnitCost);

    lines.push({
      itemId,
      itemDescription: atomic?.description ?? null,
      supplierName,
      observationCount: best.length,
      matchMethod: best[0].matchMethod as MatchMethod,
      windowStart,
      windowEnd,
      candidateUnitCost,
      currentCompanyCost,
      delta,
      changed,
      affectedAssemblies,
    });
  }

  return {
    generatedAt: windowEnd,
    windowStart,
    windowEnd,
    minObservations: MIN_OBSERVATIONS_FOR_PROPOSAL,
    lines,
    skippedAssemblyItemIds: [...skippedAssemblyItemIds],
  };
}

/**
 * The cron entry point AND the dry-run entry point — the same function, because ingest +
 * summarise never writes a price either way. Ingest first (the table is not warm on its own),
 * then build the proposal from what is now on hand.
 */
export async function runMonthlyPriceRefresh(
  prisma: PrismaClient,
  opts: BuildProposalOptions = {},
): Promise<{ ingest: IngestResult; proposal: PriceProposal }> {
  const windowEnd = opts.now ?? new Date();
  const windowDays = opts.windowDays ?? OBSERVATION_RETENTION_DAYS;
  const windowStart = new Date(windowEnd.getTime() - windowDays * 86_400_000);

  const ingest = await ingestConfirmedReceiptsInWindow(prisma, windowStart, windowEnd);
  const proposal = await buildPriceProposal(prisma, { now: windowEnd, windowDays });
  return { ingest, proposal };
}

// ─── Accepting — the ONLY write path in this file ──────────────────────────────────────────

export interface AcceptProposalInput {
  itemId: string;
  supplierName: string;
  windowDays?: number;
  now?: Date;
}

export interface CascadedAssembly {
  assemblyItemId: string;
  assemblyDescription: string | null;
  priorCompanyCost: number | null;
  companyCost: number | null;
  companyPrice: number | null;
  sellNormal: number | null;
  sellDifficult: number | null;
  sellVeryDifficult: number | null;
}

export type AcceptProposalResult =
  | {
      ok: true;
      itemId: string;
      companyCost: number;
      priorCompanyCost: number | null;
      /** Every assembly whose stored companyCost/sell* moved in this same transaction because it
       * contains `itemId` as a component. Empty when the item is not used in any assembly, or
       * when the accepted cost turned out to equal what was already stored (nothing to cascade). */
      cascadedAssemblies: CascadedAssembly[];
    }
  | { ok: false; reason: string };

/**
 * Recomputes the SAME evidence-gated candidate a proposal line would show — never trusts a
 * client-supplied number — and only then writes the item's `companyCost` (+ the book's
 * `companyPrice`/`sell*` recompute) through `updateAtomic`'s guarded path, and cascades that same
 * change into every assembly containing the item, all in ONE transaction. If the transaction
 * fails, nothing moves — a partial cascade that updates the component but not its assemblies would
 * be worse than no change at all.
 *
 * Guards, in order: assembly (reused `assertNotAssembly`, never a second check) before minimum
 * observation count, because "it's an assembly" is the more fundamental refusal. `updateAtomic`'s
 * own guard (priceBookCatalog.ts) would also refuse a companyCost patch on an assembly row, but
 * `assertNotAssembly` up front gives the clearer, assembly-specific message.
 */
export async function acceptPriceProposalLine(
  prisma: PrismaClient,
  input: AcceptProposalInput,
  editedBy: string,
): Promise<AcceptProposalResult> {
  try {
    await assertNotAssembly(prisma, input.itemId, "receive an accepted proposal price");
  } catch (err) {
    if (err instanceof AssemblyGuardError) return { ok: false, reason: err.message };
    throw err;
  }

  const windowEnd = input.now ?? new Date();
  const windowDays = input.windowDays ?? OBSERVATION_RETENTION_DAYS;
  const windowStart = new Date(windowEnd.getTime() - windowDays * 86_400_000);
  const supplierName = input.supplierName.trim();
  if (!supplierName) return { ok: false, reason: "supplierName is required." };

  const observations = await prisma.materialPriceObservation.findMany({
    where: {
      itemId: input.itemId,
      supplier: { equals: supplierName, mode: "insensitive" },
      observedAt: { gte: windowStart, lte: windowEnd },
    },
    select: { unitCost: true, matchMethod: true },
  });
  const bestRank = observations.length > 0 ? Math.max(...observations.map((r) => rankOf(r.matchMethod))) : 0;
  const best = observations.filter((r) => rankOf(r.matchMethod) === bestRank);
  if (best.length < MIN_OBSERVATIONS_FOR_PROPOSAL) {
    return {
      ok: false,
      reason: `Only ${best.length} evidence-ranked observation(s) for ${input.itemId} / ${supplierName} in the last ${windowDays} days — need at least ${MIN_OBSERVATIONS_FOR_PROPOSAL}.`,
    };
  }
  const companyCost = median(best.map((r) => r.unitCost));

  return prisma.$transaction(async (tx) => {
    const txClient = tx as unknown as PrismaClient;

    const existingAtomic = await tx.priceBookAtomic.findUnique({
      where: { itemId: input.itemId },
      select: { companyCost: true },
    });
    if (!existingAtomic) return { ok: false as const, reason: `Item ${input.itemId} not found.` };
    const priorCompanyCost = existingAtomic.companyCost;

    // THE COMPONENT'S OWN UPDATE — through updateAtomic's guarded, book-math-aware path (never a
    // raw Prisma update), so companyPrice and sell* recompute the same way every other edit does.
    const planResult = await planAtomicUpdate(txClient, input.itemId, { companyCost });
    if (!planResult.ok) return { ok: false as const, reason: planResult.reason };

    const cascadedAssemblies: CascadedAssembly[] = [];

    if (!planResult.noop) {
      await applyAtomicUpdatePlan(txClient, input.itemId, planResult.plan, editedBy);
      await tx.priceBookEdit.create({
        data: {
          itemId: input.itemId,
          field: "priceProposalAccepted",
          oldValue: priorCompanyCost === null ? null : String(priorCompanyCost),
          newValue: String(companyCost),
          editedBy,
          note: `Accepted monthly proposal (${supplierName}): ${best.length} observation(s), matchMethod rank ${bestRank}, window ${windowEnd.toISOString().slice(0, 10)} minus ${windowDays}d.`,
        },
      });

      // THE CASCADE — same transaction as the component's own update above. Every assembly
      // containing this item as a component has its stored companyCost/sell* recomputed via
      // computeAssemblySnapshot (the SAME function findAssemblyImpacts uses for the preview), read
      // live from `tx` so it reflects the companyCost write just made.
      const memberships = await tx.priceBookItemComponent.findMany({
        where: { childItemId: input.itemId },
        select: { parentItemId: true },
      });
      const parentIds = [...new Set(memberships.map((m) => m.parentItemId))];
      if (parentIds.length > 0) {
        const { tiers, rate } = await loadPricingContext(txClient);
        for (const parentItemId of parentIds) {
          const result = await computeAssemblySnapshot(txClient, parentItemId, new Map(), tiers, rate);
          if (!result) continue;
          const priorAssemblyCost = result.parent.companyCost;
          const snap = result.snapshot;

          await tx.priceBookAtomic.update({
            where: { itemId: parentItemId },
            data: {
              companyCost: snap.companyCost,
              markupTier: snap.markupTier,
              companyPrice: snap.companyPrice,
              sellNormal: snap.sellNormal,
              sellDifficult: snap.sellDifficult,
              sellVeryDifficult: snap.sellVeryDifficult,
              laborNormal: snap.laborNormal,
              laborDifficult: snap.laborDifficult,
              laborVeryDifficult: snap.laborVeryDifficult,
            },
          });
          await tx.priceBookEdit.create({
            data: {
              itemId: parentItemId,
              field: "companyCost",
              oldValue: priorAssemblyCost === null ? null : String(priorAssemblyCost),
              newValue: snap.companyCost === null ? null : String(snap.companyCost),
              editedBy,
              note: `Cascaded: component ${input.itemId}'s accepted proposal price changed this assembly's rollup.`,
            },
          });

          cascadedAssemblies.push({
            assemblyItemId: parentItemId,
            assemblyDescription: result.parent.description,
            priorCompanyCost: priorAssemblyCost,
            companyCost: snap.companyCost,
            companyPrice: snap.companyPrice,
            sellNormal: snap.sellNormal,
            sellDifficult: snap.sellDifficult,
            sellVeryDifficult: snap.sellVeryDifficult,
          });
        }
      }
    }

    return {
      ok: true as const,
      itemId: input.itemId,
      companyCost,
      priorCompanyCost,
      cascadedAssemblies,
    };
  });
}
