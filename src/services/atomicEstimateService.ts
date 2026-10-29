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

import { Prisma, PrismaClient, type PriceBookDifficulty, type PriceBookOption, type PriceBookQuantitySource } from "@prisma/client";
import { z } from "zod";
import {
  ALL_OPTIONS,
  BASE_OPTIONS,
  OPTION_LIMIT_REASON,
  isEstimateOption,
  nextFreeOption,
  type DraftOptionEntry,
  type DraftOptionSet,
  type EstimateOptionLetter,
} from "../../shared/estimateOptions";
import {
  computeEstimate,
  isContinuousLength,
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
import { asCustomPercent, type DiscountType } from "./discounts";
import { isAssemblyRowType } from "./priceBookAssembly";
import type {
  CatalogSection, FieldCatalogPage, FieldCatalogRow, FieldCatalogSnapshot, FieldCatalogSnapshotResponse,
} from "../../shared/quoteCatalog";
import { unreviewedReasons, type FieldOpenQuestion, type QuoteSuggestedLine } from "../../shared/suggestedLines";
import { COPY_REFUSED_CHANGE_ORDER, COPY_REFUSED_DIAGNOSTIC } from "../../shared/draftLifecycle";
import { logSystemEvent } from "./systemEvents";

export interface RateContext {
  rc: RateConfig;
  provisional: boolean;
  provisionalReason: string | null;
}

/**
 * Read Rate Config out of the price book and decide whether it is provisional.
 * The billed rate in the cell IS Kyle's ruling (2026-10-27: he edits it on Settings); only a BLANK
 * cell is provisional, because a missing number cannot price a labour dollar.
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
      /*
        The job-level ceilings, if the workbook carries them (2026-08-22). Read exactly like the
        per-item tiers — absent reads null, and bandsFrom() then stands the code's schedule up
        rather than pricing a band nobody set.
      */
      jobBands: {
        b1: n("jobBand1Ceiling"),
        b2: n("jobBand2Ceiling"),
        b3: n("jobBand3Ceiling"),
        b4: n("jobBand4Ceiling"),
        max1: n("jobBand1Max"),
        max2: n("jobBand2Max"),
        max3: n("jobBand3Max"),
      },
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
  tiers: MarkupTiers,
  /**
   * Item ids that are ON a draft already and must price whatever their status.
   *
   * ── RETIRE MEANS "DO NOT OFFER", NOT "DO NOT PRICE" (2026-08-20) ──────────────────────────
   *
   * This loader filtered `retiredAt: null` for every caller, which quietly made a retired atomic
   * unpriceable. Kyle renamed 39 rows in his book on 2026-08-20 — `THHN/THWN-2 Building Wire,
   * #14 AWG` became `THHN #14 AWG` and so on. Keys derive from names, so the old keys retired and
   * new ones took their place, exactly as designed.
   *
   * His live EV Charger draft referenced two of the old keys. After the import those two lines
   * reported ATOMIC_NOT_FOUND and priced at ZERO, and the draft fell from $1662.14 to $811.19 —
   * silently, with the lines still listed on screen. That is the worst shape a pricing bug can
   * take: work visibly present, contributing nothing.
   *
   * "Retire, never delete" was meant to keep exactly this from happening. Retirement removes an
   * item from browse, from search and from what the AI may propose — all of which use different
   * queries and stay filtered. It must not remove the price from a line somebody already added.
   */
  referencedItemIds: string[] = []
): Promise<Map<string, EngineAtomic>> {
  const atomics = await prisma.priceBookAtomic.findMany({
    where: referencedItemIds.length > 0
      ? { OR: [{ retiredAt: null }, { itemId: { in: referencedItemIds } }] }
      : { retiredAt: null },
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
  // Kyle's own flat charge (P030). A row carrying it needs no supplier price — see isFlatPriced.
  sellNormal: true,
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
  /**
   * Priced from Kyle's own sell columns rather than supplier cost x tier (2026-08-22).
   *
   * Kyle, on the permit fee: "It's flagging no price but it should just be priced at $200." The
   * engine priced it at $200 all along — the flat-price branch has handled it since P030. The
   * BADGE was wrong: "no price at supplier" is a statement about an item that buys nothing from
   * a supplier, and it read as "this will not price".
   */
  isFlatPriced: boolean;
  isContinuousLength: boolean;
  /**
   * A hand-built product (rowType "ASSEMBLY", priceBookAssembly.ts) — one line on the estimate, the
   * parts kept underneath. Adding it is an ordinary addLine on its itemId in BOTH apps, so the
   * picker only needs to SAY it is one (2026-10-08, field picker parity).
   */
  isAssembly: boolean;
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
  sellPricePerUnit: number | null; sellNormal: number | null; necArticle: string | null;
}): BrowsedAtomic {
  return {
    ...r,
    hasLabourUnitBasis: r.laborUnitBasis !== null,
    hasPriceAtActiveSupplier: r.costBasisUsed !== null,
    isFlatPriced: r.sellNormal !== null,
    // The engine's own test (ft OR lf), so the badge and the engine's gap check cannot disagree.
    // This used to be `=== "ft"`, which left an "lf" item un-badged while the engine still demanded
    // a measured length of it (2026-10-08, Phase 0 finding).
    isContinuousLength: isContinuousLength({ unit: r.unit }),
    isAssembly: isAssemblyRowType(r.rowType),
    hasPublishedLabour:
      r.laborNormal !== null || r.laborDifficult !== null || r.laborVeryDifficult !== null,
    sellsMaterial: rowTypeSells(r.rowType).material,
    isHourlyProduct: (r.unit ?? "").trim().toLowerCase() === "hr",
  };
}

/**
 * What a typed search is matched as: the LITERAL text. Prisma 5's `contains` hands the text to
 * Postgres LIKE untouched, so `%` and `_` typed into the box were wildcards — "14_2" matched
 * "14/2" and anything else one character apart, and the phone's saved-copy search
 * (shared/quoteCatalog.ts matchesCatalogSearch) is a plain substring test, so the two doors
 * answered differently for the same typed text (Phase 7 U5, 2026-10-10, verified against the test
 * database: `contains: "ZZP%device"` matched "ZZP plain device"; `"ZZP\\%device"` did not).
 * Backslash is Postgres' default LIKE escape, so each of `\`, `%` and `_` is escaped with one.
 */
export function literalContains(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
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
  if (input.article) where["necArticle"] = { contains: literalContains(input.article) };
  if (input.category) where["category"] = { contains: literalContains(input.category), mode: "insensitive" };
  if (input.search) {
    const search = literalContains(input.search);
    where["OR"] = [
      { itemId: { contains: search, mode: "insensitive" } },
      { description: { contains: search, mode: "insensitive" } },
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
 * Browse cards, driven by Kyle's own sections (P030): each live category and how many live items it
 * holds. Counts come from the live catalog only, so a retired section disappears rather than
 * rendering a card that leads nowhere. ONE function for the CRM's `GET /price-book/sections` and the
 * phone's `GET /health-record/quote-catalog/sections` — it used to be written inline in the CRM
 * route, which left the phone nothing to browse by (2026-10-08, one estimating system).
 */
export async function browseSections(prisma: PrismaClient): Promise<CatalogSection[]> {
  const grouped = await prisma.priceBookAtomic.groupBy({
    by: ["category"],
    where: { retiredAt: null },
    _count: { _all: true },
  });
  return grouped
    .filter((g) => g.category)
    .map((g) => ({ section: g.category as string, itemCount: g._count._all }))
    .sort((a, b) => a.section.localeCompare(b.section));
}

/**
 * The phone's view of one catalog item: words and yes/no badges only. The workbook's labour hours,
 * the labour unit basis, Red Cedar's supplier cost and the per-unit sell figure are all dropped —
 * the technician hands the phone to the customer (constants.md "Field app"). Built by naming each
 * kept field, not by deleting the bad ones, so a column added to BrowsedAtomic later does not leak.
 */
export function toFieldCatalogRow(a: BrowsedAtomic): FieldCatalogRow {
  return {
    itemId: a.itemId,
    description: a.description,
    category: a.category,
    unit: a.unit,
    isAssembly: a.isAssembly,
    hasLabourUnitBasis: a.hasLabourUnitBasis,
    hasPriceAtActiveSupplier: a.hasPriceAtActiveSupplier,
    isFlatPriced: a.isFlatPriced,
    isContinuousLength: a.isContinuousLength,
    hasPublishedLabour: a.hasPublishedLabour,
    sellsMaterial: a.sellsMaterial,
    isHourlyProduct: a.isHourlyProduct,
  };
}

/** How many rows one phone screen of results holds — the CRM's own page size for the same browse. */
export const FIELD_CATALOG_LIMIT = 60;

/** The phone's search / section browse: the CRM's browseAtomics, with the office-only columns taken off. */
export async function browseFieldCatalog(
  prisma: PrismaClient,
  input: { search?: string | null; category?: string | null }
): Promise<FieldCatalogPage> {
  const r = await browseAtomics(prisma, {
    search: input.search?.trim() || null,
    category: input.category?.trim() || null,
    limit: FIELD_CATALOG_LIMIT,
  });
  return { atomics: r.atomics.map(toFieldCatalogRow), count: r.count, total: r.total, truncated: r.truncated };
}

/**
 * What the phone's saved price book is stamped with: how many live items there are, and when the
 * newest of them last changed (the row's @updatedAt, `lastSeenAt`). A retire, a new item, an edit
 * to a word the phone shows, or a deleted row each move one of the two, and a section only ever
 * changes through its items, so this one stamp covers the sections too. Opaque to the phone.
 */
function catalogVersion(count: number, newest: Date | null | undefined): string {
  return `${count}:${newest ? newest.toISOString() : "none"}`;
}

/** The current stamp, cheaply: one aggregate, no rows. */
async function currentCatalogVersion(prisma: PrismaClient): Promise<string> {
  const agg = await prisma.priceBookAtomic.aggregate({
    where: { retiredAt: null },
    _count: { _all: true },
    _max: { lastSeenAt: true },
  });
  return catalogVersion(agg._count._all, agg._max.lastSeenAt);
}

/**
 * The WHOLE live price book as the phone keeps it for working with no signal (2026-10-09, Phase 7
 * unit U2): every non-retired item through `toFieldCatalogRow` — the same words and yes/no badges
 * the online picker shows, and nothing the picker does not — ordered by itemId, plus the section
 * cards. When the phone sends the version it already holds and nothing has changed, the answer is
 * just `{ unchanged: true }` and no rows are built.
 *
 * Deliberately NOT browseAtomics: that caps a page at 200 (the picker's 60), and a saved copy with a
 * cap would silently lose items. It reads the same BROWSE_SELECT columns and runs the same `decorate`
 * so a badge cannot mean one thing online and another offline; `lastSeenAt` is read beside them only
 * to stamp the version of the rows actually returned, and is taken off before a row is built.
 */
export async function fieldCatalogSnapshot(
  prisma: PrismaClient,
  haveVersion?: string | null
): Promise<FieldCatalogSnapshotResponse> {
  if (haveVersion) {
    const now = await currentCatalogVersion(prisma);
    if (now === haveVersion) return { unchanged: true, version: now };
  }
  const found = await prisma.priceBookAtomic.findMany({
    where: { retiredAt: null },
    orderBy: { itemId: "asc" },
    select: { ...BROWSE_SELECT, lastSeenAt: true },
  });
  let newest: Date | null = null;
  const rows: FieldCatalogRow[] = [];
  for (const { lastSeenAt, ...browse } of found) {
    if (!newest || lastSeenAt > newest) newest = lastSeenAt;
    rows.push(toFieldCatalogRow(decorate(browse)));
  }
  const snapshot: FieldCatalogSnapshot = {
    version: catalogVersion(found.length, newest),
    generatedAt: new Date().toISOString(),
    rows,
    sections: await browseSections(prisma),
  };
  return snapshot;
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
  /**
   * The draft's id, minted by the caller (Phase 7, offline estimating, 2026-10-09). The phone
   * mints it at capture time so a replay after a lost answer lands on the SAME row — the
   * constants.md idempotency convention the receipt queue established. Absent means the database
   * picks one, as every CRM caller has always had it. `openOrCreateWorkingDraft` is the only
   * caller that passes one; it checks the id is not already taken before it gets here.
   */
  id?: string;
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
      ...(input.id ? { id: input.id } : {}),
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
  /**
   * IGNORED — kept only so older callers still compile. Kyle, 2026-10-08: "We just need a number
   * not type." The service decides the source from the item itself (`quantitySourceFor`), so no
   * door can disagree with another about it.
   * @deprecated
   */
  quantitySource?: QuantitySource;
  difficulty?: Difficulty;
  location?: string | null;
  note?: string | null;
  /** Absent means the END of the draft (max sortOrder + 1), never the top — see `nextSortOrder`. */
  sortOrder?: number;
  /** Which of the three options the line belongs to. Absent means A. */
  option?: EstimateOption;
  /** Who entered it. Defaults to "human:direct-entry"; the AI can never reach this function. */
  confirmedBy?: string;
  /**
   * The line's id, minted by the caller (Phase 7, offline estimating, 2026-10-09). A replay of an
   * add whose answer was lost finds its own row by this id and writes nothing — see `addLine`.
   * Absent means the database picks one (every CRM caller).
   */
  id?: string;
}

/**
 * A refusal from a draft-level rule, carrying the HTTP status the CRM routes already answered
 * with before these rules moved out of app.ts (2026-10-08, "one estimating system"). The tech
 * routes map it the same way, so both doors say the same thing with the same code. Anything
 * thrown as a plain Error stays a 400 — the mapping the line routes have always used.
 *
 * `details` (2026-10-09, Phase 7): named facts a door puts beside the message so a phone can ACT on
 * the refusal rather than only show it — `existingDraftId` on "the office already started a quote
 * for this visit", so the queued lines can be re-pointed at that draft. Optional; most refusals
 * carry none.
 */
export class DraftError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 = 400, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = "DraftError";
  }
}

/** The status a route answers with for an error thrown by a draft rule. */
export function draftErrorStatus(err: unknown): 400 | 404 | 409 {
  return err instanceof DraftError ? err.status : 400;
}

/*
  ── "EXPECTED" — a write that says what the sender last saw (Phase 7, offline estimating, 2026-10-09) ──

  A phone with no signal keeps a tech's edits and replays them when signal returns; by then the
  office (or another phone) may have changed the same field. Each write may therefore carry
  `expected`: the value of each field as the sender's screen last showed it. The rule, per field:

    accepted when the value NOW equals `expected`          — nothing changed underneath them
    accepted when the value NOW already equals the NEW one  — the office made the same change
    otherwise refused, 409, naming the field and both values:
      "Changed at the office since you last saw it: quantity was 3, now 5"

  A value that went away and came back (3 → 7 → 3) passes the first test, and the office setting the
  same new value passes the second; both are what both people wanted, so no table of applied edits
  is needed. Checked BEFORE the reopen guard, like addOption's cap: a refused press writes nothing
  and never flips an issued draft back to "draft". Absent `expected` means last-write-wins, exactly
  as every CRM write has always been. ONE function for lines and the draft-level settings, so the
  two doors and the five writers cannot word it differently.
*/
export type ExpectedValues = Record<string, unknown>;

/** Blank is blank: "", undefined and null compare equal; strings compare trimmed. */
function expectedNorm(v: unknown): unknown {
  if (v === undefined || v === null) return null;
  if (typeof v === "string") {
    const t = v.trim();
    return t === "" ? null : t;
  }
  return v;
}

function expectedShow(v: unknown): string {
  const n = expectedNorm(v);
  if (n === null) return "blank";
  if (typeof n === "string") return `"${n}"`;
  return String(n);
}

export function assertExpected(
  current: Record<string, unknown>,
  expected: ExpectedValues | undefined,
  patch: Record<string, unknown>,
): void {
  if (!expected) return;
  for (const [field, saw] of Object.entries(expected)) {
    if (saw === undefined) continue;
    const now = expectedNorm(current[field]);
    if (now === expectedNorm(saw)) continue;
    if (field in patch && patch[field] !== undefined && now === expectedNorm(patch[field])) continue;
    throw new DraftError(
      `Changed at the office since you last saw it: ${field} was ${expectedShow(saw)}, now ${expectedShow(current[field])}`,
      409,
    );
  }
}

/** The `expected` a line edit may carry — the same fields the patch may set (both doors). */
export const editLineExpectedSchema = z.object({
  quantity: z.number().optional(),
  difficulty: z.enum(["NORMAL", "DIFFICULT", "VERY_DIFFICULT"]).optional(),
  option: z.enum(ALL_OPTIONS).optional(),
  note: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  customName: z.string().nullable().optional(),
}).optional();

/**
 * The name the customer reads for one line (Kyle, 2026-10-27: "I want to be able to edit the name
 * of the line item so I can customize the line item name to the specific job."). ONE schema for
 * both doors' line-edit bodies: trimmed, at most 200 characters; empty or null clears it, which
 * puts the price-book name back. `editLine` repeats the same rule on whatever reaches it, so a
 * caller that skips this schema cannot store a blank or an over-long name.
 */
export const LINE_CUSTOM_NAME_MAX = 200;
export const lineCustomNameSchema = z
  .string()
  .trim()
  .max(LINE_CUSTOM_NAME_MAX, `The name on the estimate can be at most ${LINE_CUSTOM_NAME_MAX} characters.`)
  .nullable()
  .optional();

/**
 * Why a draft's lines and options are shut, or null when they are open (2026-10-08 review).
 *
 * THE one place "signed" is decided. A draft whose status is "draft" is open. Otherwise it is shut
 * when ANY IssuedEstimate made from it carries a signature — superseded or not: revising a signed
 * estimate (reviseEstimate allows it, for the trip charge / warranty / discount) leaves the old
 * signed row in place and the draft "finalized", and the server still refuses line edits. The CRM
 * used to ask "is there a signed estimate that is not superseded?", which answered differently
 * after exactly that revise, so its buttons looked live and the server refused each press.
 *
 * `reopenForEditIfUnsigned` throws this sentence; `getDraftOptionSet` returns it as `lockedReason`
 * so both apps can grey the controls with it before the press.
 */
export async function draftLockedReason(db: Db, draftId: string, status: string): Promise<string | null> {
  if (status === "draft") return null;
  const signed = await db.issuedEstimate.findFirst({
    where: { draftId, signedAt: { not: null } },
    select: { number: true, revision: true },
  });
  if (!signed) return null;
  return (
    `Estimate ${signed.number} from this draft is SIGNED. A signed agreement is never edited — ` +
    `raise a change order instead.`
  );
}

/**
 * A finalized draft REOPENS for editing — unless something from it has been signed (2026-08-22).
 *
 * Kyle, from the field: *"I still cannot edit this draft."* The Edit button on an unsigned
 * estimate reopens the builder, and the builder's every mutation then refused him with
 * "finalized estimates are not edited in place."
 *
 * That guard predates the revision flow and was load-bearing then: the frozen record WAS the
 * draft, so an edit rewrote history. It is not any more. The issued estimate froze its own lines,
 * options and prices at graduation and reads nothing from the draft afterwards — and re-issuing
 * an edited draft SUPERSEDES the old estimate (same number, revision up, old link dead) rather
 * than minting a duplicate. Editing an unsigned draft is now exactly the workflow, not a threat
 * to the record.
 *
 * The line that still cannot be crossed: A SIGNATURE. Once any estimate from this draft carries a
 * customer's name, the draft stays shut and the answer is a change order — reshaping a draft
 * under a signed agreement is how "what did they sign?" stops having one answer.
 *
 * Reopening flips the status back to "draft"; the next issue re-runs finalize and re-earns
 * "finalized" honestly.
 *
 * EXPORTED (2026-10-08, "one estimating system"): every draft mutation — lines, discount, option
 * names, option mode, copying an option, raising a question — goes through this one guard, in
 * the service, so the CRM route and the tech route cannot disagree about when a draft is shut.
 *
 * `signedStaysEditable` is for the three draft-level SETTINGS whose edit only takes effect through
 * a new revision — the discount, the option names and the option mode. Kyle, 2026-09-29: the
 * discount stays editable after the estimate is issued, signed or not, because the change reaches
 * the customer only when "Save changes to the estimate" makes a revision they have to sign again;
 * the signed record froze its own discount, names and mode at graduation and reads none of them
 * back. These three had no signed refusal before the 2026-10-08 move into services, and the CRM
 * screen is built around that (PriceBookIntakePage, the amber line under the discount buttons).
 * On a signed draft they therefore return WITHOUT flipping the status — the draft stays
 * "finalized" so the revise that follows finds it as it expects. Lines, copying an option and
 * raising a question change what the customer would be signing and stay shut.
 */
export async function reopenForEditIfUnsigned(
  prisma: PrismaClient,
  draftId: string,
  action: string,
  opts: { signedStaysEditable?: boolean } = {},
): Promise<void> {
  const draft = await prisma.priceBookDraftEstimate.findUnique({
    where: { id: draftId },
    select: { status: true },
  });
  if (!draft) throw new DraftError(`Draft ${draftId} not found.`, 404);
  if (draft.status === "draft") return;

  const locked = await draftLockedReason(prisma, draftId, draft.status);
  if (locked) {
    if (opts.signedStaysEditable) return;
    // A DraftError (400), not a bare Error: the draft-rule routes answer a DraftError with its
    // status and hand anything else — a database failure — to the global handler to be logged.
    throw new DraftError(locked, 400);
  }

  await prisma.priceBookDraftEstimate.update({
    where: { id: draftId },
    data: { status: "draft", finalizedAt: null },
  });
  logSystemEvent("info", "price-book", `Draft ${draftId} reopened for editing (${action}) — nothing signed`, {
    draftId,
  });
}

/**
 * The one quantity schema every door uses to read a line's quantity off the wire (2026-10-08).
 *
 * Non-zero, positive OR negative. The CRM's routes used to say `z.number().positive()` and refuse
 * a credit line before the service ever saw it, while the field's said "non-zero" and let
 * `assertQuantityAllowed` decide — so the same change order took a negative count from the
 * phone and refused it from the desk. This schema only stops what is never valid (zero); whether
 * a negative is legal is `assertQuantityAllowed`'s call, in `addLine` / `editLine` /
 * `confirmProposedLine`, and it is the only place that rule lives.
 */
export const lineQuantitySchema = z.number().refine((n) => n !== 0, { message: "Quantity cannot be zero." });

/**
 * How a quantity was arrived at — decided HERE, from the item, never by the caller.
 *
 * Kyle, 2026-10-08: "Take the quantity type out of the CRM too. We just need a number not type."
 * A cable sold by the foot is a MEASURED_LENGTH (his rule R3: length is a field measurement, and
 * the engine raises MEASURED_LENGTH_MISSING on anything else); everything else is a COUNT,
 * including an hourly item, whose quantity IS hours. TERMINATION_COUNT and MANUAL are never
 * written by new work — they remain on old rows because history is not rewritten.
 *
 * Uses the engine's own `isContinuousLength` so the line and the engine's gap check cannot
 * disagree about what counts as sold-by-length.
 */
export function quantitySourceFor(atomic: { unit: string | null }): QuantitySource {
  return isContinuousLength(atomic) ? "MEASURED_LENGTH" : "COUNT";
}

/**
 * Where a line added without an explicit position goes: the END of the draft.
 *
 * Every hand-added line used to be written with sortOrder 0, so the order was only the createdAt
 * tiebreak. That works until the draft has been arranged (drag-and-drop, 2026-10-08): the next
 * line added would be 0 and jump to the TOP of its option. One past the draft's highest number
 * lands last whatever the existing numbers are — including a draft that is all zeros.
 * Draft-wide rather than per-option on purpose: a line moved into another option later keeps
 * its place at the end of the list, and a count (what the AI proposals used) can collide with
 * existing numbers after a delete.
 */
async function nextSortOrder(prisma: PrismaClient, draftId: string): Promise<number> {
  const agg = await prisma.priceBookDraftLine.aggregate({ where: { draftId }, _max: { sortOrder: true } });
  return (agg._max.sortOrder ?? -1) + 1;
}

/**
 * Add a line a person typed.
 *
 * CLIENT ID (Phase 7, offline estimating, 2026-10-09). When the caller minted `line.id`, a row
 * already carrying it on THIS draft is the earlier delivery of the same add — the answer was lost,
 * the phone is replaying — so it is returned as-is and NOTHING is written: no reopen, no new row.
 * The same id on ANOTHER draft is refused (409) and never adopted: an id is a fact about one row.
 * The short-circuit sits before the guards because it writes nothing; every guard below still
 * runs before any write, in the order it always has.
 *
 * Refusals are DraftErrors (400), not bare Errors (2026-10-09): the tech route now answers a
 * DraftError with its status and hands anything else — a database failure — to the global handler,
 * so a plain throw here would have turned "quantity cannot be zero" into a 500. The CRM route
 * answers every error 400 as before, so its door is unchanged.
 *
 * A RETIRED item is still added. Retire means "do not offer", not "do not price"
 * (loadCatalogAtSupplier); the phone's cached price book can lag the office's and the quote
 * payload says `retired` on the line instead, after the fact.
 */
export async function addLine(prisma: PrismaClient, draftId: string, line: AddLineInput) {
  if (line.id) {
    const already = await prisma.priceBookDraftLine.findUnique({ where: { id: line.id } });
    if (already) {
      if (already.draftId !== draftId) {
        throw new DraftError(`Line ${line.id} is already on another quote — it cannot be added to this one.`, 409);
      }
      return already;
    }
  }
  await reopenForEditIfUnsigned(prisma, draftId, "add line");
  const draft = await prisma.priceBookDraftEstimate.findUnique({ where: { id: draftId } });
  if (!draft) throw new DraftError(`Draft ${draftId} not found.`, 404);
  try {
    assertQuantityAllowed(line.quantity, Boolean(draft.changeOrderForId));
  } catch (err) {
    throw new DraftError(`Quantity for ${line.itemId}: ${err instanceof Error ? err.message : String(err)}`, 400);
  }
  const atomic = await prisma.priceBookAtomic.findUnique({ where: { itemId: line.itemId } });
  if (!atomic) {
    throw new DraftError(
      `${line.itemId} is not in the atomic catalog. If this is a NECA-backed item with no atomic ` +
        `row yet, it must be created in the workbook first — the app does not invent catalog rows.`,
      400,
    );
  }

  return prisma.priceBookDraftLine.create({
    data: {
      ...(line.id ? { id: line.id } : {}),
      draftId,
      itemId: line.itemId,
      quantity: line.quantity,
      // Decided from the item, whatever the caller sent (Kyle, 2026-10-08: "just a number").
      quantitySource: quantitySourceFor(atomic) as PriceBookQuantitySource,
      difficulty: (line.difficulty ?? "NORMAL") as PriceBookDifficulty,
      option: (line.option ?? "A") as PriceBookOption,
      location: line.location ?? null,
      note: line.note ?? null,
      sortOrder: line.sortOrder ?? (await nextSortOrder(prisma, draftId)),
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

/**
 * A quantity is positive — unless this is a change order, where it may be negative.
 *
 * Kyle, 2026-08-19: *"additional sections that add the work or remove the work… This means we
 * should be able to do a negative count on the line items."*
 *
 * Negative counts are allowed ONLY on a change order, and that restriction is the point. On an
 * ordinary estimate a negative count is a typo, and nothing downstream would catch it: the line
 * would price, the option would total, and the estimate would simply come out lower than it
 * should — which is the kind of error that is only ever found by a customer.
 *
 * Zero is refused everywhere. A line that changes nothing is not a change; it is an unfinished
 * thought, and it would print on a signed document saying nothing.
 */
export function assertQuantityAllowed(quantity: number, isChangeOrder: boolean): void {
  if (!Number.isFinite(quantity)) {
    throw new Error(`Quantity must be a number (got ${quantity}).`);
  }
  if (quantity === 0) {
    throw new Error("Quantity cannot be zero — a line that changes nothing does not belong on a document.");
  }
  if (quantity < 0 && !isChangeOrder) {
    throw new Error(
      `Quantity must be positive (got ${quantity}). A negative count removes work and is only ` +
        "allowed on a change order.",
    );
  }
}

/*
  A write that would change nothing is NOT a write (Phase 7 review, 2026-10-09).

  `assertExpected` lets a replay through when the value NOW already equals the NEW one — that is
  the lost-answer case: the phone's edit landed, the 2xx never came back, the phone sends it again.
  Between those two sends the office may have ISSUED the estimate (the edit is on it) or had it
  SIGNED (the edit is on the signed record). Running the reopen guard on such a replay would flip
  the issued draft back to "draft" and clear finalizedAt — the office then sees unsaved changes
  that do not exist — or, on the signed one, refuse an edit that is already on the signed estimate
  with "raise a change order", which stops the phone's whole chain for that draft. `addLine` gives
  itself this idempotency through the client id; the editors and the settings writers get it here:
  when every column the patch names already holds its target value, return without the reopen
  guard and without an update. The CRM door gets the same courtesy — re-saving a line unchanged no
  longer turns an issued estimate into "unsaved changes".

  Stored-value equality, not `expectedNorm`'s: a blank (null / undefined / "") equals a blank, but a
  string is compared as it would be STORED (no trim), so a real change — a trailing space the sender
  meant — still writes. Only columns the patch names count; `undefined` means "not touched".
*/
function sameStored(now: unknown, next: unknown): boolean {
  const blank = (v: unknown) => v === null || v === undefined || v === "";
  if (blank(now) && blank(next)) return true;
  return now === next;
}

export function wouldChangeNothing(current: Record<string, unknown>, data: Record<string, unknown>): boolean {
  for (const [field, next] of Object.entries(data)) {
    if (next === undefined) continue;
    if (!sameStored(current[field], next)) return false;
  }
  return true;
}

/**
 * Edit a line. `expected` (optional) is what the sender's screen last showed for each field it
 * names — the Phase 7 replay rule on `assertExpected`, checked before the reopen so a refused press
 * writes nothing. A line that is gone is a DraftError 404 — worded for either door: the tech route
 * answers its own `line_gone` sentence before this runs, and the CRM route shows this message to
 * the office, so it must not tell the office "the office may have removed it". A bad quantity is a
 * DraftError 400, for the same reason as in `addLine`. A patch that changes nothing returns the line
 * as it is, with no reopen and no update (`wouldChangeNothing`).
 */
export async function editLine(
  prisma: PrismaClient,
  lineId: string,
  patch: Partial<Omit<AddLineInput, "itemId" | "id">> & { customName?: string | null },
  expected?: ExpectedValues,
) {
  const existing = await prisma.priceBookDraftLine.findUnique({
    where: { id: lineId },
    include: { draft: true },
  });
  if (!existing) throw new DraftError(`Line ${lineId} is no longer on this quote.`, 404);
  assertExpected(existing, expected, patch);
  // Pure, writes nothing: a bad quantity is refused before the reopen guard, so a refused press
  // never flips an issued draft back to "draft" (the same order addLine keeps).
  if (patch.quantity !== undefined) {
    try {
      assertQuantityAllowed(patch.quantity, Boolean(existing.draft.changeOrderForId));
    } catch (err) {
      throw new DraftError(err instanceof Error ? err.message : String(err), 400);
    }
  }
  /*
    The source follows the item whenever the quantity is saved — and ONLY then (Kyle, 2026-10-08:
    "just a number"). A save that does not touch the quantity leaves an old MANUAL /
    TERMINATION_COUNT row exactly as it was: history is not rewritten by a note edit. A person
    who re-saves the quantity of such a row has re-entered it as a plain number, which is what
    clears the engine's "manual quantity with no note" gap on it. No atomic row (a code that has
    since gone) keeps the stored value rather than inventing one.
  */
  let quantitySource: PriceBookQuantitySource | undefined;
  if (patch.quantity !== undefined) {
    const atomic = await prisma.priceBookAtomic.findUnique({ where: { itemId: existing.itemId } });
    if (atomic) quantitySource = quantitySourceFor(atomic) as PriceBookQuantitySource;
  }
  /*
    The line's own name (Kyle, 2026-10-27). Trimmed; empty or null CLEARS it (null in the row means
    "use the price-book name" — the exit the screens' "Use the price-book name" button takes).
    `undefined` means "not touched". Refused before the reopen guard, like a bad quantity, so a
    refused press never flips an issued draft back to "draft". A signed draft is shut by the same
    reopenForEditIfUnsigned as every other line field.
  */
  let customName: string | null | undefined;
  if (patch.customName !== undefined) {
    const trimmed = (patch.customName ?? "").trim();
    if (trimmed.length > LINE_CUSTOM_NAME_MAX) {
      throw new DraftError(`The name on the estimate can be at most ${LINE_CUSTOM_NAME_MAX} characters.`, 400);
    }
    customName = trimmed === "" ? null : trimmed;
  }
  const data = {
    quantity: patch.quantity,
    customName,
    // Part of the comparison on purpose: re-saving the same number on an old MANUAL row still
    // re-sources it, exactly as before.
    quantitySource,
    difficulty: patch.difficulty as PriceBookDifficulty | undefined,
    location: patch.location,
    note: patch.note,
    sortOrder: patch.sortOrder,
    // Moving a line between options is an edit like any other. Without it, putting a line in
    // the wrong option could only be undone by deleting and re-adding it.
    option: patch.option as PriceBookOption | undefined,
  };
  if (wouldChangeNothing(existing, data)) {
    const { draft, ...row } = existing;
    void draft;
    return row;
  }
  await reopenForEditIfUnsigned(prisma, existing.draftId, "edit line");
  return prisma.priceBookDraftLine.update({ where: { id: lineId }, data });
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
  // A DraftError (404) so a door answers it as a refusal; a database failure stays a plain throw.
  if (!existing) throw new DraftError(`Line ${lineId} not found.`, 404);
  await reopenForEditIfUnsigned(prisma, existing.draftId, "remove line");
  return prisma.priceBookDraftLine.delete({ where: { id: lineId } });
}

// ─── DRAFT-LEVEL RULES — one set, both doors (Kyle, 2026-10-08) ──────────────────────
//
// "One estimating system, two doors." Until 2026-10-08 every rule below lived inline in a CRM
// route in app.ts, so a field twin would have had to copy it — and the copies had already
// started to drift: copy-option and the question route skipped the signed-draft guard the line
// functions carry, and copying an option into a finalized draft left it "finalized" with lines it
// had not been finalized with. (The discount, option names and option mode also had no signed
// refusal, but on purpose — Kyle, 2026-09-29, they take effect through a revision; see
// `reopenForEditIfUnsigned`'s `signedStaysEditable`.) Each rule is
// now a function here; `src/app.ts` (CRM) and `src/routes/health-record.ts` (tech) are thin
// wrappers over it. No rule may live in only one route.

/*
  The bodies the draft-level routes read — ONE schema each, imported by the CRM route (src/app.ts)
  and the tech route (src/routes/health-record.ts), so the two doors cannot disagree about what
  they accept (2026-10-08, Phase 2: the field gets discount, option names, option mode and copy).
*/
// Each settings body may carry `expected` — the values the sender's screen last showed (the Phase 7
// replay rule, `assertExpected`). Optional on both doors; absent means last-write-wins as before.
export const draftDiscountBodySchema = z.object({
  type: z.enum(["military", "senior", "custom"]).nullable(),
  percent: z.number().optional().nullable(),
  expected: z.object({
    type: z.enum(["military", "senior", "custom"]).nullable().optional(),
    percent: z.number().nullable().optional(),
  }).optional(),
});
export const optionsModeBodySchema = z.object({
  exclusive: z.boolean(),
  expected: z.object({ exclusive: z.boolean().optional() }).optional(),
});
export const optionMetaBodySchema = z.object({
  // Empty string clears the name rather than storing "" — the service's rule; see setOptionMeta.
  label: z.string().trim().max(120).nullable().optional(),
  note: z.string().trim().max(400).nullable().optional(),
  expected: z.object({
    label: z.string().nullable().optional(),
    note: z.string().nullable().optional(),
  }).optional(),
});
export const copyOptionBodySchema = z.object({
  from: z.enum(ALL_OPTIONS),
  to: z.enum(ALL_OPTIONS),
});

/**
 * The discount programme on a draft (Kyle, 2026-08-22; custom percent 2026-09-01).
 *
 * "military discount at 5%, senior citizen discount at 5%" — "Off of the whole job but gets
 * capped at $250." One programme per estimate; setting a new one replaces the old, null clears.
 * The AMOUNT is never stored on the draft — it is 5% of what the customer eventually selects, so
 * it does not exist yet. Surfaces compute it live; the signature freezes it.
 *
 * Custom percentage: "I want a simple enter a percentage and apply button next to the other
 * discounts" — for price matching. Type "custom" carries its percent (0 < p ≤ 50, uncapped); the
 * percent is stored only with that type so a stale figure cannot ride along under a programme.
 * The rate and the cap themselves live in `discounts.ts` and are never restated here.
 */
export async function setDraftDiscount(
  prisma: PrismaClient,
  draftId: string,
  input: {
    type: DiscountType | null;
    percent?: number | null;
    /** What the sender last saw (Phase 7 replay rule, `assertExpected`). */
    expected?: { type?: DiscountType | null; percent?: number | null };
  },
): Promise<{ discountType: string | null; discountPercent: number | null }> {
  const percent = input.type === "custom" ? asCustomPercent(input.percent) : null;
  const now = await prisma.priceBookDraftEstimate.findUnique({
    where: { id: draftId },
    select: { discountType: true, discountPercent: true },
  });
  if (!now) throw new DraftError(`Draft ${draftId} not found.`, 404);
  assertExpected({ type: now.discountType, percent: now.discountPercent }, input.expected, { type: input.type, percent });
  if (input.type === "custom" && percent === null) {
    throw new DraftError("A custom discount needs a percentage above 0 and at most 50.", 400);
  }
  // Already the programme asked for: a replay, or a re-press. No reopen, no write (see wouldChangeNothing).
  if (wouldChangeNothing(now, { discountType: input.type, discountPercent: percent })) return now;
  await reopenForEditIfUnsigned(prisma, draftId, "set discount", { signedStaysEditable: true });
  return prisma.priceBookDraftEstimate.update({
    where: { id: draftId },
    data: { discountType: input.type, discountPercent: percent },
    select: { discountType: true, discountPercent: true },
  });
}

/** The draft's option mode — additive (default) or one-or-the-other. */
export async function getOptionsMode(prisma: PrismaClient, draftId: string): Promise<{ exclusiveOptions: boolean }> {
  const draft = await prisma.priceBookDraftEstimate.findUnique({
    where: { id: draftId },
    select: { exclusiveOptions: true },
  });
  if (!draft) throw new DraftError("Draft not found.", 404);
  return draft;
}

/**
 * Option mode (Kyle, 2026-08-25).
 *
 * "A single EV Charger estimate, give 3 options on length from panel… Since these are to help
 *  decide the location and not 3 different EV Chargers they cannot be additive. A check box would
 *  be nice… I want to be able to choose either or options or the all that apply options."
 *
 * Per draft, frozen onto the issued estimate at graduation. Exclusive = the customer's page shows
 * radio buttons and the signature refuses anything but exactly one option.
 */
export async function setOptionsMode(
  prisma: PrismaClient,
  draftId: string,
  exclusive: boolean,
  /** `expected.exclusive`: the mode the sender last saw (Phase 7 replay rule, `assertExpected`). */
  opts: { expected?: { exclusive?: boolean } } = {},
): Promise<{ exclusiveOptions: boolean }> {
  const now = await getOptionsMode(prisma, draftId);
  assertExpected({ exclusive: now.exclusiveOptions }, opts.expected, { exclusive });
  // Already this mode: a replay, or a re-press. No reopen, no write (see wouldChangeNothing).
  if (now.exclusiveOptions === exclusive) return now;
  await reopenForEditIfUnsigned(prisma, draftId, "set option mode", { signedStaysEditable: true });
  return prisma.priceBookDraftEstimate.update({
    where: { id: draftId },
    data: { exclusiveOptions: exclusive },
    select: { exclusiveOptions: true },
  });
}

/** Kyle's names and short descriptions for the options, A first. Empty when none are named. */
export async function listOptionMeta(
  prisma: PrismaClient,
  draftId: string,
): Promise<Array<{ option: PriceBookOption; label: string | null; note: string | null }>> {
  return prisma.priceBookDraftOption.findMany({
    where: { draftId },
    orderBy: { option: "asc" },
    select: { option: true, label: true, note: true },
  });
}

/**
 * Naming the options (Kyle, 2026-08-20).
 *
 * "It would be nice to be able to rename the options at the review screen in order to specify the
 *  scope of work to the job being quoted. This is the perfect spot to make the title of each option
 *  reflect the itemized list that it represents. A Short description to add text in would be nice
 *  too."
 *
 * These names are frozen onto the issued estimate at graduation and are what the customer reads
 * on the tick boxes — "Exterior pathway lights" rather than "Option B". Upsert rather than create:
 * there is exactly one name per option per draft, and renaming is the normal case. An empty
 * string CLEARS the name rather than storing "", so the document falls back to the bare letter
 * instead of rendering a nameless heading.
 */
export async function setOptionMeta(
  prisma: PrismaClient,
  draftId: string,
  option: EstimateOption,
  input: {
    label?: string | null;
    note?: string | null;
    /** What the sender last saw (Phase 7 replay rule, `assertExpected`); no row yet reads as blank. */
    expected?: { label?: string | null; note?: string | null };
  },
): Promise<{ option: PriceBookOption; label: string | null; note: string | null }> {
  const label = input.label?.trim() ? input.label.trim() : null;
  const note = input.note?.trim() ? input.note.trim() : null;
  const now = await prisma.priceBookDraftOption.findUnique({
    where: { draftId_option: { draftId, option: option as PriceBookOption } },
    select: { label: true, note: true },
  });
  assertExpected({ label: now?.label ?? null, note: now?.note ?? null }, input.expected, { label, note });
  // The row already says this: a replay, or a re-press. No reopen, no write (see wouldChangeNothing).
  // Only when the row EXISTS — with no row there is no stored value, and the upsert below is what
  // makes one, exactly as before.
  if (now && wouldChangeNothing(now, { label, note })) return { option: option as PriceBookOption, label: now.label, note: now.note };
  await reopenForEditIfUnsigned(prisma, draftId, `name option ${option}`, { signedStaysEditable: true });
  return prisma.priceBookDraftOption.upsert({
    where: { draftId_option: { draftId, option: option as PriceBookOption } },
    create: { draftId, option: option as PriceBookOption, label, note },
    update: { label, note },
    select: { option: true, label: true, note: true },
  });
}

/**
 * Copy an option's lines into another (Kyle, 2026-08-25).
 *
 * "It would be nice to be able to copy an option to another so I could build on it" — build the
 * 10-foot run once in A, copy to B and C, change one length each. Lines are duplicated with their
 * quantity, difficulty, location, note and confirm state intact; APPENDS to the target, never
 * replaces what's already there.
 */
export async function copyOptionLines(
  prisma: PrismaClient,
  draftId: string,
  from: EstimateOption,
  to: EstimateOption,
): Promise<{ copied: number; from: EstimateOption; to: EstimateOption }> {
  if (from === to) throw new DraftError("Source and target options are the same.", 400);
  await reopenForEditIfUnsigned(prisma, draftId, `copy option ${from} to ${to}`);
  const lines = await prisma.priceBookDraftLine.findMany({
    where: { draftId, option: from as PriceBookOption },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });
  if (lines.length === 0) throw new DraftError(`Option ${from} has no lines to copy.`, 400);
  // The copies go AFTER everything already in the draft, in the source's own order. They used to
  // carry the source's sortOrder, which put a copy of the first line at the top of the target
  // option, in front of lines Kyle had already arranged there (2026-10-08).
  const firstSortOrder = await nextSortOrder(prisma, draftId);
  await prisma.priceBookDraftLine.createMany({
    data: lines.map((l, i) => ({
      draftId,
      itemId: l.itemId,
      quantity: l.quantity,
      quantitySource: l.quantitySource,
      difficulty: l.difficulty,
      location: l.location,
      note: l.note,
      // The job-specific name travels with the line (Kyle, 2026-10-27).
      customName: l.customName,
      sortOrder: firstSortOrder + i,
      option: to as PriceBookOption,
      state: l.state,
      proposedBy: l.proposedBy,
      proposalReasoning: l.proposalReasoning,
      proposedAt: l.proposedAt,
      confirmedBy: l.confirmedBy,
      confirmedAt: l.confirmedAt,
      editedBeforeConfirm: l.editedBeforeConfirm,
    })),
  });
  return { copied: lines.length, from, to };
}

// ─── OPTIONS D-H AND LINE ORDER — one set, both doors (Kyle, 2026-10-08) ─────────────
//
// Kyle: "I want to be able to add more than 3 options for projects that are more expansive. I want
// to have a create additional option button here which will continue the options past 'C'." and
// "I would like to be able to drag and drop line items on the review screen." Adding an option,
// removing one and saving the line order are each ONE function here; the CRM routes (src/app.ts)
// and the tech routes (src/routes/health-record.ts, behind `quoteDraftForTech`) wrap them and
// nothing else. The rules below are not restated in either route file.

/** The client a service function may be handed: the real one, or a transaction's. */
type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Which options a draft has, and what "Add option" would create next.
 *
 * A, B and C are always there. Any other letter is there if it has a PriceBookDraftOption row
 * ("Add option" writes one so an EMPTY Option D survives a reload) or a line (a line can be put in
 * D without ever pressing Add — the server accepts every letter). The engine's own option list
 * knows only options that have lines (summarizeOptions), which is why this reads the rows too.
 *
 * Built here once and returned by BOTH the CRM review payload and the tech quote payload, so no
 * screen re-derives which options exist.
 */
export async function getDraftOptionSet(db: Db, draftId: string): Promise<DraftOptionSet> {
  const draft = await db.priceBookDraftEstimate.findUnique({ where: { id: draftId }, select: { id: true, status: true } });
  if (!draft) throw new DraftError(`Draft ${draftId} not found.`, 404);
  const rows = await db.priceBookDraftOption.findMany({
    where: { draftId },
    select: { option: true, label: true, note: true },
  });
  const counts = await db.priceBookDraftLine.groupBy({
    by: ["option"],
    where: { draftId },
    _count: { _all: true },
  });
  const rowOf = new Map(rows.map((r) => [r.option as string, r]));
  const countOf = new Map(counts.map((c) => [c.option as string, c._count._all]));
  const baseOptions: readonly string[] = BASE_OPTIONS;
  const options: DraftOptionEntry[] = ALL_OPTIONS
    .filter((o) => baseOptions.includes(o) || rowOf.has(o) || (countOf.get(o) ?? 0) > 0)
    .map((o) => ({
      option: o,
      label: rowOf.get(o)?.label ?? null,
      note: rowOf.get(o)?.note ?? null,
      lineCount: countOf.get(o) ?? 0,
      removable: !baseOptions.includes(o),
    }));
  return {
    options,
    nextOption: nextFreeOption(options.map((o) => o.option)),
    lockedReason: await draftLockedReason(db, draftId, draft.status),
  };
}

/**
 * "+ Add Option D": give the draft its next option.
 *
 * Which letter: the LOWEST one after C the draft does not have (`nextFreeOption`). Removing an
 * option leaves a gap and never re-letters the others — lines, names, the customer's page and
 * issued rows all refer to the letter — so the next Add fills the gap first rather than going one
 * past the highest.
 *
 * Cap: eight (Kyle, 2026-10-08: "Capping it at eight is good."). Past H is refused with the words
 * the button shows greyed.
 *
 * Guard: the same one `addLine` carries. A finalized-but-unsigned draft reopens; a SIGNED one
 * refuses outright — an extra option changes what the customer is offered, and the signed
 * agreement is changed only by a change order. (Unlike naming an option, this does not use
 * `signedStaysEditable`: a name only takes effect through a new revision, but a new option is the
 * first step of putting more work in the draft, which a signed draft refuses everywhere.)
 *
 * The cap is checked BEFORE the reopen so a refused press does not flip an issued draft back to
 * "draft". The row is written under the (draftId, option) unique key: two presses landing at once
 * both want the same letter, the loser gets P2002 and picks the next free one.
 *
 * `letter` (Phase 7, offline estimating, 2026-10-09): the letter the sender's screen showed it was
 * adding, so a replay after a lost answer cannot add a SECOND option. Already on the draft → returned
 * with `created: false` and nothing written (A, B and C are always on it). Equal to `nextOption` →
 * the same create path as a press with no letter. Any other letter → 409: the draft moved on
 * underneath them, and inventing a different letter than the one their lines were queued for would
 * strand those lines. The P2002 loser re-reads the set and, with a letter, finds it present.
 */
export async function addOption(
  prisma: PrismaClient,
  draftId: string,
  letter?: string,
): Promise<{ option: EstimateOptionLetter; optionSet: DraftOptionSet; created: boolean }> {
  if (letter !== undefined && !isEstimateOption(letter)) throw new DraftError(`Unknown option "${letter}".`, 400);
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await getDraftOptionSet(prisma, draftId);
    if (letter !== undefined && before.options.some((o) => o.option === letter)) {
      return { option: letter, optionSet: before, created: false };
    }
    if (letter !== undefined && letter !== before.nextOption) {
      throw new DraftError(
        before.nextOption
          ? `Option ${letter} is not the next one to add — the next is ${before.nextOption}. Look at the quote again.`
          : `Option ${letter} cannot be added — ${OPTION_LIMIT_REASON}.`,
        409,
      );
    }
    const next = before.nextOption;
    if (!next) throw new DraftError(`${OPTION_LIMIT_REASON}.`, 400);
    await reopenForEditIfUnsigned(prisma, draftId, `add option ${next}`);
    try {
      await prisma.priceBookDraftOption.create({
        data: { draftId, option: next as PriceBookOption, label: null, note: null },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") continue;
      throw err;
    }
    return { option: next, optionSet: await getDraftOptionSet(prisma, draftId), created: true };
  }
  throw new DraftError("Another change added an option at the same moment — try again.", 409);
}

/**
 * "Remove Option D": take an ADDED option off the draft, with its lines.
 *
 * Only D through H. A, B and C are permanent (refused with the reason), and so is the rest of the
 * standing rule: an option that was added can always be taken away, from the screen that added it.
 *
 * Deletes the option's PriceBookDraftOption row (its name and note) AND every line in it, proposed
 * or confirmed, in ONE transaction, and returns how many lines went — the screen asks "Option D has
 * N lines — remove them too?" before it calls, and shows the number afterwards. Letters after it are
 * left exactly as they are (no re-lettering; see `addOption`).
 *
 * Guard: finalized-unsigned reopens, SIGNED refuses, exactly as `removeLine` does. The draft is
 * left untouched when the option is not on it (404) or is A/B/C (400) — those are checked first,
 * so a refused press does not reopen anything. An estimate already issued froze its own options
 * and lines at graduation and reads none of this back; removal reaches the customer only through
 * "Save changes to the estimate".
 *
 * `expectedLines` is the count the person agreed to ("Option D has 3 lines — remove them too?",
 * or none when it showed 0). The other app can add lines to the option after this screen loaded;
 * when the count in the option now is not the count they saw, NOTHING is deleted and the answer is
 * a 409 saying so (2026-10-08 review). Checked before the reopen (a refused press does not flip
 * the draft) and again inside the transaction. Undefined skips the check — a caller with no count
 * to show (a script) — but both screens always send one.
 */
export async function removeOption(
  prisma: PrismaClient,
  draftId: string,
  option: string,
  expectedLines?: number,
): Promise<{ option: EstimateOptionLetter; linesRemoved: number; optionSet: DraftOptionSet }> {
  const set = await getDraftOptionSet(prisma, draftId);
  if (!isEstimateOption(option)) throw new DraftError(`Unknown option "${option}".`, 400);
  if ((BASE_OPTIONS as readonly string[]).includes(option)) {
    throw new DraftError(
      `Option ${option} cannot be removed — A, B and C are always part of an estimate. ` +
        `Move its lines to another option or delete them instead.`,
      400,
    );
  }
  if (!set.options.some((o) => o.option === option)) {
    throw new DraftError(`Option ${option} is not on this estimate.`, 404);
  }
  const checkCount = async (db: Db) => {
    if (expectedLines === undefined) return;
    const now = await db.priceBookDraftLine.count({ where: { draftId, option: option as PriceBookOption } });
    if (now !== expectedLines) {
      throw new DraftError(
        `Option ${option} now has ${now} line${now === 1 ? "" : "s"}, not ${expectedLines} — ` +
          `someone changed it while this screen was open. Look at it again before removing it.`,
        409,
      );
    }
  };
  await checkCount(prisma);
  await reopenForEditIfUnsigned(prisma, draftId, `remove option ${option}`);
  const linesRemoved = await prisma.$transaction(async (tx) => {
    await checkCount(tx);
    const lines = await tx.priceBookDraftLine.deleteMany({ where: { draftId, option: option as PriceBookOption } });
    await tx.priceBookDraftOption.deleteMany({ where: { draftId, option: option as PriceBookOption } });
    return lines.count;
  });
  return { option, linesRemoved, optionSet: await getDraftOptionSet(prisma, draftId) };
}

/** One line's place in a saved order. */
export interface LineOrderEntry {
  lineId: string;
  option: string;
  /**
   * The option the sender believes this line is in NOW — what its screen last showed. When it is
   * not what the draft holds, the other app moved the line since, and writing `option` would
   * quietly undo that move; the save is refused with a 409 (nothing written) instead
   * (2026-10-08 review). Both screens always send it; absent skips the check (a script).
   * Only the OPTION is guarded: a stale POSITION inside one option costs a visible reshuffle,
   * a stale option changes which choice the customer is offered and what it costs.
   */
  was?: string;
}

/** The body both doors read for `line-order` — one schema, so the CRM and the tech cannot diverge. */
export const lineOrderBodySchema = z.object({
  order: z.array(z.object({
    lineId: z.string().trim().min(1),
    // A string, not z.enum: an unknown letter is the service's refusal, worded the same on both
    // doors, rather than a parse error with a different shape.
    option: z.string().trim().toUpperCase().max(4),
    was: z.string().trim().toUpperCase().max(4).optional(),
  })).max(1000),
});

/** `?expectedLines=N` on DELETE .../options/:option — see `removeOption`. */
export const expectedLinesSchema = z.coerce.number().int().min(0).optional();

/**
 * Check a proposed line order against the draft as it is NOW. Throws a DraftError (400) saying
 * what is wrong; returns the draft's lines when it is sound. Run before the reopen guard (so a bad
 * list does not reopen an issued draft) and again inside the transaction (so a line added or
 * deleted in the meantime cannot slip through).
 */
async function checkLineOrder(db: Db, draftId: string, order: readonly LineOrderEntry[]) {
  const set = await getDraftOptionSet(db, draftId);
  const have = new Set(set.options.map((o) => o.option as string));
  const seen = new Set<string>();
  for (const entry of order) {
    if (!isEstimateOption(entry.option)) throw new DraftError(`Unknown option "${entry.option}".`, 400);
    if (!have.has(entry.option)) {
      throw new DraftError(`Option ${entry.option} is not on this estimate — add it first.`, 400);
    }
    if (seen.has(entry.lineId)) throw new DraftError("The same line appears twice in the order.", 400);
    seen.add(entry.lineId);
  }
  const lines = await db.priceBookDraftLine.findMany({
    where: { draftId },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    select: { id: true, state: true, option: true, sortOrder: true },
  });
  const ids = new Set(lines.map((l) => l.id));
  const foreign = order.filter((e) => !ids.has(e.lineId));
  if (foreign.length > 0) {
    throw new DraftError(
      `${foreign.length} line(s) in the order are not on this estimate — reload it and try again.`,
      400,
    );
  }
  const currentOption = new Map(lines.map((l) => [l.id, l.option as string]));
  const moved = order.filter((e) => e.was !== undefined && currentOption.get(e.lineId) !== e.was);
  if (moved.length > 0) {
    throw new DraftError(
      `${moved.length} line(s) were moved to another option by someone else while this screen was open — ` +
        `nothing was saved. Reload the estimate and try again.`,
      409,
    );
  }
  const left = lines.filter((l) => l.state === "CONFIRMED" && !seen.has(l.id));
  if (left.length > 0) {
    throw new DraftError(
      `The order leaves out ${left.length} line(s) on this estimate — reload it and try again. ` +
        `A partial order is refused so no two lines end up in the same place.`,
      400,
    );
  }
  return lines;
}

/**
 * Save the order of the lines on a draft, and which option each one is in (drag-and-drop in Review).
 *
 * Kyle, 2026-10-08: "...I made a mistake and added some to option 'B' that were supposed to be on
 * option 'C' then I can drag and drop them where they need to be rather than delete and rebuild ...
 * allow me to organize the line items so the presentation can be set up to explain the install start
 * to finish." Two jobs in one call: move a line to another option, and put lines in install order.
 * The order IS the feature — the presentation, the issued estimate and the PDF all read lines by
 * sortOrder and none of them re-sorts.
 *
 * Takes the FULL ordered list for the draft and replaces the whole order or nothing. Within one
 * transaction, `sortOrder = index` and `option` are set on each. Refused (400, nothing written) when:
 *   - a line id is not on this draft;
 *   - a CONFIRMED line is missing from the list (a partial list would leave two lines in one place);
 *   - a line appears twice;
 *   - an option is not a letter, or is a letter the draft does not have (add it first).
 * AI-PROPOSED lines are not part of the order — the screens do not let them be dragged, they get
 * confirmed first. They may be left out of the list; they are numbered after the last listed line
 * (their own option and relative order kept) so no two lines share a position, and they land in
 * order when confirmed. A listed proposed line is placed like any other.
 *
 * Renumbering the whole draft at once also clears the all-zeros state that hand-added lines had
 * before 2026-10-08. Rows already in the right place are not rewritten.
 *
 * Guard: the same as `editLine` — a finalized-unsigned draft reopens, a SIGNED one refuses.
 */
export async function saveLineOrder(
  prisma: PrismaClient,
  draftId: string,
  order: readonly LineOrderEntry[],
): Promise<{ saved: number; changed: number }> {
  const before = await checkLineOrder(prisma, draftId, order);
  // The draft is already in this order: a replay, or a re-press. No reopen, nothing written
  // (see wouldChangeNothing above editLine — the same rule, for the same reason).
  if (lineOrderUpdates(before, order).length === 0) return { saved: order.length, changed: 0 };
  await reopenForEditIfUnsigned(prisma, draftId, "reorder lines");
  return prisma.$transaction(async (tx) => {
    const lines = await checkLineOrder(tx, draftId, order);
    const updates = lineOrderUpdates(lines, order);
    for (const u of updates) await tx.priceBookDraftLine.update({ where: { id: u.id }, data: u.data });
    return { saved: order.length, changed: updates.length };
  });
}

/**
 * The rows a line order would rewrite, against the lines as they are now — only those not already
 * in place. Pure, so the no-op check before the reopen guard and the transaction cannot disagree.
 */
function lineOrderUpdates(
  lines: readonly { id: string; option: string; sortOrder: number }[],
  order: readonly LineOrderEntry[],
): { id: string; data: { sortOrder: number; option?: PriceBookOption } }[] {
  const byId = new Map(lines.map((l) => [l.id, l]));
  const updates: { id: string; data: { sortOrder: number; option?: PriceBookOption } }[] = [];
  for (let i = 0; i < order.length; i++) {
    const want = order[i];
    const cur = byId.get(want.lineId)!;
    if (cur.sortOrder === i && cur.option === want.option) continue;
    updates.push({ id: want.lineId, data: { sortOrder: i, option: want.option as PriceBookOption } });
  }
  // Lines the list did not name (AI proposals only — a confirmed one would have been refused),
  // after the last listed line, in the order they already had.
  const listed = new Set(order.map((e) => e.lineId));
  let next = order.length;
  for (const l of lines) {
    if (listed.has(l.id)) continue;
    if (l.sortOrder !== next) updates.push({ id: l.id, data: { sortOrder: next } });
    next++;
  }
  return updates;
}

/**
 * Raise a question by hand — where an unresolved walkthrough row lands. A line the system cannot
 * match must become a visible question, never dropped text. An open question blocks issue
 * (finalizeDraft), which is why it is a draft mutation and carries the signed-draft guard.
 */
export async function raiseQuestion(
  prisma: PrismaClient,
  draftId: string,
  input: { question: string; rawText?: string | null; raisedBy: string },
) {
  await reopenForEditIfUnsigned(prisma, draftId, "raise question");
  return prisma.priceBookDraftQuestion.create({
    data: {
      draftId,
      question: input.question,
      rawText: input.rawText ?? null,
      raisedBy: input.raisedBy,
    },
  });
}

/**
 * Why a draft cannot be copied into a new quote, or null when it can (2026-10-08 review of the
 * Phase 2 field Quote screen).
 *
 * `duplicateDraft` deliberately drops `changeOrderForId` ("a fresh estimate is not a change order
 * on the old one") and keeps the visit. For an ordinary quote that is exactly right. For a CHANGE
 * ORDER or a diagnostic's RESOLUTIONS draft it is wrong twice over: the copy is an ordinary draft
 * and the newest one on the visit, so `workingDraftForVisit` hands it back as "Build the quote"
 * and it takes the job's real quote's place; and the change order's credit lines (negative
 * quantities, legal only on a change order) land on an ordinary estimate, where `createMany`
 * checks nothing. Both are drafts "opened by id from the job or the diagnostic, never as the
 * visit's quote" (workingDraftForVisit) — so they cannot be copied into one either.
 *
 * Said in one sentence so both screens grey "Copy to a new quote" with it (lifecycle.copyReason)
 * rather than hide the button, and `duplicateDraft` refuses with the same words on both doors.
 */
export async function draftCopyReason(db: Db, draftId: string): Promise<string | null> {
  const draft = await db.priceBookDraftEstimate.findUnique({ where: { id: draftId }, select: { changeOrderForId: true } });
  if (!draft) return null;
  if (draft.changeOrderForId) return COPY_REFUSED_CHANGE_ORDER;
  const owner = await db.diagnosticReport.findFirst({ where: { changeOrderDraftId: draftId }, select: { id: true } });
  if (owner) return COPY_REFUSED_DIAGNOSTIC;
  return null;
}

/**
 * Duplicate a draft (Kyle, 2026-08-31).
 *
 * "I also need a way to create a new version from already sent estimates. I want to be able to
 *  take one, have it copied exactly the way it is into the estimate builder, and begin editing it
 *  to send it as a new estimate."
 *
 * Copies the draft behind an estimate — lines with their confirm state, option names, discount,
 * resolved questions, the rate snapshot — into a brand-new EDITABLE draft (status "draft", never
 * finalized). The sent estimate and its own draft are untouched; issuing the copy produces a NEW
 * estimate number, not a revision. changeOrderForId is deliberately not copied — a fresh estimate
 * is not a change order on the old one.
 *
 * No signed-draft guard on the SOURCE, on purpose: the source is read, never written, and
 * copying a signed estimate's draft to re-quote it fresh is the whole reason this exists.
 *
 * No `photos`: a draft's photos live on its JOB as VisitPhotos (plan A, 2026-10-02), so a copy
 * of the draft already shares them — there is nothing to duplicate.
 */
export async function duplicateDraft(prisma: PrismaClient, sourceId: string): Promise<{ id: string; title: string }> {
  const source = await prisma.priceBookDraftEstimate.findUnique({
    where: { id: sourceId },
    include: { lines: true, questions: true, optionMeta: true },
  });
  if (!source) throw new DraftError(`Draft ${sourceId} not found.`, 404);
  const refusal = await draftCopyReason(prisma, sourceId);
  if (refusal) throw new DraftError(refusal, 400);
  const rate = await loadRateContext(prisma);
  const copy = await prisma.priceBookDraftEstimate.create({
    data: {
      title: source.title,
      leadId: source.leadId,
      customerId: source.customerId,
      visitId: source.visitId,
      supplierId: source.supplierId,
      jobDescription: source.jobDescription,
      scenarioRef: source.scenarioRef,
      exclusiveOptions: source.exclusiveOptions,
      // Editable from the first click — the whole point of the copy.
      status: "draft",
      // A fresh rate snapshot, not the source's: the copy prices live at today's Rate Config
      // and book, so its record must say today's rate (Kyle, 2026-09-01 — a copy of a $150
      // estimate is a $100 estimate now).
      billedLaborRate: rate.rc.billedLaborRate,
      rateProvisional: rate.provisional,
      provisionalReason: rate.provisionalReason,
      notes: source.notes,
      discountType: source.discountType,
      discountPercent: source.discountPercent,
    },
  });
  if (source.lines.length > 0) {
    await prisma.priceBookDraftLine.createMany({
      data: source.lines.map((l) => ({
        draftId: copy.id,
        itemId: l.itemId,
        quantity: l.quantity,
        quantitySource: l.quantitySource,
        difficulty: l.difficulty,
        location: l.location,
        note: l.note,
        customName: l.customName,
        sortOrder: l.sortOrder,
        option: l.option,
        state: l.state,
        proposedBy: l.proposedBy,
        proposalReasoning: l.proposalReasoning,
        proposedAt: l.proposedAt,
        confirmedBy: l.confirmedBy,
        confirmedAt: l.confirmedAt,
        editedBeforeConfirm: l.editedBeforeConfirm,
      })),
    });
  }
  if (source.questions.length > 0) {
    await prisma.priceBookDraftQuestion.createMany({
      data: source.questions.map((q) => ({
        draftId: copy.id,
        question: q.question,
        rawText: q.rawText,
        raisedBy: q.raisedBy,
        resolvedAt: q.resolvedAt,
        resolvedBy: q.resolvedBy,
        resolutionNote: q.resolutionNote,
      })),
    });
  }
  if (source.optionMeta.length > 0) {
    await prisma.priceBookDraftOption.createMany({
      data: source.optionMeta.map((o) => ({
        draftId: copy.id,
        option: o.option,
        label: o.label,
        note: o.note,
      })),
    });
  }
  return { id: copy.id, title: copy.title };
}

// ─── DRAFT LIFECYCLE: title & scope, delete, the visit's working draft ─────────────────────────
//
// (2026-10-08, "one estimating system", Phase 2 unit B.) Each of these is ONE function the CRM
// route (src/app.ts) and the tech route (src/routes/health-record.ts, behind quoteDraftForTech)
// wrap and nothing else. Where a draft stands — issued, changed since, deletable — is answered by
// `getDraftLifecycle` in issuedEstimateService.ts (it is about the issued row, and it must share
// the issue door's own lookup and wording); the draft-side rules live here.

/**
 * What a title / scope edit may carry. The body schema BOTH doors parse, so the bounds and the
 * wording of a refusal cannot drift between them. Either field alone is a valid edit; a body that
 * names neither changes nothing and is refused.
 */
export const draftDetailsBodySchema = z
  .object({
    title: z.string().trim().min(1, "The estimate needs a title.").max(200).optional(),
    jobDescription: z.string().trim().max(4000).nullable().optional(),
    // What the sender last saw (Phase 7 replay rule, `assertExpected`). Optional on both doors.
    expected: z.object({
      title: z.string().nullable().optional(),
      jobDescription: z.string().nullable().optional(),
    }).optional(),
  })
  .refine((b) => b.title !== undefined || b.jobDescription !== undefined, { message: "Nothing to change." });

/**
 * The estimate's TITLE and its SCOPE OF WORK (jobDescription) — edited on the draft, from either
 * app, after creation.
 *
 * The audit (2026-10-08 §2): no CRM route could rename a draft or edit its jobDescription once it
 * existed, and the field had no words for either — the server named every field quote
 * "customer — address". The customer reads both at the top of their page and the PDF, so if the
 * field is where estimates get built, this is what the customer sees.
 *
 * THE DRAFT'S VALUES ARE THE ESTIMATE'S: `graduateDraft` falls back to `draft.title` and
 * `draft.jobDescription` (issuedEstimateService.ts ~418), `reviseEstimate` re-reads them on every
 * revision (same file), and a title or scope handed to the issue route is written HERE first
 * (`issueDraft`). One record, read everywhere.
 *
 * Guard: `signedStaysEditable`, like the discount, the option names and the option mode (Kyle,
 * 2026-09-29) — the issued row froze its own title and scope at graduation and reads neither back,
 * so an edit here reaches the customer only through "Save changes to the estimate", a revision
 * they sign again. On an unsigned issued draft the edit reopens it honestly; on a signed one it is
 * saved without flipping the status, so the revise that follows finds the draft as it expects. (The
 * field screen still greys the editor on a signed quote — the truck cannot press that button, so a
 * change made there would sit on the draft unseen. That is a screen rule, not this one.)
 *
 * An empty scope clears it (null) rather than storing "".
 */
export async function setDraftDetails(
  prisma: PrismaClient,
  draftId: string,
  input: {
    title?: string;
    jobDescription?: string | null;
    /** What the sender last saw (Phase 7 replay rule, `assertExpected`). */
    expected?: { title?: string | null; jobDescription?: string | null };
  },
): Promise<{ id: string; title: string; jobDescription: string | null }> {
  const data: Prisma.PriceBookDraftEstimateUpdateInput = {};
  if (input.title !== undefined) data.title = input.title.trim();
  if (input.jobDescription !== undefined) {
    const scope = input.jobDescription?.trim() ?? "";
    data.jobDescription = scope === "" ? null : scope;
  }
  const now = await prisma.priceBookDraftEstimate.findUnique({
    where: { id: draftId },
    select: { id: true, title: true, jobDescription: true },
  });
  if (!now) throw new DraftError(`Draft ${draftId} not found.`, 404);
  assertExpected(now, input.expected, data as Record<string, unknown>);
  // Already says this (or names nothing): a replay, or a re-press. No reopen, no write (see wouldChangeNothing).
  if (wouldChangeNothing(now, data as Record<string, unknown>)) return now;
  await reopenForEditIfUnsigned(prisma, draftId, "title / scope", { signedStaysEditable: true });
  return prisma.priceBookDraftEstimate.update({
    where: { id: draftId },
    data,
    select: { id: true, title: true, jobDescription: true },
  });
}

/**
 * Why a draft cannot be deleted, or null when it can.
 *
 * Once ANYTHING has been issued from a draft — signed or not, live, void or lost — the draft is that
 * estimate's record (IssuedEstimate.draftId is `onDelete: Restrict`), and the exit is on the
 * estimate itself: the CRM Estimates page deletes an unsigned estimate outright (Kyle, 2026-08-22,
 * "True delete for unsigned"), voids a signed one, or marks it lost. After an unsigned estimate is
 * deleted there, the draft has nothing issued from it and can be deleted here. Said in one sentence
 * so both screens grey "Delete this quote" with it rather than hiding the button.
 */
export async function draftDeleteReason(db: Db, draftId: string): Promise<string | null> {
  const issued = await db.issuedEstimate.findFirst({
    where: { draftId },
    orderBy: [{ createdAt: "desc" }],
    select: { number: true, signedAt: true, status: true },
  });
  if (!issued) return null;
  const state = issued.signedAt
    ? "is SIGNED"
    : issued.status === "void"
      ? "was voided"
      : issued.status === "lost"
        ? "is marked lost"
        : "was issued";
  return (
    `Estimate ${issued.number} ${state} from this quote, so the quote is its record and stays. ` +
    `The way out is on the estimate itself, from the Estimates page in the office: delete it while ` +
    `it is unsigned, void it, or mark it lost.`
  );
}

/**
 * Delete a draft nothing has been issued from — the exit the standing rule requires
 * ("nothing the app creates is permanent"; Kyle, 2026-09-18). A tech who started a quote on the
 * wrong visit, or the office with a speculative draft, had no way out before this (2026-09-24
 * field-estimate-parity plan, Unit C; the CRM had no draft delete either, despite the audit table
 * saying so).
 *
 * Refused with `draftDeleteReason`'s sentence (409) once anything was issued. Lines, questions and
 * option names go with it in one transaction, and a diagnostic report that pointed at this draft as
 * its resolutions draft is unlinked, so "Build the resolutions change order" raises a fresh one
 * instead of resuming an id that no longer exists.
 */
export async function deleteDraft(prisma: PrismaClient, draftId: string): Promise<{ deleted: true; title: string }> {
  const draft = await prisma.priceBookDraftEstimate.findUnique({ where: { id: draftId }, select: { id: true, title: true } });
  if (!draft) throw new DraftError(`Draft ${draftId} not found.`, 404);
  const reason = await draftDeleteReason(prisma, draftId);
  if (reason) throw new DraftError(reason, 409);
  await prisma.$transaction(async (tx) => {
    await tx.priceBookDraftLine.deleteMany({ where: { draftId } });
    await tx.priceBookDraftQuestion.deleteMany({ where: { draftId } });
    await tx.priceBookDraftOption.deleteMany({ where: { draftId } });
    await tx.diagnosticReport.updateMany({ where: { changeOrderDraftId: draftId }, data: { changeOrderDraftId: null } });
    await tx.priceBookDraftEstimate.delete({ where: { id: draftId } });
  });
  logSystemEvent("info", "price-book", `Draft "${draft.title}" deleted (${draftId}) — nothing had been issued from it`, {
    draftId,
  });
  return { deleted: true, title: draft.title };
}

/**
 * THE visit's quote — the draft "Build the quote" resumes on the phone.
 *
 * Before 2026-10-08 the tech route resumed only `status: "draft"`, and issuing marks a draft
 * "finalized" (finalizeDraft), so a tech's edit after issue silently started a NEW draft and a NEW
 * estimate number for the same job (audit §1.3) — while the office's Edit button reopened the same
 * draft and "Save changes to the estimate" revised it. One rule now, here:
 *
 *   the NEWEST draft on the visit that is
 *     - not a change order (`changeOrderForId: null` — a change order describes the CHANGE and is
 *       opened by id from the diagnostic or the job, never as the visit's quote; never widen this),
 *     - not a diagnostic's resolutions draft (a diagnostic raised with no signed root makes an
 *       ordinary draft on the visit, diagnosticReport.ts; it is reached from the diagnostic report
 *       and must not become the main quote — identified by the DiagnosticReport that owns it),
 *     - and, if it has been issued, whose live estimate is not VOID or ARCHIVED (a voided estimate
 *       is off the books and an archived one was put away; the next quote starts fresh).
 *
 * A resumed draft may be issued (the phone shows the estimate and offers "Edit the estimate"),
 * SIGNED (locked, with the reason) or LOST ("reopen it first", the Phase 0 rule) — the quote
 * payload's `lifecycle` says which. Null means the route creates a new draft.
 */
export async function workingDraftForVisit(
  prisma: PrismaClient,
  visitId: string,
): Promise<{ id: string; status: string } | null> {
  const candidates = await prisma.priceBookDraftEstimate.findMany({
    where: { visitId, changeOrderForId: null },
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true },
  });
  if (candidates.length === 0) return null;
  const ownedByDiagnostic = new Set(
    (
      await prisma.diagnosticReport.findMany({
        where: { changeOrderDraftId: { in: candidates.map((c) => c.id) } },
        select: { changeOrderDraftId: true },
      })
    ).map((r) => r.changeOrderDraftId),
  );
  for (const candidate of candidates) {
    if (ownedByDiagnostic.has(candidate.id)) continue;
    if (candidate.status === "draft") return candidate;
    const live = await prisma.issuedEstimate.findFirst({
      where: { draftId: candidate.id, supersededBy: null },
      orderBy: { revision: "desc" },
      select: { status: true, archivedAt: true },
    });
    if (live && (live.status === "void" || live.archivedAt)) continue;
    return candidate;
  }
  return null;
}

/**
 * "Build the quote": the visit's working draft, or a new one — ONE rule for the tech door
 * (Phase 7, offline estimating, 2026-10-09; the title and supplier logic moved here from the
 * POST /visits/:visitId/quote route in routes/health-record.ts so the replay route cannot drift
 * from it).
 *
 * Which draft is the visit's quote is `workingDraftForVisit`'s rule, unchanged. The new draft is
 * titled "<customer> — <address>" at the book's active supplier, as the route always did.
 *
 * `clientDraftId` is the id a phone minted with no signal (constants.md idempotency convention):
 *   - a draft with that id already exists on this visit → it IS this request's earlier delivery,
 *     answered as resumed, nothing written;
 *   - that id exists on another visit → 409, never adopted;
 *   - a DIFFERENT working draft exists → 409 carrying `existingDraftId`, so the phone can offer
 *     "Add my N lines to it" — the office (or another phone) started this visit's quote first, and
 *     a second quote for one visit is exactly what "one quote per visit, resumable" forbids;
 *   - otherwise the draft is created under that id.
 * Without a client id it is find-or-create, exactly as the POST route has always behaved.
 *
 * Two phones starting a visit's first quote at the same instant can still make two drafts —
 * find-then-create is not atomic. That race exists today and this does not widen it.
 */
/**
 * The supplier a tech-started quote prices at: the workbook's ACTIVE SUPPLIER, "HD" when Rate
 * Config names none. ONE rule for the quote the phone starts (openOrCreateWorkingDraft) and for the
 * price sheet the phone keeps for a preview with no signal (fieldPriceSheet.ts, 2026-10-09): a sheet
 * built at one supplier and a quote started at another could never be previewed from it.
 */
export function draftSupplierFor(rc: Pick<RateConfig, "activeSupplier">): string {
  return rc.activeSupplier ?? "HD";
}

export async function openOrCreateWorkingDraft(
  prisma: PrismaClient,
  visitId: string,
  clientDraftId?: string,
): Promise<{ draftId: string; resumed: boolean }> {
  if (clientDraftId) {
    const mine = await prisma.priceBookDraftEstimate.findUnique({
      where: { id: clientDraftId },
      select: { id: true, visitId: true },
    });
    if (mine) {
      if (mine.visitId !== visitId) {
        throw new DraftError(`Quote ${clientDraftId} belongs to another visit — it cannot be this visit's quote.`, 409);
      }
      return { draftId: mine.id, resumed: true };
    }
  }
  const existing = await workingDraftForVisit(prisma, visitId);
  if (existing) {
    if (clientDraftId) {
      throw new DraftError("The office already started a quote for this visit.", 409, { existingDraftId: existing.id });
    }
    return { draftId: existing.id, resumed: true };
  }
  const visit = await prisma.visit.findUnique({
    where: { id: visitId },
    select: { id: true, customer: { select: { name: true } }, property: { select: { addressLine1: true } } },
  });
  if (!visit) throw new DraftError("Visit not found", 404);
  const { rc } = await loadRateContext(prisma);
  const draft = await createDraft(prisma, {
    id: clientDraftId,
    title: `${visit.customer.name} — ${visit.property.addressLine1}`,
    supplierId: draftSupplierFor(rc),
    visitId,
    jobDescription: null,
  });
  return { draftId: draft.id, resumed: false };
}

/**
 * Attach a context-free draft to an account and address (P029 follow-up).
 *
 * The move to account-first estimating removed the context-free entry point, which would have
 * stranded the drafts created under it. This attaches one so it can continue normally — migrated,
 * not orphaned, and never by inventing a placeholder account.
 *
 * Deliberately STRICTER than `reopenForEditIfUnsigned`: a draft that has been issued already has
 * its account on the issued estimate, and a revision keeps that account (`reviseEstimate`), so
 * re-attaching an issued draft would change nothing the customer sees and could only mislead the
 * builder. "draft" status only, as it always was.
 */
export async function attachDraftToAccount(
  prisma: PrismaClient,
  draftId: string,
  input: { accountId: string; serviceAddressId: string },
) {
  const draft = await prisma.priceBookDraftEstimate.findUnique({ where: { id: draftId } });
  if (!draft) throw new DraftError("Draft not found.", 404);
  if (draft.status !== "draft") {
    throw new DraftError(`This draft is ${draft.status} and is no longer editable.`, 409);
  }
  const property = await prisma.property.findUnique({ where: { id: input.serviceAddressId } });
  if (!property || property.customerId !== input.accountId) {
    throw new DraftError("That address does not belong to that account.", 400);
  }
  const updated = await prisma.priceBookDraftEstimate.update({
    where: { id: draft.id },
    data: { customerId: input.accountId },
  });
  return { ok: true as const, draft: updated, serviceAddressId: input.serviceAddressId };
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
  /** IGNORED — the service decides the source from the item (`quantitySourceFor`). The model may keep emitting one. */
  quantitySource?: QuantitySource;
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
  await reopenForEditIfUnsigned(prisma, draftId, "AI proposal");

  const result: ProposeResult = { proposed: [], questions: [], rejected: [] };
  // max + 1, not a row count: a count collides with existing numbers after a delete or a
  // drag-and-drop renumber and drops new proposals into the middle of the list (2026-10-08).
  let sortOrder = await nextSortOrder(prisma, draftId);

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

    /*
      The AI may NEVER propose a negative quantity, change order or not.

      Removing work is a decision about what a customer is no longer being charged for, and the
      propose-only architecture exists so that a model's suggestion cannot move money without a
      human. A proposed negative is the one shape where confirming out of habit reduces a total
      rather than raising it — the direction nobody double-checks.
    */
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
        // Decided from the item, whatever the model said (Kyle, 2026-10-08: "just a number").
        // That also ends the old MANUAL-needs-a-note dance: the model used to pick MANUAL for the
        // hourly Diagnostics line and its reasoning was copied into the note to satisfy the
        // engine's guard (P030). The service never writes MANUAL now, so there is nothing to
        // satisfy — the reasoning stays where it always was, in `proposalReasoning`.
        quantitySource: quantitySourceFor(atomic) as PriceBookQuantitySource,
        difficulty: (line.difficulty ?? "NORMAL") as PriceBookDifficulty,
        location: line.location ?? null,
        note: null,
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
  difficulty?: Difficulty;
  location?: string | null;
  note?: string | null;
}

/** The body of "Confirm" / "Edit & confirm" — read by the CRM's route and the tech's route alike. */
export const confirmLineBodySchema = z.object({
  quantity: lineQuantitySchema.optional(),
  difficulty: z.enum(["NORMAL", "DIFFICULT", "VERY_DIFFICULT"]).optional(),
  location: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
});

/** The body of "Resolve" on an open question — the same for both doors. */
export const resolveQuestionBodySchema = z.object({ resolutionNote: z.string().trim().min(1) });

/**
 * Turn a proposed line into a real one. This is the moment the model's suggestion becomes a
 * number the engine will price, and it happens only here.
 *
 * Every refusal is a DraftError (2026-10-08, Phase 2 unit D) so the CRM route and the tech route
 * answer it with the same status and the same words: 404 no such line, 409 already confirmed,
 * 400 a rule (a negative quantity off a change order, a signed draft).
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
  if (!line) throw new DraftError(`Line ${lineId} not found.`, 404);
  // 409 before the reopen — see rejectProposedLine (2026-10-08 review).
  if (line.state === "CONFIRMED") {
    throw new DraftError(`Line ${lineId} is already confirmed.`, 409);
  }
  await reopenForEditIfUnsigned(prisma, line.draftId, "confirm line");
  if (edits?.quantity !== undefined) {
    // A human is confirming, so the change-order rule applies — unlike the proposal path above,
    // where a negative is refused outright whatever the draft is.
    try {
      assertQuantityAllowed(edits.quantity, Boolean(line.draft?.changeOrderForId));
    } catch (err) {
      throw new DraftError(err instanceof Error ? err.message : String(err), 400);
    }
  }

  const edited =
    edits !== undefined &&
    ((edits.quantity !== undefined && edits.quantity !== line.quantity) ||
      (edits.difficulty !== undefined && edits.difficulty !== line.difficulty));

  // The source is the item's, not the model's and not the caller's (Kyle, 2026-10-08). This also
  // retires a proposal the model stored as MANUAL before this rule existed. No atomic row keeps
  // what is stored — the line will say so as a gap rather than be given an invented source.
  const atomic = await prisma.priceBookAtomic.findUnique({ where: { itemId: line.itemId } });
  const quantitySource = atomic ? quantitySourceFor(atomic) : (line.quantitySource as QuantitySource);

  return prisma.priceBookDraftLine.update({
    where: { id: lineId },
    data: {
      quantity: edits?.quantity ?? line.quantity,
      quantitySource: quantitySource as PriceBookQuantitySource,
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

/**
 * Reject a proposal outright. Deletes the row — an unconfirmed suggestion is not a record.
 *
 * LOCKED LIKE EVERY OTHER LINE CHANGE (2026-10-08, Phase 2 unit D): this was the one line writer
 * with no `reopenForEditIfUnsigned`, so a SIGNED draft could still lose a line through it. Confirm
 * and the line routes always had the guard; reject now has it, for both doors.
 */
export async function rejectProposedLine(prisma: PrismaClient, lineId: string) {
  const line = await prisma.priceBookDraftLine.findUnique({ where: { id: lineId } });
  if (!line) throw new DraftError(`Line ${lineId} not found.`, 404);
  // The 409 comes BEFORE the reopen (2026-10-08 review): the reopen writes on its own, outside any
  // transaction, so a refusal that came after it still left an issued, unsigned draft flipped back
  // to "draft" — a false "unsaved changes" that makes the next Save mint a revision of an
  // unchanged document and kill the customer's link. A stale phone rejecting a suggestion the
  // office has since confirmed is exactly that case.
  if (line.state === "CONFIRMED") {
    throw new DraftError(`Line ${lineId} is confirmed; use removeLine to delete a confirmed line.`, 409);
  }
  await reopenForEditIfUnsigned(prisma, line.draftId, "reject line");
  return prisma.priceBookDraftLine.delete({ where: { id: lineId } });
}

/**
 * Answer an open question ("Resolve"). Locked like raising one: a signed draft's questions are
 * part of what was signed, so resolving one is refused with the signed sentence, on both doors.
 */
export async function resolveQuestion(
  prisma: PrismaClient,
  questionId: string,
  resolvedBy: string,
  resolutionNote: string
) {
  const question = await prisma.priceBookDraftQuestion.findUnique({ where: { id: questionId } });
  if (!question) throw new DraftError(`Question ${questionId} not found.`, 404);
  // Already answered: refuse before the reopen, for the same reason as rejectProposedLine — a
  // stale or repeated Resolve must not reopen an issued draft or overwrite who answered
  // (2026-10-08 review).
  if (question.resolvedAt) {
    throw new DraftError(`Question ${questionId} is already resolved.`, 409);
  }
  await reopenForEditIfUnsigned(prisma, question.draftId, "resolve question");
  return prisma.priceBookDraftQuestion.update({
    where: { id: questionId },
    data: { resolvedAt: new Date(), resolvedBy, resolutionNote },
  });
}

/**
 * What the field Quote screen lists under "AI proposals" and "Open questions" (Phase 2 unit D) —
 * the same two lists `getDraftReview` hands the CRM, shaped for the phone (shared/suggestedLines.ts).
 * Item names come from the book; a code the book no longer has falls back to the code itself.
 */
export async function getDraftSuggestions(
  prisma: PrismaClient,
  draftId: string,
): Promise<{ suggestedLines: QuoteSuggestedLine[]; openQuestions: FieldOpenQuestion[] }> {
  const [lines, questions] = await Promise.all([
    prisma.priceBookDraftLine.findMany({
      where: { draftId, state: "PROPOSED" },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      include: { atomic: { select: { description: true } } },
    }),
    prisma.priceBookDraftQuestion.findMany({
      where: { draftId, resolvedAt: null },
      orderBy: { createdAt: "asc" },
    }),
  ]);
  return {
    suggestedLines: lines.map((l) => ({
      id: l.id,
      itemId: l.itemId,
      description: l.atomic?.description ?? l.itemId,
      quantity: l.quantity,
      difficulty: l.difficulty as QuoteSuggestedLine["difficulty"],
      option: l.option,
      reasoning: l.proposalReasoning,
      proposedBy: l.proposedBy,
    })),
    openQuestions: questions.map((q) => ({ id: q.id, question: q.question, rawText: q.rawText, raisedBy: q.raisedBy })),
  };
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
    // Which options the draft has (A, B, C plus any added), for the Review screen's sections.
    optionSet: await getDraftOptionSet(prisma, draftId),
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
  // The draft's own item ids come along, so a line added before a rename still prices.
  const atomics = await loadCatalogAtSupplier(
    prisma,
    draft.supplierId,
    rate.rc.markupTiers,
    draft.lines.map((l) => l.itemId),
  );

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
    // Rides through the engine untouched so the review, the issue and the presentation all read
    // the same name (Kyle, 2026-10-27). It prices nothing.
    customName: l.customName,
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
    // ONE wording for both doors, and for the field screen's greyed Issue button before the press
    // (shared/suggestedLines.ts) — it names the heading and the button that clears each list.
    const reasons = unreviewedReasons(unconfirmed, openQuestions);
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
