/**
 * Kyle's billed labour rate — the ONE number every labour dollar in the app derives from.
 *
 *   2026-08-11  $150/hr  (decisions/2026-08-11-billed-rate-and-no-memberships.md)
 *   2026-09-01  $100/hr  Kyle: "I want to drop the labor rate to $100 an hour. This is a
 *                        better market rate for this area and I want to commit to it now."
 *
 * Where it is read:
 *   - Rate Config `billedLaborRate` (PriceBookRateConfig) is the LIVE value the estimate
 *     engine bills supplier-priced labour at and uses to split a flat-priced row into its
 *     internal labour + material halves.
 *   - The price book's sell columns are built from it: sell_d = hours_d × rate + material
 *     (priceBookCatalog.computePricing). A rate change therefore recomputes every flat row
 *     — scripts/setLaborRate.ts does that, audited, together with the Rate Config cell.
 *   - RULED_BILLED_RATE is the ruling the live value is checked against: when Rate Config
 *     disagrees, estimates are marked PROVISIONAL and say so, and nothing overrides the cell.
 */

import type { PrismaClient } from "@prisma/client";

export const RULED_BILLED_RATE = 100;

/**
 * The live billed rate for building book prices. Rate Config first; the ruling only when the
 * cell is blank (a blank cell is a missing number, and the ruling is the one number Kyle set).
 */
export async function loadBilledLaborRate(prisma: PrismaClient): Promise<number> {
  const row = await prisma.priceBookRateConfig.findUnique({ where: { key: "billedLaborRate" } });
  const value = row?.numberValue;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : RULED_BILLED_RATE;
}
