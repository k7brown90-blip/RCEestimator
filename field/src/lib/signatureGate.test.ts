/**
 * The one signing rule (Phase 7 U8, 2026-10-10): what every "Sign now" door and the capture itself
 * agree on. Pure, so it is pinned by value: with no signal only an issued, unchanged, saved estimate
 * inside its 30 days by this phone's clock, with nothing waiting and no signature already held.
 */

import { describe, expect, it } from 'vitest'
import { CHANGED_ON_PHONE_SIGN_REASON, SIGN_NEEDS_ISSUE_REASON, heldSignatureReason, signGate, validUntil } from './signatureGate'

const DAY = 86_400_000
const NOW = Date.parse('2026-10-10T15:00:00.000Z')
const issuedDaysAgo = (days: number, over: Partial<Parameters<typeof signGate>[0]['issued'] & object> = {}) => ({
  number: '2026-1098',
  issuedAt: new Date(NOW - days * DAY).toISOString(),
  validDays: 30,
  signedAt: null,
  status: 'sent',
  ...over,
})
const base = (over: Partial<Parameters<typeof signGate>[0]> = {}) =>
  signGate({ issued: issuedDaysAgo(3), hasUnsavedChanges: false, waiting: 0, localOnlyQuote: false, offline: true, signature: null, now: NOW, ...over })

describe('signGate — with no signal', () => {
  it('an issued, unchanged, saved estimate inside its 30 days is signable, with no warning while more than two days remain', () => {
    expect(base()).toEqual({ kind: 'ok', reason: null, warning: null, daysLeft: 27 })
  })

  it('nothing issued, or a quote the office never received: "Signing needs the issued estimate"', () => {
    expect(base({ issued: null }).reason).toBe(SIGN_NEEDS_ISSUE_REASON)
    expect(base({ localOnlyQuote: true }).reason).toBe(SIGN_NEEDS_ISSUE_REASON)
    expect(base({ issued: null }).kind).toBe('needs-issue')
  })

  it('edits waiting on this phone: "You changed this estimate on the phone — Discard my changes to sign the issued version"', () => {
    const g = base({ waiting: 2 })
    expect(g.kind).toBe('changes')
    expect(g.reason).toBe(CHANGED_ON_PHONE_SIGN_REASON)
  })

  it('the office\'s copy was edited after issue (hasUnsavedChanges): needs signal to save the changes first', () => {
    const g = base({ hasUnsavedChanges: true })
    expect(g.kind).toBe('edited')
    expect(g.reason).toMatch(/Needs signal — the quote was edited after estimate 2026-1098 was issued/)
  })

  it('past the 30 days by this phone\'s clock: expired, naming the date, the office reissues it', () => {
    const g = base({ issued: issuedDaysAgo(31) })
    expect(g.kind).toBe('expired')
    expect(g.reason).toMatch(/^Estimate 2026-1098 expired on .+ — it can't be signed\. The office reissues it\.$/)
    expect(g.daysLeft).toBe(-1)
    // Day 30 exactly is still inside (the server's own arithmetic: now > createdAt + validDays).
    expect(base({ issued: issuedDaysAgo(30) }).kind).toBe('ok')
  })

  it('warns at two days or less, in days', () => {
    expect(base({ issued: issuedDaysAgo(28) }).warning).toMatch(/valid until .+ — 2 days left$/)
    expect(base({ issued: issuedDaysAgo(29) }).warning).toMatch(/— 1 day left$/)
    expect(base({ issued: issuedDaysAgo(30) }).warning).toMatch(/— it runs out today$/)
    expect(base({ issued: issuedDaysAgo(27) }).warning).toBeNull()
  })

  it('already signed: nothing to sign', () => {
    const g = base({ issued: issuedDaysAgo(3, { signedAt: '2026-10-09T10:00:00.000Z' }) })
    expect(g.kind).toBe('signed')
    expect(g.reason).toBe('Estimate 2026-1098 is already signed — there is nothing to sign.')
  })

  it('a signature already held on this phone wins over everything else, by its state', () => {
    const queued = { state: 'queued' as const, signerName: 'Mrs Panel', capturedAt: '2026-10-10T14:14:00.000Z' }
    expect(base({ signature: queued }).reason).toMatch(/^A signature for estimate 2026-1098 by Mrs Panel is already saved on this phone \(taken .+\) — waiting to reach the office$/)
    expect(base({ signature: { ...queued, state: 'refused' } }).reason).toMatch(/^The office refused the last signature for estimate 2026-1098 — Sign again, or dismiss it/)
    expect(base({ signature: { ...queued, state: 'recorded' } }).reason).toBe('Estimate 2026-1098 is signed — recorded at the office')
    // A cancelled row is no longer held; nor is a cancellation the office would not file (D4) — it only waits to be removed from the card.
    expect(base({ signature: { ...queued, state: 'cancelled' } }).kind).toBe('ok')
    expect(base({ signature: { ...queued, state: 'unfiled' } }).kind).toBe('ok')
    expect(heldSignatureReason('2026-1098', { ...queued, state: 'unfiled' })).toMatch(/the office would not file it; remove it from the card/)
    // Held beats "changes waiting" and "expired": the card is what the tech must deal with first.
    expect(base({ signature: queued, waiting: 3, issued: issuedDaysAgo(40) }).kind).toBe('signature')
    expect(heldSignatureReason('2026-1098', { ...queued, state: 'cancelled' })).toMatch(/was cancelled on this phone/)
  })
})

describe('signGate — with signal', () => {
  it('nothing issued is fine: "Sign now" issues first (the shared issue-or-reuse rule), so the gate says ok', () => {
    expect(base({ offline: false, issued: null }).kind).toBe('ok')
    expect(base({ offline: false, localOnlyQuote: true }).kind).toBe('ok')
  })

  it('edited after issue is the issue-or-reuse rule\'s to decide, not the gate\'s', () => {
    expect(base({ offline: false, hasUnsavedChanges: true }).kind).toBe('ok')
  })

  it('past the 30 days is the SERVER\'s to judge (a wrong phone clock must not grey a signature the office would take): ok, with the warning', () => {
    const g = base({ offline: false, issued: issuedDaysAgo(31) })
    expect(g.kind).toBe('ok')
    expect(g.warning).toMatch(/past that by this phone's clock; the office decides$/)
  })

  it('edits waiting and a signature held still grey it, signal or not', () => {
    expect(base({ offline: false, waiting: 1 }).kind).toBe('changes')
    expect(base({ offline: false, signature: { state: 'queued', signerName: 'X', capturedAt: '2026-10-10T14:14:00.000Z' } }).kind).toBe('signature')
  })
})

describe('validUntil', () => {
  it('is the issue time plus the days', () => {
    expect(validUntil({ issuedAt: '2026-10-01T12:00:00.000Z', validDays: 30 })).toBe('2026-10-31T12:00:00.000Z')
  })
})
