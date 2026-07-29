import { NOT_ASSESSED, ROLLUP_LABEL, type ReportItem, type ReportModel, type RollupStatusValue } from '../../domain/report'
import { REPORT_LIMITATIONS } from '../../data/reportLimitations'
import type { Inspection, Property } from '../../domain/types'

interface Props {
  report: ReportModel
  inspection: Inspection
  property: Property
  onNewInspection: () => void
}

const statusColor: Record<RollupStatusValue, string> = {
  PASS: 'bg-emerald-600',
  MONITOR: 'bg-amber-500',
  FAIL: 'bg-red-600',
  BELOW_STANDARD: 'bg-sky-600',
  NA: 'bg-slate-500',
  [NOT_ASSESSED]: 'bg-slate-700',
}

const statusText: Record<RollupStatusValue, string> = {
  PASS: 'text-emerald-300 print:text-black',
  MONITOR: 'text-amber-300 print:text-black',
  FAIL: 'text-red-300 print:text-red-700',
  BELOW_STANDARD: 'text-sky-300 print:text-black',
  NA: 'text-slate-400 print:text-black',
  [NOT_ASSESSED]: 'text-slate-500 print:text-black',
}

export function ReportScreen({ report, inspection, property, onNewInspection }: Props) {
  const { summary, sections } = report
  const hasCritical = summary.criticalFindings.length > 0

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6 print:bg-white print:text-black">
      <div className="flex items-center justify-between print:hidden">
        <button
          type="button"
          onClick={onNewInspection}
          className="rounded-lg border border-slate-600 px-4 py-2 text-sm text-slate-200"
        >
          New record
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
          Assessed {inspection.date.slice(0, 10)} by {inspection.technician}
        </p>
        {/* Not yet a customer deliverable — Phase 1 is still being proven out. */}
        <p className="mt-2 inline-block rounded border border-amber-500 px-2 py-1 text-xs font-semibold uppercase tracking-wide text-amber-300 print:text-black">
          Internal record — not for customer delivery
        </p>
      </header>

      {hasCritical && (
        <section className="rounded-xl border-2 border-red-500 bg-red-950/70 p-4 print:bg-white">
          <h2 className="text-lg font-bold text-red-200 print:text-red-700">⚠ Critical finding</h2>
          <ul className="text-sm text-red-100 print:text-red-700">
            {summary.criticalFindings.map((id) => {
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

      {/* 1 — Section status */}
      <section className="space-y-2">
        <h2 className="text-lg font-semibold text-white print:text-black">Section status</h2>
        <div className="space-y-1">
          {report.rollups.map((rollup) => (
            <div
              key={rollup.id}
              className="flex items-center justify-between rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 print:border-black print:bg-white"
            >
              <span className="flex items-center gap-2 text-sm text-slate-200 print:text-black">
                <span className={`h-2.5 w-2.5 rounded-full ${statusColor[rollup.status]}`} />
                {rollup.label}
              </span>
              <span className={`text-xs font-semibold ${statusText[rollup.status]}`}>
                {ROLLUP_LABEL[rollup.status]}
              </span>
            </div>
          ))}
        </div>
        <p className="text-xs text-slate-400 print:text-black">
          {summary.failCount} need correction · {summary.monitorCount} to monitor ·{' '}
          {summary.passCount} pass
          {summary.belowStandardCount > 0 && ` · ${summary.belowStandardCount} below standard`}
          {summary.naCount > 0 && ` · ${summary.naCount} not applicable`}
        </p>
      </section>

      {/* 2 — Action items */}
      <ItemSection
        title="Needs correction"
        items={sections.fail}
        emptyText="Nothing requires corrective action."
        tone="fail"
        showResolution
      />

      {/* 3 — Monitor */}
      <ItemSection title="Worth monitoring" items={sections.monitor} tone="monitor" />

      {/* 4 — Below Red Cedar's standard */}
      <ItemSection
        title="Below Red Cedar's standard"
        items={sections.belowStandard}
        tone="below"
        note="Code-compliant, but not what we'd install. Improving these is optional."
      />

      {/* 5 — Passed */}
      {sections.pass.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold text-white print:text-black">
            Passed ({sections.pass.length})
          </h2>
          <ul className="space-y-1 text-sm text-slate-300 print:text-black">
            {sections.pass.map((item) => (
              <li key={item.def.id} className="flex gap-2">
                <span className="text-emerald-400 print:text-black">✓</span>
                <span>
                  {item.def.id}. {item.def.title}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {sections.na.length > 0 && (
        <section className="space-y-1">
          <h2 className="text-sm font-semibold text-slate-300 print:text-black">Not applicable</h2>
          <p className="text-xs text-slate-400 print:text-black">
            {sections.na.map((item) => `${item.def.id} ${item.def.title}`).join(' · ')}
          </p>
        </section>
      )}

      {/* 6 — Not assessed this pass */}
      {report.notAssessed.length > 0 && (
        <section className="space-y-1 rounded-xl border border-slate-700 bg-slate-800/40 p-4 print:border-black print:bg-white">
          <h2 className="text-sm font-semibold text-slate-200 print:text-black">
            Not assessed in this pass ({report.notAssessed.length})
          </h2>
          <p className="text-xs text-slate-400 print:text-black">
            {report.notAssessed.map((item) => `${item.id} ${item.title}`).join(' · ')}
          </p>
        </section>
      )}

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

      {/* Technical appendix */}
      <section className="space-y-2 border-t border-slate-700 pt-4 print:border-black">
        <h2 className="text-lg font-semibold text-white print:text-black">Technical appendix</h2>
        {report.items.map((item) => (
          <div key={item.def.id} className="text-xs text-slate-400 print:text-black">
            <span className="font-medium text-slate-200 print:text-black">{item.def.id}</span>
            {item.citations.length > 0 && ` · ${item.citations.join(' · ')}`}
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
          Source provenance: [gov/std] adopting ordinances &amp; NEC/NFPA text · [peer-reviewed] NIST
          / IEEE Holm / NAFE · [industry] insurer &amp; manufacturer records. Labels are never blended.
        </p>
      </section>

      {/*
        Scope and limitations. Load-bearing, not boilerplate: without it a
        code-cited defect report reads as a clean bill of health for everything
        it doesn't mention.
      */}
      <section className="space-y-3 border-t border-slate-700 pt-4 print:border-black">
        <h2 className="text-lg font-semibold text-white print:text-black">
          Scope &amp; limitations
        </h2>
        {REPORT_LIMITATIONS.map((section) => (
          <div key={section.heading} className="space-y-1">
            <h3 className="text-sm font-medium text-slate-200 print:text-black">
              {section.heading}
            </h3>
            {section.body.map((paragraph, index) => (
              <p key={index} className="text-xs text-slate-400 print:text-black">
                {paragraph}
              </p>
            ))}
          </div>
        ))}
      </section>
    </div>
  )
}

const TONE_BORDER = {
  fail: 'border-red-800 print:border-black',
  monitor: 'border-amber-800 print:border-black',
  below: 'border-sky-800 print:border-black',
} as const

function ItemSection({
  title, items, emptyText, tone, note, showResolution,
}: {
  title: string
  items: ReportItem[]
  emptyText?: string
  tone: keyof typeof TONE_BORDER
  note?: string
  showResolution?: boolean
}) {
  if (items.length === 0) {
    return emptyText ? (
      <section className="space-y-2">
        <h2 className="text-lg font-semibold text-white print:text-black">{title}</h2>
        <p className="text-sm text-slate-400 print:text-black">{emptyText}</p>
      </section>
    ) : null
  }

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold text-white print:text-black">
        {title} ({items.length})
      </h2>
      {note && <p className="text-xs text-slate-400 print:text-black">{note}</p>}
      {items.map((item) => (
        <article
          key={item.def.id}
          className={`space-y-2 rounded-xl border bg-slate-800/60 p-4 text-sm text-slate-200 print:bg-white print:text-black ${TONE_BORDER[tone]}`}
        >
          <h3 className="font-medium text-white print:text-black">
            {item.def.id}. {item.def.title}
            {item.result.gradedState ? ` · ${item.result.gradedState}` : ''}
          </h3>
          <p>
            <strong className="text-sky-300 print:text-black">What we found:</strong> {item.whatWeFound}
          </p>
          <p>
            <strong className="text-sky-300 print:text-black">Why it matters:</strong> {item.whyItMatters}
          </p>
          {showResolution && item.result.resolutionNote && (
            <p className="rounded-lg bg-red-950/50 p-2 print:bg-white">
              <strong className="text-red-300 print:text-red-700">Resolution:</strong>{' '}
              {item.result.resolutionNote}
            </p>
          )}
          {item.result.photoIds.length > 0 && (
            <p className="text-xs text-slate-400 print:text-black">
              {item.result.photoIds.length} photo{item.result.photoIds.length > 1 ? 's' : ''} on file
            </p>
          )}
          {item.result.note && (
            <p className="text-xs text-slate-400 print:text-black">Note: {item.result.note}</p>
          )}
          <details className="text-xs text-slate-400 print:text-black">
            <summary className="cursor-pointer">Why code cares</summary>
            <p className="mt-1">{item.whatWeCheck}</p>
            <p className="mt-1">{item.whyCodeCares}</p>
          </details>
        </article>
      ))}
    </section>
  )
}
