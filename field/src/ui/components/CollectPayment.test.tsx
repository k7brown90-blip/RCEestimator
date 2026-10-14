/**
 * Collect payment while the balance is financed (Kyle, 2026-10-08; Phase 6 Unit 6A).
 *
 * The server closes the QR / pay link while a financing fee is on the invoice (chargeableAmount
 * refuses with "Financing in progress"), so the screen must not offer them: the tech sees the fee
 * as its own line, the balance it is inside, and the reason — read-only. The field never records
 * a Synchrony payment; that is the office's, on the CRM payment panel.
 *
 * The field suite renders static markup (no DOM), so the branch is pinned through the pure
 * `collectionModeFor` and the `FinancingInProgress` block the loaded screen mounts.
 */

import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { CollectPayment, FinancingBlockedNote, FinancingInProgress, collectionModeFor } from './CollectPayment'

const REASON = 'Financing in progress — balance is being paid through Synchrony'
const financing = { planNumber: '965', planDescription: '11.99% APR until paid in full', fee: 8.64, reason: REASON }

describe('collectionModeFor', () => {
  it('paid in full wins; then financing; otherwise the ordinary collect flow', () => {
    expect(collectionModeFor({ paidInFull: true, financing })).toBe('paid')
    expect(collectionModeFor({ paidInFull: false, financing })).toBe('financing')
    expect(collectionModeFor({ paidInFull: false, financing: null })).toBe('collect')
    expect(collectionModeFor({ paidInFull: false })).toBe('collect') // an older server build leaves it out
  })
})

describe('FinancingInProgress', () => {
  it('shows the fee as its own line, the balance it is inside, and the server\'s reason — nothing to tap', () => {
    const html = renderToStaticMarkup(<FinancingInProgress info={{ balance: 291.97, financing }} />)
    expect(html).toContain('Financing fee — Plan 965')
    expect(html).toContain('$8.64')
    expect(html).toContain('$291.97')
    expect(html).toContain(REASON)
    expect(html).toContain('the office records the Synchrony payment')
    // No QR, no pay link, no email-the-invoice, no recording control.
    expect(html).not.toContain('Payment QR')
    expect(html).not.toContain('Open pay page')
    expect(html).not.toContain('Email invoice')
    expect(html).not.toContain('Record')
    expect(html).not.toContain('<a ')
    expect(html).not.toContain('<button')
  })

  it('carries no rate: the fee and the balance are the only figures', () => {
    const html = renderToStaticMarkup(<FinancingInProgress info={{ balance: 291.97, financing }} />)
    expect(html).not.toMatch(/%/)
    expect(html).not.toMatch(/rate/i)
  })

  it('renders nothing when there is no financing on the visit', () => {
    expect(renderToStaticMarkup(<FinancingInProgress info={{ balance: 283.33, financing: null }} />)).toBe('')
  })
})

describe('FinancingBlockedNote (Phase 6 Unit 6C — decision 8)', () => {
  const DEPOSIT_REASON = 'The 1/3 deposit has not been collected yet — financing is for the balance after the deposit.'

  it("shows the server's reason on the payment screen, read-only — no button, no link, no rate", () => {
    const html = renderToStaticMarkup(<FinancingBlockedNote info={{ financingBlocked: DEPOSIT_REASON }} />)
    expect(html).toContain('Financing: ')
    // renderToStaticMarkup escapes nothing in this sentence, but the em dash must survive.
    expect(html).toContain('The 1/3 deposit has not been collected yet')
    expect(html).not.toContain('<button')
    expect(html).not.toContain('<a ')
    expect(html).not.toMatch(/%/)
  })

  it('renders nothing when financing is open, already on, or the invoice is paid (null) or the server is older (absent)', () => {
    expect(renderToStaticMarkup(<FinancingBlockedNote info={{ financingBlocked: null }} />)).toBe('')
    expect(renderToStaticMarkup(<FinancingBlockedNote info={{}} />)).toBe('')
  })
})

describe('CollectPayment closed', () => {
  it('is just the button — no Synchrony word on a screen a customer may be glancing at', () => {
    const html = renderToStaticMarkup(<CollectPayment visitId="visit-1" />)
    expect(html).toContain('Collect payment')
    expect(html.toLowerCase()).not.toContain('synchrony')
  })

  it('greyed WITH the reason, never hidden, while a signature taken on this phone has not reached the office (Phase 7 U8)', () => {
    const html = renderToStaticMarkup(<CollectPayment visitId="visit-1" blockedReason="Waiting for the signature to reach the office" />)
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>💳 Collect payment</)
    expect(html).toContain('Waiting for the signature to reach the office')
    // Nothing to tap through to: no QR, no pay link, no email.
    expect(html).not.toContain('Payment QR')
    expect(html).not.toContain('Email invoice')
    // Even when asked to start open: the block wins.
    expect(renderToStaticMarkup(<CollectPayment visitId="visit-1" startOpen blockedReason="Waiting for the signature to reach the office" />)).not.toContain('refresh')
  })
})
