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

import { useEffect, useRef, useState } from 'react'
import {
  createPurchaseOrderFromField,
  createStandalonePurchaseOrder,
  editPoReceipt,
  fetchJobMaterials,
  fetchPoReceipts,
  lineFromScannedCode,
  pendingReceiptCount,
  queueReceiptAndReport,
  removePoReceipt,
  resolveMaterialCode,
  setPurchaseOrderStatus,
  type FieldPoPurpose,
  type FieldPurchaseOrder,
  type FieldReceipt,
  type ScannedPoLine,
} from '../../lib/crmSync'
import type { BarcodeDetection } from '../../lib/barcodeScan'
import { BarcodeScanner } from './BarcodeScanner'
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
 *
 * The gallery/files door can also take a PDF (Kyle, 2026-09-19: "or upload of
 * a pdf (for online orders)") when the caller opts in via `galleryAccept` — a
 * camera can only ever produce a photo, so that input always stays
 * image-only. Left at its default ("image/*") this is unchanged for every
 * other caller (job-evidence photos on JobSiteScreen included); only the P.O.
 * receipt picker below widens it.
 */
export function PhotoPicker({
  onPick,
  disabled,
  cameraLabel = '📷 Take photo',
  galleryLabel = '🖼 From gallery',
  galleryAccept = 'image/*',
}: {
  onPick: (file: File) => void
  disabled?: boolean
  cameraLabel?: string
  galleryLabel?: string
  galleryAccept?: string
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
      <input ref={galleryRef} type="file" accept={galleryAccept} className="hidden" onChange={handle} />
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
        {galleryLabel}
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

/**
 * A line in progress. `unit`/`partNumber`/`itemId`/`unitCost` ride along once a scan or a
 * typed SKU resolves a material — carried straight through to the PO create call, never
 * re-typed. `unresolved` just flags a line for the status text; it never blocks submission.
 */
interface PoLineDraft {
  name: string
  qty: string
  unit?: string
  partNumber?: string
  itemId?: string
  unitCost?: number
  unresolved?: boolean
}

const blankLine = (): PoLineDraft => ({ name: '', qty: '1' })

function draftFromScanned(line: ScannedPoLine, unresolved: boolean): PoLineDraft {
  return { ...line, qty: String(line.qty), unresolved }
}

export function StartPurchaseForm({ visitId, onCreated }: { visitId?: string; onCreated: (po: CreatedPo) => void }) {
  const [purpose, setPurpose] = useState<FieldPoPurpose>('truck_stock')
  const [supplier, setSupplier] = useState('')
  const [lines, setLines] = useState<PoLineDraft[]>([blankLine()])
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)
  const [skuInput, setSkuInput] = useState('')
  const [resolving, setResolving] = useState(false)
  const [shortageTruck, setShortageTruck] = useState<string | null>(null)

  /**
   * "Create P.O." pre-fills the job's whole shortage list (Kyle, 2026-09-16/17, Unit P) — not a
   * per-item prompt, which risked one single-item PO per short line. Job-scoped only (no visitId
   * on the Purchases screen's standalone form); a fetch failure (offline) just leaves the blank
   * line, same as before — PO creation itself stays online-only regardless.
   */
  useEffect(() => {
    if (!visitId) return
    let cancelled = false
    fetchJobMaterials(visitId)
      .then((d) => {
        if (cancelled || d.shortages.length === 0) return
        setShortageTruck(d.truck.name)
        setLines(d.shortages.map((s) => ({ name: s.name, qty: String(s.shortBy), unit: s.unit ?? undefined, itemId: s.itemId })))
      })
      .catch(() => {
        // Offline or the request failed — the tech still has the blank line to type into.
      })
    return () => { cancelled = true }
  }, [visitId])

  /**
   * The one path both a camera scan and a typed SKU go through (Kyle, 2026-09-12: "typing a
   * SKU must resolve a material exactly the same way scanning a barcode does"). Cache-first,
   * offline-safe (resolveMaterialCode never throws) — a known code fills in the line with
   * zero further typing; an unknown one still adds a line, using the raw code, and is
   * flagged so Kyle can find it again at the desk. Nothing here ever blocks the purchase.
   */
  const addScannedLine = async (code: string, source: 'upc' | 'sku') => {
    setResolving(true)
    try {
      const resolved = await resolveMaterialCode(code, { source })
      const line = lineFromScannedCode(code, resolved)
      setLines((ls) => {
        const withoutBlank = ls.filter((l) => l.name.trim() || l.partNumber)
        return [...withoutBlank, draftFromScanned(line, !resolved.found)]
      })
      setStatus(
        resolved.found
          ? `✓ Added: ${line.name}`
          : `✓ Added "${code}" — new item, will need labor units assigned at the desk.`,
      )
    } finally {
      setResolving(false)
    }
  }

  const onBarcodeDetected = (detection: BarcodeDetection) => {
    setScanning(false)
    void addScannedLine(detection.code, 'upc')
  }

  const addTypedSku = () => {
    const code = skuInput.trim()
    if (!code) return
    setSkuInput('')
    void addScannedLine(code, 'sku')
  }

  const submit = async () => {
    const items = lines
      .map((l) => ({
        name: l.name.trim(), qty: Number(l.qty),
        ...(l.unit ? { unit: l.unit } : {}),
        ...(l.partNumber ? { partNumber: l.partNumber } : {}),
        ...(l.itemId ? { itemId: l.itemId } : {}),
        ...(l.unitCost != null ? { unitCost: l.unitCost } : {}),
      }))
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
      setLines([blankLine()])
      setPurpose('truck_stock')
      setShortageTruck(null)
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
          ? 'Lands in the warehouse.'
          : purpose === 'tool'
            ? 'A tool purchase — tracked separately from material, never charged to a job.'
            : 'Lands on the truck.'}
        {purpose !== 'tool' && (visitId
          ? ' Started from this job, so every line is charged to it the moment it lands; leftovers get counted back at close-out.'
          : ' No job: it stays as stock until a job uses it.')}
      </p>
      <input
        className="w-full rounded border border-slate-600 bg-slate-900 p-2 text-sm text-white placeholder:text-slate-500"
        placeholder="Supplier (e.g. Nashville Electric Supply)"
        value={supplier}
        onChange={(e) => setSupplier(e.target.value)}
      />

      {/* Scan / type a code — resolves against the same cached lookup either way, offline
          included, and never blocks: an unknown code still adds a line. */}
      {scanning ? (
        <BarcodeScanner onDetected={onBarcodeDetected} onCancel={() => setScanning(false)} />
      ) : (
        <div className="flex gap-2">
          <button
            type="button"
            disabled={resolving}
            onClick={() => setScanning(true)}
            className="flex-1 rounded-lg border border-sky-700 p-2 text-xs text-sky-200 disabled:opacity-40"
          >
            📷 Scan barcode
          </button>
          <input
            className="flex-1 rounded border border-slate-600 bg-slate-900 p-2 text-sm text-white placeholder:text-slate-500"
            placeholder="or type a SKU"
            value={skuInput}
            onChange={(e) => setSkuInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') addTypedSku() }}
          />
          <button
            type="button"
            disabled={resolving || !skuInput.trim()}
            onClick={addTypedSku}
            className="rounded-lg border border-slate-600 p-2 text-xs text-slate-200 disabled:opacity-40"
          >
            Add
          </button>
        </div>
      )}

      {shortageTruck && (
        <p className="text-[10px] text-slate-500">
          Pre-filled from what this job is short, checked against {shortageTruck}. Edit quantities or remove a line
          before starting the P.O. — more than one P.O. on a job is fine.
        </p>
      )}
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
          {line.unresolved && (
            <span className="self-center rounded bg-amber-950/60 px-2 py-1 text-[10px] text-amber-300">new</span>
          )}
          {lines.length > 1 && (
            <button
              type="button"
              onClick={() => setLines((ls) => ls.filter((_, idx) => idx !== i))}
              className="rounded border border-slate-700 px-2 text-xs text-slate-400"
            >
              ✕
            </button>
          )}
        </div>
      ))}
      <div className="flex gap-2">
        <button
          type="button"
          className="flex-1 rounded-lg border border-slate-600 p-2 text-xs text-slate-200"
          onClick={() => setLines((ls) => [...ls, blankLine()])}
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

/** THE MONEY on the card, no proof yet (Kyle, 2026-09-19) — the prompt. */
const poNeedsProof = (po: FieldPurchaseOrder) => po.moneyTotal > 0 && po.proofCount === 0
const money = (n: number) => `$${n.toFixed(2)}`

/**
 * A receipt is proof, never money (2026-09-19) — editing or removing one from
 * here moves no cost figure. Same office logic
 * (health-record.ts applyReceiptEdit / removeReceiptRecord), reached through
 * a tech-scoped twin door. Standing rule: nothing this app creates is
 * permanent without a way out from where it's shown — this is that exit for
 * a receipt filed from the field.
 */
function ReceiptsOnPo({ poId, onChanged }: { poId: string; onChanged: () => void }) {
  const [receipts, setReceipts] = useState<FieldReceipt[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [vendor, setVendor] = useState('')
  const [amount, setAmount] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = () => {
    fetchPoReceipts(poId)
      .then(setReceipts)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }
  useEffect(load, [poId])

  const startEdit = (r: FieldReceipt) => {
    setEditingId(r.id)
    setVendor(r.vendor ?? '')
    setAmount(String(r.amount))
  }

  const save = async (id: string) => {
    setBusyId(id)
    try {
      const n = Number(amount)
      await editPoReceipt(id, { vendor: vendor.trim() || null, ...(Number.isFinite(n) ? { amount: n } : {}) })
      setEditingId(null)
      load()
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyId(null)
    }
  }

  const remove = async (id: string) => {
    setBusyId(id)
    try {
      await removePoReceipt(id)
      load()
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyId(null)
    }
  }

  if (error) return <p className="rounded bg-red-950/60 p-2 text-xs text-red-200">{error}</p>
  if (!receipts) return <p className="text-xs text-slate-500">Loading receipts…</p>
  if (receipts.length === 0) return <p className="text-xs text-slate-500">No receipts on this PO.</p>

  return (
    <ul className="space-y-1 rounded-lg border border-slate-700 bg-slate-900/40 p-2">
      {receipts.map((r) => (
        <li key={r.id} className="text-xs text-slate-300">
          {editingId === r.id ? (
            <div className="flex flex-wrap items-center gap-2">
              <input
                className="w-28 rounded border border-slate-600 bg-slate-900 p-1 text-white"
                placeholder="Vendor"
                value={vendor}
                onChange={(e) => setVendor(e.target.value)}
              />
              <input
                className="w-20 rounded border border-slate-600 bg-slate-900 p-1 text-white"
                type="number"
                inputMode="decimal"
                min={0}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
              <button type="button" disabled={busyId === r.id} onClick={() => void save(r.id)} className="text-emerald-300 underline disabled:opacity-40">
                save
              </button>
              <button type="button" disabled={busyId === r.id} onClick={() => setEditingId(null)} className="text-slate-400 underline disabled:opacity-40">
                cancel
              </button>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-2">
              <span>{r.vendor ?? 'No vendor'} · {money(r.amount)}{r.hasImage ? '' : ' · no photo'}</span>
              <span className="flex shrink-0 gap-2">
                <button type="button" disabled={busyId === r.id} onClick={() => startEdit(r)} className="text-sky-300 underline disabled:opacity-40">
                  edit
                </button>
                <button type="button" disabled={busyId === r.id} onClick={() => void remove(r.id)} className="text-red-300 underline disabled:opacity-40">
                  remove
                </button>
              </span>
            </div>
          )}
        </li>
      ))}
    </ul>
  )
}

function PoRow({ po, onChanged }: { po: FieldPurchaseOrder; onChanged: () => void }) {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  // One tap, not two (Kyle, 2026-09-19: "prompts for a picture ... or upload of
  // a pdf"): a purchased PO with money and no proof opens the picker already
  // showing instead of waiting for the tech to find the toggle first.
  const [showPhoto, setShowPhoto] = useState(() => po.status === 'purchased' && poNeedsProof(po))
  const [showLand, setShowLand] = useState(false)
  const [showReceipts, setShowReceipts] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [cancelReason, setCancelReason] = useState('')

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

  /**
   * Cancel — a required, typed reason, the same rule as the CRM (a PO's
   * status never moves money; THE P.O. IS THE MONEY). Every PO gets an exit
   * from where it's shown, whichever office or field opened it.
   */
  const cancel = async () => {
    const reason = cancelReason.trim()
    if (!reason) {
      setMsg('A reason is required to cancel a PO.')
      return
    }
    setBusy(true)
    setMsg(null)
    try {
      await setPurchaseOrderStatus(po.id, 'cancelled', reason)
      setMsg(`✓ ${po.number} cancelled — ${reason}`)
      setCancelling(false)
      setCancelReason('')
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
      // Queued durably before any network call — never a bare failure that
      // drops the photo (2026-09-12: four receipts lost on 2026-09-11 because
      // a failed fetch discarded the File with nothing written anywhere).
      const { status } = await queueReceiptAndReport({
        visitId: po.jobId ?? undefined,
        purchaseOrderId: po.id,
        blob: file,
        category: 'materials',
      })
      setMsg(
        status === 'filed'
          ? `✓ Receipt filed on ${po.number}.`
          : `✓ Receipt queued on ${po.number} — will file the moment there is signal.`,
      )
      setShowPhoto(false)
      onChanged()
    } catch (err) {
      // Only a local IndexedDB failure reaches here — the network leg is
      // retried in the background and never throws out to the caller.
      setMsg(`Could not queue the photo — ${err instanceof Error ? err.message : String(err)}`)
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
      {/*
        The prompt (Kyle, 2026-09-19): "PO-XXXX, $651.73 at Home Depot — attach
        the receipt." Only once the P.O. actually has money on it — an open PO
        with nothing bought yet has nothing to prove.
      */}
      {poNeedsProof(po) && (
        <p className="rounded-lg bg-amber-950/50 p-2 text-xs text-amber-200">
          {money(po.moneyTotal)} at {po.supplier} — attach the receipt photo or PDF.
        </p>
      )}
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
          {/* Proof, not just any receipt row (Kyle, 2026-09-19) — a receipt with
              no file attached does not verify the P.O. */}
          {po.status === 'purchased' && po.proofCount > 0 && (
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
        <PhotoPicker
          onPick={(f) => void receiptPhoto(f)}
          disabled={busy}
          cameraLabel="📷 Take receipt photo"
          galleryLabel="🖼 Gallery / PDF"
          galleryAccept="image/*,application/pdf"
        />
      )}
      {/*
        Cancel — every PO gets a way out from where it's shown (standing rule:
        nothing this app creates is permanent). A reason is required, same as
        the office; PO status never moves money, so cancelling changes no cost
        figure.
      */}
      {live && !cancelling && (
        <button
          type="button"
          disabled={busy}
          onClick={() => setCancelling(true)}
          className="w-full rounded-lg border border-red-800 p-2 text-xs text-red-300 disabled:opacity-40"
        >
          Cancel this PO
        </button>
      )}
      {live && cancelling && (
        <div className="space-y-2 rounded-lg border border-red-900 bg-red-950/30 p-2">
          <input
            className="w-full rounded border border-slate-600 bg-slate-900 p-2 text-xs text-white placeholder:text-slate-500"
            placeholder="Reason (required) — e.g. opened by mistake, store was out"
            value={cancelReason}
            onChange={(e) => setCancelReason(e.target.value)}
          />
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy || !cancelReason.trim()}
              onClick={() => void cancel()}
              className="flex-1 rounded-lg bg-red-800 p-2 text-xs font-medium text-white disabled:opacity-40"
            >
              Confirm cancel
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => { setCancelling(false); setCancelReason('') }}
              className="flex-1 rounded-lg border border-slate-600 p-2 text-xs text-slate-300 disabled:opacity-40"
            >
              Never mind
            </button>
          </div>
        </div>
      )}
      {/* Receipts on this PO — edit or remove any of them (standing rule: nothing
          this app creates is permanent). Available regardless of status: a
          receipt is proof, never money, so it stays correctable after the PO closes. */}
      {po.receiptCount > 0 && (
        <button
          type="button"
          disabled={busy}
          onClick={() => setShowReceipts((s) => !s)}
          className="w-full rounded-lg border border-slate-600 p-2 text-xs text-slate-300 disabled:opacity-40"
        >
          {showReceipts ? 'hide receipts' : `Receipts on this PO (${po.receiptCount})`}
        </button>
      )}
      {showReceipts && <ReceiptsOnPo poId={po.id} onChanged={onChanged} />}
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

/**
 * A count of receipt photos captured but not yet on the server (2026-09-12) —
 * the fix for the 2026-09-11 incident where a failed upload was silent and
 * indistinguishable from a purchase never photographed. Polls rather than
 * pushing an event: cheap (one indexed count) and always current whenever
 * this list is looked at, which is exactly when it matters.
 */
export function PendingReceiptsNotice() {
  const [count, setCount] = useState(0)
  useEffect(() => {
    let cancelled = false
    const poll = () => { void pendingReceiptCount().then((n) => { if (!cancelled) setCount(n) }) }
    poll()
    const id = setInterval(poll, 5000)
    return () => { cancelled = true; clearInterval(id) }
  }, [])
  if (count === 0) return null
  return (
    <p className="rounded-lg bg-amber-950/60 p-2 text-xs text-amber-200">
      {count} receipt{count === 1 ? '' : 's'} queued on this device, waiting for signal to file.
    </p>
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
