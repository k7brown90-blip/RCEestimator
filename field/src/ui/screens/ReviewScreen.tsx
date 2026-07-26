import { useState } from 'react'
import { checklist } from '../../data/checklist'
import type { ScoreResult } from '../../domain/scoring'
import type { ItemResult } from '../../domain/types'

interface Props {
  results: Record<string, ItemResult>
  score: ScoreResult
  onComplete: (contractorReviewed: boolean) => void
  onBack: () => void
}

export function ReviewScreen({ results, score, onComplete, onBack }: Props) {
  const [contractorReviewed, setContractorReviewed] = useState(false)
  const hasCritical = score.criticalFindings.length > 0
  const titleOf = (id: string) => checklist.find((item) => item.id === id)?.title ?? id

  const findings = Object.values(results).filter(
    (r) => r.result === 'ACTION' || r.result === 'MONITOR' || r.result === 'BELOW_STANDARD',
  )

  return (
    <div className="mx-auto max-w-xl space-y-6 p-6">
      <button type="button" onClick={onBack} className="text-sm text-sky-300">
        ← Checklist
      </button>
      <h1 className="text-xl font-semibold text-white">Review findings</h1>

      {hasCritical && (
        <section className="space-y-2 rounded-xl border-2 border-red-500 bg-red-950/70 p-4">
          <h2 className="text-lg font-bold text-red-200">⚠ Critical finding</h2>
          <ul className="space-y-1 text-sm text-red-100">
            {score.criticalFindings.map((id) => (
              <li key={id}>
                <span className="font-semibold">{id}</span> — {titleOf(id)}
              </li>
            ))}
          </ul>
          <p className="text-xs text-red-200">
            Headline score is capped at 69 until resolved. This report requires contractor
            review before export.
          </p>
        </section>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-slate-300">Findings</h2>
        {findings.length === 0 && <p className="text-sm text-slate-400">No findings — clean inspection.</p>}
        {findings.map((finding) => (
          <div key={finding.itemId} className="rounded-lg border border-slate-700 bg-slate-800/60 p-3 text-sm">
            <span className="font-medium text-white">
              {finding.itemId}. {titleOf(finding.itemId)}
            </span>
            <span className="ml-2 text-xs text-slate-300">
              {finding.result}
              {finding.gradedState ? ` · ${finding.gradedState}` : ''}
            </span>
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
        Complete inspection & generate report
      </button>
    </div>
  )
}
