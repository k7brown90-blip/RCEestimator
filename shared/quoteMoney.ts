/**
 * What the customer's price looks like for a draft — computed ON THE SERVER, rendered by the CRM
 * presentation, the field Quote screen and the customer's page (2026-10-08, one-estimating-system
 * plan, Phases 2 and 3).
 *
 * 2026-09-24 field-estimate-parity plan, Unit A trap 2: "Do NOT port the CRM's client-side
 * discount arithmetic ... The server sends the amount; the phone renders it." The 5% / $250 cap
 * (and any rule that follows it) lives in ONE place — `discountOnBase` (shared/discountMath.ts),
 * through `programmeFor` in src/services/discounts.ts.
 *
 * ── ONE PRESENTATION MATH (Phase 3 unit A, Kyle 2026-10-08: "one estimating system") ───────────
 *
 * The price of "whatever the customer ticked" used to be worked out three times: in the CRM's
 * lib/presentation.ts + PresentationPage, in the Estimate Intake discount preview, and in
 * issuedEstimateRender's comboTable. `priceSelection` below is the one copy those three (and the
 * field's Show the customer screen) now share, and — since the review of 2026-10-08 — the discount
 * FROZEN at signing and at office acceptance is taken through it too
 * (src/services/discounts.ts `frozenSelectionDiscount`), so the signed discount is the cent the
 * screen showed. ONE reader still adds for itself: the estimate PDF (issuedEstimatePdf.ts) re-sums
 * the options taken for its own totals block, because it also prints each row and subtracts
 * warranty coverage. It takes the percentage through the same `discountOnBase` (via
 * `discountFor`) on a base rounded to the cent, which is exactly what `priceSelection` does, so
 * today's figures agree — but a change to the ORDER of the combined-options saving and the
 * discount made here must be repeated there. It is PURE — no database, no clock — and takes the
 * customer-visible FIGURES of a draft:
 *
 *   selection price = the ticked options' subtotals
 *                   + the trip (charged ONCE for the job, never per option)
 *                   − the combined-options material saving for exactly that combination
 *                   − the programme discount, a percentage of what is left, then the cap
 *
 * The server builds the figures (src/services/quoteMoney.ts for a draft, src/services/issuedPricingFigures.ts for
 * an issued estimate), runs this function for every combination the customer could tick, and ships
 * the finished table as `QuoteMoney.selections`. A screen looks the ticked key up; it does not add.
 *
 * Customer prices only. No labour hours, no labour dollars, no rates and no Red Cedar cost ever
 * ride here — the technician hands the phone to the customer (constants.md: "The field quote
 * payload carries NO labour hours or labour dollars"). The COMPANY view (materials, hours,
 * profit) is a different thing, computed in the CRM from the compute payload, and never reaches
 * the field.
 *
 * Plain interfaces and functions only — no TS enum, no constructor parameter properties — so the
 * client and field tsconfigs (erasableSyntaxOnly) accept this file as-is.
 */

import { discountOnBase, type DiscountRule } from "./discountMath";
import type { EstimateOptionLetter } from "./estimateOptions";
import type { QuoteFinancing } from "./financing";

const round2 = (n: number) => Math.round(n * 100) / 100;

/** One selection the discount is taken of: the whole job, or (one-or-the-other) a single option. */
export interface QuoteDiscountRow {
  /** "whole job", or "Option B" — the office's own words. */
  label: string;
  /** What the percentage was taken of (options + trip − combined-options material saving). */
  base: number;
  /** The material saving for combining options that is already inside `base`; 0 when none. */
  comboSaving: number;
  /** The discount in dollars, after the programme cap. */
  amount: number;
  capped: boolean;
  /** `base` minus `amount` — what the customer pays for this selection. */
  after: number;
}

export interface QuoteDiscount {
  type: "military" | "senior" | "custom";
  /** 5, or the custom percentage as typed (7.5). */
  percent: number;
  /** "Military discount (5%)" — what the customer reads beside the amount. */
  label: string;
  /** "5% off, capped at $250" / "7.5% off, no cap" — the office's wording. */
  terms: string;
  /**
   * One row per selection. Empty until a line is priced. `pricedOnceComplete` is true when some
   * selection still has an unpriced line, so no amount can be shown for it yet.
   */
  rows: QuoteDiscountRow[];
  pricedOnceComplete: boolean;
}

export interface QuoteRange {
  /** Cheapest and dearest option subtotal — the customer picks exactly ONE. */
  min: number;
  max: number;
}

/**
 * What the customer pays for ONE ticked combination, finished. Every field is a dollar figure the
 * customer's own page already shows; nothing here is a cost or a rate.
 */
export interface SelectionPrice {
  /** "A+B" — the options sorted and joined by "+" (`selectionKey`). */
  key: string;
  options: EstimateOptionLetter[];
  /** The ticked options' own subtotals added up (trip excluded). */
  subtotal: number;
  /** The trip / fixed job cost, once. */
  trip: number;
  /** What combining these options saves on material; 0 for one option or when nothing applies. */
  comboSaving: number;
  /** subtotal + trip − comboSaving: what the programme percentage is taken of. */
  base: number;
  /** The programme discount in dollars after its cap; 0 when no programme is set. */
  discount: number;
  discountCapped: boolean;
  /** base − discount: THE number the customer pays for this tick. */
  total: number;
}

export interface QuoteMoney {
  /** One-or-the-other mode (the "One-or-the-other options" checkbox). */
  exclusiveOptions: boolean;
  /**
   * Set only in one-or-the-other mode with two or more options holding lines, every one priced:
   * the grand sum of all options is the wrong number to headline there (Kyle, 2026-08-29).
   */
  range: QuoteRange | null;
  /** The programme in force and its finished amounts; null when no discount is set. */
  discount: QuoteDiscount | null;
  /**
   * The headline AFTER the discount, so the phone never subtracts anything: the whole-job `after`
   * in the ordinary mode; null in one-or-the-other mode (see `discountedRange`) or while a line is
   * unpriced.
   */
  discountedTotal: number | null;
  /** One-or-the-other mode: cheapest and dearest selection after the discount. */
  discountedRange: QuoteRange | null;
  /** Options that hold lines — the same ones the range is taken over. */
  pickable: EstimateOptionLetter[];
  /**
   * The finished price of EVERY combination the customer could tick, keyed "A", "A+B", … A
   * combination holding an unpriced option is absent — a screen shows "—", never a guess. At most
   * 255 entries (eight options), usually 7. Phase 3 unit A: the CRM presentation, the field's
   * "Show the customer" screen and the customer's page all read this one table.
   */
  selections: Record<string, SelectionPrice>;
  /**
   * The Synchrony financing figures for EVERY priced selection above (2026-10-08, one estimating
   * system, Phase 5), computed by the server with the ONE shared calculator (shared/financing.ts):
   * the plans once, and per selection key the deposit, fee, amount financed and monthly payment of
   * each active plan plus the "from $X/mo" headline. CUSTOMER-SAFE: no Synchrony rate rides here.
   * A screen looks the ticked key up; it never calculates. Absent/null when no plan is active (or,
   * for an estimate issued before plans were frozen onto it, none was on offer) - the screen then
   * shows no financing at all. Optional only so payloads built without Settings still type-check.
   */
  financing?: QuoteFinancing | null;
}

// ─── The pure pricer ─────────────────────────────────────────────────────────────────────────

/** The customer-visible figures of a draft or an issued estimate — everything `priceSelection` needs. */
export interface PricingFigures {
  /** The options that hold lines, with their own subtotal (null = a line is unpriced). */
  options: Array<{ option: string; subtotal: number | null }>;
  /** The trip / fixed job cost, charged once. */
  tripCharge: number;
  /** Combined-options material saving per combination key, applied savings only. Missing key = 0. */
  comboSavings: Record<string, number>;
  /** The discount programme in force as arithmetic, or null. */
  programme: DiscountRule | null;
}

/** "A+B": the options sorted and joined — the one spelling every surface uses for a combination. */
export function selectionKey(options: Iterable<string>): string {
  return [...new Set(options)].sort().join("+");
}

/**
 * The price of one ticked combination. Null for an empty selection (no price, never $0 — a $0
 * total invites signing it) and when any ticked option still has an unpriced line. A ticked option
 * the figures do not know is ignored, so a stale tick cannot price work that is not on the estimate.
 */
export function priceSelection(figures: PricingFigures, selected: readonly string[]): SelectionPrice | null {
  const chosen = figures.options.filter((o) => selected.includes(o.option));
  if (chosen.length === 0) return null;
  if (chosen.some((o) => o.subtotal === null)) return null;
  const key = selectionKey(chosen.map((o) => o.option));
  const subtotal = round2(chosen.reduce((n, o) => n + (o.subtotal ?? 0), 0));
  const trip = round2(figures.tripCharge);
  const comboSaving = round2(figures.comboSavings[key] ?? 0);
  const base = round2(subtotal + trip - comboSaving);
  const d = figures.programme ? discountOnBase(figures.programme, base) : null;
  const discount = d?.amount ?? 0;
  return {
    key,
    options: chosen.map((o) => o.option).sort() as EstimateOptionLetter[],
    subtotal,
    trip,
    comboSaving,
    base,
    discount,
    discountCapped: d?.capped ?? false,
    total: round2(base - discount),
  };
}

/** Every combination of the options the figures hold (at most 255), priced; unpriceable ones omitted. */
export function priceAllSelections(figures: PricingFigures): Record<string, SelectionPrice> {
  const letters = figures.options.map((o) => o.option).sort();
  const out: Record<string, SelectionPrice> = {};
  for (let mask = 1; mask < 1 << letters.length; mask++) {
    const taken = letters.filter((_, i) => mask & (1 << i));
    const price = priceSelection(figures, taken);
    if (price) out[price.key] = price;
  }
  return out;
}

// ─── What the screens ask of QuoteMoney ──────────────────────────────────────────────────────

/** The customer picks exactly ONE option: the mode is on AND there is something to choose between. */
export function picksOne(money: Pick<QuoteMoney, "exclusiveOptions" | "pickable">): boolean {
  return money.exclusiveOptions && money.pickable.length > 1;
}

/**
 * What starts ticked. Everything with work in it, so the first price shown is the full one the
 * customer was quoted (Kyle presents the whole thing and unticks what they decline); in
 * one-or-the-other mode the FIRST option, because presenting three alternatives as all-selected
 * would be a lie.
 */
export function defaultSelection(money: Pick<QuoteMoney, "exclusiveOptions" | "pickable">): EstimateOptionLetter[] {
  return picksOne(money) ? money.pickable.slice(0, 1) : [...money.pickable];
}

/** The finished price for what is ticked, or null (nothing ticked, or something unpriced). */
export function selectionPrice(
  money: Pick<QuoteMoney, "selections">,
  selected: readonly string[],
): SelectionPrice | null {
  if (selected.length === 0) return null;
  return money.selections[selectionKey(selected)] ?? null;
}

/**
 * What a tap on an option does to the ticks (the field's "Show the customer" screen; Phase 3 unit B).
 * One-or-the-other: picking one IS the act — it replaces the choice, and a tap on the chosen one
 * does nothing (unticking the only choice would present a $0 sale). Otherwise a tap flips that
 * option, and the customer may untick everything (the screen then shows no total, never $0).
 * `current` is what is ticked now; an option that is not pickable is ignored.
 */
export function toggleSelection(
  money: Pick<QuoteMoney, "exclusiveOptions" | "pickable">,
  current: readonly string[],
  option: string,
): EstimateOptionLetter[] {
  const pickable = money.pickable as readonly string[];
  if (!pickable.includes(option)) return current.filter((o) => pickable.includes(o)) as EstimateOptionLetter[];
  if (picksOne(money)) return [option as EstimateOptionLetter];
  const next = current.includes(option) ? current.filter((o) => o !== option) : [...current, option];
  return pickable.filter((o) => next.includes(o)) as EstimateOptionLetter[];
}
