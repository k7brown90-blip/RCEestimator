import { describe, expect, it } from 'vitest'
import {
  ageFromInstallYear,
  applyFormula,
  branchDropDelta,
  legImbalancePct,
  neutralCurrent,
} from './formulas'

describe('neutralCurrent', () => {
  it('is the imbalance between the two legs', () => {
    // Single-phase 3-wire: the neutral only carries what the legs don't cancel.
    expect(neutralCurrent(48, 62)).toBe(14)
    expect(neutralCurrent(62, 48)).toBe(14)
  })

  it('is zero on a perfectly balanced panel', () => {
    expect(neutralCurrent(55, 55)).toBe(0)
  })

  it('is zero, not NaN, when nothing is drawing', () => {
    // A readout showing NaN looks like a measurement. It must not happen.
    expect(neutralCurrent(0, 0)).toBe(0)
  })

  it('degrades to zero rather than propagating a bad reading', () => {
    expect(neutralCurrent(NaN, 40)).toBe(0)
    expect(neutralCurrent(40, Infinity)).toBe(0)
  })

  it('rounds to a tenth of an amp', () => {
    expect(neutralCurrent(48.26, 62.0)).toBe(13.7)
  })
})

describe('legImbalancePct', () => {
  it('expresses the imbalance against the larger leg', () => {
    expect(legImbalancePct(48, 62)).toBe(23) // 14/62
  })

  it('is 0 for a balanced panel', () => {
    expect(legImbalancePct(50, 50)).toBe(0)
  })

  it('is 0, not NaN, when both legs read zero', () => {
    expect(legImbalancePct(0, 0)).toBe(0)
  })

  it('is 100 when one leg carries everything', () => {
    expect(legImbalancePct(0, 40)).toBe(100)
  })
})

describe('branchDropDelta', () => {
  it('is the fall from the service control to the reading at the breaker', () => {
    expect(branchDropDelta(120, 118)).toBe(2)
  })

  it('is zero when the branch matches the control', () => {
    expect(branchDropDelta(122, 122)).toBe(0)
  })

  it('goes negative when the branch reads higher than the control', () => {
    // Not physical on a healthy circuit — usually a meter or timing artefact,
    // and the technician should see it rather than have it hidden at zero.
    expect(branchDropDelta(120, 121)).toBe(-1)
  })

  it('rounds to a tenth of a volt', () => {
    expect(branchDropDelta(121.4, 118.9)).toBe(2.5)
  })
})

describe('ageFromInstallYear', () => {
  it('counts years from install to now', () => {
    expect(ageFromInstallYear(2020, 2026)).toBe(6)
  })

  it('never reports a negative age from a future year', () => {
    expect(ageFromInstallYear(2030, 2026)).toBe(0)
  })

  it('returns 0 for a missing or nonsense year', () => {
    expect(ageFromInstallYear(0, 2026)).toBe(0)
    expect(ageFromInstallYear(NaN, 2026)).toBe(0)
  })
})

describe('applyFormula', () => {
  it('dispatches to each formula by id', () => {
    expect(applyFormula('neutral_current', { legA: 48, legB: 62 })).toBe(14)
    expect(applyFormula('leg_imbalance_pct', { legA: 48, legB: 62 })).toBe(23)
    expect(applyFormula('branch_drop_delta', { reference: 120, measured: 118.5 })).toBe(1.5)
  })

  it('returns 0 for missing inputs rather than throwing mid-inspection', () => {
    expect(applyFormula('neutral_current', {})).toBe(0)
  })
})
