/**
 * The discount arithmetic, in ONE place that the server and both apps can import
 * (2026-10-08, one-estimating-system plan, Phase 3 unit A: one presentation math).
 *
 * Kyle, 2026-08-22: "military discount at 5%, senior citizen discount at 5%" — "Off of the whole job
 * but gets capped at $250." Kyle, 2026-09-01: the custom percentage has no cap.
 *
 * `src/services/discounts.ts` owns WHICH programme is in force and what it is called; this file owns
 * what a programme does to a dollar figure, so the pure selection pricer (shared/quoteMoney.ts) and
 * `discountFor` cannot drift apart. Pure: no database, no Prisma, no clock.
 *
 * Plain functions only — no TS enum, no constructor parameter properties — so the client and field
 * tsconfigs (erasableSyntaxOnly) accept this file as-is.
 */

/** A programme as arithmetic: the share taken of the base, and the dollar ceiling if it has one. */
export interface DiscountRule {
  /** 0.05 for 5%. */
  rate: number;
  /** Null = uncapped (the custom percentage). */
  cap: number | null;
}

export interface DiscountAmount {
  /** The discount in dollars, to the cent, after the programme cap. */
  amount: number;
  /** True when the cap, not the percentage, set the amount. */
  capped: boolean;
}

/**
 * The discount for a billed base. Null when the base is not a positive number — a discount on a
 * zero job is a negative invoice, which is not a thing this system produces.
 */
export function discountOnBase(rule: DiscountRule, base: number): DiscountAmount | null {
  if (!Number.isFinite(base) || base <= 0) return null;
  const raw = Math.round(base * rule.rate * 100) / 100;
  const amount = rule.cap === null ? raw : Math.min(raw, rule.cap);
  return { amount, capped: rule.cap !== null && raw > rule.cap };
}
