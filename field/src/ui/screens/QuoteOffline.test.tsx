/**
 * The Quote screen with no signal — what the tech SEES of the queue (Phase 7 U5, 2026-10-10):
 * the header strip, "Changes waiting (N)" with its Discard, the label under a line's figure, the
 * saved book's age, and the greyed-with-reason sentences. Rendered to static markup (the field suite
 * runs in node with no DOM) and read the way a tech reads the screen.
 */

import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  ChangesWaiting,
  DISCARD_START_REASON,
  NO_SAVED_BOOK,
  NO_SIGNAL_BANNER,
  OFFLINE_ISSUE_REASON,
  PriceBookAge,
  SIGN_IN_AGAIN_HINT,
  SignalStrip,
  lineFigureWords,
  savedAtWords,
  sendingIssueReason,
  waitForChangesReason,
} from './QuoteOffline'
import { MAY_COME_DOWN, PRICED_WHEN_SIGNAL_RETURNS } from '../../../../shared/quotePreview'
import type { QuoteOpRecord } from '../../db/database'

const op = (over: Partial<QuoteOpRecord> & Pick<QuoteOpRecord, 'body'>): QuoteOpRecord => ({
  opId: `op-${over.seq ?? 1}`, draftId: 'd1', visitId: 'v1', seq: 1, kind: over.body.kind, status: 'queued', attempts: 0, queuedAt: '2026-10-10T12:00:00.000Z', ...over,
})
const lookup = { lineWords: (id: string) => (id === 'line-1' ? 'Single-pole switch' : undefined), itemWords: () => undefined }

describe('SignalStrip', () => {
  it('renders nothing with signal and nothing waiting — the screen reads as it always did', () => {
    expect(renderToStaticMarkup(<SignalStrip offline={false} waiting={0} refused={0} />)).toBe('')
  })
  it('no signal, nothing waiting: says the quote is saved on this phone and goes to the office with signal', () => {
    const html = renderToStaticMarkup(<SignalStrip offline waiting={0} refused={0} />)
    expect(html).toContain('No signal')
    expect(html).toContain(NO_SIGNAL_BANNER)
    expect(html).not.toContain('waiting')
  })
  it('no signal with changes: "No signal — 3 changes waiting"', () => {
    expect(renderToStaticMarkup(<SignalStrip offline waiting={3} refused={0} />)).toContain('No signal — 3 changes waiting')
    expect(renderToStaticMarkup(<SignalStrip offline waiting={1} refused={0} />)).toContain('No signal — 1 change waiting')
  })
  it('signal back, changes on their way: "Sending 2 changes…"', () => {
    const html = renderToStaticMarkup(<SignalStrip offline={false} waiting={2} refused={0} />)
    expect(html).toContain('Sending 2 changes…')
    expect(html).not.toContain('No signal')
  })
  it('a refusal is called out and points at the list', () => {
    expect(renderToStaticMarkup(<SignalStrip offline={false} waiting={0} refused={1} />)).toContain('1 change refused by the office')
  })
  it('the office answered 401 (U6): "Sign in again — N changes waiting" with where to do it, in place of "Sending"', () => {
    const html = renderToStaticMarkup(<SignalStrip offline={false} waiting={2} refused={0} authNeeded />)
    expect(html).toContain('Sign in again — 2 changes waiting')
    expect(html).toContain(SIGN_IN_AGAIN_HINT.replace(/'/g, '&#x27;'))
    expect(html).not.toContain('Sending')
    // With no signal the signal words win: nothing was tried, so nothing is known about the sign-in.
    expect(renderToStaticMarkup(<SignalStrip offline waiting={2} refused={0} authNeeded />)).not.toContain('Sign in again')
    // Nothing waiting: nothing to sign in for.
    expect(renderToStaticMarkup(<SignalStrip offline={false} waiting={0} refused={0} authNeeded />)).toBe('')
  })
})

describe('ChangesWaiting', () => {
  const ops = [
    op({ seq: 1, body: { kind: 'add_line', lineId: 'line-1', itemId: 'A016', quantity: 2, option: 'A' } }),
    op({ seq: 2, body: { kind: 'edit_line', lineId: 'line-1', patch: { quantity: 3 }, expected: { quantity: 2 } }, attempts: 1, lastError: 'Failed to fetch' }),
    op({ seq: 3, body: { kind: 'set_discount', type: 'senior', percent: null }, status: 'delivered' }),
    op({ seq: 4, body: { kind: 'set_mode', exclusive: true }, status: 'refused', refusal: 'Estimate 2026-1098 from this draft is SIGNED.' }),
  ]
  const render = (rows: QuoteOpRecord[], startOpen = true) =>
    renderToStaticMarkup(<ChangesWaiting ops={rows} lookup={lookup} busy={false} onDiscard={async () => 'gone'} startOpen={startOpen} />)

  it('renders nothing when nothing waits', () => {
    expect(render([])).toBe('')
  })
  it('counts only what has not reached the office, and starts closed behind one line', () => {
    const html = render(ops, false)
    expect(html).toContain('Changes waiting (3)')
    expect(html).toContain('tap to open')
    expect(html).not.toContain('Discard')
  })
  it('open: each change in words with where it stands, and a Discard on each one that can go', () => {
    const html = render(ops)
    expect(html).toContain('Added Single-pole switch ×2 to Option A')
    expect(html).toContain('Single-pole switch: quantity → 3')
    expect(html).toContain('Waiting for signal — last try: Failed to fetch')
    expect(html).toContain('Discount: Senior 5%')
    expect(html).toContain('Reached the office — waiting for its prices')
    expect(html).toContain('Refused by the office: Estimate 2026-1098 from this draft is SIGNED.')
    expect((html.match(/>Discard</g) ?? []).length).toBe(4)
    // The queued and the refused can be discarded; the one the office already took cannot — greyed WITH why.
    expect((html.match(/disabled=""/g) ?? []).length).toBe(1)
    expect(html).toContain('title="This change already reached the office — it can only be changed there now."')
  })
  it('the start of a phone-only quote is not discarded one change at a time — the exit is "Delete this quote", and the button says so', () => {
    const html = render([op({ seq: 1, body: { kind: 'start_quote', title: 'Quote — Hollis' } })])
    expect(html).toContain('Started this quote on this phone')
    // The reason carries quotes, which the markup escapes.
    expect(html).toContain(`title="${DISCARD_START_REASON.replace(/"/g, '&quot;')}"`)
    expect(html).toContain('disabled=""')
  })
  it('never prints a dollar figure', () => {
    expect(render(ops)).not.toMatch(/\$\d/)
  })
})

describe('lineFigureWords — the label under a line\'s figure (design §3)', () => {
  it("the office's own figure gets no label; a preview says Preview; wire says it may come down; unpriced says why", () => {
    expect(lineFigureWords({ priceStatus: 'office', priceReason: null })).toBeNull()
    expect(lineFigureWords({ priceStatus: 'preview', priceReason: null })).toBe('Preview')
    expect(lineFigureWords({ priceStatus: 'mayComeDown', priceReason: MAY_COME_DOWN })).toBe(MAY_COME_DOWN)
    expect(lineFigureWords({ priceStatus: 'unpriced', priceReason: 'No price is published for this item at this difficulty — the office prices it' })).toBe('No price is published for this item at this difficulty — the office prices it')
    expect(lineFigureWords({ priceStatus: 'unpriced', priceReason: null })).toBe(PRICED_WHEN_SIGNAL_RETURNS)
  })
})

describe('PriceBookAge and the words', () => {
  it('says when the book was saved on this phone, or that none is', () => {
    expect(renderToStaticMarkup(<PriceBookAge cachedAt={null} />)).toContain(NO_SAVED_BOOK)
    const html = renderToStaticMarkup(<PriceBookAge cachedAt="2026-10-09T13:02:00.000Z" />)
    expect(html).toContain('Price book saved on this phone at ')
    expect(renderToStaticMarkup(<PriceBookAge cachedAt="2026-10-09T13:02:00.000Z" what="Prices" />)).toContain('Prices saved on this phone at ')
  })
  it('savedAtWords: a time for today, a date and time otherwise; an unreadable stamp comes back as it was', () => {
    const today = new Date()
    today.setHours(7, 2, 0, 0)
    expect(savedAtWords(today.toISOString())).toMatch(/7:02/)
    expect(savedAtWords(today.toISOString())).not.toMatch(/\d{4}/)
    expect(savedAtWords('2025-01-05T13:02:00.000Z')).toMatch(/Jan/)
    expect(savedAtWords('not a date')).toBe('not a date')
  })
  it('the greyed reasons read as sentences a tech can act on', () => {
    expect(OFFLINE_ISSUE_REASON).toBe('Needs signal — the estimate number and final price come from the office')
    expect(sendingIssueReason(1)).toBe('Sending 1 change to the office — issue once it has landed')
    expect(sendingIssueReason(3)).toBe('Sending 3 changes to the office — issue once they have landed')
    expect(waitForChangesReason(2)).toBe('Wait for your 2 waiting changes to reach the office first')
    expect(waitForChangesReason(0)).toBe("Wait for the office's answer to your changes first")
  })
})
