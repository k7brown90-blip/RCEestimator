/**
 * Landing a PO (Kyle, 2026-09-09, Build 3).
 *
 * A purchased PO's material lands on its truck or in the warehouse; a tool PO
 * lands on the tool register. Each line shows the expected quantity, an
 * editable quantity landed (default expected) and an editable unit cost
 * (default from /purchase-orders/:id/landing). Landing closes the PO. Shared
 * by the Inventory page and the Purchases card.
 *
 * SUPERSEDED 2026-09-23 (Kyle correcting the 2026-09-11 design): "Stripe is
 * the source of truth… The receipt is just proof of purchase… Perfectly
 * balancing the receipt to the job purchase is always going to fail." Landing
 * is inventory, not money — it is never held for failing to match the
 * receipt's total, and there is no "Land anyway" override anymore because
 * there is nothing left to override. The receipt total still shows as
 * context. What matters now is an UNPRICED line (source "none") — a human has
 * to type a cost before that line means anything, and the row is styled to
 * make that unmissable. A PO with no receipt gets the upload right here; a PO
 * with no lines gets the receipt's own lines in one click.
 */

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { LandingDefaults } from "../lib/types";
import { money } from "../lib/utils";

const COST_SOURCE_LABEL: Record<LandingDefaults["lines"][number]["costSource"], string> = {
  "receipt-line": "from receipt line",
  "po-line": "typed on PO",
  book: "book price",
  none: "no cost — type one",
};
const GUESS_SOURCES = new Set<LandingDefaults["lines"][number]["costSource"]>(["book", "none"]);
/** Kyle, 2026-09-23: an unpriced line has to be unmissable — a human types the cost or it poisons the item's moving average. */
const UNPRICED_SOURCES = new Set<LandingDefaults["lines"][number]["costSource"]>(["none"]);

type Row = { lineId: string; qty: string; cost: string };

/**
 * Delete a landing-table line (Kyle, 2026-09-14 debug console report): "There
 * needs to always be a way to delete information added… Now I will have to
 * mark it as $0.00 or a duplicate because I cannot delete it." The delete
 * already existed in Financials → Purchases (`PoLineRow`'s remove-with-reason
 * control below); this is the same interaction shape, just reachable from the
 * landing screen where the line was actually added.
 */
function LandingLineRemove({ poId, lineId, disabled, onRemoved }: { poId: string; lineId: string; disabled: boolean; onRemoved: () => void }) {
  const [removing, setRemoving] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const remove = useMutation({
    mutationFn: () => api.removePurchaseOrderLine(poId, lineId, reason.trim()),
    onSuccess: () => { setError(null); setRemoving(false); setReason(""); onRemoved(); },
    onError: (err) => setError((err as Error).message),
  });
  if (!removing) {
    return (
      <button
        type="button"
        className="btn btn-danger px-2 py-0.5 text-xs min-h-0 disabled:cursor-not-allowed disabled:opacity-50"
        disabled={disabled}
        onClick={() => setRemoving(true)}
      >
        remove
      </button>
    );
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <input className="field w-36 px-1 py-0.5 text-xs" placeholder="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} />
      <button type="button" className="btn btn-primary px-1.5 py-0 text-[11px]" disabled={disabled || !reason.trim() || remove.isPending} onClick={() => remove.mutate()}>
        Remove
      </button>
      <button type="button" className="btn btn-secondary px-2 py-0.5 text-xs min-h-0" onClick={() => { setRemoving(false); setReason(""); setError(null); }}>cancel</button>
      {error && <span className="w-full text-red-600">{error}</span>}
    </span>
  );
}

export function LandingPanel({ poId, onLanded }: { poId: string; onLanded?: () => void }) {
  const queryClient = useQueryClient();
  const { data, isLoading, error: loadError } = useQuery({ queryKey: ["purchase-order-landing", poId], queryFn: () => api.landingDefaults(poId) });
  const [rows, setRows] = useState<Row[]>([]);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    // A refetch (after adding a line from the receipt) keeps what Kyle already typed on the lines he had.
    if (data) setRows((prev) => data.lines.map((l) => prev.find((r) => r.lineId === l.lineId) ?? { lineId: l.lineId, qty: String(l.qtyLandedDefault), cost: String(l.unitCostDefault) }));
  }, [data]);

  const refreshLanding = () => {
    for (const key of [["purchase-order-landing"], ["purchase-order"], ["purchase-orders"], ["receipts-needing-po"], ["inventory"]]) {
      void queryClient.invalidateQueries({ queryKey: key });
    }
  };

  const addLine = useMutation({
    mutationFn: (rl: { name: string; qty: number; unit: string | null; unitCost: number | null }) =>
      api.addPurchaseOrderLine(poId, { name: rl.name, qty: rl.qty, unit: rl.unit, unitCost: rl.unitCost, reason: "added from the receipt at landing" }),
    onSuccess: () => { setError(null); refreshLanding(); },
    onError: (err) => setError((err as Error).message),
  });

  /** One click: every line the receipt printed becomes a PO line (Kyle, 2026-09-11). */
  const addSuggested = useMutation({
    mutationFn: async () => {
      for (const s of data?.suggestedLines ?? []) {
        await api.addPurchaseOrderLine(poId, { name: s.name, qty: s.qty, unit: s.unit, unitCost: s.unitCost, reason: "added from the receipt at landing" });
      }
    },
    onSuccess: () => { setError(null); refreshLanding(); },
    onError: (err) => setError((err as Error).message),
  });

  /** The photo itself — a phone opens the camera, a computer opens the file picker. */
  const upload = useMutation({
    mutationFn: (file: File) => api.uploadPoReceipt(poId, { image: file }),
    onSuccess: (res) => {
      setError(null);
      setNote(res.note ?? `Receipt read: ${money(res.amount)}${res.lineCount > 0 ? ` · ${res.lineCount} line${res.lineCount === 1 ? "" : "s"}` : " · no lines read"}`);
      refreshLanding();
    },
    onError: (err) => setError((err as Error).message),
  });

  const land = useMutation({
    mutationFn: () => api.landPurchaseOrder(poId, {
      lines: rows.map((r) => ({ lineId: r.lineId, qtyLanded: Number(r.qty), unitCost: Number(r.cost) })),
      reason: reason.trim() || null,
    }),
    onSuccess: () => {
      setError(null);
      for (const key of [["inventory"], ["purchase-orders"], ["purchase-order"], ["purchase-order-landing"], ["tools"], ["trucks"], ["truck"]]) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
      onLanded?.();
    },
    onError: (err) => setError((err as Error).message),
  });

  if (isLoading) return <p className="text-xs text-rce-muted">Loading…</p>;
  if (loadError || !data) return <p className="text-xs text-red-600">{(loadError as Error | null)?.message ?? "Could not load the landing defaults."}</p>;

  const valid = rows.length > 0 && rows.every((r) => Number.isFinite(Number(r.qty)) && Number(r.qty) >= 0 && Number.isFinite(Number(r.cost)) && Number(r.cost) >= 0);
  const total = rows.reduce((s, r) => s + (Number(r.qty) || 0) * (Number(r.cost) || 0), 0);
  const isTool = data.purchaseOrder.purpose === "tool";
  const landed = Boolean(data.purchaseOrder.landedAt);
  // Display only (Kyle, 2026-09-23) — a receipt legitimately carries items never on this P.O., so this often reads false and never gates landing.
  const inBalance = data.receiptTotal <= 0 || Math.abs(total - data.receiptTotal) <= 0.01;

  return (
    <div className="space-y-2 text-xs">
      <p className="text-rce-muted">
        Lands {isTool ? "on the tool register at" : "in"} <span className="font-medium text-rce-text">{data.destinationLabel}</span>
        {data.receiptCount > 0 ? ` · receipt${data.receiptCount === 1 ? "" : "s"} ${money(data.receiptTotal)}` : " · no receipt attached"}
        {isTool ? " · one tool row per unit landed" : ""}
      </p>
      {data.blocker && <p className="rounded bg-amber-50 px-2 py-1 text-amber-800">{data.blocker}</p>}

      {/* Kyle, 2026-09-11: "a way to attach a photo of the receipt if one is missing" — an upload, not a picker. */}
      <div className={data.receiptCount === 0 ? "rounded border border-amber-300 bg-amber-50 px-2 py-1.5" : ""}>
        {data.receiptCount === 0 && <p className="mb-1 text-amber-800">No receipt on this PO. The receipt total is what the lines land at — add the photo.</p>}
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) upload.mutate(f); e.target.value = ""; }}
        />
        <button
          type="button"
          className={`btn px-2 py-0.5 text-xs ${data.receiptCount === 0 ? "btn-primary" : "btn-secondary"}`}
          disabled={upload.isPending || landed}
          onClick={() => fileRef.current?.click()}
        >
          {upload.isPending ? "Reading the photo…" : data.receiptCount === 0 ? "Upload receipt photo" : "Upload another receipt photo"}
        </button>
        {note && <span className="ml-2 text-rce-muted">{note}</span>}
      </div>

      {data.lines.length === 0 && (
        <div className="rounded border border-rce-border px-2 py-1.5">
          <p className="text-rce-muted">This PO has no lines, so there is nothing to land.</p>
          {data.suggestedLines.length > 0 && (
            <button type="button" className="btn btn-primary mt-1 px-2 py-0.5 text-xs" disabled={addSuggested.isPending || landed} onClick={() => addSuggested.mutate()}>
              {addSuggested.isPending ? "Adding…" : `Add the receipt's lines (${data.suggestedLines.length})`}
            </button>
          )}
        </div>
      )}
      <div className="overflow-x-auto">
      <table className="w-full">
        <thead className="text-left text-[11px] uppercase tracking-wide text-rce-soft">
          <tr><th className="pr-2">Item</th><th className="pr-2 text-right">Expected</th><th className="pr-2">Landed</th><th className="pr-2">Unit cost</th><th className="pr-2 text-right">Line</th><th /></tr>
        </thead>
        <tbody>
          {data.lines.map((l, i) => {
            const row = rows[i];
            if (!row) return null;
            const unpriced = UNPRICED_SOURCES.has(l.costSource) && Number(row.cost) === 0;
            return (
              <tr key={l.lineId} className={`border-t border-rce-border/60 ${unpriced ? "bg-red-50" : ""}`}>
                <td className="py-0.5 pr-2">{l.name}{l.itemId ? <span className="text-rce-muted"> · {l.itemId}</span> : null}</td>
                <td className="py-0.5 pr-2 text-right tabular-nums">{l.qtyExpected} {l.unit ?? ""}</td>
                <td className="py-0.5 pr-2">
                  <input className="field w-20 px-1 py-0.5 text-xs" inputMode="decimal" value={row.qty} onChange={(e) => setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, qty: e.target.value } : r)))} />
                </td>
                <td className="py-0.5 pr-2">
                  <input
                    className={`field w-24 px-1 py-0.5 text-xs ${unpriced ? "border-red-500" : ""}`}
                    inputMode="decimal"
                    value={row.cost}
                    onChange={(e) => setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, cost: e.target.value } : r)))}
                  />
                  <span
                    className={`ml-1 text-[10px] ${unpriced ? "font-semibold text-red-700" : GUESS_SOURCES.has(l.costSource) ? "text-amber-800" : "text-rce-muted"}`}
                    title={l.matchedReceiptLines.length > 0 ? `receipt: ${l.matchedReceiptLines.map((rl) => `${rl.name} × ${rl.qty}`).join(", ")} · ${l.weightBasis}` : l.weightBasis}
                  >
                    {COST_SOURCE_LABEL[l.costSource]}
                    {/* Kyle, 2026-09-11: the tax rides in the price, so the line says so. */}
                    {l.taxShare > 0 ? ` · incl. tax ${money(l.taxShare)}` : ""}
                    {l.costSource !== "receipt-line" && l.matchedReceiptLine ? " · receipt line has no price" : ""}
                  </span>
                </td>
                <td className="py-0.5 pr-2 text-right tabular-nums">{money((Number(row.qty) || 0) * (Number(row.cost) || 0))}</td>
                <td className="py-0.5 text-right">
                  <LandingLineRemove poId={poId} lineId={l.lineId} disabled={landed} onRemoved={refreshLanding} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>
      {data.receiptLines.length > 0 && (
        <div className="space-y-1 border-t border-rce-border/60 pt-2">
          <p className="text-[11px] uppercase tracking-wide text-rce-soft">Receipt lines</p>
          {data.receiptLines.map((r) => (
            <div key={r.receiptId}>
              <p className="text-rce-muted">{r.vendor ?? "receipt"} · {money(r.amount)}{r.parseError ? ` · ${r.parseError}` : r.lines.length === 0 ? " · no parsed lines" : ""}</p>
              {r.lines.map((rl) => (
                <p key={`${r.receiptId}-${rl.index}`} className="flex flex-wrap items-center gap-x-2 pl-2 tabular-nums">
                  <span>{rl.name}</span>
                  <span className="text-rce-muted">× {rl.qty} {rl.unit ?? ""}</span>
                  <span className="text-rce-muted">{rl.unitCost != null ? `@ ${money(rl.unitCost)}` : "no price"}</span>
                  {rl.matchedLineId ? (
                    <span className="text-rce-muted">→ {data.lines.find((l) => l.lineId === rl.matchedLineId)?.name ?? "PO line"}</span>
                  ) : (
                    <>
                      <span className="text-amber-800">not on this PO — add as a line?</span>
                      <button type="button" className="btn px-1.5 py-0 text-[11px]" disabled={addLine.isPending || Boolean(data.purchaseOrder.landedAt)} onClick={() => addLine.mutate(rl)}>Add</button>
                    </>
                  )}
                </p>
              ))}
            </div>
          ))}
          {data.taxTotal > 0 && (
            <p className="text-rce-muted">{money(data.taxTotal)} of the receipt is past its printed lines (sales tax) — spread across the lines, so each unit cost is what was paid.</p>
          )}
        </div>
      )}
      {/* Kyle, 2026-09-23: the receipt total is context, not a gate — a receipt legitimately
          carries items never on this P.O., so this will often read off and that is fine. */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className={`tabular-nums font-medium ${data.receiptTotal <= 0 ? "text-rce-muted" : inBalance ? "text-emerald-700" : "text-rce-muted"}`}>
          Landing total {money(total)}
          {data.receiptTotal > 0 ? ` of receipt ${money(data.receiptTotal)}` : " · no receipt to check against"}
          {data.receiptTotal > 0 && !inBalance ? ` · off by ${money(Math.abs(total - data.receiptTotal))}` : ""}
        </span>
        <span className="inline-flex flex-wrap items-center gap-1">
          <input className="field w-48 max-w-full px-1 py-0.5 text-xs" placeholder="Note (optional)" value={reason} onChange={(e) => setReason(e.target.value)} />
          <button
            type="button"
            className="btn btn-primary px-2 py-0.5 text-xs"
            disabled={!valid || Boolean(data.blocker) || land.isPending}
            onClick={() => land.mutate()}
          >
            {land.isPending ? "Landing…" : "Land"}
          </button>
        </span>
      </div>
      {error && <p className="text-red-600">{error}</p>}
    </div>
  );
}
