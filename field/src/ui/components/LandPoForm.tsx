/**
 * Landing a PO from the phone (Kyle, 2026-09-09, Build 3).
 *
 * A purchased PO's material lands on the truck or in the warehouse; a tool PO
 * lands on the tool register. Each line: expected qty, qty landed (default
 * expected), unit cost (default from the office) — all editable. Landing
 * closes the PO.
 *
 * Kyle, 2026-09-11: "The receipt total is the truth. It matches the card swipe
 * to the cent" — the receipt's line prices only weight the split, and the sales
 * tax rides in the unit costs. The balance line says where the landing stands;
 * Land is held until the lines equal the receipt, and landing anyway takes a
 * one-line reason. The receipt photo uploads from right here, and a PO with no
 * lines can take the receipt's own in one tap.
 *
 * Online only, and NOT queued: the ledger is the office's and a landing that
 * replayed later could double-count. The failure text says so.
 */

import { useEffect, useRef, useState } from 'react'
import { addPurchaseOrderLineFromField, fetchLandingDefaults, landPurchaseOrderFromField, requireSignal, uploadReceiptFromField, type FieldLanding, type FieldLandingReceiptLine } from '../../lib/crmSync'

const SOURCE_LABEL: Record<FieldLanding['lines'][number]['costSource'], string> = {
  'receipt-line': 'from receipt line',
  'po-line': 'typed on PO',
  book: 'book price',
  even: 'even split',
  none: 'no default',
}
const GUESS_SOURCES = new Set<FieldLanding['lines'][number]['costSource']>(['book', 'even', 'none'])

type Row = { lineId: string; qty: string; cost: string }

export function LandPoForm({ poId, onLanded }: { poId: string; onLanded: (result: { number: string; destination: string }) => void }) {
  const [data, setData] = useState<FieldLanding | null>(null)
  const [rows, setRows] = useState<Row[]>([])
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [overrideReason, setOverrideReason] = useState('')
  const fileRef = useRef<HTMLInputElement | null>(null)

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

  /** Every line the receipt printed becomes a PO line, in one tap (Kyle, 2026-09-11). */
  const addSuggested = async () => {
    setBusy(true)
    setMsg(null)
    try {
      requireSignal()
      for (const s of data?.suggestedLines ?? []) {
        await addPurchaseOrderLineFromField(poId, { name: s.name, qty: s.qty, unit: s.unit, unitCost: s.unitCost })
      }
      setReloadKey((k) => k + 1)
    } catch (err) {
      setMsg(`Not added — ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  /** The receipt photo, straight onto this PO — the same door the office uses. */
  const uploadReceipt = async (file: File) => {
    setBusy(true)
    setMsg(null)
    try {
      requireSignal()
      const res = await uploadReceiptFromField({ purchaseOrderId: poId, blob: file })
      setMsg(`Receipt added — $${res.amount.toFixed(2)}`)
      setReloadKey((k) => k + 1)
    } catch (err) {
      setMsg(`Not uploaded — ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  const valid = rows.length > 0 && rows.every((r) => Number.isFinite(Number(r.qty)) && Number(r.qty) >= 0 && Number.isFinite(Number(r.cost)) && Number(r.cost) >= 0)
  const total = rows.reduce((s, r) => s + (Number(r.qty) || 0) * (Number(r.cost) || 0), 0)
  // The receipt is the truth — Land is held until the lines add up to it (Kyle, 2026-09-11).
  const inBalance = !data || data.receiptTotal <= 0 || Math.abs(total - data.receiptTotal) <= 0.01

  const land = async () => {
    setBusy(true)
    setMsg(null)
    try {
      requireSignal()
      const result = await landPurchaseOrderFromField(
        poId,
        rows.map((r) => ({ lineId: r.lineId, qtyLanded: Number(r.qty), unitCost: Number(r.cost) })),
        inBalance || !overrideReason.trim() ? null : { reason: overrideReason.trim() },
      )
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

      {/* Kyle, 2026-09-11: "a way to attach a photo of the receipt if one is missing" — the camera, right here. */}
      <div className={data.receiptCount === 0 ? 'rounded border border-amber-700 bg-amber-950/40 p-2' : ''}>
        {data.receiptCount === 0 && <p className="mb-1 text-[11px] text-amber-200">No receipt on this PO — its total is what the lines land at.</p>}
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadReceipt(f); e.target.value = '' }}
        />
        <button
          type="button"
          disabled={busy}
          onClick={() => fileRef.current?.click()}
          className="rounded bg-slate-700 px-3 py-1.5 text-xs text-white disabled:opacity-40"
        >
          {data.receiptCount === 0 ? 'Photograph the receipt' : 'Add another receipt photo'}
        </button>
      </div>

      {data.lines.length === 0 && (
        <div className="space-y-1 rounded border border-slate-800 p-2">
          <p className="text-xs text-slate-400">No lines on this PO, so there is nothing to land.</p>
          {data.suggestedLines.length > 0 && (
            <button type="button" disabled={busy} onClick={() => void addSuggested()} className="rounded bg-emerald-800 px-3 py-1.5 text-xs text-white disabled:opacity-40">
              Add the receipt&apos;s lines ({data.suggestedLines.length})
            </button>
          )}
        </div>
      )}
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
                {/* Kyle, 2026-09-11: the tax rides in the price, so the line says so. */}
                {l.taxShare > 0 ? ` · incl. tax $${l.taxShare.toFixed(2)}` : ''}
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
          {data.taxTotal > 0 && (
            <p className="text-[11px] text-slate-400">${data.taxTotal.toFixed(2)} of the receipt is past its printed lines (sales tax) — spread across the lines, so each cost is what was paid.</p>
          )}
        </div>
      )}
      {/* Kyle, 2026-09-11: the balance is the headline — green when the lines equal the receipt, red when they do not. */}
      <div className="space-y-1">
        <p className={`text-xs tabular-nums ${data.receiptTotal <= 0 ? 'text-slate-400' : inBalance ? 'text-emerald-300' : 'text-red-300'}`}>
          Landing total ${total.toFixed(2)}
          {data.receiptTotal > 0 ? ` of receipt $${data.receiptTotal.toFixed(2)}` : ' · no receipt to check against'}
          {data.receiptTotal > 0 && !inBalance ? ` · off by $${Math.abs(total - data.receiptTotal).toFixed(2)}` : ''}
        </p>
        {!inBalance && (
          <input
            className="w-full rounded border border-slate-600 bg-slate-900 p-2 text-xs text-white"
            placeholder="Why land out of balance? (required)"
            value={overrideReason}
            onChange={(e) => setOverrideReason(e.target.value)}
          />
        )}
        <div className="flex items-center justify-end">
          <button
            type="button"
            disabled={busy || !valid || Boolean(data.blocker) || (!inBalance && !overrideReason.trim())}
            onClick={() => void land()}
            className="rounded-lg bg-emerald-800 px-4 py-2 text-xs font-medium text-white disabled:opacity-40"
          >
            {busy ? 'Landing…' : inBalance ? 'Land' : 'Land anyway'}
          </button>
        </div>
      </div>
      {msg && <p className="text-xs text-slate-300">{msg}</p>}
    </div>
  )
}
