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
import { money, shortDate } from "../lib/utils";
import { useDrawerParams } from "../lib/drawers";
import { MaterialsConsumeStep, MaterialsReturnStep, jobMaterialsKey } from "./MaterialsUsedPanel";
import { AttachProofButton, usePurchaseOrderDetail } from "./PurchaseOrders";
import { OpenDrawerButton } from "./drawers/OpenDrawerButton";

export function JobCloseoutPanel({ visitId, status }: { visitId: string; status: string }) {
  const queryClient = useQueryClient();
  const drawers = useDrawerParams();
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const { data: orders } = useQuery({
    queryKey: ["jobPOs", visitId],
    queryFn: () => api.jobPurchaseOrders(visitId),
  });
  // The "Materials used" step (Kyle, 2026-09-09, Build 4): what came off the
  // truck, pre-filled from the signed estimate. The job is charged only through
  // this — a signed estimate with material lines and no consume is a WARNING at
  // completion, never a wall.
  const { data: materials } = useQuery({ queryKey: jobMaterialsKey(visitId), queryFn: () => api.jobMaterials(visitId) });
  const [showMaterials, setShowMaterials] = useState(false);
  const materialsPending = Boolean(materials && materials.suggested.length > 0 && (materials.stock?.movementCount ?? 0) === 0);
  // "What came back?" — the close-out count (Kyle, 2026-09-15): leftover material off this job
  // counted back to the truck or warehouse. Same NO-GATE rule as the materials step above — a
  // skipped count is never a wall, and returnForJob already refuses anything nothing was consumed.
  const [showReturns, setShowReturns] = useState(false);

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
  // "Create P.O." pre-fills the job's whole shortage list (Kyle, 2026-09-16/17, Unit P) — not a
  // per-line "add to a PO" on the estimate, which risked one single-item PO per short line instead
  // of one complete material order. Multiple P.O.s on a job are still fine; this just means the
  // first one Kyle opens already has everything the job is short, editable before he sends it.
  const [showPoForm, setShowPoForm] = useState(false);
  const [supplier, setSupplier] = useState("");
  const [itemsText, setItemsText] = useState("");
  const [poLines, setPoLines] = useState<{ itemId: string | null; name: string; unit: string | null; qty: number }[]>([]);
  // Kyle, 2026-09-09: purpose is chosen, never inferred — truck stock by default.
  const [purpose, setPurpose] = useState<"truck_stock" | "warehouse" | "tool">("truck_stock");
  const [justCreated, setJustCreated] = useState<{ number: string } | null>(null);
  const togglePoForm = () => {
    if (!showPoForm && poLines.length === 0 && (materials?.shortages.length ?? 0) > 0) {
      setPoLines(materials!.shortages.map((s) => ({ itemId: s.itemId, name: s.name, unit: s.unit, qty: s.shortBy })));
    }
    setShowPoForm((s) => !s);
  };
  const createPo = useMutation({
    mutationFn: () => {
      const freeText = itemsText
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          // "3 x 12-2 Romex 250ft" or just "12-2 Romex" (qty 1)
          const m = line.match(/^(\d+(?:\.\d+)?)\s*[x×]\s*(.+)$/i);
          return m ? { name: m[2].trim(), qty: Number(m[1]) } : { name: line, qty: 1 };
        });
      const structured = poLines
        .filter((l) => l.qty > 0)
        .map((l) => ({ itemId: l.itemId ?? undefined, name: l.name, qty: l.qty, unit: l.unit ?? undefined }));
      // The one create door (2026-09-21): the same POST /purchase-orders the Purchases card
      // uses, with this job in the body — the job-scoped route was a second shape of the same thing.
      return api.startPurchaseOrder({ supplier: supplier.trim(), purpose, jobId: visitId, lines: [...structured, ...freeText] });
    },
    onSuccess: (po) => { setJustCreated({ number: po.number }); setSupplier(""); setItemsText(""); setPoLines([]); setShowPoForm(false); refresh(); },
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

      {/* ── Materials used — the costing switch (Kyle, 2026-09-09, Build 4) ──
          Shown in every close-out status, completed included (2026-09-21): this is now the ONE
          place the consume and return forms live on the job (the visit page's own copies were
          the duplicate, punch list C10), and the standing rule is that what a job records must
          stay editable from where it is shown — the same ruling the P.O. section below already
          follows ("any status, including closed and cancelled", Kyle 2026-09-20). */}
      {(
        <div className="mt-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-rce-soft">
              Materials used
              {materials && (
                <span className="ml-2 text-xs font-normal text-rce-muted">
                  {materials.stock ? `${money(materials.stock.net)} charged from truck stock` : materialsPending ? `${materials.suggested.length} line(s) from ${materials.estimate?.number ?? "the signed estimate"} waiting` : "nothing on the signed estimate to pull"}
                </span>
              )}
            </h3>
            <button className="btn btn-secondary text-xs" onClick={() => setShowMaterials((s) => !s)}>
              {showMaterials ? "Hide" : materialsPending ? "Record what came off the truck" : "Add / edit"}
            </button>
          </div>
          {materialsPending && !showMaterials && (
            <p className="mt-1 text-xs text-amber-900">Closing without this is allowed — the job's material then falls back to receipts or the estimate's frozen figure.</p>
          )}
          {showMaterials && (
            <div className="mt-2 rounded-lg border border-rce-border p-3">
              <MaterialsConsumeStep visitId={visitId} compact />
            </div>
          )}
        </div>
      )}

      {/* ── What came back? — the close-out count (Kyle, 2026-09-15) — same rule as above ── */}
      {(
        <div className="mt-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-rce-soft">What came back?</h3>
            <button className="btn btn-secondary text-xs" onClick={() => setShowReturns((s) => !s)}>
              {showReturns ? "Hide" : "Count what came back"}
            </button>
          </div>
          <p className="mt-1 text-xs text-rce-muted">
            Leftover material from this job, counted back to the truck or the warehouse — defaults to nothing
            returned. Closing without this is allowed; nothing came back is the normal case.
          </p>
          {showReturns && (
            <div className="mt-2 rounded-lg border border-rce-border p-3">
              <MaterialsReturnStep visitId={visitId} compact />
            </div>
          )}
        </div>
      )}

      {/* ── Purchase orders ── */}
      <div className="mt-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-rce-soft">
            Purchase orders
            {materials && materials.shortages.length > 0 && (
              <span className="ml-2 text-xs font-normal text-amber-800">
                short {materials.shortages.length} item(s) on {materials.truck.name}
              </span>
            )}
          </h3>
          <button className="btn btn-secondary text-xs" onClick={togglePoForm}>
            {showPoForm ? "Cancel" : "+ New P.O."}
          </button>
        </div>
        {showPoForm && (
          <div className="mt-2 space-y-2 rounded-lg border border-rce-border p-3">
            <div className="flex flex-wrap gap-2">
              <select className="field" value={purpose} onChange={(e) => setPurpose(e.target.value as typeof purpose)}>
                <option value="truck_stock">Truck stock</option>
                <option value="warehouse">Warehouse</option>
                <option value="tool">Tool</option>
              </select>
              <input
                className="field flex-1"
                placeholder="Supplier (Home Depot, ASD, …)"
                value={supplier}
                onChange={(e) => setSupplier(e.target.value)}
              />
            </div>
            {poLines.length > 0 && (
              <div>
                <p className="text-xs text-rce-muted">
                  Pre-filled from the job's shortage — on-hand checked against {materials?.truck.name}. Edit or remove
                  before creating.
                </p>
                <ul className="mt-1 space-y-1">
                  {poLines.map((l, i) => (
                    <li key={`${l.itemId ?? l.name}-${i}`} className="flex items-center gap-2">
                      <input
                        className="field w-20"
                        type="number"
                        min="0"
                        step="any"
                        value={l.qty}
                        onChange={(e) => {
                          const qty = Number(e.target.value);
                          setPoLines((prev) => prev.map((p, pi) => (pi === i ? { ...p, qty } : p)));
                        }}
                      />
                      <span className="flex-1 text-sm">
                        {l.name}
                        {l.unit ? <span className="text-rce-muted"> {l.unit}</span> : null}
                      </span>
                      <button
                        className="btn btn-danger px-2 py-0.5 text-xs min-h-0"
                        onClick={() => setPoLines((prev) => prev.filter((_, pi) => pi !== i))}
                      >
                        remove
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <textarea
              className="field w-full"
              rows={4}
              placeholder={"Additional items, one per line. Quantity first:\n3 x 12-2 Romex 250ft\n1 x 200A panel"}
              value={itemsText}
              onChange={(e) => setItemsText(e.target.value)}
            />
            <button
              className="btn btn-primary text-sm"
              disabled={!supplier.trim() || createPo.isPending}
              onClick={() => createPo.mutate()}
            >
              {createPo.isPending ? "Creating…" : "Create P.O."}
            </button>
          </div>
        )}
        {justCreated && (
          <p className="mt-2 rounded bg-emerald-50 p-2 text-sm text-emerald-900">
            <span className="text-xl font-bold tabular-nums">{justCreated.number}</span>
            <span className="ml-2 text-xs">Read this at the counter.</span>
          </p>
        )}
        {(orders ?? []).length === 0 && !showPoForm && (
          <p className="mt-1 text-xs text-rce-muted">No purchase orders on this job yet.</p>
        )}
        <ul className="mt-2 space-y-1">
          {(orders ?? []).map((po) => (
            <li key={po.id} className="rounded-lg border border-rce-border p-2 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                {/* The P.O. carries its own actions (2026-09-20): the number opens its drawer —
                    lines, money, receipts, landing, the trail — over this screen. */}
                <OpenDrawerButton kind="po" id={po.id} onOpen={drawers.open} className="font-medium hover:underline">
                  <span className="tabular-nums">{po.number}</span> · {po.supplier}
                </OpenDrawerButton>
                <span className="flex items-center gap-2 text-xs text-rce-muted">
                  {po.purpose.replaceAll("_", " ")} · {po.status} · {po.items.length} item(s) · {new Date(po.createdAt).toLocaleDateString()}
                  {(po.status === "open" || po.status === "purchased") && (
                    <button
                      className="btn btn-danger px-2 py-0.5 text-xs min-h-0"
                      onClick={() => {
                        if (window.confirm(`Cancel ${po.number}? The number is never reused.`)) void api.deletePurchaseOrder(visitId, po.id).then(refresh);
                      }}
                    >
                      cancel
                    </button>
                  )}
                </span>
              </div>
              <p className="mt-0.5 text-xs text-rce-soft">
                {po.items.map((i) => `${i.qty}× ${i.name}`).join(" · ")}
              </p>
              {/* THE MONEY (Kyle, 2026-09-19) and its proof — Kyle, 2026-09-20:
                  "I need each job's P.O. to show up on the job specific screen." */}
              <p className="mt-0.5 text-xs">
                <span className="font-medium tabular-nums">{money(po.moneyTotal)}</span>
                {po.offCardAmount != null && po.offCardAmount > 0 && (
                  <span className="text-rce-muted"> (card {money(po.cardTotal)} + typed {money(po.offCardAmount)})</span>
                )}
                <span className={po.moneyTotal > 0 && po.proofCount === 0 ? "ml-2 text-amber-800" : "ml-2 text-rce-muted"}>
                  {po.proofCount > 0 ? `${po.proofCount} receipt(s) on file` : po.moneyTotal > 0 ? "needs a receipt" : "no receipts yet"}
                </span>
              </p>
              {/* Any status, including closed and cancelled (Kyle, 2026-09-20) —
                  a P.O. can go on being edited after it lands. Same uploader as
                  the Financials Purchasing card, never a third one. */}
              <PoReceiptsOnJob poId={po.id} onDone={refresh} />
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-rce-muted">
          Actual job spend — feeds the account's job costs, the Financials reports, and (later) the
          price book. Every receipt attaches to a P.O.; techs can also send receipts from the field app.
        </p>
      </div>
    </article>
  );
}

/**
 * Receipts on one P.O., from the job screen (Kyle, 2026-09-20: "I have several
 * receipt photos to add to this job and need to edit/add to the P.O. currently
 * assigned to it"). Attach reuses AttachProofButton — the one uploader,
 * everywhere a P.O. needs its proof — rather than a third upload control. The
 * list itself is lazy: the job's P.O. list carries only a proof COUNT, so the
 * per-receipt detail (and the way OUT of it, per the standing rule that
 * anything attached must be removable from the surface that shows it) loads
 * on request instead of on every job page view.
 */
function PoReceiptsOnJob({ poId, onDone }: { poId: string; onDone: () => void }) {
  const queryClient = useQueryClient();
  const drawers = useDrawerParams();
  const [expanded, setExpanded] = useState(false);
  // Same hook (and so the same cache entry) PurchaseOrders.tsx's PoDetailPanel
  // uses — shares the cache and picks up usePoRefresh's invalidation from that
  // surface too.
  const { data: po } = usePurchaseOrderDetail(poId, expanded);
  const detach = useMutation({
    mutationFn: (receiptId: string) => api.detachReceiptFromPurchaseOrder(poId, receiptId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["purchase-order", poId] });
      onDone();
    },
  });

  return (
    <div className="mt-1 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <AttachProofButton poId={poId} label="+ Add receipt" />
        <button type="button" className="btn btn-secondary px-2 py-0.5 text-xs min-h-0" onClick={() => setExpanded((e) => !e)}>
          {expanded ? "Hide receipts" : "Show receipts"}
        </button>
      </div>
      {expanded && (
        <ul className="mt-1 space-y-0.5">
          {po && po.receipts.length === 0 && <li className="text-rce-muted">No receipts attached yet.</li>}
          {(po?.receipts ?? []).map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded border border-rce-border/60 px-2 py-1">
              <OpenDrawerButton kind="receipt" id={r.id} onOpen={drawers.open} className="text-left hover:underline">
                {r.vendor || "Unknown vendor"} · {money(r.amount)} · {shortDate(r.receivedAt)}{!r.hasImage ? " · no file" : ""}
              </OpenDrawerButton>
              <button
                type="button"
                className="btn btn-danger px-2 py-0.5 text-xs min-h-0"
                disabled={detach.isPending}
                onClick={() => { if (window.confirm("Remove this receipt from the P.O.?")) detach.mutate(r.id); }}
              >
                remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
