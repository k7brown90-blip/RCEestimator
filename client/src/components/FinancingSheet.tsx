/**
 * "or from $X/mo with financing" - the line under a selection total, and the sheet of Synchrony plan
 * cards it opens (2026-10-08, one-estimating-system plan, Phase 5 unit B).
 *
 * Kyle, 2026-10-08: "the tool that service titan has which allows you to input the job total cost,
 * the plan they select and it shows them their monthly payment. This way we can present the options
 * as a low monthly cost rather than a big bill and subsequently send them the financing option."
 *
 * Used on the two office screens that stand in front of a customer or a customer's number: "Present
 * to the customer" (PresentationPage) and the Estimate Intake totals bar (PriceBookIntakePage).
 *
 * THIS COMPONENT CALCULATES NOTHING. The deposit, the financing fee (its own line), the amount
 * financed and the monthly payment were worked out on the server by the one shared calculator and
 * arrive in `money.financing`; this looks the ticked selection up (shared/financingDisplay.ts) and
 * prints it. It also holds no Synchrony discount rate - Red Cedar's cost - because the payload it
 * is handed has none (FinancingPlanView / FinancingFigures). PresentationPage.test.tsx and
 * FinancingSheet.test.tsx search the rendered markup for the rate values to keep it that way.
 *
 * Each card carries ITS plan's Synchrony disclosure text VERBATIM, in full, from the Settings plan
 * list (Kyle's ruling, constants.md "Credit terms in customer copy"). The disclosure sits in a
 * "Synchrony's terms for Plan NNN" fold under the card's figures - one tap, never trimmed. Nothing
 * here records a plan choice: the plan is picked when the balance is paid through Synchrony.
 */

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { FinancingOffer, QuoteFinancing } from "../../../shared/financing";
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
} from "../../../shared/financingDisplay";

export function PlanCard({ offer }: { offer: FinancingOffer }) {
  return (
    <section aria-label={`Plan ${offer.planNumber}`} className="card p-3">
      <h3 className="text-sm font-semibold">{planTitle(offer)}</h3>
      <p className="text-xs text-rce-soft">{termLine(offer)}</p>
      <div className="mt-2 flex items-baseline justify-between gap-3">
        <span className="text-xs text-rce-soft">{monthlyLabel(offer.type)}</span>
        <span className="text-2xl font-semibold" data-testid={`monthly-${offer.planNumber}`}>
          {wholeDollars(offer.monthly)}/mo
        </span>
      </div>
      <dl className="mt-2 space-y-0.5 text-sm">
        {breakdownRows(offer).map((r) => (
          <div key={r.label} className="flex justify-between gap-3">
            <dt className="text-rce-soft">{r.label}</dt>
            <dd className="font-medium">{r.value}</dd>
          </div>
        ))}
      </dl>
      <details className="mt-2">
        <summary className="cursor-pointer text-xs font-semibold text-rce-accentDark underline">
          Synchrony&apos;s terms for Plan {offer.planNumber}
        </summary>
        <div className="mt-1 space-y-2 text-xs text-rce-soft">
          <p>{offer.disclosure.explanation}</p>
          <p className="font-semibold">{offer.disclosure.important}</p>
          <p>{offer.disclosure.terms}</p>
        </div>
      </details>
    </section>
  );
}

/**
 * The financing line for one selection, and its sheet. Renders nothing when there is no plan on
 * offer, nothing is ticked, or nothing is owed - never "$0/mo".
 *
 * `label` names what is ticked ("Options A + B"); `total` is that selection's total, shown at the
 * top of the sheet so the cards are read against the number they were worked out from.
 */
export function FinancingLine(props: {
  financing: QuoteFinancing | null | undefined;
  selected: readonly string[];
  label: string;
  total: number | null;
  className?: string;
}) {
  const { financing, selected, label, total, className } = props;
  const [open, setOpen] = useState(false);
  const found = financingOffersFor(financing, selected);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!found) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        className={className ?? "text-xs font-semibold text-rce-accentDark underline"}
      >
        {fromLine(found.from)}
      </button>
      {/*
        Portalled to <body> (review finding, 2026-10-08): both screens that use this put the line in a
        `backdrop-blur` bottom bar, and a backdrop-filter makes that bar the containing block for any
        `position: fixed` child - so an inline overlay filled only the ~100px bar and the dialog fell
        half off the screen. Drawer.tsx does the same for the same reason.
      */}
      {open && createPortal(
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 md:items-center" role="presentation">
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Financing options"
            className="max-h-[90vh] w-full max-w-xl overflow-y-auto overscroll-contain rounded-t-xl bg-white p-4 shadow-xl md:rounded-xl"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold">Financing options</h2>
                <p className="text-xs text-rce-soft">
                  {label}
                  {sheetTotalLine(total, found.from)}
                </p>
              </div>
              <button type="button" className="btn btn-secondary" onClick={() => setOpen(false)}>
                Close
              </button>
            </div>
            <p className="mt-2 text-xs text-rce-soft">{financingSheetNote(found.from)}</p>
            <div className="mt-3 space-y-3">
              {found.offers.map((o) => (
                <PlanCard key={o.planNumber} offer={o} />
              ))}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
