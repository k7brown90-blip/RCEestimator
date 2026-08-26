import { useState } from 'react'
import type { ChecklistItemDef, ItemResult, ResultState, SectionNote } from '../../domain/types'

interface Props {
  items: ChecklistItemDef[]
  results: Record<string, ItemResult>
  /** Outstanding ledger rows at this address. */
  knownFindingCount?: number
  declinedFindingCount?: number
  /** Component/measurement counts from the v2 structured capture. */
  v2Summary?: { enclosures: number; items: number }
  /** Per-row notes, keyed by group (2026-08-24 — matches the paper form's notes line). */
  sectionNotes?: Record<string, SectionNote>
  onSectionNote?: (group: string, note: string, includeOnReport: boolean) => void
  onOpenFindings?: () => void
  onOpenV2?: () => void
  onOpenItem: (itemId: string) => void
  /** "Add Sub-Panel Option available if there are more that one sub panel." (Kyle, 2026-08-26) */
  onAddSubPanel?: (label: string) => void
  /**
   * Tap-to-grade straight on the row (Kyle, 2026-08-24: "resemble a simple
   * check list… speed and flexibility"). null clears the mark. Detail capture
   * (measurements, photos, per-item notes) stays one tap away via the item id.
   */
  onQuickResult: (itemId: string, result: ResultState | null) => void
  onReview: () => void
}

const resultBadge: Record<ResultState, string> = {
  PASS: 'bg-emerald-700 text-emerald-100',
  MONITOR: 'bg-amber-600 text-amber-50',
  FAIL: 'bg-red-700 text-red-100',
  BELOW_STANDARD: 'bg-sky-800 text-sky-100',
  NA: 'bg-slate-600 text-slate-200',
}

const resultLabel: Record<ResultState, string> = {
  PASS: 'PASS',
  MONITOR: 'MONITOR',
  FAIL: 'FAIL',
  BELOW_STANDARD: 'BELOW STD',
  NA: 'N/A',
}

/**
 * The consolidated walk (Kyle, 2026-08-26: "organized like this exactly").
 * One flat, numbered list in his order — no section headers, no phases. Each
 * row carries its own notes line, and the sub-panel row grows an "add" control.
 */
export function ChecklistScreen({
  items, results, knownFindingCount = 0, declinedFindingCount = 0,
  v2Summary, sectionNotes = {}, onSectionNote, onOpenFindings, onOpenV2, onOpenItem,
  onAddSubPanel, onQuickResult, onReview,
}: Props) {
  const [openNoteGroup, setOpenNoteGroup] = useState<string | null>(null)
  const [addingSubPanel, setAddingSubPanel] = useState(false)
  const [subPanelLabel, setSubPanelLabel] = useState('')

  /**
   * The notes line under a row — the digital twin of the notes line each
   * section carries on the paper field record. Internal by default; the toggle
   * is what promotes a note onto the customer's report. Sub-panel instances
   * share the SUB group, so their note covers the sub-panels as a set.
   */
  const renderSectionNote = (group: string) => {
    if (!onSectionNote) return null
    const existing = sectionNotes[group]
    const open = openNoteGroup === group
    if (!open) {
      return (
        <button
          type="button"
          onClick={() => setOpenNoteGroup(group)}
          className="w-full rounded-lg border border-slate-700/60 bg-slate-900/40 p-2 text-left text-xs text-slate-400"
        >
          {existing?.note
            ? <>📝 {existing.note.length > 80 ? `${existing.note.slice(0, 80)}…` : existing.note}
                {existing.includeOnReport && <span className="ml-1 text-sky-300">· on report</span>}</>
            : '+ Notes'}
        </button>
      )
    }
    return (
      <div className="space-y-2 rounded-lg border border-slate-600 bg-slate-900/60 p-2">
        <textarea
          autoFocus
          rows={3}
          defaultValue={existing?.note ?? ''}
          placeholder="What you saw here — internal unless promoted below."
          className="w-full rounded border border-slate-600 bg-slate-800 p-2 text-sm text-white placeholder:text-slate-500"
          onBlur={(e) => onSectionNote(group, e.target.value, existing?.includeOnReport ?? false)}
        />
        <div className="flex items-center justify-between">
          <label className="flex items-center gap-2 text-xs text-slate-300">
            <input
              type="checkbox"
              checked={existing?.includeOnReport ?? false}
              onChange={(e) => onSectionNote(group, existing?.note ?? '', e.target.checked)}
            />
            Include on the customer's report
          </label>
          <button type="button" className="text-xs text-sky-300" onClick={() => setOpenNoteGroup(null)}>
            done
          </button>
        </div>
      </div>
    )
  }

  const assessedCount = items.filter((item) => results[item.id]).length
  const anyAssessed = assessedCount > 0

  const GRADE_ORDER: ResultState[] = ['PASS', 'MONITOR', 'FAIL', 'BELOW_STANDARD', 'NA']
  const gradeShort: Record<ResultState, string> = {
    PASS: 'P', MONITOR: 'M', FAIL: 'F', BELOW_STANDARD: 'B', NA: 'N',
  }

  const renderItem = (item: ChecklistItemDef, index: number, showNote: boolean) => {
    const result = results[item.id]
    const hasDetail = Boolean(
      result && (Object.keys(result.measured).length > 0 || result.photoIds.length > 0 || result.note || result.resolutionNote),
    )

    return (
      <div key={item.id} className="space-y-2">
        <div className="rounded-lg border border-slate-700 bg-slate-800/60 p-3">
          <div className="flex items-start justify-between gap-2">
            <span className="min-w-0 text-sm font-medium text-white">
              {index + 1}. {item.title}
            </span>
            <button
              type="button"
              onClick={() => onOpenItem(item.id)}
              className="shrink-0 text-xs text-sky-300"
            >
              {hasDetail ? 'detail ✓' : 'detail'}
            </button>
          </div>
          <div className="mt-2 flex gap-1.5">
            {GRADE_ORDER.map((grade) => {
              const active = result?.result === grade
              return (
                <button
                  key={grade}
                  type="button"
                  onClick={() => onQuickResult(item.id, active ? null : grade)}
                  title={resultLabel[grade]}
                  className={`h-9 flex-1 rounded font-semibold ${
                    active
                      ? resultBadge[grade]
                      : 'border border-slate-600 bg-slate-900/60 text-slate-400'
                  }`}
                >
                  {gradeShort[grade]}
                </button>
              )
            })}
          </div>
        </div>
        {showNote && renderSectionNote(item.group)}
      </div>
    )
  }

  /** The "+ Add sub-panel" control, rendered after the last sub-panel row. */
  const renderAddSubPanel = () => {
    if (!onAddSubPanel) return null
    if (!addingSubPanel) {
      return (
        <button
          type="button"
          onClick={() => setAddingSubPanel(true)}
          className="w-full rounded-lg border border-dashed border-sky-700 bg-sky-950/20 p-2.5 text-sm text-sky-300"
        >
          + Add sub-panel
        </button>
      )
    }
    const submit = () => {
      const label = subPanelLabel.trim()
      if (label) onAddSubPanel(label)
      setSubPanelLabel('')
      setAddingSubPanel(false)
    }
    return (
      <div className="flex gap-2 rounded-lg border border-sky-800 bg-sky-950/30 p-2">
        <input
          autoFocus
          value={subPanelLabel}
          onChange={(e) => setSubPanelLabel(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
          placeholder="Where is it? (Garage, Barn…)"
          className="min-w-0 flex-1 rounded border border-slate-600 bg-slate-800 p-2 text-sm text-white placeholder:text-slate-500"
        />
        <button type="button" onClick={submit} className="shrink-0 rounded bg-sky-600 px-3 text-sm font-medium text-white">
          Add
        </button>
      </div>
    )
  }

  // The add control belongs right under the last Interior Panel / Sub-Panel row.
  const lastSubIndex = items.reduce(
    (last, item, index) => (item.id === 'SUB' || item.id.startsWith('SUB:') ? index : last),
    -1,
  )

  return (
    <div className="mx-auto max-w-xl space-y-6 p-6 pb-24">
      <header className="space-y-2">
        <h1 className="text-xl font-semibold text-white">Electrical assessment</h1>
        <p className="text-xs text-slate-400">
          The walk in order: calculated load first with every customer, then the
          service, panels, grounding, and the equipment that keeps the home safe.
        </p>
        <div className="h-2 overflow-hidden rounded bg-slate-700">
          <div
            className="h-full bg-sky-500 transition-all"
            style={{ width: `${items.length === 0 ? 0 : (assessedCount / items.length) * 100}%` }}
          />
        </div>
        <p className="text-sm text-slate-400">
          {assessedCount} of {items.length} assessed
        </p>
      </header>

      {onOpenFindings && (knownFindingCount > 0 || declinedFindingCount > 0) && (
        <button
          type="button"
          onClick={onOpenFindings}
          className="flex w-full items-center justify-between rounded-lg border border-amber-800 bg-amber-950/30 p-3 text-left"
        >
          <span>
            <span className="block text-sm font-medium text-amber-200">
              {knownFindingCount} open item{knownFindingCount === 1 ? '' : 's'} on record here
            </span>
            <span className="block text-xs text-amber-300/70">
              {declinedFindingCount > 0
                ? `${declinedFindingCount} already declined — read before you quote anything.`
                : 'From previous visits to this address.'}
            </span>
          </span>
          <span className="shrink-0 text-xs text-amber-300">view →</span>
        </button>
      )}

      {onOpenV2 && (
        <button
          type="button"
          onClick={onOpenV2}
          className="flex w-full items-center justify-between rounded-lg border border-sky-800 bg-sky-950/30 p-3 text-left"
        >
          <span>
            <span className="block text-sm font-medium text-sky-200">
              Panel &amp; component capture
            </span>
            <span className="block text-xs text-sky-300/70">
              {v2Summary && (v2Summary.enclosures > 0 || v2Summary.items > 0)
                ? `${v2Summary.enclosures} enclosure${v2Summary.enclosures === 1 ? '' : 's'} · ${v2Summary.items} component${v2Summary.items === 1 ? '' : 's'} recorded`
                : 'Enclosures, thermal & torque readings, bus rubric, GFCI coverage, sampling.'}
            </span>
          </span>
          <span className="shrink-0 text-xs text-sky-300">open →</span>
        </button>
      )}

      <div className="space-y-3">
        {items.map((item, index) => {
          // Sub-panel instances share the SUB note group — one notes line for
          // the set, under the last of them, next to the add control.
          const lastOfGroup = !items.some((other, otherIndex) => otherIndex > index && other.group === item.group)
          return (
            <div key={item.id} className="space-y-3">
              {renderItem(item, index, lastOfGroup)}
              {index === lastSubIndex && renderAddSubPanel()}
            </div>
          )
        })}
      </div>

      {/* No all-items gate (Kyle, 2026-08-24): the technician assesses "what he
          has time for or what he deems necessary." Anything unmarked is reported
          as not assessed in this pass — the report already says so. */}
      <button
        type="button"
        disabled={!anyAssessed}
        onClick={onReview}
        className="fixed inset-x-0 bottom-0 mx-auto w-full max-w-xl bg-sky-600 p-4 font-medium text-white disabled:bg-slate-700 disabled:text-slate-400"
      >
        {anyAssessed
          ? `Review findings (${assessedCount}/${items.length} assessed)`
          : 'Mark at least one item to continue'}
      </button>
    </div>
  )
}
