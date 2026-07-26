import type { ReportModel } from '../../domain/report'
import type { Inspection, Property, ResultState } from '../../domain/types'

interface Props {
  report: ReportModel
  inspection: Inspection
  property: Property
  onNewInspection: () => void
}

const statusColor: Record<ResultState, string> = {
  PASS: 'bg-emerald-600',
  MONITOR: 'bg-amber-500',
  ACTION: 'bg-red-600',
  BELOW_STANDARD: 'bg-sky-600',
  NA: 'bg-slate-500',
}

export function ReportScreen({ report, inspection, property, onNewInspection }: Props) {
  const hasCritical = report.score.criticalFindings.length > 0

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6 print:bg-white print:text-black">
      <div className="flex items-center justify-between print:hidden">
        <button
          type="button"
          onClick={onNewInspection}
          className="rounded-lg border border-slate-600 px-4 py-2 text-sm text-slate-200"
        >
          New inspection
        </button>
        <button
          type="button"
          onClick={() => window.print()}
          className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white"
        >
          Print / Export
        </button>
      </div>

      <header className="space-y-1 border-b border-slate-700 pb-4 print:border-black">
        <p className="text-xs uppercase tracking-[0.2em] text-sky-300 print:text-black">
          Red Cedar Electric — Electrical Health Record
        </p>
        <h1 className="text-2xl font-semibold text-white print:text-black">{property.address}</h1>
        <p className="text-sm text-slate-400 print:text-black">
          Inspected {inspection.date.slice(0, 10)} by {inspection.technician}
        </p>
      </header>

      {hasCritical && (
        <section className="rounded-xl border-2 border-red-500 bg-red-950/70 p-4 print:bg-white">
          <h2 className="text-lg font-bold text-red-200 print:text-red-700">⚠ Critical finding</h2>
          <ul className="text-sm text-red-100 print:text-red-700">
            {report.score.criticalFindings.map((id) => {
              const item = report.items.find((r) => r.def.id === id)
              return (
                <li key={id}>
                  {id} — {item?.def.title ?? id}
                </li>
              )
            })}
          </ul>
        </section>
      )}

      <section className="flex items-center gap-6">
        <div className="text-center">
          <div className="text-5xl font-bold text-white print:text-black">{report.score.score}</div>
          <div className="text-xs text-slate-400 print:text-black">
            {report.score.itemsAssessed} items assessed
          </div>
        </div>
        <div>
          <div className="text-xl font-medium text-white print:text-black">{report.band}</div>
          <p className="max-w-sm text-xs text-slate-400 print:text-black">{report.honestyLine}</p>
        </div>
      </section>

      <section className="grid grid-cols-1 gap-2 sm:grid-cols-5">
        {report.rollups.map((rollup) => (
          <div
            key={rollup.id}
            className="rounded-lg border border-slate-700 bg-slate-800/60 p-3 text-center print:bg-white"
          >
            <span
              className={`mx-auto mb-2 block h-3 w-3 rounded-full ${statusColor[rollup.status]}`}
            />
            <span className="text-xs text-slate-200 print:text-black">{rollup.label}</span>
          </div>
        ))}
      </section>

      {report.loadCalc && (
        <section className="space-y-2 rounded-xl border border-sky-800 bg-slate-800/60 p-4 print:border-black print:bg-white">
          <h2 className="text-lg font-semibold text-white print:text-black">
            Electrical capacity (NEC Article 220)
          </h2>
          <p
            className={`text-sm font-medium ${
              report.loadCalc.result.governingAmps >= report.loadCalc.result.serviceAmps
                ? 'text-red-300 print:text-red-700'
                : report.loadCalc.result.loadPct >= 80
                  ? 'text-amber-300 print:text-black'
                  : 'text-emerald-300 print:text-black'
            }`}
          >
            Calculated load {report.loadCalc.result.governingAmps} A on a{' '}
            {report.loadCalc.result.serviceAmps} A service — {report.loadCalc.result.loadPct}%
            used, {report.loadCalc.result.spareAmps} A spare.
          </p>
          <p className="text-xs text-slate-400 print:text-black">
            Code basis 230.42(A)(1): noncontinuous load at 100% + continuous at 125% — no
            blanket 80% derate. Method: {report.loadCalc.result.methodUsed} (Optional{' '}
            {report.loadCalc.result.optionalAmps} A · Standard {report.loadCalc.result.standardAmps} A
            · Neutral {report.loadCalc.result.neutralAmps} A). Conservative 80% reference:{' '}
            {report.loadCalc.result.usableAmps80} A.
          </p>
          {report.loadCalc.result.futureLoadFindings.map((f) => (
            <p
              key={f.label}
              className={`text-xs ${f.fitsCode ? 'text-emerald-300 print:text-black' : 'text-amber-300 print:text-black'}`}
            >
              {f.label}: {f.verdict}
              {f.mitigation ? ` — ${f.mitigation}` : ''}
            </p>
          ))}
          {report.loadCalc.result.assumedValues.length > 0 && (
            <p className="text-xs text-amber-200/80 print:text-black">
              Values assumed (not nameplate-read): {report.loadCalc.result.assumedValues.join(', ')}
            </p>
          )}
        </section>
      )}

      <section className="space-y-4">
        <h2 className="text-lg font-semibold text-white print:text-black">Findings by item</h2>
        {report.items.map((item) => (
          <article
            key={item.def.id}
            className="space-y-2 rounded-xl border border-slate-700 bg-slate-800/60 p-4 text-sm text-slate-200 print:border-black print:bg-white print:text-black"
          >
            <div className="flex items-center justify-between">
              <h3 className="font-medium text-white print:text-black">
                {item.def.id}. {item.def.title}
              </h3>
              <span
                className={`rounded px-2 py-1 text-xs font-semibold text-white ${statusColor[item.result.result]}`}
              >
                {item.result.result === 'BELOW_STANDARD' ? 'BELOW STD' : item.result.result}
                {item.result.gradedState ? ` · ${item.result.gradedState}` : ''}
              </span>
            </div>
            <p>
              <strong className="text-sky-300 print:text-black">What we check:</strong> {item.whatWeCheck}
            </p>
            <p>
              <strong className="text-sky-300 print:text-black">Why code cares:</strong> {item.whyCodeCares}
            </p>
            <p>
              <strong className="text-sky-300 print:text-black">What we found:</strong> {item.whatWeFound}
            </p>
            <p>
              <strong className="text-sky-300 print:text-black">Why it matters:</strong> {item.whyItMatters}
            </p>
            {item.result.note && (
              <p className="text-xs text-slate-400 print:text-black">Note: {item.result.note}</p>
            )}
          </article>
        ))}
      </section>

      <section className="space-y-2 border-t border-slate-700 pt-4 print:border-black">
        <h2 className="text-lg font-semibold text-white print:text-black">Technical appendix</h2>
        {report.items.map((item) => (
          <div key={item.def.id} className="text-xs text-slate-400 print:text-black">
            <span className="font-medium text-slate-200 print:text-black">{item.def.id}</span> ·{' '}
            {item.citations.join(' · ')}
            {Object.keys(item.result.measured).length > 0 && (
              <span>
                {' '}
                — measured:{' '}
                {Object.entries(item.result.measured)
                  .map(([key, value]) => `${key}=${value}`)
                  .join(', ')}
              </span>
            )}
          </div>
        ))}
        {report.loadCalc && (
          <div className="space-y-1 pt-2">
            <h3 className="text-sm font-medium text-slate-200 print:text-black">
              Load calculation line items ({report.loadCalc.result.methodUsed} method)
            </h3>
            {report.loadCalc.result.breakdown.map((line, i) => (
              <div key={i} className="text-xs text-slate-400 print:text-black">
                {line.label}: {Math.round(line.rawVA)} VA → {Math.round(line.appliedVA)} VA applied ·{' '}
                {line.rule}
              </div>
            ))}
          </div>
        )}
        <p className="pt-2 text-xs text-slate-500 print:text-black">
          Source provenance: [gov/std] adopting ordinances & NEC/NFPA text · [peer-reviewed] NIST
          / IEEE Holm / NAFE · [industry] insurer & manufacturer records. Labels are never blended.
        </p>
      </section>
    </div>
  )
}
