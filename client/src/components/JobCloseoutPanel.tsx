/**
 * Job close-out — purchase orders, receipts, and Mark complete. (Kyle,
 * 2026-08-25: "There is no way to log this job as complete or track material
 * spent… Creating a P.O. is now necessary and should be on this screen. Part
 * Orders will track actual job spending and I will upload receipts.")
 *
 * NO GATE on completion — his ruling: "We do not want to lock ourselves out of
 * closing a job, some might be labor only." The button always works; what's
 * missing (unreceipted POs, no invoice sent) comes back as warnings and is
 * shown, not enforced. completedAt is the labor timestamp; clock in/out is a
 * later phase.
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";

export function JobCloseoutPanel({ visitId, status }: { visitId: string; status: string }) {
  const queryClient = useQueryClient();
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const { data: orders } = useQuery({
    queryKey: ["jobPOs", visitId],
    queryFn: () => api.jobPurchaseOrders(visitId),
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["jobPOs", visitId] });
    void queryClient.invalidateQueries({ queryKey: ["visit", visitId] });
    void queryClient.invalidateQueries({ queryKey: ["jobs"] });
  };

  const complete = useMutation({
    mutationFn: () => api.completeJob(visitId),
    onSuccess: (r) => { setWarnings(r.warnings); setError(null); refresh(); },
    onError: (err) => setError((err as Error).message),
  });
  const reopen = useMutation({
    mutationFn: () => api.reopenJob(visitId),
    onSuccess: () => { setWarnings([]); setError(null); refresh(); },
    onError: (err) => setError((err as Error).message),
  });

  // ── PO form ──
  const [showPoForm, setShowPoForm] = useState(false);
  const [supplier, setSupplier] = useState("");
  const [itemsText, setItemsText] = useState("");
  const createPo = useMutation({
    mutationFn: () => {
      const items = itemsText
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          // "3 x 12-2 Romex 250ft" or just "12-2 Romex" (qty 1)
          const m = line.match(/^(\d+(?:\.\d+)?)\s*[x×]\s*(.+)$/i);
          return m ? { name: m[2].trim(), qty: Number(m[1]) } : { name: line, qty: 1 };
        });
      return api.createPurchaseOrder(visitId, { supplier: supplier.trim(), items });
    },
    onSuccess: () => { setSupplier(""); setItemsText(""); setShowPoForm(false); refresh(); },
    onError: (err) => setError((err as Error).message),
  });

  // ── Receipt form ──
  const [showReceiptForm, setShowReceiptForm] = useState(false);
  const [receiptAmount, setReceiptAmount] = useState("");
  const [receiptVendor, setReceiptVendor] = useState("");
  const [receiptCategory, setReceiptCategory] = useState("materials");
  const [receiptImage, setReceiptImage] = useState<File | null>(null);
  const uploadReceipt = useMutation({
    mutationFn: () =>
      api.uploadJobReceipt(visitId, {
        amount: Number(receiptAmount),
        vendor: receiptVendor.trim() || undefined,
        category: receiptCategory,
        image: receiptImage,
      }),
    onSuccess: () => {
      setReceiptAmount(""); setReceiptVendor(""); setReceiptImage(null); setShowReceiptForm(false);
      setError(null); refresh();
    },
    onError: (err) => setError((err as Error).message),
  });

  const isCompleted = status === "completed";

  return (
    <article className="card rounded-2xl border border-rce-border/70 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Job close-out</h2>
        {isCompleted ? (
          <button className="btn btn-secondary text-xs" disabled={reopen.isPending} onClick={() => reopen.mutate()}>
            Reopen job
          </button>
        ) : (
          <button className="btn btn-primary" disabled={complete.isPending} onClick={() => complete.mutate()}>
            {complete.isPending ? "Completing…" : "Mark job complete"}
          </button>
        )}
      </div>

      {isCompleted && (
        <p className="mt-2 rounded bg-emerald-50 p-2 text-sm text-emerald-800">
          Completed — this job lives in the Completed section on the Jobs page, filed under the account.
        </p>
      )}
      {warnings.map((w) => (
        <p key={w} className="mt-2 rounded bg-amber-50 p-2 text-xs text-amber-900">⚠ {w}</p>
      ))}
      {error && <p className="mt-2 rounded bg-red-50 p-2 text-xs text-red-900">{error}</p>}

      {/* ── Purchase orders ── */}
      <div className="mt-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-rce-soft">Purchase orders</h3>
          <button className="btn btn-secondary text-xs" onClick={() => setShowPoForm((s) => !s)}>
            {showPoForm ? "Cancel" : "+ New P.O."}
          </button>
        </div>
        {showPoForm && (
          <div className="mt-2 space-y-2 rounded-lg border border-rce-border p-3">
            <input
              className="field w-full"
              placeholder="Supplier (Home Depot, ASD, …)"
              value={supplier}
              onChange={(e) => setSupplier(e.target.value)}
            />
            <textarea
              className="field w-full"
              rows={4}
              placeholder={"One item per line. Quantity first:\n3 x 12-2 Romex 250ft\n1 x 200A panel"}
              value={itemsText}
              onChange={(e) => setItemsText(e.target.value)}
            />
            <button
              className="btn btn-primary text-sm"
              disabled={!supplier.trim() || !itemsText.trim() || createPo.isPending}
              onClick={() => createPo.mutate()}
            >
              {createPo.isPending ? "Creating…" : "Create P.O."}
            </button>
          </div>
        )}
        {(orders ?? []).length === 0 && !showPoForm && (
          <p className="mt-1 text-xs text-rce-muted">No purchase orders on this job yet.</p>
        )}
        <ul className="mt-2 space-y-1">
          {(orders ?? []).map((po) => (
            <li key={po.id} className="rounded-lg border border-rce-border p-2 text-sm">
              <div className="flex items-center justify-between">
                <span className="font-medium">{po.supplier}</span>
                <span className="flex items-center gap-2 text-xs text-rce-muted">
                  {po.items.length} item(s) · {new Date(po.createdAt).toLocaleDateString()}
                  <button
                    className="text-red-600 underline"
                    onClick={() => { void api.deletePurchaseOrder(visitId, po.id).then(refresh); }}
                  >
                    delete
                  </button>
                </span>
              </div>
              <p className="mt-0.5 text-xs text-rce-soft">
                {po.items.map((i) => `${i.qty}× ${i.name}`).join(" · ")}
              </p>
            </li>
          ))}
        </ul>
      </div>

      {/* ── Receipts ── */}
      <div className="mt-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-rce-soft">Receipts</h3>
          <button className="btn btn-secondary text-xs" onClick={() => setShowReceiptForm((s) => !s)}>
            {showReceiptForm ? "Cancel" : "+ Add receipt"}
          </button>
        </div>
        <p className="text-xs text-rce-muted">
          Actual job spend — feeds the account's job costs, the Financials reports, and (later) the
          price book. Techs can also send receipts from the field app.
        </p>
        {showReceiptForm && (
          <div className="mt-2 space-y-2 rounded-lg border border-rce-border p-3">
            <div className="flex flex-wrap gap-2">
              <input
                className="field w-28"
                type="number"
                step="0.01"
                placeholder="Amount $"
                value={receiptAmount}
                onChange={(e) => setReceiptAmount(e.target.value)}
              />
              <input
                className="field flex-1"
                placeholder="Vendor"
                value={receiptVendor}
                onChange={(e) => setReceiptVendor(e.target.value)}
              />
              <select className="field" value={receiptCategory} onChange={(e) => setReceiptCategory(e.target.value)}>
                <option value="materials">Materials</option>
                <option value="gas">Gas</option>
                <option value="maintenance">Maintenance</option>
                <option value="overhead">Overhead</option>
              </select>
            </div>
            <input
              type="file"
              accept="image/*"
              className="text-xs"
              onChange={(e) => setReceiptImage(e.target.files?.[0] ?? null)}
            />
            <button
              className="btn btn-primary text-sm"
              disabled={!(Number(receiptAmount) > 0) || uploadReceipt.isPending}
              onClick={() => uploadReceipt.mutate()}
            >
              {uploadReceipt.isPending ? "Saving…" : "Save receipt"}
            </button>
          </div>
        )}
      </div>
    </article>
  );
}
