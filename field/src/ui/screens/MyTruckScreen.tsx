/**
 * My truck (Kyle, 2026-09-09, Build 3): what is on this truck, the tools on
 * it, a restock ask, and the truck's POs waiting to land.
 *
 * "tracks what is on the truck and what is at the warehouse ... When they are
 * used and stored the stock will be updated as to where the tool is currently
 * at." Opens from the Today list like Purchases; no assessment session needed.
 *
 * Online only — landing and tool moves are NOT queued (a replay later could
 * double-count); the failure text says "needs signal".
 */

import { useEffect, useState } from 'react'
import {
  fetchMyTruck,
  moveToolFromField,
  requestRestock,
  requireSignal,
  searchStockItems,
  type FieldMyTruck,
  type FieldStockItem,
  type FieldTool,
} from '../../lib/crmSync'
import { LandPoForm } from '../components/LandPoForm'
import { PO_PURPOSE_LABEL } from '../components/PurchaseOrderPanel'

const needsSignal = (err: unknown) => `Needs signal — ${err instanceof Error ? err.message : String(err)}`
const qtyText = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2))

export function MyTruckScreen({ onBack }: { onBack: () => void }) {
  const [data, setData] = useState<FieldMyTruck | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [showAllStock, setShowAllStock] = useState(false)
  const [landingId, setLandingId] = useState<string | null>(null)
  const [banner, setBanner] = useState<string | null>(null)

  const load = () => {
    setLoading(true)
    fetchMyTruck()
      .then((r) => { setData(r); setError(null) })
      .catch((err) => setError(needsSignal(err)))
      .finally(() => setLoading(false))
  }
  useEffect(() => { load() }, [])

  const levels = data?.levels ?? []
  const visibleStock = showAllStock ? levels : levels.slice(0, 12)

  return (
    <div className="mx-auto max-w-xl space-y-4 p-6 pb-16">
      <button type="button" onClick={onBack} className="text-sm text-sky-300">
        ← Today
      </button>

      <header className="space-y-1">
        <h1 className="text-xl font-semibold text-white">{data ? data.truck.name : 'My truck'}</h1>
        <p className="text-xs text-slate-400">
          Truck stock is what jobs get charged from. Ask for restock and the office moves it from the warehouse.
        </p>
      </header>

      {error && <p className="rounded-lg bg-red-950/60 p-2 text-xs text-red-200">{error}</p>}
      {banner && <p className="rounded-lg border border-emerald-700 bg-emerald-950/50 p-2 text-xs text-emerald-200">{banner}</p>}

      {/* ── POs to land ── */}
      {data && data.unlandedPos.length > 0 && (
        <section className="space-y-2 rounded-xl border border-amber-800 bg-slate-800/60 p-4">
          <h2 className="text-sm font-semibold text-white">Purchases to land ({data.unlandedPos.length})</h2>
          <p className="text-[11px] text-slate-500">Bought and back at the truck? Land it — the material goes on the truck and the PO closes.</p>
          <ul className="space-y-2">
            {data.unlandedPos.map((po) => (
              <li key={po.id} className="space-y-2 rounded-lg border border-slate-700 bg-slate-900/60 p-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-base font-bold tabular-nums text-white">{po.number}</p>
                    <p className="text-xs text-slate-300">{po.supplier} · {PO_PURPOSE_LABEL[po.purpose] ?? po.purpose} · {po.status}</p>
                    {po.items.length > 0 && <p className="text-[11px] text-slate-400">{po.items.map((i) => `${i.qty}× ${i.name}`).join(' · ')}</p>}
                  </div>
                  <button
                    type="button"
                    onClick={() => setLandingId(landingId === po.id ? null : po.id)}
                    className="rounded-lg bg-emerald-800 px-3 py-2 text-xs font-medium text-white"
                  >
                    {landingId === po.id ? 'hide' : 'Land'}
                  </button>
                </div>
                {landingId === po.id && (
                  <LandPoForm
                    poId={po.id}
                    onLanded={(r) => { setBanner(`✓ ${r.number} landed.`); setLandingId(null); load() }}
                  />
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ── Stock ── */}
      <section className="space-y-2 rounded-xl border border-slate-700 bg-slate-800/60 p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-white">Stock on the truck ({levels.length})</h2>
          <button type="button" className="text-xs text-sky-300 underline" onClick={load} disabled={loading}>
            {loading ? 'loading…' : 'refresh'}
          </button>
        </div>
        {!loading && levels.length === 0 && <p className="text-xs text-slate-500">Nothing on the books for this truck yet — land a PO or ask the office for a count.</p>}
        {levels.length > 0 && (
          <table className="w-full text-xs">
            <thead className="text-left text-[10px] uppercase text-slate-500">
              <tr><th>Item</th><th className="text-right">On hand</th></tr>
            </thead>
            <tbody>
              {visibleStock.map((l) => (
                <tr key={l.id} className={`border-t border-slate-700 ${l.low ? 'text-amber-200' : 'text-slate-200'}`}>
                  <td className="py-1 pr-2">{l.name}{l.low ? ' · low' : ''}</td>
                  <td className="py-1 text-right tabular-nums">{qtyText(l.qtyOnHand)} {l.unit ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {levels.length > 12 && !showAllStock && (
          <button type="button" className="text-xs text-sky-300 underline" onClick={() => setShowAllStock(true)}>Show more ({levels.length - 12})</button>
        )}
      </section>

      {/* ── Restock ── */}
      <section className="space-y-2 rounded-xl border border-slate-700 bg-slate-800/60 p-4">
        <h2 className="text-sm font-semibold text-white">Request restock</h2>
        <RestockForm onSent={() => { setBanner('✓ Restock request sent to the office.'); load() }} />
        {data && data.openRequests.length > 0 && (
          <ul className="space-y-1 pt-1">
            <p className="text-[11px] text-slate-500">Waiting on the office</p>
            {data.openRequests.map((r) => (
              <li key={r.id} className="text-xs text-slate-300">{qtyText(r.qty)} {r.unit ?? ''} {r.name}{r.note ? ` — ${r.note}` : ''}</li>
            ))}
          </ul>
        )}
      </section>

      {/* ── Tools ── */}
      <section className="space-y-2 rounded-xl border border-slate-700 bg-slate-800/60 p-4">
        <h2 className="text-sm font-semibold text-white">Tools on the truck ({data?.tools.length ?? 0})</h2>
        {data && data.tools.length === 0 && <p className="text-xs text-slate-500">No tools registered on this truck.</p>}
        <ul className="space-y-2">
          {data?.tools.map((t) => (
            <ToolRow key={t.id} tool={t} locations={data.locations} onMoved={(msg) => { setBanner(msg); load() }} />
          ))}
        </ul>
      </section>
    </div>
  )
}

function RestockForm({ onSent }: { onSent: () => void }) {
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<FieldStockItem[]>([])
  const [picked, setPicked] = useState<FieldStockItem | null>(null)
  const [name, setName] = useState('')
  const [qty, setQty] = useState('1')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  useEffect(() => {
    if (q.trim().length < 2) { setHits([]); return }
    let cancelled = false
    searchStockItems(q.trim())
      .then((r) => { if (!cancelled) setHits(r) })
      .catch(() => { if (!cancelled) setHits([]) })
    return () => { cancelled = true }
  }, [q])

  const submit = async () => {
    const label = picked ? (picked.description ?? picked.itemId) : name.trim()
    if (!label) { setMsg('Say what you need — pick from the book or type it.'); return }
    if (!(Number(qty) > 0)) { setMsg('Quantity is needed.'); return }
    setBusy(true)
    setMsg(null)
    try {
      await requestRestock({ itemId: picked?.itemId ?? null, name: label, qty: Number(qty), unit: picked?.unit ?? null, note: note.trim() || null })
      setPicked(null); setName(''); setQty('1'); setNote(''); setQ('')
      onSent()
    } catch (err) {
      setMsg(needsSignal(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-2">
      {picked ? (
        <div className="flex items-center justify-between rounded border border-sky-700 bg-sky-950/40 p-2 text-xs text-sky-100">
          <span>{picked.itemId} · {picked.description}</span>
          <button type="button" className="text-sky-300 underline" onClick={() => setPicked(null)}>change</button>
        </div>
      ) : (
        <>
          <input
            className="w-full rounded border border-slate-600 bg-slate-900 p-2 text-sm text-white placeholder:text-slate-500"
            placeholder="Search the book (12-2 NM-B, 4-square…)"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          {hits.length > 0 && (
            <ul className="max-h-40 overflow-auto rounded border border-slate-700 bg-slate-900">
              {hits.map((h) => (
                <li key={h.itemId}>
                  <button type="button" className="w-full p-2 text-left text-xs text-slate-200 hover:bg-slate-800" onClick={() => { setPicked(h); setHits([]); setQ('') }}>
                    <span className="font-medium">{h.itemId}</span> {h.description} <span className="text-slate-500">{h.unit ?? ''}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <input
            className="w-full rounded border border-slate-600 bg-slate-900 p-2 text-sm text-white placeholder:text-slate-500"
            placeholder="…or type it (not in the book)"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </>
      )}
      <div className="flex gap-2">
        <input
          className="w-20 rounded border border-slate-600 bg-slate-900 p-2 text-sm text-white"
          inputMode="decimal"
          value={qty}
          onChange={(e) => setQty(e.target.value)}
        />
        <input
          className="flex-1 rounded border border-slate-600 bg-slate-900 p-2 text-sm text-white placeholder:text-slate-500"
          placeholder="Note (optional)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <button
          type="button"
          disabled={busy}
          onClick={() => void submit()}
          className="rounded-lg bg-sky-700 px-3 py-2 text-xs font-medium text-white disabled:opacity-40"
        >
          {busy ? 'Sending…' : 'Request'}
        </button>
      </div>
      {msg && <p className="text-xs text-slate-300">{msg}</p>}
    </div>
  )
}

function ToolRow({ tool, locations, onMoved }: { tool: FieldTool; locations: { key: string; label: string }[]; onMoved: (msg: string) => void }) {
  const [moving, setMoving] = useState(false)
  const [to, setTo] = useState(locations[0]?.key ?? 'warehouse')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const move = async () => {
    setBusy(true)
    setMsg(null)
    try {
      requireSignal()
      await moveToolFromField(tool.id, to)
      const label = locations.find((l) => l.key === to)?.label ?? to
      onMoved(`✓ ${tool.name} is now at ${label}.`)
      setMoving(false)
    } catch (err) {
      setMsg(`Not moved — ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className="space-y-2 rounded-lg border border-slate-700 bg-slate-900/60 p-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-sm text-white">{tool.name}</p>
          <p className="text-[11px] text-slate-500">
            {tool.serial ? `#${tool.serial} · ` : ''}{tool.condition.replace('_', ' ')}{tool.purchaseOrderNumber ? ` · ${tool.purchaseOrderNumber}` : ''}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setMoving((m) => !m)}
          className="rounded-lg border border-sky-700 px-3 py-2 text-xs text-sky-200"
        >
          {moving ? 'hide' : 'Move'}
        </button>
      </div>
      {moving && (
        <div className="flex gap-2">
          <select
            className="flex-1 rounded border border-slate-600 bg-slate-900 p-2 text-sm text-white"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          >
            {locations.map((l) => <option key={l.key} value={l.key}>{l.label}</option>)}
          </select>
          <button
            type="button"
            disabled={busy}
            onClick={() => void move()}
            className="rounded-lg bg-sky-700 px-3 py-2 text-xs font-medium text-white disabled:opacity-40"
          >
            {busy ? 'Moving…' : 'Move it'}
          </button>
        </div>
      )}
      {msg && <p className="text-xs text-slate-300">{msg}</p>}
    </li>
  )
}
