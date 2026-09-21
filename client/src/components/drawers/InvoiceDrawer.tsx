/**
 * The invoice drawer (2026-09-20). An invoice is a signed estimate; the row comes from
 * GET /invoices (the same list the Financials "Payments received & invoices" card reads, same
 * cache entry) and the money furniture is `PaymentPanel` — deposit / balance / record a
 * payment / the QR / the deposit-required override / the warranty split, as build #1 left it.
 * Added beside it: the reminder nudge, emailing the signed PDF (with job photos, to a chosen
 * address), and opening either copy — everything the Financials panel and the account page's
 * filed-copy row can do to an invoice today.
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api, openProtectedPdf } from "../../lib/api";
import { useDrawerParams } from "../../lib/drawers";
import { money } from "../../lib/utils";
import { BounceBadge } from "../BounceBadge";
import { DeliveryChip } from "../DeliveryChip";
import { Drawer } from "../Drawer";
import { PaymentPanel } from "../PaymentPanel";
import { PhotoAttachPicker } from "../PhotoGalleryPanel";
import { SendToPicker } from "../SendToPicker";
import { OpenDrawerButton } from "./OpenDrawerButton";

export function InvoiceDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const drawers = useDrawerParams();
  const { data: invoices, isLoading, error } = useQuery({ queryKey: ["invoices"], queryFn: api.invoices });
  const inv = invoices?.find((row) => row.id === id) ?? null;

  const onChange = () => {
    for (const key of [["invoices"], ["payments"], ["financials"], ["jobProfitability"], ["warrantyReceivables"], ["paymentInfo"], ["account-summary"]]) {
      void queryClient.invalidateQueries({ queryKey: key });
    }
  };

  const [notice, setNotice] = useState<string | null>(null);
  const [error2, setError2] = useState<string | null>(null);
  const remind = useMutation({
    mutationFn: () => api.sendPaymentReminder(id),
    onSuccess: (r) => { setError2(null); setNotice(`Reminder emailed to ${r.to} — ${money(r.amount)} open.`); onChange(); },
    onError: (err) => { setNotice(null); setError2((err as Error).message); },
  });

  // Email the signed invoice PDF (2026-08-21) — to the primary, a stored contact, or a typed
  // address, with before/after photos ticked per send, never assumed.
  const [showSend, setShowSend] = useState(false);
  const [toOverride, setToOverride] = useState<string | null>(null);
  const [photoIds, setPhotoIds] = useState<string[]>([]);
  const send = useMutation({
    mutationFn: () => api.sendInvoice(id, { toOverride, photoIds: photoIds.length > 0 ? photoIds : undefined }),
    onSuccess: (r) => { setError2(null); setNotice(`Invoice emailed to ${r.to}.`); onChange(); },
    onError: (err) => { setNotice(null); setError2((err as Error).message); },
  });

  return (
    <Drawer
      title={inv ? `Invoice ${inv.number}${inv.revision > 1 ? ` rev ${inv.revision}` : ""}` : "Invoice"}
      subtitle={inv ? `${inv.customer.name} · ${inv.title} · ${inv.serviceAddress}` : undefined}
      onClose={onClose}
      wide
    >
      {error && <p className="text-sm text-red-600">Could not load invoices: {(error as Error).message}</p>}
      {isLoading && <p className="text-sm text-rce-muted">Loading…</p>}
      {invoices && !inv && (
        <p className="text-sm text-rce-muted">
          No live invoice has this id — it may be voided or superseded. Its estimate is on the account page.
        </p>
      )}
      {inv && (
        <div className="space-y-3 pb-4 text-sm">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Link to={`/accounts/${inv.customer.id}`} className="btn btn-secondary px-2 py-0.5 text-xs min-h-0">{inv.customer.name} →</Link>
            {inv.job && <OpenDrawerButton kind="job" id={inv.job.id} onOpen={drawers.open} label={`Job: ${inv.job.jobType ?? inv.job.purpose ?? inv.job.status.replaceAll("_", " ")}`} />}
            <OpenDrawerButton kind="estimate" id={inv.id} onOpen={drawers.open} label="Estimate record" />
          </div>
          <p className="text-xs text-rce-muted">
            {inv.customerPhone ?? "no phone on file"} · {inv.customerEmail ?? "no email on file"}
            <br />
            signed {new Date(inv.signedAt).toLocaleDateString()}
            {inv.signedChannel === "in_person" ? " in person" : inv.signedChannel === "email" ? " from the emailed link" : ""}
            {inv.sentTo ? ` · sent to ${inv.sentTo}` : " · not emailed"}
            {inv.job ? ` · job ${inv.job.status.replaceAll("_", " ")}` : " · job not created yet"}
            {inv.remindersSent > 0 && ` · reminded ${inv.remindersSent}x${inv.lastReminderAt ? ` (last ${new Date(inv.lastReminderAt).toLocaleDateString()})` : ""}`}
          </p>
          {(inv.lastBounceAt || inv.lastDelivery) && (
            <div className="flex flex-wrap items-center gap-1.5">
              {inv.lastBounceAt && <BounceBadge at={inv.lastBounceAt} reason={inv.lastBounceReason} />}
              <DeliveryChip delivery={inv.lastDelivery} />
            </div>
          )}
          {inv.discountTotal > 0 && (
            <p className="text-xs text-emerald-700">includes {money(inv.discountTotal)} discount credit (retired 3% programme)</p>
          )}

          <PaymentPanel estimateId={id} />

          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn btn-secondary text-sm" onClick={() => void openProtectedPdf(`/issued-estimates/${id}/pdf`)}>
              Customer copy (PDF)
            </button>
            <button type="button" className="btn btn-secondary text-sm" onClick={() => void openProtectedPdf(`/issued-estimates/${id}/pdf?audience=company`)}>
              Our copy (PDF)
            </button>
            {inv.paymentStatus !== "paid" && (
              <button type="button" className="btn btn-secondary text-sm" disabled={remind.isPending} onClick={() => remind.mutate()}>
                {remind.isPending ? "Sending…" : "Send reminder"}
              </button>
            )}
            <button type="button" className="btn btn-secondary text-sm" onClick={() => setShowSend((s) => !s)}>
              {showSend ? "Hide email" : "Email invoice…"}
            </button>
          </div>

          {showSend && (
            <div className="space-y-2 rounded-lg border border-rce-border p-3">
              <SendToPicker accountId={inv.customer.id} primaryEmail={inv.customerEmail} onChange={setToOverride} />
              <PhotoAttachPicker propertyId={inv.propertyId} selected={photoIds} onChange={setPhotoIds} />
              <button type="button" className="btn btn-primary text-sm" disabled={send.isPending} onClick={() => send.mutate()}>
                {send.isPending ? "Sending…" : `Email invoice${photoIds.length ? ` with ${photoIds.length} photo${photoIds.length === 1 ? "" : "s"}` : ""}`}
              </button>
              {!inv.customerEmail && <p className="text-xs text-rce-soft">No email on this invoice — pick a contact or type one above.</p>}
            </div>
          )}
          {notice && <p className="text-xs text-green-700">{notice}</p>}
          {error2 && <p className="text-xs text-red-700">{error2}</p>}
        </div>
      )}
    </Drawer>
  );
}
