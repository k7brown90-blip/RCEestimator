import { useState } from "react";
import { SendEmailPanel } from "./SendEmailPanel";
import { PaymentPanel, paymentInfoQuery, receiptOffer } from "./PaymentPanel";
import { useQuery } from "@tanstack/react-query";
import { openProtectedPdf } from "../lib/api";
import type { AccountSummary } from "../lib/types";

/**
 * One filed invoice copy — open it, and if it is the customer's, send it.
 *
 * Kyle, 2026-08-21: *"All signed agreements are company copies. No customer copy available and I
 * cannot email the invoice to the client."*
 *
 * The send is offered on the CUSTOMER copy only. Both rows point at the same estimate, so a button
 * on each would be two buttons doing one thing — and the one that reads "our copy" is the last
 * place to put a control that emails a customer.
 *
 * ONE EMAIL CONTROL PER DOCUMENT (Kyle, 2026-10-27: "one tool for one task"). The row's own address
 * picker, "Attach photos…" and "Email the signed copy" are the "Email the customer" panel: Invoice
 * (or Change order, on a change-order row) / Financing link, to a chosen contact + CC, photos for the
 * invoice, one Send button naming both. The payment card under "Take payment…" is mounted WITHOUT its
 * own email panel so this row never shows two.
 */
export function InvoiceRow({ doc: d, accountId, properties }: {
  doc: AccountSummary["documents"][number];
  accountId: string;
  /** The addresses the photo picker below offers photos from. The account page passed every
   * address on the account (2026-10-01, item J); the Property page (2026-10-24) passes just its
   * own, so "Attach photos" there offers THIS property's photos. */
  properties: Array<{ id: string; name: string; addressLine1: string; city: string }>;
}) {
  const [showPay, setShowPay] = useState(false);

  const canSend = d.audience === "customer" && Boolean(d.estimateId);

  // The Receipt choice (Kyle, 2026-10-29) belongs to the ROOT invoice, so only a root row asks for its payment
  // info (the same cache entry the "Take payment…" card below reads). A change-order row never offers one.
  const rootEstimateId = canSend && !d.isChangeOrder ? d.estimateId : null;
  const { data: rootInfo } = useQuery({ ...paymentInfoQuery({ estimateId: rootEstimateId ?? undefined }), enabled: Boolean(rootEstimateId) });

  return (
    <div className="rounded-lg border border-rce-border/70 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          {/*
            A CHANGE ORDER IS NOT A SECOND INVOICE (2026-09-29).

            Signing files two copies of every document, root or change order, so a job with a
            diagnostic and a resolutions change order shows FOUR rows here — and before this all
            of them read "Invoice NNNN". Two customer copies, two "Email invoice" buttons, and
            the same group totals behind each, because paymentSummary resolves to the root. Kyle
            read that as having sent two invoices (the Hoover job, 2026-09-28).

            Now the row says which it is and which invoice it belongs to.
          */}
          <p className="font-medium">
            {d.estimateNumber
              ? `${d.isChangeOrder ? "Change order" : "Invoice"} ${d.estimateNumber}`
              : d.isChangeOrder ? "Change order" : "Invoice"}{" "}
            <span className="text-xs font-normal text-rce-soft">
              {d.audience === "company" ? "· our copy" : "· customer copy"}
            </span>
          </p>
          {d.isChangeOrder && (
            <p className="text-xs text-amber-800">
              {d.invoiceNumber
                ? `Part of invoice ${d.invoiceNumber} — the total, the balance and the pay link are that invoice's.`
                : "A change order — its money belongs to the invoice it joined."}
            </p>
          )}
          <p className="text-xs text-rce-soft">
            {d.signedByName ? `Signed by ${d.signedByName}` : "Signed"}
            {d.signedAt ? ` · ${new Date(d.signedAt).toLocaleDateString()}` : ""}
          </p>
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void openProtectedPdf(`/documents/${d.id}/pdf`)}
          className="btn btn-secondary flex-1 text-sm"
        >
          Open PDF
        </button>
      </div>

      {canSend && (
        <div className="mt-2">
          <SendEmailPanel
            target="account"
            id={accountId}
            primaryEmail={d.customerEmail}
            accountIdForContacts={accountId}
            record={{
              photoProperties: properties,
              estimateId: d.estimateId,
              number: d.estimateNumber ?? undefined,
              reports: rootInfo?.email?.reports ?? [],
              kinds: [
                {
                  kind: "invoice",
                  label: `${d.isChangeOrder ? "Change order" : "Invoice"}${d.estimateNumber ? ` ${d.estimateNumber}` : ""} — the signed copy`,
                  sendAs: `${d.isChangeOrder ? "change order" : "invoice"}${d.estimateNumber ? ` ${d.estimateNumber}` : ""}`,
                },
                ...(rootInfo ? [receiptOffer(rootInfo)] : []),
                { kind: "financing", label: "Financing link" },
              ],
            }}
          />
        </div>
      )}

      {/* Charge the card / record the check, right off the invoice (2026-08-25). */}
      {canSend && (
        <div className="mt-2">
          <button type="button" className="btn btn-secondary px-2 py-0.5 text-xs min-h-0" onClick={() => setShowPay((s) => !s)}>
            {showPay ? "Hide payment" : "Take payment…"}
          </button>
          {showPay && d.estimateId && (
            <div className="mt-2">
              <PaymentPanel estimateId={d.estimateId} emailPanel={false} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
