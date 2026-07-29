import { useState } from 'react'
import type { ChecklistItemDef, ItemResult, ResultState } from '../../domain/types'

interface Props {
  items: ChecklistItemDef[]
  results: Record<string, ItemResult>
  /** Outstanding ledger rows at this address. */
  knownFindingCount?: number
  declinedFindingCount?: number
  onOpenFindings?: () => void
  onOpenItem: (itemId: string) => void
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
  onOpenFindings, onOpenItem, onReview,
}: Props) {
  const [showPhase2, setShowPhase2] = useState(false)

  const phase1 = items.filter((item) => item.phase === 1)
  const phase2 = items.filter((item) => item.phase === 2)

  const phase1Done = phase1.filter((item) => results[item.id]).length
  const phase1Complete = phase1Done === phase1.length

  /** Items whose readings this one is measured against must come first. */
  const blockedBy = (item: ChecklistItemDef): string | null => {
    const missing = (item.dependsOn ?? []).find((id) => !results[id])
    return missing ?? null
  }

  const groupsOf = (list: ChecklistItemDef[]) => [...new Set(list.map((item) => item.group))]

  const renderItem = (item: ChecklistItemDef) => {
    const result = results[item.id]
    const blocker = blockedBy(item)

    return (
      <button
        key={item.id}
        type="button"
        disabled={Boolean(blocker)}
        onClick={() => onOpenItem(item.id)}
        className="flex w-full items-center justify-between gap-3 rounded-lg border border-slate-700 bg-slate-800/60 p-3 text-left disabled:opacity-50"
      >
        <span className="min-w-0">
          <span className="block font-medium text-white">
            {item.id}. {item.title}
          </span>
          {blocker && (
            <span className="block text-xs text-amber-300">
              Record {blocker} first — its readings are the reference for this one.
            </span>
          )}
        </span>
        {result ? (
          <span className={`shrink-0 rounded px-2 py-1 text-xs font-semibold ${resultBadge[result.result]}`}>
            {resultLabel[result.result]}
          </span>
        ) : (
          <span className="shrink-0 rounded border border-slate-600 px-2 py-1 text-xs text-slate-400">
            open
          </span>
        )}
      </button>
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

      {groupsOf(phase1).map((group) => (
        <section key={group} className="space-y-2">
          <h2 className="text-sm font-medium uppercase tracking-wide text-slate-400">
            {GROUP_LABEL[group] ?? group}
          </h2>
          {phase1.filter((item) => item.group === group).map(renderItem)}
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
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      <button
        type="button"
        disabled={!phase1Complete}
        onClick={onReview}
        className="fixed inset-x-0 bottom-0 mx-auto w-full max-w-xl bg-sky-600 p-4 font-medium text-white disabled:bg-slate-700 disabled:text-slate-400"
      >
        {phase1Complete
          ? 'Review findings'
          : `Assess all Phase 1 items to continue (${phase1Done}/${phase1.length})`}
      </button>
    </div>
  )
}
