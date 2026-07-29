import { describe, expect, it } from 'vitest'
import { mergeLegacyGroundingItems, normalizeResultState, worstResult } from './compat'
import { itemResultSchema } from './schemas'
import type { ItemResult } from './types'

function item(partial: Partial<ItemResult> & { itemId: string }): ItemResult {
  return { result: 'PASS', measured: {}, photoIds: [], ...partial }
}

describe('normalizeResultState', () => {
  it('renames the retired ACTION state to FAIL', () => {
    expect(normalizeResultState('ACTION')).toBe('FAIL')
  })

  it('leaves current states alone', () => {
    for (const state of ['PASS', 'MONITOR', 'FAIL', 'BELOW_STANDARD', 'NA']) {
      expect(normalizeResultState(state)).toBe(state)
    }
  })

  it('passes non-strings straight through for zod to reject', () => {
    expect(normalizeResultState(undefined)).toBeUndefined()
    expect(normalizeResultState(42)).toBe(42)
  })
})

describe('itemResultSchema compatibility', () => {
  it('parses a record stored before the rename', () => {
    const parsed = itemResultSchema.parse({
      itemId: 'C4', result: 'ACTION', measured: {}, photoIds: [],
    })
    expect(parsed.result).toBe('FAIL')
  })

  it('still rejects a state that never existed', () => {
    expect(itemResultSchema.safeParse({
      itemId: 'C4', result: 'CATASTROPHE', measured: {}, photoIds: [],
    }).success).toBe(false)
  })
})

describe('worstResult', () => {
  it('ranks FAIL above everything', () => {
    expect(worstResult(['PASS', 'NA', 'MONITOR', 'BELOW_STANDARD', 'FAIL'])).toBe('FAIL')
  })

  it('ranks MONITOR above BELOW_STANDARD', () => {
    // Below-standard is code-compliant; monitor means something is degrading.
    expect(worstResult(['BELOW_STANDARD', 'MONITOR'])).toBe('MONITOR')
  })

  it('returns NA for an empty group', () => {
    expect(worstResult([])).toBe('NA')
  })
})

describe('mergeLegacyGroundingItems', () => {
  const retired = new Set(['C1', 'C4']) // C2/C3 no longer live

  it('leaves records untouched while C2 and C3 are still live checks', () => {
    // Merging too early would destroy a reading the technician just took.
    const live = new Set(['C1', 'C2', 'C3', 'C4'])
    const items = [item({ itemId: 'C2', measured: { ground_ohms: 18 } }), item({ itemId: 'C3' })]
    expect(mergeLegacyGroundingItems(items, live)).toEqual(items)
  })

  it('folds retired C2 and C3 into C1', () => {
    const merged = mergeLegacyGroundingItems([
      item({ itemId: 'C1', measured: { electrode_types: 'rod' } }),
      item({ itemId: 'C2', measured: { ground_ohms: 18 } }),
      item({ itemId: 'C3', measured: { gec_size: '#6 Cu' } }),
    ], retired)

    expect(merged.map((i) => i.itemId)).toEqual(['C1'])
    expect(merged[0].measured).toEqual({
      electrode_types: 'rod', ground_ohms: 18, gec_size: '#6 Cu',
    })
  })

  it('takes the worst result of the group', () => {
    // A failing GEC must not be softened by a passing electrode check.
    const merged = mergeLegacyGroundingItems([
      item({ itemId: 'C1', result: 'PASS' }),
      item({ itemId: 'C2', result: 'MONITOR' }),
      item({ itemId: 'C3', result: 'FAIL' }),
    ], retired)

    expect(merged[0].result).toBe('FAIL')
  })

  it('keeps every photo from every folded item', () => {
    const merged = mergeLegacyGroundingItems([
      item({ itemId: 'C1', photoIds: ['a'] }),
      item({ itemId: 'C2', photoIds: ['b', 'c'] }),
      item({ itemId: 'C3', photoIds: ['c'] }),
    ], retired)

    expect(merged[0].photoIds.sort()).toEqual(['a', 'b', 'c'])
  })

  it('joins notes and resolutions rather than dropping all but one', () => {
    const merged = mergeLegacyGroundingItems([
      item({ itemId: 'C2', result: 'FAIL', note: 'clamp corroded', resolutionNote: 'replace clamp' }),
      item({ itemId: 'C3', result: 'FAIL', note: 'GEC undersized', resolutionNote: 'pull #4 Cu' }),
    ], retired)

    expect(merged[0].note).toBe('clamp corroded · GEC undersized')
    expect(merged[0].resolutionNote).toBe('replace clamp · pull #4 Cu')
  })

  it('merges a retired item even when no C1 was recorded', () => {
    const merged = mergeLegacyGroundingItems([item({ itemId: 'C2', result: 'FAIL' })], retired)
    expect(merged.map((i) => i.itemId)).toEqual(['C1'])
    expect(merged[0].result).toBe('FAIL')
  })

  it('does not disturb items outside the grounding group', () => {
    const merged = mergeLegacyGroundingItems([
      item({ itemId: 'A1' }),
      item({ itemId: 'C2', result: 'MONITOR' }),
      item({ itemId: 'H1', result: 'FAIL' }),
    ], retired)

    expect(merged.map((i) => i.itemId).sort()).toEqual(['A1', 'C1', 'H1'])
    expect(merged.find((i) => i.itemId === 'H1')?.result).toBe('FAIL')
  })

  it('is a no-op when there is nothing retired to fold', () => {
    const items = [item({ itemId: 'A1' }), item({ itemId: 'C1' })]
    expect(mergeLegacyGroundingItems(items, retired)).toEqual(items)
  })
})
