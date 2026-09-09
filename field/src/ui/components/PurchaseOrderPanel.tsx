/**
 * Purchase orders from the phone (Kyle, 2026-09-09: "Purchasing needs to start
 * with a P.O. number then the purchase and photo verification of the receipt").
 *
 * Shared by the job-site screen (a PO opened on a job) and the Purchases
 * screen (a PO with no job). Purpose is chosen — "Truck Stock, Warehouse, or
 * Tool purchase ... The default will be truck stock." After creation the
 * number is shown big: it gets read at the counter. Each PO offers "Take
 * receipt photo for this PO" (the verification) and "Purchased".
 *
 * Online only on purpose: a PO number comes from the office's counter, and a
 * number the phone made up offline could collide. The failure text says so.
 */

import { useRef, useState } from 'react'
import {
  createPurchaseOrderFromField,
  createStandalonePurchaseOrder,
  setPurchaseOrderStatus,
  uploadReceiptFromField,
  type FieldPoPurpose,
  type FieldPurchaseOrder,
} from '../../lib/crmSync'
import { LandPoForm } from './LandPoForm'

export const PO_PURPOSE_LABEL: Record<FieldPoPurpose, string> = {
  truck_stock: 'Truck stock',
  warehouse: 'Warehouse',
  tool: 'Tool',
}

const STATUS_CLASS: Record<string, string> = {
  open: 'bg-sky-800 text-sky-100',
  purchased: 'bg-amber-700 text-amber-50',
  verified: 'bg-emerald-800 text-emerald-100',
  closed: 'bg-slate-700 text-slate-200',
  cancelled: 'bg-red-900 text-red-100',
}

const noSignal = (err: unknown) =>
  `${err instanceof Error ? err.message : 'no signal?'} — POs need signal; try again with bars.`

/**
 * Camera AND gallery (Kyle, 2026-08-25: "needs access to the phones photo
 * gallery for upload along with the take photo option"). Two inputs on
 * purpose: `capture` forces the camera and locks the gallery out, so each
 * door gets its own input instead of one ambiguous chooser.
 */
export function PhotoPicker({
  onPick,
  disabled,
  cameraLabel = '📷 Take photo',
}: {
  onPick: (file: File) => void
  disabled?: boolean
  cameraLabel?: string
}) {
  const cameraRef = useRef<HTMLInputElement>(null)
  const galleryRef = useRef<HTMLInputElement>(null)
  const handle = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) onPick(file)
    e.target.value = ''
  }
  return (
    <div className="flex gap-2">
      <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={handle} />
      <input ref={galleryRef} type="file" accept="image/*" className="hidden" onChange={handle} />
      <button
        type="button"
        disabled={disabled}
        onClick={() => cameraRef.current?.click()}
        className="flex-1 rounded-lg border border-slate-600 p-2 text-xs text-slate-200 disabled:opacity-40"
      >
        {cameraLabel}
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={() => galleryRef.current?.click()}
        className="flex-1 rounded-lg border border-slate-600 p-2 text-xs text-slate-200 disabled:opacity-40"
      >
        🖼 From gallery
      </button>
    </div>
  )
}

export interface CreatedPo {
  id: string
  number: string
  purpose: FieldPoPurpose
  status: string
  supplier: string
}

/** The number, big. It gets read out loud at the counter. */
export function PoNumberBanner({ po }: { po: CreatedPo }) {
  return (
    <div className="rounded-xl border border-emerald-700 bg-emerald-950/50 p-4 text-center">
      <p className="text-3xl font-bold tabular-nums tracking-wide text-emerald-100">{po.number}</p>
      <p className="mt-1 text-xs text-emerald-300">Read this at the counter</p>
      <p className="text-[11px] text-slate-400">{po.supplier} · {PO_PURPOSE_LABEL[po.purpose]}</p>
    </div>
  )
}

export function StartPurchaseForm({ visitId, onCreated }: { visitId?: string; onCreated: (po: CreatedPo) => void }) {
  const [purpose, setPurpose] = useState<FieldPoPurpose>('truck_stock')
  const [supplier, setSupplier] = useState('')
  const [lines, setLines] = useState<{ name: string; qty: string }[]>([{ name: '', qty: '1' }])
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)

  const submit = async () => {
    const items = lines
      .map((l) => ({ name: l.name.trim(), qty: Number(l.qty) }))
      .filter((l) => l.name && Number.isFinite(l.qty) && l.qty > 0)
    if (!supplier.trim()) {
      setStatus('Supplier is needed.')
      return
    }
    setBusy(true)
    setStatus(null)
    try {
      const input = { supplier: supplier.trim(), purpose, items }
      const po = visitId ? await createPurchaseOrderFromField(visitId, input) : await createStandalonePurchaseOrder(input)
      onCreated({ ...po, supplier: po.supplier ?? supplier.trim() })
      setSupplier('')
      setLines([{ name: '', qty: '1' }])
      setPurpose('truck_stock')
    } catch (err) {
      setStatus(`Failed — ${noSignal(err)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-1">
        {(['truck_stock', 'warehouse', 'tool'] as FieldPoPurpose[]).map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => setPurpose(p)}
            className={`flex-1 rounded-lg border p-2 text-xs font-medium ${
              purpose === p ? 'border-sky-500 bg-sky-900/60 text-white' : 'border-slate-600 text-slate-300'
            }`}
          >
            {PO_PURPOSE_LABEL[p]}
          </button>
        ))}
      </div>
      <p className="text-[10px] text-slate-500">
        {purpose === 'warehouse'
          ? 'Lands in the warehouse — only for moving material to truck stock later.'
          : purpose === 'tool'
            ? 'A tool purchase — tracked separately from material.'
            : 'Lands on the truck. Jobs are charged from truck stock, not from the PO.'}
      </p>
      <input
        className="w-full rounded border border-slate-600 bg-slate-900 p-2 text-sm text-white placeholder:text-slate-500"
        placeholder="Supplier (e.g. Nashville Electric Supply)"
        value={supplier}
        onChange={(e) => setSupplier(e.target.value)}
      />
      {lines.map((line, i) => (
        <div key={i} className="flex gap-2">
          <input
            className="w-16 rounded border border-slate-600 bg-slate-900 p-2 text-sm text-white"
            type="number"
            min="1"
            value={line.qty}
            onChange={(e) => setLines((ls) => ls.map((l, idx) => (idx === i ? { ...l, qty: e.target.value } : l)))}
          />
          <input
            className="flex-1 rounded border border-slate-600 bg-slate-900 p-2 text-sm text-white placeholder:text-slate-500"
            placeholder="Part / material (optional)"
            value={line.name}
            onChange={(e) => setLines((ls) => ls.map((l, idx) => (idx === i ? { ...l, name: e.target.value } : l)))}
          />
        </div>
      ))}
      <div className="flex gap-2">
        <button
          type="button"
          className="flex-1 rounded-lg border border-slate-600 p-2 text-xs text-slate-200"
          onClick={() => setLines((ls) => [...ls, { name: '', qty: '1' }])}
        >
          ＋ line
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void submit()}
          className="flex-1 rounded-lg bg-sky-700 p-2 text-xs font-medium text-white disabled:opacity-40"
        >
          {busy ? 'Getting a number…' : 'Start PO'}
        </button>
      </div>
      {status && <p className="text-xs text-slate-300">{status}</p>}
    </div>
  )
}

function PoRow({ po, onChanged }: { po: FieldPurchaseOrder; onChanged: () => void }) {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [showPhoto, setShowPhoto] = useState(false)
  const [showLand, setShowLand] = useState(false)

  const move = async (to: 'purchased' | 'verified') => {
    setBusy(true)
    setMsg(null)
    try {
      await setPurchaseOrderStatus(po.id, to)
      setMsg(`✓ ${po.number} marked ${to}.`)
      onChanged()
    } catch (err) {
      setMsg(`Failed — ${noSignal(err)}`)
    } finally {
      setBusy(false)
    }
  }

  const receiptPhoto = async (file: File) => {
    setBusy(true)
    setMsg(null)
    try {
      const result = await uploadReceiptFromField({
        visitId: po.jobId ?? undefined,
        purchaseOrderId: po.id,
        blob: file,
        category: 'materials',
      })
      setMsg(
        result.status === 'pending_review'
          ? `✓ Receipt filed on ${po.number} ($${result.amount.toFixed(2)}) — the office reviews it.`
          : `✓ Receipt filed on ${po.number} ($${result.amount.toFixed(2)}).`,
      )
      setShowPhoto(false)
      onChanged()
    } catch (err) {
      setMsg(`Upload failed — ${noSignal(err)}`)
    } finally {
      setBusy(false)
    }
  }

  const live = po.status === 'open' || po.status === 'purchased'
  return (
    <li className="space-y-2 rounded-lg border border-slate-700 bg-slate-900/60 p-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-base font-bold tabular-nums text-white">{po.number}</p>
          <p className="text-xs text-slate-300">
            {po.supplier} · {PO_PURPOSE_LABEL[po.purpose] ?? po.purpose}
            {po.truckName ? ` · ${po.truckName}` : ''}
          </p>
          {po.jobLabel && <p className="text-[11px] text-slate-500">on {po.jobLabel}</p>}
          {po.items.length > 0 && (
            <p className="text-[11px] text-slate-400">{po.items.map((i) => `${i.qty}× ${i.name}`).join(' · ')}</p>
          )}
        </div>
        <div className="text-right">
          <span className={`inline-block rounded px-2 py-0.5 text-[10px] font-semibold uppercase ${STATUS_CLASS[po.status] ?? 'bg-slate-700 text-slate-200'}`}>
            {po.status}
          </span>
          <p className="mt-1 text-[10px] text-slate-500">{po.receiptCount} receipt{po.receiptCount === 1 ? '' : 's'}</p>
        </div>
      </div>
      {live && (
        <div className="flex gap-2">
          {po.status === 'open' && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void move('purchased')}
              className="flex-1 rounded-lg bg-amber-700 p-2 text-xs font-medium text-white disabled:opacity-40"
            >
              Purchased
            </button>
          )}
          {po.status === 'purchased' && po.receiptCount > 0 && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void move('verified')}
              className="flex-1 rounded-lg bg-emerald-800 p-2 text-xs font-medium text-white disabled:opacity-40"
            >
              Verified
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => setShowPhoto((s) => !s)}
            className="flex-1 rounded-lg border border-sky-700 p-2 text-xs text-sky-200 disabled:opacity-40"
          >
            {showPhoto ? 'hide' : '📷 Receipt photo for this PO'}
          </button>
        </div>
      )}
      {live && showPhoto && (
        <PhotoPicker onPick={(f) => void receiptPhoto(f)} disabled={busy} cameraLabel="📷 Take receipt photo" />
      )}
      {/* Kyle, 2026-09-09 (Build 3): bought and back at the truck — land it. Material goes on the truck / in the warehouse; the PO closes. */}
      {po.status === 'purchased' && (
        <button
          type="button"
          disabled={busy}
          onClick={() => setShowLand((s) => !s)}
          className="w-full rounded-lg border border-emerald-700 p-2 text-xs text-emerald-200 disabled:opacity-40"
        >
          {showLand ? 'hide landing' : '📦 Land — material is on the truck'}
        </button>
      )}
      {po.status === 'purchased' && showLand && (
        <LandPoForm poId={po.id} onLanded={(r) => { setMsg(`✓ ${r.number} landed.`); setShowLand(false); onChanged() }} />
      )}
      {busy && <p className="text-xs text-slate-400">Working…</p>}
      {msg && <p className="text-xs text-slate-300">{msg}</p>}
    </li>
  )
}

export function PurchaseOrderList({ orders, onChanged }: { orders: FieldPurchaseOrder[]; onChanged: () => void }) {
  if (orders.length === 0) return <p className="text-xs text-slate-500">No purchase orders yet.</p>
  return (
    <ul className="space-y-2">
      {orders.map((po) => (
        <PoRow key={po.id} po={po} onChanged={onChanged} />
      ))}
    </ul>
  )
}
