/**
 * The customer's price for a draft, worked out ONCE on the server (2026-10-08, one-estimating-system
 * plan, Phase 2 for the field and Phase 3 unit A for the CRM presentation).
 *
 * Kyle, 2026-08-22: "military discount at 5%, senior citizen discount at 5%" — "Off of the whole job
 * but gets capped at $250." Kyle, 2026-09-01: "The discounts are not showing up. I can't tell if it
 * is applying them." The office used to price the discount (and the ticked-combination total) in the
 * browser, in two places; the phone must NOT do the same — a second copy of a money rule is how the
 * invoice came to contradict the account row. So the figures are built once, here, from the engine's
 * own option subtotals, trip and combined-options saving plus the programme in `discounts.ts`, run
 * through the PURE pricer in shared/quoteMoney.ts, and every screen renders the finished table:
 * the CRM Presentation page and Estimate Intake's discount block (via GET /price-book/drafts/:id/
 * compute) and the field Quote screen (via GET /health-record/quotes/:draftId). The customer's
 * public page runs the same pricer over its frozen lines (issuedEstimateRender).
 *
 * "The selection" is the whole job (every option together) in the ordinary mode, and each option on
 * its own in one-or-the-other mode, where the customer picks exactly one.
 *
 * Customer prices only — `summarizeOptions` is the engine's own grouping, and nothing here reads
 * hours, labour dollars or a rate. The amount is never stored on the draft (setDraftDiscount keeps
 * only the programme): it is a percentage of what the customer eventually selects.
 */

import type { PrismaClient } from "@prisma/client";
import type { EstimateOptionLetter } from "../../shared/estimateOptions";
import {
  priceAllSelections,
  type PricingFigures,
  type QuoteDiscount,
  type QuoteDiscountRow,
  type QuoteMoney,
  type QuoteRange,
  type SelectionPrice,
} from "../../shared/quoteMoney";
import { summarizeOptions, type ComputedEstimate, type OptionSummary } from "./atomicEstimateEngine";
import { pricingFiguresFromIssued } from "./issuedPricingFigures";
import { presentDecision } from "../../shared/presentIssue";
import type { DraftLifecycle } from "../../shared/draftLifecycle";
import { discountLabel, discountTerms, programmeFor, type DiscountProgramme } from "./discounts";
import { buildQuoteFinancing, type FinancingPlan, type QuoteFinancing } from "../../shared/financing";
import { getActiveFinancingPlans, plansFromSnapshot } from "./financingSettings";
import { parseWarrantyJson } from "./stripePayments";

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface QuoteMoneyDraft {
  discountType: string | null;
  discountPercent: number | null;
  exclusiveOptions: boolean;
}

/**
 * An option's subtotal exactly as ISSUING will freeze it (review finding, 2026-10-08): every line
 * rounded to the cent FIRST (graduateDraft's `lineTotal = round2(labour + material)`), those
 * cents added, then rounded. The engine's own `summarizeOptions` subtotal adds the raw floats, so
 * two lines of $14.375 sum to $28.75 there and $28.76 once frozen - a cent apart per line. The
 * money the phone and the Present screen show must be the money the customer signs, so the
 * figures are built from the per-line-rounded sum. Null when the engine has no billed rate
 * (summarizeOptions' own rule: never a number we made up).
 */
export function frozenStyleSubtotal(computed: ComputedEstimate, summary: OptionSummary): number | null {
  if (summary.subtotal === null) return null;
  return round2(
    computed.lines
      .filter((l) => l.option === summary.option)
      .reduce((n, l) => n + round2((l.laborDollars ?? 0) + (l.materialSell ?? 0)), 0),
  );
}

/**
 * Pure: the customer-visible figures of a computed draft, as the shared pricer wants them. The
 * trip is the engine's job fixed cost (charged once); the combined-options saving is the engine's
 * gate-3 reduction for exactly each combination, counted only where it APPLIED.
 */
export function pricingFiguresFromComputed(
  computed: ComputedEstimate,
  programme: DiscountProgramme | null,
): PricingFigures {
  const used = summarizeOptions(computed).filter((o) => o.lineCount > 0);
  const comboSavings: Record<string, number> = {};
  for (const [key, combo] of Object.entries(computed.combinationDiscounts ?? {})) {
    if (combo?.applied) comboSavings[key] = combo.reduction;
  }
  return {
    options: used.map((o) => ({ option: o.option, subtotal: frozenStyleSubtotal(computed, o) })),
    tripCharge: computed.jobFixedCost ?? 0,
    comboSavings,
    programme: programme ? { rate: programme.rate, cap: programme.cap } : null,
  };
}

/**
 * The Synchrony plans a payload prices, and the home-warranty coverage that comes off first.
 * LIVE draft: today's active plans from Settings. ISSUED estimate: the plans frozen onto it at issue
 * (`IssuedEstimate.financingPlansJson`), so a Settings edit never changes a sent quote.
 */
export interface FinancingInput {
  plans: readonly FinancingPlan[];
  /** Home-warranty coverage on an issued estimate; the homeowner finances only their share. */
  warrantyCovered?: number;
}

/**
 * Pure: the finished money table from customer-visible FIGURES - the one builder behind both the
 * live draft payload and the frozen issued-estimate payload (see `getQuoteMoney`), so the two can
 * never be shaped differently.
 *
 * `financing` (Phase 5): when given, every priced selection also gets its Synchrony figures from
 * the shared calculator. The finished table is what the CRM Present screen, Estimate Intake, the
 * field's Show-the-customer screen and the customer page read; none of them calculates.
 */
export function buildQuoteMoneyFromFigures(
  figures: PricingFigures,
  exclusiveOptions: boolean,
  programme: DiscountProgramme | null,
  financing?: FinancingInput | null,
): QuoteMoney {
  const used = figures.options;
  const pickable = used.map((o) => o.option as EstimateOptionLetter);
  // One-or-the-other only means anything with two or more options to choose between.
  const exclusive = exclusiveOptions && used.length > 1;
  // The range reads the SAME subtotals the table does, so the headline range and the
  // ticked-combination price can never disagree by a cent.
  const subtotals = used.map((o) => o.subtotal);
  const everyPriced = subtotals.every((s) => s !== null);

  const range: QuoteRange | null =
    exclusive && everyPriced
      ? {
          min: round2(Math.min(...(subtotals as number[]))),
          max: round2(Math.max(...(subtotals as number[]))),
        }
      : null;
  // THE one table: every combination the customer could tick, priced by the shared pricer.
  const selections = priceAllSelections(figures);

  let discount: QuoteDiscount | null = null;
  let discountedTotal: number | null = null;
  let discountedRange: QuoteRange | null = null;

  if (programme) {
    const rowFor = (sel: string[], label: string): QuoteDiscountRow | null => {
      const price: SelectionPrice | undefined = selections[[...sel].sort().join("+")];
      if (!price) return null;
      return {
        label,
        base: price.base,
        comboSaving: price.comboSaving,
        amount: price.discount,
        capped: price.discountCapped,
        after: price.total,
      };
    };

    const letters = used.map((o) => o.option);
    const sets: string[][] = exclusive ? letters.map((o) => [o]) : letters.length > 0 ? [letters] : [];
    const rows: QuoteDiscountRow[] = [];
    let pricedOnceComplete = false;
    for (const sel of sets) {
      const label = sel.length === letters.length && letters.length > 1 ? "whole job" : `Option ${sel[0]}`;
      const row = rowFor(sel, label);
      if (row) rows.push(row);
      else pricedOnceComplete = true;
    }

    discount = {
      type: programme.type,
      percent: programme.percent,
      label: discountLabel(programme),
      terms: discountTerms(programme),
      rows,
      pricedOnceComplete,
    };
    if (!exclusive) discountedTotal = rows[0]?.after ?? null;
    else if (rows.length === sets.length && rows.length > 0) {
      discountedRange = { min: Math.min(...rows.map((r) => r.after)), max: Math.max(...rows.map((r) => r.after)) };
    }
  }

  const money: QuoteMoney = { exclusiveOptions, range, discount, discountedTotal, discountedRange, pickable, selections };
  if (financing) money.financing = financingForSelections(financing, selections);
  return money;
}

/** Pure: the financing table for a set of priced selections - the one place payloads call the calculator. */
export function financingForSelections(
  financing: FinancingInput,
  selections: Record<string, SelectionPrice>,
): QuoteFinancing | null {
  const totals: Record<string, number> = {};
  for (const [key, price] of Object.entries(selections)) totals[key] = price.total;
  return buildQuoteFinancing(financing.plans, totals, financing.warrantyCovered ?? 0);
}

/** Pure: the finished figures for a computed (LIVE) draft. Exported so the rule is testable without a database. */
export function buildQuoteMoney(
  computed: ComputedEstimate,
  draft: QuoteMoneyDraft,
  financing?: FinancingInput | null,
): QuoteMoney {
  const programme = programmeFor(draft.discountType, draft.discountPercent);
  return buildQuoteMoneyFromFigures(pricingFiguresFromComputed(computed, programme), draft.exclusiveOptions, programme, financing);
}

/**
 * The customer's money for an estimate that is ISSUED and being used as it stands: the frozen
 * options, trip, band schedule, programme and mode of the estimate itself.
 */
export async function getIssuedQuoteMoney(prisma: PrismaClient, estimateId: string): Promise<QuoteMoney | null> {
  const est = await prisma.issuedEstimate.findUnique({
    where: { id: estimateId },
    select: {
      tripCharge: true,
      jobBandsJson: true,
      discountType: true,
      discountPercent: true,
      exclusiveOptions: true,
      // Server-side columns: the snapshot (rates inside) and the warranty claim are read to PRICE
      // the financing table; neither is returned - only finished figures leave this function.
      financingPlansJson: true,
      warrantyJson: true,
      options: { select: { option: true, subtotal: true }, orderBy: { option: "asc" } },
      lines: { select: { option: true, materialCost: true, materialSell: true, inMaterialCap: true } },
    },
  });
  if (!est) return null;
  const { figures } = pricingFiguresFromIssued(est);
  // The plans FROZEN at issue; an estimate issued before they were frozen offers no financing.
  const frozenPlans = plansFromSnapshot(est.financingPlansJson);
  return buildQuoteMoneyFromFigures(
    figures,
    Boolean(est.exclusiveOptions),
    programmeFor(est.discountType, est.discountPercent),
    frozenPlans ? { plans: frozenPlans, warrantyCovered: parseWarrantyJson(est.warrantyJson)?.coveredAmount ?? 0 } : null,
  );
}

/**
 * What both quote payloads carry as `money`.
 *
 * SHOW WHAT WILL BE SIGNED (review finding, 2026-10-08). "Show the customer" / "Present" USE the
 * estimate that already exists when the draft is issued and untouched since (shared/presentIssue.ts
 * `reuse`): nothing is re-frozen, and signing records THAT estimate's frozen lines, bands and
 * programme. Pricing the screen from today's catalog and today's Rate Config while the signature
 * records the frozen figures would let the customer agree to one number on the phone and sign
 * another after any price, rate or band change since issue. So in exactly that case the table is
 * built from the issued estimate; in every other case (never issued, or edited since - the press
 * will issue a fresh freeze of what the draft shows now) it is the live draft. A signed or lost
 * estimate has nothing to sign, so it keeps showing the draft.
 */
export async function getQuoteMoney(
  prisma: PrismaClient,
  draftId: string,
  computed: ComputedEstimate,
  lifecycle: DraftLifecycle,
): Promise<QuoteMoney> {
  const decision = presentDecision(lifecycle);
  if (decision.kind === "reuse" && !decision.signed && !decision.changedSince) {
    const frozen = await getIssuedQuoteMoney(prisma, decision.estimateId);
    if (frozen) return frozen;
  }
  const draft = await prisma.priceBookDraftEstimate.findUnique({
    where: { id: draftId },
    select: { discountType: true, discountPercent: true, exclusiveOptions: true },
  });
  // A draft has not been sent, so it reads LIVE Settings (the plans in force right now).
  const livePlans = await getActiveFinancingPlans();
  return buildQuoteMoney(
    computed,
    {
      discountType: draft?.discountType ?? null,
      discountPercent: draft?.discountPercent ?? null,
      exclusiveOptions: draft?.exclusiveOptions ?? false,
    },
    livePlans.length > 0 ? { plans: livePlans } : null,
  );
}
