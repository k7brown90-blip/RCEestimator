/**
 * The picker's pieces (2026-10-08, Phase 2 unit C): the same gap badges the office sees, worded the
 * same, with NO hours; section cards; and the greying-with-a-reason on a signed quote. The picker
 * itself is stateful and fetches, so its first screen and its parts are what is rendered here.
 */

import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { CatalogBadges, CatalogResultList, QuoteCatalogPicker, SectionCards } from './QuoteCatalogPicker'
import type { QuoteCatalogRow } from '../../lib/crmSync'

const SIGNED = 'Estimate 2026-1098 from this draft is SIGNED. A signed agreement is never edited — raise a change order instead.'

const row = (over: Partial<QuoteCatalogRow> = {}): QuoteCatalogRow => ({
  itemId: 'A016', description: 'Duplex receptacle', category: 'DEVICES', unit: 'ea', isAssembly: false,
  hasLabourUnitBasis: true, hasPriceAtActiveSupplier: true, isFlatPriced: false, isContinuousLength: false,
  hasPublishedLabour: true, sellsMaterial: true, isHourlyProduct: false, ...over,
})

describe('CatalogBadges', () => {
  it('a clean item has no badges at all', () => {
    expect(renderToStaticMarkup(<CatalogBadges row={row()} />)).toBe('')
  })

  it("says what the office's browse says, in the same words", () => {
    const html = renderToStaticMarkup(
      <CatalogBadges row={row({ hasPriceAtActiveSupplier: false, hasPublishedLabour: false, isContinuousLength: true, isHourlyProduct: true, isAssembly: true })} />,
    )
    for (const words of ['no price at supplier', 'no labour hours', 'measured length', 'by the hour', 'assembly']) {
      expect(html).toContain(words)
    }
  })

  it('no unit basis is called out only when there ARE hours (otherwise "no labour hours" already says it)', () => {
    expect(renderToStaticMarkup(<CatalogBadges row={row({ hasLabourUnitBasis: false })} />)).toContain('no labour unit basis')
    const none = renderToStaticMarkup(<CatalogBadges row={row({ hasLabourUnitBasis: false, hasPublishedLabour: false })} />)
    expect(none).not.toContain('no labour unit basis')
  })

  it('a flat-priced item (the permit fee) is never badged "no price at supplier"', () => {
    const html = renderToStaticMarkup(<CatalogBadges row={row({ hasPriceAtActiveSupplier: false, isFlatPriced: true })} />)
    expect(html).not.toContain('no price at supplier')
  })

  it('never prints an hours figure', () => {
    const html = renderToStaticMarkup(<CatalogBadges row={row({ hasPublishedLabour: false })} />)
    expect(html).not.toMatch(/\d\s*(hr|hours)/i)
  })
})

describe('CatalogResultList', () => {
  const list = (over: Partial<Parameters<typeof CatalogResultList>[0]> = {}) =>
    renderToStaticMarkup(
      <CatalogResultList rows={[row(), row({ itemId: 'EV1', description: 'Hardwired EV charger', isAssembly: true })]} loading={false} truncated={false} total={2}
        disabledReason={null} busy={false} addInto="B" emptyText="Nothing here." onPick={() => {}} {...over} />,
    )

  it('each item says which option it will land in; an assembly is badged', () => {
    const html = list()
    expect(html).toContain('title="Add to Option B"')
    expect(html).toContain('Hardwired EV charger')
    expect(html).toContain('assembly')
  })

  it('a SIGNED quote greys every item with the reason, and still lists them', () => {
    const html = list({ disabledReason: SIGNED })
    expect((html.match(/disabled=""/g) ?? []).length).toBe(2)
    expect((html.match(new RegExp(`title="${SIGNED}"`, 'g')) ?? []).length).toBe(2)
    expect(html).toContain('Duplex receptacle')
  })

  it('says when more matched than are shown, and how to narrow it', () => {
    const html = list({ truncated: true, total: 140 })
    expect(html).toContain('Showing 2 of 140')
  })

  it('an empty list says so', () => {
    expect(list({ rows: [], emptyText: 'Nothing in this section.' })).toContain('Nothing in this section.')
  })
})

describe('SectionCards', () => {
  it('one card per section with its item count', () => {
    const html = renderToStaticMarkup(
      <SectionCards sections={[{ section: 'NM CABLE', itemCount: 12 }, { section: 'OLD WORK BOXES', itemCount: 1 }]} disabledReason={null} onPick={() => {}} />,
    )
    expect(html).toContain('NM CABLE')
    expect(html).toContain('12 item(s)')
    expect(html).toContain('OLD WORK BOXES')
    expect(html).not.toContain('disabled=""')
  })

  it('greyed with the reason on a signed quote', () => {
    const html = renderToStaticMarkup(<SectionCards sections={[{ section: 'NM CABLE', itemCount: 12 }]} disabledReason={SIGNED} onPick={() => {}} />)
    expect(html).toContain('disabled=""')
    expect(html).toContain(`title="${SIGNED}"`)
  })
})

describe('QuoteCatalogPicker, first screen', () => {
  const render = (lockedReason: string | null) =>
    renderToStaticMarkup(
      <QuoteCatalogPicker search="" onSearch={() => {}} lockedReason={lockedReason} busy={false} addInto="C" onPick={async () => true} onError={() => {}} />,
    )

  it('an open quote: the search box and a "Browse by section" button, both live', () => {
    const html = render(null)
    expect(html).toContain('Search the price book')
    expect(html).toContain('adds to Option C')
    expect(html).toContain('Browse by section')
    expect(html).not.toContain('disabled=""')
  })

  it('a SIGNED quote greys search and browse, each carrying the reason', () => {
    const html = render(SIGNED)
    expect((html.match(/disabled=""/g) ?? []).length).toBe(2)
    expect((html.match(new RegExp(`title="${SIGNED}"`, 'g')) ?? []).length).toBe(2)
    expect(html).toContain('Browse by section')
  })
})

// ─── Phase 7 U5 (2026-10-10): the picker with no signal reads the book saved on this phone ────────

describe('QuoteCatalogPicker, first screen with no signal', () => {
  it('is the same search box and "Browse by section" — the saved book answers behind them', () => {
    const html = renderToStaticMarkup(
      <QuoteCatalogPicker search="" onSearch={() => {}} lockedReason={null} busy={false} addInto="A" onPick={async () => true} onError={() => {}} offline />,
    )
    expect(html).toContain('Search the price book')
    expect(html).toContain('Browse by section')
    expect(html).not.toContain('disabled=""')
  })
})
