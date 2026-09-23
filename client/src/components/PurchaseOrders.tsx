/**
 * Purchase orders in the CRM (Kyle, 2026-09-09).
 *
 * "Purchasing needs to start with a P.O. number then the purchase and photo
 * verification of the receipt." The Purchases card on Financials starts a PO
 * (purpose chosen: Truck stock default / Warehouse / Tool — "Tool purchases
 * will be done separately"), shows the number big enough to read at the
 * counter, lists open and purchased POs, and pairs loose materials receipts
 * with a PO. "We need to be able to edit manually in case there are errors
 * found" — every edit asks for a one-line reason that lands in the trail.
 *
 * A row opens the P.O.'s DRAWER (`PoDetailPanel` — lines, money, receipts,
 * landing, status, the trail) over this list. Until 2026-09-21 the same panel
 * also expanded in place under the row; that was the duplicate the drawers
 * plan's Phase 6 deleted ("drawers win", Kyle). No new windows or tabs, no
 * endless lists — rows cap at 8 with Show more.
 */

import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import type { PurchaseOrderLineInput } from "../lib/api";
import { OFF_CARD_METHOD_LABEL, isActiveJob } from "../lib/types";
import type { OffCardMethod, PoPurpose, PoStatus, PurchaseOrderDetail, PurchaseOrderLine, PurchaseOrderSummary, ReviewReceiptRow } from "../lib/types";
import { money, shortDate } from "../lib/utils";
import { useDrawerParams } from "../lib/drawers";
import { LandingPanel } from "./LandingPanel";
import { CollapsibleCard } from "./CollapsibleCard";
import { OpenDrawerButton } from "./drawers/OpenDrawerButton";

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

/**
 * "The P.O. is the money, the receipt is proof" (Kyle, 2026-09-19): a P.O. that
 * has money and no proof needs its receipt attached before it can verify.
 */
export function poNeedsProof(po: Pick<PurchaseOrderSummary, "moneyTotal" | "proofCount">): boolean {
  return po.moneyTotal > 0 && po.proofCount === 0;
}

function PurposePill({ purpose }: { purpose: PoPurpose | string }) {
  return <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-700">{PO_PURPOSE_LABEL[purpose] ?? purpose}</span>;
}

/**
 * Retry button for a receipt stuck in pending_review with no vendor/amount
 * (Unit 2, Kyle 2026-09-12 — async Vision parsing needs an operator retry).
 * Hits the admin-only reparse route; safe to click repeatedly since it only
 * fills fields still empty and can never create a second receipt.
 */
export function ReparseReceiptButton({ receiptId }: { receiptId: string }) {
  const refresh = usePoRefresh();
  const [error, setError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: () => api.reparseReceipt(receiptId),
    onSuccess: () => { setError(null); refresh(); },
    onError: (err) => setError((err as Error).message),
  });
  return (
    <span className="flex items-center gap-1">
      <button
        type="button"
        className="rounded border border-red-300 bg-white px-1.5 py-0.5 text-[11px] text-red-800 disabled:opacity-50"
        disabled={mutation.isPending}
        onClick={() => mutation.mutate()}
      >
        {mutation.isPending ? "Re-parsing…" : "Re-parse"}
      </button>
      {error && <span className="text-[11px] text-red-600">{error}</span>}
    </span>
  );
}

/**
 * Open and purchased POs — the live ones. One hook so every reader shares the
 * cache entry (the query-key collision test compares call sites).
 *
 * Contract deliberately unchanged (Kyle's ruling 2026-09-12, Unit 4): this is
 * also the source list for ReceiptPoPicker's attach-target dropdown, and a
 * verified PO must not be added there — see useRecentlyVerifiedPurchaseOrders
 * below for the Financials-list-only fix.
 */
export function useLivePurchaseOrders() {
  return useQuery({
    queryKey: ["purchase-orders", { status: "open,purchased" }],
    queryFn: () => api.purchaseOrders({ status: "open,purchased" }),
  });
}

/**
 * Landed POs — what a "Returned to store" picker should offer (defect fix,
 * 2026-09-22). Stock sitting on a truck or in the warehouse got there by
 * LANDING, not by being "live" in the open/purchased sense: `useLivePurchaseOrders`
 * is close to the exact complement of what a returns desk needs. `landedAt != null`
 * is the test for "this material was received" — a closed PO that landed is a
 * perfectly good return target; an open PO never is. Own queryKey so this never
 * collides with useLivePurchaseOrders' cache entry (ReceiptPoPicker and the
 * refund-attach picker on TrucksPage keep using that one, untouched, per the
 * 2026-09-12 ruling above).
 */
export function useLandedPurchaseOrders() {
  return useQuery({
    queryKey: ["purchase-orders", "landed"],
    queryFn: () => api.purchaseOrders({ status: "purchased,verified,closed" }),
    select: (data) =>
      data
        .filter((po) => po.landedAt)
        .sort((a, b) => new Date(b.landedAt as string).getTime() - new Date(a.landedAt as string).getTime()),
  });
}

const VERIFIED_RECENCY_DAYS = 7;

/**
 * Verified POs from roughly the last 7 days (Kyle's ruling 2026-09-12, Unit 4).
 *
 * A PO moves to "verified" the instant its receipt photo lands — on
 * 2026-09-11 that made two successful uploads vanish from the "Open and
 * purchased" list at the exact moment they succeeded, so a partial receipt
 * loss read as a total one. This is a separate query (not a widened
 * useLivePurchaseOrders) specifically so ReceiptPoPicker's attach-target list
 * — which shares that hook — stays untouched; only the Financials display
 * list gains these rows.
 */
function useRecentlyVerifiedPurchaseOrders() {
  return useQuery({
    // A string literal here, not `{ status: "verified" }` — the query-key
    // collision test (tests/queryKeyCollisions.test.ts) compares object-shaped
    // key segments by property NAME only, so an object with the same `status`
    // property as useLivePurchaseOrders' key reads as the same cache entry
    // even though the values differ. The leading "purchase-orders" segment is
    // kept so usePoRefresh's prefix invalidation still reaches this query.
    queryKey: ["purchase-orders", "verified"],
    queryFn: () => api.purchaseOrders({ status: "verified" }),
    select: (data) => {
      const cutoff = Date.now() - VERIFIED_RECENCY_DAYS * 24 * 60 * 60 * 1000;
      return data.filter((po) => po.verifiedAt && new Date(po.verifiedAt).getTime() >= cutoff);
    },
  });
}

const PENDING_REVIEW_STALE_MINUTES = 60;

/**
 * Every receipt waiting for review (Kyle, 2026-09-08) — one hook, one cache entry,
 * read by the Purchases card and the Purchasing & Stock page's review list and strip
 * (tab separation, 2026-09-20; it used to be FinancialsPage that read it).
 */
export function usePendingReviewReceipts() {
  return useQuery({ queryKey: ["receipt-review"], queryFn: api.pendingReceipts });
}

/**
 * Everything a PO change can move: the PO lists, the receipt queues, the
 * job/account money, and (AttachProofButton is used from TrucksPage's
 * "needing a receipt" queue too, 2026-09-19) the truck ledger and its card
 * spend.
 */
export function usePoRefresh() {
  const queryClient = useQueryClient();
  return () => {
    // ["receipt"] is the receipt drawer's own record (2026-09-20) — attaching, detaching or
    // waiving from either side must redraw the other.
    for (const key of [["purchase-orders"], ["purchase-order"], ["receipts-needing-po"], ["receipt-review"], ["receipt"], ["account-summary"], ["jobPOs"], ["jobReceipts"], ["jobProfitability"], ["financials"], ["inventory"], ["tools"], ["trucks"], ["truck"], ["card-spend"]]) {
      void queryClient.invalidateQueries({ queryKey: key });
    }
  };
}

/**
 * Confirmed materials receipts with no P.O. — one hook, because the Purchases card and the
 * P.O. drawer (2026-09-20) both feed it to PoDetailPanel's "link one already uploaded" list,
 * and the query-key collision test compares call sites by text.
 */
export function useReceiptsNeedingPo() {
  return useQuery({ queryKey: ["receipts-needing-po"], queryFn: api.receiptsNeedingPo });
}

/**
 * Correct a receipt's purchase date (2026-09-14, legacy purchase close-out Unit 4).
 * The only place this can be fixed by hand — a Vision year mis-parse (e.g. 2022
 * instead of 2026) silently drops the receipt's amount from the P&L and keeps its
 * card transaction from ever matching, both of which are date-windowed. Collapsed
 * to "edit date" by default so the common case (nothing wrong) stays out of the way.
 */
export function ReceiptDateEditor({ receiptId, receivedAt }: { receiptId: string; receivedAt: string }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(receivedAt.slice(0, 10));
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => api.reviewReceipt(receiptId, { receivedAt: value }),
    onSuccess: () => { setError(null); setEditing(false); void queryClient.invalidateQueries(); },
    onError: (err) => setError((err as Error).message),
  });

  if (!editing) {
    return (
      <button type="button" className="btn btn-secondary px-2 py-0.5 text-xs min-h-0" onClick={() => setEditing(true)}>
        edit date
      </button>
    );
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <input
        type="date"
        className="field px-1 py-0.5 text-xs"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <button type="button" className="btn btn-secondary px-2 py-0.5 text-xs" disabled={save.isPending || !value} onClick={() => save.mutate()}>
        Save
      </button>
      <button type="button" className="btn btn-secondary px-2 py-0.5 text-xs min-h-0" onClick={() => { setEditing(false); setError(null); }}>cancel</button>
      {error && <span className="w-full text-red-600">{error}</span>}
    </span>
  );
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

/**
 * "No PO — legacy" (2026-09-14, legacy purchase close-out Unit 2). Kyle: "we
 * are not getting anywhere trying to attach things that don't exist to them" —
 * a receipt whose PO can never exist (its photo was lost, e.g. the 9/11 upload
 * failure) leaves this queue by being WAIVED, never attached. Attaching would
 * silently drop it from the job's receipt rung with nothing to pick it back up
 * (this is how the Daughdrill $381.90 was lost). Same required-reason
 * ReasonRow pattern as the rest of this card; ReasonRow is a hoisted function
 * declaration further down this file.
 */
export function WaivePoAction({ receiptId }: { receiptId: string }) {
  const refresh = usePoRefresh();
  const [waiving, setWaiving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const waive = useMutation({
    mutationFn: (reason: string) => api.waiveReceiptPo(receiptId, reason),
    onSuccess: () => { setError(null); setWaiving(false); refresh(); },
    onError: (err) => setError((err as Error).message),
  });

  if (!waiving) {
    return (
      <button type="button" className="btn btn-secondary px-2 py-0.5 text-xs min-h-0" onClick={() => setWaiving(true)}>
        No PO — legacy
      </button>
    );
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <ReasonRow label="Waive" busy={waive.isPending} onSubmit={(reason) => waive.mutate(reason)} onCancel={() => setWaiving(false)} />
      {error && <span className="w-full text-red-600">{error}</span>}
    </span>
  );
}

/**
 * Attach a receipt photo or PDF straight onto a P.O. — the one uploader, reused
 * everywhere a P.O. needs its proof (Kyle, 2026-09-19: "prompts for a picture
 * of the receipt or upload of a pdf"). Attaching fires
 * verifyPurchaseOrderIfComplete server-side, so a P.O. that already has its
 * money moves to verified the moment this succeeds — no second step.
 */
export function AttachProofButton({ poId, label = "Attach receipt" }: { poId: string; label?: string }) {
  const refresh = usePoRefresh();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const upload = useMutation({
    mutationFn: (file: File) => api.uploadPoReceipt(poId, { image: file }),
    onSuccess: (res) => {
      setError(null);
      setNote(res.note ?? `Receipt read: ${money(res.amount)}${res.lineCount > 0 ? ` · ${res.lineCount} line${res.lineCount === 1 ? "" : "s"}` : " · no lines read — type them or land by hand"}`);
      refresh();
    },
    onError: (err) => setError((err as Error).message),
  });
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <input
        ref={fileRef}
        type="file"
        accept="image/*,application/pdf"
        capture="environment"
        className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) upload.mutate(f); e.target.value = ""; }}
      />
      <button type="button" className="btn btn-secondary px-2 py-0.5 text-xs" disabled={upload.isPending} onClick={() => fileRef.current?.click()}>
        {upload.isPending ? "Reading…" : label}
      </button>
      {note && <span className="text-rce-muted">{note}</span>}
      {error && <span className="text-red-600">{error}</span>}
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
  const [jobId, setJobId] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([emptyLine()]);
  const [error, setError] = useState<string | null>(null);
  // Kyle's ruling 2026-09-15: "All items on a P.O. should land automatically on
  // the job it was bought for." Optional and defaults to none — a truck restock
  // PO carries no job and never will. Same underlying call JobsPage makes for its
  // "active" tab (api.jobs({ archived: false })), filtered with the same
  // isActiveJob helper AccountsPage/AccountDetailPage already use for "current
  // work" — a job finished or cancelled months ago is not a real target to buy
  // for. A distinct string key segment, not `{ archived: false }` — that object
  // shape structurally collides with JobsPage's `{ archived }` key under
  // tests/queryKeyCollisions.test.ts even though the two call sites agree today,
  // exactly the trap useRecentlyVerifiedPurchaseOrders' comment above warns about.
  const { data: jobs = [] } = useQuery({ queryKey: ["jobs", "open-for-po-picker"], queryFn: () => api.jobs({ archived: false }) });
  const openJobs = jobs.filter((j) => isActiveJob(j.status));
  const create = useMutation({
    mutationFn: () => {
      const cleaned: PurchaseOrderLineInput[] = lines
        .map((l) => ({ name: l.name.trim(), qty: Number(l.qty), unit: l.unit.trim() || null, partNumber: l.partNumber.trim() || null }))
        .filter((l) => l.name && Number.isFinite(l.qty) && l.qty > 0);
      return api.startPurchaseOrder({ supplier: supplier.trim(), purpose, jobId: jobId || null, notes: notes.trim() || null, lines: cleaned });
    },
    onSuccess: (po) => {
      setError(null); setSupplier(""); setNotes(""); setJobId(""); setLines([emptyLine()]); setPurpose("truck_stock");
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
        <select className="field min-w-48 flex-1" value={jobId} onChange={(e) => setJobId(e.target.value)}>
          <option value="">No job (truck/warehouse stock)</option>
          {openJobs.map((j) => (
            <option key={j.visitId} value={j.visitId}>{j.customer.name} — {j.property.addressLine1}, {j.property.city}</option>
          ))}
        </select>
      </div>
      <p className="mt-1 text-xs text-rce-muted">
        {purpose === "warehouse"
          ? "Lands in the warehouse (home)."
          : purpose === "tool"
            ? "A tool purchase — tracked separately from material, never charged to a job."
            : "Lands on the truck."}
        {purpose !== "tool" && (jobId
          ? " Tagged to a job: the moment it lands, every line is charged to that job and the stock nets back out. Whatever is left over gets counted back at close-out."
          : " No job: it stays as stock until a job uses it.")}
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
        <button type="button" className="btn btn-secondary px-2 py-0.5 text-xs min-h-0" onClick={() => setLines((ls) => [...ls, emptyLine()])}>+ add line</button>
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
  const { data: recentlyVerified = [] } = useRecentlyVerifiedPurchaseOrders();
  const { data: needing = [] } = useReceiptsNeedingPo();
  const { data: pendingReview = [] } = usePendingReviewReceipts();
  const drawers = useDrawerParams();
  // Unit 2 (Kyle, 2026-09-12): receipts uploaded with no vendor/amount wait on an
  // async Vision parse. Past this many minutes it almost certainly finished (or
  // died) — a number he cannot miss, not a log line, per the binding condition
  // on making pending_review the normal state.
  const stalePending = pendingReview.filter(
    (r) => !r.vendor && r.amount <= 0 && Date.now() - new Date(r.receivedAt).getTime() > PENDING_REVIEW_STALE_MINUTES * 60 * 1000,
  );
  const refresh = usePoRefresh();
  const [justCreated, setJustCreated] = useState<PurchaseOrderSummary | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [showAllNeeding, setShowAllNeeding] = useState(false);
  // Display-only merge: a receipt that just verified stays visible for
  // VERIFIED_RECENCY_DAYS instead of disappearing the instant it succeeds
  // (Unit 4). Sorted to match the server's own openedAt-desc ordering.
  const displayOrders = [...orders, ...recentlyVerified].sort(
    (a, b) => new Date(b.openedAt).getTime() - new Date(a.openedAt).getTime(),
  );
  const visible = showAll ? displayOrders : displayOrders.slice(0, PAGE_SIZE);
  const visibleNeeding = showAllNeeding ? needing : needing.slice(0, PAGE_SIZE);

  // Folded by default (Kyle, 2026-09-10): "N open · M to land" — open = no purchase yet,
  // to land = bought but the material has not landed on its truck / in the warehouse.
  const openCount = orders.filter((po) => po.status === "open").length;
  const toLand = orders.filter((po) => po.status === "purchased" && !po.landedAt).length;
  const needsProofCount = orders.filter(poNeedsProof).length;
  const summary = (
    <>
      {openCount} open · {toLand} to land
      {needsProofCount > 0 && <span className="text-amber-800"> · {needsProofCount} need{needsProofCount === 1 ? "s" : ""} proof</span>}
      {needing.length > 0 && <span className="text-amber-800"> · {needing.length} receipt{needing.length === 1 ? "" : "s"} need a PO</span>}
      {stalePending.length > 0 && <span className="text-red-800"> · {stalePending.length} stuck in review</span>}
    </>
  );

  return (
    <CollapsibleCard id="purchases" title="Purchases" summary={summary}>
      <p className="mb-3 text-xs text-rce-muted">
        A purchase starts with a PO number, then the buy, then the receipt photo that verifies it. Material lands on a
        truck or in the warehouse — never on a job. Every edit asks for a reason and keeps a trail.
      </p>

      {/* The new P.O. opens in its drawer straight away — the number is the drawer's title, so
          it is still the big thing on screen at the counter. */}
      <StartPoForm onCreated={(po) => { setJustCreated(po); drawers.open("po", po.id); refresh(); }} />

      {justCreated && (
        <div className="mt-3 rounded-lg border border-emerald-300 bg-emerald-50 p-3">
          <p className="text-3xl font-bold tabular-nums text-emerald-900">{justCreated.number}</p>
          <p className="text-xs text-emerald-800">
            Read this at the counter · {justCreated.supplier} · {PO_PURPOSE_LABEL[justCreated.purpose]}
            {justCreated.truckName ? ` · ${justCreated.truckName}` : ""}
          </p>
        </div>
      )}

      <h3 className="mt-4 text-sm font-semibold text-rce-soft">Open and purchased ({displayOrders.length})</h3>
      {displayOrders.length === 0 && <p className="text-sm text-rce-muted">No open purchases.</p>}
      <ul className="mt-1 space-y-1">
        {visible.map((po) => (
          <li key={po.id} className="rounded-lg border border-rce-border px-3 py-1.5 text-sm">
            <button type="button" className="flex w-full flex-wrap items-center justify-between gap-2 text-left" title="Open this P.O." onClick={() => drawers.open("po", po.id)}>
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-semibold tabular-nums">{po.number}</span>
                <PurposePill purpose={po.purpose} />
                <span>{po.supplier}</span>
                {po.truckName && <span className="text-xs text-rce-muted">{po.truckName}</span>}
                {po.jobLabel && <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-700">{po.jobLabel}</span>}
                {/* Kyle, 2026-09-09: "card proves" — the money behind this PO is on a card transaction. */}
                {po.cardMatched && <span className="rounded bg-sky-100 px-1.5 py-0.5 text-[11px] text-sky-800">card</span>}
                {po.afterTheFact && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-800">after the fact</span>}
                {poNeedsProof(po) && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-800">needs proof</span>}
                {po.landedAt && <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[11px] text-emerald-800">landed {shortDate(po.landedAt)}</span>}
              </span>
              <span className="flex flex-wrap items-center gap-2 text-xs text-rce-muted">
                <PoStatusPill status={po.status} />
                <span>opened {shortDate(po.openedAt)}</span>
                <span>{po.receiptCount} receipt{po.receiptCount === 1 ? "" : "s"}</span>
                <span className="text-rce-accent">Open</span>
              </span>
            </button>
            {/*
              Kyle, 2026-09-19: "the system prompts for proof" — right on the row, no
              need to expand the panel first. "PO-XXXX, $651.73 at Home Depot —
              attach the receipt."
            */}
            {poNeedsProof(po) && (
              <div className="mt-1 flex flex-wrap items-center gap-2 rounded bg-amber-50/60 px-2 py-1 text-xs text-amber-900">
                <span>{money(po.moneyTotal)} at {po.supplier} — attach the receipt</span>
                <AttachProofButton poId={po.id} />
              </div>
            )}
          </li>
        ))}
      </ul>
      {displayOrders.length > PAGE_SIZE && !showAll && (
        <button type="button" className="btn btn-secondary mt-1 px-2 py-0.5 text-xs min-h-0" onClick={() => setShowAll(true)}>Show more ({displayOrders.length - PAGE_SIZE})</button>
      )}

      {stalePending.length > 0 && (
        <div className="mt-4 rounded-lg border border-red-300 bg-red-50 p-2">
          <p className="text-sm font-semibold text-red-800">
            {stalePending.length} receipt{stalePending.length === 1 ? "" : "s"} stuck in review — no vendor or amount after {PENDING_REVIEW_STALE_MINUTES} minutes
          </p>
          <ul className="mt-1 space-y-1">
            {stalePending.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 text-xs text-red-900">
                <span>{shortDate(r.receivedAt)} · {r.jobLabel}</span>
                <ReparseReceiptButton receiptId={r.id} />
              </li>
            ))}
          </ul>
        </div>
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
            <span className="flex flex-wrap items-center gap-2">
              <ReceiptDateEditor receiptId={r.id} receivedAt={r.receivedAt} />
              <ReceiptPoPicker receiptId={r.id} jobId={r.jobId} />
              <WaivePoAction receiptId={r.id} />
            </span>
          </li>
        ))}
      </ul>
      {needing.length > PAGE_SIZE && !showAllNeeding && (
        <button type="button" className="btn btn-secondary mt-1 px-2 py-0.5 text-xs min-h-0" onClick={() => setShowAllNeeding(true)}>Show more ({needing.length - PAGE_SIZE})</button>
      )}
    </CollapsibleCard>
  );
}

// ─── Detail panel: lines, trail, receipts, actions ────────────────────────────

/** Exported (PUNCHLIST K3) so the job screen's own P.O. cancel can ask for a typed reason
    through the same widget the P.O. drawer uses, instead of carrying a second, canned one. */
export function ReasonRow({ label, busy, onSubmit, onCancel }: { label: string; busy: boolean; onSubmit: (reason: string) => void; onCancel: () => void }) {
  const [reason, setReason] = useState("");
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <input className="field w-56 max-w-full px-1 py-0.5 text-xs" placeholder="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} />
      <button type="button" className="btn btn-primary px-2 py-0.5 text-xs" disabled={!reason.trim() || busy} onClick={() => onSubmit(reason.trim())}>{label}</button>
      <button type="button" className="btn btn-secondary px-2 py-0.5 text-xs min-h-0" onClick={onCancel}>cancel</button>
    </span>
  );
}

/**
 * One PO's full detail — shared so every reader is the same cache entry
 * (queryKeyCollisions.test.ts compares call sites by exact text; two
 * differently-named local params calling the same endpoint would otherwise
 * read as two different shapes under one key). JobCloseoutPanel.tsx's
 * job-screen receipt list reads this too.
 */
export function usePurchaseOrderDetail(id: string, enabled = true) {
  return useQuery({ queryKey: ["purchase-order", id], queryFn: () => api.purchaseOrder(id), enabled });
}

export function PoDetailPanel({ id, needing }: { id: string; needing: ReviewReceiptRow[] }) {
  const { data: po } = usePurchaseOrderDetail(id);
  const refresh = usePoRefresh();
  const drawers = useDrawerParams();
  const [error, setError] = useState<string | null>(null);
  const onError = (err: unknown) => setError((err as Error).message);
  const onDone = () => { setError(null); refresh(); };

  const transition = useMutation({
    mutationFn: ({ to, reason }: { to: "purchased" | "verified" | "closed" | "cancelled"; reason?: string }) => api.transitionPurchaseOrder(id, to, reason),
    onSuccess: onDone, onError,
  });
  const attach = useMutation({ mutationFn: (receiptId: string) => api.attachReceiptToPurchaseOrder(id, receiptId), onSuccess: () => { setLinking(false); onDone(); }, onError });
  const detach = useMutation({ mutationFn: (receiptId: string) => api.detachReceiptFromPurchaseOrder(id, receiptId), onSuccess: onDone, onError });
  const [cancelling, setCancelling] = useState(false);
  const [linking, setLinking] = useState(false);
  const [attachChoice, setAttachChoice] = useState("");
  // Only a receipt that belongs to nothing yet can be linked by hand; everything else is an upload.
  const loose = needing.filter((r) => !r.jobId);

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
              {/* The receipt carries its own actions (2026-09-20): the row opens its drawer. */}
              <OpenDrawerButton kind="receipt" id={r.id} onOpen={drawers.open} className="text-left hover:underline">
                {r.vendor || "Unknown vendor"} · {money(r.amount)} · {shortDate(r.receivedAt)}{r.status !== "confirmed" ? " · needs review" : ""}
              </OpenDrawerButton>
              {editable && (
                <button type="button" className="btn btn-danger px-2 py-0.5 text-xs min-h-0" disabled={detach.isPending} onClick={() => detach.mutate(r.id)}>detach</button>
              )}
            </li>
          ))}
        </ul>
        {/*
          Kyle, 2026-09-11: "This should not pull up existing job costs but be an
          upload as the receipts will be photos added from the phone or computer."
          The picker is gone; linking a receipt that is on no job and no PO stays
          behind a toggle for the rare case where the photo is already in.
        */}
        {editable && (
          <div className="mt-1 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <AttachProofButton poId={id} label="Upload receipt photo/PDF" />
              {loose.length > 0 && !linking && (
                <button type="button" className="btn btn-secondary px-2 py-0.5 text-xs min-h-0" onClick={() => setLinking(true)}>or link one already uploaded</button>
              )}
            </div>
            {linking && loose.length > 0 && (
              <div className="flex flex-wrap items-center gap-1">
                <select className="field px-1 py-0.5 text-xs" value={attachChoice} onChange={(e) => setAttachChoice(e.target.value)}>
                  <option value="">Receipts on no job and no PO…</option>
                  {loose.map((r) => (
                    <option key={r.id} value={r.id}>{r.vendor || "Unknown vendor"} · {money(r.amount)} · {shortDate(r.receivedAt)}</option>
                  ))}
                </select>
                <button type="button" className="btn btn-secondary px-2 py-0.5 text-xs" disabled={!attachChoice || attach.isPending} onClick={() => { attach.mutate(attachChoice); setAttachChoice(""); }}>Link</button>
                <button type="button" className="btn btn-secondary px-2 py-0.5 text-xs min-h-0" onClick={() => { setLinking(false); setAttachChoice(""); }}>cancel</button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* THE MONEY (Kyle, 2026-09-19: "the P.O. is the money") — the charges and the typed not-on-card amount; the receipts above are the proof. */}
      <PoMoney po={po} />

      {po.afterTheFact && (
        <p className="text-amber-800">Drafted after the fact from the card — attach the receipt photo and confirm the purpose before closing.</p>
      )}

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
          {" "}<Link to="/purchasing" className="btn btn-secondary px-2 py-0.5 text-xs min-h-0">Stock on hand →</Link>
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {po.status === "open" && <button type="button" className="btn btn-primary text-xs" disabled={transition.isPending} onClick={() => transition.mutate({ to: "purchased" })}>Mark purchased</button>}
        {po.status === "purchased" && <button type="button" className="btn btn-primary text-xs" disabled={transition.isPending} onClick={() => transition.mutate({ to: "verified" })}>Verify</button>}
        {po.status === "verified" && <button type="button" className="btn btn-primary text-xs" disabled={transition.isPending} onClick={() => transition.mutate({ to: "closed" })}>Close</button>}
        {live && !cancelling && <button type="button" className="btn btn-danger text-xs" onClick={() => setCancelling(true)}>Cancel PO</button>}
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

/**
 * The money on the P.O. (Kyle, 2026-09-19): every card charge (many per P.O. —
 * a split is two rows here), each with its way OUT (unlink with a reason, or
 * ignore), plus the typed not-on-card amount — editable in any status, reason
 * required, null = "it was on the card after all".
 */
function PoMoney({ po }: { po: PurchaseOrderDetail }) {
  const refresh = usePoRefresh();
  const [error, setError] = useState<string | null>(null);
  const [typing, setTyping] = useState(false);
  const [amount, setAmount] = useState(po.offCardAmount != null ? String(po.offCardAmount) : "");
  const [method, setMethod] = useState<OffCardMethod>(po.offCardMethod ?? "cash");
  const [at, setAt] = useState(po.offCardAt ? po.offCardAt.slice(0, 10) : "");
  const [note, setNote] = useState(po.offCardNote ?? "");
  const onError = (err: unknown) => setError((err as Error).message);
  const save = useMutation({
    mutationFn: (input: { reason: string; clear?: boolean }) => api.setPurchaseOrderMoney(po.id, input.clear
      ? { reason: input.reason, offCardAmount: null }
      : { reason: input.reason, offCardAmount: Number(amount), offCardMethod: method, offCardNote: note.trim() || null, ...(at ? { offCardAt: at } : {}) }),
    onSuccess: () => { setError(null); setTyping(false); refresh(); },
    onError,
  });
  const charge = useMutation({
    mutationFn: (input: { id: string; reason: string; purchaseOrderId?: null; status?: "ignored" | "unmatched" }) => api.updateCardSpend(input.id, input),
    onSuccess: () => { setError(null); refresh(); },
    onError,
  });
  const ask = (prompt: string) => { const reason = window.prompt(prompt); return reason?.trim() ? reason.trim() : null; };
  return (
    <div>
      <p className="font-semibold uppercase tracking-wide text-rce-soft">Money — {money(po.moneyTotal)}</p>
      <ul className="mt-1 space-y-0.5">
        {po.cardSpends.map((s) => (
          <li key={s.id} className={`flex flex-wrap items-center justify-between gap-2 ${s.status === "ignored" ? "text-rce-muted line-through" : ""}`}>
            <span>
              Card · {s.merchantName} · <span className="tabular-nums">{money(s.amount)}</span> · {shortDate(s.occurredAt)} · {s.kind}
              {s.status === "ignored" && <span className="ml-1 no-underline"> · ignored{s.ignoredReason ? ` — ${s.ignoredReason}` : ""}</span>}
            </span>
            <span className="flex gap-1">
              {s.status === "ignored"
                ? <button type="button" className="btn btn-secondary px-2 py-0.5 text-xs min-h-0" onClick={() => { const reason = ask("Reason for counting this charge again?"); if (reason) charge.mutate({ id: s.id, status: "unmatched", reason }); }}>count again</button>
                : <button type="button" className="btn btn-secondary px-2 py-0.5 text-xs min-h-0" onClick={() => { const reason = ask("Reason for ignoring this charge (it leaves every money figure)?"); if (reason) charge.mutate({ id: s.id, status: "ignored", reason }); }}>ignore</button>}
              <button type="button" className="btn btn-danger px-2 py-0.5 text-xs min-h-0" onClick={() => { const reason = ask(`Reason for taking this charge off ${po.number}?`); if (reason) charge.mutate({ id: s.id, purchaseOrderId: null, reason }); }}>unlink</button>
            </span>
          </li>
        ))}
        {po.cardSpends.length === 0 && <li className="text-rce-muted">No card charge on this P.O. — a swipe at {po.supplier} lands here on its own.</li>}
        <li className="flex flex-wrap items-center justify-between gap-2">
          <span>
            {po.offCardAmount != null
              ? <>Not on the card · <span className="tabular-nums">{money(po.offCardAmount)}</span> · {OFF_CARD_METHOD_LABEL[po.offCardMethod ?? "unknown"]}{po.offCardAt ? ` · ${shortDate(po.offCardAt)}` : ""}{po.offCardNote ? <span className="text-rce-muted"> — {po.offCardNote}</span> : null}</>
              : <span className="text-rce-muted">Paid cash, check or a personal card? Type the amount — it is the money when there is no charge.</span>}
          </span>
          {!typing && (
            <span className="flex gap-1">
              <button type="button" className="btn btn-secondary px-2 py-0.5 text-xs min-h-0" onClick={() => setTyping(true)}>{po.offCardAmount != null ? "edit" : "type amount"}</button>
              {po.offCardAmount != null && (
                <button type="button" className="btn btn-danger px-2 py-0.5 text-xs min-h-0" onClick={() => { const reason = ask("Reason for removing the typed amount (it was on the card after all)?"); if (reason) save.mutate({ reason, clear: true }); }}>remove</button>
              )}
            </span>
          )}
        </li>
      </ul>
      {typing && (
        <div className="mt-1 flex flex-wrap items-center gap-1">
          <input className="field w-24 px-1 py-0.5 text-xs" inputMode="decimal" placeholder="Amount" value={amount} onChange={(e) => setAmount(e.target.value)} />
          <select className="field px-1 py-0.5 text-xs" value={method} onChange={(e) => setMethod(e.target.value as OffCardMethod)}>
            {(Object.keys(OFF_CARD_METHOD_LABEL) as OffCardMethod[]).map((m) => <option key={m} value={m}>{OFF_CARD_METHOD_LABEL[m]}</option>)}
          </select>
          <input className="field px-1 py-0.5 text-xs" type="date" value={at} onChange={(e) => setAt(e.target.value)} title="When it was paid — the P&L month" />
          <input className="field w-44 px-1 py-0.5 text-xs" placeholder="Note" value={note} onChange={(e) => setNote(e.target.value)} />
          {Number.isFinite(Number(amount)) && amount.trim() !== ""
            ? <ReasonRow label="Save" busy={save.isPending} onSubmit={(reason) => save.mutate({ reason })} onCancel={() => setTyping(false)} />
            : <button type="button" className="btn btn-secondary px-2 py-0.5 text-xs min-h-0" onClick={() => setTyping(false)}>cancel</button>}
        </div>
      )}
      {error && <p className="text-red-600">{error}</p>}
    </div>
  );
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
        {editable && !editing && <button type="button" className="btn btn-secondary px-2 py-0.5 text-xs min-h-0" onClick={() => setEditing(true)}>Edit</button>}
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
          <button type="button" className="btn btn-secondary px-2 py-0.5 text-xs min-h-0" onClick={() => setMode("edit")}>edit</button>
          <button type="button" className="btn btn-danger px-2 py-0.5 text-xs min-h-0" onClick={() => setMode("remove")}>remove</button>
        </span>
      )}
      {editable && mode === "remove" && (
        <ReasonRow label="Remove line" busy={remove.isPending} onSubmit={(reason) => remove.mutate(reason)} onCancel={() => setMode("view")} />
      )}
    </li>
  );
}
