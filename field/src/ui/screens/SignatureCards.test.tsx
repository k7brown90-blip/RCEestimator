/**
 * The card for a signature taken on this phone (Phase 7 U8, 2026-10-10), rendered to static markup
 * (the field suite runs in node with no DOM) and read the way the technician reads it: NOT recorded
 * yet / Not recorded (the office's words) / Signed — each with its exits, greyed WITH the reason.
 */

import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SignatureQueueRecord } from '../../db/database'
import {
  CANCEL_SIGNATURE_LABEL,
  DISMISS_LABEL,
  DONT_START_WORK,
  REMOVE_FROM_PHONE_LABEL,
  SIGNATURE_REFUSED_BLOCK,
  SIGNATURE_SAVED_NOT_RECORDED,
  SIGN_AGAIN_LABEL,
  SIGN_AGAIN_NEEDS_SIGNAL,
  SignaturePendingCard,
  WAITING_FOR_SIGNATURE,
  refusedWords,
  savedCopyWords,
  signedByWords,
} from './SignatureCards'

const row = (over: Partial<SignatureQueueRecord> = {}): SignatureQueueRecord => ({
  signatureId: 'sig-1', estimateId: 'est-1', visitId: 'v1', draftId: 'd1', number: '2026-1098',
  signerName: 'Mrs Panel', signatureImage: 'data:image/png;base64,AAAA', selectedOptions: ['A'],
  revision: 1, figuresKey: 'k', consentText: 'c', capturedAt: '2026-10-10T14:14:00.000Z',
  state: 'queued', attempts: 0, queuedAt: '2026-10-10T14:14:00.000Z', ...over,
})
const render = (r: SignatureQueueRecord, extra: Partial<Parameters<typeof SignaturePendingCard>[0]> = {}) =>
  renderToStaticMarkup(
    <SignaturePendingCard row={r} offline={false} busy={false} onCancel={async () => {}} onDismiss={async () => {}} onSignAgain={async () => {}} {...extra} />,
  )

describe('queued — "Signature saved on this phone — NOT recorded yet"', () => {
  it('says so, names who signed and when, says not to start work, and offers Cancel (reason required)', () => {
    const html = render(row())
    expect(html).toContain(SIGNATURE_SAVED_NOT_RECORDED)
    expect(html).toContain('Mrs Panel signed estimate 2026-1098 at')
    expect(html).toContain(DONT_START_WORK.replace(/'/g, '&#x27;'))
    expect(html).toContain(CANCEL_SIGNATURE_LABEL)
    expect(html).toContain('role="status"')
    expect(html).not.toContain('Signed —')
    expect(html).not.toContain(SIGN_AGAIN_LABEL)
    expect(html).not.toContain(DISMISS_LABEL)
    // The drawn mark never renders on a card.
    expect(html).not.toContain('base64')
  })

  it('says what it is waiting for: signal, a sign-in, or the office\'s answer (with the tries so far)', () => {
    expect(render(row(), { offline: true })).toContain('Waiting for signal')
    expect(render(row(), { authNeeded: true })).toContain('Sign in again')
    expect(render(row({ attempts: 2, lastError: 'CRM request failed (503)' }))).toContain('2 tries so far — last answer: CRM request failed (503)')
    expect(render(row())).toContain('Sending to the office…')
    expect(render(row({ state: 'cancelled', cancelKind: 'cancelled', cancelReason: 'x' }))).toContain('Cancelled — the cancellation is filed at the office')
    expect(render(row({ state: 'cancelled', cancelKind: 'cancelled', cancelReason: 'x' }))).not.toContain(CANCEL_SIGNATURE_LABEL)
  })
})

describe('refused — "Not recorded: <the office\'s words>. The customer believes they signed — call them."', () => {
  const refused = row({ state: 'refused', reason: 'This estimate is void.', refusedAt: '2026-10-10T16:00:00.000Z' })

  it('is a red alert with the office\'s words, Sign again and the dismiss (reason required)', () => {
    const html = render(refused)
    expect(html).toContain('role="alert"')
    expect(html).toContain('Not recorded: This estimate is void. The customer believes they signed — call them.')
    expect(html).toContain('>Sign again<')
    expect(html).toContain(DISMISS_LABEL.replace(/'/g, '&#x27;'))
    expect(html).not.toContain(CANCEL_SIGNATURE_LABEL)
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Sign again</)
  })

  it('Sign again is greyed WITH the reason with no signal, or when the screen cannot open signing', () => {
    const offline = render(refused, { offline: true })
    expect(offline).toMatch(/<button[^>]*disabled=""[^>]*>Sign again</)
    expect(offline).toContain(SIGN_AGAIN_NEEDS_SIGNAL)
    const nowhere = render(refused, { onSignAgain: undefined })
    expect(nowhere).toMatch(/<button[^>]*disabled=""[^>]*>Sign again</)
    expect(nowhere).toContain('Sign again from the quote')
  })

  it('refusedWords ends the office\'s sentence once, whether or not it brought its own full stop', () => {
    expect(refusedWords('This estimate is void.')).toBe('Not recorded: This estimate is void. The customer believes they signed — call them.')
    expect(refusedWords('replaced by a newer revision')).toBe('Not recorded: replaced by a newer revision. The customer believes they signed — call them.')
  })
})

describe('unfiled — the office would not file the cancellation (D4)', () => {
  const unfiled = row({ state: 'unfiled', cancelKind: 'cancelled', cancelReason: 'Customer wants to think it over', fileRefusal: 'Estimate not found' })

  it('says so with the office\'s words and the technician\'s reason, says nothing was recorded, and offers the one exit, Remove from this phone', () => {
    const html = render(unfiled, { onRemove: async () => {} })
    expect(html).toContain('Cancelled on this phone — the office would not file the cancellation: Estimate not found')
    expect(html).toContain('Nothing was recorded for this signature (your reason: Customer wants to think it over)')
    expect(html).toContain(`>${REMOVE_FROM_PHONE_LABEL}<`)
    expect(html).not.toMatch(new RegExp(`<button[^>]*disabled=""[^>]*>${REMOVE_FROM_PHONE_LABEL}<`))
    expect(html).not.toContain(CANCEL_SIGNATURE_LABEL)
    expect(html).not.toContain(SIGN_AGAIN_LABEL)
    expect(html).not.toContain(DISMISS_LABEL)
    expect(html).not.toContain('Signed —')
    expect(html).not.toContain('base64')
    // A dismissal that could not be filed names itself.
    expect(render(row({ ...unfiled, cancelKind: 'dismissed' }), { onRemove: async () => {} })).toContain('would not file the dismissal')
  })

  it('Remove is greyed WITH why where the screen cannot remove it', () => {
    const html = render(unfiled, { onRemove: undefined })
    expect(html).toMatch(new RegExp(`<button[^>]*disabled=""[^>]*>${REMOVE_FROM_PHONE_LABEL}<`))
    expect(html).toContain('Remove it from the card on the job or the quote')
  })
})

describe('a send that failed on this phone (D7)', () => {
  it('says the failure is the phone\'s, not the signal\'s', () => {
    const html = render(row({ attempts: 1, lastError: "Cannot read properties of undefined (reading 'token')", lastErrorKind: 'phone' }))
    expect(html).toContain('Could not be sent from this phone — last try: Cannot read properties of undefined')
    expect(html).not.toContain('Waiting for signal')
    // The office answering 5xx is still "sending", with the answer.
    expect(render(row({ attempts: 1, lastError: 'CRM request failed (503)', lastErrorKind: 'office' }))).toContain('1 try so far — last answer: CRM request failed (503)')
  })
})

describe('recorded — "Signed"', () => {
  it('says Signed only here, with when it was recorded', () => {
    const html = render(row({ state: 'recorded', recordedAt: '2026-10-10T16:30:00.000Z' }))
    expect(html).toContain('Signed — estimate 2026-1098 is recorded at the office')
    expect(html).toContain('recorded')
    expect(html).not.toContain(CANCEL_SIGNATURE_LABEL)
    expect(html).not.toContain(SIGN_AGAIN_LABEL)
    expect(html).not.toContain('NOT recorded')
  })
})

describe('the words', () => {
  it('are the design\'s sentences', () => {
    expect(WAITING_FOR_SIGNATURE).toBe('Waiting for the signature to reach the office')
    expect(SIGNATURE_SAVED_NOT_RECORDED).toBe('Signature saved on this phone — NOT recorded yet')
    expect(CANCEL_SIGNATURE_LABEL).toBe('Cancel this signature (not recorded yet)')
    expect(DISMISS_LABEL).toBe("I've called the customer — dismiss")
    expect(REMOVE_FROM_PHONE_LABEL).toBe('Remove from this phone')
    expect(SIGNATURE_REFUSED_BLOCK).toBe('The office refused the signature — have the customer sign again, or dismiss it on the card')
    expect(savedCopyWords('2026-10-10T14:14:00.000Z')).toMatch(/^This phone's copy, saved /)
    expect(signedByWords(row())).toMatch(/^Mrs Panel signed estimate 2026-1098 at .+ \(this phone's clock\)$/)
  })
})
