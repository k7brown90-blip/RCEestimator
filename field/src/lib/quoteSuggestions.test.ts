/**
 * The words and small rules behind the field Quote screen's AI proposals and walkthrough list
 * (2026-10-08, one-estimating-system plan, Phase 2, unit D). Open questions are gone (Kyle, 2026-11-28).
 */

import { describe, expect, it } from 'vitest'
import {
  aiSummaryText,
  confirmButtonLabel,
  confirmEdits,
  issueDisabledReason,
  proposalsHeading,
  suggestedPointer,
  suggestionQuantityProblem,
  unmatchedText,
  walkthroughLineNote,
  walkthroughLines,
  walkthroughPathBadge,
} from './quoteSuggestions'
import { notPlacedNote, unreviewedReasons } from '../../../shared/suggestedLines'

describe('headings: the office\'s own words', () => {
  it('AI proposals — N waiting on you (and no "Open questions" heading any more)', () => {
    expect(proposalsHeading(3)).toBe('AI proposals — 3 waiting on you')
  })
})

describe('Confirm vs Edit & confirm', () => {
  const line = { quantity: 3, difficulty: 'NORMAL' as const }

  it('unchanged sends nothing and the button says Confirm', () => {
    expect(confirmEdits(line, '3', 'NORMAL')).toEqual({})
    expect(confirmButtonLabel(false)).toBe('Confirm')
  })

  it('a changed quantity or difficulty is sent, and the button says Edit & confirm', () => {
    expect(confirmEdits(line, '5', 'NORMAL')).toEqual({ quantity: 5 })
    expect(confirmEdits(line, '3', 'DIFFICULT')).toEqual({ difficulty: 'DIFFICULT' })
    expect(confirmEdits(line, '5', 'VERY_DIFFICULT')).toEqual({ quantity: 5, difficulty: 'VERY_DIFFICULT' })
    expect(confirmButtonLabel(true)).toBe('Edit & confirm')
  })
})

describe('suggestionQuantityProblem: the office\'s rule, with the reason on screen', () => {
  it('accepts a positive number', () => {
    expect(suggestionQuantityProblem('2.5', false)).toBeNull()
  })
  it('refuses blank, non-numbers and zero', () => {
    expect(suggestionQuantityProblem('', false)).toBe('Enter a quantity.')
    expect(suggestionQuantityProblem('abc', false)).toBe('Enter a quantity.')
    expect(suggestionQuantityProblem('0', false)).toMatch(/zero changes nothing/)
  })
  it('a negative is only for a change order', () => {
    expect(suggestionQuantityProblem('-1', false)).toMatch(/Only a change order can take work off/)
    expect(suggestionQuantityProblem('-1', true)).toBeNull()
    expect(suggestionQuantityProblem('0', true)).toMatch(/minus number/)
  })
})

describe('the walkthrough list', () => {
  it('is one item per line, blank lines dropped, each trimmed', () => {
    expect(walkthroughLines('  4 20A receptacle \n\n50 ft EMT\n   \n')).toEqual(['4 20A receptacle', '50 ft EMT'])
    expect(walkthroughLines('   ')).toEqual([])
  })

  it("a line added from a match carries the office's note", () => {
    expect(walkthroughLineNote('50 ft EMT')).toBe('From walkthrough: "50 ft EMT"')
  })

  it('always names which brain answered, and a degraded AI says why', () => {
    expect(walkthroughPathBadge('ai', null)).toContain('nothing is priced or confirmed')
    expect(walkthroughPathBadge('basic', 'OPENAI_API_KEY is not set')).toBe('Basic match — AI unavailable: OPENAI_API_KEY is not set')
    expect(walkthroughPathBadge('basic', null)).toBe('Basic match')
  })

  it('summarises an AI build the way the office does', () => {
    // Kyle, 2026-11-28: no question count - what could not be placed is a separate note.
    expect(aiSummaryText(3, 0)).toBe('3 line(s) proposed')
    expect(aiSummaryText(3, 2)).toBe('3 line(s) proposed · 2 refused')
  })

  it("what the model could not place is one 'Couldn't place' note, and nothing when all was placed", () => {
    expect(notPlacedNote([])).toBeNull()
    expect(notPlacedNote([
      { text: 'weird outdoor plug by the pool', reason: 'nothing in the price book fits' },
      { text: 'a 4-inch junction box', reason: '' },
    ])).toBe("Couldn't place: weird outdoor plug by the pool (nothing in the price book fits); a 4-inch junction box - add them by hand if needed.")
  })

  it('an unmatched row says which word the book does not know, and where to look instead', () => {
    expect(unmatchedText(['canless'])).toContain('“canless” is not in your price book')
    expect(unmatchedText(['canless', 'wafer'])).toContain('“canless”, “wafer” are not in your price book')
    expect(unmatchedText([])).toContain('Nothing in the price book matched this')
    expect(unmatchedText([])).toContain('browse it by section')
  })
})

describe('under an option on the board', () => {
  it('points at "AI proposals", singular and plural', () => {
    expect(suggestedPointer(1)).toContain('1 AI-suggested line is waiting on you')
    expect(suggestedPointer(2)).toContain('2 AI-suggested lines are waiting on you')
    expect(suggestedPointer(1)).toContain('AI proposals')
  })
})

describe('issueDisabledReason: the Issue button explains itself BEFORE the press', () => {
  const SIGNED = 'Estimate 2026-1098 from this draft is SIGNED. A signed agreement is never edited — raise a change order instead.'

  it('is open (null) when nothing is waiting and the lifecycle allows it', () => {
    expect(issueDisabledReason(null, 0)).toBeNull()
  })

  it("waiting suggestions block it, in the server's own sentence", () => {
    expect(issueDisabledReason(null, 2)).toBe(unreviewedReasons(2).join(' '))
    expect(issueDisabledReason(null, 1)).toContain('under "AI proposals" tap Confirm')
  })

  it('an old open question never greys it: the sentence has no question in it and nothing here takes one (Kyle, 2026-11-28)', () => {
    expect(issueDisabledReason(null, 0)).toBeNull()
    expect(unreviewedReasons(0)).toEqual([])
    expect(unreviewedReasons(2).join(' ')).not.toMatch(/question/i)
  })

  it("the lifecycle's own reason (signed, lost, nothing changed) wins", () => {
    expect(issueDisabledReason(SIGNED, 2)).toBe(SIGNED)
  })
})
