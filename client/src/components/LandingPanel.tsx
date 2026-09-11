/**
 * Landing a PO (Kyle, 2026-09-09, Build 3).
 *
 * A purchased PO's material lands on its truck or in the warehouse; a tool PO
 * lands on the tool register. Each line shows the expected quantity, an
 * editable quantity landed (default expected) and an editable unit cost
 * (default from /purchase-orders/:id/landing). Landing closes the PO. Shared
 * by the Inventory page and the Purchases card.
 *
 * Kyle, 2026-09-11 (the seven picks): "The receipt total is the truth. It
 * matches the card swipe to the cent" — the photo's line prices are only the
 * weights that split it, and the sales tax rides in the unit costs rather than
 * being left over. So the panel shows the balance ("Landing total $X of receipt
 * $Y"), holds Land until the two agree, and takes a one-line reason for "Land
 * anyway". A PO with no receipt gets the upload right here ("This is where we
 * need a way to attach a photo of the receipt if one is missing"); a PO with no
 * lines gets the receipt's own lines in one click.
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
  even: "even split",
  none: "no default",
};
const GUESS_SOURCES = new Set<LandingDefaults["lines"][number]["costSource"]>(["book", "even", "none"]);

type Row = { lineId: string; qty: string; cost: string };

export function LandingPanel({ poId, onLanded }: { poId: string; onLanded?: () => void }) {
  const queryClient = useQueryClient();
  const { data, isLoading, error: loadError } = useQuery({ queryKey: ["purchase-order-landing", poId], queryFn: () => api.landingDefaults(poId) });
  const [rows, setRows] = useState<Row[]>([]);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [overriding, setOverriding] = useState(false);
  const [overrideReason, setOverrideReason] = useState("");
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
      ...(overriding && overrideReason.trim() ? { override: { reason: overrideReason.trim() } } : {}),
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
  // The receipt is the truth — Land is held until the lines add up to it (Kyle, 2026-09-11).
  const inBalance = data.receiptTotal <= 0 || Math.abs(total - data.receiptTotal) <= 0.01;
  const overrideReady = overriding && overrideReason.trim().length > 0;

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
                  <span
                    className={`ml-1 text-[10px] ${GUESS_SOURCES.has(l.costSource) ? "text-amber-800" : "text-rce-muted"}`}
                    title={l.matchedReceiptLines.length > 0 ? `receipt: ${l.matchedReceiptLines.map((rl) => `${rl.name} × ${rl.qty}`).join(", ")} · weighted by ${l.weightBasis}` : `weighted by ${l.weightBasis}`}
                  >
                    {COST_SOURCE_LABEL[l.costSource]}
                    {/* Kyle, 2026-09-11: the tax rides in the price, so the line says so. */}
                    {l.taxShare > 0 ? ` · incl. tax ${money(l.taxShare)}` : ""}
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
          {data.taxTotal > 0 && (
            <p className="text-rce-muted">{money(data.taxTotal)} of the receipt is past its printed lines (sales tax) — spread across the lines, so each unit cost is what was paid.</p>
          )}
        </div>
      )}
      {/* Kyle, 2026-09-11: the balance is the headline — green when the lines equal the receipt, red when they do not. */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className={`tabular-nums font-medium ${data.receiptTotal <= 0 ? "text-rce-muted" : inBalance ? "text-emerald-700" : "text-red-600"}`}>
          Landing total {money(total)}
          {data.receiptTotal > 0 ? ` of receipt ${money(data.receiptTotal)}` : " · no receipt to check against"}
          {data.receiptTotal > 0 && !inBalance ? ` · off by ${money(Math.abs(total - data.receiptTotal))}` : ""}
        </span>
        <span className="inline-flex flex-wrap items-center gap-1">
          <input className="field w-48 max-w-full px-1 py-0.5 text-xs" placeholder="Note (optional)" value={reason} onChange={(e) => setReason(e.target.value)} />
          {!inBalance && !overriding && (
            <button type="button" className="text-amber-800 hover:underline" onClick={() => setOverriding(true)}>Land anyway</button>
          )}
          {!inBalance && overriding && (
            <>
              <input className="field w-52 max-w-full px-1 py-0.5 text-xs" placeholder="Why land out of balance? (required)" value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} />
              <button type="button" className="text-rce-muted" onClick={() => { setOverriding(false); setOverrideReason(""); }}>cancel</button>
            </>
          )}
          <button
            type="button"
            className="btn btn-primary px-2 py-0.5 text-xs"
            disabled={!valid || Boolean(data.blocker) || land.isPending || (!inBalance && !overrideReady)}
            onClick={() => land.mutate()}
          >
            {land.isPending ? "Landing…" : inBalance ? "Land" : "Land anyway"}
          </button>
        </span>
      </div>
      {error && <p className="text-red-600">{error}</p>}
    </div>
  );
}
