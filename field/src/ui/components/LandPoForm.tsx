/**
 * Landing a PO from the phone (Kyle, 2026-09-09, Build 3).
 *
 * A purchased PO's material lands on the truck or in the warehouse; a tool PO
 * lands on the tool register. Each line: expected qty, qty landed (default
 * expected), unit cost (default from the office — receipt prorated, keyed, or
 * the book) — all editable. Landing closes the PO.
 *
 * Online only, and NOT queued: the ledger is the office's and a landing that
 * replayed later could double-count. The failure text says so.
 */

import { useEffect, useState } from 'react'
import { fetchLandingDefaults, landPurchaseOrderFromField, requireSignal, type FieldLanding } from '../../lib/crmSync'

const SOURCE_LABEL: Record<FieldLanding['lines'][number]['costSource'], string> = {
  receipt: 'from receipt',
  line: 'as keyed',
  book: 'book price',
  none: 'no default',
}

type Row = { lineId: string; qty: string; cost: string }

export function LandPoForm({ poId, onLanded }: { poId: string; onLanded: (result: { number: string; destination: string }) => void }) {
  const [data, setData] = useState<FieldLanding | null>(null)
  const [rows, setRows] = useState<Row[]>([])
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetchLandingDefaults(poId)
      .then((d) => {
        if (cancelled) return
        setData(d)
        setRows(d.lines.map((l) => ({ lineId: l.lineId, qty: String(l.qtyLandedDefault), cost: String(l.unitCostDefault) })))
      })
      .catch((err) => { if (!cancelled) setMsg(`Needs signal — ${err instanceof Error ? err.message : String(err)}`) })
    return () => { cancelled = true }
  }, [poId])

  const valid = rows.length > 0 && rows.every((r) => Number.isFinite(Number(r.qty)) && Number(r.qty) >= 0 && Number.isFinite(Number(r.cost)) && Number(r.cost) >= 0)
  const total = rows.reduce((s, r) => s + (Number(r.qty) || 0) * (Number(r.cost) || 0), 0)

  const land = async () => {
    setBusy(true)
    setMsg(null)
    try {
      requireSignal()
      const result = await landPurchaseOrderFromField(poId, rows.map((r) => ({ lineId: r.lineId, qtyLanded: Number(r.qty), unitCost: Number(r.cost) })))
      onLanded(result)
    } catch (err) {
      setMsg(`Not landed — ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  if (!data) return <p className="text-xs text-slate-400">{msg ?? 'Loading…'}</p>
  const isTool = data.purchaseOrder.purpose === 'tool'
  return (
    <div className="space-y-2 rounded-lg border border-slate-700 bg-slate-950/40 p-2">
      <p className="text-[11px] text-slate-400">
        Lands {isTool ? 'on the tool register at' : 'in'} <span className="text-slate-200">{data.destinationLabel}</span>
        {data.receiptCount > 0 ? ` · receipt $${data.receiptTotal.toFixed(2)}` : ' · no receipt attached'}
      </p>
      {data.blocker && <p className="rounded bg-amber-950/60 p-2 text-xs text-amber-200">{data.blocker}</p>}
      {data.lines.length === 0 && <p className="text-xs text-slate-400">No lines on this PO — the office adds them, then it can land.</p>}
      {data.lines.map((l, i) => {
        const row = rows[i]
        if (!row) return null
        return (
          <div key={l.lineId} className="space-y-1">
            <p className="text-xs text-slate-200">{l.name} <span className="text-slate-500">· expected {l.qtyExpected} {l.unit ?? ''}</span></p>
            <div className="flex gap-2">
              <label className="flex-1 text-[10px] text-slate-500">
                landed
                <input
                  className="mt-0.5 w-full rounded border border-slate-600 bg-slate-900 p-2 text-sm text-white"
                  inputMode="decimal"
                  value={row.qty}
                  onChange={(e) => setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, qty: e.target.value } : r)))}
                />
              </label>
              <label className="flex-1 text-[10px] text-slate-500">
                unit cost · {SOURCE_LABEL[l.costSource]}
                <input
                  className="mt-0.5 w-full rounded border border-slate-600 bg-slate-900 p-2 text-sm text-white"
                  inputMode="decimal"
                  value={row.cost}
                  onChange={(e) => setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, cost: e.target.value } : r)))}
                />
              </label>
            </div>
          </div>
        )
      })}
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs tabular-nums text-slate-300">Total ${total.toFixed(2)}</span>
        <button
          type="button"
          disabled={busy || !valid || Boolean(data.blocker)}
          onClick={() => void land()}
          className="rounded-lg bg-emerald-800 px-4 py-2 text-xs font-medium text-white disabled:opacity-40"
        >
          {busy ? 'Landing…' : 'Land'}
        </button>
      </div>
      {msg && <p className="text-xs text-slate-300">{msg}</p>}
    </div>
  )
}
