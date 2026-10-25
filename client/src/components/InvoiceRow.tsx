import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { SendToPicker } from "./SendToPicker";
import { PaymentPanel } from "./PaymentPanel";
import { PhotoAttachPicker } from "./PhotoGalleryPanel";
import { api, openProtectedPdf } from "../lib/api";
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
 */
export function InvoiceRow({ doc: d, accountId, properties }: {
  doc: AccountSummary["documents"][number];
  accountId: string;
  /** The addresses the photo picker below offers photos from. The account page passed every
   * address on the account (2026-10-01, item J); the Property page (2026-10-24) passes just its
   * own, so "Attach photos" there offers THIS property's photos. */
  properties: Array<{ id: string; name: string; addressLine1: string; city: string }>;
}) {
  const [sent, setSent] = useState<string | null>(null);
  // Which address (Kyle, 2026-08-25) — null lets the server default to primary.
  const [toOverride, setToOverride] = useState<string | null>(null);
  // CC (Kyle, 2026-10-24): one email, the To above plus any number of CCs.
  const [cc, setCc] = useState<string[]>([]);
  const [showPay, setShowPay] = useState(false);
  // Photo gallery (2026-08-28): before/after photos ticked to ride the invoice.
  const [photoIds, setPhotoIds] = useState<string[]>([]);
  const [showPhotos, setShowPhotos] = useState(false);

  const send = useMutation({
    mutationFn: () => api.sendInvoice(d.estimateId as string, {
      toOverride,
      ...(cc.length > 0 ? { cc } : {}),
      photoIds: photoIds.length > 0 ? photoIds : undefined,
    }),
    onSuccess: (r) => setSent(r.cc && r.cc.length > 0 ? `${r.to} (cc ${r.cc.join(", ")})` : r.to),
  });

  const canSend = d.audience === "customer" && Boolean(d.estimateId);

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
        {canSend && (
          <>
            <SendToPicker accountId={accountId} primaryEmail={d.customerEmail} onChange={setToOverride} onCcChange={setCc} />
            <button
              type="button"
              onClick={() => send.mutate()}
              disabled={send.isPending}
              className="btn btn-primary flex-1 text-sm disabled:opacity-60"
            >
              {/*
                Says what it sends (2026-09-29): the SIGNED COPY of this row's document, not the
                whole invoice. The whole invoice goes out from "Email invoice NNNN — $X due" on
                the payment panel ("Take payment…" below). The same two words as the invoice
                drawer's button, because it is the same send — two names for one action is how
                the wrong one got pressed after the Hoover job.
              */}
              {send.isPending ? "Sending…" : d.isChangeOrder ? "Email the signed change order" : "Email the signed copy"}
            </button>
          </>
        )}
      </div>

      {/*
        Photo gallery (2026-08-28): attach photos to the invoice email — per send, ticked by the
        operator, never assumed. Gated on the ACCOUNT having an address at all (2026-10-01, item
        J), not on this document's own `propertyId` — the picker now reaches every property on
        the account, not just the one this document was filed at. Photos added while building
        the estimate are job photos too (plan A, 2026-10-02), so that one source covers them.
      */}
      {canSend && properties.length > 0 && (
        <div className="mt-2">
          <button type="button" className="btn btn-secondary px-2 py-0.5 text-xs min-h-0" onClick={() => setShowPhotos((s) => !s)}>
            {showPhotos ? "Hide photos" : `Attach photos…${photoIds.length ? ` (${photoIds.length})` : ""}`}
          </button>
          {showPhotos && (
            <PhotoAttachPicker properties={properties} selected={photoIds} onChange={setPhotoIds} />
          )}
        </div>
      )}

      {sent && <p className="mt-2 text-xs text-green-700">Invoice emailed to {sent}.</p>}
      {send.isError && (
        <p className="mt-2 text-xs text-red-600">{(send.error as Error).message}</p>
      )}

      {/* Charge the card / record the check, right off the invoice (2026-08-25). */}
      {canSend && (
        <div className="mt-2">
          <button type="button" className="btn btn-secondary px-2 py-0.5 text-xs min-h-0" onClick={() => setShowPay((s) => !s)}>
            {showPay ? "Hide payment" : "Take payment…"}
          </button>
          {showPay && d.estimateId && (
            <div className="mt-2">
              <PaymentPanel estimateId={d.estimateId} />
            </div>
          )}
        </div>
      )}
      {canSend && !d.customerEmail && !sent && (
        <p className="mt-2 text-xs text-rce-soft">
          No email on this estimate — add one to the customer record first.
        </p>
      )}
    </div>
  );
}
