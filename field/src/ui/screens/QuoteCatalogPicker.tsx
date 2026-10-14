/**
 * The Quote screen's price-book picker: search it, or browse it by section (Kyle, 2026-10-08, "one
 * estimating system" — Phase 2 unit C; 2026-09-24 field-estimate-parity Unit D).
 *
 * The office's Estimate Intake has a search box AND section cards (BrowseTab in
 * PriceBookIntakePage.tsx). The phone had the search box only: two letters, thirty results, no way
 * to look around. This is the phone's twin, worded the same ("Search the price book", "← All
 * sections", "no price at supplier", "no labour hours", "by the hour") and fed by the same server
 * browse. Assemblies are rows of that same book, so they appear in both lists with an "assembly"
 * badge, and adding one is the same call as adding anything else.
 *
 * NO HOURS HERE. The badges say that labour hours are missing, never how many — the server takes the
 * workbook's hours and Red Cedar's supplier cost off every row it sends this screen, because the
 * technician hands the phone to the customer (constants.md "Field app").
 *
 * WITH NO SIGNAL (Phase 7 unit U5, 2026-10-10): the same search and the same section cards, over the
 * price book saved on this phone at the Today screen (lib/quoteSync.ts syncQuoteCatalog). The test is
 * the shared one the server runs (shared/quoteCatalog.ts matchesCatalogSearch / inSection), the rows
 * come in the server's order, and the list is cut at the same page size (CACHED_CATALOG_PAGE, the
 * server's FIELD_CATALOG_LIMIT) — so the two read alike, and "Showing 60 of 140" means the same
 * thing. The book's age is always on screen while the saved copy is in use: "Price book saved on
 * this phone at 7:02 AM". A search that loses signal mid-way falls back to the saved copy and tells
 * the screen (onNetworkFailure); an HTTP refusal is never treated as no signal.
 *
 * Tapping an item adds it (quantity 1) to the option chosen in "Adding into"; quantity, difficulty,
 * place and note are then set on the line itself, as before.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  browseQuoteSection,
  fetchQuoteSections,
  isNetworkFailure,
  searchQuoteCatalog,
  type QuoteCatalogRow,
  type QuoteSection,
} from '../../lib/crmSync'
import { CACHED_CATALOG_PAGE, cachedCatalogMeta, searchCachedCatalog } from '../../lib/quoteSync'
import type { EstimateOptionLetter } from '../../../../shared/estimateOptions'
import { PriceBookAge } from './QuoteOffline'

/** The same gap badges the office sees before it adds a line — worded alike, hours never shown. */
export function CatalogBadges({ row }: { row: QuoteCatalogRow }) {
  const badges: Array<{ text: string; tone: 'amber' | 'red' | 'sky' }> = []
  // Not on a flat-priced row: the permit fee buys nothing from a supplier and prices at Kyle's own
  // $200 — the badge told him it would not price (2026-08-22). A labour product buys nothing either.
  if (row.sellsMaterial && !row.hasPriceAtActiveSupplier && !row.isFlatPriced) badges.push({ text: 'no price at supplier', tone: 'amber' })
  if (!row.hasPublishedLabour) badges.push({ text: 'no labour hours', tone: 'red' })
  if (!row.hasLabourUnitBasis && row.hasPublishedLabour) badges.push({ text: 'no labour unit basis', tone: 'amber' })
  if (row.isContinuousLength) badges.push({ text: 'measured length', tone: 'sky' })
  if (row.isHourlyProduct) badges.push({ text: 'by the hour', tone: 'sky' })
  if (row.isAssembly) badges.push({ text: 'assembly', tone: 'sky' })
  if (badges.length === 0) return null
  const tone = {
    amber: 'bg-amber-950/60 text-amber-200',
    red: 'bg-red-950/60 text-red-200',
    sky: 'bg-sky-950/60 text-sky-200',
  }
  return (
    <span className="mt-1 flex flex-wrap gap-1">
      {badges.map((b) => (
        <span key={b.text} className={`rounded px-1.5 py-0.5 text-[11px] ${tone[b.tone]}`}>{b.text}</span>
      ))}
    </span>
  )
}

/** A list of catalog rows to tap. Greyed WITH the reason (a signed quote), never hidden. */
export function CatalogResultList({ rows, loading, truncated, total, disabledReason, busy, addInto, emptyText, onPick }: {
  rows: QuoteCatalogRow[]
  loading: boolean
  truncated: boolean
  total: number
  disabledReason: string | null
  busy: boolean
  addInto: EstimateOptionLetter
  emptyText: string
  onPick: (row: QuoteCatalogRow) => void
}) {
  return (
    <div className="max-h-72 space-y-1 overflow-y-auto rounded-lg border border-slate-700 bg-slate-900 p-2">
      {loading && <p className="p-2 text-xs text-slate-400">Loading…</p>}
      {!loading && rows.length === 0 && <p className="p-2 text-xs text-slate-500">{emptyText}</p>}
      {rows.map((r) => (
        <button
          key={r.itemId}
          type="button"
          disabled={busy || Boolean(disabledReason)}
          title={disabledReason ?? `Add to Option ${addInto}`}
          onClick={() => onPick(r)}
          className="block w-full rounded p-2 text-left text-sm text-slate-200 hover:bg-slate-800 disabled:opacity-50"
        >
          {r.description ?? r.itemId}
          <span className="block text-[11px] text-slate-500">{r.unit ? `per ${r.unit}` : 'each'}</span>
          <CatalogBadges row={r} />
        </button>
      ))}
      {truncated && (
        <p className="p-2 text-[11px] text-slate-400">
          Showing {rows.length} of {total} — type a few letters in the search box to narrow it.
        </p>
      )}
    </div>
  )
}

/** The section cards: Kyle's own price-book sections and how many items each holds. */
export function SectionCards({ sections, disabledReason, onPick }: {
  sections: QuoteSection[]
  disabledReason: string | null
  onPick: (section: string) => void
}) {
  if (sections.length === 0) return <p className="text-xs text-slate-500">The price book is empty.</p>
  return (
    <div className="grid grid-cols-2 gap-2">
      {sections.map((c) => (
        <button
          key={c.section}
          type="button"
          disabled={Boolean(disabledReason)}
          title={disabledReason ?? undefined}
          onClick={() => onPick(c.section)}
          className="rounded-lg border border-slate-700 bg-slate-800 p-3 text-left disabled:opacity-50"
        >
          <span className="block text-sm font-semibold leading-tight text-white">{c.section}</span>
          <span className="mt-1 block text-[11px] text-slate-400">{c.itemCount} item(s)</span>
        </button>
      ))}
    </div>
  )
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err))

type Page = { rows: QuoteCatalogRow[]; truncated: boolean; total: number }

export function QuoteCatalogPicker({ search, onSearch, lockedReason, busy, addInto, onPick, onError, offline = false, onNetworkFailure, children }: {
  search: string
  onSearch: (v: string) => void
  /** The server's reason this quote is shut (signed), or null. Greys search, browse and every result. */
  lockedReason: string | null
  busy: boolean
  addInto: EstimateOptionLetter
  /** Adds the item; resolves true when it landed (so the picker can say so). */
  onPick: (row: QuoteCatalogRow) => Promise<boolean>
  onError: (message: string) => void
  /** The screen knows the phone has no signal: read the saved book, never ask the server. */
  offline?: boolean
  /** A live search got no answer (fetch threw): the picker fell back to the saved book and the screen should know. */
  onNetworkFailure?: () => void
  /** Rendered between the search box and the lists (the assessment findings). */
  children?: ReactNode
}) {
  const [searchRows, setSearchRows] = useState<Page | null>(null)
  const [browsing, setBrowsing] = useState(false)
  const [sections, setSections] = useState<QuoteSection[] | null>(null)
  const [section, setSection] = useState<string | null>(null)
  const [sectionRows, setSectionRows] = useState<Page | null>(null)
  const [added, setAdded] = useState<string | null>(null)
  // The last list came from the book saved on this phone (no signal, or signal lost mid-search).
  const [fromSaved, setFromSaved] = useState(false)
  // When the saved book was saved — undefined until read; null when nothing is saved.
  const [savedAt, setSavedAt] = useState<string | null | undefined>(undefined)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searching = search.trim().length >= 2

  const usingSaved = offline || fromSaved
  useEffect(() => {
    if (!usingSaved) return
    cachedCatalogMeta().then((m) => setSavedAt(m?.cachedAt ?? null)).catch(() => setSavedAt(null))
  }, [usingSaved])

  /**
   * Live first unless the phone knows it has no signal; on NO ANSWER (fetch threw) the saved book
   * answers instead and the screen is told. A refusal is reported as before and nothing is substituted.
   */
  const liveOrSaved = async <T,>(live: () => Promise<T>, saved: () => Promise<T>): Promise<T> => {
    if (!offline) {
      try {
        const r = await live()
        setFromSaved(false)
        return r
      } catch (err) {
        if (!isNetworkFailure(err)) throw err
        onNetworkFailure?.()
      }
    }
    const r = await saved()
    setFromSaved(true)
    return r
  }
  const page = (r: { atomics: QuoteCatalogRow[]; truncated: boolean; total: number }): Page => ({ rows: r.atomics, truncated: r.truncated, total: r.total })

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current)
    if (!searching) { setSearchRows(null); return }
    timer.current = setTimeout(() => {
      const term = search.trim()
      liveOrSaved(
        () => searchQuoteCatalog(term),
        () => searchCachedCatalog({ search: term, limit: CACHED_CATALOG_PAGE }),
      )
        .then((r) => setSearchRows(page(r)))
        .catch((err) => onError(errText(err)))
    }, 300)
    return () => { if (timer.current) clearTimeout(timer.current) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, offline])

  const openBrowse = () => {
    setBrowsing(true)
    setAdded(null)
    if (sections === null) {
      liveOrSaved(
        () => fetchQuoteSections().then((r) => r.sections),
        () => cachedCatalogMeta().then((m) => m?.sections ?? []),
      )
        .then(setSections)
        .catch((err) => { setBrowsing(false); onError(errText(err)) })
    }
  }
  const openSection = (name: string) => {
    setSection(name)
    setSectionRows(null)
    liveOrSaved(
      () => browseQuoteSection(name),
      () => searchCachedCatalog({ section: name, limit: CACHED_CATALOG_PAGE }),
    )
      .then((r) => setSectionRows(page(r)))
      .catch((err) => { setSection(null); onError(errText(err)) })
  }
  const pick = async (row: QuoteCatalogRow) => {
    const ok = await onPick(row)
    if (!ok) return
    setAdded(`Added ${row.description ?? row.itemId} to Option ${addInto}.`)
    // A search starts over (as it always did); a section stays open so several items can be added.
    if (searching) onSearch('')
  }

  return (
    <div className="space-y-2">
      <input
        className="w-full rounded-lg border border-slate-600 bg-slate-800 p-3 text-sm text-white disabled:opacity-50"
        placeholder={lockedReason ? 'Adding is off — see the note above' : `Search the price book… (2+ letters) — adds to Option ${addInto}`}
        value={search}
        disabled={Boolean(lockedReason)}
        title={lockedReason ?? undefined}
        onChange={(e) => { setAdded(null); onSearch(e.target.value) }}
      />
      {/* The age of the saved book, always on screen while it is the one answering (design §3). */}
      {usingSaved && savedAt !== undefined && <PriceBookAge cachedAt={savedAt} />}
      {children}

      {added && <p className="rounded bg-emerald-950/50 p-2 text-xs text-emerald-200">{added}</p>}

      {searching && searchRows !== null && (
        <CatalogResultList
          rows={searchRows.rows}
          loading={false}
          truncated={searchRows.truncated}
          total={searchRows.total}
          disabledReason={lockedReason}
          busy={busy}
          addInto={addInto}
          emptyText={usingSaved ? 'Nothing in the book saved on this phone matches. Try the section cards instead.' : 'Nothing in the book matches. Try the section cards instead.'}
          onPick={(r) => void pick(r)}
        />
      )}

      {!searching && !browsing && (
        <button
          type="button"
          disabled={Boolean(lockedReason)}
          title={lockedReason ?? undefined}
          onClick={openBrowse}
          className="w-full rounded-lg border border-slate-600 bg-slate-800 p-3 text-sm font-medium text-sky-200 disabled:opacity-50"
        >
          Browse by section
        </button>
      )}

      {!searching && browsing && section === null && (
        <div className="space-y-2 rounded-lg border border-slate-700 bg-slate-900 p-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-300">Sections of the price book</span>
            <button type="button" className="text-xs text-sky-300 underline" onClick={() => setBrowsing(false)}>Close</button>
          </div>
          {sections === null
            ? <p className="p-2 text-xs text-slate-400">Loading the sections…</p>
            : <SectionCards sections={sections} disabledReason={lockedReason} onPick={openSection} />}
        </div>
      )}

      {!searching && browsing && section !== null && (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <button type="button" className="text-xs text-sky-300 underline" onClick={() => { setSection(null); setSectionRows(null) }}>← All sections</button>
            <span className="truncate text-xs font-medium text-slate-300">{section}</span>
          </div>
          <CatalogResultList
            rows={sectionRows?.rows ?? []}
            loading={sectionRows === null}
            truncated={sectionRows?.truncated ?? false}
            total={sectionRows?.total ?? 0}
            disabledReason={lockedReason}
            busy={busy}
            addInto={addInto}
            emptyText="Nothing in this section."
            onPick={(r) => void pick(r)}
          />
        </div>
      )}
    </div>
  )
}
