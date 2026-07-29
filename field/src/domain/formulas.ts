import type { FormulaId } from './types'

/**
 * Values the app derives so the technician doesn't do arithmetic on a ladder.
 *
 * Every function here is pure and total — no NaN, no Infinity, no division by
 * zero. A field readout showing "NaN" is worse than showing nothing, because it
 * looks like a measurement.
 */

const round1 = (value: number) => Math.round(value * 10) / 10

/**
 * Neutral current on a single-phase 3-wire 120/240 V service.
 *
 * The neutral carries the imbalance between the two legs, so |L1 − L2|. This is
 * a CALCULATION, not a reading: it holds for linear loads, but nonlinear
 * (electronic) loads add harmonic content the subtraction can't see. A clamp on
 * the neutral is the ground truth — the report says so.
 */
export function neutralCurrent(legA: number, legB: number): number {
  if (!Number.isFinite(legA) || !Number.isFinite(legB)) return 0
  return round1(Math.abs(legA - legB))
}

/** Imbalance as a percentage of the larger leg. Zero when nothing is drawing. */
export function legImbalancePct(legA: number, legB: number): number {
  if (!Number.isFinite(legA) || !Number.isFinite(legB)) return 0
  const larger = Math.max(Math.abs(legA), Math.abs(legB))
  if (larger === 0) return 0
  return Math.round((Math.abs(legA - legB) / larger) * 100)
}

/**
 * Voltage drop from the service/main termination to a branch breaker.
 *
 * The reference is the L–N reading taken at the service, which is the control
 * for that property — a house delivered 122 V simply has a 122 V baseline. What
 * matters is the variance from it, not the absolute number.
 */
export function branchDropDelta(referenceVolts: number, measuredVolts: number): number {
  if (!Number.isFinite(referenceVolts) || !Number.isFinite(measuredVolts)) return 0
  return round1(referenceVolts - measuredVolts)
}

/** Equipment age in years. Never negative, even with a typo'd install year. */
export function ageFromInstallYear(installYear: number, currentYear = new Date().getFullYear()): number {
  if (!Number.isFinite(installYear) || installYear <= 0) return 0
  return Math.max(0, currentYear - Math.round(installYear))
}

const FORMULA_INPUTS: Record<FormulaId, string[]> = {
  neutral_current: ['legA', 'legB'],
  leg_imbalance_pct: ['legA', 'legB'],
  branch_drop_delta: ['reference', 'measured'],
  age_from_install_year: ['installYear'],
}

/** Positional inputs each formula expects, in order. */
export function formulaInputNames(id: FormulaId): string[] {
  return FORMULA_INPUTS[id] ?? []
}

export function applyFormula(id: FormulaId, inputs: Record<string, number>): number {
  switch (id) {
    case 'neutral_current':
      return neutralCurrent(inputs.legA, inputs.legB)
    case 'leg_imbalance_pct':
      return legImbalancePct(inputs.legA, inputs.legB)
    case 'branch_drop_delta':
      return branchDropDelta(inputs.reference, inputs.measured)
    case 'age_from_install_year':
      return ageFromInstallYear(inputs.installYear)
    default:
      return 0
  }
}
