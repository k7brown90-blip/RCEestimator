import { describe, expect, it } from 'vitest'
import {
  evaluateThreshold,
  isFieldRequired,
  missingRequiredCells,
  missingRequiredFields,
  requiresOverrideReason,
  suggestedVerdict,
} from './fieldValidation'
import type { InputFieldDef, MeasuredRow } from './types'

const ohms: InputFieldDef = {
  id: 'ground_ohms',
  label: 'Resistance to earth',
  type: 'number',
  unit: 'Ω',
  required: true,
  thresholds: [
    { when: { gt: 25 }, verdict: 'FAIL', message: 'Above the 25 Ω limit — 250.53(A)(2).' },
    { when: { lte: 25 }, verdict: 'PASS' },
  ],
}

const rodCount: InputFieldDef = {
  id: 'rod_count',
  label: 'Rod count',
  type: 'number',
  requiredWhen: { fieldId: 'electrode_types', includes: 'rod' },
}

const electrodes: InputFieldDef = {
  id: 'electrode_types',
  label: 'Electrodes present',
  type: 'multiselect',
  required: true,
  options: [
    { value: 'rod', label: 'Driven rod(s)' },
    { value: 'ufer', label: 'Ufer' },
  ],
}

describe('isFieldRequired', () => {
  it('honours a plain required flag', () => {
    expect(isFieldRequired(ohms, {})).toBe(true)
  })

  it('is not required when its trigger is absent', () => {
    // Don't ask for rod count on a house with no rods.
    expect(isFieldRequired(rodCount, { electrode_types: ['ufer'] })).toBe(false)
    expect(isFieldRequired(rodCount, {})).toBe(false)
  })

  it('becomes required once its trigger is selected', () => {
    expect(isFieldRequired(rodCount, { electrode_types: ['ufer', 'rod'] })).toBe(true)
  })

  it('supports an equals trigger as well as includes', () => {
    const field: InputFieldDef = {
      id: 'egc_to_neutral', label: 'EGC bond', type: 'text',
      requiredWhen: { fieldId: 'bus_config', equals: 'separated' },
    }
    expect(isFieldRequired(field, { bus_config: 'separated' })).toBe(true)
    expect(isFieldRequired(field, { bus_config: 'shared' })).toBe(false)
  })
})

describe('missingRequiredFields', () => {
  it('lists required fields left blank', () => {
    expect(missingRequiredFields([ohms, electrodes], {})).toEqual(['ground_ohms', 'electrode_types'])
  })

  it('accepts a zero reading as a real value', () => {
    // 0 Ω is a measurement, not an empty box.
    expect(missingRequiredFields([ohms], { ground_ohms: 0 })).toEqual([])
  })

  it('treats whitespace as blank', () => {
    expect(missingRequiredFields([electrodes], { electrode_types: '   ' })).toEqual(['electrode_types'])
  })

  it('treats an empty multiselect as blank', () => {
    expect(missingRequiredFields([electrodes], { electrode_types: [] })).toEqual(['electrode_types'])
  })

  it('never demands a computed field — it is derived, not entered', () => {
    const computed: InputFieldDef = {
      id: 'neutral_amps', label: 'Neutral', type: 'computed',
      formula: 'neutral_current', required: true,
    }
    expect(missingRequiredFields([computed], {})).toEqual([])
  })

  it('respects a conditional requirement', () => {
    expect(missingRequiredFields([rodCount], { electrode_types: ['rod'] })).toEqual(['rod_count'])
    expect(missingRequiredFields([rodCount], { electrode_types: ['ufer'] })).toEqual([])
  })
})

describe('missingRequiredCells', () => {
  const table: InputFieldDef = {
    id: 'branch_rows',
    label: 'Branch circuits',
    type: 'table',
    columns: [
      { id: 'circuit_no', label: 'Ckt', type: 'text', required: true },
      { id: 'measured_v', label: 'V', type: 'number', required: true },
      { id: 'description', label: 'Desc', type: 'text' },
      { id: 'delta_v', label: 'Δ', type: 'computed', formula: 'branch_drop_delta', required: true },
    ],
  }

  it('finds rows missing a required cell', () => {
    const rows: MeasuredRow[] = [
      { circuit_no: '14', measured_v: 118 },
      { circuit_no: '15' }, // no reading
      { measured_v: 119 },  // no circuit number
    ]
    expect(missingRequiredCells(table, rows)).toEqual([1, 2])
  })

  it('ignores optional and computed columns', () => {
    expect(missingRequiredCells(table, [{ circuit_no: '14', measured_v: 118 }])).toEqual([])
  })

  it('returns nothing for a field that is not a table', () => {
    expect(missingRequiredCells(ohms, [])).toEqual([])
  })
})

describe('evaluateThreshold', () => {
  it('picks the first matching rule', () => {
    expect(evaluateThreshold(ohms, 32)?.verdict).toBe('FAIL')
    expect(evaluateThreshold(ohms, 18)?.verdict).toBe('PASS')
  })

  it('treats the boundary as within the limit', () => {
    // 250.53(A)(2) allows a single rod at 25 Ω or less.
    expect(evaluateThreshold(ohms, 25)?.verdict).toBe('PASS')
    expect(evaluateThreshold(ohms, 25.1)?.verdict).toBe('FAIL')
  })

  it('says nothing about a field with no reading yet', () => {
    expect(evaluateThreshold(ohms, undefined)).toBeNull()
    expect(evaluateThreshold(ohms, '')).toBeNull()
  })

  it('coerces a numeric string, since inputs arrive as text', () => {
    expect(evaluateThreshold(ohms, '32')?.verdict).toBe('FAIL')
  })

  it('matches an eq rule on a select value', () => {
    const field: InputFieldDef = {
      id: 'gec_conn', label: 'Connection', type: 'select',
      options: [{ value: 'soldered', label: 'Soldered' }],
      thresholds: [{ when: { eq: 'soldered' }, verdict: 'FAIL', message: '250.70 prohibits solder.' }],
    }
    expect(evaluateThreshold(field, 'soldered')?.verdict).toBe('FAIL')
    expect(evaluateThreshold(field, 'listed_clamp')).toBeNull()
  })
})

describe('suggestedVerdict', () => {
  it('takes the worst verdict across all fields', () => {
    const suggestion = suggestedVerdict([ohms], { ground_ohms: 40 })
    expect(suggestion?.verdict).toBe('FAIL')
    expect(suggestion?.reasons[0]).toContain('250.53(A)(2)')
  })

  it('is null when no threshold has anything to say', () => {
    expect(suggestedVerdict([electrodes], { electrode_types: ['rod'] })).toBeNull()
  })

  it('does not let a passing field mask a failing one', () => {
    const other: InputFieldDef = {
      id: 'other', label: 'Other', type: 'number',
      thresholds: [{ when: { lt: 100 }, verdict: 'PASS' }],
    }
    expect(suggestedVerdict([other, ohms], { other: 1, ground_ohms: 40 })?.verdict).toBe('FAIL')
  })
})

describe('requiresOverrideReason', () => {
  it('demands a reason for talking a verdict down', () => {
    expect(requiresOverrideReason('FAIL', 'PASS')).toBe(true)
    expect(requiresOverrideReason('FAIL', 'MONITOR')).toBe(true)
    expect(requiresOverrideReason('MONITOR', 'PASS')).toBe(true)
  })

  it('lets an electrician escalate freely', () => {
    // Seeing something the numbers don't should never need paperwork.
    expect(requiresOverrideReason('PASS', 'FAIL')).toBe(false)
    expect(requiresOverrideReason('MONITOR', 'FAIL')).toBe(false)
  })

  it('asks for nothing when the verdict matches the suggestion', () => {
    expect(requiresOverrideReason('FAIL', 'FAIL')).toBe(false)
  })

  it('asks for nothing when there is no suggestion', () => {
    expect(requiresOverrideReason(undefined, 'PASS')).toBe(false)
  })

  it('exempts N/A — the item did not apply, so the readings are moot', () => {
    expect(requiresOverrideReason('FAIL', 'NA')).toBe(false)
  })
})
