import { bannerListedItemIds, weights, type WeightTableEntry } from '../data/weights'
import type { Inspection, ItemResult, ResultState } from './types'

export interface ScoringConfig {
  weights: readonly WeightTableEntry[]
  bannerItemIds: readonly string[]
}

const defaultConfig: ScoringConfig = {
  weights,
  bannerItemIds: bannerListedItemIds,
}

export interface ScoreResult {
  score: number
  itemsAssessed: number
  criticalFindings: string[]
  deductions: number
  maxWeight: number
}

// Weight is pure data selection — the engine never computes S×L×C itself
// (hard requirement: weights are tunable in weights.ts without touching the engine).
function getWeight(item: ItemResult, table: readonly WeightTableEntry[]): number {
  const entries = table.filter((entry) => entry.itemId === item.itemId)
  if (entries.length === 0) {
    return 0
  }

  if (item.gradedState) {
    const match = entries.find((entry) => entry.gradedState === item.gradedState)
    if (match) {
      return match.W
    }
  }

  // No graded state selected (e.g. PASS on a graded item): the item's contribution
  // to "max possible weight" is its worst-case potential — the highest grade.
  return Math.max(...entries.map((entry) => entry.W))
}

// Banner triggers off the explicit named list (Scoring Design §3 Step 4), never off
// the severity integer. D1 banners only at its 'severe' grade.
function isCriticalFinding(item: ItemResult, bannerItemIds: readonly string[]): boolean {
  if (item.result !== 'ACTION') {
    return false
  }
  if (item.itemId === 'D1') {
    return item.gradedState === 'severe'
  }
  return bannerItemIds.includes(item.itemId)
}

function getMultiplier(result: ResultState): number {
  switch (result) {
    case 'PASS':
      return 0
    case 'MONITOR':
      return 0.35
    case 'ACTION':
      return 1
    case 'BELOW_STANDARD':
      return 0.15
    case 'NA':
      return 0
    default:
      return 0
  }
}

export function scoreInspection(
  inspection: Inspection,
  config: ScoringConfig = defaultConfig,
): ScoreResult {
  // NA items are excluded from BOTH numerator and denominator.
  const applicable = inspection.items.filter((item) => item.result !== 'NA')
  let deductions = 0
  let maxWeight = 0
  const criticalFindings: string[] = []

  for (const item of applicable) {
    const weight = getWeight(item, config.weights)
    maxWeight += weight
    deductions += getMultiplier(item.result) * weight

    if (isCriticalFinding(item, config.bannerItemIds)) {
      criticalFindings.push(item.itemId)
    }
  }

  const rawScore = maxWeight > 0 ? 100 * (1 - deductions / maxWeight) : 100
  const score = Math.round(rawScore)
  // Cap at ≤69, does NOT stack lower with multiple criticals; each critical is listed.
  const cappedScore = criticalFindings.length > 0 ? Math.min(score, 69) : score

  return {
    score: cappedScore,
    itemsAssessed: applicable.length,
    criticalFindings,
    deductions,
    maxWeight,
  }
}
