/**
 * Protocol v2 capture — enclosures, components, measurements, GFCI coverage
 * and sampling disclosure. The structured half of the assessment that rides
 * the push as the `v2` section.
 *
 * Rule feedback is immediate (domain/v2Rules mirrors the server's hard
 * rules): a thermal reading asks for its companion current before it can be
 * added, torque isn't even offered on a service-side energized enclosure,
 * and completing with an unexpanded failed sample is blocked here the same
 * way the server would block the sync.
 */

import { useMemo, useState } from 'react'
import type {
  ComponentType, EnclosureType, V2BusVisual, V2Capture, V2Classification,
  V2Enclosure, V2GfciCoverage, V2Item, V2Measurement, V2SamplingRecord,
} from '../../domain/v2Types'
import { checkCapture, checkItem, checkMeasurement, measurementTypesFor } from '../../domain/v2Rules'

interface Props {
  capture: V2Capture
  onChange: (next: V2Capture) => void
  onBack: () => void
}

const ENCLOSURE_TYPES: Array<[EnclosureType, string]> = [
  ['service_equipment', 'Service equipment'],
  ['main_disconnect', 'Main disconnect'],
  ['main_panel', 'Main panel'],
  ['subpanel', 'Subpanel'],
  ['equipment_disconnect', 'Equipment disconnect'],
]

const COMPONENT_TYPES: Array<[ComponentType, string]> = [
  ['lug', 'Lug / termination'],
  ['breaker', 'Breaker'],
  ['bus_stab', 'Bus stab'],
  ['bus_joint', 'Bus joint'],
  ['bus_bar_section', 'Bus bar section'],
  ['neutral_bar', 'Neutral bar'],
  ['ground_bar', 'Ground bar'],
  ['spd', 'Surge protective device'],
  ['service_entrance', 'Service entrance'],
  ['weatherhead', 'Weatherhead'],
  ['mast', 'Mast'],
  ['meter_base', 'Meter base'],
  ['receptacle', 'Receptacle'],
  ['switch', 'Switch'],
  ['fixture', 'Fixture'],
  ['smoke_alarm', 'Smoke alarm'],
  ['co_alarm', 'CO alarm'],
]

const CLASSES: Array<[V2Classification, string, string]> = [
  ['pass', 'PASS', 'bg-emerald-700'],
  ['fail', 'FAIL', 'bg-red-700'],
  ['monitor', 'MONITOR', 'bg-amber-600'],
  ['upgrade', 'UPGRADE', 'bg-sky-700'],
]

const UNIT_FOR: Record<string, string> = {
  torque: 'in_lb',
  thermal_delta_t: 'C',
  thermal_absolute: 'C',
  stab_thermal_delta_t: 'C',
  grounding_resistance: 'ohm',
  receptacle_tension: 'oz',
  voltage_unloaded: 'V',
  voltage_loaded: 'V',
  current: 'A',
  voltage_drop_pct: '%',
  source_impedance: 'ohm',
  circuit_current_at_reading: 'A',
}

const isBusComponent = (t: string) => ['bus_stab', 'bus_joint', 'bus_bar_section'].includes(t)
const isThermal = (t: string) => ['thermal_delta_t', 'thermal_absolute', 'stab_thermal_delta_t'].includes(t)
const isComparative = (t: string) => ['thermal_delta_t', 'stab_thermal_delta_t'].includes(t)

const field = 'w-full rounded-md border border-slate-600 bg-slate-900 p-2 text-sm text-white'
const label = 'block text-xs text-slate-400 mb-1'
const btn = 'rounded-md px-3 py-1.5 text-sm font-medium'

export function V2CaptureScreen({ capture, onChange, onBack }: Props) {
  const [tab, setTab] = useState<'enclosures' | 'gfci' | 'sampling'>('enclosures')
  const [activeEnclosureKey, setActiveEnclosureKey] = useState<string | null>(null)
  const violations = useMemo(() => checkCapture(capture), [capture])

  const activeEnclosure = capture.enclosures.find((e) => e.locationKey === activeEnclosureKey)

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-4">
      <header className="flex items-center justify-between">
        <button type="button" onClick={onBack} className="text-sm text-slate-400">&larr; Checklist</button>
        <h1 className="text-lg font-semibold text-white">Panel &amp; Component Capture</h1>
        <span className="text-xs text-slate-500">v2</span>
      </header>

      {violations.length > 0 && (
        <div className="rounded-lg border border-amber-700 bg-amber-950/60 p-3 text-xs text-amber-200">
          <p className="font-semibold">Before this record can sync:</p>
          <ul className="mt-1 list-disc pl-4">
            {violations.map((v, i) => <li key={i}>{v.message}</li>)}
          </ul>
        </div>
      )}

      <nav className="grid grid-cols-3 gap-1 rounded-lg bg-slate-800 p-1 text-sm">
        {([['enclosures', `Enclosures (${capture.enclosures.length})`], ['gfci', `GFCI (${capture.gfciCoverage.length})`], ['sampling', `Sampling (${capture.samplingRecords.length})`]] as const).map(([key, text]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`rounded-md py-1.5 ${tab === key ? 'bg-slate-600 text-white' : 'text-slate-400'}`}
          >
            {text}
          </button>
        ))}
      </nav>

      {tab === 'enclosures' && !activeEnclosure && (
        <EnclosureList
          capture={capture}
          onOpen={setActiveEnclosureKey}
          onAdd={(enclosure) => onChange({ ...capture, enclosures: [...capture.enclosures, enclosure] })}
        />
      )}
      {tab === 'enclosures' && activeEnclosure && (
        <EnclosureDetail
          enclosure={activeEnclosure}
          capture={capture}
          onChange={onChange}
          onBack={() => setActiveEnclosureKey(null)}
        />
      )}
      {tab === 'gfci' && <GfciSection capture={capture} onChange={onChange} />}
      {tab === 'sampling' && <SamplingSection capture={capture} onChange={onChange} />}
    </div>
  )
}

// ── Enclosures ───────────────────────────────────────────────────────────────

function EnclosureList({ capture, onOpen, onAdd }: {
  capture: V2Capture
  onOpen: (key: string) => void
  onAdd: (enclosure: V2Enclosure) => void
}) {
  const [adding, setAdding] = useState(false)
  const [enclosureType, setEnclosureType] = useState<EnclosureType>('main_panel')
  const [description, setDescription] = useState('')
  const [energized, setEnergized] = useState(false)

  const add = () => {
    const base = description.trim() || enclosureType
    const key = base.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 40)
    let unique = key
    let n = 2
    while (capture.enclosures.some((e) => e.locationKey === unique)) unique = `${key}_${n++}`
    onAdd({
      locationKey: unique,
      enclosureType,
      locationDescription: description.trim() || null,
      // Service equipment is energized on the line side by definition.
      serviceSideEnergized: enclosureType === 'service_equipment' ? true : energized,
    })
    setAdding(false)
    setDescription('')
    setEnergized(false)
  }

  return (
    <div className="space-y-2">
      {capture.enclosures.map((e) => {
        const itemCount = capture.items.filter((i) => i.locationKey === e.locationKey).length
        return (
          <button
            key={e.locationKey}
            type="button"
            onClick={() => onOpen(e.locationKey)}
            className="flex w-full items-center justify-between rounded-lg border border-slate-700 bg-slate-800/60 p-3 text-left"
          >
            <span>
              <span className="block font-medium text-white">
                {ENCLOSURE_TYPES.find(([t]) => t === e.enclosureType)?.[1]}
                {e.locationDescription ? ` — ${e.locationDescription}` : ''}
              </span>
              <span className="text-xs text-slate-400">
                {itemCount} component{itemCount === 1 ? '' : 's'}
                {e.serviceSideEnergized ? ' · service side energized — no torque' : ''}
              </span>
            </span>
            <span className="text-slate-500">&rarr;</span>
          </button>
        )
      })}

      {adding ? (
        <div className="space-y-2 rounded-lg border border-slate-700 bg-slate-800/60 p-3">
          <div>
            <span className={label}>Type</span>
            <select className={field} value={enclosureType} onChange={(e) => setEnclosureType(e.target.value as EnclosureType)}>
              {ENCLOSURE_TYPES.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
            </select>
          </div>
          <div>
            <span className={label}>Where is it? (e.g. "garage north wall")</span>
            <input className={field} value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          {enclosureType !== 'service_equipment' && (
            <label className="flex items-center gap-2 text-sm text-slate-300">
              <input type="checkbox" checked={energized} onChange={(e) => setEnergized(e.target.checked)} />
              Line side stays energized with the disconnect open
            </label>
          )}
          <div className="flex gap-2">
            <button type="button" className={`${btn} bg-emerald-700 text-white`} onClick={add}>Add enclosure</button>
            <button type="button" className={`${btn} bg-slate-700 text-slate-300`} onClick={() => setAdding(false)}>Cancel</button>
          </div>
        </div>
      ) : (
        <button type="button" className={`${btn} w-full border border-dashed border-slate-600 py-3 text-slate-300`} onClick={() => setAdding(true)}>
          + Add enclosure
        </button>
      )}
    </div>
  )
}

function EnclosureDetail({ enclosure, capture, onChange, onBack }: {
  enclosure: V2Enclosure
  capture: V2Capture
  onChange: (next: V2Capture) => void
  onBack: () => void
}) {
  const items = capture.items.filter((i) => i.locationKey === enclosure.locationKey)
  const [addingItem, setAddingItem] = useState(false)

  return (
    <div className="space-y-3">
      <button type="button" onClick={onBack} className="text-sm text-slate-400">&larr; Enclosures</button>
      <h2 className="font-semibold text-white">
        {ENCLOSURE_TYPES.find(([t]) => t === enclosure.enclosureType)?.[1]}
        {enclosure.locationDescription ? ` — ${enclosure.locationDescription}` : ''}
      </h2>
      {enclosure.serviceSideEnergized && (
        <p className="rounded-md border border-amber-700 bg-amber-950/50 p-2 text-xs text-amber-200">
          Service side energized — main lugs get thermal + visual only; torque is not offered here (§3.3).
        </p>
      )}

      {items.map((item) => (
        <ItemCard
          key={item.clientId}
          item={item}
          enclosures={capture.enclosures}
          onChange={(next) => onChange({ ...capture, items: capture.items.map((i) => (i.clientId === item.clientId ? next : i)) })}
          onRemove={() => onChange({ ...capture, items: capture.items.filter((i) => i.clientId !== item.clientId) })}
        />
      ))}

      {addingItem ? (
        <NewItemForm
          enclosure={enclosure}
          onAdd={(item) => {
            onChange({ ...capture, items: [...capture.items, item] })
            setAddingItem(false)
          }}
          onCancel={() => setAddingItem(false)}
        />
      ) : (
        <button type="button" className={`${btn} w-full border border-dashed border-slate-600 py-3 text-slate-300`} onClick={() => setAddingItem(true)}>
          + Add component
        </button>
      )}
    </div>
  )
}

function NewItemForm({ enclosure, onAdd, onCancel }: {
  enclosure: V2Enclosure
  onAdd: (item: V2Item) => void
  onCancel: () => void
}) {
  const [componentType, setComponentType] = useState<ComponentType>('lug')
  const [locationLabel, setLocationLabel] = useState('')

  return (
    <div className="space-y-2 rounded-lg border border-slate-700 bg-slate-800/60 p-3">
      <div>
        <span className={label}>Component</span>
        <select className={field} value={componentType} onChange={(e) => setComponentType(e.target.value as ComponentType)}>
          {COMPONENT_TYPES.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
        </select>
      </div>
      <div>
        <span className={label}>Label (circuit, leg/stab, room…)</span>
        <input className={field} value={locationLabel} onChange={(e) => setLocationLabel(e.target.value)} />
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          className={`${btn} bg-emerald-700 text-white`}
          onClick={() => onAdd({
            clientId: crypto.randomUUID(),
            componentType,
            locationKey: enclosure.locationKey,
            locationLabel: locationLabel.trim() || null,
            classification: 'pass',
            measurements: [],
            busVisual: null,
          })}
        >
          Add
        </button>
        <button type="button" className={`${btn} bg-slate-700 text-slate-300`} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}

function ItemCard({ item, enclosures, onChange, onRemove }: {
  item: V2Item
  enclosures: V2Enclosure[]
  onChange: (next: V2Item) => void
  onRemove: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const enclosure = enclosures.find((e) => e.locationKey === item.locationKey)
  const itemViolations = checkItem(item, enclosures)

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-800/60 p-3">
      <button type="button" className="flex w-full items-center justify-between text-left" onClick={() => setExpanded(!expanded)}>
        <span className="min-w-0">
          <span className="block font-medium text-white">
            {COMPONENT_TYPES.find(([t]) => t === item.componentType)?.[1]}
            {item.locationLabel ? ` — ${item.locationLabel}` : ''}
          </span>
          <span className="text-xs text-slate-400">
            {(item.measurements ?? []).length} reading{(item.measurements ?? []).length === 1 ? '' : 's'}
            {itemViolations.length > 0 ? ` · ${itemViolations.length} issue${itemViolations.length === 1 ? '' : 's'}` : ''}
          </span>
        </span>
        <span className={`rounded px-2 py-0.5 text-xs font-bold text-white ${CLASSES.find(([c]) => c === item.classification)?.[2]}`}>
          {CLASSES.find(([c]) => c === item.classification)?.[1]}
        </span>
      </button>

      {expanded && (
        <div className="mt-3 space-y-3 border-t border-slate-700 pt-3">
          <div className="grid grid-cols-4 gap-1">
            {CLASSES.map(([value, text, color]) => (
              <button
                key={value}
                type="button"
                onClick={() => onChange({ ...item, classification: value })}
                className={`rounded py-1.5 text-xs font-bold text-white ${item.classification === value ? color : 'bg-slate-700 text-slate-300'}`}
              >
                {text}
              </button>
            ))}
          </div>

          <MeasurementEditor item={item} enclosure={enclosure} onChange={onChange} />

          {isBusComponent(item.componentType) && (
            <BusVisualEditor
              value={item.busVisual ?? null}
              onChange={(busVisual) => onChange({ ...item, busVisual })}
            />
          )}

          <div>
            <span className={label}>Note</span>
            <textarea className={field} rows={2} value={item.techNote ?? ''} onChange={(e) => onChange({ ...item, techNote: e.target.value || null })} />
          </div>

          {itemViolations.length > 0 && (
            <ul className="list-disc pl-4 text-xs text-amber-300">
              {itemViolations.map((v, i) => <li key={i}>{v.message}</li>)}
            </ul>
          )}

          <button type="button" className="text-xs font-medium text-red-400" onClick={onRemove}>Remove component</button>
        </div>
      )}
    </div>
  )
}

function MeasurementEditor({ item, enclosure, onChange }: {
  item: V2Item
  enclosure: V2Enclosure | undefined
  onChange: (next: V2Item) => void
}) {
  const available = measurementTypesFor(item.componentType, enclosure)
  const [type, setType] = useState(available[0] ?? 'thermal_delta_t')
  const [value, setValue] = useState('')
  const [loadAmps, setLoadAmps] = useState('')
  const [comparedTo, setComparedTo] = useState('')
  const [error, setError] = useState<string | null>(null)

  const add = () => {
    const measurement: V2Measurement = {
      measurementType: type as V2Measurement['measurementType'],
      measuredValue: Number(value),
      unit: UNIT_FOR[type] ?? '',
      loadAmperageAtReading: loadAmps === '' ? null : Number(loadAmps),
      comparativeReferenceItemId: comparedTo.trim() || null,
      methodStandard: isThermal(type) ? 'NETA MTS Table 100.18 framework' : null,
    }
    if (value === '' || Number.isNaN(measurement.measuredValue)) {
      setError('Enter the measured value.')
      return
    }
    const violation = checkMeasurement(measurement, enclosure)
    if (violation) {
      setError(violation.message)
      return
    }
    onChange({ ...item, measurements: [...(item.measurements ?? []), measurement] })
    setValue('')
    setLoadAmps('')
    setComparedTo('')
    setError(null)
  }

  return (
    <div className="space-y-2">
      {(item.measurements ?? []).map((m, index) => (
        <div key={index} className="flex items-center justify-between rounded bg-slate-900 px-2 py-1 text-xs text-slate-300">
          <span>
            {m.measurementType} = {m.measuredValue} {m.unit}
            {m.loadAmperageAtReading != null ? ` @ ${m.loadAmperageAtReading} A` : ''}
            {m.comparativeReferenceItemId ? ` vs ${m.comparativeReferenceItemId}` : ''}
          </span>
          <button
            type="button"
            className="text-red-400"
            onClick={() => onChange({ ...item, measurements: (item.measurements ?? []).filter((_, i) => i !== index) })}
          >
            ×
          </button>
        </div>
      ))}

      <div className="grid grid-cols-2 gap-2">
        <div>
          <span className={label}>Reading</span>
          <select className={field} value={type} onChange={(e) => setType(e.target.value)}>
            {available.map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
          </select>
        </div>
        <div>
          <span className={label}>Value ({UNIT_FOR[type] ?? '–'})</span>
          <input className={field} inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} />
        </div>
        {isThermal(type) && (
          <div>
            <span className={label}>Circuit current (A) — required</span>
            <input className={field} inputMode="decimal" value={loadAmps} onChange={(e) => setLoadAmps(e.target.value)} />
          </div>
        )}
        {isComparative(type) && (
          <div>
            <span className={label}>Compared against — required</span>
            <input className={field} placeholder="e.g. leg A stab 3" value={comparedTo} onChange={(e) => setComparedTo(e.target.value)} />
          </div>
        )}
      </div>
      {error && <p className="text-xs text-amber-300">{error}</p>}
      <button type="button" className={`${btn} bg-slate-700 text-slate-200`} onClick={add}>+ Add reading</button>
    </div>
  )
}

const BUS_FIELDS: Array<[keyof V2BusVisual, string, string[]]> = [
  ['corrosionLocation', 'Corrosion location', ['stab_contact_patch', 'bar_flat_non_contact', 'bolted_joint', 'neutral_bar', 'ground_bar']],
  ['corrosionProduct', 'Corrosion product', ['', 'white_powdery', 'green_blue', 'black_brown', 'red_rust']],
  ['platingStatus', 'Plating status', ['intact', 'tarnished_intact', 'breached_localized', 'breached_at_contact', 'absent']],
  ['materialLoss', 'Material loss', ['none', 'surface_film', 'light_pitting', 'deep_pitting', 'erosion_deformation']],
  ['arcSignature', 'Arc signature', ['none', 'spatter', 'rounded_melted_edges', 'material_transfer']],
  ['adjacentPolymer', 'Adjacent polymer', ['unaffected', 'discolored', 'browned_embrittled', 'charred']],
  ['heatTintMetal', 'Heat tint on metal', ['none', 'straw', 'blue_purple']],
]

function BusVisualEditor({ value, onChange }: {
  value: V2BusVisual | null
  onChange: (next: V2BusVisual) => void
}) {
  const current: V2BusVisual = value ?? {
    corrosionLocation: 'bar_flat_non_contact',
    corrosionProduct: null,
    platingStatus: 'intact',
    materialLoss: 'none',
    arcSignature: 'none',
    adjacentPolymer: 'unaffected',
    heatTintMetal: 'none',
  }

  return (
    <div className="rounded-md border border-slate-700 p-2">
      <p className="mb-2 text-xs font-semibold text-slate-300">Bus visual rubric (§8.5){value ? '' : ' — not yet recorded'}</p>
      <div className="grid grid-cols-2 gap-2">
        {BUS_FIELDS.map(([key, text, options]) => (
          <div key={key}>
            <span className={label}>{text}</span>
            <select
              className={field}
              value={(current[key] as string | null) ?? ''}
              onChange={(e) => onChange({ ...current, [key]: e.target.value === '' ? null : e.target.value })}
            >
              {options.map((o) => <option key={o} value={o}>{o === '' ? '—' : o.replace(/_/g, ' ')}</option>)}
            </select>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── GFCI coverage ────────────────────────────────────────────────────────────

function GfciSection({ capture, onChange }: { capture: V2Capture; onChange: (next: V2Capture) => void }) {
  const [location, setLocation] = useState('')
  const blank: Omit<V2GfciCoverage, 'locationDescriptor'> = {
    requiredAtInstall: true,
    requiredCurrentCode: true,
    protectionSource: 'none',
    functionTestResult: 'not_tested',
    classification: 'pass',
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-slate-400">
        Protection is resolved by LOCATION, wherever it sits — panel breaker or upstream device (§9.2).
      </p>
      {capture.gfciCoverage.map((row, index) => (
        <div key={index} className="space-y-2 rounded-lg border border-slate-700 bg-slate-800/60 p-3">
          <div className="flex items-center justify-between">
            <span className="font-medium text-white">{row.locationDescriptor}</span>
            <button type="button" className="text-xs text-red-400" onClick={() => onChange({ ...capture, gfciCoverage: capture.gfciCoverage.filter((_, i) => i !== index) })}>Remove</button>
          </div>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <label className="flex items-center gap-2 text-slate-300">
              <input type="checkbox" checked={row.requiredAtInstall} onChange={(e) => update(index, { requiredAtInstall: e.target.checked })} />
              Required at install era
            </label>
            <label className="flex items-center gap-2 text-slate-300">
              <input type="checkbox" checked={row.requiredCurrentCode} onChange={(e) => update(index, { requiredCurrentCode: e.target.checked })} />
              Required by current code
            </label>
            <div>
              <span className={label}>Protection source</span>
              <select className={field} value={row.protectionSource} onChange={(e) => update(index, { protectionSource: e.target.value as V2GfciCoverage['protectionSource'] })}>
                <option value="none">none</option>
                <option value="device">GFCI at device</option>
                <option value="upstream_device">upstream device</option>
                <option value="panel_breaker">panel breaker</option>
              </select>
            </div>
            <div>
              <span className={label}>Function test</span>
              <select className={field} value={row.functionTestResult ?? 'not_tested'} onChange={(e) => update(index, { functionTestResult: e.target.value as V2GfciCoverage['functionTestResult'] })}>
                <option value="pass">trips + resets</option>
                <option value="fail">fails to trip</option>
                <option value="not_tested">not tested</option>
              </select>
            </div>
            <div className="col-span-2">
              <span className={label}>Classification</span>
              <div className="grid grid-cols-4 gap-1">
                {CLASSES.map(([value, text, color]) => (
                  <button key={value} type="button" onClick={() => update(index, { classification: value })} className={`rounded py-1 text-xs font-bold text-white ${row.classification === value ? color : 'bg-slate-700 text-slate-300'}`}>
                    {text}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      ))}
      <div className="flex gap-2">
        <input className={field} placeholder="Location (e.g. kitchen counter east)" value={location} onChange={(e) => setLocation(e.target.value)} />
        <button
          type="button"
          className={`${btn} shrink-0 bg-slate-700 text-slate-200`}
          onClick={() => {
            if (!location.trim()) return
            onChange({ ...capture, gfciCoverage: [...capture.gfciCoverage, { locationDescriptor: location.trim(), ...blank }] })
            setLocation('')
          }}
        >
          + Add
        </button>
      </div>
    </div>
  )

  function update(index: number, patch: Partial<V2GfciCoverage>) {
    onChange({
      ...capture,
      gfciCoverage: capture.gfciCoverage.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    })
  }
}

// ── Sampling ─────────────────────────────────────────────────────────────────

function SamplingSection({ capture, onChange }: { capture: V2Capture; onChange: (next: V2Capture) => void }) {
  const categories: V2SamplingRecord['category'][] = ['receptacle', 'torque', 'switch', 'fixture']

  const rowFor = (category: V2SamplingRecord['category']) =>
    capture.samplingRecords.find((s) => s.category === category)

  const upsert = (category: V2SamplingRecord['category'], patch: Partial<V2SamplingRecord>) => {
    const existing = rowFor(category)
    const next: V2SamplingRecord = existing
      ? { ...existing, ...patch }
      : { category, totalCount: 0, testedCount: 0, basis: '', expandedDueToFail: false, ...patch }
    onChange({
      ...capture,
      samplingRecords: [...capture.samplingRecords.filter((s) => s.category !== category), next],
    })
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-slate-400">
        Sampling is legitimate; undisclosed sampling is not (§6). A FAIL inside a sample expands that
        category to 100% before this record can close.
      </p>
      {categories.map((category) => {
        const row = rowFor(category)
        const gateBlocked = row?.expandedDueToFail && row.testedCount < row.totalCount
        return (
          <div key={category} className={`space-y-2 rounded-lg border p-3 ${gateBlocked ? 'border-amber-600 bg-amber-950/40' : 'border-slate-700 bg-slate-800/60'}`}>
            <p className="font-medium capitalize text-white">{category}</p>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <span className={label}>Total on property</span>
                <input className={field} inputMode="numeric" value={row?.totalCount ?? ''} onChange={(e) => upsert(category, { totalCount: Number(e.target.value) || 0 })} />
              </div>
              <div>
                <span className={label}>Tested</span>
                <input className={field} inputMode="numeric" value={row?.testedCount ?? ''} onChange={(e) => upsert(category, { testedCount: Number(e.target.value) || 0 })} />
              </div>
              <div className="col-span-2">
                <span className={label}>Sampling basis</span>
                <input className={field} placeholder="e.g. one per branch circuit, 25% minimum" value={row?.basis ?? ''} onChange={(e) => upsert(category, { basis: e.target.value })} />
              </div>
              <label className="col-span-2 flex items-center gap-2 text-sm text-slate-300">
                <input type="checkbox" checked={row?.expandedDueToFail ?? false} onChange={(e) => upsert(category, { expandedDueToFail: e.target.checked })} />
                A FAIL was found in this sample (expands it to 100%)
              </label>
            </div>
            {gateBlocked && (
              <p className="text-xs text-amber-300">
                {row!.testedCount}/{row!.totalCount} tested — must reach 100% before close (§6.3).
              </p>
            )}
          </div>
        )
      })}
    </div>
  )
}
