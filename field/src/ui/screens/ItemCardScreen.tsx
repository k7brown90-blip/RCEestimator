import { useMemo, useState } from 'react'
import type { FindingRecord } from '../../db/database'
import { savePhoto } from '../../db/photos'
import { branchDropVerdict } from '../../domain/diagnostics'
import { applyFormula } from '../../domain/formulas'
import {
  isBlank,
  missingRequiredCells,
  missingRequiredFields,
  requiresOverrideReason,
  suggestedVerdict,
} from '../../domain/fieldValidation'
import type {
  ChecklistItemDef,
  GradedState,
  InspectionLoadCalc,
  ItemResult,
  MeasuredRow,
  MeasuredValue,
  ResultState,
} from '../../domain/types'
import { FieldInput } from '../components/FieldInput'
import { LoadCalcPanel } from '../components/LoadCalcPanel'

interface Props {
  item: ChecklistItemDef
  existing?: ItemResult
  existingLoadCalc?: InspectionLoadCalc
  /** Saved results for other items, so cross-item formula inputs resolve. */
  otherResults?: Record<string, ItemResult>
  /**
   * What the ledger already holds for this item at this address.
   *
   * The best place in the app for it: the technician is looking at the same
   * equipment the last finding was written about, deciding what to record. Any
   * other placement asks them to remember.
   */
  openFinding?: FindingRecord
  onSave: (result: ItemResult, loadCalc?: InspectionLoadCalc) => void
  onBack: () => void
}

const num = (value: MeasuredValue | undefined): number => {
  if (typeof value === 'number') return value
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : NaN
}

/**
 * Resolve a formula input reference. A bare id reads this item's own fields;
 * `ITEM.field` reads another item's, so C1 can cite the service rating recorded
 * on A2 without the technician typing it twice.
 */
function resolveInput(
  ref: string,
  measured: Record<string, MeasuredValue>,
  otherResults: Record<string, ItemResult>,
): number {
  if (!ref.includes('.')) return num(measured[ref])
  const [itemId, fieldId] = ref.split('.')
  return num(otherResults[itemId]?.measured?.[fieldId])
}

/** Positional argument names each formula expects, matching formulas.ts. */
function formulaArgNames(formula: string): string[] {
  switch (formula) {
    case 'neutral_current':
    case 'leg_imbalance_pct':
      return ['legA', 'legB']
    case 'branch_drop_delta':
      return ['reference', 'measured']
    case 'age_from_install_year':
      return ['installYear']
    default:
      return []
  }
}

function omit(
  record: Record<string, MeasuredValue>,
  key: string,
): Record<string, MeasuredValue> {
  const next = { ...record }
  delete next[key]
  return next
}

const resultOptions: { value: ResultState; label: string; classes: string }[] = [
  { value: 'PASS', label: 'PASS', classes: 'border-emerald-500 bg-emerald-700/40' },
  { value: 'MONITOR', label: 'MONITOR', classes: 'border-amber-500 bg-amber-600/40' },
  { value: 'FAIL', label: 'FAIL', classes: 'border-red-500 bg-red-700/40' },
  { value: 'BELOW_STANDARD', label: 'BELOW STANDARD', classes: 'border-sky-500 bg-sky-800/40' },
]

export function ItemCardScreen({
  item, existing, existingLoadCalc, otherResults = {}, openFinding, onSave, onBack,
}: Props) {
  const [result, setResult] = useState<ResultState | undefined>(existing?.result)
  const [gradedState, setGradedState] = useState<GradedState | undefined>(existing?.gradedState)
  const [measured, setMeasured] = useState<Record<string, MeasuredValue>>(existing?.measured ?? {})
  const [photoIds, setPhotoIds] = useState<string[]>(existing?.photoIds ?? [])
  const [note, setNote] = useState(existing?.note ?? '')
  const [resolutionNote, setResolutionNote] = useState(existing?.resolutionNote ?? '')
  const [overrideReason, setOverrideReason] = useState(existing?.overrideReason ?? '')
  const [error, setError] = useState<string | null>(null)
  const [loadCalc, setLoadCalc] = useState<InspectionLoadCalc | undefined>(existingLoadCalc)

  const options = item.naAllowed
    ? [...resultOptions, { value: 'NA' as ResultState, label: 'N/A (logged)', classes: 'border-slate-500 bg-slate-700/40' }]
    : resultOptions

  /** Formula outputs, recalculated live so the technician sees them as they type. */
  const computed = useMemo(() => {
    const values: Record<string, number> = {}
    for (const field of item.inputFields) {
      if (field.type !== 'computed' || !field.formula) continue
      const inputs: Record<string, number> = {}
      const names = formulaArgNames(field.formula)
      ;(field.formulaInputs ?? []).forEach((ref, index) => {
        const name = names[index]
        if (name) inputs[name] = resolveInput(ref, measured, otherResults)
      })
      values[field.id] = applyFormula(field.formula, inputs)
    }
    return values
  }, [item.inputFields, measured, otherResults])

  /**
   * Per-row deltas and verdicts for a branch-drop table. The reference is the
   * matching leg's L–N reading from the panel-voltage item, so a row's drop is
   * always measured against the control taken at the service.
   */
  const tableState = useMemo(() => {
    const state: Record<string, { rows: MeasuredRow[]; verdicts: ResultState[] }> = {}
    for (const field of item.inputFields) {
      if (field.type !== 'table') continue
      const rows = Array.isArray(measured[field.id]) ? (measured[field.id] as MeasuredRow[]) : []
      const deltaColumn = field.columns?.find((column) => column.formula === 'branch_drop_delta')
      if (!deltaColumn) {
        state[field.id] = { rows, verdicts: [] }
        continue
      }

      const withDeltas = rows.map((row) => {
        const leg = String(row.leg ?? 'L1')
        const referenceRef = leg === 'L2' ? 'D6.v_l2_n' : 'D6.v_l1_n'
        const reference = resolveInput(referenceRef, measured, otherResults)
        const measuredVolts = num(row.measured_v)
        const delta = Number.isFinite(reference) && Number.isFinite(measuredVolts)
          ? applyFormula('branch_drop_delta', { reference, measured: measuredVolts })
          : NaN
        return { ...row, [deltaColumn.id]: Number.isFinite(delta) ? delta : '' }
      })

      state[field.id] = {
        rows: withDeltas,
        verdicts: withDeltas.map((row) =>
          branchDropVerdict(num(row[deltaColumn.id]), Boolean(row.unstable)),
        ),
      }
    }
    return state
  }, [item.inputFields, measured, otherResults])

  /** Worst verdict any reading implies — the number's opinion, before the tech's. */
  const suggested = useMemo(() => {
    const fromFields = suggestedVerdict(item.inputFields, { ...measured, ...computed })
    const fromRows = Object.values(tableState).flatMap((table) => table.verdicts)
    if (!fromFields && fromRows.length === 0) return null

    const order: ResultState[] = ['NA', 'PASS', 'BELOW_STANDARD', 'MONITOR', 'FAIL']
    let verdict = fromFields?.verdict ?? 'PASS'
    for (const rowVerdict of fromRows) {
      if (order.indexOf(rowVerdict) > order.indexOf(verdict)) verdict = rowVerdict
    }
    return { verdict, reasons: fromFields?.reasons ?? [] }
  }, [item.inputFields, measured, computed, tableState])

  const needsOverrideReason = requiresOverrideReason(suggested?.verdict, result ?? 'PASS')

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

    // "We want to always measure to collect data" — required readings are
    // required whatever the verdict, not just when something's wrong. N/A is the
    // one exception: there was nothing there to measure.
    if (result !== 'NA') {
      const missing = missingRequiredFields(item.inputFields, measured)
      if (missing.length > 0) {
        const labels = item.inputFields
          .filter((field) => missing.includes(field.id))
          .map((field) => field.label)
        setError(`Record ${labels.join(', ')} before saving.`)
        return
      }
      for (const field of item.inputFields) {
        if (field.type !== 'table') continue
        const rows = tableState[field.id]?.rows ?? []
        if (field.minRows && rows.length < field.minRows) {
          setError(`${field.label}: at least ${field.minRows} reading required.`)
          return
        }
        const incomplete = missingRequiredCells(field, rows)
        if (incomplete.length > 0) {
          setError(`${field.label}: row ${incomplete[0] + 1} is incomplete.`)
          return
        }
      }
    }

    // A FAIL is a claim the customer will be asked to pay to fix, so it carries
    // its own evidence: a photo of the condition and what it'll take to correct.
    if (result === 'FAIL') {
      if (photoIds.length === 0) {
        setError('A FAIL needs at least one photo of the condition.')
        return
      }
      if (!resolutionNote.trim()) {
        setError('A FAIL needs a resolution — what will it take to correct this?')
        return
      }
    }

    if (needsOverrideReason && !overrideReason.trim()) {
      setError(`The readings suggest ${suggested?.verdict}. Say why you're recording ${result}.`)
      return
    }

    // Persist the derived values alongside the raw ones. Recomputing at render
    // time would let a later edit upstream silently rewrite what was reported.
    const measuredWithTables = { ...measured }
    const rowVerdicts: Record<string, ResultState[]> = {}
    for (const [fieldId, table] of Object.entries(tableState)) {
      measuredWithTables[fieldId] = table.rows
      if (table.verdicts.length > 0) rowVerdicts[fieldId] = table.verdicts
    }

    onSave({
      itemId: item.id,
      result,
      gradedState: item.graded && result !== 'PASS' && result !== 'NA' ? gradedState : undefined,
      measured: measuredWithTables,
      computed: Object.keys(computed).length > 0 ? computed : undefined,
      autoVerdicts: suggested ? { [item.id]: suggested.verdict } : undefined,
      rowVerdicts: Object.keys(rowVerdicts).length > 0 ? rowVerdicts : undefined,
      photoIds,
      note: note.trim() || undefined,
      resolutionNote: result === 'FAIL' ? resolutionNote.trim() : undefined,
      overrideReason: needsOverrideReason ? overrideReason.trim() : undefined,
    }, loadCalc)
  }

  return (
    <div className="mx-auto max-w-xl space-y-5 p-6">
      <button type="button" onClick={onBack} className="text-sm text-sky-300">
        ← Checklist
      </button>
      <h1 className="text-lg font-semibold text-white">
        {item.title}
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

      {item.id === 'LOAD' && (
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
        <section className="space-y-4">
          <h2 className="text-sm font-medium text-slate-300">Measured values</h2>
          {item.inputFields.map((field) => (
            <FieldInput
              key={field.id}
              field={field}
              measured={measured}
              value={
                field.type === 'computed'
                  ? computed[field.id]
                  : field.type === 'table'
                    ? tableState[field.id]?.rows ?? []
                    : measured[field.id]
              }
              rowVerdicts={tableState[field.id]?.verdicts}
              onChange={(value) =>
                setMeasured((m) => (isBlank(value) ? omit(m, field.id) : { ...m, [field.id]: value }))
              }
            />
          ))}
        </section>
      )}

      {openFinding && (
        <section
          className={`space-y-1 rounded-xl border p-4 text-xs ${
            openFinding.status === 'declined'
              ? 'border-slate-600 bg-slate-800/60'
              : 'border-amber-700 bg-amber-950/30'
          }`}
        >
          <h2 className="text-sm font-medium text-amber-200">
            {openFinding.status === 'declined'
              ? 'Previously declined at this address'
              : `Open since ${new Date(openFinding.openedAt).toLocaleDateString()}`}
          </h2>
          <p className="text-slate-300">{openFinding.findingText}</p>
          {openFinding.resolutionNote && (
            <p className="text-slate-400">Recommended: {openFinding.resolutionNote}</p>
          )}
          {openFinding.status === 'declined' && openFinding.declinedVerbatim && (
            <p className="italic text-slate-400">
              “{openFinding.declinedVerbatim}” — {openFinding.declinedByName}
              {openFinding.declinedByRelation
                ? ` (${openFinding.declinedByRelation.replace(/_/g, ' ')})`
                : ''}
            </p>
          )}
          <p className="text-slate-500">
            {openFinding.observedCount > 1
              ? `Recorded ${openFinding.observedCount} times. `
              : ''}
            Record what you find today — the ledger reconciles it against this.
          </p>
        </section>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-slate-300">Result</h2>

        {suggested && (
          <div className="rounded-lg border border-slate-700 bg-slate-800/60 p-3 text-xs">
            <p className="text-slate-300">
              Your readings suggest <span className="font-semibold">{suggested.verdict}</span>.
            </p>
            {suggested.reasons.map((reason) => (
              <p key={reason} className="mt-1 text-slate-400">{reason}</p>
            ))}
            {result === undefined && (
              <button
                type="button"
                onClick={() => setResult(suggested.verdict)}
                className="mt-2 rounded border border-sky-700 px-2 py-1 text-sky-300"
              >
                Use {suggested.verdict}
              </button>
            )}
          </div>
        )}

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

        {needsOverrideReason && (
          <label className="block space-y-1">
            <span className="text-xs text-amber-300">
              You're recording {result} where the readings suggest {suggested?.verdict}. Why?
            </span>
            <input
              className="w-full rounded-lg border border-amber-700 bg-slate-800 p-3 text-sm text-white"
              placeholder="e.g. reading taken with the load disconnected"
              value={overrideReason}
              onChange={(e) => setOverrideReason(e.target.value)}
            />
          </label>
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
        {/* Camera AND gallery (Kyle, 2026-08-25: "needs access to the phones
            photo gallery for upload along with the take photo option"). Two
            inputs on purpose: `capture` forces the camera open and locks the
            gallery out, so each door gets its own input. */}
        <div className="flex gap-2">
          <input
            id={`photo-camera-${item.id}`}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) void capturePhoto(file)
              e.target.value = ''
            }}
          />
          <input
            id={`photo-gallery-${item.id}`}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) void capturePhoto(file)
              e.target.value = ''
            }}
          />
          <label
            htmlFor={`photo-camera-${item.id}`}
            className="flex-1 cursor-pointer rounded-lg border border-slate-600 p-2 text-center text-sm text-slate-200"
          >
            📷 Take photo
          </label>
          <label
            htmlFor={`photo-gallery-${item.id}`}
            className="flex-1 cursor-pointer rounded-lg border border-slate-600 p-2 text-center text-sm text-slate-200"
          >
            🖼 From gallery
          </label>
        </div>
      </section>

      {result === 'FAIL' && (
        <label className="block space-y-1">
          <span className="text-sm font-medium text-red-300">
            Resolution — what will correct this? (required)
          </span>
          <textarea
            className="w-full rounded-lg border border-red-700 bg-slate-800 p-3 text-white"
            rows={3}
            placeholder="e.g. Install GFCI receptacle at the washer outlet"
            value={resolutionNote}
            onChange={(e) => setResolutionNote(e.target.value)}
          />
          <span className="block text-xs text-slate-400">
            This goes on the report as the recommended fix.
          </span>
        </label>
      )}

      <label className="block space-y-1">
        <span className="text-sm font-medium text-slate-300">Observations (optional)</span>
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
