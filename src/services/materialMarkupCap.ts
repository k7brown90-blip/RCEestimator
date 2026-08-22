/**
 * A second check on material markup, keyed to the size of the job.
 *
 * Kyle, 2026-08-21:
 *
 *   *"I need to double check how these estimates add up for bigger projects... Our markup does a
 *    per item. The estimate I am working on right now has material approximately 3x the total
 *    material cost. We have to plan the best way for the material mark ups work against total
 *    material cost so it stays within a reasonable range."*
 *
 *   *"I think we keep the main tiers but introduce a second check that looks at total material
 *    cost and apply it to the same tiered system we have."*
 *
 * ── WHY THE PER-ITEM TIERS ARE NOT THE PROBLEM ─────────────────────────────────────────────────
 *
 * Markup on material pays for procurement — sourcing it, fetching it, handling it, warrantying it,
 * carrying the cost until the customer pays. Those are close to FIXED per item and per trip, not
 * proportional to what the item cost. A $2 connector and a $200 breaker take the same phone call.
 * That is exactly why a cheap item earns a bigger multiplier, and the per-item ladder in Rate
 * Config is right.
 *
 * ── WHAT BREAKS AT SCALE ───────────────────────────────────────────────────────────────────────
 *
 * The ladder keys off UNIT price, which quietly assumes a cheap item is a small line. Quantity
 * breaks that assumption. A thousand feet of wire at $0.30 is $300 of cost marked up FIVE TIMES,
 * because each foot is under a dollar. On a remodel, bulk cheap material IS the material budget.
 *
 * Measured across every estimate issued to 2026-08-21: 91% of material cost sat in the 2.5x, 3.5x
 * and 5x bands, and the blended result was 3.39x. One estimate reached 4.53x.
 *
 * ── THE CHECK ──────────────────────────────────────────────────────────────────────────────────
 *
 * The same multipliers Kyle already uses, read against the material cost of the JOB rather than
 * the price of one item. If the per-item tiers produce a blended markup above the ceiling for that
 * band, every material line is scaled down proportionally until it meets the ceiling.
 *
 * Three properties this must always have:
 *
 *   1. IT ONLY EVER CAPS. It cannot raise a price. A job priced under its ceiling is untouched,
 *      which is most small work — four of Kyle's six real estimates do not move at all.
 *   2. IT NEVER TOUCHES LABOUR. His hourly rate is his hourly rate.
 *   3. IT IS VISIBLE. What it did is recorded and printed on the company copy. A silent haircut on
 *      a number he quotes to customers is worse than no check at all.
 *
 * ── AND WHY PER OPTION ─────────────────────────────────────────────────────────────────────────
 *
 * Each option is separately purchasable, so each is priced as its own job. Applying one ceiling
 * across the whole estimate would mean Option A's price depended on how much material sat in
 * Option B — so unticking B on the presentation screen would silently re-price A while a customer
 * watched. For a single-scope job the two are identical.
 */

/** One band of the job-level ceiling. `upTo` is exclusive; the last band is open-ended. */
export interface MarkupBand {
  upTo: number | null;
  ceiling: number;
  label: string;
}

/**
 * Kyle's ladder, re-scaled from "price of one item" to "material cost of one job" (2026-08-21).
 *
 * The MULTIPLIERS are his existing ones and are not invented here. The THRESHOLDS are new, because
 * his per-item thresholds cannot be reused directly: $200 is a lot for a single item and nothing
 * for a job's material. Fed his own thresholds, this check fired on all six of his real estimates
 * and cut $1,795 — including $458 off a $1,353 service call. Re-scaled, it fires on two and cuts
 * $473, and both of those were genuinely out of line.
 *
 * The top two bands are tighter than the per-item ladder at Kyle's instruction: "I will take your
 * recommendation but want to add in the tighter on big work." Above $1,000 of material he is
 * bidding against other shops, and on that class of job labour is where the money is.
 *
 * TODO: this belongs in Rate Config next to the per-item tiers, so he can change it without a
 * deploy. It is here for now so the check exists; moving it is a follow-up, not a redesign.
 */
export const JOB_MATERIAL_BANDS: MarkupBand[] = [
  { upTo: 250, ceiling: 3.5, label: "under $250" },
  { upTo: 1000, ceiling: 2.5, label: "$250–999" },
  { upTo: 3000, ceiling: 1.5, label: "$1,000–2,999" },
  { upTo: null, ceiling: 1.25, label: "$3,000+" },
];

export function bandFor(materialCost: number): MarkupBand {
  return (
    JOB_MATERIAL_BANDS.find((b) => b.upTo === null || materialCost < b.upTo) ??
    JOB_MATERIAL_BANDS[JOB_MATERIAL_BANDS.length - 1]
  );
}

/** What the check did to one option, so the company copy can show its working. */
export interface MaterialCapResult {
  materialCost: number;
  /** What the per-item tiers produced, before this check. */
  uncappedSell: number;
  blended: number;
  ceiling: number;
  bandLabel: string;
  /** What it is charged at after the check. Equal to uncappedSell when nothing was capped. */
  cappedSell: number;
  /** uncappedSell − cappedSell. Zero when the ceiling was not reached. */
  reduction: number;
  applied: boolean;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Decide the ceiling for one option's material and report what it means.
 *
 * Returns `applied: false` and an unchanged sell when there is nothing to do — no material, no
 * cost recorded, or a blended markup already under the ceiling.
 */
export function capMaterial(materialCost: number, materialSell: number): MaterialCapResult {
  const band = bandFor(materialCost);
  const base: MaterialCapResult = {
    materialCost: round2(materialCost),
    uncappedSell: round2(materialSell),
    blended: materialCost > 0 ? materialSell / materialCost : 0,
    ceiling: band.ceiling,
    bandLabel: band.label,
    cappedSell: round2(materialSell),
    reduction: 0,
    applied: false,
  };

  /*
    No recorded cost means no basis for a ceiling, and inventing one would be inventing a number.
    This is not the same as free material: a line whose cost the engine could not determine already
    reports itself as incomplete, and that is the signal Kyle acts on — not a silent markdown here.
  */
  if (materialCost <= 0 || materialSell <= 0) return base;

  const ceilingSell = round2(materialCost * band.ceiling);
  if (materialSell <= ceilingSell) return base;

  return {
    ...base,
    cappedSell: ceilingSell,
    reduction: round2(materialSell - ceilingSell),
    applied: true,
  };
}
