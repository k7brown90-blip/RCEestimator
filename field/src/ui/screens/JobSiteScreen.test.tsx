/**
 * The Job site screen's "Estimate N issued — not signed yet" gate (2026-10-08, one-estimating-system
 * plan, Phase 2 unit B, audit bug d).
 *
 * The 2026-09-24 closing-out plan found this panel was dead code: the job brief only ever carried a
 * SIGNED estimate, so "estimate present AND unsigned" could never hold. The brief now carries the
 * newest live unsigned estimate too (health-record.ts job-brief; tests/fieldQuoteLifecycle.test.ts
 * pins the payload), and this pins the screen's side of the same condition.
 */

import { describe, expect, it } from 'vitest'
import { awaitingSignatureFor } from './JobSiteScreen'

const estimate = (signedAt: string | null) => ({
  estimate: { number: '2026-1098', title: 'Panel', scopeText: null, signedAt, customerUrl: 'https://x/e/abc', lines: [] },
})

describe('awaitingSignatureFor', () => {
  it('an issued, UNSIGNED estimate on the brief renders the panel', () => {
    expect(awaitingSignatureFor(estimate(null), false, false)).toBe(true)
  })

  it('an older server that leaves signedAt out counts as unsigned too', () => {
    const brief = { estimate: { number: '2026-1098', title: 'Panel', scopeText: null, lines: [] } }
    expect(awaitingSignatureFor(brief, false, false)).toBe(true)
  })

  it('signed: the panel gives way to the two live choices (choicePending) or to nothing', () => {
    expect(awaitingSignatureFor(estimate('2026-10-08T15:00:00Z'), true, false)).toBe(false)
    expect(awaitingSignatureFor(estimate('2026-10-08T15:00:00Z'), false, false)).toBe(false)
  })

  it('no estimate on the brief, or the visit already done: no panel', () => {
    expect(awaitingSignatureFor({ estimate: null }, false, false)).toBe(false)
    expect(awaitingSignatureFor(null, false, false)).toBe(false)
    expect(awaitingSignatureFor(estimate(null), false, true)).toBe(false)
  })

  it('choicePending never wins over an unsigned estimate — the server keeps it false until the signature', () => {
    // If a server ever answered choicePending for unsigned money, the panel would hide and the live
    // choices would show; fieldChoicePending (sameDayJob.ts) refuses that, and this documents the order.
    expect(awaitingSignatureFor(estimate(null), true, false)).toBe(false)
  })
})

// ─── 2026-10-08 review: the panel emails, it does not text ────────────────────

import { readFileSync } from 'node:fs'

describe('the "issued - not signed yet" panel emails the estimate (Kyle, 2026-10-01 ruling)', () => {
  // The screen is stateful and fetches, so it cannot be rendered statically; this pins the source.
  // Kyle: "the text option for signiture needs chaged to email since we do not have text yet."
  // Since the brief began carrying an unsigned live estimate (2026-10-08) this panel renders on a
  // phone for the first time, and it still held the OS share sheet - i.e. the text channel.
  const source = readFileSync(new URL('./JobSiteScreen.tsx', import.meta.url), 'utf8')
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  it('has no navigator.share call and no "Share the link" button', () => {
    expect(code).not.toContain('navigator.share')
    expect(code).not.toContain('Share the link to their phone')
  })
  it('uses the same email button as the Quote screen panel, from the brief estimate id', () => {
    expect(code).toContain('<EmailEstimateButton')
    expect(code).toContain('brief.estimate.id')
  })
  it('offers "Show the customer / Sign now" - the IN-PERSON door - ahead of the customer-page link', () => {
    // Review finding (2026-10-08): this panel's only signing door was the public /e/:token page,
    // which records the signature as "from the emailed link". The customer who says yes a few
    // minutes later now signs on this phone, recorded in person with the technician named.
    expect(code).toContain('Show the customer / Sign now')
    expect(code).toContain('onShowCustomer')
    expect(code.indexOf('Show the customer / Sign now')).toBeLessThan(code.indexOf('CUSTOMER_PAGE_LABEL}'))
  })
  it('labels the page link as the customer\'s own-device door, never "review & sign"', () => {
    expect(code).not.toContain('review &amp; sign')
    expect(code).toContain('CUSTOMER_PAGE_LABEL')
  })
  it('and offers "Email the financing link" beside it, before signing (Phase 4)', () => {
    expect(code).toContain('<EmailFinancingButton')
    expect(code.indexOf('<EmailEstimateButton')).toBeLessThan(code.indexOf('<EmailFinancingButton'))
  })
})

// ─── Phase 7 U8 (2026-10-10): signing with no signal, as the Job site shows it ────────────────

describe('the Job site with a signature taken on this phone (U8)', () => {
  // The screen is stateful and fetches, so it cannot be rendered statically; this pins the source
  // against the design's §2/§6 words. The card itself is pinned by SignatureCards.test.tsx.
  const source = readFileSync(new URL('./JobSiteScreen.tsx', import.meta.url), 'utf8')
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  it('reads the saved copy of the visit\'s quote when the brief cannot load, and labels the panel as this phone\'s copy', () => {
    expect(code).toContain('workingQuoteMirrorForVisit(assignment.visitId)')
    expect(code).toContain('savedCopyWords(savedQuote.snapshotAt)')
    // Only a network failure stands the saved copy in; a refusal keeps the office's words.
    expect(code).toContain('if (isNetworkFailure(err)) {')
  })

  it('shows the signature card and greys Complete work now / Schedule for later / Collect payment "Waiting for the signature to reach the office"', () => {
    expect(code).toContain('<SignaturePendingCard')
    expect(code).toContain('blockedReason={signatureWaiting ? WAITING_FOR_SIGNATURE : null}')
    expect(code).toContain('{WAITING_FOR_SIGNATURE}. Both choices open the moment this card says Signed.')
    expect(code).toContain('title={signatureWaiting ? WAITING_FOR_SIGNATURE : undefined}')
  })

  it('"Show the customer / Sign now" is greyed WITH the one signing rule\'s reason (a signature held, expired by this clock, edits waiting) — on the page, not only the tooltip', () => {
    expect(code).toContain('disabled={showSignReason !== null}')
    expect(code).toContain('{showSignReason && <p className="text-[11px] text-amber-200">{showSignReason}</p>}')
    expect(code).toContain('heldSignatureReason(panelEstimate.number, heldSignature)')
    expect(code).toContain('signGate({')
  })

  it('the two emails are greyed "Needs signal" from the saved copy, and never says Signed before the office has answered', () => {
    expect(code).toContain('blockedReason={offline ? OFFLINE_EMAIL_REASON : null}')
    // "Signed —" renders only from the brief's own signed state (choicePending) or the recorded card.
    expect(code.match(/Signed — \{brief\?\.estimate\?\.number\}/g)?.length).toBe(1)
  })
})
