/**
 * The discount programmes — military and senior (Kyle, 2026-08-22), and a custom percentage
 * (Kyle, 2026-09-01).
 *
 *   *"I also need to add in military discount at 5%, senior citizen discount at 5% in the
 *    services and fees section."* And on mechanics: *"Off of the whole job but gets capped
 *    at $250."*
 *
 *   *"I want to be able to add a custom discount here. This will allow me to stay competitive
 *    and I can follow through with a price match system. I want a simple enter a percentage
 *    and apply button next to the other discounts."*
 *
 * ── ONE FUNCTION, EVERY SURFACE ────────────────────────────────────────────────────────────────
 *
 * The customer page, the presentation screen, the PDF, the invoice email, the Stripe amount and
 * the account row all show a discounted figure. Five surfaces that each did their own arithmetic
 * is how the invoice total came to contradict the account row — so the computation lives here and
 * nowhere else, and every caller is handed the finished record.
 *
 * ── WHY A PERCENTAGE OF THE WHOLE JOB, AFTER THE OTHER GATES ───────────────────────────────────
 *
 * "The whole job" is what the customer is actually paying: their selected options, plus the trip,
 * minus the combination discount. Running it BEFORE the combination discount would double-count —
 * a percentage of money the customer is not being charged.
 *
 * ── THE CAP IS THE PROGRAMMES', NOT THE CUSTOM RATE'S ──────────────────────────────────────────
 *
 * Military and senior are courtesies: 5%, and a big remodel gives away $250, not $500. The custom
 * percentage is the opposite kind of number — Kyle typing the exact concession a price match
 * needs. A ceiling on it would silently undercut the match he just promised, so it has none; the
 * dollar amount is his to control through the percentage, which is bounded at 50%.
 *
 * ── ONE PROGRAMME PER ESTIMATE ─────────────────────────────────────────────────────────────────
 *
 * The type is a single field, not a list. A customer who is both a veteran and a senior gets 5%
 * once; a custom rate replaces a programme rather than stacking on it. The schema cannot express
 * stacking by construction.
 *
 * ── FROZEN AT SIGNATURE ────────────────────────────────────────────────────────────────────────
 *
 * The amount depends on the selection, which does not exist until the customer signs — the same
 * shape as the combination discount, frozen in the same transaction (discountJson). The custom
 * percentage itself is frozen onto the issued estimate at issue, so an edit to the draft later
 * cannot restate a document in a customer's hands.
 */

import { discountOnBase } from "../../shared/discountMath";
import { priceSelection, selectionKey } from "../../shared/quoteMoney";
import { programmeFor, type DiscountProgramme, type DiscountType } from "../../shared/discountProgramme";

/*
  ── THE PROGRAMME TABLE MOVED TO shared/discountProgramme.ts (2026-10-09, Phase 7 unit U3) ──────

  Which programme is in force (programmeFor), the two normalisers (asDiscountType, asCustomPercent),
  the DISCOUNT_* constants and the two word functions (discountLabel, discountTerms) now live in
  shared/ so the phone's labelled Preview with no signal applies the SAME programme rule the server
  does, from the same file, instead of a copy. Re-exported here unchanged so every existing importer
  of this module keeps working. What stays here is what needs the server: `discountFor` and the
  signing-time `frozenSelectionDiscount`.
*/
export {
  CUSTOM_PERCENT_MAX,
  DISCOUNT_CAP,
  DISCOUNT_RATE,
  asCustomPercent,
  asDiscountType,
  programmeFor,
  type DiscountProgramme,
  type DiscountType,
} from "../../shared/discountProgramme";

export interface DiscountResult {
  type: DiscountType;
  rate: number;
  cap: number | null;
  percent: number;
  /** What the percentage was taken of — selected subtotals + trip − combination discount. */
  base: number;
  amount: number;
  capped: boolean;
}

// The words beside the amount and the terms sentence: shared/discountProgramme.ts, re-exported.
export { discountLabel, discountTerms } from "../../shared/discountProgramme";

/**
 * The discount for a billed base. Null when no programme applies or the base is not positive —
 * a discount on a zero job is a negative invoice, which is not a thing this system produces.
 * Accepts a programme type ("military"/"senior") for the fixed programmes, or the full terms.
 */
export function discountFor(
  programme: DiscountProgramme | DiscountType | null | undefined,
  base: number,
): DiscountResult | null {
  const prog = typeof programme === "string" ? programmeFor(programme) : programme ?? null;
  if (!prog) return null;
  // The arithmetic itself is shared/discountMath.ts — the one copy the pure selection pricer
  // (shared/quoteMoney.ts, the CRM presentation and the field screen) also uses (2026-10-08).
  const d = discountOnBase(prog, base);
  if (!d) return null;
  return {
    type: prog.type,
    rate: prog.rate,
    cap: prog.cap,
    percent: prog.percent,
    base: Math.round(base * 100) / 100,
    amount: d.amount,
    capped: d.capped,
  };
}

/**
 * The discount FROZEN at signing or office acceptance, worked out by the shared pure pricer
 * (shared/quoteMoney.ts `priceSelection`) over the estimate's frozen figures (2026-10-08, Kyle's
 * "one estimating system", review finding on Phase 3 unit A).
 *
 * The customer page, the CRM Present screen, Estimate Intake and the field Show / Sign screens all
 * price "what did they tick" through `priceSelection`, which rounds the base to the cent BEFORE it
 * takes the percentage. Signing used to add the floats itself and hand the unrounded sum to
 * `discountFor`, so a base like 1235.8999999999999 froze $61.79 where the screen had shown $61.80
 * — a signed total a cent off the one the customer ticked. Both write paths (applySignature and
 * recordOfficeAcceptance) call THIS function now, so the frozen discount cannot come from a
 * different calculation than the figure on screen.
 *
 * `comboReduction` is the combined-options saving that APPLIED for exactly `bought` (0 when none).
 */
export function frozenSelectionDiscount(
  est: {
    discountType: string | null | undefined;
    discountPercent: number | null | undefined;
    tripCharge: number | null | undefined;
    options: ReadonlyArray<{ option: string; subtotal: number }>;
  },
  bought: readonly string[],
  comboReduction: number,
): DiscountResult | null {
  const programme = programmeFor(est.discountType, est.discountPercent);
  if (!programme) return null;
  const trip = est.tripCharge ?? 0;
  const price = priceSelection(
    {
      options: est.options.map((o) => ({ option: o.option, subtotal: o.subtotal })),
      tripCharge: trip,
      comboSavings: { [selectionKey(bought)]: comboReduction },
      programme: { rate: programme.rate, cap: programme.cap },
    },
    bought,
  );
  // An estimate with no options at all (nothing to tick) is priced on its trip alone, as before.
  if (!price) return discountFor(programme, Math.round((trip - comboReduction) * 100) / 100);
  if (!(price.base > 0)) return null;
  return {
    type: programme.type,
    rate: programme.rate,
    cap: programme.cap,
    percent: programme.percent,
    base: price.base,
    amount: price.discount,
    capped: price.discountCapped,
  };
}
