/**
 * Collect payment in the driveway (Kyle, 2026-08-25). The customer scans the
 * QR or takes the shared link and pays on their own phone through Stripe
 * Checkout — the tech never touches a card number and can't change an amount.
 * Deposit collects first; the balance QR appears once the deposit is in.
 * Needs signal, deliberately: payment status has to be live to be trusted.
 *
 * Extracted from AssignmentScreen when the job-site screen arrived (Phase 2)
 * so both surfaces show the identical collection flow.
 */

import { useEffect, useState } from 'react'
import { fetchVisitPaymentInfo, type VisitPaymentInfo } from '../../lib/crmSync'

export function CollectPayment({ visitId, startOpen = false }: { visitId: string; startOpen?: boolean }) {
  const [open, setOpen] = useState(startOpen)
  const [info, setInfo] = useState<VisitPaymentInfo | null | 'none'>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await fetchVisitPaymentInfo(visitId)
      setInfo(result ?? 'none')
      setLoaded(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (open && !loaded) void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full rounded-lg border border-emerald-800 bg-emerald-950/40 p-2 text-xs text-emerald-200"
      >
        💳 Collect payment
      </button>
    )
  }

  return (
    <div className="space-y-2 rounded-lg border border-emerald-800 bg-emerald-950/30 p-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-emerald-200">Collect payment</span>
        <span className="flex gap-3">
          <button type="button" className="text-xs text-sky-300 underline" onClick={() => void load()}>
            {loading ? 'checking…' : 'refresh'}
          </button>
          <button type="button" className="text-xs text-slate-400 underline" onClick={() => setOpen(false)}>
            close
          </button>
        </span>
      </div>
      {error && <p className="rounded bg-red-950/60 p-2 text-xs text-red-200">{error}</p>}
      {info === 'none' && (
        <p className="text-xs text-slate-400">No signed estimate on this visit yet — nothing to collect.</p>
      )}
      {info && info !== 'none' && (
        <>
          <p className="text-xs text-slate-300">
            Invoice {info.number} · total ${info.billedTotal.toFixed(2)}
            {info.totalPaid > 0 && ` · paid $${info.totalPaid.toFixed(2)}`}
          </p>
          {info.paidInFull ? (
            <p className="rounded bg-emerald-900/60 p-2 text-sm font-medium text-emerald-200">
              ✓ Paid in full — nothing to collect.
            </p>
          ) : (
            <>
              <div className="rounded-lg bg-white p-2 text-center">
                <p className="mb-1 text-xs font-medium text-slate-800">
                  {info.depositSatisfied
                    ? `Balance due: $${info.balance.toFixed(2)} — customer scans:`
                    : `Deposit due: $${(info.depositDue - info.depositPaid).toFixed(2)} — customer scans:`}
                </p>
                <img
                  src={info.depositSatisfied ? info.qrUrl : info.depositQrUrl}
                  alt="Payment QR"
                  className="mx-auto h-44 w-44"
                />
              </div>
              <div className="flex gap-2">
                <a
                  href={info.depositSatisfied ? info.payUrl : info.depositPayUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="flex-1 rounded-lg bg-sky-600 p-2 text-center text-xs font-medium text-white"
                >
                  Open pay page
                </a>
                {typeof navigator.share === 'function' && (
                  <button
                    type="button"
                    className="flex-1 rounded-lg border border-slate-600 p-2 text-xs text-slate-200"
                    onClick={() =>
                      void navigator.share({
                        title: 'Red Cedar Electric — pay online',
                        url: info.depositSatisfied ? info.payUrl : info.depositPayUrl,
                      }).catch(() => {})
                    }
                  >
                    Share link
                  </button>
                )}
              </div>
              <p className="text-[10px] text-slate-500">
                Tap refresh after they pay — the paid mark comes from the office record, live.
              </p>
            </>
          )}
        </>
      )}
    </div>
  )
}
