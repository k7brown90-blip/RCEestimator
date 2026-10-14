/**
 * WHICH discount programme is in force, and what it is called — in ONE place the server and both
 * apps can import (2026-10-09, one-estimating-system plan, Phase 7 unit U3).
 *
 * Kyle, 2026-08-22: "military discount at 5%, senior citizen discount at 5%" — "Off of the whole job
 * but gets capped at $250." Kyle, 2026-09-01: a custom percentage, no cap, bounded at 50%.
 *
 * This used to live only in src/services/discounts.ts. The phone's labelled Preview with no signal
 * (Kyle, 2026-10-09, all three difficulties from 2026-10-13) needs to know what a
 * "military" discount DOES to a preview figure, and the one rule for that must not be copied into
 * field code — so the programme table moved here and discounts.ts re-exports it; its 28 importers
 * did not change. Nothing here is a cost or a rate of Red Cedar's: the 5% and the $250 cap are the
 * terms the customer already reads on the estimate ("5% off, capped at $250").
 *
 * The ARITHMETIC a programme does to a dollar figure is shared/discountMath.ts; this file owns which
 * programme and its words. Pure: no database, no clock. Plain interfaces and functions only — no TS
 * enum, no constructor parameter properties — so the client and field tsconfigs
 * (erasableSyntaxOnly) accept this file as-is.
 */

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
