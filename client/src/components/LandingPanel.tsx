/**
 * Landing a PO (Kyle, 2026-09-09, Build 3).
 *
 * A purchased PO's material lands on its truck or in the warehouse; a tool PO
 * lands on the tool register. Each line shows the expected quantity, an
 * editable quantity landed (default expected) and an editable unit cost
 * (default from /purchase-orders/:id/landing — the receipt total prorated
 * across lines when there is one, else the keyed cost, else the book).
 * Landing closes the PO. Shared by the Inventory page and the Purchases card.
 */

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { LandingDefaults } from "../lib/types";
import { money } from "../lib/utils";

const COST_SOURCE_LABEL: Record<LandingDefaults["lines"][number]["costSource"], string> = {
  receipt: "from receipt",
  line: "as keyed",
  book: "book price",
  none: "no default",
};

type Row = { lineId: string; qty: string; cost: string };

export function LandingPanel({ poId, onLanded }: { poId: string; onLanded?: () => void }) {
  const queryClient = useQueryClient();
  const { data, isLoading, error: loadError } = useQuery({ queryKey: ["purchase-order-landing", poId], queryFn: () => api.landingDefaults(poId) });
  const [rows, setRows] = useState<Row[]>([]);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (data) setRows(data.lines.map((l) => ({ lineId: l.lineId, qty: String(l.qtyLandedDefault), cost: String(l.unitCostDefault) })));
  }, [data]);

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
                  <span className="ml-1 text-rce-muted">{COST_SOURCE_LABEL[l.costSource]}</span>
                </td>
                <td className="py-0.5 text-right tabular-nums">{money((Number(row.qty) || 0) * (Number(row.cost) || 0))}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="tabular-nums">Landing total {money(total)}{data.receiptTotal > 0 && Math.abs(total - data.receiptTotal) > 0.01 ? <span className="text-amber-800"> · receipt {money(data.receiptTotal)}</span> : null}</span>
        <span className="inline-flex flex-wrap items-center gap-1">
          <input className="field w-48 px-1 py-0.5 text-xs" placeholder="Note (optional)" value={reason} onChange={(e) => setReason(e.target.value)} />
          <button type="button" className="btn btn-primary px-2 py-0.5 text-xs" disabled={!valid || Boolean(data.blocker) || land.isPending} onClick={() => land.mutate()}>
            {land.isPending ? "Landing…" : "Land"}
          </button>
        </span>
      </div>
      {error && <p className="text-red-600">{error}</p>}
    </div>
  );
}
