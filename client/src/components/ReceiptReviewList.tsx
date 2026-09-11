import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { money, shortDate } from "../lib/utils";
import { CollapsibleCard } from "./CollapsibleCard";

/**
 * Receipts waiting for review, in one place (Kyle, 2026-09-08: "It is not
 * clear where to confirm field inputs"). Field-app captures land here with
 * whatever the vision read produced; the vendor and amount are editable, and
 * Confirm saves both and counts the receipt toward its job's material.
 * Rendered at the top of the account page (that account's jobs) and at the
 * top of Financials (every account).
 */
export type ReviewableReceipt = {
  id: string;
  vendor: string | null;
  amount: number;
  category: string;
  receivedAt: string;
  /** "Panel Upgrade — 12 Oak St, Franklin" or similar. */
  jobLabel: string;
  /** When set, the row links to the account. */
  accountId?: string;
  accountName?: string;
  /** The PO this receipt verifies (Kyle, 2026-09-09); needsPo flags a materials receipt without one. */
  purchaseOrderNumber?: string | null;
  needsPo?: boolean;
  /** Kyle, 2026-09-09: "card proves" — this receipt is paired with a card transaction. */
  cardMatched?: boolean;
};

export function PendingReceiptFields({
  receipt,
  busy,
  onConfirm,
}: {
  receipt: { amount: number; vendor: string | null };
  busy: boolean;
  onConfirm: (input: { amount: number; vendor: string | null }) => void;
}) {
  const [amount, setAmount] = useState(receipt.amount > 0 ? receipt.amount.toFixed(2) : "");
  const [vendor, setVendor] = useState(receipt.vendor ?? "");
  const parsed = Number(amount);
  const valid = amount.trim() !== "" && Number.isFinite(parsed) && parsed > 0;
  return (
    <span className="flex flex-wrap items-center gap-1">
      <input
        className="field w-32 max-w-full px-1 py-0.5 text-xs"
        placeholder="Vendor"
        value={vendor}
        onChange={(e) => setVendor(e.target.value)}
      />
      <input
        className="field w-24 px-1 py-0.5 text-right text-xs tabular-nums"
        inputMode="decimal"
        placeholder="0.00"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
      />
      <button
        type="button"
        className="btn btn-primary px-2 py-0.5 text-xs"
        disabled={busy || !valid}
        title={valid ? "Confirm and count this receipt" : "Enter the receipt total first"}
        onClick={() => onConfirm({ amount: Math.round(parsed * 100) / 100, vendor: vendor.trim() || null })}
      >
        Confirm
      </button>
    </span>
  );
}

/**
 * `collapsible` (Financials, Kyle 2026-09-10) folds the list into a CollapsibleCard — open
 * whenever there are rows, and still gone entirely when there are none. The account page
 * keeps the plain amber card.
 */
export function ReceiptReviewList({ rows, title = "Receipts to review", collapsible = false }: { rows: ReviewableReceipt[]; title?: string; collapsible?: boolean }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const review = useMutation({
    mutationFn: ({ id, ...input }: { id: string; amount: number; vendor: string | null }) =>
      api.reviewReceipt(id, { status: "confirmed", ...input }),
    onSuccess: () => { setError(null); void queryClient.invalidateQueries(); },
    onError: (err) => setError((err as Error).message),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteReceipt(id),
    onSuccess: () => { setError(null); void queryClient.invalidateQueries(); },
    onError: (err) => setError((err as Error).message),
  });

  if (rows.length === 0) return null;

  const body = (
    <>
      <p className="mb-2 text-xs text-amber-800">
        Field captures wait here and are not counted in any job's material until confirmed. Fix the vendor or
        total if the photo was read wrong, then Confirm. Remove a duplicate.
      </p>
      <ul className="space-y-2">
        {rows.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded border border-amber-200 bg-white px-3 py-2 text-sm">
            <span className="min-w-0">
              <span className="font-medium">{r.vendor || "Unknown vendor"}</span>
              <span className="text-rce-muted"> · {r.category} · read as {money(r.amount)} · {shortDate(r.receivedAt)}</span>
              {r.purchaseOrderNumber && <span className="ml-1 rounded bg-slate-100 px-1 text-xs tabular-nums text-slate-700">{r.purchaseOrderNumber}</span>}
              {r.needsPo && <span className="ml-1 rounded bg-amber-100 px-1 text-xs text-amber-800">needs PO</span>}
              {r.cardMatched && <span className="ml-1 rounded bg-sky-100 px-1 text-xs text-sky-800">card</span>}
              <span className="block text-xs text-rce-muted">
                {r.accountId ? (
                  <Link to={`/accounts/${r.accountId}`} className="text-rce-accent hover:underline">{r.accountName}</Link>
                ) : null}
                {r.accountId ? " · " : ""}
                {r.jobLabel}
              </span>
            </span>
            <span className="flex flex-wrap items-center gap-2">
              <PendingReceiptFields
                receipt={r}
                busy={review.isPending}
                onConfirm={(input) => review.mutate({ id: r.id, ...input })}
              />
              <button
                type="button"
                className="text-xs text-red-600 hover:underline"
                disabled={remove.isPending}
                onClick={() => {
                  if (window.confirm(`Remove this ${money(r.amount)} receipt?`)) remove.mutate(r.id);
                }}
              >
                Remove
              </button>
            </span>
          </li>
        ))}
      </ul>
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </>
  );

  if (collapsible) {
    return (
      <CollapsibleCard
        id="receipts-review"
        title={<span className="text-amber-900">{title}</span>}
        summary={<span className="font-medium text-amber-800">{rows.length} waiting</span>}
        defaultOpen
        className="border-amber-300 bg-amber-50/60"
      >
        {body}
      </CollapsibleCard>
    );
  }

  return (
    <section className="card mb-5 border-amber-300 bg-amber-50/60 p-4">
      <h2 className="text-base font-semibold text-amber-900">
        {title} ({rows.length})
      </h2>
      {body}
    </section>
  );
}
