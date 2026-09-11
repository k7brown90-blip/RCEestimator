/**
 * Purchase orders in the CRM (Kyle, 2026-09-09).
 *
 * "Purchasing needs to start with a P.O. number then the purchase and photo
 * verification of the receipt." The Purchases card on Financials starts a PO
 * (purpose chosen: Truck stock default / Warehouse / Tool — "Tool purchases
 * will be done separately"), shows the number big enough to read at the
 * counter, lists open and purchased POs with an expand-in-place detail panel
 * (lines, trail, receipts, actions), and pairs loose materials receipts with
 * a PO. "We need to be able to edit manually in case there are errors found"
 * — every edit here asks for a one-line reason that lands in the trail.
 *
 * Everything stays in the card (Kyle: no new windows or tabs, no endless
 * lists — rows cap at 8 with Show more).
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import type { PurchaseOrderLineInput } from "../lib/api";
import type { PoPurpose, PoStatus, PurchaseOrderDetail, PurchaseOrderLine, PurchaseOrderSummary, ReviewReceiptRow } from "../lib/types";
import { money, shortDate } from "../lib/utils";
import { LandingPanel } from "./LandingPanel";
import { CollapsibleCard } from "./CollapsibleCard";

const PAGE_SIZE = 8;

export const PO_PURPOSE_LABEL: Record<string, string> = {
  truck_stock: "Truck stock",
  warehouse: "Warehouse",
  tool: "Tool",
};

const STATUS_CLASS: Record<PoStatus, string> = {
  open: "bg-sky-100 text-sky-800",
  purchased: "bg-amber-100 text-amber-800",
  verified: "bg-emerald-100 text-emerald-800",
  closed: "bg-slate-200 text-slate-700",
  cancelled: "bg-red-100 text-red-800",
};

export function PoStatusPill({ status }: { status: PoStatus | string }) {
  const cls = STATUS_CLASS[status as PoStatus] ?? "bg-slate-100 text-slate-700";
  return <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${cls}`}>{status}</span>;
}

function PurposePill({ purpose }: { purpose: PoPurpose | string }) {
  return <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-700">{PO_PURPOSE_LABEL[purpose] ?? purpose}</span>;
}

/**
 * Open and purchased POs — the live ones. One hook so every reader shares the
 * cache entry (the query-key collision test compares call sites).
 */
export function useLivePurchaseOrders() {
  return useQuery({
    queryKey: ["purchase-orders", { status: "open,purchased" }],
    queryFn: () => api.purchaseOrders({ status: "open,purchased" }),
  });
}

/** Everything a PO change can move: the PO lists, the receipt queues, and the job/account money. */
function usePoRefresh() {
  const queryClient = useQueryClient();
  return () => {
    for (const key of [["purchase-orders"], ["purchase-order"], ["receipts-needing-po"], ["receipt-review"], ["account-summary"], ["jobPOs"], ["jobReceipts"], ["jobProfitability"], ["financials"], ["inventory"], ["tools"], ["trucks"]]) {
      void queryClient.invalidateQueries({ queryKey: key });
    }
  };
}

/**
 * The PO picker on a materials receipt that has none (account page and the
 * Financials card). This job's POs first, then every other live PO.
 */
export function ReceiptPoPicker({ receiptId, jobId }: { receiptId: string; jobId: string | null }) {
  const { data: orders = [] } = useLivePurchaseOrders();
  const refresh = usePoRefresh();
  const [choice, setChoice] = useState("");
  const [error, setError] = useState<string | null>(null);
  const attach = useMutation({
    mutationFn: (poId: string) => api.attachReceiptToPurchaseOrder(poId, receiptId),
    onSuccess: () => { setError(null); setChoice(""); refresh(); },
    onError: (err) => setError((err as Error).message),
  });
  const mine = orders.filter((o) => jobId && o.jobId === jobId);
  const others = orders.filter((o) => !(jobId && o.jobId === jobId));
  const label = (o: PurchaseOrderSummary) => `${o.number} · ${o.supplier} · ${PO_PURPOSE_LABEL[o.purpose] ?? o.purpose}`;
  return (
    <span className="ml-1 inline-flex flex-wrap items-center gap-1">
      <span className="rounded bg-amber-100 px-1 text-amber-800">needs PO</span>
      <select className="field px-1 py-0.5 text-xs" value={choice} onChange={(e) => setChoice(e.target.value)}>
        <option value="">Attach to PO…</option>
        {mine.length > 0 && (
          <optgroup label="This job">
            {mine.map((o) => <option key={o.id} value={o.id}>{label(o)}</option>)}
          </optgroup>
        )}
        {others.length > 0 && (
          <optgroup label={mine.length > 0 ? "Other open POs" : "Open POs"}>
            {others.map((o) => <option key={o.id} value={o.id}>{label(o)}</option>)}
          </optgroup>
        )}
      </select>
      <button
        type="button"
        className="btn btn-secondary px-2 py-0.5 text-xs"
        disabled={!choice || attach.isPending}
        onClick={() => attach.mutate(choice)}
      >
        Attach
      </button>
      {error && <span className="w-full text-red-600">{error}</span>}
    </span>
  );
}

// ─── Start PO form ────────────────────────────────────────────────────────────

type DraftLine = { name: string; qty: string; unit: string; partNumber: string };
const emptyLine = (): DraftLine => ({ name: "", qty: "1", unit: "", partNumber: "" });

function StartPoForm({ onCreated }: { onCreated: (po: PurchaseOrderSummary) => void }) {
  const [purpose, setPurpose] = useState<PoPurpose>("truck_stock");
  const [supplier, setSupplier] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([emptyLine()]);
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => {
      const cleaned: PurchaseOrderLineInput[] = lines
        .map((l) => ({ name: l.name.trim(), qty: Number(l.qty), unit: l.unit.trim() || null, partNumber: l.partNumber.trim() || null }))
        .filter((l) => l.name && Number.isFinite(l.qty) && l.qty > 0);
      return api.startPurchaseOrder({ supplier: supplier.trim(), purpose, notes: notes.trim() || null, lines: cleaned });
    },
    onSuccess: (po) => {
      setError(null); setSupplier(""); setNotes(""); setLines([emptyLine()]); setPurpose("truck_stock");
      onCreated(po);
    },
    onError: (err) => setError((err as Error).message),
  });
  const setLine = (i: number, patch: Partial<DraftLine>) =>
    setLines((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));

  return (
    <div className="rounded-lg border border-rce-border p-3">
      <p className="text-sm font-semibold">Start PO</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {(["truck_stock", "warehouse", "tool"] as PoPurpose[]).map((p) => (
          <label key={p} className={`cursor-pointer rounded-lg border px-3 py-1.5 text-sm ${purpose === p ? "border-rce-accent bg-rce-accent/10 font-medium" : "border-rce-border"}`}>
            <input type="radio" name="po-purpose" className="mr-1" checked={purpose === p} onChange={() => setPurpose(p)} />
            {PO_PURPOSE_LABEL[p]}
          </label>
        ))}
        <input
          className="field min-w-48 flex-1"
          placeholder="Supplier (Home Depot, ASD, NES…)"
          value={supplier}
          onChange={(e) => setSupplier(e.target.value)}
        />
      </div>
      <p className="mt-1 text-xs text-rce-muted">
        {purpose === "warehouse"
          ? "Lands in the warehouse (home) — used only to transfer material to truck stock."
          : purpose === "tool"
            ? "A tool purchase — tracked separately from material."
            : "Lands on the truck. Jobs are charged from truck stock — never from a PO."}
      </p>
      <div className="mt-2 space-y-1">
        {lines.map((l, i) => (
          <div key={i} className="flex flex-wrap gap-1">
            <input className="field w-16 px-1 py-0.5 text-sm" inputMode="decimal" placeholder="Qty" value={l.qty} onChange={(e) => setLine(i, { qty: e.target.value })} />
            <input className="field w-16 px-1 py-0.5 text-sm" placeholder="Unit" value={l.unit} onChange={(e) => setLine(i, { unit: e.target.value })} />
            <input className="field min-w-40 flex-1 px-1 py-0.5 text-sm" placeholder="Item (optional — lines can come later)" value={l.name} onChange={(e) => setLine(i, { name: e.target.value })} />
            <input className="field w-28 px-1 py-0.5 text-sm" placeholder="Part #" value={l.partNumber} onChange={(e) => setLine(i, { partNumber: e.target.value })} />
          </div>
        ))}
        <button type="button" className="text-xs text-rce-accent" onClick={() => setLines((ls) => [...ls, emptyLine()])}>+ add line</button>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input className="field flex-1" placeholder="Notes (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} />
        <button type="button" className="btn btn-primary text-sm" disabled={!supplier.trim() || create.isPending} onClick={() => create.mutate()}>
          {create.isPending ? "Starting…" : "Start PO"}
        </button>
      </div>
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}

// ─── The card ────────────────────────────────────────────────────────────────

export function PurchasesCard() {
  const { data: orders = [] } = useLivePurchaseOrders();
  const { data: needing = [] } = useQuery({ queryKey: ["receipts-needing-po"], queryFn: api.receiptsNeedingPo });
  const refresh = usePoRefresh();
  const [justCreated, setJustCreated] = useState<PurchaseOrderSummary | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [showAllNeeding, setShowAllNeeding] = useState(false);
  const visible = showAll ? orders : orders.slice(0, PAGE_SIZE);
  const visibleNeeding = showAllNeeding ? needing : needing.slice(0, PAGE_SIZE);

  // Folded by default (Kyle, 2026-09-10): "N open · M to land" — open = no purchase yet,
  // to land = bought but the material has not landed on its truck / in the warehouse.
  const openCount = orders.filter((po) => po.status === "open").length;
  const toLand = orders.filter((po) => po.status === "purchased" && !po.landedAt).length;
  const summary = (
    <>
      {openCount} open · {toLand} to land
      {needing.length > 0 && <span className="text-amber-800"> · {needing.length} receipt{needing.length === 1 ? "" : "s"} need a PO</span>}
    </>
  );

  return (
    <CollapsibleCard id="purchases" title="Purchases" summary={summary}>
      <p className="mb-3 text-xs text-rce-muted">
        A purchase starts with a PO number, then the buy, then the receipt photo that verifies it. Material lands on a
        truck or in the warehouse — never on a job. Every edit asks for a reason and keeps a trail.
      </p>

      <StartPoForm onCreated={(po) => { setJustCreated(po); setOpenId(po.id); refresh(); }} />

      {justCreated && (
        <div className="mt-3 rounded-lg border border-emerald-300 bg-emerald-50 p-3">
          <p className="text-3xl font-bold tabular-nums text-emerald-900">{justCreated.number}</p>
          <p className="text-xs text-emerald-800">
            Read this at the counter · {justCreated.supplier} · {PO_PURPOSE_LABEL[justCreated.purpose]}
            {justCreated.truckName ? ` · ${justCreated.truckName}` : ""}
          </p>
        </div>
      )}

      <h3 className="mt-4 text-sm font-semibold text-rce-soft">Open and purchased ({orders.length})</h3>
      {orders.length === 0 && <p className="text-sm text-rce-muted">No open purchases.</p>}
      <ul className="mt-1 space-y-1">
        {visible.map((po) => (
          <li key={po.id} className="rounded-lg border border-rce-border px-3 py-1.5 text-sm">
            <button type="button" className="flex w-full flex-wrap items-center justify-between gap-2 text-left" onClick={() => setOpenId(openId === po.id ? null : po.id)}>
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-semibold tabular-nums">{po.number}</span>
                <PurposePill purpose={po.purpose} />
                <span>{po.supplier}</span>
                {po.truckName && <span className="text-xs text-rce-muted">{po.truckName}</span>}
                {/* Kyle, 2026-09-09: "card proves" — the money behind this PO is on a card transaction. */}
                {po.cardMatched && <span className="rounded bg-sky-100 px-1.5 py-0.5 text-[11px] text-sky-800">card</span>}
                {po.afterTheFact && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-800">after the fact</span>}
                {po.landedAt && <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[11px] text-emerald-800">landed {shortDate(po.landedAt)}</span>}
              </span>
              <span className="flex flex-wrap items-center gap-2 text-xs text-rce-muted">
                <PoStatusPill status={po.status} />
                <span>opened {shortDate(po.openedAt)}</span>
                <span>{po.receiptCount} receipt{po.receiptCount === 1 ? "" : "s"}</span>
                <span className="text-rce-accent">{openId === po.id ? "Hide" : "Open"}</span>
              </span>
            </button>
            {openId === po.id && <PoDetailPanel id={po.id} needing={needing} />}
          </li>
        ))}
      </ul>
      {orders.length > PAGE_SIZE && !showAll && (
        <button type="button" className="mt-1 text-xs text-rce-accent" onClick={() => setShowAll(true)}>Show more ({orders.length - PAGE_SIZE})</button>
      )}

      <h3 className="mt-4 text-sm font-semibold text-amber-800">Receipts needing a PO ({needing.length})</h3>
      {needing.length === 0 && <p className="text-sm text-rce-muted">Every confirmed materials receipt is on a PO.</p>}
      <ul className="mt-1 space-y-1">
        {visibleNeeding.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50/40 px-3 py-1.5 text-sm">
            <span className="min-w-0">
              <span className="font-medium">{r.vendor || "Unknown vendor"}</span>
              <span className="ml-1 text-xs text-rce-muted">{money(r.amount)} · {shortDate(r.receivedAt)}</span>
              <span className="block text-xs text-rce-muted">
                {r.accountId ? <Link to={`/accounts/${r.accountId}`} className="text-rce-accent hover:underline">{r.accountName}</Link> : null}
                {r.accountId ? " · " : ""}{r.jobLabel}
              </span>
            </span>
            <ReceiptPoPicker receiptId={r.id} jobId={r.jobId} />
          </li>
        ))}
      </ul>
      {needing.length > PAGE_SIZE && !showAllNeeding && (
        <button type="button" className="mt-1 text-xs text-rce-accent" onClick={() => setShowAllNeeding(true)}>Show more ({needing.length - PAGE_SIZE})</button>
      )}
    </CollapsibleCard>
  );
}

// ─── Detail panel: lines, trail, receipts, actions ────────────────────────────

function ReasonRow({ label, busy, onSubmit, onCancel }: { label: string; busy: boolean; onSubmit: (reason: string) => void; onCancel: () => void }) {
  const [reason, setReason] = useState("");
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <input className="field w-56 max-w-full px-1 py-0.5 text-xs" placeholder="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} />
      <button type="button" className="btn btn-primary px-2 py-0.5 text-xs" disabled={!reason.trim() || busy} onClick={() => onSubmit(reason.trim())}>{label}</button>
      <button type="button" className="text-xs text-rce-muted" onClick={onCancel}>cancel</button>
    </span>
  );
}

function PoDetailPanel({ id, needing }: { id: string; needing: ReviewReceiptRow[] }) {
  const { data: po } = useQuery({ queryKey: ["purchase-order", id], queryFn: () => api.purchaseOrder(id) });
  const refresh = usePoRefresh();
  const [error, setError] = useState<string | null>(null);
  const onError = (err: unknown) => setError((err as Error).message);
  const onDone = () => { setError(null); refresh(); };

  const transition = useMutation({
    mutationFn: ({ to, reason }: { to: "purchased" | "verified" | "closed" | "cancelled"; reason?: string }) => api.transitionPurchaseOrder(id, to, reason),
    onSuccess: onDone, onError,
  });
  const attach = useMutation({ mutationFn: (receiptId: string) => api.attachReceiptToPurchaseOrder(id, receiptId), onSuccess: onDone, onError });
  const detach = useMutation({ mutationFn: (receiptId: string) => api.detachReceiptFromPurchaseOrder(id, receiptId), onSuccess: onDone, onError });
  const [cancelling, setCancelling] = useState(false);
  const [attachChoice, setAttachChoice] = useState("");

  if (!po) return <p className="mt-2 text-xs text-rce-muted">Loading…</p>;
  const live = po.status === "open" || po.status === "purchased";
  const editable = live || po.status === "verified";

  return (
    <div className="mt-2 space-y-3 rounded-md bg-rce-bg p-3 text-xs">
      <PoHeader po={po} editable={editable} />

      <div>
        <p className="font-semibold uppercase tracking-wide text-rce-soft">Lines ({po.lines.length})</p>
        <PoLines po={po} editable={editable} />
      </div>

      <div>
        <p className="font-semibold uppercase tracking-wide text-rce-soft">Receipts ({po.receipts.length})</p>
        {po.receipts.length === 0 && <p className="text-rce-muted">No receipt attached yet — the receipt photo is what verifies the purchase.</p>}
        <ul className="mt-1 space-y-1">
          {po.receipts.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2">
              <span>{r.vendor || "Unknown vendor"} · {money(r.amount)} · {shortDate(r.receivedAt)}{r.status !== "confirmed" ? " · needs review" : ""}</span>
              {editable && (
                <button type="button" className="text-red-600 hover:underline" disabled={detach.isPending} onClick={() => detach.mutate(r.id)}>detach</button>
              )}
            </li>
          ))}
        </ul>
        {editable && needing.length > 0 && (
          <div className="mt-1 flex flex-wrap items-center gap-1">
            <select className="field px-1 py-0.5 text-xs" value={attachChoice} onChange={(e) => setAttachChoice(e.target.value)}>
              <option value="">Attach receipt…</option>
              {needing.map((r) => (
                <option key={r.id} value={r.id}>{r.vendor || "Unknown vendor"} · {money(r.amount)} · {shortDate(r.receivedAt)} · {r.jobLabel}</option>
              ))}
            </select>
            <button type="button" className="btn btn-secondary px-2 py-0.5 text-xs" disabled={!attachChoice || attach.isPending} onClick={() => { attach.mutate(attachChoice); setAttachChoice(""); }}>Attach</button>
          </div>
        )}
      </div>

      <div>
        <p className="font-semibold uppercase tracking-wide text-rce-soft">Card transactions ({po.cardSpends.length})</p>
        {po.cardSpends.length === 0 && <p className="text-rce-muted">No card transaction behind this PO yet — the card is the money; it lands here on its own.</p>}
        <ul className="mt-1 space-y-0.5">
          {po.cardSpends.map((s) => (
            <li key={s.id}>
              {s.merchantName} · <span className="tabular-nums">{money(s.amount)}</span> · {shortDate(s.occurredAt)} · {s.kind}
              {s.receiptId ? <span className="text-emerald-700"> · receipt matched</span> : s.status === "ignored" ? " · ignored" : <span className="text-amber-800"> · no receipt matched</span>}
            </li>
          ))}
        </ul>
        {po.afterTheFact && (
          <p className="mt-1 text-amber-800">Drafted after the fact from the card — attach the receipt photo and confirm the purpose before closing.</p>
        )}
      </div>

      {/* Kyle, 2026-09-09 (Build 3): material lands on the truck or in the warehouse; a tool PO lands on the register. Landing closes the PO. */}
      {(po.status === "purchased" || po.status === "verified") && !po.landedAt && (
        <div>
          <p className="font-semibold uppercase tracking-wide text-rce-soft">Land</p>
          <LandingPanel poId={po.id} onLanded={onDone} />
        </div>
      )}
      {po.landedAt && (
        <p className="rounded bg-emerald-50 px-2 py-1 text-emerald-800">
          Landed {shortDate(po.landedAt)} — {po.purpose === "tool" ? "on the tool register" : po.destinationType === "warehouse" ? "in the warehouse" : `on ${po.truckName ?? "the truck"}`}.
          {" "}<Link to="/inventory" className="text-rce-accent hover:underline">Inventory →</Link>
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {po.status === "open" && <button type="button" className="btn btn-primary text-xs" disabled={transition.isPending} onClick={() => transition.mutate({ to: "purchased" })}>Mark purchased</button>}
        {po.status === "purchased" && <button type="button" className="btn btn-primary text-xs" disabled={transition.isPending} onClick={() => transition.mutate({ to: "verified" })}>Verify</button>}
        {po.status === "verified" && <button type="button" className="btn btn-primary text-xs" disabled={transition.isPending} onClick={() => transition.mutate({ to: "closed" })}>Close</button>}
        {live && !cancelling && <button type="button" className="text-red-600 hover:underline" onClick={() => setCancelling(true)}>Cancel PO</button>}
        {live && cancelling && (
          <ReasonRow label="Cancel PO" busy={transition.isPending} onSubmit={(reason) => { transition.mutate({ to: "cancelled", reason }); setCancelling(false); }} onCancel={() => setCancelling(false)} />
        )}
      </div>
      {error && <p className="text-red-600">{error}</p>}

      <div>
        <p className="font-semibold uppercase tracking-wide text-rce-soft">Trail</p>
        <ul className="mt-1 space-y-0.5 text-rce-muted">
          {po.events.map((e) => (
            <li key={e.id}>
              {new Date(e.at).toLocaleString()} · {e.actor} · {e.kind.replaceAll("_", " ")}
              {e.reason ? ` — ${e.reason}` : ""}
              {e.kind === "edited" && e.before && e.after ? ` (${describeDiff(e.before, e.after)})` : ""}
              {e.kind === "status" && e.after ? ` → ${String(e.after.status)}` : ""}
              {e.kind === "landed" && e.after && Array.isArray(e.after.lines) ? ` (${(e.after.lines as { name: string; qtyLanded: number }[]).map((l) => `${l.qtyLanded} ${l.name}`).join(", ")})` : ""}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function describeDiff(before: Record<string, unknown>, after: Record<string, unknown>): string {
  return Object.keys(after).map((k) => `${k}: ${String(before[k] ?? "—")} → ${String(after[k] ?? "—")}`).join(", ");
}

function PoHeader({ po, editable }: { po: PurchaseOrderDetail; editable: boolean }) {
  const refresh = usePoRefresh();
  const [editing, setEditing] = useState(false);
  const [supplier, setSupplier] = useState(po.supplier);
  const [purpose, setPurpose] = useState<PoPurpose>(po.purpose);
  const [notes, setNotes] = useState(po.notes ?? "");
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (reason: string) => api.updatePurchaseOrder(po.id, { reason, supplier: supplier.trim(), purpose, notes: notes.trim() || null }),
    onSuccess: () => { setError(null); setEditing(false); refresh(); },
    onError: (err) => setError((err as Error).message),
  });
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0">
          <span className="font-semibold">{po.supplier}</span> · {PO_PURPOSE_LABEL[po.purpose]} · {po.destinationType === "warehouse" ? "Warehouse (home)" : po.truckName ?? "truck"}
          {po.jobLabel && <span className="text-rce-muted"> · opened on {po.accountId ? <Link to={`/accounts/${po.accountId}`} className="text-rce-accent hover:underline">{po.accountName}</Link> : null} {po.jobLabel}</span>}
          <span className="text-rce-muted"> · opened by {po.openedBy}{po.sentAt ? ` · emailed ${shortDate(po.sentAt)}` : ""}</span>
        </span>
        {editable && !editing && <button type="button" className="text-rce-accent" onClick={() => setEditing(true)}>Edit</button>}
      </div>
      {po.notes && !editing && <p className="text-rce-muted">Notes: {po.notes}</p>}
      {editing && (
        <div className="mt-1 flex flex-wrap items-center gap-1">
          <input className="field w-44 px-1 py-0.5 text-xs" value={supplier} onChange={(e) => setSupplier(e.target.value)} placeholder="Supplier" />
          <select className="field px-1 py-0.5 text-xs" value={purpose} onChange={(e) => setPurpose(e.target.value as PoPurpose)}>
            <option value="truck_stock">Truck stock</option>
            <option value="warehouse">Warehouse</option>
            <option value="tool">Tool</option>
          </select>
          <input className="field w-52 max-w-full px-1 py-0.5 text-xs" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes" />
          <ReasonRow label="Save" busy={save.isPending} onSubmit={(reason) => save.mutate(reason)} onCancel={() => setEditing(false)} />
        </div>
      )}
      {error && <p className="text-red-600">{error}</p>}
    </div>
  );
}

function PoLines({ po, editable }: { po: PurchaseOrderDetail; editable: boolean }) {
  const refresh = usePoRefresh();
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftLine>(emptyLine());
  const add = useMutation({
    mutationFn: () => api.addPurchaseOrderLine(po.id, {
      name: draft.name.trim(), qty: Number(draft.qty), unit: draft.unit.trim() || null, partNumber: draft.partNumber.trim() || null,
    }),
    onSuccess: () => { setError(null); setDraft(emptyLine()); refresh(); },
    onError: (err) => setError((err as Error).message),
  });
  const draftValid = draft.name.trim() !== "" && Number(draft.qty) > 0;
  return (
    <div>
      {po.lines.length === 0 && <p className="text-rce-muted">No lines yet.</p>}
      <ul className="mt-1 space-y-1">
        {po.lines.map((line) => <PoLineRow key={line.id} poId={po.id} line={line} editable={editable} onError={setError} />)}
      </ul>
      {editable && (
        <div className="mt-1 flex flex-wrap items-center gap-1">
          <input className="field w-14 px-1 py-0.5 text-xs" inputMode="decimal" placeholder="Qty" value={draft.qty} onChange={(e) => setDraft({ ...draft, qty: e.target.value })} />
          <input className="field w-14 px-1 py-0.5 text-xs" placeholder="Unit" value={draft.unit} onChange={(e) => setDraft({ ...draft, unit: e.target.value })} />
          <input className="field w-48 px-1 py-0.5 text-xs" placeholder="Add a line" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          <input className="field w-24 px-1 py-0.5 text-xs" placeholder="Part #" value={draft.partNumber} onChange={(e) => setDraft({ ...draft, partNumber: e.target.value })} />
          <button type="button" className="btn btn-secondary px-2 py-0.5 text-xs" disabled={!draftValid || add.isPending} onClick={() => add.mutate()}>Add line</button>
        </div>
      )}
      {error && <p className="text-red-600">{error}</p>}
    </div>
  );
}

function PoLineRow({ poId, line, editable, onError }: { poId: string; line: PurchaseOrderLine; editable: boolean; onError: (msg: string | null) => void }) {
  const refresh = usePoRefresh();
  const [mode, setMode] = useState<"view" | "edit" | "remove">("view");
  const [name, setName] = useState(line.name);
  const [qty, setQty] = useState(String(line.qty));
  const [unit, setUnit] = useState(line.unit ?? "");
  const [partNumber, setPartNumber] = useState(line.partNumber ?? "");
  const edit = useMutation({
    mutationFn: (reason: string) => api.editPurchaseOrderLine(poId, line.id, {
      reason, name: name.trim(), qty: Number(qty), unit: unit.trim() || null, partNumber: partNumber.trim() || null,
    }),
    onSuccess: () => { onError(null); setMode("view"); refresh(); },
    onError: (err) => onError((err as Error).message),
  });
  const remove = useMutation({
    mutationFn: (reason: string) => api.removePurchaseOrderLine(poId, line.id, reason),
    onSuccess: () => { onError(null); refresh(); },
    onError: (err) => onError((err as Error).message),
  });
  if (mode === "edit") {
    return (
      <li className="flex flex-wrap items-center gap-1">
        <input className="field w-14 px-1 py-0.5 text-xs" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} />
        <input className="field w-14 px-1 py-0.5 text-xs" placeholder="Unit" value={unit} onChange={(e) => setUnit(e.target.value)} />
        <input className="field w-48 px-1 py-0.5 text-xs" value={name} onChange={(e) => setName(e.target.value)} />
        <input className="field w-24 px-1 py-0.5 text-xs" placeholder="Part #" value={partNumber} onChange={(e) => setPartNumber(e.target.value)} />
        <ReasonRow label="Save" busy={edit.isPending} onSubmit={(reason) => edit.mutate(reason)} onCancel={() => setMode("view")} />
      </li>
    );
  }
  return (
    <li className="flex flex-wrap items-center justify-between gap-2">
      <span>
        {line.qty} {line.unit ?? ""} {line.name}{line.partNumber ? ` (#${line.partNumber})` : ""}
        {line.unitCost != null ? <span className="text-rce-muted"> · {money(line.unitCost)}/ea</span> : null}
        {line.qtyLanded != null ? <span className="text-rce-muted"> · landed {line.qtyLanded}</span> : null}
      </span>
      {editable && mode === "view" && (
        <span className="flex gap-2">
          <button type="button" className="text-rce-accent" onClick={() => setMode("edit")}>edit</button>
          <button type="button" className="text-red-600" onClick={() => setMode("remove")}>remove</button>
        </span>
      )}
      {editable && mode === "remove" && (
        <ReasonRow label="Remove line" busy={remove.isPending} onSubmit={(reason) => remove.mutate(reason)} onCancel={() => setMode("view")} />
      )}
    </li>
  );
}
