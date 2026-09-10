/**
 * Materials used at close-out (Kyle, 2026-09-09, Build 4 — the costing switch).
 *
 * "Anything in a truck can be assigned to a job." The tech confirms what came
 * off the truck: pre-filled from the signed estimate's taken lines with the
 * truck's on-hand beside each, quantities editable, a line added from the book
 * when something extra was pulled. Confirm charges the job at the truck's
 * moving average — the only way a job is charged for material now.
 *
 * Online only, NOT queued: a consume that replayed later could double-charge.
 * The truck being short comes back as the office's 409, naming the item and
 * the on-hand; there is no negative override from the phone.
 */

import { useEffect, useState } from 'react'
import {
  consumeFromField,
  fetchJobMaterials,
  requireSignal,
  searchStockItems,
  type FieldJobMaterials,
  type FieldStockItem,
} from '../../lib/crmSync'

type Row = { itemId: string; name: string; unit: string | null; qty: string; onHand: number | null; avgUnitCost: number | null; fromEstimate: boolean }

const SOURCE_LABEL: Record<FieldJobMaterials['materialSource'], string> = {
  stock: 'from truck stock',
  receipts: 'from receipts',
  estimate: 'from the signed estimate',
  none: 'nothing recorded',
}

export function MaterialsUsedStep({ visitId, onRecorded }: { visitId: string; onRecorded?: () => void }) {
  const [data, setData] = useState<FieldJobMaterials | null>(null)
  const [rows, setRows] = useState<Row[]>([])
  const [reason, setReason] = useState('')
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<FieldStockItem[]>([])
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  // Rows seed from the suggested lines: the estimate's quantity less what this
  // job already consumed, so a second pass never doubles up.
  const seed = (d: FieldJobMaterials): Row[] => d.suggested.map((s) => ({
    itemId: s.itemId, name: s.name, unit: s.unit,
    qty: String(Math.max(0, Math.round((s.qty - s.consumedQty) * 10000) / 10000)),
    onHand: s.onHand, avgUnitCost: s.avgUnitCost, fromEstimate: true,
  }))
  const load = (isCancelled: () => boolean = () => false) => {
    fetchJobMaterials(visitId)
      .then((d) => {
        if (isCancelled()) return
        setData(d)
        setLoadError(null)
        setRows(seed(d))
      })
      .catch((err) => { if (!isCancelled()) setLoadError(`Needs signal — ${err instanceof Error ? err.message : String(err)}`) })
  }
  useEffect(() => {
    let cancelled = false
    load(() => cancelled)
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visitId])

  useEffect(() => {
    if (q.trim().length < 2) { setHits([]); return }
    let cancelled = false
    searchStockItems(q.trim())
      .then((r) => { if (!cancelled) setHits(r.filter((h) => !rows.some((row) => row.itemId === h.itemId)).slice(0, 8)) })
      .catch(() => { if (!cancelled) setHits([]) })
    return () => { cancelled = true }
  }, [q, rows])

  const active = rows.filter((r) => Number(r.qty) > 0)
  const projected = active.reduce((s, r) => s + Number(r.qty) * (r.avgUnitCost ?? 0), 0)
  const valid = active.length > 0 && rows.every((r) => r.qty === '' || (Number.isFinite(Number(r.qty)) && Number(r.qty) >= 0))

  const confirm = async () => {
    setBusy(true)
    setMsg(null)
    try {
      requireSignal()
      const movements = await consumeFromField(
        visitId,
        active.map((r) => ({ itemId: r.itemId, name: r.name, qty: Number(r.qty), unit: r.unit })),
        reason.trim() || null,
      )
      const total = movements.reduce((s, m) => s + m.qty * (m.unitCost ?? 0), 0)
      setMsg(`✓ ${movements.length} line(s) recorded — $${total.toFixed(2)} charged to this job from ${data?.truck.name ?? 'the truck'}.`)
      setReason('')
      load()
      onRecorded?.()
    } catch (err) {
      setMsg(`Not recorded — ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  if (loadError) return <p className="rounded bg-red-950/60 p-2 text-xs text-red-200">{loadError}</p>
  if (!data) return <p className="text-xs text-slate-400">Loading materials…</p>

  return (
    <div className="space-y-2 rounded-lg border border-slate-700 bg-slate-950/40 p-2">
      <p className="text-[11px] text-slate-400">
        Off <span className="text-slate-200">{data.truck.name}</span> at its average cost.
        {data.estimate ? ` Pre-filled from ${data.estimate.number} — fix the quantities to what actually came off the truck.` : ' No signed estimate — add what came off the truck.'}
      </p>
      {data.stock && (
        <p className="text-[11px] text-emerald-300">
          Already on this job: ${data.stock.net.toFixed(2)} {SOURCE_LABEL[data.materialSource]} ({data.stock.movementCount} line(s)).
        </p>
      )}
      {rows.map((r, i) => {
        const qty = Number(r.qty) || 0
        const short = r.onHand !== null && qty > r.onHand
        return (
          <div key={r.itemId} className="space-y-1">
            <p className="text-xs text-slate-200">
              {r.name}{!r.fromEstimate && <span className="text-slate-500"> · added</span>}
              <span className={short ? 'ml-1 text-amber-300' : 'ml-1 text-slate-500'}>
                · on truck {r.onHand === null ? '…' : `${r.onHand} ${r.unit ?? ''}`}{short ? ` — short ${Math.round((qty - (r.onHand ?? 0)) * 10000) / 10000}` : ''}
              </span>
            </p>
            <div className="flex items-center gap-2">
              <input
                className="w-24 rounded border border-slate-600 bg-slate-900 p-2 text-sm text-white"
                inputMode="decimal"
                value={r.qty}
                onChange={(e) => setRows((rs) => rs.map((x, idx) => (idx === i ? { ...x, qty: e.target.value } : x)))}
              />
              <span className="text-xs text-slate-400">{r.unit ?? ''}</span>
              <span className="ml-auto text-xs tabular-nums text-slate-300">{r.avgUnitCost === null ? '' : `$${(qty * r.avgUnitCost).toFixed(2)}`}</span>
            </div>
          </div>
        )
      })}
      <input
        className="w-full rounded border border-slate-600 bg-slate-900 p-2 text-sm text-white placeholder:text-slate-500"
        placeholder="Pulled something else? Search the book…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {hits.length > 0 && (
        <ul className="max-h-40 overflow-auto rounded border border-slate-700 bg-slate-900">
          {hits.map((h) => (
            <li key={h.itemId}>
              <button
                type="button"
                className="w-full p-2 text-left text-xs text-slate-200 hover:bg-slate-800"
                onClick={() => {
                  setRows((rs) => [...rs, { itemId: h.itemId, name: h.description ?? h.itemId, unit: h.unit, qty: '1', onHand: null, avgUnitCost: null, fromEstimate: false }])
                  setHits([]); setQ('')
                }}
              >
                <span className="font-medium">{h.itemId}</span> {h.description} <span className="text-slate-500">{h.unit ?? ''}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <input
        className="w-full rounded border border-slate-600 bg-slate-900 p-2 text-sm text-white placeholder:text-slate-500"
        placeholder="Note (optional)"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs tabular-nums text-slate-300">≈ ${projected.toFixed(2)}</span>
        <button
          type="button"
          disabled={busy || !valid}
          onClick={() => void confirm()}
          className="rounded-lg bg-emerald-800 px-4 py-2 text-xs font-medium text-white disabled:opacity-40"
        >
          {busy ? 'Recording…' : 'Confirm materials used'}
        </button>
      </div>
      {msg && <p className="text-xs text-slate-300">{msg}</p>}
    </div>
  )
}
