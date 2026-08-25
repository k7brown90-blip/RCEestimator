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
  /** Per-section notes, keyed by group (2026-08-24 — matches the paper form's notes line). */
  sectionNotes?: Record<string, SectionNote>
  onSectionNote?: (group: string, note: string, includeOnReport: boolean) => void
  onOpenFindings?: () => void
  onOpenV2?: () => void
  onOpenItem: (itemId: string) => void
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

const GROUP_LABEL: Record<string, string> = {
  'service-entrance': 'Service entrance & supply',
  'main-disconnect': 'Main disconnect & working space',
  'bonding-grounding': 'Bonding & grounding',
  'panel-condition': 'Panel condition & overcurrent',
  'panel-measurements': 'Panel measurements',
  surge: 'Surge protection',
  'equipment-disconnects': 'Equipment disconnects',
  'subpanel-bonding': 'Subpanel bonding',
  'branch-protection': 'Branch-circuit protection',
  devices: 'Devices, receptacles & lighting',
  'life-safety': 'Life safety',
  'metro-amendments': 'Metro amendments',
}

export function ChecklistScreen({
  items, results, knownFindingCount = 0, declinedFindingCount = 0,
  v2Summary, sectionNotes = {}, onSectionNote, onOpenFindings, onOpenV2, onOpenItem,
  onQuickResult, onReview,
}: Props) {
  const [showPhase2, setShowPhase2] = useState(false)
  const [openNoteGroup, setOpenNoteGroup] = useState<string | null>(null)

  /**
   * The section-note affordance under each group heading — the digital twin of
   * the notes line each section carries on the paper field record. Internal by
   * default; the toggle is what promotes a note onto the customer's report.
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
            : '+ Section note'}
        </button>
      )
    }
    return (
      <div className="space-y-2 rounded-lg border border-slate-600 bg-slate-900/60 p-2">
        <textarea
          autoFocus
          rows={3}
          defaultValue={existing?.note ?? ''}
          placeholder="What you saw in this section — internal unless promoted below."
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

  const phase1 = items.filter((item) => item.phase === 1)
  const phase2 = items.filter((item) => item.phase === 2)

  const phase1Done = phase1.filter((item) => results[item.id]).length
  const anyAssessed = Object.keys(results).length > 0

  const groupsOf = (list: ChecklistItemDef[]) => [...new Set(list.map((item) => item.group))]

  /**
   * The paper form's row, digitized (Kyle, 2026-08-24: "resemble a simple check
   * list with the pass, monitor, fail, below standard, and n/a options"). One
   * tap grades the item; tapping the same grade again clears it. The full item
   * card — measurements, photos, per-item notes — is behind the "detail" link
   * for what the technician deems necessary, never in the way of the walk.
   * A grade set here on an item the card already detailed keeps that detail.
   */
  const GRADE_ORDER: ResultState[] = ['PASS', 'MONITOR', 'FAIL', 'BELOW_STANDARD', 'NA']
  const gradeShort: Record<ResultState, string> = {
    PASS: 'P', MONITOR: 'M', FAIL: 'F', BELOW_STANDARD: 'B', NA: 'N',
  }

  const renderItem = (item: ChecklistItemDef) => {
    const result = results[item.id]
    const hasDetail = Boolean(
      result && (Object.keys(result.measured).length > 0 || result.photoIds.length > 0 || result.note || result.resolutionNote),
    )

    return (
      <div key={item.id} className="rounded-lg border border-slate-700 bg-slate-800/60 p-3">
        <div className="flex items-start justify-between gap-2">
          <span className="min-w-0 text-sm font-medium text-white">
            {item.id}. {item.title}
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
    )
  }

  return (
    <div className="mx-auto max-w-xl space-y-6 p-6 pb-24">
      <header className="space-y-2">
        <h1 className="text-xl font-semibold text-white">Phase 1 — service &amp; exterior</h1>
        <p className="text-xs text-slate-400">
          Everything assessed at the service: the mast, meter, main disconnect, grounding
          electrodes, water and gas bonds, the panel at this location, and the HVAC disconnect.
          One pass, one position.
        </p>
        <div className="h-2 overflow-hidden rounded bg-slate-700">
          <div
            className="h-full bg-sky-500 transition-all"
            style={{ width: `${phase1.length === 0 ? 0 : (phase1Done / phase1.length) * 100}%` }}
          />
        </div>
        <p className="text-sm text-slate-400">
          {phase1Done} of {phase1.length} Phase 1 items assessed
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

      {groupsOf(phase1).map((group) => (
        <section key={group} className="space-y-2">
          <h2 className="text-sm font-medium uppercase tracking-wide text-slate-400">
            {GROUP_LABEL[group] ?? group}
          </h2>
          {phase1.filter((item) => item.group === group).map(renderItem)}
          {renderSectionNote(group)}
        </section>
      ))}

      {phase2.length > 0 && (
        <section className="space-y-2 rounded-xl border border-slate-700 bg-slate-900/40 p-3">
          <button
            type="button"
            onClick={() => setShowPhase2((open) => !open)}
            className="flex w-full items-center justify-between text-left"
          >
            <span>
              <span className="block text-sm font-medium text-slate-300">
                Phase 2 — interior ({phase2.length} items)
              </span>
              <span className="block text-xs text-slate-500">
                Subpanels, GFCI/AFCI, devices, alarms. Not required in this pass.
              </span>
            </span>
            <span className="text-xs text-sky-300">{showPhase2 ? 'hide' : 'show'}</span>
          </button>

          {showPhase2 && (
            <div className="space-y-4 pt-2">
              {groupsOf(phase2).map((group) => (
                <div key={group} className="space-y-2">
                  <h3 className="text-xs uppercase tracking-wide text-slate-500">
                    {GROUP_LABEL[group] ?? group}
                  </h3>
                  {phase2.filter((item) => item.group === group).map(renderItem)}
                  {renderSectionNote(group)}
                </div>
              ))}
            </div>
          )}
        </section>
      )}

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
          ? `Review findings (${phase1Done}/${phase1.length} Phase 1 assessed)`
          : 'Mark at least one item to continue'}
      </button>
    </div>
  )
}
