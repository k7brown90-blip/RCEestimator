/**
 * The receipt drawer (2026-09-20). A receipt is proof, never money (Kyle, 2026-09-19): editing
 * anything here moves no cost figure. What the record can do — every one of these exists
 * today, spread over the review queue, the needs-a-P.O. queue, the account page's job card and
 * the job screen — now in one place: see the photo or PDF, fix the vendor / amount / category
 * / purchase date the reader got wrong, confirm it, re-parse a stuck one, put it on its P.O.
 * or take it off, waive a P.O. it can never have, clear a reconciliation flag, and remove it.
 */

import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api, fetchProtectedObjectUrl } from "../../lib/api";
import { useDrawerParams } from "../../lib/drawers";
import { useReceiptRecord } from "../../lib/recordQueries";
import type { ReceiptRecord } from "../../lib/types";
import { money, shortDate } from "../../lib/utils";
import { Drawer } from "../Drawer";
import { PhotoLightbox } from "../PhotoLightbox";
import { ProtectedImage } from "../ProtectedImage";
import { ReceiptPoPicker, ReparseReceiptButton, WaivePoAction, usePoRefresh } from "../PurchaseOrders";
import { OpenDrawerButton } from "./OpenDrawerButton";

const CATEGORIES = ["materials", "gas", "maintenance", "overhead", "permit", "inspection"] as const;

export function ReceiptDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const { data: r, isLoading, error } = useReceiptRecord(id);
  const refresh = usePoRefresh();
  const drawers = useDrawerParams();
  const [error2, setError2] = useState<string | null>(null);
  const onError = (err: unknown) => setError2((err as Error).message);
  const onDone = () => { setError2(null); refresh(); };

  const save = useMutation({
    mutationFn: (input: Parameters<typeof api.reviewReceipt>[1]) => api.reviewReceipt(id, input),
    onSuccess: onDone,
    onError,
  });
  const detach = useMutation({
    mutationFn: (poId: string) => api.detachReceiptFromPurchaseOrder(poId, id),
    onSuccess: onDone,
    onError,
  });
  const remove = useMutation({
    mutationFn: () => api.deleteReceipt(id),
    onSuccess: () => { onDone(); onClose(); },
    onError,
  });

  const pending = r?.status === "pending_review";

  return (
    <Drawer
      title={r ? r.vendor || "Unknown vendor" : "Receipt"}
      subtitle={r ? `${money(r.amount)} · ${r.category} · ${shortDate(r.receivedAt)} · from ${r.source.replaceAll("_", " ")}` : undefined}
      onClose={onClose}
      headerActions={r ? (
        pending
          ? <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-800">needs review</span>
          : <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[11px] font-medium text-emerald-800">confirmed</span>
      ) : null}
    >
      {error && <p className="text-sm text-red-600">Could not load this receipt: {(error as Error).message}</p>}
      {isLoading && <p className="text-sm text-rce-muted">Loading…</p>}
      {r && (
        <div className="space-y-4 pb-4 text-sm">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {r.accountId && <Link to={`/accounts/${r.accountId}`} className="btn btn-secondary px-2 py-0.5 text-xs min-h-0">{r.accountName ?? "Account"} →</Link>}
            {r.jobId
              ? <OpenDrawerButton kind="job" id={r.jobId} onOpen={drawers.open} label={`Job: ${r.jobLabel}`} />
              : <span className="text-rce-muted">{r.jobLabel}</span>}
          </div>

          {/* The P.O. it proves (Kyle, 2026-09-09: purchasing starts with a P.O.). */}
          <section className="rounded-lg border border-rce-border p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-rce-soft">Purchase order</p>
            {r.purchaseOrderId ? (
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <OpenDrawerButton kind="po" id={r.purchaseOrderId} onOpen={drawers.open} className="font-semibold tabular-nums hover:underline">
                  {r.purchaseOrderNumber}
                </OpenDrawerButton>
                {r.purchaseOrderStatus && <span className="text-xs text-rce-muted">{r.purchaseOrderStatus}</span>}
                <button
                  type="button"
                  className="btn btn-danger px-2 py-0.5 text-xs min-h-0"
                  disabled={detach.isPending}
                  onClick={() => { if (window.confirm(`Take this receipt off ${r.purchaseOrderNumber}?`)) detach.mutate(r.purchaseOrderId!); }}
                >
                  detach
                </button>
              </div>
            ) : r.poWaivedAt ? (
              <p className="mt-1 text-xs text-rce-muted">No P.O. — legacy, waived {shortDate(r.poWaivedAt)}{r.poWaivedReason ? `: ${r.poWaivedReason}` : ""}.</p>
            ) : r.category === "materials" ? (
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                <ReceiptPoPicker receiptId={r.id} jobId={r.jobId} />
                <WaivePoAction receiptId={r.id} />
              </div>
            ) : (
              <p className="mt-1 text-xs text-rce-muted">Not a materials receipt — no P.O. needed.</p>
            )}
          </section>

          <ReceiptProof receipt={r} />

          <ReceiptFields receipt={r} busy={save.isPending} onSave={(input) => save.mutate(input)} />

          {r.reconciliationNote && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
              <p className="font-semibold">The reader could not reconcile this receipt</p>
              <p className="mt-0.5">{r.reconciliationNote}</p>
              <button type="button" className="btn btn-secondary mt-2 px-2 py-0.5 text-xs min-h-0" disabled={save.isPending} onClick={() => save.mutate({ reconciliationNote: null })}>
                Checked by hand — clear the flag
              </button>
            </div>
          )}

          {r.lineItems.length > 0 && (
            <section>
              <p className="text-xs font-semibold uppercase tracking-wide text-rce-soft">Lines read ({r.lineItems.length})</p>
              <ul className="mt-1 space-y-0.5 text-xs text-rce-muted">
                {r.lineItems.map((l, i) => (
                  <li key={`${l.name ?? "line"}-${i}`}>
                    {l.qty ?? ""} {l.unit ?? ""} {l.name ?? "(unnamed)"}{l.unitCost != null ? ` · ${money(l.unitCost)}/ea` : ""}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <div className="flex flex-wrap items-center gap-2">
            {pending && (
              <button type="button" className="btn btn-primary text-sm" disabled={save.isPending || !(r.amount > 0)} title={r.amount > 0 ? "Confirm this receipt" : "Enter the receipt total first"} onClick={() => save.mutate({ status: "confirmed" })}>
                Confirm
              </button>
            )}
            {pending && <ReparseReceiptButton receiptId={r.id} />}
            <button
              type="button"
              className="btn btn-danger text-sm"
              disabled={remove.isPending}
              onClick={() => { if (window.confirm(`Remove this ${money(r.amount)} receipt? This cannot be undone.`)) remove.mutate(); }}
            >
              Remove receipt
            </button>
          </div>
          {error2 && <p className="text-xs text-red-600">{error2}</p>}
        </div>
      )}
    </Drawer>
  );
}

/** The photo or PDF behind the receipt — fetched through the session, never a token in a URL. */
function ReceiptProof({ receipt }: { receipt: ReceiptRecord }) {
  const [lightbox, setLightbox] = useState(false);
  const path = `/health-record-admin/receipts/${receipt.id}/image`;
  if (!receipt.hasImage) {
    return <p className="text-xs text-rce-muted">No photo or PDF on this receipt.</p>;
  }
  if ((receipt.imageMime ?? "").startsWith("image/")) {
    return (
      <div>
        <ProtectedImage path={path} alt={`Receipt from ${receipt.vendor ?? "unknown vendor"}`} className="max-h-64 rounded-lg border border-rce-border object-contain" linkToFullSize={false} onClick={() => setLightbox(true)} />
        {lightbox && (
          <PhotoLightbox path={path} alt={`Receipt from ${receipt.vendor ?? "unknown vendor"}`} caption={`${receipt.vendor ?? "Receipt"} · ${money(receipt.amount)}`} onClose={() => setLightbox(false)} />
        )}
      </div>
    );
  }
  return <ProtectedFrame path={path} title={`Receipt from ${receipt.vendor ?? "unknown vendor"}`} />;
}

function ProtectedFrame({ path, title }: { path: string; title: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let url: string | null = null;
    let gone = false;
    fetchProtectedObjectUrl(path)
      .then((next) => { if (gone) URL.revokeObjectURL(next); else { url = next; setSrc(next); } })
      .catch(() => setFailed(true));
    return () => { gone = true; if (url) URL.revokeObjectURL(url); };
  }, [path]);
  if (failed) return <p className="text-xs text-red-700">Could not load that receipt.</p>;
  if (!src) return <p className="text-xs text-rce-muted">Loading receipt…</p>;
  return <iframe src={src} title={title} className="h-80 w-full rounded-lg border border-rce-border bg-white" />;
}

/**
 * The editable fields. Seeded from the record once per fetch; Save sends only what changed, so a
 * date left alone is never re-anchored and a vendor left alone is never re-written.
 */
function ReceiptFields({ receipt, busy, onSave }: { receipt: ReceiptRecord; busy: boolean; onSave: (input: Parameters<typeof api.reviewReceipt>[1]) => void }) {
  const [vendor, setVendor] = useState(receipt.vendor ?? "");
  const [amount, setAmount] = useState(receipt.amount > 0 ? receipt.amount.toFixed(2) : "");
  const [category, setCategory] = useState(receipt.category);
  const [receivedAt, setReceivedAt] = useState(receipt.receivedAt.slice(0, 10));
  const parsed = Number(amount);
  const amountValid = amount.trim() !== "" && Number.isFinite(parsed) && parsed >= 0;
  const changed =
    vendor.trim() !== (receipt.vendor ?? "") ||
    (amountValid && Math.round(parsed * 100) / 100 !== receipt.amount) ||
    category !== receipt.category ||
    receivedAt !== receipt.receivedAt.slice(0, 10);

  const submit = () => {
    const input: Parameters<typeof api.reviewReceipt>[1] = {};
    if (vendor.trim() !== (receipt.vendor ?? "")) input.vendor = vendor.trim() || null;
    if (amountValid && Math.round(parsed * 100) / 100 !== receipt.amount) input.amount = Math.round(parsed * 100) / 100;
    if (category !== receipt.category) input.category = category;
    if (receivedAt && receivedAt !== receipt.receivedAt.slice(0, 10)) input.receivedAt = receivedAt;
    onSave(input);
  };

  return (
    <section className="rounded-lg border border-rce-border p-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-rce-soft">What the receipt says</p>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <label className="text-xs text-rce-soft">
          Vendor
          <input className="field mt-1" value={vendor} onChange={(e) => setVendor(e.target.value)} placeholder="Vendor" />
        </label>
        <label className="text-xs text-rce-soft">
          Total
          <input className="field mt-1 text-right tabular-nums" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
        </label>
        <label className="text-xs text-rce-soft">
          Category
          <select className="field mt-1" value={category} onChange={(e) => setCategory(e.target.value)}>
            {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <label className="text-xs text-rce-soft">
          Purchase date
          <input className="field mt-1" type="date" value={receivedAt} onChange={(e) => setReceivedAt(e.target.value)} title="The receipt's actual purchase date — the P&L month" />
        </label>
      </div>
      <div className="mt-2 flex justify-end">
        <button type="button" className="btn btn-primary px-3 py-1 text-xs min-h-0" disabled={busy || !changed || !amountValid} onClick={submit}>
          {busy ? "Saving…" : "Save changes"}
        </button>
      </div>
    </section>
  );
}
