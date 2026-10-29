/**
 * Kyle's billed labour rate — the ONE number every labour dollar in the app derives from.
 *
 *   2026-08-11  $150/hr  (decisions/2026-08-11-billed-rate-and-no-memberships.md)
 *   2026-09-01  $100/hr  Kyle: "I want to drop the labor rate to $100 an hour. This is a
 *                        better market rate for this area and I want to commit to it now."
 *   2026-10-27  Kyle: "I want to be able to edit the chosen hourly rate in the app. This way we do
 *                      not need to code everytime we need to update." It stays $100 until he
 *                      changes it on Settings -> Billed labor rate.
 *
 * Where it is read:
 *   - Rate Config `billedLaborRate` (PriceBookRateConfig) is the LIVE value the estimate
 *     engine bills supplier-priced labour at and uses to split a flat-priced row into its
 *     internal labour + material halves.
 *   - The price book's sell columns are built from it: sell_d = hours_d × rate + material
 *     (priceBookCatalog.computePricing). A rate change therefore recomputes every priced row
 *     — services/billedRateChange.ts does that, audited, together with the Rate Config cell;
 *     the Settings screen and scripts/setLaborRate.ts both call it.
 *
 * The rate Kyle saves IS the ruling. There is no second number in code to compare it against, so
 * a rate other than $100 is never "provisional". Only a BLANK cell is (atomicEstimateService
 * loadRateContext): a missing number blocks the customer price until it is set.
 */

import type { PrismaClient } from "@prisma/client";

/**
 * Used ONLY when the Rate Config cell is blank, so the price-book editor can still price a new row
 * rather than fail. It is not a ruling and nothing compares the cell to it: estimates built while
 * the cell is blank are still marked PROVISIONAL / blocked by loadRateContext, whatever this says.
 */
export const BLANK_CELL_FALLBACK_RATE = 100;

/**
 * The live billed rate for building book prices. Rate Config first; the fallback only when the
 * cell is blank.
 */
export async function loadBilledLaborRate(prisma: PrismaClient): Promise<number> {
  const row = await prisma.priceBookRateConfig.findUnique({ where: { key: "billedLaborRate" } });
  const value = row?.numberValue;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : BLANK_CELL_FALLBACK_RATE;
}
