/**
 * The words and small rules behind the field Quote screen's AI proposals, open questions and
 * walkthrough list (2026-10-08, one-estimating-system plan, Phase 2, unit D).
 */

import { describe, expect, it } from 'vitest'
import {
  aiSummaryText,
  confirmButtonLabel,
  confirmEdits,
  issueDisabledReason,
  proposalsHeading,
  questionsHeading,
  suggestedPointer,
  suggestionQuantityProblem,
  unmatchedText,
  walkthroughLineNote,
  walkthroughLines,
  walkthroughPathBadge,
} from './quoteSuggestions'
import { unreviewedReasons } from '../../../shared/suggestedLines'

describe('headings: the office\'s own words', () => {
  it('AI proposals — N waiting on you / Open questions — N', () => {
    expect(proposalsHeading(3)).toBe('AI proposals — 3 waiting on you')
    expect(questionsHeading(2)).toBe('Open questions — 2')
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
    expect(aiSummaryText(3, 1, 0)).toBe('3 line(s) proposed · 1 question(s)')
    expect(aiSummaryText(3, 1, 2)).toBe('3 line(s) proposed · 1 question(s) · 2 refused')
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
    expect(issueDisabledReason(null, 0, 0)).toBeNull()
  })

  it("waiting suggestions and questions block it, in the server's own sentences", () => {
    expect(issueDisabledReason(null, 2, 1)).toBe(unreviewedReasons(2, 1).join(' '))
    expect(issueDisabledReason(null, 1, 0)).toContain('under "AI proposals" tap Confirm')
    expect(issueDisabledReason(null, 0, 1)).toContain('under "Open questions"')
  })

  it("the lifecycle's own reason (signed, lost, nothing changed) wins", () => {
    expect(issueDisabledReason(SIGNED, 2, 1)).toBe(SIGNED)
  })
})
