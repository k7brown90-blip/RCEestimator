/**
 * Quote in the field (Kyle, 2026-09-01, step 4 of the service call): build the
 * estimate in the driveway from the SAME price book and engine as the office.
 *
 * The flow mirrors the day: search the book, add lines (difficulty and A/B/C
 * options per line), watch the same totals the office would see, then ISSUE —
 * the customer signs on their own phone from the customer page link, and the
 * deposit QR is one tap away on the job screen. Gaps are shown per line before
 * issue, because the graduation gate will refuse them with the same words.
 *
 * Needs signal, deliberately: prices are the office's live book, and a quote
 * built against a stale cached book is a wrong promise.
 */

import { useEffect, useRef, useState } from 'react'
import {
  addQuoteLine,
  editQuoteLine,
  fetchPropertyFindings,
  fetchQuote,
  issueQuote,
  openQuoteForVisit,
  removeQuoteLine,
  searchQuoteCatalog,
  type QuoteCatalogRow,
  type QuoteLine,
  type QuoteState,
} from '../../lib/crmSync'
import type { FindingRecord } from '../../db/database'

interface Props {
  visitId: string
  propertyId: string
  customerName: string
  onBack: () => void
}

const money = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `$${n.toFixed(2)}`)
const DIFFS = ['NORMAL', 'DIFFICULT', 'VERY_DIFFICULT'] as const
const DIFF_LABEL = { NORMAL: 'Normal', DIFFICULT: 'Difficult', VERY_DIFFICULT: 'Very difficult' } as const

function LineRow({ line, busy, onPatch, onRemove }: {
  line: QuoteLine
  busy: boolean
  onPatch: (patch: Parameters<typeof editQuoteLine>[1]) => void
  onRemove: () => void
}) {
  const [qty, setQty] = useState(String(line.quantity))
  useEffect(() => setQty(String(line.quantity)), [line.quantity])
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-800 p-3">
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm font-medium text-white">{line.description}</span>
        <span className="shrink-0 text-sm font-semibold text-emerald-300">{money(line.lineTotal)}</span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        <input
          className="w-20 rounded border border-slate-600 bg-slate-900 p-2 text-white"
          type="number"
          inputMode="decimal"
          min={0.01}
          value={qty}
          disabled={busy}
          onChange={(e) => setQty(e.target.value)}
          onBlur={() => {
            const n = Number(qty)
            if (Number.isFinite(n) && n > 0 && n !== line.quantity) onPatch({ quantity: n })
            else setQty(String(line.quantity))
          }}
        />
        <select
          className="rounded border border-slate-600 bg-slate-900 p-2 text-white"
          value={line.difficulty}
          disabled={busy}
          onChange={(e) => onPatch({ difficulty: e.target.value as QuoteLine['difficulty'] })}
        >
          {DIFFS.map((d) => <option key={d} value={d}>{DIFF_LABEL[d]}</option>)}
        </select>
        <select
          className="rounded border border-slate-600 bg-slate-900 p-2 text-white"
          value={line.option}
          disabled={busy}
          onChange={(e) => onPatch({ option: e.target.value as QuoteLine['option'] })}
        >
          {(['A', 'B', 'C'] as const).map((o) => <option key={o} value={o}>Option {o}</option>)}
        </select>
        <button type="button" disabled={busy} onClick={onRemove} className="ml-auto text-red-300 underline">
          remove
        </button>
      </div>
      {line.gaps.length > 0 && (
        <ul className="mt-2 space-y-1">
          {line.gaps.map((g, i) => (
            <li key={i} className="rounded bg-amber-950/50 p-2 text-[11px] text-amber-200">{g}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function QuoteScreen({ visitId, propertyId, customerName, onBack }: Props) {
  const [draftId, setDraftId] = useState<string | null>(null)
  const [quote, setQuote] = useState<QuoteState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [search, setSearch] = useState('')
  const [results, setResults] = useState<QuoteCatalogRow[] | null>(null)
  const [issued, setIssued] = useState<{ number: string; customerUrl: string; unpriced: string[] } | null>(null)
  const [issueReasons, setIssueReasons] = useState<string[]>([])
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /*
    Open item 2 (2026-09-01): what the assessment found offers itself while
    quoting. A finding is NOT a price-book row, so nothing is auto-mapped —
    tapping one seeds the search with its words, and the next line added
    carries the finding as its note, so the estimate line says WHY it exists.
  */
  const [findings, setFindings] = useState<FindingRecord[]>([])
  const [findingsOpen, setFindingsOpen] = useState(false)
  const [activeFinding, setActiveFinding] = useState<FindingRecord | null>(null)
  useEffect(() => {
    fetchPropertyFindings(propertyId)
      .then((r) => setFindings(r.findings.filter((f) => f.status === 'open' || f.status === 'scheduled')))
      .catch(() => setFindings([]))
  }, [propertyId])

  const refresh = async (id: string) => setQuote(await fetchQuote(id))

  useEffect(() => {
    openQuoteForVisit(visitId)
      .then(async ({ draftId }) => { setDraftId(draftId); await refresh(draftId) })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visitId])

  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current)
    if (search.trim().length < 2) { setResults(null); return }
    searchTimer.current = setTimeout(() => {
      searchQuoteCatalog(search.trim())
        .then((r) => setResults(r.atomics))
        .catch((err) => setError(err instanceof Error ? err.message : String(err)))
    }, 300)
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current) }
  }, [search])

  const act = async (fn: () => Promise<unknown>) => {
    if (!draftId) return
    setBusy(true)
    setError(null)
    try { await fn(); await refresh(draftId) }
    catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setBusy(false) }
  }

  if (issued) {
    return (
      <div className="mx-auto max-w-xl space-y-4 p-6">
        <h1 className="text-xl font-semibold text-white">Estimate {issued.number} issued</h1>
        {issued.unpriced.length > 0 && (
          <p className="rounded bg-amber-950/60 p-3 text-xs text-amber-200">
            Heads up — these lines froze at $0 (no price in the book): {issued.unpriced.join(', ')}.
            The estimate is cheaper than the work by whatever they are worth.
          </p>
        )}
        <p className="text-sm text-slate-300">
          Hand the customer your phone or share the link — they review and sign on their own screen.
          The deposit QR is on the job screen the moment it&apos;s signed.
        </p>
        <a
          href={issued.customerUrl}
          target="_blank"
          rel="noreferrer"
          className="block w-full rounded-lg bg-sky-600 p-3 text-center text-sm font-medium text-white"
        >
          Open the customer&apos;s estimate to review &amp; sign
        </a>
        {typeof navigator.share === 'function' && (
          <button
            type="button"
            className="w-full rounded-lg border border-slate-600 p-3 text-sm text-slate-200"
            onClick={() => void navigator.share({ title: `Estimate ${issued.number} — Red Cedar Electric`, url: issued.customerUrl }).catch(() => {})}
          >
            Share the link to their phone
          </button>
        )}
        <button type="button" onClick={onBack} className="w-full rounded-lg border border-slate-700 p-3 text-sm text-slate-300">
          Back to the job
        </button>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-xl space-y-4 p-6">
      <button type="button" onClick={onBack} className="text-sm text-sky-300 underline">← Job site</button>
      <header>
        <h1 className="text-xl font-semibold text-white">Quote — {customerName}</h1>
        <p className="text-xs text-slate-400">Same book, same prices, same gates as the office.</p>
      </header>

      {error && <p className="rounded bg-red-950/60 p-2 text-xs text-red-200">{error}</p>}
      {quote?.rateProvisional && (
        <p className="rounded bg-amber-950/60 p-2 text-xs text-amber-200">
          PROVISIONAL labour rate — the office has to settle the rate before this can be issued.
        </p>
      )}

      <input
        className="w-full rounded-lg border border-slate-600 bg-slate-800 p-3 text-sm text-white"
        placeholder="Search the price book… (2+ letters)"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      {findings.length > 0 && (
        <div className="space-y-1 rounded-lg border border-amber-800 bg-amber-950/20 p-2">
          <button
            type="button"
            onClick={() => setFindingsOpen((o) => !o)}
            className="w-full text-left text-xs font-medium text-amber-200"
          >
            ⚡ {findings.length} open finding{findings.length > 1 ? 's' : ''} at this address — tap one to quote it
          </button>
          {findingsOpen && findings.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => {
                setActiveFinding(f)
                setFindingsOpen(false)
                // Seed the book search with the finding's own words; the tech
                // trims it to the term that matches how the book names things.
                setSearch(f.title.split(/[—:-]/)[0].trim().slice(0, 40))
              }}
              className={`block w-full rounded p-2 text-left text-xs ${activeFinding?.id === f.id ? 'bg-amber-900/60 text-amber-100' : 'text-amber-200 hover:bg-amber-950/40'}`}
            >
              {f.critical ? '⚠ ' : ''}{f.title}
              <span className="block text-[10px] text-amber-400/70">{f.severity}{f.section ? ` · ${f.section}` : ''}</span>
            </button>
          ))}
          {activeFinding && (
            <p className="rounded bg-slate-900/70 p-2 text-[11px] text-slate-300">
              Quoting: <b className="text-amber-200">{activeFinding.title}</b> — the next item you add
              carries it as the line note.{' '}
              <button type="button" className="underline" onClick={() => setActiveFinding(null)}>clear</button>
            </p>
          )}
        </div>
      )}

      {results !== null && (
        <div className="max-h-72 space-y-1 overflow-y-auto rounded-lg border border-slate-700 bg-slate-900 p-2">
          {results.length === 0 && <p className="p-2 text-xs text-slate-500">Nothing in the book matches.</p>}
          {results.map((r) => (
            <button
              key={r.itemId}
              type="button"
              disabled={busy}
              onClick={() => {
                setSearch(''); setResults(null)
                const note = activeFinding ? `Assessment finding: ${activeFinding.title}` : undefined
                setActiveFinding(null)
                void act(() => addQuoteLine(draftId!, {
                  itemId: r.itemId,
                  quantity: 1,
                  quantitySource: r.isContinuousLength ? 'MEASURED_LENGTH' : 'COUNT',
                  ...(note ? { note } : {}),
                }))
              }}
              className="block w-full rounded p-2 text-left text-sm text-slate-200 hover:bg-slate-800"
            >
              {r.description ?? r.itemId}
              <span className="block text-[11px] text-slate-500">
                {r.unit ? `per ${r.unit}` : 'each'}
                {r.isHourlyProduct ? ' · quantity is HOURS' : ''}
                {r.isContinuousLength ? ' · measured length' : ''}
                {!r.hasPublishedLabour && !r.isFlatPriced ? ' · ⚠ no labour published' : ''}
                {r.sellsMaterial && !r.hasPriceAtActiveSupplier && !r.isFlatPriced ? ' · ⚠ no supplier price' : ''}
              </span>
            </button>
          ))}
        </div>
      )}

      <section className="space-y-2">
        {quote === null && !error && <p className="text-xs text-slate-500">Loading the quote…</p>}
        {quote?.lines.length === 0 && (
          <p className="rounded-lg border border-slate-700 bg-slate-800/60 p-4 text-sm text-slate-400">
            No lines yet — search the book above and tap an item to add it.
          </p>
        )}
        {quote?.lines.map((l) => (
          <LineRow
            key={l.id}
            line={l}
            busy={busy}
            onPatch={(patch) => void act(() => editQuoteLine(l.id, patch))}
            onRemove={() => void act(() => removeQuoteLine(l.id))}
          />
        ))}
      </section>

      {quote && quote.lines.length > 0 && (
        <section className="space-y-1 rounded-lg border border-slate-700 bg-slate-800/70 p-3 text-sm">
          {quote.options.filter((o) => o.lineCount > 0).map((o) => (
            <p key={o.option} className="flex justify-between text-slate-300">
              <span>Option {o.option} · {o.lineCount} line{o.lineCount > 1 ? 's' : ''} · {o.laborHours.toFixed(2)} hr</span>
              <span className={o.complete ? '' : 'text-amber-300'}>{o.complete ? money(o.subtotal) : 'incomplete'}</span>
            </p>
          ))}
          <p className="flex justify-between border-t border-slate-600 pt-1 font-semibold text-white">
            <span>Total (all options)</span><span>{money(quote.total)}</span>
          </p>
        </section>
      )}

      {issueReasons.length > 0 && (
        <ul className="space-y-1">
          {issueReasons.map((r, i) => (
            <li key={i} className="rounded bg-amber-950/60 p-2 text-xs text-amber-200">{r}</li>
          ))}
        </ul>
      )}

      {quote && quote.lines.length > 0 && (
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setBusy(true)
            setIssueReasons([])
            issueQuote(draftId!)
              .then((r) => setIssued(r))
              .catch((err) => {
                const body = (err as { body?: { reasons?: string[] } }).body
                if (body?.reasons?.length) setIssueReasons(body.reasons)
                else setError(err instanceof Error ? err.message : String(err))
              })
              .finally(() => setBusy(false))
          }}
          className="w-full rounded-lg bg-emerald-700 p-3 text-sm font-semibold text-white disabled:opacity-50"
        >
          Issue the estimate — freezes prices, customer signs next
        </button>
      )}
    </div>
  )
}
