import { useMemo, useState } from 'react'
import { capacityCheck220_83, resolveVA, type LoadCalcInput, type LoadItem } from '../../domain/loadcalc'
import { FUTURE_PICKS, HVAC_PICK_TYPES, QUICK_PICKS, newLoadItem } from '../../data/loadPicks'
import { submitCapacityCheck } from '../../lib/crmSync'
import type { CrmAssignment } from '../../domain/types'

/**
 * "Can this service take what the customer wants to add?"
 *
 * The first-pass check on every add-load call — an EV charger, a heat pump, a
 * hot tub. Fast, defensible, code-cited, and it needs no return trip. Runs
 * without an assessment in progress, because that's how it comes up: an ordinary
 * service call and a question at the door.
 *
 * Sections in the order a technician works: existing service ampacity, floor
 * area, what's already there, what's being added, answer.
 */

interface Props {
  assignment?: CrmAssignment
  onBack: () => void
}

const kw = (item: LoadItem) => (resolveVA(item) / 1000).toFixed(1)

export function CapacityCheckScreen({ assignment, onBack }: Props) {
  const [serviceAmps, setServiceAmps] = useState(100)
  const [floorAreaSqFt, setFloorAreaSqFt] = useState(1500)
  const [existing, setExisting] = useState<LoadItem[]>([])
  const [added, setAdded] = useState<LoadItem[]>([])
  const [saved, setSaved] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const input: LoadCalcInput = useMemo(
    () => ({
      mode: 'tech',
      occupancy: 'dwellingSingleFamily',
      serviceAmps,
      serviceVoltage: 240,
      floorAreaSqFt,
      loads: existing,
    }),
    [serviceAmps, floorAreaSqFt, existing],
  )

  const result = useMemo(() => capacityCheck220_83(input, added), [input, added])
  const addingHvac = added.some((item) => HVAC_PICK_TYPES.has(item.type))

  async function save() {
    setError(null)
    if (!assignment) {
      setError('Open this from an assigned job to file the calculation to the account.')
      return
    }
    try {
      const id = crypto.randomUUID()
      await submitCapacityCheck({
        id,
        visitId: assignment.visitId,
        propertyId: assignment.propertyId,
        serviceAmps,
        floorAreaSqFt,
        loads: existing,
        newLoads: added,
        newLoadLabel: added.map((item) => item.label).join(', ') || null,
      })
      setSaved(id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="mx-auto max-w-xl space-y-5 p-6 pb-28">
      <button type="button" onClick={onBack} className="text-sm text-sky-300">← Back</button>

      <header className="space-y-1">
        <h1 className="text-lg font-semibold text-white">Can this service take the new load?</h1>
        <p className="text-xs text-slate-400">
          NEC 220.83 — the existing-dwelling calculation. Run this before quoting anything, including
          a service upgrade.
        </p>
        {assignment && <p className="text-xs text-slate-500">{assignment.address.formatted}</p>}
      </header>

      {/* 1. Existing service */}
      <section className="space-y-2 rounded-xl border border-slate-700 bg-slate-800/60 p-4">
        <h2 className="text-sm font-medium text-sky-300">1 · Existing service</h2>
        <div className="grid grid-cols-2 gap-3">
          <label className="text-xs text-slate-300">
            Service rating (A)
            <input
              type="number"
              inputMode="numeric"
              className="mt-1 w-full rounded border border-slate-600 bg-slate-900 p-3 text-white"
              value={serviceAmps}
              onChange={(e) => setServiceAmps(Number(e.target.value) || 0)}
            />
          </label>
          <label className="text-xs text-slate-300">
            Floor area (ft²)
            <input
              type="number"
              inputMode="numeric"
              className="mt-1 w-full rounded border border-slate-600 bg-slate-900 p-3 text-white"
              value={floorAreaSqFt}
              onChange={(e) => setFloorAreaSqFt(Number(e.target.value) || 0)}
            />
          </label>
        </div>
        <p className="text-xs text-slate-500">
          Conditioned area, excluding open porches and unfinished space (220.12).
        </p>
      </section>

      {/* 2. What's already there */}
      <LoadSection
        heading="2 · What's already there"
        blurb="Fastened appliances, ranges, dryers, water heaters, HVAC. Small-appliance and laundry circuits are counted automatically."
        picks={QUICK_PICKS}
        items={existing}
        onAdd={(pick) => setExisting((list) => [...list, newLoadItem(pick)])}
        onRemove={(id) => setExisting((list) => list.filter((item) => item.id !== id))}
        onConfirmPlate={(id) =>
          setExisting((list) => list.map((item) => (item.id === id ? { ...item, nameplateRead: true } : item)))
        }
      />

      {/* 3. What's being added */}
      <LoadSection
        heading="3 · What's being added"
        blurb="The load the customer is asking about."
        picks={FUTURE_PICKS}
        items={added}
        onAdd={(pick) => setAdded((list) => [...list, newLoadItem(pick)])}
        onRemove={(id) => setAdded((list) => list.filter((item) => item.id !== id))}
        onConfirmPlate={(id) =>
          setAdded((list) => list.map((item) => (item.id === id ? { ...item, nameplateRead: true } : item)))
        }
      />

      {/* 4. The answer */}
      <section
        className={`space-y-2 rounded-xl border p-4 ${
          result.fits ? 'border-emerald-700 bg-emerald-950/30' : 'border-red-700 bg-red-950/30'
        }`}
      >
        <h2 className="text-sm font-medium text-slate-300">4 · Result</h2>
        <p className="text-2xl font-semibold text-white">
          {result.amps} A of {result.serviceAmps} A — {result.loadPct}% loaded
        </p>
        <p className={`text-sm font-medium ${result.fits ? 'text-emerald-300' : 'text-red-300'}`}>
          {result.fits
            ? `Calculates. ${result.spareAmps} A spare — quote the addition.`
            : `Does not calculate. Over by ${Math.abs(result.spareAmps)} A — quote the service upgrade.`}
        </p>

        {/* The (A)/(B) branch is visible on purpose: it's a large difference and
            the technician should see which one applied, not have it inferred. */}
        <p className="rounded bg-slate-900/60 p-2 text-xs text-slate-300">
          <span className="font-medium text-sky-300">220.83({result.variant})</span>{' '}
          {addingHvac
            ? 'New air conditioning or space heat, so it counts at 100% and only the rest is staged.'
            : 'No new air conditioning or space heat, so the whole connected load stages.'}
        </p>
        <p className="text-xs text-slate-400">{result.citation}</p>

        {!result.fits && (
          <p className="rounded border border-amber-800 bg-amber-950/40 p-2 text-xs text-amber-200">
            A 220.87 metered demand study is a separate, priced service — a recorder, a return trip
            and thirty days. Only order one if the customer has said they want to try to avoid the
            upgrade, and tell them plainly: if the study comes back short, the upgrade is still
            needed and the fee is spent. The office orders it.
          </p>
        )}

        <details className="text-xs text-slate-300">
          <summary className="cursor-pointer text-sky-300">Show the arithmetic</summary>
          <table className="mt-2 w-full">
            <tbody>
              {result.breakdown.map((line, index) => (
                <tr key={`${line.label}-${index}`} className="border-t border-slate-700">
                  <td className="py-1 pr-2">{line.label}</td>
                  <td className="py-1 text-right tabular-nums">{Math.round(line.appliedVA)} VA</td>
                  <td className="py-1 pl-2 text-right text-slate-500">{line.rule}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>

        {result.assumedValues.length > 0 && (
          <p className="text-xs text-amber-300">
            Assumed nameplates: {result.assumedValues.join(', ')}. A calculation built on guesses is
            a different document from one built on plate readings — confirm before it goes to a
            customer.
          </p>
        )}
      </section>

      {error && <p className="rounded-lg bg-red-900/60 p-3 text-sm text-red-200">{error}</p>}
      {saved && (
        <p className="rounded-lg bg-emerald-900/50 p-3 text-sm text-emerald-200">
          Filed to the account. It syncs when there's signal.
        </p>
      )}

      <button
        type="button"
        onClick={() => void save()}
        disabled={Boolean(saved)}
        className="w-full rounded-lg bg-sky-600 p-3 font-medium text-white disabled:bg-slate-700"
      >
        {saved ? 'Filed' : 'File this calculation to the account'}
      </button>
    </div>
  )
}

function LoadSection({
  heading, blurb, picks, items, onAdd, onRemove, onConfirmPlate,
}: {
  heading: string
  blurb: string
  picks: { label: string; item: Omit<LoadItem, 'id'> }[]
  items: LoadItem[]
  onAdd: (pick: Omit<LoadItem, 'id'>) => void
  onRemove: (id: string) => void
  onConfirmPlate: (id: string) => void
}) {
  return (
    <section className="space-y-2 rounded-xl border border-slate-700 bg-slate-800/60 p-4">
      <h2 className="text-sm font-medium text-sky-300">{heading}</h2>
      <p className="text-xs text-slate-500">{blurb}</p>

      <div className="flex flex-wrap gap-2">
        {picks.map((pick) => (
          <button
            key={pick.label}
            type="button"
            onClick={() => onAdd(pick.item)}
            className="rounded border border-slate-600 px-2 py-1.5 text-xs text-slate-200"
          >
            + {pick.label}
          </button>
        ))}
      </div>

      {items.length > 0 && (
        <ul className="space-y-1 pt-2">
          {items.map((item) => (
            <li key={item.id} className="flex items-center justify-between gap-2 rounded bg-slate-900/60 p-2 text-xs">
              <span className="min-w-0">
                <span className="block text-slate-200">{item.label}</span>
                <span className="block text-slate-500">
                  {kw(item)} kW
                  {!item.nameplateRead && ' · assumed'}
                </span>
              </span>
              <span className="flex shrink-0 gap-2">
                {!item.nameplateRead && (
                  <button
                    type="button"
                    onClick={() => onConfirmPlate(item.id)}
                    className="rounded border border-emerald-700 px-2 py-1 text-emerald-300"
                  >
                    read plate
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => onRemove(item.id)}
                  className="rounded border border-slate-600 px-2 py-1 text-slate-400"
                >
                  remove
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
