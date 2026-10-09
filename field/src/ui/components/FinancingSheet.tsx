/**
 * "or from $X/mo with financing" on the "Show the customer" screen, and the sheet of Synchrony plan
 * cards it opens (2026-10-08, one-estimating-system plan, Phase 5 unit B).
 *
 * Kyle, 2026-10-08: "the tool that service titan has which allows you to input the job total cost,
 * the plan they select and it shows them their monthly payment. This way we can present the options
 * as a low monthly cost rather than a big bill and subsequently send them the financing option."
 *
 * The technician is standing at the panel with the homeowner (CLAUDE.md, two apps, two people, two
 * places), so this belongs on the phone's customer screen - the twin of the CRM's FinancingSheet,
 * reading the SAME words and lookups from shared/financingDisplay.ts.
 *
 * THIS COMPONENT CALCULATES NOTHING. Deposit, financing fee (its own line), amount financed and the
 * monthly payment were worked out on the server by the one shared calculator and arrive in the quote
 * payload's `money.financing`; the phone looks the ticked selection up and prints it. The payload
 * holds no Synchrony discount rate - Red Cedar's cost - so there is none to show or to hide
 * (tests/financingEstimator.test.ts keeps the rate out of the payload; FinancingSheet.test.tsx
 * searches this component's markup for the rate values).
 *
 * Each card carries ITS plan's Synchrony disclosure text VERBATIM and in full, from the Settings plan
 * list (Kyle's ruling, constants.md "Credit terms in customer copy"), in a fold under the figures.
 * Nothing here records a plan choice: the plan is picked when the balance is paid through Synchrony.
 */

import { useEffect, useState } from 'react'
import type { FinancingOffer, QuoteFinancing } from '../../../../shared/financing'
import {
  breakdownRows,
  financingOffersFor,
  financingSheetNote,
  fromLine,
  monthlyLabel,
  planTitle,
  sheetTotalLine,
  termLine,
  wholeDollars,
} from '../../../../shared/financingDisplay'

export function PlanCard({ offer }: { offer: FinancingOffer }) {
  return (
    <section aria-label={`Plan ${offer.planNumber}`} className="rounded-xl border-2 border-slate-300 bg-white p-4">
      <h3 className="text-lg font-bold">{planTitle(offer)}</h3>
      <p className="text-base text-slate-600">{termLine(offer)}</p>
      <div className="mt-2 flex items-baseline justify-between gap-3">
        <span className="text-base text-slate-600">{monthlyLabel(offer.type)}</span>
        <span className="text-3xl font-bold" data-testid={`monthly-${offer.planNumber}`}>
          {wholeDollars(offer.monthly)}/mo
        </span>
      </div>
      <dl className="mt-2 space-y-1 text-base">
        {breakdownRows(offer).map((r) => (
          <div key={r.label} className="flex justify-between gap-3">
            <dt className="text-slate-600">{r.label}</dt>
            <dd className="font-semibold">{r.value}</dd>
          </div>
        ))}
      </dl>
      <details className="mt-3">
        <summary className="min-h-[2.5rem] cursor-pointer py-2 text-base font-semibold text-sky-800 underline">
          Synchrony&apos;s terms for Plan {offer.planNumber}
        </summary>
        <div className="space-y-2 text-sm text-slate-700">
          <p>{offer.disclosure.explanation}</p>
          <p className="font-semibold">{offer.disclosure.important}</p>
          <p>{offer.disclosure.terms}</p>
        </div>
      </details>
    </section>
  )
}

/**
 * The financing line for one selection, and its full-screen sheet. Renders nothing when no plan is on
 * offer, nothing is ticked, or nothing is owed - never "$0/mo".
 *
 * `label` names what is ticked ("Options A + B"); `total` is that selection's total, shown at the top
 * of the sheet so the cards are read against the number they were worked out from.
 */
export function FinancingLine(props: {
  financing: QuoteFinancing | null | undefined
  selected: readonly string[]
  label: string
  total: number | null
  /** The line's own look; "Show the customer" is light, the Quote screen's totals box is dark. */
  className?: string
}) {
  const { financing, selected, label, total, className } = props
  const [open, setOpen] = useState(false)
  const found = financingOffersFor(financing, selected)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  if (!found) return null
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        className={className ?? 'min-h-[2.5rem] text-base font-semibold text-sky-800 underline'}
      >
        {fromLine(found.from)}
      </button>
      {open && (
        <div role="dialog" aria-modal="true" aria-label="Financing options" className="fixed inset-0 z-50 overflow-y-auto bg-slate-100 text-slate-900">
          <div className="mx-auto max-w-xl space-y-3 p-4 pb-8">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-2xl font-bold">Financing options</h2>
                <p className="text-base text-slate-600">
                  {label}
                  {sheetTotalLine(total, found.from)}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="min-h-[2.75rem] shrink-0 rounded-lg border-2 border-slate-400 bg-white px-4 text-base font-semibold"
              >
                Close
              </button>
            </div>
            <p className="text-base text-slate-700">{financingSheetNote(found.from)}</p>
            {found.offers.map((o) => (
              <PlanCard key={o.planNumber} offer={o} />
            ))}
          </div>
        </div>
      )}
    </>
  )
}
