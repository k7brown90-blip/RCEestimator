/**
 * Landing a PO from the phone (Kyle, 2026-09-09, Build 3).
 *
 * A purchased PO's material lands on the truck or in the warehouse; a tool PO
 * lands on the tool register. Each line: expected qty, qty landed (default
 * expected), unit cost (default from the office) — all editable. Landing
 * closes the PO.
 *
 * Kyle, 2026-09-10: "The pricing on the P.O.'s does not seem to be applied
 * correctly from the receipts … they are not the same price." Each line's
 * default is the price printed beside it on the receipt; the label under the
 * cost says which lines are guesses. The receipt's own lines show under the
 * PO lines; one not on the PO can be added as a line so it lands at the
 * receipt's price.
 *
 * Online only, and NOT queued: the ledger is the office's and a landing that
 * replayed later could double-count. The failure text says so.
 */

import { useEffect, useState } from 'react'
import { addPurchaseOrderLineFromField, fetchLandingDefaults, landPurchaseOrderFromField, requireSignal, type FieldLanding, type FieldLandingReceiptLine } from '../../lib/crmSync'

const SOURCE_LABEL: Record<FieldLanding['lines'][number]['costSource'], string> = {
  'receipt-line': 'from receipt line',
  'po-line': 'typed on PO',
  'receipt-prorated': 'prorated',
  book: 'book price',
  none: 'no default',
}
const GUESS_SOURCES = new Set<FieldLanding['lines'][number]['costSource']>(['receipt-prorated', 'book', 'none'])

type Row = { lineId: string; qty: string; cost: string }

export function LandPoForm({ poId, onLanded }: { poId: string; onLanded: (result: { number: string; destination: string }) => void }) {
  const [data, setData] = useState<FieldLanding | null>(null)
  const [rows, setRows] = useState<Row[]>([])
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    fetchLandingDefaults(poId)
      .then((d) => {
        if (cancelled) return
        setData(d)
        // A reload (after adding a line from the receipt) keeps what was already typed on the lines we had.
        setRows((prev) => d.lines.map((l) => prev.find((r) => r.lineId === l.lineId) ?? { lineId: l.lineId, qty: String(l.qtyLandedDefault), cost: String(l.unitCostDefault) }))
      })
      .catch((err) => { if (!cancelled) setMsg(`Needs signal — ${err instanceof Error ? err.message : String(err)}`) })
    return () => { cancelled = true }
  }, [poId, reloadKey])

  const addFromReceipt = async (rl: FieldLandingReceiptLine) => {
    setBusy(true)
    setMsg(null)
    try {
      requireSignal()
      await addPurchaseOrderLineFromField(poId, { name: rl.name, qty: rl.qty, unit: rl.unit, unitCost: rl.unitCost })
      setReloadKey((k) => k + 1)
    } catch (err) {
      setMsg(`Not added — ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

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
                unit cost · <span className={GUESS_SOURCES.has(l.costSource) ? 'text-amber-300' : ''}>{SOURCE_LABEL[l.costSource]}</span>
                {l.costSource !== 'receipt-line' && l.matchedReceiptLine ? ' · receipt line has no price' : ''}
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
      {data.receiptLines.length > 0 && (
        <div className="space-y-1 rounded border border-slate-800 p-2">
          <p className="text-[10px] uppercase tracking-wide text-slate-500">Receipt lines</p>
          {data.receiptLines.map((r) => (
            <div key={r.receiptId} className="space-y-0.5">
              <p className="text-[11px] text-slate-400">{r.vendor ?? 'receipt'} · ${r.amount.toFixed(2)}{r.parseError ? ` · ${r.parseError}` : r.lines.length === 0 ? ' · no parsed lines' : ''}</p>
              {r.lines.map((rl) => (
                <div key={`${r.receiptId}-${rl.index}`} className="flex flex-wrap items-center gap-x-2 pl-2 text-[11px] tabular-nums">
                  <span className="text-slate-200">{rl.name}</span>
                  <span className="text-slate-500">× {rl.qty} {rl.unit ?? ''}</span>
                  <span className="text-slate-500">{rl.unitCost != null ? `@ $${rl.unitCost.toFixed(2)}` : 'no price'}</span>
                  {rl.matchedLineId ? (
                    <span className="text-slate-500">→ {data.lines.find((l) => l.lineId === rl.matchedLineId)?.name ?? 'PO line'}</span>
                  ) : (
                    <>
                      <span className="text-amber-300">not on this PO — add as a line?</span>
                      <button type="button" disabled={busy} onClick={() => void addFromReceipt(rl)} className="rounded bg-slate-700 px-2 py-0.5 text-[11px] text-white disabled:opacity-40">Add</button>
                    </>
                  )}
                </div>
              ))}
            </div>
          ))}
          {data.remainder > 0 && data.lines.some((l) => l.costSource === 'receipt-prorated') && (
            <p className="text-[11px] text-slate-400">${data.remainder.toFixed(2)} of the receipt is not on a priced line — spread over the prorated lines.</p>
          )}
        </div>
      )}
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
