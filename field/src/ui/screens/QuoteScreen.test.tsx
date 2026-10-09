/**
 * The Quote screen's per-line row (2026-10-08, one-estimating-system plan, Phase 2, unit A): on a
 * SIGNED quote every control on the row — quantity, difficulty, option, remove — is greyed with the
 * server's reason as its tooltip, never hidden. (Phase 1 left these live on a signed quote, so the
 * tech could press them and get a refusal. The reason itself is printed once at the top of the
 * screen; the screen is stateful and fetches, so the row is what is rendered here.)
 */

import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { LineRow } from './QuoteScreen'
import type { QuoteLine } from '../../lib/crmSync'

const SIGNED = 'Estimate 2026-1098 from this draft is SIGNED. A signed agreement is never edited — raise a change order instead.'

const line: QuoteLine = {
  id: 'l1', itemId: 'item-1', description: 'Replace panel', quantity: 1, quantitySource: 'COUNT',
  difficulty: 'NORMAL', option: 'A', note: null, location: null, lineTotal: 1200, gaps: [],
}

const render = (lockedReason: string | null, busy = false, l: QuoteLine = line) =>
  renderToStaticMarkup(
    <LineRow line={l} busy={busy} lockedReason={lockedReason} letters={['A', 'B', 'C']} allowNegative={false} onPatch={() => {}} onRemove={() => {}} />,
  )

describe('LineRow', () => {
  it('an open quote: every control is live', () => {
    const html = render(null)
    expect(html).not.toContain('disabled=""')
    expect(html).toContain('remove')
  })

  it('a SIGNED quote greys quantity, difficulty, option, location, note and remove, each carrying the reason', () => {
    const html = render(SIGNED)
    expect((html.match(/disabled=""/g) ?? []).length).toBe(6)
    expect((html.match(new RegExp(`title="${SIGNED}"`, 'g')) ?? []).length).toBe(6)
    // Greyed, not hidden: the controls are still on the page.
    expect(html).toContain('remove')
    expect(html).toContain('Option A')
  })

  it('a call in flight greys the row without claiming the quote is signed', () => {
    const html = render(null, true)
    expect((html.match(/disabled=""/g) ?? []).length).toBe(6)
    expect(html).not.toContain('SIGNED')
  })

  it("shows the line's location and note, labelled, so the tech sees what the customer will read", () => {
    const html = render(null, false, { ...line, location: 'Garage', note: 'Assessment finding: double-tapped breaker' })
    expect(html).toContain('Location')
    expect(html).toContain('value="Garage"')
    expect(html).toContain('Note')
    expect(html).toContain('value="Assessment finding: double-tapped breaker"')
  })

  it('a line with neither shows empty boxes with a hint, still editable', () => {
    const html = render(null)
    expect(html).toContain('placeholder="kitchen, garage…"')
    expect(html).toContain('Location')
  })
})
