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

export type DiscountType = "military" | "senior" | "custom";

export const DISCOUNT_RATE = 0.05;
export const DISCOUNT_CAP = 250;
/** The custom percentage is bounded: more than half off is a typo, not a price match. */
export const CUSTOM_PERCENT_MAX = 50;

/** A programme's terms: the rate taken of the base, and the ceiling if it has one. */
export interface DiscountProgramme {
  type: DiscountType;
  rate: number;
  /** Null = uncapped (custom). */
  cap: number | null;
  /** The whole-number-or-decimal percentage as Kyle typed or the programme defines (5, 7.5). */
  percent: number;
}

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

/** Normalise untrusted input to a programme type or nothing. Anything unrecognised is nothing. */
export function asDiscountType(v: unknown): DiscountType | null {
  return v === "military" || v === "senior" || v === "custom" ? v : null;
}

/** A valid custom percentage, or null. Two decimals, more than zero, at most CUSTOM_PERCENT_MAX. */
export function asCustomPercent(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  const rounded = Math.round(n * 100) / 100;
  return rounded > 0 && rounded <= CUSTOM_PERCENT_MAX ? rounded : null;
}

/**
 * The programme in force from the two stored fields. A "custom" type without a valid percentage
 * is no discount at all — never a guessed one.
 */
export function programmeFor(type: unknown, percent?: unknown): DiscountProgramme | null {
  const t = asDiscountType(type);
  if (!t) return null;
  if (t === "custom") {
    const p = asCustomPercent(percent);
    return p === null ? null : { type: t, rate: p / 100, cap: null, percent: p };
  }
  return { type: t, rate: DISCOUNT_RATE, cap: DISCOUNT_CAP, percent: DISCOUNT_RATE * 100 };
}

const fmtPercent = (p: number) => (Number.isInteger(p) ? String(p) : String(Math.round(p * 100) / 100));

/** What the customer reads beside the amount. */
export function discountLabel(p: DiscountProgramme | DiscountType): string {
  const prog = typeof p === "string" ? programmeFor(p) : p;
  if (!prog) return "Discount";
  if (prog.type === "military") return "Military discount (5%)";
  if (prog.type === "senior") return "Senior discount (5%)";
  return `Discount (${fmtPercent(prog.percent)}%)`;
}

/**
 * The terms in the words the office's discount block prints beside the buttons — "5% off, capped
 * at $250" / "7.5% off, no cap" (PriceBookIntakePage). Built here so the phone is SENT the sentence
 * and never works out a cap or a rate for itself (2026-10-08, one estimating system).
 */
export function discountTerms(p: DiscountProgramme): string {
  return p.cap === null ? `${fmtPercent(p.percent)}% off, no cap` : `${fmtPercent(p.percent)}% off, capped at $${p.cap}`;
}

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
