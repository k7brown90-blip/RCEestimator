/**
 * Atomic-first custom estimate engine (Phase 2.0).
 *
 * Kyle, 2026-08-12 (decisions/2026-08-12-atomic-first-custom-estimates.md):
 *   "estimating software that builds off of tech input that compares to the atomic units.
 *    This will allow for any job to be fully customized to what is actually needed rather
 *    than what is assumed."
 *
 * A tech's field inputs — which atomics, how many, measured lengths, and what the conditions
 * actually were on THAT line — compose an estimate priced entirely from the imported atomic
 * catalog. There is no assembly in this path by design: an assembly is a bundle of
 * assumptions, and the testing phase spent two weeks proving those assumptions wrong
 * (AS-017's anchor/thread mismatch, AS-022's straps with no fasteners, AS-006 buying no
 * conductors).
 *
 * WHAT IT REUSES, RATHER THAN REBUILDS. Cost resolution, markup tiers, sell price and the
 * refusal vocabulary all come from `priceBookPricing.ts` — the Phase 1 module that is already
 * verified to the cent against the workbook. Re-implementing any of it would create a second
 * arithmetic that could drift from the book.
 *
 * THE THREE WAYS A LINE CAN BE INCOMPLETE, kept distinct because they route to different
 * people:
 *   1. NO PRICE at the selected supplier      -> the 03:03 sourcing task, or pick another supplier
 *   2. NO LABOUR VALUE for the chosen difficulty -> Kyle (four atomics block this today)
 *   3. NO LABOUR UNIT BASIS (Atomics!AA UNVERIFIED) -> the 04:00 task
 * None of the three is ever defaulted, substituted, or rounded into a number.
 */

import {
  markupTierFor,
  resolveCostBasis,
  sellPriceFor,
  type MarkupTiers,
  type Quotable,
  type RateConfig,
  type SupplierPriceRow,
} from "./priceBookPricing";

// ─── Inputs ─────────────────────────────────────────────────────────────────────

export type Difficulty = "NORMAL" | "DIFFICULT" | "VERY_DIFFICULT";
export type QuantitySource = "COUNT" | "MEASURED_LENGTH" | "TERMINATION_COUNT" | "MANUAL";

/** The atomic catalog row as the engine needs it. Mirrors PriceBookAtomic. */
export interface EngineAtomic {
  itemId: string;
  description: string | null;
  unit: string | null; // "ea" | "ft" | "sq ft" | "hr"
  rowType: string | null;
  laborNormal: number | null;
  laborDifficult: number | null;
  laborVeryDifficult: number | null;
  /** "E" | "C" | "M" | null. Null = the workbook has not established one. */
  laborUnitBasis: string | null;
  /** 1 | 100 | 1000 | null */
  laborUnitDivisor: number | null;
  laborUnitBasisRaw: string | null;
  costBasisUsed: number | null;
  sellPricePerUnit: number | null;
  necaUnitBasis: string | null;
}

/** One tech input. */
export interface DraftLineInput {
  id?: string;
  itemId: string;
  quantity: number;
  quantitySource: QuantitySource;
  difficulty: Difficulty;
  location?: string | null;
  note?: string | null;
}

// ─── Outputs ────────────────────────────────────────────────────────────────────

export type LineGapKind =
  | "NO_PRICE_AT_SUPPLIER"
  | "NO_LABOUR_VALUE"
  | "NO_LABOUR_UNIT_BASIS"
  | "ATOMIC_NOT_FOUND"
  | "MEASURED_LENGTH_MISSING"
  | "MANUAL_QUANTITY_WITHOUT_NOTE";

export interface LineGap {
  kind: LineGapKind;
  itemId: string;
  message: string;
  /** Who can close it. Named so a gap is actionable rather than merely reported. */
  routesTo: "sourcing-0303" | "kyle" | "price-book-0400" | "tech";
}

export interface ComputedLine {
  /**
   * The draft line's own id, passed straight through from the input.
   *
   * Present so a caller can join a computed row back to the row it came from. Joining on
   * `itemId` looks equivalent and is not: a draft may legitimately carry the same atomic twice
   * (Kyle's 2026-08-16 draft has two N001 lines, 100 ft each), and an itemId join silently shows
   * the first row's hours and dollars against both. Undefined only when the caller supplied no
   * id — the engine is usable on bare inputs, as its tests do.
   */
  id?: string;
  itemId: string;
  description: string | null;
  quantity: number;
  quantitySource: QuantitySource;
  difficulty: Difficulty;
  unit: string | null;
  location: string | null;
  note: string | null;

  /** The atomic's labour figure for THIS line's difficulty, before the unit divisor. */
  laborUnitValue: number | null;
  laborUnitBasis: string | null;
  laborUnitDivisor: number | null;
  /** qty x laborUnitValue / divisor. Null when any input is missing — never 0-for-unknown. */
  laborHours: number | null;
  laborDollars: number | null;

  costBasis: number | null;
  sellPerUnit: number | null;
  materialCost: number | null;
  materialSell: number | null;

  gaps: LineGap[];
  complete: boolean;
}

export interface ComputedEstimate {
  supplierId: string;
  billedLaborRate: number | null;
  lines: ComputedLine[];

  /** Sums over lines that could be computed. Lines with gaps contribute nothing. */
  laborHours: number;
  laborDollars: number;
  materialCost: number;
  materialSell: number;
  subtotal: number | null;
  jobFixedCost: number | null;
  total: number | null;

  gaps: LineGap[];
  /** Lines that could not be fully priced — the count that decides quotability. */
  incompleteLineCount: number;
  totalLineCount: number;
  completenessSummary: string;
}

// ─── Labour ─────────────────────────────────────────────────────────────────────

/**
 * The atomic's published labour figure for the difficulty the tech observed.
 *
 * Kyle 2026-08-11: difficulty is a FIELD OBSERVATION, selected per line, and it is NOT a
 * multiplier. NECA publishes its own Difficult and Very Difficult columns and they are not a
 * clean multiple of Normal — the 2026-08-11 audit found 20 of 59 standard-curve rows where
 * ×1.25/×1.50 does not reproduce the published figure, and N008's Kyle-set triple is
 * 0.50/0.75/1.00 where a multiplier returns 0.625. So this READS the column; it never scales
 * Normal.
 *
 * Returns null when that column is blank — which is a gap, not a zero. Four atomics
 * (CF003, CF015, N010, XT002) are known to block on exactly this.
 */
export function laborValueFor(atomic: EngineAtomic, difficulty: Difficulty): number | null {
  switch (difficulty) {
    case "NORMAL":
      return atomic.laborNormal ?? null;
    case "DIFFICULT":
      return atomic.laborDifficult ?? null;
    case "VERY_DIFFICULT":
      return atomic.laborVeryDifficult ?? null;
  }
}

/**
 * NECA MLU p.10, quoted verbatim in the workbook's own column header:
 *   E = one, or per each item
 *   C = per hundred items or per hundred linear feet
 *   M = per thousand items or per thousand linear feet
 *   "These calculations are not interchangeable."
 *
 * HOURS = qty x labour / divisor.
 *
 * A missing divisor returns null and the line blocks. The column header instructs this
 * explicitly — "the app must BLOCK, not default to E" — and the reason is that E vs C is a
 * 100x error that produces a completely plausible-looking number. C004's 6.2 is 3.10 hr for
 * 50 ft under C, and 310 hr under E.
 */
export function laborHoursFor(
  atomic: EngineAtomic,
  quantity: number,
  difficulty: Difficulty
): number | null {
  const value = laborValueFor(atomic, difficulty);
  if (value === null) return null;
  if (atomic.laborUnitDivisor === null || atomic.laborUnitDivisor === undefined) return null;
  if (atomic.laborUnitDivisor <= 0) return null;
  return (quantity * value) / atomic.laborUnitDivisor;
}

// ─── Row Type — what a row actually sells ───────────────────────────────────────

/**
 * Whether a catalog row buys material, sells labour, or both.
 *
 * `Row Type` is workbook PROSE, not an enum, and its vocabulary has grown past the two strings
 * this engine used to test for. Production carries nine distinct values today, including
 * `MATERIAL + LABOR (both values PENDING - see Labor Status and Notes)` and — the one that bit —
 * **`LABOR PRODUCT`**, the ten standalone sellable services (DG001 diagnostics, PT001 panel
 * tune-up, SD008 alarm test…).
 *
 * The old test was `rowType !== "LABOR ONLY"`. `"LABOR PRODUCT"` is a different string, so all ten
 * were treated as material-bearing and every one of them raised NO_PRICE_AT_SUPPLIER — the engine
 * asking Home Depot for the price of an hour of troubleshooting. Kyle hit it on DG001 on
 * 2026-08-17 and it blocks finalize on a row that is working exactly as designed.
 *
 * So: read the two words that carry the meaning rather than matching the whole phrase. A row type
 * the vocabulary has not met yet (`REFERENCE`, `DECLARATION`, blank) stays permissive and is
 * checked for both — an unrecognised row landing on an estimate should raise gaps, not slip
 * through unexamined.
 */
export function rowTypeSells(rowType: string | null | undefined): {
  material: boolean;
  labour: boolean;
} {
  const t = (rowType ?? "").toUpperCase();
  const material = t.includes("MATERIAL");
  const labour = t.includes("LABOR") || t.includes("LABOUR");
  if (!material && !labour) return { material: true, labour: true };
  return { material, labour };
}

// ─── Continuous-length detection ────────────────────────────────────────────────

/**
 * Continuous-length product — the class Kyle's cable rule governs.
 *
 * Kyle, rule R3 (2026-08-08), verbatim: "I do not want cable (romex/mc/other) to be included
 * in assemblies. Length is a field measurement and needs to be calculated separately."
 *
 * The workbook's own machine-readable marker for this class is `Unit = ft` — the same test the
 * 2026-08-11 Run 8 cable audit used ("measured directly against the 38 continuous-length
 * (unit = ft) atomics"). Reusing that test rather than inventing a keyword list keeps the app
 * and the book agreeing on what counts as cable.
 */
export function isContinuousLength(atomic: EngineAtomic): boolean {
  const u = (atomic.unit ?? "").trim().toLowerCase();
  return u === "ft" || u === "lf";
}

/**
 * Raceway and termination work that implies conductors must also be on the estimate.
 *
 * This is the F-87 guard: AS-006 bought 15 ft of EMT, a box, a mud ring, a device and a plate
 * and ZERO conductors, and its total "reads as a finished outlet price". In a freeform
 * atomic-first estimate that failure mode gets easier, not harder — nothing curates the line
 * list any more. So the engine asks the question the assembly layer used to.
 *
 * Deliberately conservative: it triggers on the workbook's own category text, and it produces
 * a REFUSAL TO FINALIZE, not an auto-added line. The engine never adds material the tech did
 * not choose — that would be inventing scope.
 */
export function impliesConductors(atomic: EngineAtomic): boolean {
  const hay = `${atomic.description ?? ""} ${atomic.necaUnitBasis ?? ""}`.toLowerCase();
  if (/\b(emt|conduit|raceway|pvc rigid|liquidtight|conduit body)\b/.test(hay)) return true;
  if (/\b(connector|coupling)\b/.test(hay) && /\b(emt|mc|nm|cable|conduit)\b/.test(hay)) return true;
  return false;
}

// ─── Composition ────────────────────────────────────────────────────────────────

export function computeEstimate(
  lines: DraftLineInput[],
  atomics: Map<string, EngineAtomic>,
  rc: RateConfig,
  supplierId: string
): ComputedEstimate {
  const computed: ComputedLine[] = [];

  for (const input of lines) {
    const atomic = atomics.get(input.itemId);
    const gaps: LineGap[] = [];

    if (!atomic) {
      computed.push({
        id: input.id,
        itemId: input.itemId,
        description: null,
        quantity: input.quantity,
        quantitySource: input.quantitySource,
        difficulty: input.difficulty,
        unit: null,
        location: input.location ?? null,
        note: input.note ?? null,
        laborUnitValue: null,
        laborUnitBasis: null,
        laborUnitDivisor: null,
        laborHours: null,
        laborDollars: null,
        costBasis: null,
        sellPerUnit: null,
        materialCost: null,
        materialSell: null,
        gaps: [
          {
            kind: "ATOMIC_NOT_FOUND",
            itemId: input.itemId,
            message:
              `${input.itemId} is not in the imported atomic catalog. It may be a NECA-backed ` +
              `line with no atomic row yet — the S-2026-08-11-G job had eight of those. It ` +
              `cannot be priced until the atomic exists.`,
            routesTo: "price-book-0400",
          },
        ],
        complete: false,
      });
      continue;
    }

    // ── Labour ──
    const sells = rowTypeSells(atomic.rowType);

    const laborUnitValue = laborValueFor(atomic, input.difficulty);
    if (laborUnitValue === null) {
      if (sells.labour) {
        gaps.push({
          kind: "NO_LABOUR_VALUE",
          itemId: atomic.itemId,
          message:
            `${atomic.itemId} has no ${input.difficulty} labour value in the workbook. ` +
            `NECA publishes its own Difficult / Very Difficult columns and they are not a ` +
            `multiple of Normal, so this cannot be scaled up from the Normal figure — that ` +
            `would fabricate a labour number. Kyle sets it.`,
          routesTo: "kyle",
        });
      }
    }
    if (laborUnitValue !== null && (atomic.laborUnitDivisor === null || atomic.laborUnitDivisor === undefined)) {
      gaps.push({
        kind: "NO_LABOUR_UNIT_BASIS",
        itemId: atomic.itemId,
        message:
          `${atomic.itemId} carries a labour value of ${laborUnitValue} but no verified NECA ` +
          `unit basis (Atomics!AA reads ${JSON.stringify(atomic.laborUnitBasisRaw ?? "blank")}). ` +
          `E, C and M differ by factors of 100 — ${laborUnitValue} could be ${laborUnitValue} hr ` +
          `or ${(laborUnitValue / 100).toFixed(4)} hr per unit. The workbook's own instruction is ` +
          `to block rather than assume.`,
        routesTo: "price-book-0400",
      });
    }
    const laborHours = laborHoursFor(atomic, input.quantity, input.difficulty);
    const laborDollars =
      laborHours === null || rc.billedLaborRate === null ? null : laborHours * rc.billedLaborRate;

    // ── Material ──
    const costBasis = atomic.costBasisUsed;
    const sellPerUnit = atomic.sellPricePerUnit;
    if (sells.material && (costBasis === null || costBasis === undefined)) {
      gaps.push({
        kind: "NO_PRICE_AT_SUPPLIER",
        itemId: atomic.itemId,
        message:
          `${atomic.itemId} has no price at the selected supplier (${supplierId}). There is no ` +
          `fallback to another supplier's price — that substitution is forbidden (Kyle ` +
          `2026-08-08). Price the item, change the supplier, or quote this line by hand.`,
        routesTo: "sourcing-0303",
      });
    }

    // ── Tech-input hygiene ──
    if (input.quantitySource === "MANUAL" && !(input.note ?? "").trim()) {
      gaps.push({
        kind: "MANUAL_QUANTITY_WITHOUT_NOTE",
        itemId: atomic.itemId,
        message:
          `${atomic.itemId} uses a MANUAL quantity with no note. A hand-set quantity that ` +
          `records no reason is indistinguishable later from a typo.`,
        routesTo: "tech",
      });
    }
    if (isContinuousLength(atomic) && input.quantitySource !== "MEASURED_LENGTH") {
      gaps.push({
        kind: "MEASURED_LENGTH_MISSING",
        itemId: atomic.itemId,
        message:
          `${atomic.itemId} is continuous-length product (unit = ${atomic.unit}) but its ` +
          `quantity source is ${input.quantitySource}, not MEASURED_LENGTH. Kyle: "Length is a ` +
          `field measurement and needs to be calculated separately."`,
        routesTo: "tech",
      });
    }

    const materialCost =
      costBasis === null || costBasis === undefined ? null : input.quantity * costBasis;
    const materialSell =
      sellPerUnit === null || sellPerUnit === undefined ? null : input.quantity * sellPerUnit;

    computed.push({
      id: input.id,
      itemId: atomic.itemId,
      description: atomic.description,
      quantity: input.quantity,
      quantitySource: input.quantitySource,
      difficulty: input.difficulty,
      unit: atomic.unit,
      location: input.location ?? null,
      note: input.note ?? null,
      laborUnitValue,
      laborUnitBasis: atomic.laborUnitBasis,
      laborUnitDivisor: atomic.laborUnitDivisor,
      laborHours,
      laborDollars,
      costBasis: costBasis ?? null,
      sellPerUnit: sellPerUnit ?? null,
      materialCost,
      materialSell,
      gaps,
      complete: gaps.length === 0,
    });
  }

  // Sums cover only what could be computed. A line with a gap contributes NOTHING rather
  // than zero — and the completeness counters, not the total, are what say the number is
  // partial. This is the same discipline Phase 1 enforces at assembly level (F-82: a flag
  // reading "MATERIAL COMPLETE" beside a $0.00 total is the error an estimator acts on).
  const laborHours = computed.reduce((s, l) => s + (l.laborHours ?? 0), 0);
  const laborDollars = computed.reduce((s, l) => s + (l.laborDollars ?? 0), 0);
  const materialCost = computed.reduce((s, l) => s + (l.materialCost ?? 0), 0);
  const materialSell = computed.reduce((s, l) => s + (l.materialSell ?? 0), 0);

  const subtotal = rc.billedLaborRate === null ? null : laborDollars + materialSell;
  const jobFixedCost = rc.jobFixedCost;
  const total = subtotal === null || jobFixedCost === null ? null : subtotal + jobFixedCost;

  const gaps = computed.flatMap((l) => l.gaps);
  const incompleteLineCount = computed.filter((l) => !l.complete).length;

  return {
    supplierId,
    billedLaborRate: rc.billedLaborRate,
    lines: computed,
    laborHours,
    laborDollars,
    materialCost,
    materialSell,
    subtotal,
    jobFixedCost,
    total,
    gaps,
    incompleteLineCount,
    totalLineCount: computed.length,
    // COMPLETE REQUIRES SUBSTANCE (P022 / P019 §3).
    //
    // This used to read `incompleteLineCount === 0 ? "COMPLETE" : ...`, which an EMPTY draft
    // satisfies — zero lines carry gaps because there are no lines. Kyle photographed
    // `COMPLETE - 0 lines - $200.00` at 23:37Z on 2026-08-16, three minutes before his first
    // line existed, and it was telling him the truth about gaps while implying the opposite
    // about the estimate.
    //
    // Vacuous truth is the same failure shape as a silently wrong price: the reader acts on
    // the summary, not on the predicate behind it. An empty draft is EMPTY, not complete.
    completenessSummary:
      computed.length === 0
        ? "EMPTY - no lines yet"
        : incompleteLineCount === 0
          ? "COMPLETE"
          : `INCOMPLETE - ${incompleteLineCount} of ${computed.length} lines carry gaps`,
  };
}

// ─── Finalize gate ──────────────────────────────────────────────────────────────

export interface FinalizeRefusal {
  finalized: false;
  reasons: string[];
  warnings: string[];
  computed: ComputedEstimate;
}
export interface FinalizeAccepted {
  finalized: true;
  warnings: string[];
  computed: ComputedEstimate;
}
export type FinalizeResult = FinalizeRefusal | FinalizeAccepted;

export interface FinalizeOptions {
  context: "customer" | "internal";
  rateProvisional?: boolean;
  provisionalReason?: string | null;
}

/**
 * The estimate-level refusal gate — same shape and same discipline as Phase 1's
 * `quoteAssembly()`, applied to a freeform composition.
 *
 * Refuses with reasons. Never emits a $0 line, never silently drops an unpriced item.
 */
export function finalizeEstimate(
  computed: ComputedEstimate,
  atomics: Map<string, EngineAtomic>,
  opts: FinalizeOptions
): FinalizeResult {
  const reasons: string[] = [];
  const warnings: string[] = [];

  if (computed.totalLineCount === 0) {
    reasons.push("The estimate has no lines.");
  }

  // Group gaps so the refusal is readable rather than a wall of one-liners.
  const byKind = new Map<LineGapKind, LineGap[]>();
  for (const g of computed.gaps) {
    if (!byKind.has(g.kind)) byKind.set(g.kind, []);
    byKind.get(g.kind)!.push(g);
  }
  const label: Record<LineGapKind, string> = {
    NO_PRICE_AT_SUPPLIER: "No price at the selected supplier",
    NO_LABOUR_VALUE: "No labour value for the observed difficulty",
    NO_LABOUR_UNIT_BASIS: "No verified NECA labour unit basis",
    ATOMIC_NOT_FOUND: "Atomic not in the catalog",
    MEASURED_LENGTH_MISSING: "Continuous-length item without a measured length",
    MANUAL_QUANTITY_WITHOUT_NOTE: "Manual quantity with no note",
  };
  for (const [kind, list] of byKind) {
    const ids = Array.from(new Set(list.map((g) => g.itemId)));
    reasons.push(`${label[kind]} (${ids.length}): ${ids.join(", ")}`);
  }

  // ── The measured-line guard (Kyle's cable rule, enforced at estimate level) ──
  // If the estimate installs raceway or terminations but contains NO measured-length line,
  // the conductors are missing. Removing cable from the template was supposed to move it to a
  // field measurement, not delete it — "otherwise removing cable silently becomes a discount."
  const hasRaceway = computed.lines.some((l) => {
    const a = atomics.get(l.itemId);
    return a ? impliesConductors(a) : false;
  });
  const hasMeasuredLine = computed.lines.some((l) => l.quantitySource === "MEASURED_LENGTH");
  if (hasRaceway && !hasMeasuredLine) {
    const racewayIds = computed.lines
      .filter((l) => {
        const a = atomics.get(l.itemId);
        return a ? impliesConductors(a) : false;
      })
      .map((l) => l.itemId);
    reasons.push(
      `MEASURED LINES MISSING — this estimate installs raceway or terminations ` +
        `(${Array.from(new Set(racewayIds)).join(", ")}) and contains no measured-length line. ` +
        `Kyle: "Length is a field measurement and needs to be calculated separately." An ` +
        `estimate that buys conduit and no conductors reads as a finished price and is not one ` +
        `(F-87, AS-006). Measure the run and add the conductor line, or record why none is needed.`
    );
  }

  if (opts.rateProvisional && opts.context === "customer") {
    reasons.push(
      `PROVISIONAL RATE — refusing to issue a customer price. ` +
        (opts.provisionalReason ??
          `Rate Config B2 does not match Kyle's ruled $150/hr ` +
            `(decisions/2026-08-11-billed-rate-and-no-memberships.md).`) +
        ` The cell is the price-book task's lane; this engine will not override it.`
    );
  } else if (opts.rateProvisional) {
    warnings.push(
      `Computed at a PROVISIONAL labour rate. ` +
        (opts.provisionalReason ?? "Rate Config B2 is not $150/hr.")
    );
  }

  if (reasons.length > 0) {
    return { finalized: false, reasons, warnings, computed };
  }
  return { finalized: true, warnings, computed };
}

// ─── Seam: composition rules (NOT built this task) ──────────────────────────────

/**
 * SEAM FOR THE `Composition Rules` TAB — deliberately empty.
 *
 * The 04:00 task created that tab in the workbook on 2026-08-13, and the Phase 2.0 prompt is
 * explicit: do not ingest it yet, do not guess a schema for it, leave a clearly-named seam.
 * This is that seam.
 *
 * What it will carry when it lands: per-atomic companion requirements and quantity drivers —
 * "this raceway needs straps at this interval, those straps need fasteners, this box needs a
 * ring." That knowledge used to live in the curated assembly layer, and the atomic-first pivot
 * moved the completeness risk onto the tech (recorded as a risk in
 * decisions/2026-08-12-atomic-first-custom-estimates.md). These rules are how it moves back
 * into the software.
 *
 * HOW IT MUST BEHAVE WHEN IT IS BUILT — Kyle, 2026-08-12, binding:
 *
 *   "each job being unique and needing exact inputs for each item; not generalized or assumed"
 *
 * so a composition rule SURFACES A REQUIREMENT FOR THE TECH TO CONFIRM WITH AN EXACT INPUT.
 * It never silently auto-adds a quantity. "This run needs straps — how many?" is the rule
 * working; adding seven straps on the tech's behalf is the assumption this whole pivot exists
 * to remove, reintroduced one layer down. The return type is deliberately a *suggestion*
 * carrying a nullable quantity, not a line the engine inserts.
 *
 * When the tab arrives it will come with an IMPORT MAPPING IMPACT flag; the mapping file is
 * updated first, then this function is implemented against it. Until then it returns no
 * suggestions — NOT an empty list dressed up as "nothing needed".
 */
export interface CompositionSuggestion {
  itemId: string;
  reason: string;
  suggestedQuantity: number | null;
}

export function suggestCompanionLines(_lines: DraftLineInput[]): {
  available: false;
  reason: string;
  suggestions: CompositionSuggestion[];
} {
  return {
    available: false,
    reason:
      "Composition Rules ingestion is not built (Phase 2.0 scope excludes it). The workbook tab " +
      "exists as of 2026-08-13 but its shape has not been mapped, and guessing it would put " +
      "invented companion quantities on a quote. No suggestions are offered — this is 'not " +
      "implemented', not 'nothing required'.",
    suggestions: [],
  };
}

// ─── Catalog loading helper ─────────────────────────────────────────────────────

/**
 * Resolve every atomic's cost at ONE supplier, using the Phase 1 rules unchanged.
 * Exported so the demo, the service layer and any test share one code path.
 */
export function resolveCatalogAtSupplier(
  atomics: EngineAtomic[],
  supplierPrices: SupplierPriceRow[],
  supplierId: string,
  tiers: MarkupTiers
): Map<string, EngineAtomic> {
  const out = new Map<string, EngineAtomic>();
  for (const a of atomics) {
    const { costBasis } = resolveCostBasis(a.itemId, supplierId, supplierPrices);
    out.set(a.itemId, {
      ...a,
      costBasisUsed: costBasis,
      sellPricePerUnit: sellPriceFor(costBasis, tiers),
    });
  }
  return out;
}

export { markupTierFor };
export type { MarkupTiers, RateConfig, SupplierPriceRow, Quotable };
