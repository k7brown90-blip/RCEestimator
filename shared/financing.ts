/**
 * The in-app Synchrony financing estimator - ONE calculator, pure, integer cents (2026-10-08,
 * one-estimating-system plan, Phase 5 / Detail B).
 *
 * Kyle, 2026-10-08: "the tool that service titan has which allows you to input the job total cost,
 * the plan they select and it shows them their monthly payment. This way we can present the options
 * as a low monthly cost rather than a big bill and subsequently send them the financing option."
 *
 * ── THE MATH (verified against Synchrony's own estimator, 2026-10-08) ──────────────────────────
 *
 *   deposit   = one third of the job total - the SAME rounding as `depositDueOf`
 *               (src/services/stripePayments.ts): the nearest cent, half up. Never financed.
 *   balance   = total - deposit
 *   fee       = HALF of the plan's Synchrony discount rate x the balance (Kyle + advisory, 2026-10-08:
 *               "Fee = 50% of plan rate x balance after 1/3 deposit"), rounded to the cent
 *   financed  = balance + fee
 *   monthly   = reduced-APR plans (964/965): financed x payment factor (1.75%), rounded UP to the
 *               whole dollar. Deferred-interest plans (920/924): financed / promo months, rounded UP
 *               to the whole dollar. ($8,643 financed -> 964/965 $152, 924 $481, 920 $1,441.)
 *   payoff    = the plan's stated term (82 / 86 months, or the promo length) - a plan SETTING, never
 *               computed here.
 *
 * Everything is integer cents and integer scaled percentages, rounded ONCE at the end. Synchrony's
 * own page showed $176 for $10,000 where the rule gives $175 - their float artefact
 * (0.0175 x 10000 = 175.00000000000003, then rounded up). Ours is exact: $175.
 *
 * "Total payments with interest" is deliberately NOT computed (plan, Detail B "The math"): it
 * depends on billing-cycle days only Synchrony has, and a credit-cost figure that does not match
 * the lender's is worse than none.
 *
 * ── WHO MAY SEE WHAT ───────────────────────────────────────────────────────────────────────────
 *
 * `FinancingPlan.discountRatePct` is RED CEDAR'S COST - what Synchrony charges the company. It
 * lives in Settings and on the server (and in the snapshot frozen on an issued estimate so the
 * server can recompute). It must never reach a CRM customer view, the field payload, a field
 * screen, a public page, an email or a PDF. Every function that leaves the server returns the
 * customer-safe `FinancingPlanView` / `FinancingFigures` below, which have NO rate fields; the
 * field and the CRM presentation import ONLY those types (`import type`), so no rate arithmetic is
 * even bundled with them. tests/financingEstimator.test.ts greps the field and client sources for
 * the rate's field name to keep it that way.
 *
 * Plain interfaces and functions only - no TS enum, no constructor parameter properties - so the
 * client and field tsconfigs (erasableSyntaxOnly) accept this file as-is.
 */

export type FinancingPlanType = "reduced_apr" | "deferred_interest";

export const FINANCING_PLAN_TYPES: readonly FinancingPlanType[] = ["reduced_apr", "deferred_interest"];

/** Synchrony's own text for a plan, shown VERBATIM beside its figures - never paraphrased or trimmed. */
export interface FinancingDisclosure {
  /** The paragraph explaining how the estimated payment was worked out. */
  explanation: string;
  /** The "IMPORTANT: ..." line. */
  important: string;
  /** The promo terms block (dated: "New Accounts as of 08/29/25: Purchase APR 26.99%"). */
  terms: string;
}

/**
 * A plan as it is configured in Settings. SERVER-SIDE / SETTINGS-SCREEN ONLY - carries Red Cedar's
 * cost (`discountRatePct`). Percent fields are PERCENTS (6.1 means 6.1%), never fractions.
 */
export interface FinancingPlan {
  /** Synchrony's plan number, e.g. "965". A string: it is an identifier, not a quantity. */
  planNumber: string;
  type: FinancingPlanType;
  /** "10.99% APR until paid in full" / "No interest if paid in full within 18 months". */
  description: string;
  /** Reduced APR: the fixed-payment term (82 / 86). Deferred interest: the promo length (6 / 18). */
  months: number;
  /** The customer's APR for a reduced-APR plan (10.99); null for deferred interest. */
  apr: number | null;
  /** Fixed payment as a percent of the amount financed (1.75 / 2.5). Only reduced APR computes with it. */
  paymentFactorPct: number;
  /** Synchrony's charge to Red Cedar, as a percent (6.1). RED CEDAR'S COST - never shown to customers. */
  discountRatePct: number;
  active: boolean;
  /** Display order, lowest first. */
  sortOrder: number;
  disclosure: FinancingDisclosure;
}

/** The part of a plan the customer reads - no rate fields. Sent once per payload, not per selection. */
export interface FinancingPlanView {
  planNumber: string;
  description: string;
  type: FinancingPlanType;
  months: number;
  /** The customer's APR for a reduced-APR plan; null for deferred interest. */
  apr: number | null;
  disclosure: FinancingDisclosure;
}

/** One plan's finished dollar figures for ONE selection. Whole-dollar `monthly`; the rest in dollars and cents. */
export interface FinancingFigures {
  planNumber: string;
  /** The one-third deposit, paid up front and never financed. */
  deposit: number;
  /** The financing fee as its own line. */
  fee: number;
  /** balance + fee - what the customer authorizes Synchrony to release. */
  financed: number;
  /** The monthly payment in WHOLE dollars (rounded up). */
  monthly: number;
}

/** The complete customer-safe offer for one plan and one selection: what a plan card renders. */
export type FinancingOffer = FinancingPlanView & FinancingFigures;

/** One selection's offers (plan order) and its "from $X/mo" headline. */
export interface SelectionFinancing {
  /** The lowest monthly payment among the offers - "or from $175/mo". */
  fromMonthly: number;
  /** The plan that headline belongs to. */
  fromPlanNumber: string;
  offers: FinancingFigures[];
  /**
   * Home-warranty coverage taken off this selection before it was financed, in dollars - present ONLY
   * when a claim reduces what the homeowner finances (review finding, 2026-10-08). With `yourShare` it
   * lets every sheet say the deposit is a third of THEIR share, not of the gross total beside it.
   */
  warrantyCovered?: number;
  /** The homeowner's share (selection total - coverage): what the deposit, fee and monthly are worked on. */
  yourShare?: number;
}

/** What rides on the money payloads: the plan descriptors once, and the figures per selection key. */
export interface QuoteFinancing {
  plans: FinancingPlanView[];
  bySelection: Record<string, SelectionFinancing>;
}

// ─── The calculation, in integer cents ───────────────────────────────────────────────────────

/** Percentages are held to four decimals; scaling by this makes them exact integers (7.25 -> 72500). */
const PCT_SCALE = 10_000;
const scaled = (pct: number) => Math.round(pct * PCT_SCALE);

/** Integer divide, rounded half UP (n and d are non-negative integers). */
function divRound(n: number, d: number): number {
  return Math.floor((2 * n + d) / (2 * d));
}

/** Integer divide, rounded UP to the next whole number. */
function divCeil(n: number, d: number): number {
  return Math.floor((n + d - 1) / d);
}

/**
 * One third of the total, to the cent, half up. Identical to `depositDueOf` (stripePayments.ts:
 * round2(total / 3)): a third of a whole number of cents is only ever .000, .333 or .667 of a cent,
 * never exactly .5, so no tie can fall differently. tests/financingEstimator.test.ts pins the
 * agreement over a range of totals - "reuse/align, do not diverge".
 */
export function depositCentsOf(totalCents: number): number {
  return divRound(totalCents, 3);
}

/** The financing fee, in cents: half the plan's discount rate x the balance, to the cent, half up. */
export function financingFeeCents(balanceCents: number, discountRatePct: number): number {
  // balance x (rate% / 2) = balance x scaledRate / (PCT_SCALE x 100 x 2)
  return divRound(balanceCents * scaled(discountRatePct), PCT_SCALE * 100 * 2);
}

/**
 * What Synchrony keeps when it funds a gross amount, in cents: the FULL discount rate x the gross,
 * to the cent, half up (Phase 6 Unit 6A, 2026-10-09). The fee above is HALF of this rate on the
 * balance; this is the whole rate on what was actually financed (balance + fee), which is why
 * Red Cedar's half of the fee covers ~48% of the cut and the rest is a cost of sale. Synchrony pays
 * NET (gross - cut) and offers no API for the figure, so the server captures it at recording from
 * the fee record's rate snapshot. Server-side only: the field and the CRM payment panel receive the
 * finished dollar figures, never the rate.
 */
export function lenderCutCents(grossCents: number, discountRatePct: number): number {
  return divRound(grossCents * scaled(discountRatePct), PCT_SCALE * 100);
}

/**
 * The monthly payment in WHOLE dollars, rounded UP, for an amount financed.
 * Reduced APR: financed x payment factor. Deferred interest: financed / promo months.
 */
export function monthlyPaymentDollars(
  plan: Pick<FinancingPlan, "type" | "months" | "paymentFactorPct">,
  financedCents: number,
): number {
  if (plan.type === "reduced_apr") {
    // financed x (factor% / 100) cents, then up to whole dollars (/100).
    return divCeil(financedCents * scaled(plan.paymentFactorPct), PCT_SCALE * 100 * 100);
  }
  return divCeil(financedCents, plan.months * 100);
}

/** The finished figures for one plan and a job total, in integer cents. Internal to the server and tests. */
export interface FinancingCalc {
  depositCents: number;
  balanceCents: number;
  feeCents: number;
  financedCents: number;
  monthlyDollars: number;
  /** The plan's stated payoff period. */
  payoffMonths: number;
}

export function calculateFinancing(plan: FinancingPlan, totalCents: number): FinancingCalc {
  const depositCents = depositCentsOf(totalCents);
  const balanceCents = totalCents - depositCents;
  const feeCents = financingFeeCents(balanceCents, plan.discountRatePct);
  const financedCents = balanceCents + feeCents;
  return {
    depositCents,
    balanceCents,
    feeCents,
    financedCents,
    monthlyDollars: monthlyPaymentDollars(plan, financedCents),
    payoffMonths: plan.months,
  };
}

// ─── Customer-safe views ─────────────────────────────────────────────────────────────────────

/** Plans in the order they are shown: sortOrder, then plan number as a stable tiebreak. */
export function orderedPlans<T extends Pick<FinancingPlan, "sortOrder" | "planNumber">>(plans: readonly T[]): T[] {
  return [...plans].sort((a, b) => a.sortOrder - b.sortOrder || a.planNumber.localeCompare(b.planNumber));
}

/** The customer-readable part of a plan. Copies only the named fields - the rate cannot ride along. */
export function planView(plan: FinancingPlan): FinancingPlanView {
  return {
    planNumber: plan.planNumber,
    description: plan.description,
    type: plan.type,
    months: plan.months,
    apr: plan.type === "reduced_apr" ? plan.apr : null,
    disclosure: {
      explanation: plan.disclosure.explanation,
      important: plan.disclosure.important,
      terms: plan.disclosure.terms,
    },
  };
}

const toDollars = (cents: number) => cents / 100;

/** One plan's customer-safe figures for a job total in cents. */
export function financingFigures(plan: FinancingPlan, totalCents: number): FinancingFigures {
  const c = calculateFinancing(plan, totalCents);
  return {
    planNumber: plan.planNumber,
    deposit: toDollars(c.depositCents),
    fee: toDollars(c.feeCents),
    financed: toDollars(c.financedCents),
    monthly: c.monthlyDollars,
  };
}

/** The complete customer-safe offer (plan descriptor + figures) - what one plan card renders. */
export function financingOffer(plan: FinancingPlan, totalCents: number): FinancingOffer {
  return { ...planView(plan), ...financingFigures(plan, totalCents) };
}

/** Whole dollars or dollars-and-cents total -> integer cents. */
export function dollarsToCents(dollars: number): number {
  return Math.round(dollars * 100);
}

/**
 * Financing for EVERY priced selection: `totalsByKey` maps a selection key ("A", "A+B") to what the
 * customer pays for that tick, in dollars. A selection that is not worth financing (no price, or
 * nothing owed) is absent - a screen shows nothing, never "$0/mo". Inactive plans are skipped, so
 * a snapshot or a Settings list can be passed whole. Returns null when no plan is active.
 *
 * `coveredDollars` is a home-warranty company paying part of the bill (Kyle, 2026-09-09): the
 * homeowner finances only THEIR share, so it comes off each selection first, capped at that
 * selection’s total exactly as the customer’s page caps it (issuedEstimateRender).
 */
export function buildQuoteFinancing(
  plans: readonly FinancingPlan[],
  totalsByKey: Readonly<Record<string, number>>,
  coveredDollars = 0,
): QuoteFinancing | null {
  const active = orderedPlans(plans.filter((p) => p.active));
  if (active.length === 0) return null;
  const bySelection: Record<string, SelectionFinancing> = {};
  for (const [key, total] of Object.entries(totalsByKey)) {
    const gross = dollarsToCents(total);
    const coveredCents = Math.min(Math.max(0, dollarsToCents(coveredDollars)), gross);
    const cents = gross - coveredCents;
    if (!Number.isFinite(cents) || cents <= 0) continue;
    const offers = active.map((p) => financingFigures(p, cents));
    // "From" = the lowest monthly; on a tie the plan shown first (the cheapest for Red Cedar).
    let best = offers[0];
    for (const o of offers) if (o.monthly < best.monthly) best = o;
    bySelection[key] = { fromMonthly: best.monthly, fromPlanNumber: best.planNumber, offers };
    if (coveredCents > 0) {
      bySelection[key].warrantyCovered = toDollars(coveredCents);
      bySelection[key].yourShare = toDollars(cents);
    }
  }
  return { plans: active.map(planView), bySelection };
}
