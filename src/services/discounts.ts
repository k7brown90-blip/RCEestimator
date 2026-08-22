/**
 * The two discount programmes — military and senior (Kyle, 2026-08-22).
 *
 *   *"I also need to add in military discount at 5%, senior citizen discount at 5% in the
 *    services and fees section."* And on mechanics: *"Off of the whole job but gets capped
 *    at $250."*
 *
 * ── ONE FUNCTION, EVERY SURFACE ────────────────────────────────────────────────────────────────
 *
 * The customer page, the presentation screen, the PDF, the invoice email and the account row all
 * show a discounted figure. Five surfaces that each did their own arithmetic is how the invoice
 * total came to contradict the account row last week — so the computation lives here and nowhere
 * else, and every caller is handed the finished record.
 *
 * ── WHY 5% OF THE WHOLE JOB, AFTER THE OTHER GATES ─────────────────────────────────────────────
 *
 * "The whole job" is what the customer is actually paying: their selected options, plus the trip,
 * minus the combination discount. Running it BEFORE the combination discount would double-count —
 * 5% of money the customer is not being charged. The cap means a big remodel gives away $250, not
 * $500: the programme is a courtesy, not a margin structure.
 *
 * ── ONE PROGRAMME PER ESTIMATE ─────────────────────────────────────────────────────────────────
 *
 * The type is a single field, not a list. A customer who is both a veteran and a senior gets 5%
 * once — stacking to 10% was never offered and the schema cannot express it by construction.
 *
 * ── FROZEN AT SIGNATURE ────────────────────────────────────────────────────────────────────────
 *
 * The amount depends on the selection, which does not exist until the customer signs — the same
 * shape as the combination discount, frozen in the same transaction (discountJson). If the rate
 * or cap ever changes here, signed documents keep saying what they said.
 */

export type DiscountType = "military" | "senior";

export const DISCOUNT_RATE = 0.05;
export const DISCOUNT_CAP = 250;

export interface DiscountResult {
  type: DiscountType;
  rate: number;
  cap: number;
  /** What the 5% was taken of — selected subtotals + trip − combination discount. */
  base: number;
  amount: number;
  capped: boolean;
}

export function discountLabel(type: DiscountType): string {
  return type === "military" ? "Military discount (5%)" : "Senior discount (5%)";
}

/** Normalise untrusted input to a programme or nothing. Anything unrecognised is nothing. */
export function asDiscountType(v: unknown): DiscountType | null {
  return v === "military" || v === "senior" ? v : null;
}

/**
 * The discount for a billed base. Null when no programme applies or the base is not positive —
 * a discount on a zero job is a negative invoice, which is not a thing this system produces.
 */
export function discountFor(type: DiscountType | null | undefined, base: number): DiscountResult | null {
  if (!type) return null;
  if (!Number.isFinite(base) || base <= 0) return null;
  const raw = Math.round(base * DISCOUNT_RATE * 100) / 100;
  const amount = Math.min(raw, DISCOUNT_CAP);
  return { type, rate: DISCOUNT_RATE, cap: DISCOUNT_CAP, base: Math.round(base * 100) / 100, amount, capped: raw > DISCOUNT_CAP };
}
