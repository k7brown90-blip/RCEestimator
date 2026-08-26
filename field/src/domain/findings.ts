import { bannerListedItemIds, conditionalBannerItems } from '../data/criticalItems'
import type { ChecklistItemDef, Inspection, ItemResult, ResultState } from './types'

/**
 * What the report leads with, in place of a 0-100 score.
 *
 * The score was retired because a number invites "why isn't it 100?" instead of
 * "what needs fixing?" — and because a weighted average lets a serious finding
 * hide behind twenty passes. What survives from the old scoring engine is the
 * part that actually gated anything: the critical-finding banner and the
 * contractor review it requires.
 */

export interface FindingsConfig {
  bannerItemIds: readonly string[]
  conditionalBannerItems: Record<string, { gradedState: string }>
}

const defaultConfig: FindingsConfig = {
  bannerItemIds: bannerListedItemIds,
  conditionalBannerItems,
}

export interface FindingsSummary {
  itemsAssessed: number
  failCount: number
  monitorCount: number
  passCount: number
  belowStandardCount: number
  naCount: number
  /** Visible items the technician never opened — distinct from N/A. */
  notAssessedCount: number
  criticalFindings: string[]
}

/**
 * A finding is critical when a banner-listed item FAILs. Graded items only
 * banner at their listed grade — a moderate D1 is a real finding but not a
 * stop-work.
 */
export function isCriticalFinding(item: ItemResult, config: FindingsConfig = defaultConfig): boolean {
  if (item.result !== 'FAIL') return false

  // Sub-panel instances carry ids like `SUB:garage`; they banner exactly as
  // their base item does.
  const baseId = item.itemId.split(':')[0]

  const conditional = config.conditionalBannerItems[baseId]
  if (conditional) return item.gradedState === conditional.gradedState

  return config.bannerItemIds.includes(baseId)
}

export function summarizeFindings(
  inspection: Inspection,
  visibleItems: ChecklistItemDef[] = [],
  config: FindingsConfig = defaultConfig,
): FindingsSummary {
  const counts: Record<ResultState, number> = {
    PASS: 0, MONITOR: 0, FAIL: 0, BELOW_STANDARD: 0, NA: 0,
  }
  const criticalFindings: string[] = []

  for (const item of inspection.items) {
    counts[item.result] = (counts[item.result] ?? 0) + 1
    if (isCriticalFinding(item, config)) criticalFindings.push(item.itemId)
  }

  const assessedIds = new Set(inspection.items.map((item) => item.itemId))
  const notAssessedCount = visibleItems.filter((def) => !assessedIds.has(def.id)).length

  return {
    // N/A items were assessed — the technician looked and recorded that the item
    // doesn't apply here. Only genuinely untouched items are "not assessed".
    itemsAssessed: inspection.items.length,
    failCount: counts.FAIL,
    monitorCount: counts.MONITOR,
    passCount: counts.PASS,
    belowStandardCount: counts.BELOW_STANDARD,
    naCount: counts.NA,
    notAssessedCount,
    criticalFindings,
  }
}

export const emptySummary = (): FindingsSummary => ({
  itemsAssessed: 0,
  failCount: 0,
  monitorCount: 0,
  passCount: 0,
  belowStandardCount: 0,
  naCount: 0,
  notAssessedCount: 0,
  criticalFindings: [],
})
