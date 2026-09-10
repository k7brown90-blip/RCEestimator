/**
 * Landing a PO (Kyle, 2026-09-09, Build 3).
 *
 * A purchased PO's material lands on its truck or in the warehouse; a tool PO
 * lands on the tool register. Each line shows the expected quantity, an
 * editable quantity landed (default expected) and an editable unit cost
 * (default from /purchase-orders/:id/landing). Landing closes the PO. Shared
 * by the Inventory page and the Purchases card.
 *
 * Kyle, 2026-09-10: "The pricing on the P.O.'s does not seem to be applied
 * correctly from the receipts … they are not the same price." Each line's
 * default is the price printed beside it on the receipt, and the source label
 * says which lines are guesses (prorated, book). The receipt's own lines show
 * under the PO lines; one that is not on the PO can be added as a line so it
 * lands at the receipt's price.
 */

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { LandingDefaults } from "../lib/types";
import { money } from "../lib/utils";

const COST_SOURCE_LABEL: Record<LandingDefaults["lines"][number]["costSource"], string> = {
  "receipt-line": "from receipt line",
  "po-line": "typed on PO",
  "receipt-prorated": "prorated",
  book: "book price",
  none: "no default",
};
const GUESS_SOURCES = new Set<LandingDefaults["lines"][number]["costSource"]>(["receipt-prorated", "book", "none"]);

type Row = { lineId: string; qty: string; cost: string };

export function LandingPanel({ poId, onLanded }: { poId: string; onLanded?: () => void }) {
  const queryClient = useQueryClient();
  const { data, isLoading, error: loadError } = useQuery({ queryKey: ["purchase-order-landing", poId], queryFn: () => api.landingDefaults(poId) });
  const [rows, setRows] = useState<Row[]>([]);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    // A refetch (after adding a line from the receipt) keeps what Kyle already typed on the lines he had.
    if (data) setRows((prev) => data.lines.map((l) => prev.find((r) => r.lineId === l.lineId) ?? { lineId: l.lineId, qty: String(l.qtyLandedDefault), cost: String(l.unitCostDefault) }));
  }, [data]);

  const addLine = useMutation({
    mutationFn: (rl: LandingDefaults["receiptLines"][number]["lines"][number]) =>
      api.addPurchaseOrderLine(poId, { name: rl.name, qty: rl.qty, unit: rl.unit, unitCost: rl.unitCost, reason: "added from the receipt at landing" }),
    onSuccess: () => {
      setError(null);
      for (const key of [["purchase-order-landing"], ["purchase-order"], ["purchase-orders"]]) void queryClient.invalidateQueries({ queryKey: key });
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

  return (
    <div className="space-y-2 text-xs">
      <p className="text-rce-muted">
        Lands {isTool ? "on the tool register at" : "in"} <span className="font-medium text-rce-text">{data.destinationLabel}</span>
        {data.receiptCount > 0 ? ` · receipt${data.receiptCount === 1 ? "" : "s"} ${money(data.receiptTotal)}` : " · no receipt attached"}
        {isTool ? " · one tool row per unit landed" : ""}
      </p>
      {data.blocker && <p className="rounded bg-amber-50 px-2 py-1 text-amber-800">{data.blocker}</p>}
      {data.lines.length === 0 && <p className="text-rce-muted">This PO has no lines — add them on the Purchases card, then land it.</p>}
      <div className="overflow-x-auto">
      <table className="w-full">
        <thead className="text-left text-[11px] uppercase tracking-wide text-rce-soft">
          <tr><th className="pr-2">Item</th><th className="pr-2 text-right">Expected</th><th className="pr-2">Landed</th><th className="pr-2">Unit cost</th><th className="text-right">Line</th></tr>
        </thead>
        <tbody>
          {data.lines.map((l, i) => {
            const row = rows[i];
            if (!row) return null;
            return (
              <tr key={l.lineId} className="border-t border-rce-border/60">
                <td className="py-0.5 pr-2">{l.name}{l.itemId ? <span className="text-rce-muted"> · {l.itemId}</span> : null}</td>
                <td className="py-0.5 pr-2 text-right tabular-nums">{l.qtyExpected} {l.unit ?? ""}</td>
                <td className="py-0.5 pr-2">
                  <input className="field w-20 px-1 py-0.5 text-xs" inputMode="decimal" value={row.qty} onChange={(e) => setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, qty: e.target.value } : r)))} />
                </td>
                <td className="py-0.5 pr-2">
                  <input className="field w-24 px-1 py-0.5 text-xs" inputMode="decimal" value={row.cost} onChange={(e) => setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, cost: e.target.value } : r)))} />
                  <span className={`ml-1 text-[10px] ${GUESS_SOURCES.has(l.costSource) ? "text-amber-800" : "text-rce-muted"}`} title={l.matchedReceiptLine ? `receipt: ${l.matchedReceiptLine.name} × ${l.matchedReceiptLine.qty}` : undefined}>
                    {COST_SOURCE_LABEL[l.costSource]}
                    {l.costSource !== "receipt-line" && l.matchedReceiptLine ? " · receipt line has no price" : ""}
                  </span>
                </td>
                <td className="py-0.5 text-right tabular-nums">{money((Number(row.qty) || 0) * (Number(row.cost) || 0))}</td>
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
          {data.remainder > 0 && data.lines.some((l) => l.costSource === "receipt-prorated") && (
            <p className="text-rce-muted">{money(data.remainder)} of the receipt is not on a priced line — spread over the prorated lines.</p>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="tabular-nums">Landing total {money(total)}{data.receiptTotal > 0 && Math.abs(total - data.receiptTotal) > 0.01 ? <span className="text-amber-800"> · receipt {money(data.receiptTotal)}</span> : null}</span>
        <span className="inline-flex flex-wrap items-center gap-1">
          <input className="field w-48 max-w-full px-1 py-0.5 text-xs" placeholder="Note (optional)" value={reason} onChange={(e) => setReason(e.target.value)} />
          <button type="button" className="btn btn-primary px-2 py-0.5 text-xs" disabled={!valid || Boolean(data.blocker) || land.isPending} onClick={() => land.mutate()}>
            {land.isPending ? "Landing…" : "Land"}
          </button>
        </span>
      </div>
      {error && <p className="text-red-600">{error}</p>}
    </div>
  );
}
