import { describe, expect, it } from 'vitest'
import { checklist } from './checklist'
import { jurisdictions } from './jurisdictions'
import { bannerListedItemIds, weights } from './weights'
import { checklistItemDefSchema, jurisdictionProfileSchema } from '../domain/schemas'

describe('checklist data integrity', () => {
  it('validates every item against the Zod schema', () => {
    for (const item of checklist) {
      expect(() => checklistItemDefSchema.parse(item)).not.toThrow()
    }
  })

  it('has unique item ids', () => {
    const ids = checklist.map((item) => item.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('covers sections A through I', () => {
    const prefixes = new Set(checklist.map((item) => item.id[0]))
    expect([...prefixes].sort()).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'])
  })

  it('every scored item has a weight entry', () => {
    const weightedIds = new Set(weights.map((entry) => entry.itemId))
    // C1 and I1 have no row in the published §3 weight table // VERIFY pending contractor lock
    const unweighted = checklist
      .map((item) => item.id)
      .filter((id) => !weightedIds.has(id))
    expect(unweighted).toEqual(['C1', 'I1'])
  })

  it('bannerListed flags match the explicit banner list (D1/D5 handled in engine)', () => {
    const flagged = checklist.filter((item) => item.bannerListed).map((item) => item.id)
    expect(flagged.sort()).toEqual([...bannerListedItemIds].sort())
  })

  it('marks exactly E1, E2, E3, H1 as life-safety class (Scoring Design Step 1c)', () => {
    const lifeSafety = checklist.filter((item) => item.lifeSafetyClass).map((item) => item.id)
    expect(lifeSafety.sort()).toEqual(['E1', 'E2', 'E3', 'H1'])
  })

  it('allows N/A only where the Blueprint permits it', () => {
    const naItems = checklist.filter((item) => item.naAllowed).map((item) => item.id)
    expect(naItems.sort()).toEqual(['C5', 'C6', 'D5'])
  })

  it('D1 carries the three graded states', () => {
    const d1 = checklist.find((item) => item.id === 'D1')
    expect(d1?.graded).toEqual(['severe', 'moderate', 'minor'])
  })

  it('keeps {placeholders} referenced by whatWeFound resolvable from input fields', () => {
    // Placeholders that are merged from computed/report context, not direct inputs.
    const contextTokens = new Set([
      'plain_result',
      'edition_note',
      'tn_amendment_note',
      'required_or_optional',
      'spd_code_stance',
      'spd_requirement_line',
    ])
    for (const item of checklist) {
      const fieldIds = new Set(item.inputFields.map((field) => field.id))
      const tokens = [...item.reasoning.whatWeFound.matchAll(/\{(\w+)\}/g)].map((m) => m[1])
      for (const token of tokens) {
        expect(
          fieldIds.has(token) || contextTokens.has(token),
          `${item.id}: unresolvable placeholder {${token}}`,
        ).toBe(true)
      }
    }
  })
})

describe('jurisdiction data integrity', () => {
  it('validates every profile against the Zod schema', () => {
    for (const profile of jurisdictions) {
      expect(() => jurisdictionProfileSchema.parse(profile)).not.toThrow()
    }
  })

  it('defines the five profiles from the Blueprint table', () => {
    expect(jurisdictions.map((p) => p.id)).toEqual([
      'murfreesboro',
      'brentwood',
      'rutherford',
      'franklin',
      'nashville',
    ])
  })

  it('requires surge only under 2023 editions', () => {
    for (const profile of jurisdictions) {
      expect(profile.surgeRequired).toBe(profile.necEdition === '2023')
    }
  })

  it('enables Metro amendments only for Nashville', () => {
    for (const profile of jurisdictions) {
      expect(profile.metroAmendments).toBe(profile.id === 'nashville')
    }
  })
})
