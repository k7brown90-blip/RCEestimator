import { useMemo, useState } from 'react'
import {
  calculateLoad,
  capacityCheck220_83,
  isContinuous,
  resolveVA,
  type LoadCalcInput,
  type LoadItem,
  type LoadType,
} from '../../domain/loadcalc'
import { ALL_TYPES, FUTURE_PICKS, QUICK_PICK_CATEGORIES, newLoadItem } from '../../data/loadPicks'
import type { InspectionLoadCalc } from '../../domain/types'
import type { GeneratorFuel } from '../../domain/generator'
import { GeneratorPanel, generatorSelection } from './GeneratorPanel'

interface Props {
  initial?: InspectionLoadCalc
  onApply: (record: InspectionLoadCalc) => void
}

// Pick lists live in data/loadPicks.ts so this panel, the standalone capacity
// check and the CRM's phone-quoting panel can't disagree about what a typical
// water heater is.
const newItem = newLoadItem

function kwOf(item: LoadItem): number {
  return resolveVA(item) / 1000
}

function LoadRow({
  item,
  onChange,
  onRemove,
}: {
  item: LoadItem
  onChange: (next: LoadItem) => void
  onRemove: () => void
}) {
  return (
    <div className="space-y-1 rounded-lg border border-slate-700 bg-slate-900/50 p-2">
      <div className="flex items-center gap-2">
        <input
          className="min-w-0 flex-1 rounded border border-slate-600 bg-slate-800 p-1.5 text-xs text-white"
          value={item.label}
          onChange={(e) => onChange({ ...item, label: e.target.value })}
        />
        <button type="button" onClick={onRemove} className="text-xs text-red-300">
          remove
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-300">
        {item.type !== 'heatPump' && (
          <label className="flex items-center gap-1">
            kW
            <input
              type="number"
              step="0.1"
              className="w-20 rounded border border-slate-600 bg-slate-800 p-1 text-white"
              value={item.nameplateKW ?? (item.nameplateVA !== undefined ? item.nameplateVA / 1000 : '')}
              onChange={(e) =>
                onChange({
                  ...item,
                  nameplateKW: e.target.value === '' ? undefined : Number(e.target.value),
                  nameplateVA: undefined,
                  amps: undefined,
                })
              }
            />
          </label>
        )}
        {item.type === 'heatPump' && item.heatPump && (
          <>
            <label className="flex items-center gap-1">
              compressor VA
              <input
                type="number"
                className="w-20 rounded border border-slate-600 bg-slate-800 p-1 text-white"
                value={item.heatPump.compressorVA}
                onChange={(e) => onChange({ ...item, heatPump: { ...item.heatPump!, compressorVA: Number(e.target.value) } })}
              />
            </label>
            <label className="flex items-center gap-1">
              supplemental VA
              <input
                type="number"
                className="w-20 rounded border border-slate-600 bg-slate-800 p-1 text-white"
                value={item.heatPump.supplementalVA}
                onChange={(e) => onChange({ ...item, heatPump: { ...item.heatPump!, supplementalVA: Number(e.target.value) } })}
              />
            </label>
          </>
        )}
        <label className="flex items-center gap-1">
          V
          <select
            className="rounded border border-slate-600 bg-slate-800 p-1 text-white"
            value={item.volts ?? 240}
            onChange={(e) => onChange({ ...item, volts: Number(e.target.value) })}
          >
            <option value={120}>120</option>
            <option value={240}>240</option>
          </select>
        </label>
        {item.type === 'spaceHeat' && (
          <label className="flex items-center gap-1">
            units
            <input
              type="number"
              className="w-14 rounded border border-slate-600 bg-slate-800 p-1 text-white"
              value={item.separatelyControlledUnits ?? 1}
              onChange={(e) => onChange({ ...item, separatelyControlledUnits: Number(e.target.value) })}
            />
          </label>
        )}
        {/* Off the condenser plate — feeds the generator sizing surge check
            (P031). Without it every recommendation flags "provide condenser
            LRA or tonnage" with nowhere on site to answer it (Kyle,
            2026-08-29, the Hamrick report). */}
        {(item.type === 'cooling' || item.type === 'heatPump') && (
          <label className="flex items-center gap-1">
            LRA
            <input
              type="number"
              step="0.1"
              placeholder="plate"
              className="w-16 rounded border border-slate-600 bg-slate-800 p-1 text-white"
              value={item.lockedRotorAmps ?? ''}
              onChange={(e) =>
                onChange({ ...item, lockedRotorAmps: e.target.value === '' ? undefined : Number(e.target.value) })
              }
            />
          </label>
        )}
        {(item.type === 'arcWelder' || item.type === 'resistanceWelder') && (
          <label className="flex items-center gap-1">
            duty %
            <input
              type="number"
              className="w-14 rounded border border-slate-600 bg-slate-800 p-1 text-white"
              value={item.dutyCyclePct ?? (item.type === 'arcWelder' ? 100 : 50)}
              onChange={(e) => onChange({ ...item, dutyCyclePct: Number(e.target.value) })}
            />
          </label>
        )}
        {item.type === 'dryer' && (
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={item.onLaundryCircuit ?? false}
              onChange={(e) => onChange({ ...item, onLaundryCircuit: e.target.checked })}
            />
            on laundry circuit
          </label>
        )}
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={item.nameplateRead ?? false}
            onChange={(e) => onChange({ ...item, nameplateRead: e.target.checked })}
          />
          plate read
        </label>
        <span className="ml-auto text-slate-400">{kwOf(item).toFixed(2)} kVA</span>
      </div>
    </div>
  )
}

export function LoadCalcPanel({ initial, onApply }: Props) {
  const [serviceAmps, setServiceAmps] = useState(initial?.input.serviceAmps ?? 200)
  const [floorAreaSqFt, setFloorAreaSqFt] = useState(initial?.input.floorAreaSqFt ?? 1500)
  const [loads, setLoads] = useState<LoadItem[]>(initial?.input.loads ?? [])
  const [futureLoads, setFutureLoads] = useState<LoadItem[]>(initial?.input.futureLoads ?? [])
  const [showFullInventory, setShowFullInventory] = useState(false)
  // ── P031 generator sizing — collapsed until the tech opens it ──
  const [generatorOpen, setGeneratorOpen] = useState(initial?.generator !== undefined)
  const [generatorFuel, setGeneratorFuel] = useState<GeneratorFuel>(initial?.generator?.fuel ?? 'NG')
  const [generatorSoftStart, setGeneratorSoftStart] = useState(initial?.generator?.softStart ?? false)
  // DEFAULT one 1,000-ft altitude step for Middle TN, tech-overridable (P031 amendment).
  const [generatorAltitude, setGeneratorAltitude] = useState(initial?.generator?.altitudeSteps ?? 1)
  const [generatorInclude, setGeneratorInclude] = useState(initial?.generator?.includeInEstimate ?? false)

  const input: LoadCalcInput = useMemo(
    () => ({
      mode: 'tech',
      occupancy: 'dwellingSingleFamily',
      serviceAmps,
      serviceVoltage: 240,
      floorAreaSqFt,
      loads,
      futureLoads,
    }),
    [serviceAmps, floorAreaSqFt, loads, futureLoads],
  )

  const result = useMemo(() => calculateLoad(input), [input])

  /**
   * The same house under 220.83, shown alongside.
   *
   * These answer different questions — calculateLoad asks "what does this house
   * draw?", 220.83 asks "can it take one more thing?" — and they legitimately
   * produce different numbers. Rendering only one of them is how an assessment
   * and a phone quote end up citing different amperages for the same service
   * with nothing on screen explaining why.
   *
   * The panel's "future loads" are 220.83's new loads: that's the same list,
   * asked the same question.
   */
  const capacity = useMemo(() => capacityCheck220_83(input, futureLoads), [input, futureLoads])

  const update = (setter: typeof setLoads) => (id: string, next: LoadItem) =>
    setter((list) => list.map((l) => (l.id === id ? next : l)))
  const remove = (setter: typeof setLoads) => (id: string) =>
    setter((list) => list.filter((l) => l.id !== id))

  return (
    <section className="space-y-3 rounded-xl border border-sky-800 bg-slate-900/70 p-4">
      <header className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold text-sky-300">NEC Article 220 load calculation</h2>
        <span className="text-xs text-slate-400">Tech mode · Optional method primary</span>
      </header>

      <div className="flex flex-wrap gap-3 text-xs text-slate-300">
        <label className="flex items-center gap-1">
          Service (A)
          <input
            type="number"
            className="w-20 rounded border border-slate-600 bg-slate-800 p-1.5 text-white"
            value={serviceAmps}
            onChange={(e) => setServiceAmps(Number(e.target.value))}
          />
        </label>
        <label className="flex items-center gap-1">
          Adaptable area (ft², excl. porch/garage/unfinished)
          <input
            type="number"
            className="w-24 rounded border border-slate-600 bg-slate-800 p-1.5 text-white"
            value={floorAreaSqFt}
            onChange={(e) => setFloorAreaSqFt(Number(e.target.value))}
          />
        </label>
      </div>
      <p className="text-xs text-slate-500">
        2 small-appliance + 1 laundry circuits (220.52 minimums) and the bathroom-circuit
        no-add guard are applied automatically.
      </p>

      <div>
        <h3 className="mb-1 text-xs font-medium text-slate-300">
          Add loads — walk the house room by room (tap; values editable)
        </h3>
        {/* Grouped the way a house is walked (Kyle, 2026-08-24: "anything that
            can be found at a residence or home garage"). What the code already
            covers without a line item — washers, countertop plug-ins, ordinary
            receptacles — is deliberately absent; adding it would double-count. */}
        <div className="space-y-2">
          {QUICK_PICK_CATEGORIES.map((cat) => (
            <div key={cat.category}>
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                {cat.category}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {cat.picks.map((pick) => (
                  <button
                    key={pick.label}
                    type="button"
                    onClick={() => setLoads((l) => [...l, newItem(pick.item)])}
                    className="rounded-full border border-slate-600 bg-slate-800 px-2.5 py-1 text-xs text-slate-200"
                  >
                    + {pick.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
          <button
            type="button"
            onClick={() => setShowFullInventory((s) => !s)}
            className="rounded-full border border-sky-700 bg-sky-900/50 px-2.5 py-1 text-xs text-sky-200"
          >
            {showFullInventory ? 'Hide full inventory' : 'Anything else — full inventory…'}
          </button>
        </div>
        {showFullInventory && (
          <select
            className="mt-2 w-full rounded border border-slate-600 bg-slate-800 p-2 text-xs text-white"
            value=""
            onChange={(e) => {
              const type = e.target.value as LoadType
              if (type) setLoads((l) => [...l, newItem({ type, label: type, nameplateKW: 1, volts: 240 })])
            }}
          >
            <option value="">Add any load type (full §5 taxonomy)…</option>
            {ALL_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        )}
      </div>

      {loads.length > 0 && (
        <div className="space-y-1.5">
          {loads.map((item) => (
            <LoadRow
              key={item.id}
              item={item}
              onChange={(next) => update(setLoads)(item.id, next)}
              onRemove={() => remove(setLoads)(item.id)}
            />
          ))}
        </div>
      )}

      <div>
        <h3 className="mb-1 text-xs font-medium text-slate-300">"Can I add this?" — future loads</h3>
        <div className="flex flex-wrap gap-1.5">
          {FUTURE_PICKS.map((pick) => (
            <button
              key={pick.label}
              type="button"
              onClick={() => setFutureLoads((l) => [...l, newItem(pick.item)])}
              className="rounded-full border border-slate-600 bg-slate-800 px-2.5 py-1 text-xs text-slate-200"
            >
              + {pick.label}
            </button>
          ))}
        </div>
        {futureLoads.length > 0 && (
          <div className="mt-1.5 space-y-1.5">
            {futureLoads.map((item) => (
              <LoadRow
                key={item.id}
                item={item}
                onChange={(next) => update(setFutureLoads)(item.id, next)}
                onRemove={() => remove(setFutureLoads)(item.id)}
              />
            ))}
          </div>
        )}
      </div>

      {/*
        Two methods, both shown, each labelled. They answer different questions
        and a different number from each is expected — an unexplained difference
        between two Red Cedar documents is not.
      */}
      <div className="space-y-1 rounded-lg border border-slate-700 bg-slate-800/80 p-3 text-sm text-slate-200">
        <p className="text-xs font-medium uppercase tracking-wide text-sky-300">
          What this house draws — Article 220 {result.methodUsed} method
        </p>
        <p className="text-lg font-semibold text-white">
          Calculated load {result.governingAmps} A on a {serviceAmps} A service —{' '}
          {result.loadPct}% used, {result.spareAmps} A spare
        </p>
        <p className="text-xs text-slate-400">
          Code basis 230.42: noncontinuous 100% + continuous 125%. Method:{' '}
          {result.methodUsed}
          {result.methodUsed === 'standard' && serviceAmps < 100
            ? ' (Optional unavailable — service under 100 A, 220.82(A))'
            : ''}
          . Optional {result.optionalAmps} A · Standard {result.standardAmps} A · Neutral{' '}
          {result.neutralAmps} A.
        </p>
        <p className="text-xs text-slate-500">
          Conservative reference only (never the recommendation basis): 80% ={' '}
          {result.usableAmps80} A.
        </p>
        {result.futureLoadFindings.map((f) => (
          <p
            key={f.label}
            className={`text-xs ${f.fitsCode ? 'text-emerald-300' : 'text-amber-300'}`}
          >
            {f.label}: {f.verdict}
            {f.mitigation ? ` — ${f.mitigation}` : ''}
          </p>
        ))}
        {result.assumedValues.length > 0 && (
          <p className="text-xs text-amber-200/80">
            Assumed (not plate-read): {result.assumedValues.join(', ')}
          </p>
        )}
        {futureLoads.some((f) => isContinuous(f)) && (
          <p className="text-xs text-slate-500">
            Continuous candidates carry the ×1.25 factor in the capacity check only — the
            220 calculated load is not inflated (no double-count).
          </p>
        )}
      </div>

      <div
        className={`space-y-1 rounded-lg border p-3 text-sm ${
          capacity.fits ? 'border-emerald-800 bg-emerald-950/30' : 'border-red-800 bg-red-950/30'
        }`}
      >
        <p className="text-xs font-medium uppercase tracking-wide text-sky-300">
          Can it take the new load — 220.83({capacity.variant})
        </p>
        <p className="text-lg font-semibold text-white">
          {capacity.amps} A of {capacity.serviceAmps} A — {capacity.loadPct}% loaded
        </p>
        <p className={`text-xs font-medium ${capacity.fits ? 'text-emerald-300' : 'text-red-300'}`}>
          {futureLoads.length === 0
            ? 'No new load entered — this is the existing-dwelling figure for the house as it stands.'
            : capacity.fits
              ? `Calculates with ${capacity.spareAmps} A spare. Quote the addition.`
              : `Over by ${Math.abs(capacity.spareAmps)} A. Quote the service upgrade.`}
        </p>
        <p className="text-xs text-slate-400">{capacity.citation}</p>
        {/* Why the two figures differ, said before anyone has to ask. */}
        {capacity.amps !== result.governingAmps && (
          <p className="text-xs text-slate-500">
            Different from the {result.governingAmps} A above because 220.83 stages an existing
            dwelling's load differently from the {result.methodUsed} method. Both are correct; this
            is the one that answers whether the new load fits.
          </p>
        )}
      </div>

      {/* ── P031: generator sizing off this calculation, on request ── */}
      <button
        type="button"
        onClick={() => setGeneratorOpen((s) => !s)}
        className="rounded-full border border-slate-600 bg-slate-800 px-2.5 py-1 text-xs text-slate-200"
      >
        {generatorOpen ? 'Hide generator sizing' : 'Generator sizing recommendation…'}
      </button>
      {generatorOpen && (
        <GeneratorPanel
          input={input}
          result={result}
          fuel={generatorFuel}
          softStart={generatorSoftStart}
          altitudeSteps={generatorAltitude}
          includeInEstimate={generatorInclude}
          onFuel={setGeneratorFuel}
          onSoftStart={setGeneratorSoftStart}
          onAltitudeSteps={setGeneratorAltitude}
          onIncludeInEstimate={setGeneratorInclude}
        />
      )}

      <button
        type="button"
        onClick={() =>
          onApply({
            input,
            result,
            ...(generatorOpen
              ? {
                  generator: generatorSelection(
                    input, result, generatorFuel, generatorSoftStart, generatorAltitude, generatorInclude,
                  ),
                }
              : {}),
          })
        }
        className="w-full rounded-lg bg-sky-700 p-2.5 text-sm font-medium text-white"
      >
        Apply to A2 (stores calculation with the record)
      </button>
    </section>
  )
}
