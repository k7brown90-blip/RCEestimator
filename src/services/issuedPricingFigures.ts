/**
 * The customer-visible FIGURES of an ISSUED estimate, as the shared pure pricer wants them
 * (2026-10-08, one-estimating-system plan, Phase 3; review finding on the reuse path).
 *
 * An issued estimate is a frozen document: its options' subtotals, its trip charge, the schedule of
 * material bands it was issued under (`jobBandsJson`) and its discount programme. The customer page
 * (issuedEstimateRender) prices every combination from exactly these, and since the review the
 * quote payloads do too whenever the screen is going to USE that estimate as it stands - "Show the
 * customer" / "Sign now" on a draft that is issued and unchanged. Before this, those screens priced
 * from a LIVE recompute (today's catalog, today's Rate Config, today's bands), so a price change
 * between issue and signing could leave the phone showing one total and the signature recording
 * another. One function builds the figures for both readers so they cannot disagree.
 *
 * Customer prices only: the material costs feed the combined-options band lookup on the server and
 * never leave it.
 */

import type { PricingFigures } from "../../shared/quoteMoney";
import { programmeFor } from "./discounts";
import { allSelectionCaps, type MarkupBand, type MaterialCapResult } from "./materialMarkupCap";

export interface IssuedFiguresSource {
  tripCharge: number;
  jobBandsJson: string | null;
  discountType: string | null;
  discountPercent: number | null;
  options: ReadonlyArray<{ option: string; subtotal: number }>;
  lines: ReadonlyArray<{
    option: string;
    materialCost: number | null;
    materialSell: number | null;
    inMaterialCap: boolean;
  }>;
}

export function pricingFiguresFromIssued(est: IssuedFiguresSource): {
  figures: PricingFigures;
  /** The engine's own combination key set and savings, for the page that lists exactly those keys. */
  caps: Record<string, MaterialCapResult>;
} {
  /*
    Priced with the schedule frozen at issue (jobBandsJson), not whatever Rate Config holds now.
    Continuous-length material only (Kyle, 2026-08-31, "split the difference") - unit items keep
    their book price; the frozen flag keeps this on the issue's population.
  */
  const frozenBands = est.jobBandsJson ? (JSON.parse(est.jobBandsJson) as MarkupBand[]) : undefined;
  const caps = allSelectionCaps(
    est.lines.map((l) => ({
      option: l.option,
      materialCost: l.inMaterialCap ? l.materialCost : null,
      materialSell: l.inMaterialCap ? l.materialSell : null,
    })),
    frozenBands,
  );
  const programme = programmeFor(est.discountType, est.discountPercent);
  const figures: PricingFigures = {
    options: est.options.map((o) => ({ option: o.option, subtotal: o.subtotal })),
    tripCharge: est.tripCharge,
    comboSavings: Object.fromEntries(Object.entries(caps).map(([key, cap]) => [key, cap.reduction])),
    programme: programme ? { rate: programme.rate, cap: programme.cap } : null,
  };
  return { figures, caps };
}
