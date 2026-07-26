import { useState } from 'react'
import { savePhoto } from '../../db/photos'
import type { ChecklistItemDef, GradedState, InspectionLoadCalc, ItemResult, ResultState } from '../../domain/types'
import { LoadCalcPanel } from '../components/LoadCalcPanel'

interface Props {
  item: ChecklistItemDef
  existing?: ItemResult
  existingLoadCalc?: InspectionLoadCalc
  onSave: (result: ItemResult, loadCalc?: InspectionLoadCalc) => void
  onBack: () => void
}

const resultOptions: { value: ResultState; label: string; classes: string }[] = [
  { value: 'PASS', label: 'PASS', classes: 'border-emerald-500 bg-emerald-700/40' },
  { value: 'MONITOR', label: 'MONITOR', classes: 'border-amber-500 bg-amber-600/40' },
  { value: 'ACTION', label: 'ACTION', classes: 'border-red-500 bg-red-700/40' },
  { value: 'BELOW_STANDARD', label: 'BELOW STANDARD', classes: 'border-sky-500 bg-sky-800/40' },
]

export function ItemCardScreen({ item, existing, existingLoadCalc, onSave, onBack }: Props) {
  const [result, setResult] = useState<ResultState | undefined>(existing?.result)
  const [gradedState, setGradedState] = useState<GradedState | undefined>(existing?.gradedState)
  const [measured, setMeasured] = useState<Record<string, string | number>>(existing?.measured ?? {})
  const [photoIds, setPhotoIds] = useState<string[]>(existing?.photoIds ?? [])
  const [note, setNote] = useState(existing?.note ?? '')
  const [error, setError] = useState<string | null>(null)
  const [loadCalc, setLoadCalc] = useState<InspectionLoadCalc | undefined>(existingLoadCalc)

  const options = item.naAllowed
    ? [...resultOptions, { value: 'NA' as ResultState, label: 'N/A (logged)', classes: 'border-slate-500 bg-slate-700/40' }]
    : resultOptions

  const hasMeasuredValue = item.inputFields.some(
    (field) => String(measured[field.id] ?? '').trim().length > 0,
  )

  async function capturePhoto(file: File) {
    const id = crypto.randomUUID()
    await savePhoto(id, file)
    setPhotoIds((ids) => [...ids, id])
  }

  function save() {
    if (!result) {
      setError('Select a result.')
      return
    }
    if (item.graded && result !== 'PASS' && result !== 'NA' && !gradedState) {
      setError('Select the graded condition that matches the evidence.')
      return
    }
    // Mandatory evidence (spec §11): any ACTION — and every banner-listed ACTION —
    // requires ≥1 photo and the measured value before it can be marked complete.
    if (result === 'ACTION' && (photoIds.length === 0 || !hasMeasuredValue)) {
      setError('An ACTION finding requires at least one photo and the measured value.')
      return
    }
    onSave({
      itemId: item.id,
      result,
      gradedState: item.graded && result !== 'PASS' && result !== 'NA' ? gradedState : undefined,
      measured,
      photoIds,
      note: note.trim() || undefined,
    }, loadCalc)
  }

  return (
    <div className="mx-auto max-w-xl space-y-5 p-6">
      <button type="button" onClick={onBack} className="text-sm text-sky-300">
        ← Checklist
      </button>
      <h1 className="text-lg font-semibold text-white">
        {item.id}. {item.title}
      </h1>

      <section className="space-y-3 rounded-xl border border-slate-700 bg-slate-800/60 p-4 text-sm text-slate-200">
        <div>
          <h2 className="font-medium text-sky-300">What we check</h2>
          <p>{item.reasoning.whatWeCheck}</p>
        </div>
        <div>
          <h2 className="font-medium text-sky-300">Why code cares</h2>
          <p>{item.reasoning.whyCodeCares}</p>
        </div>
        <p className="text-xs text-slate-400">{item.citations.join(' · ')}</p>
      </section>

      {item.id === 'A2' && (
        <LoadCalcPanel
          initial={loadCalc}
          onApply={(record) => {
            setLoadCalc(record)
            setMeasured((m) => ({
              ...m,
              service_amps: record.input.serviceAmps,
              calc_load: record.result.governingAmps,
            }))
          }}
        />
      )}

      {item.inputFields.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-medium text-slate-300">Measured values</h2>
          {item.inputFields.map((field) => (
            <label key={field.id} className="block space-y-1">
              <span className="text-xs text-slate-400">{field.label}</span>
              <input
                type={field.type === 'number' ? 'number' : 'text'}
                inputMode={field.type === 'number' ? 'decimal' : undefined}
                className="w-full rounded-lg border border-slate-600 bg-slate-800 p-3 text-white"
                value={String(measured[field.id] ?? '')}
                onChange={(e) =>
                  setMeasured((m) => ({
                    ...m,
                    [field.id]:
                      field.type === 'number' && e.target.value !== ''
                        ? Number(e.target.value)
                        : e.target.value,
                  }))
                }
              />
            </label>
          ))}
        </section>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-slate-300">Result</h2>
        <div className="grid grid-cols-2 gap-2">
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => setResult(option.value)}
              className={`rounded-lg border p-3 text-sm font-semibold text-white ${
                result === option.value ? option.classes : 'border-slate-700 bg-slate-800/60'
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
        {result === 'BELOW_STANDARD' && (
          <p className="text-xs text-sky-200">
            Meets code — below Red Cedar's enhanced standard. The report will state this plainly.
          </p>
        )}
      </section>

      {item.graded && result && result !== 'PASS' && result !== 'NA' && (
        <section className="space-y-2">
          <h2 className="text-sm font-medium text-slate-300">
            Graded condition (score to worst-case potential — photo required)
          </h2>
          <div className="grid grid-cols-3 gap-2">
            {item.graded.map((grade) => (
              <button
                key={grade}
                type="button"
                onClick={() => setGradedState(grade)}
                className={`rounded-lg border p-2 text-sm text-white ${
                  gradedState === grade ? 'border-red-500 bg-red-700/40' : 'border-slate-700 bg-slate-800/60'
                }`}
              >
                {grade}
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-slate-300">
          Photos {photoIds.length > 0 && `(${photoIds.length} attached)`}
        </h2>
        <input
          type="file"
          accept="image/*"
          capture="environment"
          className="w-full text-sm text-slate-300"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) void capturePhoto(file)
            e.target.value = ''
          }}
        />
      </section>

      <label className="block space-y-1">
        <span className="text-sm font-medium text-slate-300">Note</span>
        <textarea
          className="w-full rounded-lg border border-slate-600 bg-slate-800 p-3 text-white"
          rows={2}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </label>

      {error && <p className="rounded-lg bg-red-900/60 p-3 text-sm text-red-200">{error}</p>}

      <button
        type="button"
        onClick={save}
        className="w-full rounded-lg bg-sky-600 p-3 font-medium text-white"
      >
        Save item
      </button>
    </div>
  )
}
