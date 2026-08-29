import { useMemo } from 'react'
import type { LoadCalcInput, LoadCalcResult } from '../../domain/loadcalc'
import {
  LIQUID_COOLED_TEXT,
  recommendGenerator,
  type GeneratorFuel,
  type GeneratorRecommendation,
  type SiteConditions,
} from '../../domain/generator'
import type { InspectionLoadCalc } from '../../domain/types'

export type GeneratorSelection = NonNullable<InspectionLoadCalc['generator']>

interface Props {
  input: LoadCalcInput
  result: LoadCalcResult
  fuel: GeneratorFuel
  softStart: boolean
  altitudeSteps: number
  includeInEstimate: boolean
  onFuel: (fuel: GeneratorFuel) => void
  onSoftStart: (on: boolean) => void
  onAltitudeSteps: (steps: number) => void
  onIncludeInEstimate: (on: boolean) => void
}

function ModelCell({ model, ratedKW, siteDeratedKW, liquidCooled }: {
  model: { classLabel: string; generatorModel: string } | null
  ratedKW: number | null
  siteDeratedKW: number | null
  liquidCooled: boolean
}) {
  if (liquidCooled) return <span className="font-semibold text-amber-300">{LIQUID_COOLED_TEXT}</span>
  if (model === null) return <span className="text-slate-400">—</span>
  return (
    <span className="font-semibold text-white">
      Guardian {model.classLabel} kW (model {model.generatorModel})
      {ratedKW !== null && siteDeratedKW !== null && siteDeratedKW !== ratedKW && (
        <span className="ml-1 font-normal text-slate-400">— {siteDeratedKW} kW at this site</span>
      )}
    </span>
  )
}

/**
 * P031 tech-facing section: the whole-home matrix (three schemes, each with its
 * NEC 2017 basis), the essential-loads tier with covered / not-covered lists,
 * and every active flag. Renders from the shared engine — the customer
 * one-pager is built from the same recommendation object, never re-derived.
 * Amendment 2026-08-28: Generac Guardian model table, fuel-matched ratings,
 * site derate input, data vintage on screen.
 */
export function GeneratorPanel({
  input, result, fuel, softStart, altitudeSteps, includeInEstimate,
  onFuel, onSoftStart, onAltitudeSteps, onIncludeInEstimate,
}: Props) {
  const site: SiteConditions = useMemo(() => ({ altitudeSteps }), [altitudeSteps])
  const rec: GeneratorRecommendation = useMemo(
    () => recommendGenerator({ calcInput: input, calcResult: result, fuel, softStart, site }),
    [input, result, fuel, softStart, site],
  )

  return (
    <div className="space-y-3 rounded-lg border border-slate-700 bg-slate-900/60 p-3">
      <div className="flex flex-wrap items-center gap-3 text-xs text-slate-300">
        <span className="font-medium text-sky-300">Generator sizing — Generac Guardian</span>
        <label className="flex items-center gap-1">
          Fuel
          <select
            className="rounded border border-slate-600 bg-slate-800 p-1 text-white"
            value={fuel}
            onChange={(e) => onFuel(e.target.value as GeneratorFuel)}
          >
            <option value="NG">Natural gas</option>
            <option value="LP">Propane (LP)</option>
          </select>
        </label>
        <label className="flex items-center gap-1">
          Altitude (×1,000 ft)
          <input
            type="number"
            min={0}
            step={1}
            className="w-14 rounded border border-slate-600 bg-slate-800 p-1 text-white"
            value={altitudeSteps}
            onChange={(e) => onAltitudeSteps(Math.max(0, Number(e.target.value)))}
          />
        </label>
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={softStart} onChange={(e) => onSoftStart(e.target.checked)} />
          soft-start kit on largest compressor
        </label>
      </div>
      <p className="text-[10px] text-slate-500">
        Site derate ×{rec.siteDerateFactor} applied to published ratings (−3.5%/1,000 ft; −1%/10 °F above 60 °F).
      </p>

      {rec.flags.length > 0 && (
        <div className="space-y-1">
          {rec.flags.map((f) => (
            <p key={f.id} className={`text-xs ${f.severity === 'hard' ? 'text-red-300' : 'text-amber-300'}`}>
              {f.severity === 'hard' ? 'FLAG: ' : 'Check: '}
              {f.message}
            </p>
          ))}
        </div>
      )}

      <div>
        <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
          Whole home — three schemes
        </p>
        <div className="space-y-1.5">
          {rec.wholeHome.map((s) => (
            <div key={s.scheme} className="rounded border border-slate-700 bg-slate-800/60 p-2 text-xs">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-medium text-slate-200">{s.title}</span>
                <ModelCell model={s.model} ratedKW={s.ratedKW} siteDeratedKW={s.siteDeratedKW} liquidCooled={s.liquidCooled} />
              </div>
              <p className="text-slate-400">
                {s.necBasis} · {s.requiredKW !== null ? `${s.requiredKW} kW required (${s.requiredAmps} A)` : 'no code-minimum size'} · basis: {s.loadBasis}
              </p>
              {/* Installer priority table — mirrors Generac's panel decal (Appendix B). */}
              {s.managementPlan !== undefined && s.managementPlan.managed.length > 0 && (
                <table className="mt-1 w-full text-left text-[10px] text-slate-400">
                  <thead>
                    <tr className="text-slate-500">
                      <th className="pr-2">P</th><th className="pr-2">Load</th>
                      <th className="pr-2">Mechanism</th><th className="pr-2">kW</th><th>BOM</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.managementPlan.managed.map((row) => (
                      <tr key={row.label}>
                        <td className="pr-2">{row.priority}</td>
                        <td className="pr-2">{row.label}</td>
                        <td className="pr-2">{row.mechanism}</td>
                        <td className="pr-2">{row.kw}</td>
                        <td>{row.bomSlot ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {s.notes.map((n) => (
                <p key={n} className="text-slate-500">{n}</p>
              ))}
            </div>
          ))}
        </div>
      </div>

      <div>
        <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
          Essential loads (partial home)
        </p>
        {rec.partial === null ? (
          <p className="text-xs text-amber-300">
            Suppressed — see the flag above; offer whole-home sizing (with load management where it fits).
          </p>
        ) : (
          <div className="rounded border border-slate-700 bg-slate-800/60 p-2 text-xs">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-medium text-slate-200">
                {rec.partial.requiredKW} kW calculated ({rec.partial.requiredAmps} A)
              </span>
              <ModelCell
                model={rec.partial.model}
                ratedKW={rec.partial.ratedKW}
                siteDeratedKW={rec.partial.siteDeratedKW}
                liquidCooled={rec.partial.liquidCooled}
              />
            </div>
            <p className="mt-1 text-slate-300">Covered:</p>
            {rec.partial.covered.map((c) => (
              <p key={c.label} className="text-slate-400">
                · {c.label} — {(c.va / 1000).toFixed(2)} kVA <span className="text-slate-500">({c.rule})</span>
              </p>
            ))}
            <p className="mt-1 text-slate-300">Not covered:</p>
            {rec.partial.notCovered.map((n) => (
              <p key={n} className="text-slate-400">· {n}</p>
            ))}
            {rec.partial.excludedWithReason.length > 0 && (
              <>
                <p className="mt-1 text-slate-300">Excluded:</p>
                {rec.partial.excludedWithReason.map((n) => (
                  <p key={n} className="text-slate-400">· {n}</p>
                ))}
              </>
            )}
          </div>
        )}
      </div>

      {rec.surge.status !== 'none' && (
        <p className="text-xs text-slate-400">{rec.surge.message}</p>
      )}
      {rec.scopeLines.map((line) => (
        <p key={line} className="text-xs text-amber-200/80">{line}</p>
      ))}

      {/* Package references resolve against the price book; the import lane is
          still stalled, and saying so beats a silent blank (P031). */}
      <p className="text-[10px] text-slate-500">
        Package refs: {[...new Set(rec.wholeHome.flatMap((s) => s.priceBookRefs))].join(' · ')}
        {rec.partial ? ` · ${rec.partial.priceBookRefs.join(' · ')}` : ''} — prices resolve when the price book lands.
      </p>
      {/* Data vintage on screen so stale data is visible (amendment rule 6). */}
      <p className="text-[10px] text-slate-500">Product data: {rec.dataRevision}</p>

      <label className="flex items-center gap-2 text-xs text-slate-200">
        <input type="checkbox" checked={includeInEstimate} onChange={(e) => onIncludeInEstimate(e.target.checked)} />
        Offer with the estimate (customer one-pager; the office still approves before it sends)
      </label>

      <p className="text-[10px] text-slate-500">{rec.disclaimer}</p>
    </div>
  )
}

/** Build the stored payload from the panel's current state. */
export function generatorSelection(
  input: LoadCalcInput,
  result: LoadCalcResult,
  fuel: GeneratorFuel,
  softStart: boolean,
  altitudeSteps: number,
  includeInEstimate: boolean,
): GeneratorSelection {
  return {
    recommendation: recommendGenerator({
      calcInput: input, calcResult: result, fuel, softStart, site: { altitudeSteps },
    }),
    fuel,
    softStart,
    altitudeSteps,
    includeInEstimate,
  }
}
