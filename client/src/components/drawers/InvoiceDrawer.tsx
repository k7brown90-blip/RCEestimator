/**
 * The invoice drawer (2026-09-20). An invoice is a signed estimate; the row comes from
 * GET /invoices (the same list the Financials "Payments received & invoices" card reads, same
 * cache entry) and the money furniture is `PaymentPanel` — deposit / balance / record a
 * payment / the QR / the deposit-required override / the warranty split, as build #1 left it.
 * Added beside it: opening either copy and raising a change order.
 *
 * ONE EMAIL CONTROL (Kyle, 2026-10-27: "A rule of thumb is there is one tool for one task."). This
 * drawer used to carry "Send reminder", "Email the signed copy…" / "Hide email" and, inside the
 * payment panel, "Email invoice NNNN — $X due" - three buttons that all emailed this invoice. They
 * are the "Email the customer" panel inside the payment card: Invoice / Deposit request / Financing
 * link / Review request / Message, to a chosen contact + CC, with one Send button that names both.
 * Click path from the Dashboard: Invoices -> the invoice -> Email the customer -> Invoice -> pick
 * who -> "Send invoice NNNN to …".
 */

import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api, openProtectedPdf } from "../../lib/api";
import { useDrawerParams } from "../../lib/drawers";
import { money } from "../../lib/utils";
import { BounceBadge } from "../BounceBadge";
import { DeliveryChip } from "../DeliveryChip";
import { Drawer } from "../Drawer";
import { PaymentPanel } from "../PaymentPanel";
import { RaiseChangeOrderButton } from "../RaiseChangeOrderButton";
import { OpenDrawerButton } from "./OpenDrawerButton";
import { acceptanceWording } from "../../../../shared/acceptance";

export function InvoiceDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const drawers = useDrawerParams();
  const { data: invoices, isLoading, error } = useQuery({ queryKey: ["invoices"], queryFn: api.invoices });
  const inv = invoices?.find((row) => row.id === id) ?? null;

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
            {/* "signed … in person" / "accepted … by phone, recorded by the office" — shared/acceptance.ts;
                an office acceptance (2026-09-24) never reads as a bare "signed". */}
            {acceptanceWording(inv.signedChannel, inv.acceptedVia).verb} {new Date(inv.signedAt).toLocaleDateString()}
            {acceptanceWording(inv.signedChannel, inv.acceptedVia).how ? ` ${acceptanceWording(inv.signedChannel, inv.acceptedVia).how}` : ""}
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
            {/*
              The job grew (2026-09-29). The invoice is one of the three places a person stands
              when a tech rings to say there is more work — it lands on THIS invoice, one balance
              and one payment (services/invoiceGroup.ts). `inv` comes from GET /invoices, which
              lists live signed roots only, so the target is always signed and never void.
            */}
            <RaiseChangeOrderButton
              target={{ estimateId: inv.id, status: "signed", signed: true }}
            />
          </div>
        </div>
      )}
    </Drawer>
  );
}
