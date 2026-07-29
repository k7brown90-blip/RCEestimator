import { evaluateThreshold, isFieldRequired } from '../../domain/fieldValidation'
import type { InputFieldDef, MeasuredRow, MeasuredValue, ResultState } from '../../domain/types'

interface Props {
  field: InputFieldDef
  value: MeasuredValue | undefined
  measured: Record<string, MeasuredValue>
  onChange: (value: MeasuredValue) => void
  /** Verdicts for a table field's rows, positionally. */
  rowVerdicts?: ResultState[]
}

const VERDICT_HINT: Record<ResultState, string> = {
  PASS: 'text-emerald-300',
  MONITOR: 'text-amber-300',
  FAIL: 'text-red-300',
  BELOW_STANDARD: 'text-sky-300',
  NA: 'text-slate-400',
}

const VERDICT_CHIP: Record<ResultState, string> = {
  PASS: 'bg-emerald-700 text-emerald-100',
  MONITOR: 'bg-amber-600 text-amber-50',
  FAIL: 'bg-red-700 text-red-100',
  BELOW_STANDARD: 'bg-sky-800 text-sky-100',
  NA: 'bg-slate-600 text-slate-200',
}

const inputClass = 'w-full rounded-lg border border-slate-600 bg-slate-800 p-3 text-white'

/**
 * One control per field type, sized for a phone held one-handed in a crawlspace.
 *
 * Selects render as chip buttons rather than a dropdown — a native picker on a
 * phone means two taps and a scroll for what should be one tap.
 */
export function FieldInput({ field, value, measured, onChange, rowVerdicts }: Props) {
  const required = isFieldRequired(field, measured)
  const threshold = evaluateThreshold(field, value)

  return (
    <div className="space-y-1">
      <label className="block space-y-1">
        <span className="text-xs text-slate-400">
          {field.label}
          {field.unit ? ` (${field.unit})` : ''}
          {required && <span className="ml-1 text-red-400">*</span>}
        </span>
        <Control field={field} value={value} onChange={onChange} rowVerdicts={rowVerdicts} measured={measured} />
      </label>

      {field.helpText && <p className="text-xs text-slate-500">{field.helpText}</p>}

      {threshold && (
        <p className={`text-xs ${VERDICT_HINT[threshold.verdict]}`}>
          {threshold.message ?? `Reads as ${threshold.verdict}.`}
        </p>
      )}
    </div>
  )
}

function Control({ field, value, onChange, rowVerdicts, measured }: Props) {
  switch (field.type) {
    case 'number':
      return (
        <input
          type="number"
          inputMode="decimal"
          className={inputClass}
          min={field.min}
          max={field.max}
          step={field.step}
          placeholder={field.placeholder}
          value={value === undefined ? '' : String(value)}
          onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
        />
      )

    case 'select':
      return (
        <div className="grid grid-cols-2 gap-2">
          {(field.options ?? []).map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => onChange(value === option.value ? '' : option.value)}
              className={`rounded-lg border p-2 text-left text-sm text-white ${
                value === option.value
                  ? 'border-sky-500 bg-sky-800/50'
                  : 'border-slate-700 bg-slate-800/60'
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      )

    case 'multiselect': {
      const selected = Array.isArray(value) ? (value as string[]) : []
      return (
        <div className="flex flex-wrap gap-2">
          {(field.options ?? []).map((option) => {
            const on = selected.includes(option.value)
            return (
              <button
                key={option.value}
                type="button"
                onClick={() =>
                  onChange(on ? selected.filter((v) => v !== option.value) : [...selected, option.value])
                }
                className={`rounded-full border px-3 py-1.5 text-sm text-white ${
                  on ? 'border-sky-500 bg-sky-800/50' : 'border-slate-700 bg-slate-800/60'
                }`}
              >
                {option.label}
              </button>
            )
          })}
        </div>
      )
    }

    case 'boolean':
      return (
        <button
          type="button"
          onClick={() => onChange(!value)}
          className={`w-full rounded-lg border p-3 text-left text-sm text-white ${
            value ? 'border-amber-500 bg-amber-700/40' : 'border-slate-700 bg-slate-800/60'
          }`}
        >
          {value ? 'Yes' : 'No'}
        </button>
      )

    case 'computed':
      return (
        <div className="rounded-lg border border-slate-700 bg-slate-900/60 p-3 text-white">
          {value === undefined || value === '' ? (
            <span className="text-sm text-slate-500">Calculated from your readings</span>
          ) : (
            <span className="text-lg font-medium">
              {String(value)}
              {field.unit ? ` ${field.unit}` : ''}
            </span>
          )}
        </div>
      )

    case 'table':
      return (
        <TableInput
          field={field}
          rows={Array.isArray(value) ? (value as MeasuredRow[]) : []}
          onChange={onChange}
          rowVerdicts={rowVerdicts}
          measured={measured}
        />
      )

    case 'text':
    default:
      return (
        <input
          type="text"
          className={inputClass}
          placeholder={field.placeholder}
          value={value === undefined ? '' : String(value)}
          onChange={(e) => onChange(e.target.value)}
        />
      )
  }
}

function TableInput({
  field, rows, onChange, rowVerdicts,
}: {
  field: InputFieldDef
  rows: MeasuredRow[]
  onChange: (value: MeasuredValue) => void
  rowVerdicts?: ResultState[]
  measured: Record<string, MeasuredValue>
}) {
  const columns = field.columns ?? []
  const atMax = field.maxRows !== undefined && rows.length >= field.maxRows

  const updateCell = (index: number, columnId: string, cellValue: MeasuredValue) => {
    const next = rows.map((row, i) =>
      i === index ? { ...row, [columnId]: cellValue as MeasuredRow[string] } : row,
    )
    onChange(next)
  }

  return (
    <div className="space-y-3">
      {rows.map((row, index) => (
        <div key={index} className="space-y-2 rounded-lg border border-slate-700 bg-slate-800/60 p-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-300">Row {index + 1}</span>
            <div className="flex items-center gap-2">
              {rowVerdicts?.[index] && (
                <span className={`rounded px-2 py-0.5 text-xs font-semibold ${VERDICT_CHIP[rowVerdicts[index]]}`}>
                  {rowVerdicts[index]}
                </span>
              )}
              <button
                type="button"
                onClick={() => onChange(rows.filter((_, i) => i !== index))}
                className="text-xs text-red-300"
              >
                Remove
              </button>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            {columns.map((column) => (
              <label key={column.id} className="block space-y-1">
                <span className="text-[11px] text-slate-400">
                  {column.label}
                  {column.unit ? ` (${column.unit})` : ''}
                </span>
                <CellControl
                  column={column}
                  value={row[column.id]}
                  onChange={(next) => updateCell(index, column.id, next)}
                />
              </label>
            ))}
          </div>
        </div>
      ))}

      <button
        type="button"
        disabled={atMax}
        onClick={() => onChange([...rows, {}])}
        className="w-full rounded-lg border border-dashed border-slate-600 p-3 text-sm text-sky-300 disabled:opacity-40"
      >
        + Add {rows.length === 0 ? 'a reading' : 'another reading'}
      </button>
    </div>
  )
}

function CellControl({
  column, value, onChange,
}: {
  column: InputFieldDef
  value: MeasuredValue | undefined
  onChange: (value: MeasuredValue) => void
}) {
  const cellClass = 'w-full rounded border border-slate-600 bg-slate-800 p-2 text-sm text-white'

  if (column.type === 'computed') {
    return (
      <div className="rounded border border-slate-700 bg-slate-900/60 p-2 text-sm text-white">
        {value === undefined || value === '' ? '—' : String(value)}
      </div>
    )
  }

  if (column.type === 'boolean') {
    return (
      <button
        type="button"
        onClick={() => onChange(!value)}
        className={`w-full rounded border p-2 text-sm text-white ${
          value ? 'border-amber-500 bg-amber-700/40' : 'border-slate-700 bg-slate-800/60'
        }`}
      >
        {value ? 'Yes' : 'No'}
      </button>
    )
  }

  if (column.type === 'select') {
    return (
      <div className="flex gap-1">
        {(column.options ?? []).map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            className={`flex-1 rounded border p-2 text-sm text-white ${
              value === option.value
                ? 'border-sky-500 bg-sky-800/50'
                : 'border-slate-700 bg-slate-800/60'
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
    )
  }

  return (
    <input
      type={column.type === 'number' ? 'number' : 'text'}
      inputMode={column.type === 'number' ? 'decimal' : undefined}
      className={cellClass}
      min={column.min}
      max={column.max}
      step={column.step}
      value={value === undefined ? '' : String(value)}
      onChange={(e) =>
        onChange(column.type === 'number' && e.target.value !== '' ? Number(e.target.value) : e.target.value)
      }
    />
  )
}
