/**
 * My accounts (Kyle, 2026-09-01, ratified Option A): the properties this tech
 * has serviced — from their own assignments and inspections, never a customer
 * directory — with each address's assessment history and open findings.
 *
 * Read paths in this phase. The verbs that come later (revise an assessment,
 * start a service-call visit) will hang off the property view built here, so
 * the layout already leads with the history a tech needs at a repeat address.
 */

import { useEffect, useState } from 'react'
import {
  fetchInspectionFull,
  fetchMyProperties,
  fetchPropertyHistory,
  type InspectionFull,
  type MyProperty,
  type PropertyHistory,
} from '../../lib/crmSync'
import { OpenFindingsScreen } from './OpenFindingsScreen'

interface Props {
  onBack: () => void
  /**
   * Reopen an assessment pre-filled to correct it (Kyle, 2026-09-01). The
   * office supersedes the original and re-sends the corrected report — the
   * customer is never left holding an inaccurate calculation.
   */
  onRevise: (full: InspectionFull) => void
}

const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—'

export function MyAccountsScreen({ onBack, onRevise }: Props) {
  const [revising, setRevising] = useState<string | null>(null)
  const [list, setList] = useState<MyProperty[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState<MyProperty | null>(null)
  const [history, setHistory] = useState<PropertyHistory | null>(null)
  const [showFindings, setShowFindings] = useState(false)

  useEffect(() => {
    fetchMyProperties().then(setList).catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }, [])

  useEffect(() => {
    if (!active) { setHistory(null); return }
    let cancelled = false
    setHistory(null)
    fetchPropertyHistory(active.propertyId)
      .then((h) => { if (!cancelled) setHistory(h) })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)) })
    return () => { cancelled = true }
  }, [active])

  if (active && showFindings) {
    return (
      <OpenFindingsScreen
        propertyId={active.propertyId}
        addressLabel={`${active.address.line1}, ${active.address.city}`}
        onBack={() => setShowFindings(false)}
      />
    )
  }

  if (active) {
    return (
      <div className="mx-auto max-w-xl space-y-4 p-6">
        <button type="button" onClick={() => setActive(null)} className="text-sm text-sky-300 underline">
          ← My accounts
        </button>
        <header className="space-y-1">
          <h1 className="text-xl font-semibold text-white">{active.customerName}</h1>
          <p className="text-sm text-slate-300">{active.address.line1}</p>
          <p className="text-xs text-slate-400">
            {active.address.city}, {active.address.state} {active.address.postalCode}
          </p>
          {history?.property.customer.phone && (
            <p className="text-xs text-slate-400">📞 {history.property.customer.phone}</p>
          )}
        </header>

        <button
          type="button"
          onClick={() => setShowFindings(true)}
          className="w-full rounded-lg border border-amber-700 bg-amber-950/40 p-3 text-left text-sm text-amber-200"
        >
          Open findings at this address
          {active.openFindingCount > 0 ? ` (${active.openFindingCount})` : ''} →
        </button>

        <section className="space-y-2">
          <h2 className="text-sm font-medium text-slate-300">Assessments</h2>
          {!history && !error && <p className="text-xs text-slate-500">Loading…</p>}
          {history && history.inspections.length === 0 && (
            <p className="rounded-lg border border-slate-700 bg-slate-800/60 p-3 text-sm text-slate-400">
              No assessments on file for this address yet.
            </p>
          )}
          {history?.inspections.map((i) => (
            <div key={i.id} className="rounded-lg border border-slate-700 bg-slate-800 p-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-white">{fmtDate(i.date)}</span>
                <span className="text-xs text-slate-400">
                  {i.score !== null ? `score ${i.score}` : i.schemaVersion}
                  {i.mine ? ' · yours' : i.technicianName ? ` · ${i.technicianName}` : ''}
                </span>
              </div>
              <p className="mt-1 text-xs text-slate-400">
                {i.itemsAssessed} items · {i.passCount} pass · {i.monitorCount} monitor · {i.failCount} fail
                {i.hasLoadCalc ? ' · load calc ✓' : ''}
                {i.contractorReviewed ? ' · reviewed' : ''}
                {i.supersededById ? ' · superseded by a correction' : ''}
                {i.revisesId ? ' · correction' : ''}
              </p>
              {!i.supersededById && (
                <button
                  type="button"
                  disabled={revising !== null}
                  onClick={() => {
                    setRevising(i.id)
                    fetchInspectionFull(i.id)
                      .then((full) => onRevise(full))
                      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
                      .finally(() => setRevising(null))
                  }}
                  className="mt-2 w-full rounded-lg border border-sky-700 bg-sky-950/40 p-2 text-xs font-medium text-sky-200 disabled:opacity-50"
                >
                  {revising === i.id ? 'Opening…' : '✏️ Revise — reopens pre-filled; the corrected report is re-sent to the customer'}
                </button>
              )}
            </div>
          ))}
        </section>
        {error && <p className="rounded bg-red-950/60 p-2 text-xs text-red-200">{error}</p>}
      </div>
    )
  }

  const shown = (list ?? []).filter((p) => {
    const q = query.trim().toLowerCase()
    if (!q) return true
    return `${p.customerName} ${p.name} ${p.address.line1} ${p.address.city}`.toLowerCase().includes(q)
  })

  return (
    <div className="mx-auto max-w-xl space-y-4 p-6">
      <button type="button" onClick={onBack} className="text-sm text-sky-300 underline">
        ← Schedule
      </button>
      <header className="space-y-1">
        <h1 className="text-xl font-semibold text-white">My accounts</h1>
        <p className="text-xs text-slate-400">Every address you've been assigned to or assessed.</p>
      </header>
      <input
        className="w-full rounded-lg border border-slate-600 bg-slate-800 p-3 text-sm text-white"
        placeholder="Search name or address…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {error && <p className="rounded bg-red-950/60 p-2 text-xs text-red-200">{error}</p>}
      {list === null && !error && <p className="text-xs text-slate-500">Loading…</p>}
      {list !== null && shown.length === 0 && (
        <p className="rounded-lg border border-slate-700 bg-slate-800/60 p-4 text-sm text-slate-400">
          {query ? 'No account matches that search.' : 'No serviced accounts yet — they appear after your first assignment or assessment.'}
        </p>
      )}
      {shown.map((p) => (
        <button
          key={p.propertyId}
          type="button"
          onClick={() => setActive(p)}
          className="block w-full rounded-lg border border-slate-700 bg-slate-800 p-3 text-left"
        >
          <span className="flex items-center justify-between">
            <span className="font-medium text-white">{p.customerName}</span>
            <span className="text-xs text-slate-400">{fmtDate(p.lastServicedAt)}</span>
          </span>
          <span className="block text-sm text-slate-300">{p.address.line1}, {p.address.city}</span>
          <span className="mt-1 block text-xs text-slate-400">
            {p.latestInspection
              ? `Last assessment ${fmtDate(p.latestInspection.date)}${p.latestInspection.hasLoadCalc ? ' · load calc ✓' : ''}`
              : 'No assessment on file'}
            {p.openFindingCount > 0 && (
              <span className="text-amber-300"> · {p.openFindingCount} open finding{p.openFindingCount > 1 ? 's' : ''}</span>
            )}
          </span>
        </button>
      ))}
    </div>
  )
}
