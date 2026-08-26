import type { GradedState } from '../domain/types'

/**
 * Items whose failure forces the red banner and blocks delivery until a licensed
 * contractor has reviewed the report.
 *
 * Maintained as an EXPLICIT list rather than derived from a severity number, so
 * that tuning a weight can never silently drop a life-safety item out of the
 * banner.
 *
 * 2026-08-26 consolidation: the old per-check ids (A3, C1, C4, C5, C6, D2, D3,
 * E1, H1) folded into these rows. Sub-panel instances (`SUB:<slug>`) inherit
 * SUB's listing — isCriticalFinding normalizes the instance id to its base.
 */
export const bannerListedItemIds: readonly string[] = [
  'METER', // supply-side damage — nothing upstream of it can clear a fault
  'MAIN', // hazard panel / defeated overcurrent protection / overheating lugs
  'SUB', // neutral-ground bond error, hazard panel — instances included
  'GES', // the fault-clearing backbone: bonding, GEC, EGC, ISBT
  'WIRE', // dead GFCI in a wet area, no working smoke/CO alarms
]

/**
 * Items that only banner at a particular grade. Empty since the 2026-08-26
 * consolidation (the old D1-severe rule rode along into MAIN, which banners on
 * any FAIL) — kept so the mechanism survives for a future graded item.
 */
export const conditionalBannerItems: Record<string, { gradedState: GradedState }> = {}
