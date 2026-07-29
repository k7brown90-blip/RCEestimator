import type { GradedState } from '../domain/types'

/**
 * Items whose failure forces the red banner and blocks delivery until a licensed
 * contractor has reviewed the report.
 *
 * Maintained as an EXPLICIT list rather than derived from a severity number, so
 * that tuning a weight can never silently drop a life-safety item out of the
 * banner. (The S×L×C weight table this used to sit alongside is gone — it existed
 * only to produce the 0-100 score, which was retired. The banner concept and the
 * contractor-review gate are the parts worth keeping.)
 */
export const bannerListedItemIds: readonly string[] = [
  'C1', // grounding electrode system — absorbed the old C2 (rod resistance) and C3 (GEC)
  'C4', // MBJ / EGC-bar bonding error
  'C5', // neutral-ground bond error at a subpanel
  'C6', // water/gas pipe bonding
  'D2', // oversized breaker / defeated overcurrent protection
  'D3', // hazard or delisted panel
  'H1', // no working smoke/CO alarms
  'E1', // GFCI absent in a required wet location
  'A3', // supply-side damage
]

/**
 * Items that only banner at a particular grade. D1 (connection integrity) fails
 * at three severities; only a severe thermal/torque finding is a stop-work.
 */
export const conditionalBannerItems: Record<string, { gradedState: GradedState }> = {
  D1: { gradedState: 'severe' },
}
