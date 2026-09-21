/**
 * Materials used — the costing switch (Kyle, 2026-09-09, Build 4).
 *
 * "On future jobs I can label some stock as truckstock and it won't double
 * count the cost." Materials land on a truck or in the warehouse, never on a
 * job. A job is charged ONLY when stock is consumed from a truck, at the
 * truck's moving-average cost; a return credits it back. Everything is a
 * ledger row with an actor and a reason.
 *
 * Two pieces:
 *   MaterialsConsumeStep — the "Materials used" step at close-out: pre-filled
 *     from the signed estimate's taken lines with the truck's on-hand beside
 *     each, editable quantities, add a line from the book, Confirm → consume.
 *     Kyle's override (allow negative, reason required) lives here too.
 *   MaterialsReturnStep — the close-out count: every line the job took, what
 *     came back, one reason for the batch.
 *   MaterialsUsedPanel — the visit page's card: the source label and figure,
 *     every consume/return line with its cost, the materials-list PDF, and
 *     the receipts with the ones riding a PO flagged "inventory, not job cost".
 *     It READS; the consume and return forms live on JobCloseoutPanel (and so
 *     in the job drawer) — this card used to mount its own copies of both,
 *     which was the duplicate punch list C10 named (deleted 2026-09-21).
 */

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, openProtectedPdf } from "../lib/api";
import { MATERIAL_SOURCE_LABEL, type InventoryItem, type JobMaterialsView, type SuggestedMaterialLine } from "../lib/types";
import { money, shortDate } from "../lib/utils";

type Row = { key: string; itemId: string; name: string; unit: string | null; qty: string; onHand: number | null; avgUnitCost: number | null; fromEstimate: boolean };

const SOURCE_NOTE: Record<JobMaterialsView["materialSource"], string> = {
  po: "card charges + typed not-on-card amounts on the P.O.s tagged to this job",
  none: "no P.O. tagged to this job carries money yet",
};

/** Query key names the endpoint: /jobs/:id/materials. Invalidated by every consume/return. */
export const jobMaterialsKey = (visitId: string) => ["job-materials", visitId] as const;

export function invalidateMaterials(queryClient: ReturnType<typeof useQueryClient>, visitId: string) {
  void queryClient.invalidateQueries({ queryKey: jobMaterialsKey(visitId) });
  for (const key of [["visit", visitId], ["jobs"], ["account-summary"], ["inventory"], ["jobProfitability"], ["financials"], ["financials-materials"]]) {
    void queryClient.invalidateQueries({ queryKey: key });
  }
}

function rowsFromSuggested(lines: SuggestedMaterialLine[]): Row[] {
  return lines.map((s) => ({
    key: s.itemId,
    itemId: s.itemId,
    name: s.name,
    unit: s.unit,
    // What is still expected to come off the truck: the estimate's quantity less what this job already consumed.
    qty: String(Math.max(0, Math.round((s.qty - s.consumedQty) * 10000) / 10000)),
    onHand: s.onHand,
    avgUnitCost: s.avgUnitCost,
    fromEstimate: true,
  }));
}

/** Book search for an add-line — the same picker the Inventory page uses. */
function ItemSearch({ onPick, exclude }: { onPick: (item: InventoryItem) => void; exclude: Set<string> }) {
  const [q, setQ] = useState("");
  const { data: items = [] } = useQuery({ queryKey: ["inventory-items", { q }], queryFn: () => api.inventoryItems(q), enabled: q.trim().length >= 2 });
  const hits = items.filter((i) => !exclude.has(i.itemId)).slice(0, 8);
  return (
    <div className="relative">
      <input className="field w-full text-xs" placeholder="Add a line from the book (12-2 NM-B, 4-square…)" value={q} onChange={(e) => setQ(e.target.value)} />
      {q.trim().length >= 2 && hits.length > 0 && (
        <ul className="absolute z-10 mt-1 max-h-48 w-full overflow-auto rounded border border-rce-border bg-white shadow">
          {hits.map((i) => (
            <li key={i.itemId}>
              <button type="button" className="w-full px-2 py-1 text-left text-xs hover:bg-rce-bg" onClick={() => { onPick(i); setQ(""); }}>
                <span className="font-medium">{i.itemId}</span> {i.description}{i.unit ? <span className="text-rce-muted"> · {i.unit}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function MaterialsConsumeStep({ visitId, onDone, compact }: { visitId: string; onDone?: () => void; compact?: boolean }) {
  const queryClient = useQueryClient();
  const { data, isLoading, error: loadError } = useQuery({ queryKey: jobMaterialsKey(visitId), queryFn: () => api.jobMaterials(visitId) });
  const [rows, setRows] = useState<Row[]>([]);
  const [seeded, setSeeded] = useState(false);
  const [reason, setReason] = useState("");
  const [allowNegative, setAllowNegative] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    if (data && !seeded) { setRows(rowsFromSuggested(data.suggested)); setSeeded(true); }
  }, [data, seeded]);
  // On-hand for lines added by hand comes from the same endpoint the estimate builder reads.
  const addedIds = useMemo(() => rows.filter((r) => r.onHand === null).map((r) => r.itemId), [rows]);
  const { data: onHand } = useQuery({
    queryKey: ["inventory-on-hand", { itemIds: addedIds.join(","), truckId: data?.truck.id ?? "" }],
    queryFn: () => api.inventoryOnHand(addedIds, data?.truck.id),
    enabled: addedIds.length > 0 && Boolean(data),
  });
  useEffect(() => {
    if (!onHand) return;
    setRows((rs) => rs.map((r) => (r.onHand === null && onHand[r.itemId] ? { ...r, onHand: onHand[r.itemId].qty, avgUnitCost: onHand[r.itemId].avgUnitCost, unit: r.unit ?? onHand[r.itemId].unit } : r)));
  }, [onHand]);

  const consume = useMutation({
    mutationFn: () => api.consumeForJob(visitId, {
      truckId: data?.truck.id ?? null,
      lines: rows.filter((r) => Number(r.qty) > 0).map((r) => ({ itemId: r.itemId, name: r.name, qty: Number(r.qty), unit: r.unit })),
      reason: reason.trim() || null,
      allowNegative,
    }),
    onSuccess: (movements) => {
      const total = movements.reduce((s, m) => s + m.qty * (m.unitCost ?? 0), 0);
      setDone(`Recorded ${movements.length} line(s) — ${money(Math.round(total * 100) / 100)} charged to this job from ${data?.truck.name ?? "the truck"}.`);
      setError(null);
      setSeeded(false);
      setReason("");
      setAllowNegative(false);
      invalidateMaterials(queryClient, visitId);
      onDone?.();
    },
    onError: (err) => setError((err as Error).message),
  });

  if (isLoading) return <p className="text-xs text-rce-muted">Loading materials…</p>;
  if (loadError || !data) return <p className="text-xs text-red-600">{(loadError as Error | null)?.message ?? "Could not load the job's materials."}</p>;

  const active = rows.filter((r) => Number(r.qty) > 0);
  const short = active.filter((r) => r.onHand !== null && Number(r.qty) > r.onHand);
  const projected = active.reduce((s, r) => s + Number(r.qty) * (r.avgUnitCost ?? 0), 0);
  const valid = active.length > 0 && rows.every((r) => r.qty === "" || (Number.isFinite(Number(r.qty)) && Number(r.qty) >= 0)) && (!allowNegative || reason.trim().length > 0);

  return (
    <div className="space-y-2 text-xs">
      <p className="text-rce-muted">
        Off <span className="font-medium text-rce-text">{data.truck.name}</span> at its moving-average cost.
        {data.estimate ? ` Pre-filled from ${data.estimate.number}'s taken lines; edit what actually came off the truck.` : " No signed estimate — add the lines that came off the truck."}
      </p>
      {rows.length === 0 && <p className="text-rce-muted">No lines yet — search the book below.</p>}
      {rows.length > 0 && (
        <table className="w-full">
          <thead className="text-left text-[11px] uppercase tracking-wide text-rce-soft">
            <tr><th className="pr-2">Item</th><th className="pr-2">Used</th><th className="pr-2 text-right">On truck</th><th className="text-right">Cost</th></tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const qty = Number(r.qty) || 0;
              const isShort = r.onHand !== null && qty > r.onHand;
              return (
                <tr key={r.key} className="border-t border-rce-border/60">
                  <td className="py-0.5 pr-2">
                    {r.name}<span className="text-rce-muted"> · {r.itemId}</span>
                    {!r.fromEstimate && <span className="ml-1 text-rce-muted">(added)</span>}
                  </td>
                  <td className="py-0.5 pr-2">
                    <input className="field w-20 px-1 py-0.5 text-xs" inputMode="decimal" value={r.qty} onChange={(e) => setRows((rs) => rs.map((x, idx) => (idx === i ? { ...x, qty: e.target.value } : x)))} />
                    <span className="ml-1 text-rce-muted">{r.unit ?? ""}</span>
                  </td>
                  <td className={`py-0.5 pr-2 text-right tabular-nums ${isShort ? "text-amber-800" : ""}`}>
                    {r.onHand === null ? "…" : `${r.onHand} ${r.unit ?? ""}`}
                    {isShort && <span className="block text-[10px]">short {Math.round((qty - (r.onHand ?? 0)) * 10000) / 10000}</span>}
                  </td>
                  <td className="py-0.5 text-right tabular-nums">{r.avgUnitCost === null ? "—" : money(Math.round(qty * r.avgUnitCost * 100) / 100)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <ItemSearch
        exclude={new Set(rows.map((r) => r.itemId))}
        onPick={(i) => setRows((rs) => [...rs, { key: i.itemId, itemId: i.itemId, name: i.description ?? i.itemId, unit: i.unit, qty: "1", onHand: null, avgUnitCost: null, fromEstimate: false }])}
      />
      {short.length > 0 && (
        <p className="rounded bg-amber-50 p-2 text-amber-900">
          {data.truck.name} is short on {short.map((r) => r.name).join(", ")} — the ledger will refuse this unless you allow the truck to go negative (with a reason). Land the PO first if it is sitting in the truck unlanded.
        </p>
      )}
      <div className={`flex flex-wrap items-center gap-2 ${compact ? "" : "justify-between"}`}>
        <input className="field w-60 px-1 py-0.5 text-xs" placeholder={allowNegative ? "Reason (required to go negative)" : "Note (optional)"} value={reason} onChange={(e) => setReason(e.target.value)} />
        <label className="inline-flex items-center gap-1 text-rce-muted">
          <input type="checkbox" checked={allowNegative} onChange={(e) => setAllowNegative(e.target.checked)} /> allow the truck to go negative
        </label>
        <span className="ml-auto inline-flex items-center gap-2">
          <span className="tabular-nums text-rce-muted">≈ {money(Math.round(projected * 100) / 100)}</span>
          <button type="button" className="btn btn-primary px-2 py-0.5 text-xs" disabled={!valid || consume.isPending} onClick={() => consume.mutate()}>
            {consume.isPending ? "Recording…" : "Confirm materials used"}
          </button>
        </span>
      </div>
      {error && <p className="rounded bg-red-50 p-2 text-red-900">{error}</p>}
      {done && <p className="rounded bg-emerald-50 p-2 text-emerald-900">{done}</p>}
    </div>
  );
}

/**
 * What this job still has outstanding, per item: consumed minus already
 * returned, positive only — what MaterialsReturnStep offers to count back.
 */
function netConsumedRows(lines: JobMaterialsView["lines"]): Array<{ itemId: string; name: string; unit: string | null; net: number }> {
  const byItem = new Map<string, { itemId: string; name: string; unit: string | null; net: number }>();
  for (const l of lines) {
    const row = byItem.get(l.itemId) ?? { itemId: l.itemId, name: l.name, unit: l.unit, net: 0 };
    row.net += l.kind === "return" ? -l.qty : l.qty;
    byItem.set(l.itemId, row);
  }
  return [...byItem.values()].filter((r) => r.net > 0);
}

/** Default reason for the close-out count — one reason for the whole batch, overridable once (Kyle, 2026-09-15). */
const CLOSEOUT_RETURN_REASON = "Job close-out count";

/**
 * The close-out count step — "What came back?" (Kyle, 2026-09-15): "Left over
 * material gets counted to the truck or warehouse once the job is marked
 * complete." One pass over everything this job took, quantities editable,
 * defaulting to nothing returned (most jobs consume what they took). One
 * Confirm writes every line in a single /return call, credited at the cost
 * this job was charged — same machinery as ReturnForm, just all the lines at
 * once and one reason for the batch instead of one per line. Never gates
 * Mark complete; a job with nothing consumed shows nothing to count.
 */
export function MaterialsReturnStep({ visitId, onDone, compact }: { visitId: string; onDone?: () => void; compact?: boolean }) {
  const queryClient = useQueryClient();
  const { data, isLoading, error: loadError } = useQuery({ queryKey: jobMaterialsKey(visitId), queryFn: () => api.jobMaterials(visitId) });
  const rows = useMemo(() => (data ? netConsumedRows(data.lines) : []), [data]);
  const [qtys, setQtys] = useState<Record<string, string>>({});
  const [destination, setDestination] = useState<"truck" | "warehouse">("truck");
  const [reason, setReason] = useState(CLOSEOUT_RETURN_REASON);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const active = rows
    .map((r) => ({ ...r, qty: Number(qtys[r.itemId] ?? "") || 0 }))
    .filter((r) => r.qty > 0);
  const overrun = rows.find((r) => {
    const v = qtys[r.itemId];
    return v !== undefined && v.trim() !== "" && Number.isFinite(Number(v)) && Number(v) > r.net;
  });
  const valid = active.length > 0 && !overrun && rows.every((r) => {
    const v = qtys[r.itemId];
    return v === undefined || v.trim() === "" || (Number.isFinite(Number(v)) && Number(v) >= 0);
  });

  const ret = useMutation({
    mutationFn: () => api.returnForJob(visitId, {
      truckId: destination === "truck" ? (data?.truck.id ?? null) : null,
      warehouse: destination === "warehouse",
      lines: active.map((r) => ({ itemId: r.itemId, name: r.name, qty: r.qty, unit: r.unit })),
      reason: reason.trim() || CLOSEOUT_RETURN_REASON,
    }),
    onSuccess: (movements) => {
      const total = movements.reduce((s, m) => s + m.qty * (m.unitCost ?? 0), 0);
      const place = destination === "warehouse" ? "the warehouse" : data?.truck.name ?? "the truck";
      setDone(`Counted ${movements.length} line(s) back onto ${place} — ${money(Math.round(total * 100) / 100)} credited to this job.`);
      setError(null);
      setQtys({});
      invalidateMaterials(queryClient, visitId);
      onDone?.();
    },
    onError: (err) => setError((err as Error).message),
  });

  if (isLoading) return <p className="text-xs text-rce-muted">Loading materials…</p>;
  if (loadError || !data) return <p className="text-xs text-red-600">{(loadError as Error | null)?.message ?? "Could not load the job's materials."}</p>;
  if (rows.length === 0) return <p className="text-xs text-rce-muted">Nothing consumed on this job yet — nothing to count.</p>;

  return (
    <div className="space-y-2 text-xs">
      <p className="text-rce-muted">
        Everything this job took off {data.truck.name}. What came back? Defaults to nothing returned — leave a line blank if it was all used.
      </p>
      <table className="w-full">
        <thead className="text-left text-[11px] uppercase tracking-wide text-rce-soft">
          <tr><th className="pr-2">Item</th><th className="pr-2 text-right">Taken</th><th className="pr-2 text-right">Came back</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const v = qtys[r.itemId] ?? "";
            const tooMuch = v.trim() !== "" && Number.isFinite(Number(v)) && Number(v) > r.net;
            return (
              <tr key={r.itemId} className="border-t border-rce-border/60">
                <td className="py-0.5 pr-2">{r.name}<span className="text-rce-muted"> · {r.itemId}</span></td>
                <td className="py-0.5 pr-2 text-right tabular-nums">{r.net} {r.unit ?? ""}</td>
                <td className="py-0.5 pr-2 text-right">
                  <input
                    className={`field w-20 px-1 py-0.5 text-right text-xs ${tooMuch ? "border-red-400" : ""}`}
                    inputMode="decimal"
                    placeholder="0"
                    value={v}
                    onChange={(e) => setQtys((q) => ({ ...q, [r.itemId]: e.target.value }))}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {overrun && (
        <p className="rounded bg-red-50 p-2 text-red-900">{overrun.name} — this job only has {overrun.net} {overrun.unit ?? ""} outstanding.</p>
      )}
      <div className={`flex flex-wrap items-center gap-2 ${compact ? "" : "justify-between"}`}>
        <select className="field text-xs" value={destination} onChange={(e) => setDestination(e.target.value as typeof destination)}>
          <option value="truck">To {data.truck.name}</option>
          <option value="warehouse">To the warehouse</option>
        </select>
        <input className="field w-56 px-1 py-0.5 text-xs" placeholder="Reason for the batch" value={reason} onChange={(e) => setReason(e.target.value)} />
        <button type="button" className="btn btn-primary px-2 py-0.5 text-xs" disabled={!valid || ret.isPending} onClick={() => ret.mutate()}>
          {ret.isPending ? "Counting…" : "Confirm count"}
        </button>
      </div>
      {error && <p className="rounded bg-red-50 p-2 text-red-900">{error}</p>}
      {done && <p className="rounded bg-emerald-50 p-2 text-emerald-900">{done}</p>}
    </div>
  );
}

export function MaterialsUsedPanel({ visitId }: { visitId: string }) {
  const { data, isLoading } = useQuery({ queryKey: jobMaterialsKey(visitId), queryFn: () => api.jobMaterials(visitId) });

  if (isLoading) return <article className="card rounded-2xl border border-rce-border/70 p-5 text-sm text-rce-muted">Loading materials…</article>;
  if (!data) return null;

  return (
    <article className="card rounded-2xl border border-rce-border/70 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Materials used</h2>
        <div className="flex items-center gap-2">
          {/* Unit L, 2026-09-17: "should show the materials from the line items used to quote the
              job" — every signed estimate's taken lines, assemblies expanded, no costs. */}
          <button
            type="button"
            className="btn btn-secondary text-xs"
            onClick={() => void openProtectedPdf(`/jobs/${visitId}/materials-list.pdf`)}
          >
            Materials list
          </button>
        </div>
      </div>
      <p className="mt-1 text-sm">
        <span className="font-semibold tabular-nums">{money(data.materialCost)}</span>
        <span className="ml-2 text-rce-muted">· {MATERIAL_SOURCE_LABEL[data.materialSource]} — {SOURCE_NOTE[data.materialSource]}</span>
      </p>
      <p className="text-xs text-rce-muted">
        {data.po && `${data.po.poCount} P.O.(s) · card ${money(data.po.card)} · typed ${money(data.po.typed)}`}
        {data.stock && `${data.po ? " · " : ""}off the truck ${money(data.stock.net)} in ${data.stock.movementCount} ledger row(s) — inventory only, not cost`}
        {data.estimateMaterial !== null && ` · estimate carried ${money(data.estimateMaterial)} (an estimate, never cost)`}
      </p>

      {/* Recording what came off the truck, and what came back, is in "Job close-out" above
          (and in the job's drawer) — one form each, not a second copy here (2026-09-21). */}

      <div className="mt-3">
        {data.lines.length === 0 ? (
          <p className="text-xs text-rce-muted">Nothing recorded from truck stock yet{data.suggested.length > 0 ? ` — ${data.suggested.length} line(s) on the signed estimate are waiting in the close-out step.` : "."}</p>
        ) : (
          <table className="w-full text-xs">
            <thead className="text-left text-[11px] uppercase tracking-wide text-rce-soft">
              <tr><th className="pr-2">When</th><th className="pr-2">Item</th><th className="pr-2 text-right">Qty</th><th className="pr-2 text-right">Unit cost</th><th className="pr-2 text-right">Cost</th><th>By / reason</th></tr>
            </thead>
            <tbody>
              {data.lines.map((l) => (
                <tr key={l.movementId} className="border-t border-rce-border/60">
                  <td className="py-0.5 pr-2 text-rce-muted">{shortDate(l.at)}</td>
                  <td className="py-0.5 pr-2">
                    <span className={`mr-1 rounded px-1 text-[10px] uppercase ${l.kind === "return" ? "bg-emerald-50 text-emerald-800" : l.kind === "correction" ? "bg-amber-50 text-amber-800" : "bg-rce-bg text-rce-soft"}`}>{l.kind}</span>
                    {l.name}{l.onVisitId ? <span className="text-rce-muted"> · on the quoted-on visit</span> : null}
                  </td>
                  <td className="py-0.5 pr-2 text-right tabular-nums">{l.qty} {l.unit ?? ""}</td>
                  <td className="py-0.5 pr-2 text-right tabular-nums">{l.unitCost === null ? "—" : money(l.unitCost)}</td>
                  <td className={`py-0.5 pr-2 text-right tabular-nums ${l.cost < 0 ? "text-emerald-800" : ""}`}>{money(l.cost)}</td>
                  <td className="py-0.5 text-rce-muted">{l.actor}{l.reason ? ` — ${l.reason}` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {data.receipts.length > 0 && (
        <div className="mt-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-rce-soft">Receipts on this job</h3>
          <ul className="mt-1 space-y-0.5 text-xs">
            {data.receipts.map((r) => (
              <li key={r.id} className="flex flex-wrap justify-between gap-2">
                <span>
                  {shortDate(r.receivedAt)} · {r.vendor ?? "(no vendor)"} · {r.category}{r.purchaseOrderNumber ? ` · ${r.purchaseOrderNumber}` : ""}
                  {r.note && <span className="ml-1 text-amber-800">— {r.note}</span>}
                </span>
                {/* A receipt is proof, never money (Kyle, 2026-09-19): its amount is what it says, not what the job is charged. */}
                <span className="tabular-nums text-rce-muted">{money(r.amount)}{r.hasFile ? "" : " · no file"}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </article>
  );
}
