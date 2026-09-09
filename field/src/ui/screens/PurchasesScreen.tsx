/**
 * Purchases (Kyle, 2026-09-09): a purchase with no job — truck stock, a
 * warehouse run, or a tool. "Purchasing needs to start with a P.O. number
 * then the purchase and photo verification of the receipt." Opens from the
 * Today list like My accounts; no assessment session needed.
 *
 * Lists this tech's open and purchased POs (including ones the office opened,
 * so a PO started at the desk can be read at the counter). Online only — the
 * number comes from the office, and the failure text says "needs signal".
 */

import { useEffect, useState } from 'react'
import { fetchMyPurchaseOrders, type FieldPurchaseOrder } from '../../lib/crmSync'
import { PoNumberBanner, PurchaseOrderList, StartPurchaseForm, type CreatedPo } from '../components/PurchaseOrderPanel'

export function PurchasesScreen({ onBack }: { onBack: () => void }) {
  const [orders, setOrders] = useState<FieldPurchaseOrder[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [justCreated, setJustCreated] = useState<CreatedPo | null>(null)

  const load = () => {
    setLoading(true)
    fetchMyPurchaseOrders()
      .then((r) => { setOrders(r.orders); setError(null) })
      .catch((err) => setError(`Needs signal — ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => setLoading(false))
  }
  useEffect(() => { load() }, [])

  return (
    <div className="mx-auto max-w-xl space-y-4 p-6 pb-16">
      <button type="button" onClick={onBack} className="text-sm text-sky-300">
        ← Today
      </button>

      <header className="space-y-1">
        <h1 className="text-xl font-semibold text-white">Purchases</h1>
        <p className="text-xs text-slate-400">
          Start with a PO number, buy, then photo the receipt. Truck stock by default; warehouse and tool runs are their own thing.
        </p>
      </header>

      <section className="space-y-2 rounded-xl border border-slate-700 bg-slate-800/60 p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-white">Start a purchase</h2>
          <button type="button" className="text-xs text-sky-300 underline" onClick={() => setShowForm((s) => !s)}>
            {showForm ? 'hide' : 'new P.O.'}
          </button>
        </div>
        {showForm && (
          <StartPurchaseForm
            onCreated={(po) => {
              setJustCreated(po)
              setShowForm(false)
              load()
            }}
          />
        )}
        {justCreated && <PoNumberBanner po={justCreated} />}
      </section>

      <section className="space-y-2 rounded-xl border border-slate-700 bg-slate-800/60 p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-white">Open and purchased ({orders.length})</h2>
          <button type="button" className="text-xs text-sky-300 underline" onClick={load} disabled={loading}>
            {loading ? 'loading…' : 'refresh'}
          </button>
        </div>
        {error && <p className="rounded-lg bg-red-950/60 p-2 text-xs text-red-200">{error}</p>}
        <PurchaseOrderList orders={orders} onChanged={load} />
      </section>
    </div>
  )
}
