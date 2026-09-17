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

import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { money } from "../lib/utils";
import { MaterialsConsumeStep, MaterialsReturnStep, jobMaterialsKey } from "./MaterialsUsedPanel";

export function JobCloseoutPanel({ visitId, status }: { visitId: string; status: string }) {
  const queryClient = useQueryClient();
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
      return api.createPurchaseOrder(visitId, { supplier: supplier.trim(), purpose, items: [...structured, ...freeText] });
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

      {/* ── Materials used — the costing switch (Kyle, 2026-09-09, Build 4) ── */}
      {!isCompleted && (
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

      {/* ── What came back? — the close-out count (Kyle, 2026-09-15) ── */}
      {!isCompleted && (
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
                        className="text-xs text-red-600 underline"
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
                <span className="font-medium"><span className="tabular-nums">{po.number}</span> · {po.supplier}</span>
                <span className="flex items-center gap-2 text-xs text-rce-muted">
                  {po.purpose.replaceAll("_", " ")} · {po.status} · {po.items.length} item(s) · {new Date(po.createdAt).toLocaleDateString()}
                  {(po.status === "open" || po.status === "purchased") && (
                    <button
                      className="text-red-600 underline"
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
              {po.status !== "closed" && po.status !== "cancelled" && (
                <PoReceiptUpload poId={po.id} onDone={refresh} />
              )}
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
 * Receipt upload attached to one P.O. (Kyle, 2026-09-17: "there should not be
 * an stand alone add a receipt button. Every receipt should have a P.O.
 * first.") Same door as PurchaseOrders.tsx's PoDetailPanel — api.uploadPoReceipt
 * — so a receipt can only land on a P.O., never loose on the job.
 */
function PoReceiptUpload({ poId, onDone }: { poId: string; onDone: () => void }) {
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const upload = useMutation({
    mutationFn: (file: File) =>
      api.uploadPoReceipt(poId, { image: file, amount: Number(amount) > 0 ? Number(amount) : undefined }),
    onSuccess: (res) => {
      setError(null);
      setNote(res.note ?? `Receipt saved: ${money(res.amount)}`);
      setAmount("");
      onDone();
    },
    onError: (err) => { setError((err as Error).message); setNote(null); },
  });

  return (
    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
      <input
        ref={fileRef}
        type="file"
        accept="image/*,application/pdf"
        className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) upload.mutate(f); e.target.value = ""; }}
      />
      <input
        className="field w-24 px-1 py-0.5 text-xs"
        type="number"
        step="0.01"
        placeholder="Amount $ (optional)"
        value={amount}
        onChange={(ev) => setAmount(ev.target.value)}
      />
      <button
        type="button"
        className="btn btn-secondary px-2 py-0.5 text-xs"
        disabled={upload.isPending}
        onClick={() => fileRef.current?.click()}
      >
        {upload.isPending ? "Saving…" : "+ Add receipt"}
      </button>
      {note && <span className="text-emerald-700">{note}</span>}
      {error && <span className="text-red-600">{error}</span>}
    </div>
  );
}
