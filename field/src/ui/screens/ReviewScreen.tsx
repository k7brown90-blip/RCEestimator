import { useState } from 'react'
import { checklist } from '../../data/checklist'
import type { FindingsSummary } from '../../domain/findings'
import type { ItemResult, ResultState } from '../../domain/types'

interface Props {
  results: Record<string, ItemResult>
  summary: FindingsSummary
  onComplete: (contractorReviewed: boolean) => void
  onBack: () => void
}

const findingLabel: Record<ResultState, string> = {
  PASS: 'PASS',
  MONITOR: 'MONITOR',
  FAIL: 'FAIL',
  BELOW_STANDARD: 'BELOW STD',
  NA: 'N/A',
}

export function ReviewScreen({ results, summary, onComplete, onBack }: Props) {
  const [contractorReviewed, setContractorReviewed] = useState(false)
  const hasCritical = summary.criticalFindings.length > 0
  const titleOf = (id: string) => checklist.find((item) => item.id === id)?.title ?? id

  const findings = Object.values(results).filter(
    (r) => r.result === 'FAIL' || r.result === 'MONITOR' || r.result === 'BELOW_STANDARD',
  )

  return (
    <div className="mx-auto max-w-xl space-y-6 p-6">
      <button type="button" onClick={onBack} className="text-sm text-sky-300">
        ← Checklist
      </button>
      <h1 className="text-xl font-semibold text-white">Review findings</h1>

      <section className="grid grid-cols-3 gap-2 text-center">
        <div className="rounded-lg border border-red-800 bg-red-950/40 p-3">
          <div className="text-2xl font-bold text-red-200">{summary.failCount}</div>
          <div className="text-xs text-red-300">need correction</div>
        </div>
        <div className="rounded-lg border border-amber-800 bg-amber-950/40 p-3">
          <div className="text-2xl font-bold text-amber-200">{summary.monitorCount}</div>
          <div className="text-xs text-amber-300">to monitor</div>
        </div>
        <div className="rounded-lg border border-emerald-800 bg-emerald-950/40 p-3">
          <div className="text-2xl font-bold text-emerald-200">{summary.passCount}</div>
          <div className="text-xs text-emerald-300">pass</div>
        </div>
      </section>

      {summary.notAssessedCount > 0 && (
        <p className="rounded-lg border border-slate-700 bg-slate-800/60 p-3 text-sm text-slate-300">
          {summary.notAssessedCount} item{summary.notAssessedCount > 1 ? 's' : ''} not assessed in
          this pass. The report will say so.
        </p>
      )}

      {hasCritical && (
        <section className="space-y-2 rounded-xl border-2 border-red-500 bg-red-950/70 p-4">
          <h2 className="text-lg font-bold text-red-200">⚠ Critical finding</h2>
          <ul className="space-y-1 text-sm text-red-100">
            {summary.criticalFindings.map((id) => (
              <li key={id}>
                <span className="font-semibold">{id}</span> — {titleOf(id)}
              </li>
            ))}
          </ul>
          <p className="text-xs text-red-200">
            This report requires licensed-contractor review before it can be exported.
          </p>
        </section>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-slate-300">Findings</h2>
        {findings.length === 0 && (
          <p className="text-sm text-slate-400">No findings — everything assessed met requirements.</p>
        )}
        {findings.map((finding) => (
          <div key={finding.itemId} className="rounded-lg border border-slate-700 bg-slate-800/60 p-3 text-sm">
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-medium text-white">
                {finding.itemId}. {titleOf(finding.itemId)}
              </span>
              <span className="text-xs text-slate-300">
                {findingLabel[finding.result]}
                {finding.gradedState ? ` · ${finding.gradedState}` : ''}
              </span>
            </div>
            {finding.resolutionNote && (
              <p className="mt-1 text-xs text-slate-400">Resolution: {finding.resolutionNote}</p>
            )}
          </div>
        ))}
      </section>

      {hasCritical && (
        <label className="flex items-start gap-3 rounded-lg border border-slate-700 bg-slate-800/60 p-3 text-sm text-slate-200">
          <input
            type="checkbox"
            className="mt-1"
            checked={contractorReviewed}
            onChange={(e) => setContractorReviewed(e.target.checked)}
          />
          <span>
            The licensed contractor has reviewed the critical finding(s) on this report.
          </span>
        </label>
      )}

      <button
        type="button"
        disabled={hasCritical && !contractorReviewed}
        onClick={() => onComplete(contractorReviewed)}
        className="w-full rounded-lg bg-sky-600 p-3 font-medium text-white disabled:bg-slate-700 disabled:text-slate-400"
      >
        Complete the record &amp; generate the report
      </button>
    </div>
  )
}
