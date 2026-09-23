/**
 * Purchasing & Stock — buying, and what is on hand. (Tab separation, 2026-09-20; this was
 * the Inventory tab.)
 *
 * Kyle, 2026-09-20: "we need to review what can be separated so each tab is very clear
 * what its for and what information is there." Financials was the grab bag — the P&L and
 * invoices, but also purchasing, receipt review and stock landing. Financials is MONEY ONLY
 * now, and everything about BUYING lives here: the Purchases card (start a P.O., attach the
 * receipt, land it), the receipts waiting for review, the P.O.s waiting to land, restock
 * requests, the materials database, the stock on every truck and in the warehouse, and the
 * tool register. The Purchases card and the review list are the same components they were
 * on Financials — moved, not rewritten — and Financials carries a pointer here for one
 * release so muscle memory has somewhere to land.
 *
 * The inventory half is unchanged (Kyle, 2026-09-09, Build 3): "We need an inventory tab
 * that tracks what is on the truck and what is at the warehouse so on future jobs I can
 * label some stock as truckstock and it won't double count the cost." "Warehouse items will
 * only be used to transfer material to truck stock." "There is only one warehouse for now
 * it is my home location." One card per location — the warehouse first, then each truck —
 * with on hand, moving-average unit cost, value, an editable par, and a low-stock flag. Row
 * actions: Transfer to truck (warehouse rows only — Kyle's rule), Adjust (a count with a
 * reason), history (the movements, each correctable with a reason). Everything in-card;
 * rows cap at 12 with Show more (Kyle's no-endless-list rule). Nothing here charges a job
 * — a job is charged when its P.O. lands (services/inventory.ts).
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PageHeader } from "../components/PageHeader";
import {
  AttachProofButton,
  PO_PURPOSE_LABEL,
  PoStatusPill,
  PurchasesCard,
  poNeedsProof,
  useLandedPurchaseOrders,
  useLivePurchaseOrders,
  usePendingReviewReceipts,
  useReceiptsNeedingPo,
} from "../components/PurchaseOrders";
import { ReceiptReviewList } from "../components/ReceiptReviewList";
import { AttentionStrip } from "../components/AttentionStrip";
import { OpenDrawerButton } from "../components/drawers/OpenDrawerButton";
import { api } from "../lib/api";
import { useDrawerParams } from "../lib/drawers";
import type { InventoryItem, InventoryOverview, InventoryTruck, MaterialCompletionReason, MaterialRow, MaterialWithCompletion, StockLevelView, StockMovementView, StockRequestView, ToolCondition, ToolView } from "../lib/types";
import { money, shortDate } from "../lib/utils";

const PAGE_SIZE = 12;
const WAREHOUSE_KEY = "warehouse";

/** Unit costs carry four places — a moving average of $0.7714/ft is not $0.77. */
const unitMoney = (n: number | null | undefined) => (typeof n === "number" ? `$${n.toFixed(4).replace(/0{1,2}$/, "")}` : "—");
const qtyText = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

const KIND_LABEL: Record<StockMovementView["kind"], string> = {
  purchase_in: "purchase in",
  transfer: "transfer",
  consume: "consume",
  return: "return",
  // Truck/warehouse → the store (2026-09-22, supplier returns). NOT "return" — that kind
  // means job → truck and the two must never read alike in the ledger.
  supplier_return: "returned to store",
  count: "count",
  correction: "correction",
};

const CONDITION_LABEL: Record<ToolCondition, string> = { good: "good", needs_repair: "needs repair", retired: "retired" };

type Location = { key: string; label: string; truckId: string | null };

function locationsOf(data: InventoryOverview | undefined): Location[] {
  return [
    { key: WAREHOUSE_KEY, label: "Warehouse (home)", truckId: null },
    ...(data?.trucks ?? []).map((t) => ({ key: t.locationKey, label: t.truck.name, truckId: t.truck.id })),
  ];
}

/** Everything a stock or tool change can move. */
function useInventoryRefresh() {
  const queryClient = useQueryClient();
  return () => {
    for (const key of [["inventory"], ["inventory-movements"], ["tools"], ["tool"], ["trucks"], ["truck"], ["purchase-orders"], ["purchase-order"], ["purchase-order-landing"]]) {
      void queryClient.invalidateQueries({ queryKey: key });
    }
  };
}

function ReasonRow({ label, busy, onSubmit, onCancel, placeholder = "Reason (required)" }: { label: string; busy: boolean; onSubmit: (reason: string) => void; onCancel: () => void; placeholder?: string }) {
  const [reason, setReason] = useState("");
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <input className="field w-52 max-w-full px-1 py-0.5 text-xs" placeholder={placeholder} value={reason} onChange={(e) => setReason(e.target.value)} />
      <button type="button" className="btn btn-primary px-2 py-0.5 text-xs" disabled={!reason.trim() || busy} onClick={() => onSubmit(reason.trim())}>{label}</button>
      <button type="button" className="btn btn-secondary px-2 py-0.5 text-xs min-h-0" onClick={onCancel}>cancel</button>
    </span>
  );
}

function ShowMore({ total, shown, onMore }: { total: number; shown: number; onMore: () => void }) {
  if (total <= shown) return null;
  return <button type="button" className="btn btn-secondary mt-1 px-2 py-0.5 text-xs min-h-0" onClick={onMore}>Show more ({total - shown})</button>;
}

// ─── The page ────────────────────────────────────────────────────────────────

export function PurchasingPage() {
  const { data, isLoading, error } = useQuery({ queryKey: ["inventory"], queryFn: api.inventory });
  // The receipts waiting for review, every account (Kyle, 2026-09-08: "It is not clear
  // where to confirm field inputs") — they were the first thing on Financials; now here.
  const { data: pendingReceipts = [] } = usePendingReviewReceipts();
  const locations = locationsOf(data);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Purchasing & Stock"
        subtitle="Buying, and what is on hand. A purchase starts with a P.O. and ends when its material lands on a truck or in the warehouse; jobs are charged from truck stock."
        actions={<a href="#purchases" className="btn btn-primary text-sm">Start a P.O.</a>}
      />

      <PurchasingAttention overview={data} pendingReceipts={pendingReceipts} />

      {/* ── Purchases (Kyle, 2026-09-09): the PO is the document — number, purchase, receipt
          photo. Moved here from Financials (2026-09-20). The wrapper's id is the page's own
          "Start a P.O." anchor. ── */}
      <div id="purchases">
        <PurchasesCard />
      </div>

      <ReceiptReviewList
        collapsible
        title="Receipts to review (all accounts)"
        rows={pendingReceipts.map((r) => ({
          id: r.id, vendor: r.vendor, amount: r.amount, category: r.category, receivedAt: r.receivedAt,
          jobLabel: r.jobLabel, accountId: r.accountId ?? undefined, accountName: r.accountName ?? undefined,
          purchaseOrderNumber: r.purchaseOrderNumber, needsPo: r.needsPo,
        }))}
      />

      {isLoading && <p className="text-sm text-rce-muted">Loading…</p>}
      {error && <p className="text-sm text-red-600">{(error as Error).message}</p>}
      {data && (
        <>
          <PosToLand pos={data.unlandedPos} />
          <RestockRequests requests={data.openRequests} />
          <MaterialsSection />
          <LocationCard
            title="Warehouse (home)"
            subtitle="Purchases with purpose Warehouse land here. Warehouse items only move out as transfers to truck stock."
            locationKey={WAREHOUSE_KEY}
            levels={data.warehouse.levels}
            value={data.warehouse.value}
            trucks={data.trucks}
            isWarehouse
          />
          {data.trucks.map((t) => (
            <LocationCard
              key={t.locationKey}
              title={t.truck.name}
              subtitle={`${t.truck.technicianName ?? "no tech"} · truck stock — what gets charged to jobs${t.lowStock.length ? ` · ${t.lowStock.length} below par` : ""}`}
              locationKey={t.locationKey}
              levels={t.levels}
              value={t.value}
              trucks={data.trucks}
            />
          ))}
          <ToolsCard locations={locations} />
        </>
      )}
    </div>
  );
}

// ─── The tab's question: which money has no proof? ───────────────────────────

/**
 * Purchasing & Stock's attention strip (2026-09-20). "THE CHARGE IS THE MONEY. THE RECEIPT IS
 * PROOF" (Kyle, 2026-09-19) — so the thing this tab must never let slide is money on a P.O.
 * with no receipt behind it. Those P.O.s are the rows, with the attach button right there;
 * the chips count the rest of the queues this page already fetches: receipts with no P.O.,
 * receipts waiting for review, P.O.s waiting to land, restock requests. Same hooks as the
 * Purchases card, so this adds no request.
 */
function PurchasingAttention({ overview, pendingReceipts }: { overview: InventoryOverview | undefined; pendingReceipts: { id: string }[] }) {
  const { data: live = [] } = useLivePurchaseOrders();
  const { data: needing = [] } = useReceiptsNeedingPo();
  const drawers = useDrawerParams();
  const needsProof = live.filter(poNeedsProof);
  const unproved = needsProof.reduce((sum, po) => sum + po.moneyTotal, 0);
  const toLand = overview?.unlandedPos.length ?? 0;
  const requests = overview?.openRequests.length ?? 0;
  return (
    <AttentionStrip
      chips={[
        { key: "proof", label: `${needsProof.length} P.O.${needsProof.length === 1 ? "" : "s"} with money and no receipt (${money(unproved)})`, count: needsProof.length, tone: "red" },
        { key: "needs-po", label: `${needing.length} receipt${needing.length === 1 ? "" : "s"} with no P.O.`, count: needing.length },
        { key: "review", label: `${pendingReceipts.length} receipt${pendingReceipts.length === 1 ? "" : "s"} to review`, count: pendingReceipts.length },
        { key: "land", label: `${toLand} to land`, count: toLand },
        { key: "requests", label: `${requests} restock request${requests === 1 ? "" : "s"}`, count: requests },
      ]}
      rows={needsProof.map((po) => ({
        key: po.id,
        text: <><span className="tabular-nums">{po.number}</span> · {po.supplier} — {money(po.moneyTotal)}, no receipt</>,
        detail: `${PO_PURPOSE_LABEL[po.purpose] ?? po.purpose}${po.truckName ? ` · ${po.truckName}` : ""}${po.jobLabel ? ` · ${po.jobLabel}` : ""} · opened ${shortDate(po.openedAt)}`,
        action: (
          <>
            <AttachProofButton poId={po.id} />
            <OpenDrawerButton kind="po" id={po.id} onOpen={drawers.open} />
          </>
        ),
      }))}
      moreText="the rest are in the Purchases card"
    />
  );
}

// ─── POs to land ─────────────────────────────────────────────────────────────

/**
 * The queue of P.O.s waiting to land. A row opens the P.O.'s drawer, whose "Land" section is
 * `LandingPanel` — the one landing surface. Until 2026-09-21 this list also expanded its own
 * `LandingPanel` in place, which put two landing forms for the same P.O. on one page (punch
 * list H3); the drawer's copy is the one that survives.
 */
function PosToLand({ pos }: { pos: InventoryOverview["unlandedPos"] }) {
  const drawers = useDrawerParams();
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? pos : pos.slice(0, PAGE_SIZE);
  return (
    <section className="card p-4">
      <h2 className="text-lg font-semibold">POs to land ({pos.length})</h2>
      <p className="mb-2 text-xs text-rce-muted">Purchased and verified POs whose material has not landed yet. Landing puts it on the truck or in the warehouse (a tool PO onto the register) and closes the PO. Open a row to land it.</p>
      {pos.length === 0 && <p className="text-sm text-rce-muted">Nothing waiting to land.</p>}
      <ul className="space-y-1">
        {visible.map((po) => (
          <li key={po.id} className="rounded-lg border border-rce-border px-3 py-1.5 text-sm">
            <button type="button" className="flex w-full flex-wrap items-center justify-between gap-2 text-left" title="Open this P.O. to land it" onClick={() => drawers.open("po", po.id)}>
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-semibold tabular-nums">{po.number}</span>
                <span>{po.supplier}</span>
                <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-700">{PO_PURPOSE_LABEL[po.purpose] ?? po.purpose}</span>
                <span className="text-xs text-rce-muted">{po.purpose === "warehouse" ? "Warehouse (home)" : po.truckName ?? "truck"}</span>
              </span>
              <span className="flex flex-wrap items-center gap-2 text-xs text-rce-muted">
                <PoStatusPill status={po.status} />
                {po.purchasedAt && <span>purchased {shortDate(po.purchasedAt)}</span>}
                <span>{po.lineCount} line{po.lineCount === 1 ? "" : "s"} · {po.receiptCount} receipt{po.receiptCount === 1 ? "" : "s"}</span>
                <span className="text-rce-accent">Land</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      <ShowMore total={pos.length} shown={visible.length} onMore={() => setShowAll(true)} />
    </section>
  );
}

// ─── Restock requests ────────────────────────────────────────────────────────

function RestockRequests({ requests }: { requests: StockRequestView[] }) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? requests : requests.slice(0, PAGE_SIZE);
  return (
    <section className="card p-4">
      <h2 className="text-lg font-semibold">Restock requests ({requests.length})</h2>
      <p className="mb-2 text-xs text-rce-muted">A tech asked for stock from the truck. Fulfill moves it warehouse → truck at the warehouse's average cost; Decline needs a reason.</p>
      {requests.length === 0 && <p className="text-sm text-rce-muted">No open requests.</p>}
      <ul className="space-y-1">
        {visible.map((r) => <RequestRow key={r.id} row={r} />)}
      </ul>
      <ShowMore total={requests.length} shown={visible.length} onMore={() => setShowAll(true)} />
    </section>
  );
}

function RequestRow({ row }: { row: StockRequestView }) {
  const refresh = useInventoryRefresh();
  const [mode, setMode] = useState<"view" | "decline">("view");
  const [error, setError] = useState<string | null>(null);
  const fulfill = useMutation({ mutationFn: () => api.fulfillStockRequest(row.id), onSuccess: () => { setError(null); refresh(); }, onError: (err) => setError((err as Error).message) });
  const decline = useMutation({ mutationFn: (reason: string) => api.declineStockRequest(row.id, reason), onSuccess: () => { setError(null); setMode("view"); refresh(); }, onError: (err) => setError((err as Error).message) });
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50/40 px-3 py-1.5 text-sm">
      <span className="min-w-0">
        <span className="font-medium">{row.truckName}</span> wants <span className="tabular-nums">{qtyText(row.qty)} {row.unit ?? ""}</span> {row.name}
        {row.itemId ? <span className="text-xs text-rce-muted"> · {row.itemId}</span> : <span className="text-xs text-amber-800"> · not a book item</span>}
        <span className="block text-xs text-rce-muted">{shortDate(row.createdAt)}{row.note ? ` · ${row.note}` : ""}</span>
      </span>
      {mode === "view" && (
        <span className="flex gap-2 text-xs">
          <button type="button" className="btn btn-primary px-2 py-0.5 text-xs" disabled={fulfill.isPending} onClick={() => fulfill.mutate()}>Fulfill</button>
          <button type="button" className="btn btn-danger px-2 py-0.5 text-xs min-h-0" onClick={() => setMode("decline")}>Decline</button>
        </span>
      )}
      {mode === "decline" && <ReasonRow label="Decline" busy={decline.isPending} onSubmit={(reason) => decline.mutate(reason)} onCancel={() => setMode("view")} />}
      {error && <span className="w-full text-xs text-red-600">{error}</span>}
    </li>
  );
}

// ─── The material database (2026-09-12, barcode/materials plan Unit 6) ───────
//
// Kyle: "I want a materials data base in the inventory tab... an assigned list (completed with
// cost and labor units) and unassigned (not completed or unfilled information)." Completion is
// derived server-side (services/materials.ts materialCompletion) and returned as `completion` on
// every row — this file only ever reads that field, never recomputes it. The unassigned list
// names WHICH piece is missing so it reads as an actionable worklist, not a shrug.

const MISSING_LABEL: Record<MaterialCompletionReason, string> = {
  no_link: "no link to a price book item",
  no_labor: "no labor on the linked item",
  no_cost: "no cost",
};

/** An assembly is never a purchasable thing and must never be offered as a material's link
 * target. The real guard is server-side (assertNotAssembly, services/priceBookAssembly.ts); this
 * just keeps one out of the picker's results, matching the same client-side convention already
 * used for the assembly-component picker in PriceBookCatalogPage.tsx. */
const isAssemblyRowType = (rowType: string | null | undefined) => (rowType ?? "").toUpperCase() === "ASSEMBLY";

function useMaterialsRefresh() {
  const queryClient = useQueryClient();
  return () => {
    for (const key of [["materials"], ["materials-unassigned"]]) {
      void queryClient.invalidateQueries({ queryKey: key });
    }
  };
}

function materialLabel(m: MaterialRow): string {
  return m.description || m.sku || m.upc || "(no description)";
}

function packText(m: MaterialRow): string {
  if (m.packQty == null) return "";
  return `pack of ${qtyText(m.packQty)}${m.packUnit ? ` ${m.packUnit}` : ""}`;
}

/** Package price ÷ packQty — the each-price that compares to the book's per-each/per-foot
 * figure. Display mirror of the server's perUnitCostFromPack (services/materials.ts); this is a
 * unit conversion for display, not a completion decision, so mirroring it here is fine — the same
 * distinction the codebase already draws for the assembly-cost preview in PriceBookCatalogPage. */
function perUnitCost(m: MaterialRow): number | null {
  if (m.lastCost == null) return null;
  if (m.packQty != null && m.packQty > 0) return m.lastCost / m.packQty;
  return m.lastCost;
}

function MaterialsSection() {
  const { data: unassigned = [], isLoading: loadingUnassigned } = useQuery({ queryKey: ["materials-unassigned"], queryFn: api.unassignedMaterials });
  const { data: all = [], isLoading: loadingAll } = useQuery({ queryKey: ["materials"], queryFn: api.materials });
  const assigned = all.filter((m) => m.completion.assigned);
  return (
    <>
      <UnassignedMaterialsCard rows={unassigned} isLoading={loadingUnassigned} />
      <AssignedMaterialsCard rows={assigned} isLoading={loadingAll} />
    </>
  );
}

function UnassignedMaterialsCard({ rows, isLoading }: { rows: MaterialWithCompletion[]; isLoading: boolean }) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? rows : rows.slice(0, PAGE_SIZE);
  return (
    <section className="card p-4">
      <h2 className="text-lg font-semibold">Materials to complete ({rows.length})</h2>
      <p className="mb-2 text-xs text-rce-muted">Scanned or entered but not yet quotable. Link joins an existing price book item that already carries labor; Promote creates a brand new one.</p>
      {isLoading && <p className="text-sm text-rce-muted">Loading…</p>}
      {!isLoading && rows.length === 0 && <p className="text-sm text-rce-muted">Nothing waiting — every material has a cost and labor units.</p>}
      <ul className="space-y-1">
        {visible.map((r) => <UnassignedMaterialRow key={r.material.id} row={r} />)}
      </ul>
      <ShowMore total={rows.length} shown={visible.length} onMore={() => setShowAll(true)} />
    </section>
  );
}

function UnassignedMaterialRow({ row }: { row: MaterialWithCompletion }) {
  const refresh = useMaterialsRefresh();
  const { material, completion } = row;
  const [mode, setMode] = useState<"view" | "link" | "promote" | "cost">("view");
  const [error, setError] = useState<string | null>(null);
  const onError = (err: unknown) => setError((err as Error).message);
  const done = () => { setError(null); setMode("view"); refresh(); };

  const link = useMutation({ mutationFn: (itemId: string) => api.linkMaterial(material.id, itemId), onSuccess: done, onError });
  const setCost = useMutation({ mutationFn: (cost: number) => api.updateMaterialCost(material.id, cost), onSuccess: done, onError });

  return (
    <li className="rounded-lg border border-amber-200 bg-amber-50/40 px-3 py-1.5 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0">
          <span className="font-medium">{materialLabel(material)}</span>
          {material.upc && <span className="text-xs text-rce-muted"> · UPC {material.upc}</span>}
          {material.sku && <span className="text-xs text-rce-muted"> · SKU {material.sku}{material.supplier ? ` (${material.supplier})` : ""}</span>}
          {packText(material) && <span className="text-xs text-rce-muted"> · {packText(material)}</span>}
          <span className="block text-xs">
            {completion.missing.map((reason) => (
              <span key={reason} className="mr-1 inline-block rounded bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-800">{MISSING_LABEL[reason]}</span>
            ))}
          </span>
        </span>
        {mode === "view" && (
          <span className="flex flex-wrap gap-2 text-xs">
            <button type="button" className="btn btn-secondary px-2 py-0.5 text-xs min-h-0" onClick={() => setMode("link")}>Link</button>
            {!material.itemId && <button type="button" className="btn btn-secondary px-2 py-0.5 text-xs min-h-0" onClick={() => setMode("promote")}>Promote</button>}
            {completion.missing.includes("no_cost") && <button type="button" className="btn btn-secondary px-2 py-0.5 text-xs min-h-0" onClick={() => setMode("cost")}>Set cost</button>}
          </span>
        )}
      </div>
      {mode === "link" && <LinkPicker busy={link.isPending} onPick={(itemId) => link.mutate(itemId)} onCancel={() => setMode("view")} />}
      {mode === "promote" && <PromoteForm material={material} onDone={done} onCancel={() => setMode("view")} />}
      {mode === "cost" && <SetCostRow current={material.lastCost} busy={setCost.isPending} onSubmit={(v) => setCost.mutate(v)} onCancel={() => setMode("view")} />}
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </li>
  );
}

function SetCostRow({ current, busy, onSubmit, onCancel }: { current: number | null; busy: boolean; onSubmit: (v: number) => void; onCancel: () => void }) {
  const [value, setValue] = useState(current != null ? String(current) : "");
  const valid = value.trim() !== "" && Number.isFinite(Number(value)) && Number(value) >= 0;
  return (
    <div className="mt-1 inline-flex flex-wrap items-center gap-1 text-xs">
      <span>Package price $</span>
      <input className="field w-20 px-1 py-0.5 text-xs" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
      <button type="button" className="btn btn-primary px-2 py-0.5 text-xs" disabled={!valid || busy} onClick={() => onSubmit(Number(value))}>Save</button>
      <button type="button" className="btn btn-secondary px-2 py-0.5 text-xs min-h-0" onClick={onCancel}>cancel</button>
    </div>
  );
}

function LinkPicker({ busy, onPick, onCancel }: { busy: boolean; onPick: (itemId: string) => void; onCancel: () => void }) {
  const [q, setQ] = useState("");
  const active = q.trim().length >= 2 ? q.trim() : "";
  const { data, isFetching } = useQuery({
    queryKey: ["materials-link-picker", active],
    queryFn: () => api.pbCatalogItems({ search: active }),
    enabled: Boolean(active),
  });
  const results = (data?.atomics ?? []).filter((a) => !isAssemblyRowType(a.rowType)).slice(0, 20);
  return (
    <div className="mt-1 rounded-md bg-white p-2 text-xs">
      <div className="flex items-center gap-1">
        <input className="field w-64 max-w-full px-1 py-0.5 text-xs" placeholder="Search the book (item id or description)…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
        <button type="button" className="btn btn-secondary px-2 py-0.5 text-xs min-h-0" onClick={onCancel}>cancel</button>
      </div>
      {isFetching && <p className="mt-1 text-rce-muted">Searching…</p>}
      {active && !isFetching && results.length === 0 && <p className="mt-1 text-rce-muted">No matching item — try Promote instead.</p>}
      {results.length > 0 && (
        <ul className="mt-1 max-h-48 overflow-auto">
          {results.map((a) => (
            <li key={a.itemId}>
              <button type="button" className="flex w-full items-center justify-between gap-2 rounded px-1.5 py-1 text-left hover:bg-rce-bg" disabled={busy} onClick={() => onPick(a.itemId)}>
                <span><span className="font-medium">{a.itemId}</span> {a.description}</span>
                <span className="text-rce-muted">{a.laborNormal != null || a.laborDifficult != null || a.laborVeryDifficult != null ? "has labor" : "no labor yet"}{a.companyCost != null ? ` · ${money(a.companyCost)}` : ""}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PromoteForm({ material, onDone, onCancel }: { material: MaterialRow; onDone: () => void; onCancel: () => void }) {
  const { data: catData } = useQuery({ queryKey: ["materials-pb-categories"], queryFn: api.pbCatalogCategories });
  const categories = (catData?.categories ?? []).map((c) => c.name);
  const derivedCost = material.lastCost != null && material.packQty != null && material.packQty > 0
    ? Math.round((material.lastCost / material.packQty) * 100) / 100
    : material.lastCost;
  const [form, setForm] = useState({
    description: material.description ?? "",
    category: "",
    rowType: "MATERIAL + LABOR",
    unitLabel: material.packUnit ?? "",
    companyCost: derivedCost != null ? String(derivedCost) : "",
    laborNormal: "",
    laborDifficult: "",
    laborVeryDifficult: "",
  });
  const [error, setError] = useState<string | null>(null);
  const promote = useMutation({
    mutationFn: () => api.promoteMaterial(material.id, {
      description: form.description.trim(),
      category: form.category.trim(),
      rowType: form.rowType,
      unitLabel: form.unitLabel.trim() || null,
      companyCost: form.companyCost.trim() === "" ? null : Number(form.companyCost),
      laborNormal: form.laborNormal.trim() === "" ? null : Number(form.laborNormal),
      laborDifficult: form.laborDifficult.trim() === "" ? null : Number(form.laborDifficult),
      laborVeryDifficult: form.laborVeryDifficult.trim() === "" ? null : Number(form.laborVeryDifficult),
    }),
    onSuccess: onDone,
    onError: (err) => setError((err as Error).message),
  });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const canSave = form.description.trim() !== "" && form.category.trim() !== "" && !promote.isPending;
  return (
    <div className="mt-1 rounded-md bg-white p-2 text-xs">
      <div className="flex flex-wrap items-center gap-1">
        <input className="field w-52 px-1 py-0.5 text-xs" placeholder="Description" value={form.description} onChange={set("description")} autoFocus />
        <input className="field w-36 px-1 py-0.5 text-xs" placeholder="Category" list="materials-pb-cat-list" value={form.category} onChange={set("category")} />
        <datalist id="materials-pb-cat-list">{categories.map((c) => <option key={c} value={c} />)}</datalist>
        <input className="field w-24 px-1 py-0.5 text-xs" placeholder="Unit (e.g. ea)" value={form.unitLabel} onChange={set("unitLabel")} />
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1">
        <span>Cost/ea $</span>
        <input className="field w-20 px-1 py-0.5 text-xs" inputMode="decimal" value={form.companyCost} onChange={set("companyCost")} />
        <span>Hrs normal</span>
        <input className="field w-16 px-1 py-0.5 text-xs" inputMode="decimal" value={form.laborNormal} onChange={set("laborNormal")} />
        <span>difficult</span>
        <input className="field w-16 px-1 py-0.5 text-xs" inputMode="decimal" value={form.laborDifficult} onChange={set("laborDifficult")} />
        <span>very diff.</span>
        <input className="field w-16 px-1 py-0.5 text-xs" inputMode="decimal" value={form.laborVeryDifficult} onChange={set("laborVeryDifficult")} />
      </div>
      <div className="mt-1 flex items-center gap-2">
        <button type="button" className="btn btn-primary px-2 py-0.5 text-xs" disabled={!canSave} onClick={() => promote.mutate()}>{promote.isPending ? "Creating…" : "Promote"}</button>
        <button type="button" className="btn btn-secondary px-2 py-0.5 text-xs min-h-0" onClick={onCancel}>cancel</button>
      </div>
      {error && <p className="mt-1 text-red-600">{error}</p>}
    </div>
  );
}

function AssignedMaterialsCard({ rows, isLoading }: { rows: MaterialWithCompletion[]; isLoading: boolean }) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? rows : rows.slice(0, PAGE_SIZE);
  return (
    <section className="card p-4">
      <h2 className="text-lg font-semibold">Materials ({rows.length} assigned)</h2>
      <p className="mb-2 text-xs text-rce-muted">Cost and labor units both present — ready to quote. Cost/unit is the pack price divided by pack size, the figure that compares to the book.</p>
      {isLoading && <p className="text-sm text-rce-muted">Loading…</p>}
      {!isLoading && rows.length === 0 && <p className="text-sm text-rce-muted">Nothing assigned yet.</p>}
      {rows.length > 0 && (
        <div className="mt-2 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-[11px] uppercase tracking-wide text-rce-soft">
            <tr><th className="pr-2">Material</th><th className="pr-2">UPC</th><th className="pr-2">SKU</th><th className="pr-2">Pack</th><th className="pr-2">Linked item</th><th className="pr-2 text-right">Cost/unit</th></tr>
          </thead>
          <tbody>
            {visible.map((r) => <AssignedMaterialRow key={r.material.id} material={r.material} />)}
          </tbody>
        </table>
        </div>
      )}
      <ShowMore total={rows.length} shown={visible.length} onMore={() => setShowAll(true)} />
    </section>
  );
}

function AssignedMaterialRow({ material }: { material: MaterialRow }) {
  return (
    <tr className="border-t border-rce-border/60">
      <td className="py-1 pr-2">{materialLabel(material)}</td>
      <td className="py-1 pr-2 tabular-nums text-xs text-rce-muted">{material.upc ?? "—"}</td>
      <td className="py-1 pr-2 tabular-nums text-xs text-rce-muted">{material.sku ?? "—"}{material.supplier ? ` (${material.supplier})` : ""}</td>
      <td className="py-1 pr-2 text-xs text-rce-muted">{packText(material) || "—"}</td>
      <td className="py-1 pr-2 text-xs">{material.itemId}</td>
      <td className="py-1 pr-2 text-right tabular-nums">{unitMoney(perUnitCost(material))}</td>
    </tr>
  );
}

// ─── One location ────────────────────────────────────────────────────────────

function LocationCard({ title, subtitle, locationKey, levels, value, trucks, isWarehouse = false }: {
  title: string; subtitle: string; locationKey: string; levels: StockLevelView[]; value: number; trucks: InventoryTruck[]; isWarehouse?: boolean;
}) {
  const [showAll, setShowAll] = useState(false);
  const [counting, setCounting] = useState(false);
  const visible = showAll ? levels : levels.slice(0, PAGE_SIZE);
  const low = levels.filter((l) => l.low).length;
  return (
    <section className="card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">{title} <span className="text-sm font-normal tabular-nums text-rce-muted">· {money(value)} on hand{low ? ` · ${low} low` : ""}</span></h2>
          <p className="text-xs text-rce-muted">{subtitle}</p>
        </div>
        <span className="flex flex-wrap items-center gap-2">
          <button type="button" className="btn btn-secondary text-xs" onClick={() => setCounting((c) => !c)}>{counting ? "Hide count" : "Count"}</button>
          <a href="#purchases" className="btn btn-secondary text-xs">Start PO</a>
        </span>
      </div>
      {counting && <CountForm locationKey={locationKey} onDone={() => setCounting(false)} />}
      {levels.length === 0 && <p className="mt-2 text-sm text-rce-muted">Nothing on hand yet — land a PO here, or Count what is already on the shelf.</p>}
      {levels.length > 0 && (
        <div className="mt-2 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-[11px] uppercase tracking-wide text-rce-soft">
            <tr><th className="pr-2">Item</th><th className="pr-2 text-right">On hand</th><th className="pr-2 text-right">Unit cost</th><th className="pr-2 text-right">Value</th><th className="pr-2 text-right">Par</th><th className="text-right">Actions</th></tr>
          </thead>
          <tbody>
            {visible.map((l) => <LevelRow key={l.id} level={l} locationKey={locationKey} trucks={trucks} isWarehouse={isWarehouse} />)}
          </tbody>
        </table>
        </div>
      )}
      <ShowMore total={levels.length} shown={visible.length} onMore={() => setShowAll(true)} />
    </section>
  );
}

function LevelRow({ level, locationKey, trucks, isWarehouse }: { level: StockLevelView; locationKey: string; trucks: InventoryTruck[]; isWarehouse: boolean }) {
  const refresh = useInventoryRefresh();
  const [mode, setMode] = useState<"view" | "transfer" | "adjust" | "return" | "history">("view");
  const [error, setError] = useState<string | null>(null);
  const [parEditing, setParEditing] = useState(false);
  const [par, setPar] = useState(level.parLevel == null ? "" : String(level.parLevel));
  const [truckId, setTruckId] = useState(trucks[0]?.truck.id ?? "");
  const [qty, setQty] = useState("");
  const [returnPoId, setReturnPoId] = useState("");
  // Recent P.O.s for the optional "put this refund on a P.O." pick — stock here got here
  // by LANDING, so this needs the landed list (components/PurchaseOrders.tsx), never the
  // open+purchased list the receipt/refund pickers use — those are close to the exact
  // complement of what a returns desk needs (defect fix, 2026-09-22).
  const { data: recentPos = [] } = useLandedPurchaseOrders();
  const onError = (err: unknown) => setError((err as Error).message);
  const done = () => { setError(null); setMode("view"); setQty(""); setReturnPoId(""); refresh(); };
  const setParLevel = useMutation({ mutationFn: (value: number | null) => api.setParLevel(level.id, value), onSuccess: () => { setError(null); setParEditing(false); refresh(); }, onError });
  const transfer = useMutation({ mutationFn: (reason: string) => api.transferStock({ itemId: level.itemId, qty: Number(qty), toTruckId: truckId, reason }), onSuccess: done, onError });
  const adjust = useMutation({ mutationFn: (reason: string) => api.countStock({ locationKey, reason, lines: [{ itemId: level.itemId, name: level.name, unit: level.unit, qty: Number(qty) }] }), onSuccess: done, onError });
  const supplierReturn = useMutation({
    mutationFn: (reason: string) => api.supplierReturn({ itemId: level.itemId, qty: Number(qty), fromLocationKey: locationKey, purchaseOrderId: returnPoId || null, reason }),
    onSuccess: done,
    onError,
  });
  const qtyOk = Number.isFinite(Number(qty)) && Number(qty) >= 0 && qty.trim() !== "";
  const returnQtyOk = Number.isFinite(Number(qty)) && Number(qty) > 0 && qty.trim() !== "";
  return (
    <>
      <tr className={`border-t border-rce-border/60 ${level.low ? "bg-amber-50/60" : ""}`}>
        <td className="py-1 pr-2">
          {level.name}
          <span className="text-xs text-rce-muted"> · {level.itemId}</span>
          {level.low && <span className="ml-1 rounded bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-800">low</span>}
        </td>
        <td className="py-1 pr-2 text-right tabular-nums">{qtyText(level.qtyOnHand)} {level.unit ?? ""}</td>
        <td className="py-1 pr-2 text-right tabular-nums">{unitMoney(level.avgUnitCost)}</td>
        <td className="py-1 pr-2 text-right tabular-nums">{money(level.value)}</td>
        <td className="py-1 pr-2 text-right tabular-nums">
          {parEditing ? (
            <span className="inline-flex items-center gap-1">
              <input className="field w-16 px-1 py-0.5 text-xs" inputMode="decimal" value={par} onChange={(e) => setPar(e.target.value)} />
              <button type="button" className="btn btn-primary px-2 py-0.5 text-xs min-h-0" disabled={setParLevel.isPending} onClick={() => setParLevel.mutate(par.trim() === "" ? null : Number(par))}>save</button>
              <button type="button" className="btn btn-secondary px-2 py-0.5 text-xs min-h-0" onClick={() => setParEditing(false)}>cancel</button>
            </span>
          ) : (
            <button type="button" className="btn btn-secondary px-2 py-0.5 text-xs min-h-0" title="Set the restock threshold" onClick={() => setParEditing(true)}>{level.parLevel == null ? "set" : qtyText(level.parLevel)}</button>
          )}
        </td>
        <td className="py-1 text-right text-xs">
          <span className="inline-flex gap-2 whitespace-nowrap">
            {isWarehouse && <button type="button" className="btn btn-secondary px-2 py-0.5 text-xs min-h-0" onClick={() => setMode(mode === "transfer" ? "view" : "transfer")}>Transfer to truck</button>}
            <button type="button" className="btn btn-secondary px-2 py-0.5 text-xs min-h-0" onClick={() => setMode(mode === "return" ? "view" : "return")}>Returned to store</button>
            <button type="button" className="btn btn-secondary px-2 py-0.5 text-xs min-h-0" onClick={() => setMode(mode === "adjust" ? "view" : "adjust")}>Adjust</button>
            <button type="button" className="btn btn-secondary px-2 py-0.5 text-xs min-h-0" onClick={() => setMode(mode === "history" ? "view" : "history")}>{mode === "history" ? "hide history" : "history"}</button>
          </span>
        </td>
      </tr>
      {mode !== "view" && (
        <tr className="bg-rce-bg text-xs">
          <td colSpan={6} className="px-2 py-2">
            {mode === "transfer" && (
              <span className="inline-flex flex-wrap items-center gap-1">
                <span>Move</span>
                <input className="field w-20 px-1 py-0.5 text-xs" inputMode="decimal" placeholder="Qty" value={qty} onChange={(e) => setQty(e.target.value)} />
                <span>{level.unit ?? ""} to</span>
                <select className="field px-1 py-0.5 text-xs" value={truckId} onChange={(e) => setTruckId(e.target.value)}>
                  {trucks.map((t) => <option key={t.truck.id} value={t.truck.id}>{t.truck.name}</option>)}
                </select>
                <span className="text-rce-muted">at {unitMoney(level.avgUnitCost)} · {qtyText(level.qtyOnHand)} on hand</span>
                <ReasonRow label="Transfer" busy={transfer.isPending || !qtyOk || !truckId} onSubmit={(reason) => transfer.mutate(reason)} onCancel={() => setMode("view")} placeholder="Reason (optional)" />
              </span>
            )}
            {mode === "adjust" && (
              <span className="inline-flex flex-wrap items-center gap-1">
                <span>Counted</span>
                <input className="field w-20 px-1 py-0.5 text-xs" inputMode="decimal" placeholder={qtyText(level.qtyOnHand)} value={qty} onChange={(e) => setQty(e.target.value)} />
                <span>{level.unit ?? ""} (book says {qtyText(level.qtyOnHand)}) — a count movement; the average cost stays</span>
                <ReasonRow label="Adjust" busy={adjust.isPending || !qtyOk} onSubmit={(reason) => adjust.mutate(reason)} onCancel={() => setMode("view")} />
              </span>
            )}
            {mode === "return" && (
              <span className="inline-flex flex-wrap items-center gap-1">
                <span>Returned</span>
                <input className="field w-20 px-1 py-0.5 text-xs" inputMode="decimal" placeholder={qtyText(level.qtyOnHand)} value={qty} onChange={(e) => setQty(e.target.value)} />
                <span>{level.unit ?? ""} to the store at {unitMoney(level.avgUnitCost)} · {qtyText(level.qtyOnHand)} on hand</span>
                <select className="field px-1 py-0.5 text-xs" value={returnPoId} onChange={(e) => setReturnPoId(e.target.value)}>
                  <option value="">No P.O. (refund unattached)</option>
                  {recentPos.map((po) => <option key={po.id} value={po.id}>{po.number} · {po.supplier}</option>)}
                </select>
                <ReasonRow label="Return to store" busy={supplierReturn.isPending || !returnQtyOk} onSubmit={(reason) => supplierReturn.mutate(reason)} onCancel={() => setMode("view")} />
              </span>
            )}
            {mode === "history" && <History itemId={level.itemId} locationKey={locationKey} />}
            {error && <p className="mt-1 text-red-600">{error}</p>}
          </td>
        </tr>
      )}
    </>
  );
}

function History({ itemId, locationKey }: { itemId: string; locationKey: string }) {
  const { data: rows = [], isLoading } = useQuery({ queryKey: ["inventory-movements", { itemId, locationKey }], queryFn: () => api.inventoryMovements({ itemId, locationKey, limit: 100 }) });
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? rows : rows.slice(0, PAGE_SIZE);
  if (isLoading) return <p className="text-rce-muted">Loading…</p>;
  if (rows.length === 0) return <p className="text-rce-muted">No movements yet.</p>;
  return (
    <div>
      <ul className="space-y-0.5">
        {visible.map((m) => <MovementRow key={m.id} m={m} here={locationKey} />)}
      </ul>
      <ShowMore total={rows.length} shown={visible.length} onMore={() => setShowAll(true)} />
    </div>
  );
}

function MovementRow({ m, here }: { m: StockMovementView; here: string }) {
  const refresh = useInventoryRefresh();
  const [correcting, setCorrecting] = useState(false);
  const [delta, setDelta] = useState("");
  const [error, setError] = useState<string | null>(null);
  const correct = useMutation({
    mutationFn: (reason: string) => api.correctMovement({ correctsId: m.id, delta: Number(delta), reason }),
    onSuccess: () => { setError(null); setCorrecting(false); setDelta(""); refresh(); },
    onError: (err) => setError((err as Error).message),
  });
  const sign = m.kind === "count" ? (m.delta ?? 0) : m.kind === "correction" ? (m.delta ?? 0) * (m.toLocationKey === here ? 1 : -1) : m.toLocationKey === here ? m.qty : -m.qty;
  const other = m.kind === "transfer" ? (m.toLocationKey === here ? `from ${m.fromLocationKey}` : `to ${m.toLocationKey}`) : "";
  return (
    <li className="flex flex-wrap items-center justify-between gap-2">
      <span className="min-w-0">
        <span className="tabular-nums text-rce-muted">{new Date(m.at).toLocaleString()}</span> · {KIND_LABEL[m.kind]}
        {" "}<span className={`tabular-nums ${sign < 0 ? "text-red-700" : "text-emerald-700"}`}>{sign > 0 ? "+" : ""}{qtyText(sign)}</span>
        {m.kind === "count" ? ` → ${qtyText(m.qty)} counted` : ""}
        {m.unitCost != null ? ` @ ${unitMoney(m.unitCost)}` : ""}
        {other ? ` ${other}` : ""}
        {m.purchaseOrderId ? " · PO" : ""}
        {m.correctsId ? " · corrects an earlier movement" : ""}
        <span className="text-rce-muted"> · {m.actor}{m.reason ? ` — ${m.reason}` : ""}</span>
      </span>
      {!correcting && <button type="button" className="btn btn-secondary px-2 py-0.5 text-xs min-h-0" onClick={() => setCorrecting(true)}>correct</button>}
      {correcting && (
        <span className="inline-flex flex-wrap items-center gap-1">
          <input className="field w-16 px-1 py-0.5 text-xs" inputMode="decimal" placeholder="±qty" value={delta} onChange={(e) => setDelta(e.target.value)} />
          <ReasonRow label="Correct" busy={correct.isPending || !Number.isFinite(Number(delta)) || delta.trim() === ""} onSubmit={(reason) => correct.mutate(reason)} onCancel={() => setCorrecting(false)} />
        </span>
      )}
      {error && <span className="w-full text-red-600">{error}</span>}
    </li>
  );
}

// ─── Count form (multi-line, item search) ────────────────────────────────────

type CountLine = { itemId: string; name: string; unit: string | null; qty: string; unitCost: string };

function ItemSearch({ onPick }: { onPick: (item: InventoryItem) => void }) {
  const [q, setQ] = useState("");
  const { data: items = [] } = useQuery({ queryKey: ["inventory-items", { q }], queryFn: () => api.inventoryItems(q), enabled: q.trim().length >= 2 });
  return (
    <div className="relative">
      <input className="field w-64 max-w-full px-1 py-0.5 text-xs" placeholder="Search the book (item id or name)…" value={q} onChange={(e) => setQ(e.target.value)} />
      {q.trim().length >= 2 && items.length > 0 && (
        <ul className="absolute left-0 z-10 mt-1 max-h-56 w-96 max-w-[calc(100vw-3rem)] overflow-auto rounded-md border border-rce-border bg-white text-xs shadow">
          {items.map((i) => (
            <li key={i.itemId}>
              <button type="button" className="flex w-full items-center justify-between gap-2 px-2 py-1 text-left hover:bg-rce-bg" onClick={() => { onPick(i); setQ(""); }}>
                <span><span className="font-medium">{i.itemId}</span> {i.description}</span>
                <span className="text-rce-muted">{i.unit ?? ""}{i.lastCost != null ? ` · ${unitMoney(i.lastCost)}` : ""}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CountForm({ locationKey, onDone }: { locationKey: string; onDone: () => void }) {
  const refresh = useInventoryRefresh();
  const [lines, setLines] = useState<CountLine[]>([]);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const count = useMutation({
    mutationFn: () => api.countStock({
      locationKey, reason: reason.trim(),
      lines: lines.map((l) => ({ itemId: l.itemId, name: l.name, unit: l.unit, qty: Number(l.qty), unitCost: l.unitCost.trim() === "" ? null : Number(l.unitCost) })),
    }),
    onSuccess: () => { setError(null); setLines([]); setReason(""); refresh(); onDone(); },
    onError: (err) => setError((err as Error).message),
  });
  const valid = lines.length > 0 && reason.trim() !== "" && lines.every((l) => Number.isFinite(Number(l.qty)) && l.qty.trim() !== "" && (l.unitCost.trim() === "" || Number(l.unitCost) >= 0));
  return (
    <div className="mt-2 rounded-lg border border-rce-border p-3 text-xs">
      <p className="font-semibold">Physical count</p>
      <p className="text-rce-muted">Sets on hand to what you counted. A new item is valued at the unit cost you give, else the book's last purchase price; an item already here keeps its average.</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <ItemSearch onPick={(i) => setLines((ls) => ls.some((l) => l.itemId === i.itemId) ? ls : [...ls, { itemId: i.itemId, name: i.description ?? i.itemId, unit: i.unit, qty: "", unitCost: i.lastCost != null ? String(i.lastCost) : "" }])} />
      </div>
      <ul className="mt-2 space-y-1">
        {lines.map((l, i) => (
          <li key={l.itemId} className="flex flex-wrap items-center gap-1">
            <span className="w-64 max-w-full">{l.name} <span className="text-rce-muted">· {l.itemId}</span></span>
            <input className="field w-20 px-1 py-0.5 text-xs" inputMode="decimal" placeholder="Counted" value={l.qty} onChange={(e) => setLines((ls) => ls.map((x, idx) => (idx === i ? { ...x, qty: e.target.value } : x)))} />
            <span className="text-rce-muted">{l.unit ?? ""}</span>
            <input className="field w-24 px-1 py-0.5 text-xs" inputMode="decimal" placeholder="Unit cost" value={l.unitCost} onChange={(e) => setLines((ls) => ls.map((x, idx) => (idx === i ? { ...x, unitCost: e.target.value } : x)))} />
            <button type="button" className="btn btn-danger px-2 py-0.5 text-xs min-h-0" onClick={() => setLines((ls) => ls.filter((_, idx) => idx !== i))}>remove</button>
          </li>
        ))}
      </ul>
      <div className="mt-2 flex flex-wrap items-center gap-1">
        <input className="field w-64 max-w-full px-1 py-0.5 text-xs" placeholder="Reason (required) — e.g. Friday count" value={reason} onChange={(e) => setReason(e.target.value)} />
        <button type="button" className="btn btn-primary px-2 py-0.5 text-xs" disabled={!valid || count.isPending} onClick={() => count.mutate()}>{count.isPending ? "Saving…" : `Record count (${lines.length})`}</button>
        <button type="button" className="btn btn-secondary px-2 py-0.5 text-xs min-h-0" onClick={onDone}>cancel</button>
      </div>
      {error && <p className="mt-1 text-red-600">{error}</p>}
    </div>
  );
}

// ─── Tool register ───────────────────────────────────────────────────────────

function ToolsCard({ locations }: { locations: Location[] }) {
  const { data: tools = [], isLoading } = useQuery({ queryKey: ["tools"], queryFn: () => api.tools() });
  const [showAll, setShowAll] = useState(false);
  const [adding, setAdding] = useState(false);
  const [showRetired, setShowRetired] = useState(false);
  const live = tools.filter((t) => showRetired || t.condition !== "retired");
  const visible = showAll ? live : live.slice(0, PAGE_SIZE);
  const retired = tools.length - tools.filter((t) => t.condition !== "retired").length;
  return (
    <section className="card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">Tool register ({live.length})</h2>
          <p className="text-xs text-rce-muted">Tool POs land here. Tools live in the warehouse or on a truck and move as the jobs demand — every move leaves a trail.</p>
        </div>
        <span className="flex flex-wrap items-center gap-2">
          {retired > 0 && <button type="button" className="btn btn-secondary px-2 py-0.5 text-xs min-h-0" onClick={() => setShowRetired((s) => !s)}>{showRetired ? "hide retired" : `show retired (${retired})`}</button>}
          <button type="button" className="btn btn-secondary text-xs" onClick={() => setAdding((a) => !a)}>{adding ? "Hide" : "Add tool"}</button>
        </span>
      </div>
      {adding && <AddToolForm locations={locations} onDone={() => setAdding(false)} />}
      {isLoading && <p className="mt-2 text-sm text-rce-muted">Loading…</p>}
      {!isLoading && live.length === 0 && <p className="mt-2 text-sm text-rce-muted">No tools on the register yet — land a tool PO or add one by hand.</p>}
      {live.length > 0 && (
        <div className="mt-2 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-[11px] uppercase tracking-wide text-rce-soft">
            <tr><th className="pr-2">Tool</th><th className="pr-2">Serial</th><th className="pr-2 text-right">Cost</th><th className="pr-2">Condition</th><th className="pr-2">Location</th><th className="text-right">Actions</th></tr>
          </thead>
          <tbody>
            {visible.map((t) => <ToolRow key={t.id} tool={t} locations={locations} />)}
          </tbody>
        </table>
        </div>
      )}
      <ShowMore total={live.length} shown={visible.length} onMore={() => setShowAll(true)} />
    </section>
  );
}

function AddToolForm({ locations, onDone }: { locations: Location[]; onDone: () => void }) {
  const refresh = useInventoryRefresh();
  const [name, setName] = useState("");
  const [serial, setSerial] = useState("");
  const [cost, setCost] = useState("");
  const [locationKey, setLocationKey] = useState(WAREHOUSE_KEY);
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => api.createTool({ name: name.trim(), serial: serial.trim() || null, cost: cost.trim() === "" ? null : Number(cost), locationKey, notes: notes.trim() || null }),
    onSuccess: () => { setError(null); setName(""); setSerial(""); setCost(""); setNotes(""); refresh(); onDone(); },
    onError: (err) => setError((err as Error).message),
  });
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1 rounded-lg border border-rce-border p-3 text-xs">
      <input className="field w-48 px-1 py-0.5 text-xs" placeholder="Tool" value={name} onChange={(e) => setName(e.target.value)} />
      <input className="field w-28 px-1 py-0.5 text-xs" placeholder="Serial" value={serial} onChange={(e) => setSerial(e.target.value)} />
      <input className="field w-20 px-1 py-0.5 text-xs" inputMode="decimal" placeholder="Cost" value={cost} onChange={(e) => setCost(e.target.value)} />
      <select className="field px-1 py-0.5 text-xs" value={locationKey} onChange={(e) => setLocationKey(e.target.value)}>
        {locations.map((l) => <option key={l.key} value={l.key}>{l.label}</option>)}
      </select>
      <input className="field w-48 px-1 py-0.5 text-xs" placeholder="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
      <button type="button" className="btn btn-primary px-2 py-0.5 text-xs" disabled={!name.trim() || create.isPending} onClick={() => create.mutate()}>Add</button>
      <button type="button" className="btn btn-secondary px-2 py-0.5 text-xs min-h-0" onClick={onDone}>cancel</button>
      {error && <span className="w-full text-red-600">{error}</span>}
    </div>
  );
}

function ToolRow({ tool, locations }: { tool: ToolView; locations: Location[] }) {
  const refresh = useInventoryRefresh();
  const [mode, setMode] = useState<"view" | "move" | "edit">("view");
  const [error, setError] = useState<string | null>(null);
  const [to, setTo] = useState(locations.find((l) => l.key !== tool.locationKey)?.key ?? WAREHOUSE_KEY);
  const [name, setName] = useState(tool.name);
  const [serial, setSerial] = useState(tool.serial ?? "");
  const [cost, setCost] = useState(tool.cost == null ? "" : String(tool.cost));
  const [condition, setCondition] = useState<ToolCondition>(tool.condition);
  const [notes, setNotes] = useState(tool.notes ?? "");
  const onError = (err: unknown) => setError((err as Error).message);
  const done = () => { setError(null); setMode("view"); refresh(); };
  const move = useMutation({ mutationFn: (reason: string) => api.moveTool(tool.id, { toLocationKey: to, reason }), onSuccess: done, onError });
  const edit = useMutation({
    mutationFn: (reason: string) => api.updateTool(tool.id, { reason, name: name.trim(), serial: serial.trim() || null, cost: cost.trim() === "" ? null : Number(cost), condition, notes: notes.trim() || null }),
    onSuccess: done, onError,
  });
  const label = (key: string) => locations.find((l) => l.key === key)?.label ?? key;
  return (
    <>
      <tr className={`border-t border-rce-border/60 ${tool.condition === "retired" ? "text-rce-muted" : ""}`}>
        <td className="py-1 pr-2">{tool.name}{tool.purchaseOrderNumber ? <span className="text-xs text-rce-muted"> · {tool.purchaseOrderNumber}</span> : null}{tool.notes ? <span className="block text-xs text-rce-muted">{tool.notes}</span> : null}</td>
        <td className="py-1 pr-2 tabular-nums">{tool.serial ?? <span className="text-rce-muted">—</span>}</td>
        <td className="py-1 pr-2 text-right tabular-nums">{money(tool.cost)}</td>
        <td className="py-1 pr-2">
          <span className={`rounded px-1.5 py-0.5 text-[11px] ${tool.condition === "good" ? "bg-emerald-100 text-emerald-800" : tool.condition === "needs_repair" ? "bg-amber-100 text-amber-800" : "bg-slate-200 text-slate-700"}`}>{CONDITION_LABEL[tool.condition]}</span>
        </td>
        <td className="py-1 pr-2">{label(tool.locationKey)}</td>
        <td className="py-1 text-right text-xs">
          <span className="inline-flex gap-2 whitespace-nowrap">
            <button type="button" className="btn btn-secondary px-2 py-0.5 text-xs min-h-0" onClick={() => setMode(mode === "move" ? "view" : "move")}>Move</button>
            <button type="button" className="btn btn-secondary px-2 py-0.5 text-xs min-h-0" onClick={() => setMode(mode === "edit" ? "view" : "edit")}>Edit</button>
          </span>
        </td>
      </tr>
      {mode !== "view" && (
        <tr className="bg-rce-bg text-xs">
          <td colSpan={6} className="px-2 py-2">
            {mode === "move" && (
              <span className="inline-flex flex-wrap items-center gap-1">
                <span>Move to</span>
                <select className="field px-1 py-0.5 text-xs" value={to} onChange={(e) => setTo(e.target.value)}>
                  {locations.filter((l) => l.key !== tool.locationKey).map((l) => <option key={l.key} value={l.key}>{l.label}</option>)}
                </select>
                <ReasonRow label="Move" busy={move.isPending} onSubmit={(reason) => move.mutate(reason)} onCancel={() => setMode("view")} placeholder="Reason (optional)" />
              </span>
            )}
            {mode === "edit" && (
              <span className="inline-flex flex-wrap items-center gap-1">
                <input className="field w-44 px-1 py-0.5 text-xs" value={name} onChange={(e) => setName(e.target.value)} placeholder="Tool" />
                <input className="field w-28 px-1 py-0.5 text-xs" value={serial} onChange={(e) => setSerial(e.target.value)} placeholder="Serial" />
                <input className="field w-20 px-1 py-0.5 text-xs" inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} placeholder="Cost" />
                <select className="field px-1 py-0.5 text-xs" value={condition} onChange={(e) => setCondition(e.target.value as ToolCondition)}>
                  {(Object.keys(CONDITION_LABEL) as ToolCondition[]).map((c) => <option key={c} value={c}>{CONDITION_LABEL[c]}</option>)}
                </select>
                <input className="field w-44 px-1 py-0.5 text-xs" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes" />
                <ReasonRow label="Save" busy={edit.isPending || !name.trim()} onSubmit={(reason) => edit.mutate(reason)} onCancel={() => setMode("view")} />
              </span>
            )}
            {error && <p className="mt-1 text-red-600">{error}</p>}
          </td>
        </tr>
      )}
    </>
  );
}
