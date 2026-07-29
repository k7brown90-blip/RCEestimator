import { describe, expect, it } from 'vitest'
import { checklist } from './checklist'
import { jurisdictions } from './jurisdictions'
import { bannerListedItemIds, conditionalBannerItems } from './criticalItems'
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

  it('bannerListed flags match the explicit banner list', () => {
    const flagged = checklist.filter((item) => item.bannerListed).map((item) => item.id)
    expect(flagged.sort()).toEqual([...bannerListedItemIds].sort())
  })

  it('every banner-listed id is a real checklist item', () => {
    // A typo here would silently drop an item out of the critical banner.
    const ids = new Set(checklist.map((item) => item.id))
    for (const id of bannerListedItemIds) {
      expect(ids.has(id), `banner list references unknown item ${id}`).toBe(true)
    }
    for (const id of Object.keys(conditionalBannerItems)) {
      expect(ids.has(id), `conditional banner references unknown item ${id}`).toBe(true)
    }
  })

  it('only banners a graded item at a grade that item actually offers', () => {
    for (const [id, { gradedState }] of Object.entries(conditionalBannerItems)) {
      const def = checklist.find((item) => item.id === id)
      expect(def?.graded, `${id} is conditionally bannered but is not graded`).toBeDefined()
      expect(def?.graded).toContain(gradedState)
    }
  })

  it('marks exactly E1, E2, E3, H1 as life-safety class (Scoring Design Step 1c)', () => {
    const lifeSafety = checklist.filter((item) => item.lifeSafetyClass).map((item) => item.id)
    expect(lifeSafety.sort()).toEqual(['E1', 'E2', 'E3', 'H1'])
  })

  it('allows N/A only where the Blueprint permits it', () => {
    // C5 no subpanels · C6 no gas piping · D5 all-copper · D4 and D7 a strictly
    // disconnect-only enclosure, which has neither a directory nor branch breakers.
    const naItems = checklist.filter((item) => item.naAllowed).map((item) => item.id)
    expect(naItems.sort()).toEqual(['C5', 'C6', 'D4', 'D5', 'D7'])
  })

  it('D1 carries the three graded states', () => {
    const d1 = checklist.find((item) => item.id === 'D1')
    expect(d1?.graded).toEqual(['severe', 'moderate', 'minor'])
  })

  it('keeps {placeholders} referenced by whatWeFound resolvable from input fields', () => {
    // Placeholders that are merged from report context, not direct inputs.
    const contextTokens = new Set([
      'plain_result',
      'edition_note',
      'tn_amendment_note',
      'required_or_optional',
      'spd_code_stance',
      'spd_requirement_line',
    ])
    const fieldIdsOf = (id: string) =>
      new Set(checklist.find((item) => item.id === id)?.inputFields.map((field) => field.id) ?? [])

    for (const item of checklist) {
      const fieldIds = fieldIdsOf(item.id)
      // `[\w.]` so a cross-item {ITEM.field} reference is caught, not skipped.
      const tokens = [...item.reasoning.whatWeFound.matchAll(/\{([\w.]+)\}/g)].map((m) => m[1])
      for (const token of tokens) {
        if (token.includes('.')) {
          const [otherId, fieldId] = token.split('.')
          expect(
            fieldIdsOf(otherId).has(fieldId),
            `${item.id}: {${token}} references a field ${otherId} does not have`,
          ).toBe(true)
          continue
        }
        expect(
          fieldIds.has(token) || contextTokens.has(token),
          `${item.id}: unresolvable placeholder {${token}}`,
        ).toBe(true)
      }
    }
  })

  it('never cites a cross-item value from an item assessed in a later phase', () => {
    // A Phase 1 report is delivered before Phase 2 is walked, so a backward
    // reference would print an em dash on every Phase 1 record.
    const phaseOf = new Map(checklist.map((item) => [item.id, item.phase]))
    for (const item of checklist) {
      const tokens = [...item.reasoning.whatWeFound.matchAll(/\{(\w+)\.(\w+)\}/g)]
      for (const [, otherId] of tokens) {
        expect(
          (phaseOf.get(otherId) ?? 1) <= item.phase,
          `${item.id} (phase ${item.phase}) cites ${otherId} (phase ${phaseOf.get(otherId)})`,
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
