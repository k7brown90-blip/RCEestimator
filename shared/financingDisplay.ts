/**
 * What a financing plan card SAYS - the words and the lookups, shared by the CRM, the field app and
 * the customer's page so the three read the same (2026-10-08, one-estimating-system plan, Phase 5
 * unit B, Detail B "Where it lives").
 *
 * This file does no money arithmetic. The figures (deposit, fee, amount financed, monthly payment)
 * were worked out ON THE SERVER by the one calculator (shared/financing.ts) and ride on
 * `QuoteMoney.financing`; a screen LOOKS THE TICK UP here and prints what it finds. It imports only
 * TYPES from financing.ts, so no rate arithmetic is bundled with a screen, and the customer-safe
 * types it works on carry no Synchrony discount rate (Red Cedar's cost) at all.
 *
 * Wording, Kyle 2026-10-08 (Detail B): the monthly figure carries Synchrony's OWN labels - "Fixed
 * monthly payment" for a reduced-APR plan, "Suggested equal monthly payment" for a deferred-interest
 * plan - and each card carries that plan's Synchrony disclosure VERBATIM from Settings. There is no
 * "total payments with interest" anywhere: it cannot be reproduced without Synchrony's billing-cycle
 * dates, and a credit-cost figure that does not match the lender's is worse than none.
 *
 * Plain functions only - no TS enum, no constructor parameter properties - so the client and field
 * tsconfigs (erasableSyntaxOnly) and the server all accept this file as-is.
 */

import type {
  FinancingOffer,
  FinancingPlanType,
  FinancingPlanView,
  QuoteFinancing,
  SelectionFinancing,
} from "./financing";
import { selectionKey } from "./quoteMoney";

/** Whole dollars, no cents - the monthly payment is always rounded up to a whole dollar. */
export function wholeDollars(n: number): string {
  return `$${Math.round(n)}`;
}

/** Dollars and cents, formatted EXACTLY as every other money figure on these screens (no thousands comma). */
export function dollarsAndCents(n: number): string {
  return `$${n.toFixed(2)}`;
}

/** Synchrony's own label for the monthly figure of a plan type. */
export function monthlyLabel(type: FinancingPlanType): string {
  return type === "reduced_apr" ? "Fixed monthly payment" : "Suggested equal monthly payment";
}

/** "11.99% APR - 86 months" for a reduced-APR plan; "18 month promotion" for deferred interest. */
export function termLine(plan: Pick<FinancingPlanView, "type" | "apr" | "months">): string {
  if (plan.type === "reduced_apr") {
    return plan.apr === null ? `${plan.months} months` : `${plan.apr}% APR · ${plan.months} months`;
  }
  return `${plan.months} month promotion`;
}

/** The card's title: "Plan 965 - 11.99% APR until paid in full". */
export function planTitle(plan: Pick<FinancingPlanView, "planNumber" | "description">): string {
  return `Plan ${plan.planNumber} — ${plan.description}`;
}

/** The three labelled lines under the monthly figure, in order. The fee is its own line, never folded in. */
export function breakdownRows(offer: Pick<FinancingOffer, "planNumber" | "deposit" | "fee" | "financed">): Array<{
  /** The FinancingFigures field this row prints - the customer page repaints the right cell by it. */
  key: "deposit" | "fee" | "financed";
  label: string;
  value: string;
}> {
  return [
    { key: "deposit", label: "Deposit (one third, paid up front)", value: dollarsAndCents(offer.deposit) },
    { key: "fee", label: `Financing fee — Plan ${offer.planNumber}`, value: dollarsAndCents(offer.fee) },
    { key: "financed", label: "Amount financed", value: dollarsAndCents(offer.financed) },
  ];
}

/** "or from $175/mo with financing" - the line under a selection total that opens the plan cards. */
export function fromLine(sel: Pick<SelectionFinancing, "fromMonthly">): string {
  return `or from ${wholeDollars(sel.fromMonthly)}/mo with financing`;
}

/**
 * The sentence at the top of the plan cards: it says the deposit is still paid, and that it records
 * nothing (decision 12 - the plan is chosen when the balance is paid).
 *
 * Reworded 2026-11-27, Kyle: "when someone chooses financing it needs to be clear they pay a
 * deposit still." The old text said payments were worked "on the total shown"; they are worked on
 * the balance after the one-third deposit (shared/financing.ts).
 */
export const FINANCING_SHEET_NOTE =
  "Financing covers the balance after the one-third deposit. The deposit is still paid up front, before we schedule. Estimated monthly payments; nothing is chosen or recorded here.";

/** The warranty variant: identical, but a home-warranty claim reduced what the homeowner finances, so it is "your share". */
export const FINANCING_SHEET_NOTE_WARRANTY =
  "Financing covers your share after the one-third deposit. The deposit is still paid up front, before we schedule. Estimated monthly payments; nothing is chosen or recorded here.";

/**
 * The line the customer's email and PDF carry under "Finance this project" (Kyle, 2026-11-27). The
 * amount is the one-third deposit from the SAME buildQuoteFinancing result the monthly figures come
 * from; a price range with no offers has no amount, so the sentence is worded without one.
 * No credit terms: nothing here is a rate, a term or an approval.
 */
export function financingDepositLine(deposit: number | null): string {
  return deposit !== null && deposit > 0
    ? `Financing covers the balance. The one-third deposit of ${dollarsAndCents(deposit)} is still paid up front, before we schedule.`
    : "Financing covers the balance. The one-third deposit is still paid up front, before we schedule.";
}

/** The financing-link email's deposit sentence (Kyle, 2026-11-27). Same rule: no credit terms. */
export const FINANCING_LINK_DEPOSIT_SENTENCE =
  "Financing covers the balance after the one-third deposit. The deposit is still paid to Red Cedar Electric up front, before we schedule the work.";

/** The signed page's deposit box and the deposit-request email, where financing is on offer (Kyle, 2026-11-27). */
export const FINANCING_DEPOSIT_STILL_DUE =
  "Paying the balance with financing? This deposit is still due now. Financing covers the balance after it.";

/**
 * The sheet's header tail: the total the selection is shown at, and - when a home-warranty claim
 * reduced what the homeowner finances - the coverage and "your share" the cards were worked on, so
 * the one-third deposit on each card is visibly a third of the number beside it (review finding,
 * 2026-10-08). The figures are the server's; this only words them.
 */
export function sheetTotalLine(total: number | null, sel: Pick<SelectionFinancing, "warrantyCovered" | "yourShare">): string {
  const parts: string[] = [];
  if (total !== null) parts.push(`total ${dollarsAndCents(total)}`);
  if (sel.warrantyCovered !== undefined && sel.yourShare !== undefined) {
    parts.push(`warranty covers ${dollarsAndCents(sel.warrantyCovered)}`);
    parts.push(`your share ${dollarsAndCents(sel.yourShare)}`);
  }
  return parts.length ? ` · ${parts.join(" · ")}` : "";
}

/** The sheet's opening sentence: covers the balance, or - when a warranty claim reduced what is financed - "your share". */
export function financingSheetNote(sel: Pick<SelectionFinancing, "yourShare">): string {
  return sel.yourShare === undefined
    ? FINANCING_SHEET_NOTE
    : FINANCING_SHEET_NOTE_WARRANTY;
}

/** One selection's financing, or null when nothing is ticked, nothing is owed, or no plan is on offer. */
export function selectionFinancing(
  financing: QuoteFinancing | null | undefined,
  selected: readonly string[],
): SelectionFinancing | null {
  if (!financing || selected.length === 0) return null;
  return financing.bySelection[selectionKey(selected)] ?? null;
}

/**
 * The plan cards for one selection, in the order the Settings list gives (Kyle's: 965, 964, 920,
 * 924): each plan's customer-readable descriptor joined to that selection's finished figures. Null
 * when there is nothing to show. A plan the descriptors do not know is skipped, never invented.
 */
export function financingOffersFor(
  financing: QuoteFinancing | null | undefined,
  selected: readonly string[],
): { from: SelectionFinancing; offers: FinancingOffer[] } | null {
  const from = selectionFinancing(financing, selected);
  if (!financing || !from) return null;
  const offers: FinancingOffer[] = [];
  for (const fig of from.offers) {
    const plan = financing.plans.find((p) => p.planNumber === fig.planNumber);
    if (plan) offers.push({ ...plan, ...fig });
  }
  if (offers.length === 0) return null;
  return { from, offers };
}

/**
 * The lowest "from" among several selections - Estimate Intake's one-or-the-other bar, where the
 * customer will pick exactly ONE option so the honest headline is the cheapest alternative. Ties go
 * to the first key given.
 */
export function cheapestSelection(
  financing: QuoteFinancing | null | undefined,
  keys: ReadonlyArray<readonly string[]>,
): { key: string; from: SelectionFinancing } | null {
  let best: { key: string; from: SelectionFinancing } | null = null;
  for (const k of keys) {
    const from = selectionFinancing(financing, k);
    if (from && (!best || from.fromMonthly < best.from.fromMonthly)) best = { key: selectionKey(k), from };
  }
  return best;
}
