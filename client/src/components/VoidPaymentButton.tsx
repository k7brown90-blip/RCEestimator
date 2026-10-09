/**
 * "Void…" on a recorded payment (Kyle, 2026-10-08, one-estimating-system decision 11):
 *
 *   "Only the administrator can void a recorded payment ... reason required; row kept, marked
 *    void, audit trail."
 *
 * The CRM session IS the administrator, so this control lives on every CRM list of payments —
 * the Take-payment panel (job page, invoice drawer, account page, signing page) and the
 * Financials year ledger — and nowhere in the field app. It asks for the reason, confirms, and
 * posts to the one void route; the row is never removed from the list, it comes back struck
 * through with "Voided <date> — <reason>" (VoidedPaymentNote below).
 *
 * Greyed WITH the reason, never hidden (CLAUDE.md click-through rule 5): a Stripe row says a
 * card payment is refunded in Stripe; an already-voided row shows the void note instead.
 */

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { money } from "../lib/utils";

/** The query keys every money surface reads — all of them refetch after a void. */
const MONEY_QUERY_KEYS: string[][] = [
  ["paymentInfo"], ["payments"], ["invoices"], ["financials"], ["jobs"], ["schedule"],
  ["jobProfitability"], ["warrantyReceivables"], ["account-summary"], ["accounts"],
];

export function VoidPaymentButton({
  payment,
  onVoided,
}: {
  payment: { id: string; amount: number; method: string; voidedAt?: string | null };
  onVoided?: () => void;
}) {
  const queryClient = useQueryClient();
  const [reopened, setReopened] = useState(0);
  const voidIt = useMutation({
    mutationFn: (reason: string) => api.voidPayment(payment.id, reason),
    onSuccess: (r) => {
      // A bank deposit already confirmed as this payment went back to the bank review queue
      // (services/paymentVoid.ts, 2026-10-09) — said here, where the void was pressed.
      setReopened(r.bankLinesReopened ?? 0);
      for (const key of ["bank-lines", "bank-confirmations"]) void queryClient.invalidateQueries({ queryKey: [key] });
      for (const key of MONEY_QUERY_KEYS) void queryClient.invalidateQueries({ queryKey: key });
      onVoided?.();
    },
  });

  if (payment.voidedAt) {
    return reopened > 0
      ? <span className="text-xs text-amber-800">{reopened} bank deposit line{reopened > 1 ? "s" : ""} that had been confirmed as this payment went back to the bank review queue — match {reopened > 1 ? "them" : "it"} to the replacement payment.</span>
      : null;
  }
  const isCard = payment.method === "stripe";

  const ask = () => {
    const reason = window.prompt(`Why is this $${payment.amount.toFixed(2)} ${payment.method} payment being voided? (required — it stays on the record)`);
    if (reason == null) return;
    if (!reason.trim()) { window.alert("A reason is required to void a payment."); return; }
    if (!window.confirm(`Void the $${payment.amount.toFixed(2)} ${payment.method} payment? It stays listed, struck through, and counts in no balance.\n\nReason: ${reason.trim()}`)) return;
    voidIt.mutate(reason.trim());
  };

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        className="btn btn-secondary px-2 py-0.5 text-xs min-h-0"
        disabled={isCard || voidIt.isPending}
        title={
          isCard
            ? "A card payment is refunded in Stripe, not voided here — issue the refund from the Stripe Dashboard and it is recorded on this row automatically."
            : "Void this payment with a reason — it stays on the record, struck through, and counts in no balance."
        }
        onClick={ask}
      >
        {voidIt.isPending ? "Voiding…" : "Void…"}
      </button>
      {voidIt.isError && <span className="text-xs text-red-700">{(voidIt.error as Error).message}</span>}
    </span>
  );
}

/** "Voided <date> — <reason>", shown beside a struck-through row. */
export function VoidedPaymentNote({ voidedAt, voidReason }: { voidedAt?: string | null; voidReason?: string | null }) {
  if (!voidedAt) return null;
  return (
    <span className="text-xs font-medium text-red-700">
      Voided {new Date(voidedAt).toLocaleDateString()}{voidReason ? ` — ${voidReason}` : ""}
    </span>
  );
}

/**
 * "Refunded $X on <date>" beside a card payment that was refunded in the Stripe Dashboard and
 * recorded here by the webhook (Kyle, 2026-10-09, ruling 7 of the one-estimating-system plan).
 * There is NO button: the refund is made in Stripe, and the row says so. A partial refund names
 * the part; a full one says "in full". Nothing is rendered on an unrefunded row.
 */
export function RefundedPaymentNote({ payment }: {
  payment: { amount: number; refundedAmount?: number; refundedAt?: string | null; refunds?: { stripeRefundId: string; reason: string | null; status: string }[] };
}) {
  const refunded = payment.refundedAmount ?? 0;
  if (!(refunded > 0)) return null;
  const inFull = refunded >= payment.amount - 0.005;
  const reasons = (payment.refunds ?? []).filter((r) => r.status === "succeeded" && r.reason).map((r) => r.reason!.replaceAll("_", " "));
  return (
    <span className="text-xs font-medium text-amber-800" title="The refund was made in the Stripe Dashboard and recorded here automatically from Stripe's refund event. To refund more, do it in Stripe — it will show here.">
      Refunded {money(refunded)}{inFull ? " in full" : ` of ${money(payment.amount)}`}
      {payment.refundedAt ? ` on ${new Date(payment.refundedAt).toLocaleDateString()}` : ""}
      {reasons.length > 0 ? ` — ${[...new Set(reasons)].join(", ")}` : ""}
      {" "}· made in Stripe, recorded here automatically
    </span>
  );
}
