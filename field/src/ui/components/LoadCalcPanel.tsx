import { useMemo, useState } from 'react'
import {
  calculateLoad,
  isContinuous,
  resolveVA,
  type LoadCalcInput,
  type LoadItem,
  type LoadType,
} from '../../domain/loadcalc'
import { ALL_TYPES, FUTURE_PICKS, QUICK_PICKS, newLoadItem } from '../../data/loadPicks'
import type { InspectionLoadCalc } from '../../domain/types'

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
        <h3 className="mb-1 text-xs font-medium text-slate-300">Add loads (tap; values editable)</h3>
        <div className="flex flex-wrap gap-1.5">
          {QUICK_PICKS.map((pick) => (
            <button
              key={pick.label}
              type="button"
              onClick={() => setLoads((l) => [...l, newItem(pick.item)])}
              className="rounded-full border border-slate-600 bg-slate-800 px-2.5 py-1 text-xs text-slate-200"
            >
              + {pick.label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setShowFullInventory((s) => !s)}
            className="rounded-full border border-sky-700 bg-sky-900/50 px-2.5 py-1 text-xs text-sky-200"
          >
            {showFullInventory ? 'Hide full inventory' : 'Full inventory…'}
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

      <div className="space-y-1 rounded-lg border border-slate-700 bg-slate-800/80 p-3 text-sm text-slate-200">
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

      <button
        type="button"
        onClick={() => onApply({ input, result })}
        className="w-full rounded-lg bg-sky-700 p-2.5 text-sm font-medium text-white"
      >
        Apply to A2 (stores calculation with the record)
      </button>
    </section>
  )
}
