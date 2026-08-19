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
  rowTypeSells,
  type ComputedEstimate,
  type Difficulty,
  type DraftLineInput,
  type EngineAtomic,
  type FinalizeResult,
  type QuantitySource,
  type EstimateOption,
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
      // Kyle's catalog (P030): the authoritative customer prices per difficulty.
      source: true,
      sellNormal: true,
      sellDifficult: true,
      sellVeryDifficult: true,
      companyCost: true,
      companyPrice: true,
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
    // Kyle's rows arrive already priced by his own sheet; everything else resolves at the
    // supplier below.
    costBasisUsed: a.companyCost ?? null,
    sellPricePerUnit: a.companyPrice ?? null,
  }));

  return resolveCatalogAtSupplier(engineAtomics, supplierPrices, supplierId, tiers);
}

// ─── Catalog browse — the ONE read path for "what is in the catalog" ────────────
//
// P014 (T1 + T2). Before this, three surfaces answered "what atomics exist?": the price-book
// intake API, the legacy `GET /atomic-units` route, and the `query_atomic_units` MCP tool — and
// the last two read the stale `AtomicUnit` table, so the catalog the AI proposed from was not the
// catalog the engine prices from. They now all land here.
//
// This is a browse/search projection, deliberately NOT `loadCatalogAtSupplier()`. That function
// resolves cost at one supplier and is the pricing path; this one answers "does this item exist
// and what does the workbook publish for it" without pricing anything. Keeping them separate is
// what stops a browse screen from quietly becoming a second pricing implementation.

/** The published fields a browse surface may see. No computed dollar leaves this function. */
const BROWSE_SELECT = {
  itemId: true,
  description: true,
  category: true,
  unit: true,
  rowType: true,
  laborNormal: true,
  laborDifficult: true,
  laborVeryDifficult: true,
  laborUnitBasis: true,
  costBasisUsed: true,
  sellPricePerUnit: true,
  necArticle: true,
} as const;

export interface BrowseAtomicsInput {
  /** Free-text match against item code or description. */
  search?: string | null;
  /** NEC article card, e.g. "210". */
  article?: string | null;
  /** The workbook's Category column. */
  category?: string | null;
  limit?: number;
}

export interface BrowsedAtomic {
  itemId: string;
  description: string | null;
  category: string | null;
  unit: string | null;
  rowType: string | null;
  laborNormal: number | null;
  laborDifficult: number | null;
  laborVeryDifficult: number | null;
  laborUnitBasis: string | null;
  costBasisUsed: number | null;
  sellPricePerUnit: number | null;
  necArticle: string | null;
  /**
   * Badges, not judgements. A null labour basis or a missing supplier price does not hide the
   * row — it is shown so a tech sees BEFORE adding a line that it will land incomplete.
   */
  hasLabourUnitBasis: boolean;
  hasPriceAtActiveSupplier: boolean;
  isContinuousLength: boolean;
  /**
   * False when ALL THREE published labour columns are blank — the row can never produce an hour
   * at any difficulty. Distinct from `hasLabourUnitBasis`, which is about a row that HAS hours
   * and cannot scale them. Kyle added DG001 on 2026-08-17 and it showed no warning of any kind,
   * because the only labour badge was guarded on `laborNormal !== null` and DG001's is null.
   */
  hasPublishedLabour: boolean;
  /**
   * Whether the row buys material at all. A `LABOR PRODUCT` (DG001 diagnostics, PT001 tune-up)
   * does not, so "no price at supplier" is not a gap on it and must not be badged as one.
   */
  sellsMaterial: boolean;
  /**
   * Sold by the hour — quantity IS hours. Kyle 2026-08-17: "The diagnostics menu is dictated by
   * hours not quantity and measured, terminations, counted does not apply."
   */
  isHourlyProduct: boolean;
}

function decorate(r: {
  itemId: string; description: string | null; category: string | null; unit: string | null;
  rowType: string | null; laborNormal: number | null; laborDifficult: number | null;
  laborVeryDifficult: number | null; laborUnitBasis: string | null; costBasisUsed: number | null;
  sellPricePerUnit: number | null; necArticle: string | null;
}): BrowsedAtomic {
  return {
    ...r,
    hasLabourUnitBasis: r.laborUnitBasis !== null,
    hasPriceAtActiveSupplier: r.costBasisUsed !== null,
    isContinuousLength: (r.unit ?? "").toLowerCase() === "ft",
    hasPublishedLabour:
      r.laborNormal !== null || r.laborDifficult !== null || r.laborVeryDifficult !== null,
    sellsMaterial: rowTypeSells(r.rowType).material,
    isHourlyProduct: (r.unit ?? "").trim().toLowerCase() === "hr",
  };
}

/**
 * Search/browse the live catalog. Retired rows are excluded — they are kept on disk (move,
 * never delete) but a retired atomic is not proposable, so it is not browsable either.
 */
export async function browseAtomics(
  prisma: PrismaClient,
  input: BrowseAtomicsInput = {}
): Promise<{ atomics: BrowsedAtomic[]; count: number; total: number; truncated: boolean }> {
  const limit = Math.min(Math.max(Number(input.limit ?? 50) || 50, 1), 200);
  const where: Record<string, unknown> = { retiredAt: null };
  if (input.article) where["necArticle"] = { contains: input.article };
  if (input.category) where["category"] = { contains: input.category, mode: "insensitive" };
  if (input.search) {
    where["OR"] = [
      { itemId: { contains: input.search, mode: "insensitive" } },
      { description: { contains: input.search, mode: "insensitive" } },
    ];
  }

  // `count` is how many rows came back; `total` is how many matched. They differ whenever the
  // page cap bites, and the catalog is larger than the cap — so without `total` a caller has no
  // way to know how big the catalog actually is, and "how many items are in the book" is exactly
  // the question a stale hard-coded number (the old "82-unit catalog" string) used to answer
  // wrongly. Cheap query, and it makes the size observable instead of assumed.
  const [rows, total] = await Promise.all([
    prisma.priceBookAtomic.findMany({
      where,
      take: limit,
      orderBy: { itemId: "asc" },
      select: BROWSE_SELECT,
    }),
    prisma.priceBookAtomic.count({ where }),
  ]);

  return {
    atomics: rows.map(decorate),
    count: rows.length,
    total,
    truncated: total > rows.length,
  };
}

/** Single-item lookup by the workbook's own ID (A016, SD002…). Null when absent or retired. */
export async function findAtomicByCode(
  prisma: PrismaClient,
  itemId: string
): Promise<BrowsedAtomic | null> {
  const row = await prisma.priceBookAtomic.findFirst({
    where: { itemId, retiredAt: null },
    select: BROWSE_SELECT,
  });
  return row ? decorate(row) : null;
}

/**
 * True for a code shaped like the LEGACY catalog's code space (LINE-002, TRIM-D01, RI-001).
 *
 * Used only to give a 404 a useful sentence. The two code spaces are disjoint — the workbook
 * speaks A016/SD002 — and a caller still holding a legacy code has a stale integration, not a
 * typo. Saying so beats "not found".
 */
export function looksLikeLegacyCode(code: string): boolean {
  return /^[A-Z]{2,12}-[A-Z0-9]{1,4}$/.test(code.trim().toUpperCase());
}

// ─── Draft CRUD ─────────────────────────────────────────────────────────────────

export interface CreateDraftInput {
  title: string;
  supplierId: string;
  jobDescription?: string | null;
  scenarioRef?: string | null;
  notes?: string | null;
  /**
   * Context (P024, Option A). All optional — the nav entry creates drafts with none of them and
   * must keep working, because Kyle prices speculatively and tests daily.
   *
   * Passing `visitId` is enough: `customerId` is derived from it server-side, since
   * `Visit.customerId` is required and therefore free to read.
   */
  leadId?: string | null;
  customerId?: string | null;
  visitId?: string | null;
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

  // CONTEXT RESOLUTION (P024, Option A).
  //
  // A visit knows its customer (`Visit.customerId` is required), so an entry point that knows the
  // job does not also have to know the account — passing `visitId` is enough.
  //
  // A link that does not resolve is DROPPED, not fatal. The ids arrive in a URL from the legacy
  // estimate page, and a stale or mistyped one must not stop a tech creating a draft: unattached
  // is the working default, so a bad link degrades to it. Without this the foreign key rejects
  // the whole insert, which is the opposite of "additive and reversible".
  const visit = input.visitId
    ? await prisma.visit.findUnique({ where: { id: input.visitId }, select: { id: true, customerId: true } })
    : null;
  const visitId = visit?.id ?? null;

  let customerId = input.customerId ?? visit?.customerId ?? null;
  if (customerId && !(await prisma.customer.findUnique({ where: { id: customerId }, select: { id: true } }))) {
    customerId = null;
  }

  let leadId = input.leadId ?? null;
  if (leadId && !(await prisma.lead.findUnique({ where: { id: leadId }, select: { id: true } }))) {
    leadId = null;
  }

  const { rc, provisional, provisionalReason } = await loadRateContext(prisma);
  return prisma.priceBookDraftEstimate.create({
    data: {
      title: input.title,
      supplierId: input.supplierId,
      jobDescription: input.jobDescription ?? null,
      scenarioRef: input.scenarioRef ?? null,
      notes: input.notes ?? null,
      leadId,
      customerId,
      visitId,
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
  /** Who entered it. Defaults to "human:direct-entry"; the AI can never reach this function. */
  confirmedBy?: string;
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
      // This is the HUMAN path — a person typed this line, so it is confirmed on creation.
      // The schema default is PROPOSED; setting it here is what distinguishes an operator's
      // line from the model's suggestion, and it is set explicitly rather than by default so
      // the distinction survives a future change to that default.
      state: "CONFIRMED",
      confirmedBy: line.confirmedBy ?? "human:direct-entry",
      confirmedAt: new Date(),
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

/**
 * Remove a line from a draft.
 *
 * The finalized guard is the same one `addLine` and `editLine` carry, and it was missing here.
 * That mattered the moment this got a caller: until 2026-08-17 nothing in the UI reached it, so
 * a bare delete was harmless. Kyle then filed "I also have no way to edit or delete an entry
 * already submitted" and the button that answers it goes straight through this function — at
 * which point an unguarded delete would let someone remove a line out of an estimate that had
 * already been issued to a customer, and the price would silently change underneath the quote.
 * A finalized estimate is a record, not a working document.
 */
export async function removeLine(prisma: PrismaClient, lineId: string) {
  const existing = await prisma.priceBookDraftLine.findUnique({
    where: { id: lineId },
    include: { draft: true },
  });
  if (!existing) throw new Error(`Line ${lineId} not found.`);
  if (existing.draft.status !== "draft") {
    throw new Error(
      `Draft ${existing.draftId} is ${existing.draft.status}; its lines are not removable. A ` +
        `finalized estimate is a record of what was quoted — reopen it or start a revision.`
    );
  }
  return prisma.priceBookDraftLine.delete({ where: { id: lineId } });
}

// ─── AI PROPOSALS — the model's only write, and it writes nothing that prices ───────
//
// Kyle's control architecture (projects/red-cedar-crm.md § TECH INTAKE):
//   "The AI proposes, the tech confirms, the engine prices."
// Everything below enforces the first third. The model reaches `proposeLines` and nothing
// else; confirmation is a separate function that only the PIN-authenticated HTTP surface
// calls; pricing happens in the engine and reads CONFIRMED rows only.

export interface ProposedLineInput {
  /** A PriceBookAtomic code — the NEW catalog (A016, SD002…), not the legacy AtomicUnit. */
  itemId: string;
  /** A SUGGESTED quantity. It is not authoritative and prices nothing until confirmed. */
  quantity: number;
  quantitySource: QuantitySource;
  difficulty?: Difficulty;
  location?: string | null;
  /** Why the model thinks this line belongs. Required — a proposal without a reason is a guess. */
  reasoning: string;
}

export interface ProposeResult {
  proposed: Array<{ id: string; itemId: string; quantity: number; description: string | null }>;
  questions: Array<{ id: string; question: string }>;
  rejected: Array<{ itemId: string; reason: string }>;
}

/**
 * The model's single write path.
 *
 * Every line lands `PROPOSED` and contributes nothing to any total. Anything the model names
 * that is not a real atomic does NOT become a line — it becomes an open question on the draft,
 * because "never make up a number" applies to scope as much as to price: an unmatched item is a
 * question for the tech, not a nearest-guess atomic.
 */
export async function proposeLines(
  prisma: PrismaClient,
  draftId: string,
  lines: ProposedLineInput[],
  unmatched: Array<{ question: string; rawText?: string | null }>,
  proposedBy: string
): Promise<ProposeResult> {
  const draft = await prisma.priceBookDraftEstimate.findUnique({ where: { id: draftId } });
  if (!draft) throw new Error(`Draft ${draftId} not found.`);
  if (draft.status !== "draft") {
    throw new Error(`Draft ${draftId} is ${draft.status}; proposals are only accepted on an open draft.`);
  }

  const result: ProposeResult = { proposed: [], questions: [], rejected: [] };
  let sortOrder = await prisma.priceBookDraftLine.count({ where: { draftId } });

  for (const line of lines) {
    // Unknown code → a question, never a nearest match. The model does not get to invent
    // catalog rows, and a fuzzy "closest atomic" is exactly the assumption the atomic-first
    // ruling removes.
    const atomic = await prisma.priceBookAtomic.findFirst({
      where: { itemId: line.itemId, retiredAt: null },
    });
    if (!atomic) {
      const q = await prisma.priceBookDraftQuestion.create({
        data: {
          draftId,
          question:
            `Proposed item "${line.itemId}" is not in the price book. Reason given: ` +
            `${line.reasoning}. A human needs to pick the right atomic or add one to the workbook.`,
          rawText: line.reasoning,
          raisedBy: proposedBy,
        },
      });
      result.questions.push({ id: q.id, question: q.question });
      result.rejected.push({ itemId: line.itemId, reason: "not in PriceBookAtomic" });
      continue;
    }

    if (!Number.isFinite(line.quantity) || line.quantity <= 0) {
      result.rejected.push({ itemId: line.itemId, reason: `non-positive quantity ${line.quantity}` });
      continue;
    }
    if (!(line.reasoning ?? "").trim()) {
      result.rejected.push({ itemId: line.itemId, reason: "no reasoning supplied" });
      continue;
    }

    const created = await prisma.priceBookDraftLine.create({
      data: {
        draftId,
        itemId: atomic.itemId,
        quantity: line.quantity,
        quantitySource: line.quantitySource as PriceBookQuantitySource,
        difficulty: (line.difficulty ?? "NORMAL") as PriceBookDifficulty,
        location: line.location ?? null,
        /*
          A MANUAL QUANTITY NEEDS A REASON, AND THE MODEL ALREADY GAVE ONE.

          The engine refuses a MANUAL quantity carrying no note, because a hand-set number with no
          recorded reason is indistinguishable later from a typo. That guard was written for a
          human typing into a box — but the model also picks MANUAL, for exactly the items where
          it should (Kyle's Diagnostics line is priced per hour, and "2 hours" is a judgement, not
          a count). With `note: null` those proposals could be confirmed and then never finalize:
          the P030 verification run hit precisely this, on the diagnostics line, after the model
          proposed it correctly.

          The model's `reasoning` IS the reason the guard is asking for — it is required on every
          proposal and it is already displayed next to the confirm button. Carrying it into the
          note satisfies the guard with a real justification rather than a placeholder, and only
          for MANUAL: every other source leaves the note empty for the tech to use.
        */
        note: line.quantitySource === "MANUAL" ? line.reasoning : null,
        sortOrder: sortOrder++,
        state: "PROPOSED",
        proposedBy,
        proposalReasoning: line.reasoning,
        proposedAt: new Date(),
      },
    });
    result.proposed.push({
      id: created.id,
      itemId: created.itemId,
      quantity: created.quantity,
      description: atomic.description,
    });
  }

  for (const u of unmatched) {
    const q = await prisma.priceBookDraftQuestion.create({
      data: {
        draftId,
        question: u.question,
        rawText: u.rawText ?? null,
        raisedBy: proposedBy,
      },
    });
    result.questions.push({ id: q.id, question: q.question });
  }

  return result;
}

// ─── HUMAN CONFIRMATION — reachable only from the PIN-authenticated surface ─────────

export interface ConfirmLineInput {
  /** Edit-then-confirm: any of these overrides the model's suggestion before it counts. */
  quantity?: number;
  quantitySource?: QuantitySource;
  difficulty?: Difficulty;
  location?: string | null;
  note?: string | null;
}

/**
 * Turn a proposed line into a real one. This is the moment the model's suggestion becomes a
 * number the engine will price, and it happens only here.
 */
export async function confirmProposedLine(
  prisma: PrismaClient,
  lineId: string,
  confirmedBy: string,
  edits?: ConfirmLineInput
) {
  const line = await prisma.priceBookDraftLine.findUnique({
    where: { id: lineId },
    include: { draft: true },
  });
  if (!line) throw new Error(`Line ${lineId} not found.`);
  if (line.draft.status !== "draft") {
    throw new Error(`Draft ${line.draftId} is ${line.draft.status}; its lines are not editable.`);
  }
  if (line.state === "CONFIRMED") {
    throw new Error(`Line ${lineId} is already confirmed.`);
  }
  if (edits?.quantity !== undefined && (!Number.isFinite(edits.quantity) || edits.quantity <= 0)) {
    throw new Error(`Quantity must be a positive number (got ${edits.quantity}).`);
  }

  const edited =
    edits !== undefined &&
    ((edits.quantity !== undefined && edits.quantity !== line.quantity) ||
      (edits.quantitySource !== undefined && edits.quantitySource !== line.quantitySource) ||
      (edits.difficulty !== undefined && edits.difficulty !== line.difficulty));

  return prisma.priceBookDraftLine.update({
    where: { id: lineId },
    data: {
      quantity: edits?.quantity ?? line.quantity,
      quantitySource: (edits?.quantitySource ?? line.quantitySource) as PriceBookQuantitySource,
      difficulty: (edits?.difficulty ?? line.difficulty) as PriceBookDifficulty,
      location: edits?.location ?? line.location,
      note: edits?.note ?? line.note,
      state: "CONFIRMED",
      confirmedBy,
      confirmedAt: new Date(),
      editedBeforeConfirm: edited,
    },
  });
}

/** Reject a proposal outright. Deletes the row — an unconfirmed suggestion is not a record. */
export async function rejectProposedLine(prisma: PrismaClient, lineId: string) {
  const line = await prisma.priceBookDraftLine.findUnique({ where: { id: lineId } });
  if (!line) throw new Error(`Line ${lineId} not found.`);
  if (line.state === "CONFIRMED") {
    throw new Error(`Line ${lineId} is confirmed; use removeLine to delete a confirmed line.`);
  }
  return prisma.priceBookDraftLine.delete({ where: { id: lineId } });
}

export async function resolveQuestion(
  prisma: PrismaClient,
  questionId: string,
  resolvedBy: string,
  resolutionNote: string
) {
  return prisma.priceBookDraftQuestion.update({
    where: { id: questionId },
    data: { resolvedAt: new Date(), resolvedBy, resolutionNote },
  });
}

/** Everything a human needs to review before confirming. */
export async function getDraftReview(prisma: PrismaClient, draftId: string) {
  const draft = await prisma.priceBookDraftEstimate.findUnique({
    where: { id: draftId },
    include: {
      lines: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }], include: { atomic: true } },
      questions: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!draft) throw new Error(`Draft ${draftId} not found.`);
  return {
    draft,
    proposedLines: draft.lines.filter((l) => l.state === "PROPOSED"),
    confirmedLines: draft.lines.filter((l) => l.state === "CONFIRMED"),
    openQuestions: draft.questions.filter((q) => q.resolvedAt === null),
  };
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

  // ── ONLY CONFIRMED LINES ARE PRICED. This is the load-bearing line of the whole
  // propose-only architecture: a PROPOSED line is the model's recommendation and it moves
  // no total anywhere until a human confirms it. Filtering here rather than in the engine
  // means every caller of computeDraft gets the guarantee, including the parity harness and
  // any future UI, without having to remember it.
  const confirmed = draft.lines.filter((l) => l.state === "CONFIRMED");
  const inputs: DraftLineInput[] = confirmed.map((l) => ({
    id: l.id,
    itemId: l.itemId,
    quantity: l.quantity,
    quantitySource: l.quantitySource as QuantitySource,
    difficulty: l.difficulty as Difficulty,
    location: l.location,
    note: l.note,
    option: l.option as EstimateOption,
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

  // ── Nothing finalizes while the model's work is still unreviewed ──
  // A proposed line prices nothing, so without this check a draft full of unconfirmed
  // suggestions would finalize as a smaller-but-valid-looking estimate. That is the quiet
  // failure this gate exists to prevent: an estimate that is wrong by omission and looks
  // complete. Same reasoning as the workbook's unpriced-component counter.
  const unconfirmed = await prisma.priceBookDraftLine.count({
    where: { draftId, state: "PROPOSED" },
  });
  const openQuestions = await prisma.priceBookDraftQuestion.count({
    where: { draftId, resolvedAt: null },
  });

  const result = finalizeEstimate(computed, atomics, {
    context,
    rateProvisional: rate.provisional,
    provisionalReason: rate.provisionalReason,
  });

  if (unconfirmed > 0 || openQuestions > 0) {
    const reasons: string[] = [];
    if (unconfirmed > 0) {
      reasons.push(
        `${unconfirmed} AI-proposed line(s) are still unconfirmed. A proposal prices nothing — ` +
          `confirm or reject each one before this estimate can be issued.`
      );
    }
    if (openQuestions > 0) {
      reasons.push(
        `${openQuestions} open question(s) from the AI are unresolved. An item the model could ` +
          `not match is a question for the tech, not an omission to quote around.`
      );
    }
    return {
      finalized: false,
      reasons: [...reasons, ...(result.finalized ? [] : result.reasons)],
      warnings: result.warnings,
      computed,
    };
  }

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
