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
// The second, job-level check on material markup — see that file for why it exists.
import { allSelectionCaps, bandsFrom, capMaterial, type MaterialCapResult } from "./materialMarkupCap";
import { RULED_BILLED_RATE } from "./laborRate";

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

  // ── KYLE'S CATALOG (P030) ──────────────────────────────────────────────────────────────
  // "kyles-tab" rows carry the authoritative CUSTOMER PRICE per difficulty, computed on his own
  // sheet as labour x the billed rate + marked-up material ($150 at import, $100 from 2026-09-01). When these
  // are present the line prices FLAT from them and the engine does not re-derive anything.
  source?: string | null;
  sellNormal?: number | null;
  sellDifficult?: number | null;
  sellVeryDifficult?: number | null;
  /** Internal only — what the item costs RCE and its marked-up material, for job costing. */
  companyCost?: number | null;
  companyPrice?: number | null;
}

/** The flat customer price for one unit at this difficulty, or null when the row does not offer it. */
export function flatSellFor(atomic: EngineAtomic, difficulty: Difficulty): number | null {
  switch (difficulty) {
    case "NORMAL": return atomic.sellNormal ?? null;
    case "DIFFICULT": return atomic.sellDifficult ?? null;
    case "VERY_DIFFICULT": return atomic.sellVeryDifficult ?? null;
  }
}

/** True for a row priced from Kyle's sell columns rather than from NECA labour + supplier cost. */
export function isFlatPriced(atomic: EngineAtomic): boolean {
  return (
    atomic.sellNormal !== null && atomic.sellNormal !== undefined
  ) || (
    atomic.sellDifficult !== null && atomic.sellDifficult !== undefined
  ) || (
    atomic.sellVeryDifficult !== null && atomic.sellVeryDifficult !== undefined
  );
}

/** One tech input. */
/** Which of Kyle's three options a line sits in. Defaults to A when a caller does not say. */
export type EstimateOption = "A" | "B" | "C";
export const ESTIMATE_OPTIONS: EstimateOption[] = ["A", "B", "C"];

export interface DraftLineInput {
  id?: string;
  itemId: string;
  quantity: number;
  quantitySource: QuantitySource;
  difficulty: Difficulty;
  location?: string | null;
  note?: string | null;
  /**
   * Option A, B or C. Optional so the engine stays usable on bare inputs, as its own tests do —
   * an absent option means A, which is what every line was before options existed.
   */
  option?: EstimateOption;
}

// ─── Outputs ────────────────────────────────────────────────────────────────────

export type LineGapKind =
  | "NO_PRICE_AT_SUPPLIER"
  | "NO_LABOUR_VALUE"
  | "NO_LABOUR_UNIT_BASIS"
  | "ATOMIC_NOT_FOUND"
  | "MEASURED_LENGTH_MISSING"
  | "MANUAL_QUANTITY_WITHOUT_NOTE"
  | "NO_SELL_PRICE_AT_DIFFICULTY";

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
  /** Passed straight through, so a caller can group priced rows without a second lookup. */
  option: EstimateOption;
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

  /**
   * True when the line priced FLAT from Kyle's own sell columns (his catalog tab and every
   * in-app item). Informational — carried to the company copy.
   */
  flatPriced: boolean;
  /**
   * True when the line is continuous-length material (wire, cable, conduit) — the only lines the
   * job-level material cap reads and scales (Kyle, 2026-08-31, "split the difference"). Unit
   * items sell at their book price whatever the job's material blend.
   */
  inMaterialCap: boolean;

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
  /** AFTER the job-level check below. This is what the customer is charged for material. */
  materialSell: number;

  /**
   * What the job-level material check did, keyed by option (2026-08-21).
   *
   * Present for every option that has lines, whether or not the ceiling was reached — `applied`
   * says which. Recorded rather than merely acted on because Kyle has to be able to see cost,
   * what the per-item tiers produced, the ceiling that governed, and what it cost him. A markup
   * adjustment he cannot see is one he cannot defend to a customer who asks.
   */
  materialCaps: Record<string, MaterialCapResult>;

  /**
   * THE THIRD GATE, precomputed for every combination the customer could tick (2026-08-22).
   *
   * Kyle: "the savings add up and help push the sale of more work simply by lowing the cost of
   * material. I win because I lose nothing on labor and can get the material all same day."
   *
   * Keyed "A", "A+B", "A+B+C"… (comboKey order). Each entry prices that selection's combined
   * material as ONE job through the same bands — run on the post-gate-2 figures, so a single
   * option never earns a further cut and the discount exists only where combining reaches a
   * deeper band. Seven entries at most; shipping finished results is what lets a customer-facing
   * surface show "choose both and save $X" without ever holding a cost figure.
   */
  combinationDiscounts: Record<string, MaterialCapResult>;

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

/**
 * Is this atomic a CONDUCTOR — wire, cable, the thing pulled through the raceway?
 *
 * ── WHY THIS EXISTS, AND WHAT IT REPLACES ──────────────────────────────────────────────────────
 *
 * The raceway guard below used to ask "does the estimate contain a MEASURED_LENGTH line?" as its
 * proxy for "are the conductors here?". That proxy worked when the catalog carried units: wire was
 * `unit = "ft"`, `isContinuousLength` returned true, the entry screen forced the source to
 * MEASURED_LENGTH, and the guard found it.
 *
 * Kyle's own catalog has **no unit column at all** — every atomic imports with `unit = null`. So
 * from the day it went live (P030) `isContinuousLength` has been false for everything, wire has
 * been entered as a COUNT, and the guard has been unable to see conductors that were plainly on
 * the estimate. On 2026-08-20 it refused a job that already had 6 AWG and 10 AWG in it.
 *
 * A rule that cannot be satisfied is worse than no rule: it teaches the operator that the refusal
 * is noise. So the guard now asks what a line IS rather than how it was counted.
 *
 * Matching is on the description because that is what his book actually carries. It is deliberately
 * broad — a false POSITIVE here only means an estimate is allowed through that a stricter reading
 * might have queried, while a false negative blocks real work, which is the failure that just
 * happened.
 */
export function isConductor(atomic: EngineAtomic): boolean {
  const hay = `${atomic.itemId} ${atomic.description ?? ""}`.toLowerCase();
  if (/(thhn|thwn|xhhw|romex|conductor)/.test(hay)) return true;
  // NM-B / MC / SE / UF cable, and anything sized in AWG or kcmil.
  if (/(nm-b|mc cable|se cable|uf-b)/.test(hay)) return true;
  if (/(awg|kcmil)/.test(hay)) return true;
  if (/building wire/.test(hay)) return true;
  return false;
}

/**
 * Is this atomic CONTINUOUS-LENGTH MATERIAL — wire, cable, conduit, tubing: the stuff sold by
 * the foot, where quantity is what breaks the per-item markup ladder?
 *
 * ── WHY THIS DECIDES THE JOB-LEVEL CAP'S SCOPE (Kyle, 2026-08-31) ─────────────────────────────
 *
 * The per-item tiers key off unit price and quietly assume a cheap item is a small line. A
 * thousand feet of #14 at $0.64 is $640 of cost marked up five times — that is the failure the
 * job-level cap (materialMarkupCap.ts) exists for, and it is a FOOTAGE failure. A $170 SMM, a
 * $283 load center or a $27 disconnect is one unit at the tier Kyle chose for it; scaling those
 * down because the wire on the same job was heavy re-marks prices he set on purpose.
 *
 * His ruling, after seeing both extremes the same day ("The '+New Item' in the price book is not
 * adding up" — the SMM cut from $456 to $285.98 — and then "We still need the material cap, I
 * never said to remove that"): split the difference. The cap applies to continuous-length
 * material only; unit items sell at their book price.
 *
 * Matching is on description and category because Kyle's catalog carries no unit column (see
 * isConductor). Fittings are the trap: "Insulated Multi-Tap Connector, #14 to 2/0 AWG" contains
 * "AWG", a "PVC Factory Elbow" contains "PVC" — both are unit items, so anything that names a
 * fitting is excluded before the length patterns are tried.
 */
const FITTING_WORDS =
  /\b(elbow|coupling|connector|connectors|box|boxes|bushing|strap|straps|hanger|clamp|clamps|body|bodies|fitting|adapter|nipple|locknut|hub|cover|plate|reducer|bell end|cap|lug|lugs|terminal|tap|clip|clips|support)\b/;

export function isContinuousLengthMaterial(atomic: {
  itemId: string;
  description: string | null;
  unit?: string | null;
  unitLabel?: string | null;
  category?: string | null;
}): boolean {
  const unit = (atomic.unit ?? atomic.unitLabel ?? "").trim().toLowerCase();
  if (/^(ft|lf|foot|feet|per foot|per ft|linear f(oo|ee)t)$/.test(unit)) return true;
  const hay = `${atomic.itemId} ${atomic.description ?? ""} ${atomic.category ?? ""}`.toLowerCase();
  if (FITTING_WORDS.test(hay)) return false;
  // Conductors — wire and cable of every kind.
  if (/(thhn|thwn|xhhw|romex|conductor|nm-b|mc cable|se cable|ser cable|uf-b|use-2|building wire|feeder cable|awg|kcmil)/.test(hay)) return true;
  // Raceway lengths — conduit and tubing (sticks or per foot).
  if (/\b(conduit|tubing|raceway)\b/.test(hay)) return true;
  if (/\b(emt|imc|rmc|pvc|lfmc|lfnc|liquidtight|ent)\b/.test(hay) && /\b(inch|in\.|\d\/\d|sch|schedule)\b/.test(hay)) return true;
  return false;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
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
        option: input.option ?? "A",
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
        flatPriced: false,
        inMaterialCap: false,
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
    /*
      KYLE'S CATALOG PRICES FLAT (P030).

      His sheet already did the arithmetic this engine was built to do: every row carries a sell
      price per difficulty, computed as labour x the billed rate + marked-up material and asserted to the cent
      at import. So for these rows the engine READS the price rather than rebuilding it — the same
      instinct as difficulty being read from a published column instead of scaled from Normal.

      The labour hours and the material split are still computed and still stored, because job
      costing needs them. They are INTERNAL. `laborDollars + materialSell` is defined here to sum
      exactly to the flat sell, which is what lets the customer-facing collapse in
      `issuedEstimateService` stay unchanged: it adds those two and gets Kyle's number.
    */
    if (isFlatPriced(atomic)) {
      const unitSell = flatSellFor(atomic, input.difficulty);
      if (unitSell === null) {
        gaps.push({
          kind: "NO_SELL_PRICE_AT_DIFFICULTY",
          itemId: atomic.itemId,
          message:
            `${atomic.itemId} publishes no price at ${input.difficulty}. The tech's difficulty is a ` +
            `field observation and the book has to answer it — this line cannot be quoted until the ` +
            `column is filled in.`,
          routesTo: "kyle",
        });
      }

      const hours = laborHoursFor(atomic, input.quantity, input.difficulty);
      const flat = unitSell === null ? null : round2(unitSell * input.quantity);
      const labourDollars = hours === null || rc.billedLaborRate === null ? null : round2(hours * rc.billedLaborRate);
      // Material is the remainder, so the two internal halves reconstruct Kyle's price exactly.
      const material = flat === null ? null : round2(flat - (labourDollars ?? 0));

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

      computed.push({
        id: input.id,
        option: input.option ?? "A",
        itemId: atomic.itemId,
        description: atomic.description,
        quantity: input.quantity,
        quantitySource: input.quantitySource,
        difficulty: input.difficulty,
        unit: atomic.unit,
        location: input.location ?? null,
        note: input.note ?? null,
        laborUnitValue: laborValueFor(atomic, input.difficulty),
        laborUnitBasis: atomic.laborUnitBasis,
        laborUnitDivisor: atomic.laborUnitDivisor,
        laborHours: hours,
        laborDollars: labourDollars,
        costBasis: atomic.costBasisUsed ?? null,
        sellPerUnit: unitSell,
        materialCost: atomic.costBasisUsed === null || atomic.costBasisUsed === undefined
          ? null
          : round2(input.quantity * atomic.costBasisUsed),
        materialSell: material,
        flatPriced: true,
        inMaterialCap: isContinuousLengthMaterial(atomic),
        gaps,
        complete: gaps.length === 0,
      });
      continue;
    }

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
      option: input.option ?? "A",
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
      flatPriced: false,
      inMaterialCap: isContinuousLengthMaterial(atomic),
      gaps,
      complete: gaps.length === 0,
    });
  }

  /*
    ── THE JOB-LEVEL MATERIAL CHECK (Kyle, 2026-08-21) ──────────────────────────────────────────

    "I think we keep the main tiers but introduce a second check that looks at total material cost
     and apply it to the same tiered system we have."

    The per-item ladder above has already priced every line. This reads the RESULT of that per
    option and, if the blended markup exceeds what a job of that size should carry, scales the
    material lines down until it does. See materialMarkupCap.ts for why the per-item ladder is
    correct and where it stops being correct.

    Applied here rather than at the option summary or in the PDF because every one of those reads
    from `computed.lines`. A cap applied downstream would leave the lines saying one thing and the
    total saying another, and Kyle reads the lines.
  */
  // Kyle's schedule from Rate Config when his workbook carries it, the code's otherwise.
  const bands = bandsFrom(rc.jobBands);

  /*
    ── THE CAP'S SCOPE: CONTINUOUS-LENGTH MATERIAL ONLY (Kyle, 2026-08-31) ──────────────────────

    Both extremes were tried the same day. Capping every line cut a "50 AMP Generac SMM" from its
    $456 book price to $285.98 ("The '+New Item' in the price book is not adding up"). Exempting
    every book-priced line lifted a wire-heavy generator install by $2,500 / $5,400 per option
    ("We still need the material cap, I never said to remove that"). His ruling: split the
    difference.

    So gates 2 and 3 read only the lines where footage is the problem — wire, cable, conduit,
    tubing (isContinuousLengthMaterial). Their material is banded and scaled as a job. Unit items
    — SMMs, panels, disconnects, breakers, fittings — sell at the book price Kyle set for them,
    whatever else is on the job, and contribute nothing to the band.
  */
  const materialCaps: Record<string, MaterialCapResult> = {};
  for (const option of ESTIMATE_OPTIONS) {
    const inOption = computed.filter((l) => l.option === option && l.inMaterialCap);
    if (inOption.length === 0) continue;

    const cost = inOption.reduce((n, l) => n + (l.materialCost ?? 0), 0);
    const sell = inOption.reduce((n, l) => n + (l.materialSell ?? 0), 0);
    const cap = capMaterial(cost, sell, bands);
    materialCaps[option] = cap;
    if (!cap.applied) continue;

    /*
      Scaled proportionally so every line keeps its share. The alternative — taking the whole
      reduction off one line — would show a customer a part priced below what the next identical
      part on the same estimate costs.

      The residual from rounding is put on the LARGEST material line, so the lines sum to the
      capped figure exactly. Cents that do not reconcile are the failure this codebase keeps
      closing; the integrity check at graduation would refuse the estimate over them.
    */
    const factor = cap.cappedSell / cap.uncappedSell;
    let running = 0;
    let largest: (typeof computed)[number] | null = null;
    for (const line of inOption) {
      if (line.materialSell === null) continue;
      const next = Math.round(line.materialSell * factor * 100) / 100;
      line.materialSell = next;
      running += next;
      if (largest === null || next > (largest.materialSell ?? 0)) largest = line;
    }
    const residual = Math.round((cap.cappedSell - running) * 100) / 100;
    if (residual !== 0 && largest !== null && largest.materialSell !== null) {
      largest.materialSell = Math.round((largest.materialSell + residual) * 100) / 100;
    }
  }

  // Gate 3 runs on the lines AS GATE 2 LEFT THEM — the discount is what combining adds on top.
  // Same scope as gate 2: unit items contribute nothing; they keep their option membership so
  // every combination key still enumerates.
  const combinationDiscounts = allSelectionCaps(
    computed.map((l) => ({
      option: l.option,
      materialCost: l.inMaterialCap ? l.materialCost : null,
      materialSell: l.inMaterialCap ? l.materialSell : null,
    })),
    bands,
  );

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
    /** What the job-level material check did, per option. Empty when it changed nothing. */
    materialCaps,
    combinationDiscounts,
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
    warnings.push("The estimate has no lines.");
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
    NO_SELL_PRICE_AT_DIFFICULTY: "No price published for the observed difficulty",
  };
  /*
    ── THESE WARN. THEY NO LONGER REFUSE. (Kyle, 2026-08-20) ─────────────────────────────────

    "These checks are becoming a preventative block. They need removed. Nothing should block me
     from completing the estimate."

    He is right, and the reason he is right is that these gates had been refusing WORK THAT WAS
    CORRECT. The raceway rule looked for a MEASURED_LENGTH line as its proxy for "the conductors
    are here", and that proxy became unsatisfiable the day his own catalog went live — his book
    has no unit column, so nothing is ever flagged continuous-length and nothing is ever forced to
    a measured source. On 2026-08-20 it refused an estimate that already had 6 AWG and 10 AWG on
    it, and he could not get past it by doing anything right.

    A gate that cannot be satisfied does not protect the work; it teaches the operator that
    refusals are noise, and the next one — the one that matters — gets clicked through too.

    So the findings survive and the block does not. Everything here is now a warning, shown
    verbatim where the operator will read it, and the decision is his. He is the licensed
    electrician; the software's job is to notice, not to forbid.

    ONE THING THIS COSTS, STATED PLAINLY: a line the engine could not price contributes NOTHING to
    the total. An estimate carrying one is genuinely too cheap, and now it can be issued. That is
    why the unpriced-line warning is worded as money rather than as a data problem, and why the
    presentation screen calls it out before a customer ever sees a number.
  */
  for (const [kind, list] of byKind) {
    const ids = Array.from(new Set(list.map((g) => g.itemId)));
    const money = kind === "MANUAL_QUANTITY_WITHOUT_NOTE" || kind === "MEASURED_LENGTH_MISSING"
      ? ""
      : " — these lines add NOTHING to the total, so this price is lower than the work.";
    warnings.push(`${label[kind]} (${ids.length}): ${ids.join(", ")}${money}`);
  }

  // ── The measured-line guard (Kyle's cable rule, enforced at estimate level) ──
  // If the estimate installs raceway or terminations but contains NO measured-length line,
  // the conductors are missing. Removing cable from the template was supposed to move it to a
  // field measurement, not delete it — "otherwise removing cable silently becomes a discount."
  const hasRaceway = computed.lines.some((l) => {
    const a = atomics.get(l.itemId);
    return a ? impliesConductors(a) : false;
  });
  /*
    ASKS WHAT THE LINE IS, NOT HOW IT WAS COUNTED.

    This was `quantitySource === "MEASURED_LENGTH"`, which is a proxy that stopped working the day
    Kyle's catalog went live: his book has no unit column, so every atomic imports with unit null,
    `isContinuousLength` is false for everything, and nothing is ever forced to MEASURED_LENGTH.
    The guard then refused estimates that plainly contained wire — including one on 2026-08-20
    with 6 AWG and 10 AWG on it.
  */
  const hasConductor = computed.lines.some((l) => {
    const a = atomics.get(l.itemId);
    return a ? isConductor(a) : false;
  });
  if (hasRaceway && !hasConductor) {
    const racewayIds = computed.lines
      .filter((l) => {
        const a = atomics.get(l.itemId);
        return a ? impliesConductors(a) : false;
      })
      .map((l) => l.itemId);
    /*
      ── SAY WHAT IS MISSING, NOT WHAT THE RULE IS CALLED ─────────────────────────────────────

      This refusal used to open "MEASURED LINES MISSING". Kyle hit it on 2026-08-20 with conduit
      and fittings on the estimate and read it as a complaint about his QUANTITY:

        "It did not allow me to proceed because it is not calculating my qty of 2 as 20 feet of
         conduit."

      It was not. The estimate had raceway and no WIRE, and the rule is named after the mechanism
      it uses to detect that — a measured-length line — rather than after the thing that is
      actually absent. He went looking for a units bug that did not exist.

      A refusal is read by someone mid-job who wants to send a price. It has to name the missing
      work in the first six words.
    */
    warnings.push(
      `NO WIRE ON THIS ESTIMATE — it installs conduit or terminations ` +
        `(${Array.from(new Set(racewayIds)).join(", ")}) but has no conductor line. Conduit with ` +
        `nothing pulled through it is not a finished job, and quoting it reads as one. Add the ` +
        `wire — it is measured in the field, so its length is entered as a measurement, not a ` +
        `count — or, if the run genuinely needs no conductors (a stub-out or a spare raceway), ` +
        `add a line saying so. This is not about the quantity on your conduit line.`
    );
  }

  if (opts.rateProvisional && opts.context === "customer") {
    // Also a warning now, and this is the one that deserves the most care: a provisional rate is
    // wrong on EVERY labour line at once, not on one item. Kyle's instruction was unambiguous
    // ("Nothing should block me from completing the estimate"), so it is said as loudly as a
    // warning can be said and the call is his.
    warnings.push(
      `PROVISIONAL LABOUR RATE — every labour figure on this estimate is computed from it. ` +
        (opts.provisionalReason ??
          `Rate Config B2 does not match Kyle's ruled $${RULED_BILLED_RATE}/hr ` +
            `(src/services/laborRate.ts).`) +
        ` The cell is the price-book task's lane; this engine will not override it.`
    );
  } else if (opts.rateProvisional) {
    warnings.push(
      `Computed at a PROVISIONAL labour rate. ` +
        (opts.provisionalReason ?? `Rate Config B2 is not $${RULED_BILLED_RATE}/hr.`)
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
    /*
      KYLE'S ROWS DO NOT RESOLVE AT A SUPPLIER (P030).

      His sheet already carries the cost and the marked-up price he chose, tier by tier, row by
      row. Running them through the supplier lookup would find nothing (there are no Supplier
      Prices rows for his keys), null the cost, and raise NO_PRICE_AT_SUPPLIER on all 226 items —
      overwriting the numbers he set with the absence of numbers he never entered.
    */
    if (isFlatPriced(a)) {
      out.set(a.itemId, a);
      continue;
    }
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

// ─── Options A / B / C (2026-08-19) ─────────────────────────────────────────────

export interface OptionSummary {
  option: EstimateOption;
  lineCount: number;
  laborHours: number;
  laborDollars: number;
  materialSell: number;
  /** labour + material for THIS option's lines. Excludes the trip charge — see below. */
  subtotal: number | null;
  /** True when every line in the option priced completely. */
  complete: boolean;
}

/**
 * Per-option subtotals, grouped from lines the engine has already priced.
 *
 * Kyle, 2026-08-19: *"Each option gives its total separately. Each option can be selected to give
 * a combined total if they want to do one, two, or all three of the options."*
 *
 * ── THE TRIP CHARGE IS NOT IN HERE, AND THAT IS THE POINT ──────────────────────────────────────
 *
 * `jobFixedCost` is charged once for turning up. Folding it into each option's subtotal would
 * mean a customer who takes all three options pays it three times for one visit — and because
 * each option would still look individually correct, the error would only be visible in a total
 * nobody checks by hand. It belongs to the JOB, and Kyle's ruling says any combination of options
 * signed together *"count as a single job"*. So it is added once, by `combineOptions`, after the
 * selection is known.
 *
 * This groups rather than re-prices: the numbers are the engine's own, so there is no second
 * implementation of the money maths to drift from the first.
 */
export function summarizeOptions(computed: ComputedEstimate): OptionSummary[] {
  return ESTIMATE_OPTIONS.map((option) => {
    const lines = computed.lines.filter((l) => l.option === option);
    const laborHours = lines.reduce((n, l) => n + (l.laborHours ?? 0), 0);
    const laborDollars = lines.reduce((n, l) => n + (l.laborDollars ?? 0), 0);
    const materialSell = lines.reduce((n, l) => n + (l.materialSell ?? 0), 0);
    const complete = lines.length > 0 && lines.every((l) => l.complete);
    return {
      option,
      lineCount: lines.length,
      laborHours,
      laborDollars,
      materialSell,
      // Null when the rate is unknown, matching the estimate-level rule: never a number we made up.
      subtotal: computed.billedLaborRate === null ? null : laborDollars + materialSell,
      complete,
    };
  });
}

export interface CombinedTotal {
  selected: EstimateOption[];
  subtotal: number | null;
  jobFixedCost: number | null;
  total: number | null;
  /** False when any selected option has a line the engine could not price. */
  complete: boolean;
}

/**
 * What the customer pays for the options they ticked.
 *
 * The trip charge is added ONCE, however many options are selected, because the work happens on
 * one visit and is one job. Selecting nothing yields a null total rather than a £0 one — an empty
 * selection has no price, and showing zero would invite signing it.
 */
export function combineOptions(
  computed: ComputedEstimate,
  selected: EstimateOption[],
): CombinedTotal {
  const summaries = summarizeOptions(computed).filter((s) => selected.includes(s.option));
  const withLines = summaries.filter((s) => s.lineCount > 0);

  if (withLines.length === 0) {
    return { selected, subtotal: null, jobFixedCost: computed.jobFixedCost, total: null, complete: false };
  }

  const anyUnpriced = withLines.some((s) => s.subtotal === null);
  const subtotal = anyUnpriced ? null : withLines.reduce((n, s) => n + (s.subtotal ?? 0), 0);
  const total =
    subtotal === null || computed.jobFixedCost === null ? null : subtotal + computed.jobFixedCost;

  return {
    selected,
    subtotal,
    jobFixedCost: computed.jobFixedCost,
    total,
    complete: withLines.every((s) => s.complete),
  };
}
