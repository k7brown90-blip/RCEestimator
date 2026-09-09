/**
 * Inventory (Kyle, 2026-09-09, Build 3).
 *
 * "We need an inventory tab that tracks what is on the truck and what is at
 * the warehouse so on future jobs I can label some stock as truckstock and it
 * won't double count the cost." "Warehouse items will only be used to
 * transfer material to truck stock." "There is only one warehouse for now it
 * is my home location."
 *
 * Top: POs waiting to land and restock requests from the trucks. Then one card
 * per location — the warehouse first, then each truck — with on hand, moving-
 * average unit cost, value, an editable par, and a low-stock flag. Row actions:
 * Transfer to truck (warehouse rows only — Kyle's rule), Adjust (a count with a
 * reason), history (the movements, each correctable with a reason). The tool
 * register sits at the bottom. Everything in-card; rows cap at 12 with Show
 * more (Kyle's no-endless-list rule). Nothing here charges a job — Build 4.
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { PageHeader } from "../components/PageHeader";
import { LandingPanel } from "../components/LandingPanel";
import { PO_PURPOSE_LABEL, PoStatusPill } from "../components/PurchaseOrders";
import { api } from "../lib/api";
import type { InventoryItem, InventoryOverview, InventoryTruck, StockLevelView, StockMovementView, StockRequestView, ToolCondition, ToolView } from "../lib/types";
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
      <input className="field w-52 px-1 py-0.5 text-xs" placeholder={placeholder} value={reason} onChange={(e) => setReason(e.target.value)} />
      <button type="button" className="btn btn-primary px-2 py-0.5 text-xs" disabled={!reason.trim() || busy} onClick={() => onSubmit(reason.trim())}>{label}</button>
      <button type="button" className="text-xs text-rce-muted" onClick={onCancel}>cancel</button>
    </span>
  );
}

function ShowMore({ total, shown, onMore }: { total: number; shown: number; onMore: () => void }) {
  if (total <= shown) return null;
  return <button type="button" className="mt-1 text-xs text-rce-accent" onClick={onMore}>Show more ({total - shown})</button>;
}

// ─── The page ────────────────────────────────────────────────────────────────

export function InventoryPage() {
  const { data, isLoading, error } = useQuery({ queryKey: ["inventory"], queryFn: api.inventory });
  const locations = locationsOf(data);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Inventory"
        subtitle="What is on each truck and in the warehouse, at moving-average cost. The warehouse only feeds the trucks; jobs are charged from truck stock."
        actions={<Link to="/financials" className="btn btn-secondary text-sm">Start PO → Financials</Link>}
      />
      {isLoading && <p className="text-sm text-rce-muted">Loading…</p>}
      {error && <p className="text-sm text-red-600">{(error as Error).message}</p>}
      {data && (
        <>
          <PosToLand pos={data.unlandedPos} />
          <RestockRequests requests={data.openRequests} />
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

// ─── POs to land ─────────────────────────────────────────────────────────────

function PosToLand({ pos }: { pos: InventoryOverview["unlandedPos"] }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? pos : pos.slice(0, PAGE_SIZE);
  return (
    <section className="card p-4">
      <h2 className="text-lg font-semibold">POs to land ({pos.length})</h2>
      <p className="mb-2 text-xs text-rce-muted">Purchased and verified POs whose material has not landed yet. Landing puts it on the truck or in the warehouse (a tool PO onto the register) and closes the PO.</p>
      {pos.length === 0 && <p className="text-sm text-rce-muted">Nothing waiting to land.</p>}
      <ul className="space-y-1">
        {visible.map((po) => (
          <li key={po.id} className="rounded-lg border border-rce-border px-3 py-1.5 text-sm">
            <button type="button" className="flex w-full flex-wrap items-center justify-between gap-2 text-left" onClick={() => setOpenId(openId === po.id ? null : po.id)}>
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
                <span className="text-rce-accent">{openId === po.id ? "Hide" : "Land"}</span>
              </span>
            </button>
            {openId === po.id && (
              <div className="mt-2 rounded-md bg-rce-bg p-3">
                <LandingPanel poId={po.id} onLanded={() => setOpenId(null)} />
              </div>
            )}
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
      <span>
        <span className="font-medium">{row.truckName}</span> wants <span className="tabular-nums">{qtyText(row.qty)} {row.unit ?? ""}</span> {row.name}
        {row.itemId ? <span className="text-xs text-rce-muted"> · {row.itemId}</span> : <span className="text-xs text-amber-800"> · not a book item</span>}
        <span className="block text-xs text-rce-muted">{shortDate(row.createdAt)}{row.note ? ` · ${row.note}` : ""}</span>
      </span>
      {mode === "view" && (
        <span className="flex gap-2 text-xs">
          <button type="button" className="btn btn-primary px-2 py-0.5 text-xs" disabled={fulfill.isPending} onClick={() => fulfill.mutate()}>Fulfill</button>
          <button type="button" className="text-red-600 hover:underline" onClick={() => setMode("decline")}>Decline</button>
        </span>
      )}
      {mode === "decline" && <ReasonRow label="Decline" busy={decline.isPending} onSubmit={(reason) => decline.mutate(reason)} onCancel={() => setMode("view")} />}
      {error && <span className="w-full text-xs text-red-600">{error}</span>}
    </li>
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
          <Link to="/financials" className="btn btn-secondary text-xs">Start PO</Link>
        </span>
      </div>
      {counting && <CountForm locationKey={locationKey} onDone={() => setCounting(false)} />}
      {levels.length === 0 && <p className="mt-2 text-sm text-rce-muted">Nothing on hand yet — land a PO here, or Count what is already on the shelf.</p>}
      {levels.length > 0 && (
        <table className="mt-2 w-full text-sm">
          <thead className="text-left text-[11px] uppercase tracking-wide text-rce-soft">
            <tr><th className="pr-2">Item</th><th className="pr-2 text-right">On hand</th><th className="pr-2 text-right">Unit cost</th><th className="pr-2 text-right">Value</th><th className="pr-2 text-right">Par</th><th className="text-right">Actions</th></tr>
          </thead>
          <tbody>
            {visible.map((l) => <LevelRow key={l.id} level={l} locationKey={locationKey} trucks={trucks} isWarehouse={isWarehouse} />)}
          </tbody>
        </table>
      )}
      <ShowMore total={levels.length} shown={visible.length} onMore={() => setShowAll(true)} />
    </section>
  );
}

function LevelRow({ level, locationKey, trucks, isWarehouse }: { level: StockLevelView; locationKey: string; trucks: InventoryTruck[]; isWarehouse: boolean }) {
  const refresh = useInventoryRefresh();
  const [mode, setMode] = useState<"view" | "transfer" | "adjust" | "history">("view");
  const [error, setError] = useState<string | null>(null);
  const [parEditing, setParEditing] = useState(false);
  const [par, setPar] = useState(level.parLevel == null ? "" : String(level.parLevel));
  const [truckId, setTruckId] = useState(trucks[0]?.truck.id ?? "");
  const [qty, setQty] = useState("");
  const onError = (err: unknown) => setError((err as Error).message);
  const done = () => { setError(null); setMode("view"); setQty(""); refresh(); };
  const setParLevel = useMutation({ mutationFn: (value: number | null) => api.setParLevel(level.id, value), onSuccess: () => { setError(null); setParEditing(false); refresh(); }, onError });
  const transfer = useMutation({ mutationFn: (reason: string) => api.transferStock({ itemId: level.itemId, qty: Number(qty), toTruckId: truckId, reason }), onSuccess: done, onError });
  const adjust = useMutation({ mutationFn: (reason: string) => api.countStock({ locationKey, reason, lines: [{ itemId: level.itemId, name: level.name, unit: level.unit, qty: Number(qty) }] }), onSuccess: done, onError });
  const qtyOk = Number.isFinite(Number(qty)) && Number(qty) >= 0 && qty.trim() !== "";
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
              <button type="button" className="text-xs text-rce-accent" disabled={setParLevel.isPending} onClick={() => setParLevel.mutate(par.trim() === "" ? null : Number(par))}>save</button>
              <button type="button" className="text-xs text-rce-muted" onClick={() => setParEditing(false)}>cancel</button>
            </span>
          ) : (
            <button type="button" className="text-rce-accent hover:underline" title="Set the restock threshold" onClick={() => setParEditing(true)}>{level.parLevel == null ? "set" : qtyText(level.parLevel)}</button>
          )}
        </td>
        <td className="py-1 text-right text-xs">
          <span className="inline-flex gap-2">
            {isWarehouse && <button type="button" className="text-rce-accent" onClick={() => setMode(mode === "transfer" ? "view" : "transfer")}>Transfer to truck</button>}
            <button type="button" className="text-rce-accent" onClick={() => setMode(mode === "adjust" ? "view" : "adjust")}>Adjust</button>
            <button type="button" className="text-rce-accent" onClick={() => setMode(mode === "history" ? "view" : "history")}>{mode === "history" ? "hide history" : "history"}</button>
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
      <span>
        <span className="tabular-nums text-rce-muted">{new Date(m.at).toLocaleString()}</span> · {KIND_LABEL[m.kind]}
        {" "}<span className={`tabular-nums ${sign < 0 ? "text-red-700" : "text-emerald-700"}`}>{sign > 0 ? "+" : ""}{qtyText(sign)}</span>
        {m.kind === "count" ? ` → ${qtyText(m.qty)} counted` : ""}
        {m.unitCost != null ? ` @ ${unitMoney(m.unitCost)}` : ""}
        {other ? ` ${other}` : ""}
        {m.purchaseOrderId ? " · PO" : ""}
        {m.correctsId ? " · corrects an earlier movement" : ""}
        <span className="text-rce-muted"> · {m.actor}{m.reason ? ` — ${m.reason}` : ""}</span>
      </span>
      {!correcting && <button type="button" className="text-rce-accent" onClick={() => setCorrecting(true)}>correct</button>}
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
      <input className="field w-64 px-1 py-0.5 text-xs" placeholder="Search the book (item id or name)…" value={q} onChange={(e) => setQ(e.target.value)} />
      {q.trim().length >= 2 && items.length > 0 && (
        <ul className="absolute z-10 mt-1 max-h-56 w-96 overflow-auto rounded-md border border-rce-border bg-white text-xs shadow">
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
            <span className="w-64">{l.name} <span className="text-rce-muted">· {l.itemId}</span></span>
            <input className="field w-20 px-1 py-0.5 text-xs" inputMode="decimal" placeholder="Counted" value={l.qty} onChange={(e) => setLines((ls) => ls.map((x, idx) => (idx === i ? { ...x, qty: e.target.value } : x)))} />
            <span className="text-rce-muted">{l.unit ?? ""}</span>
            <input className="field w-24 px-1 py-0.5 text-xs" inputMode="decimal" placeholder="Unit cost" value={l.unitCost} onChange={(e) => setLines((ls) => ls.map((x, idx) => (idx === i ? { ...x, unitCost: e.target.value } : x)))} />
            <button type="button" className="text-red-600" onClick={() => setLines((ls) => ls.filter((_, idx) => idx !== i))}>remove</button>
          </li>
        ))}
      </ul>
      <div className="mt-2 flex flex-wrap items-center gap-1">
        <input className="field w-64 px-1 py-0.5 text-xs" placeholder="Reason (required) — e.g. Friday count" value={reason} onChange={(e) => setReason(e.target.value)} />
        <button type="button" className="btn btn-primary px-2 py-0.5 text-xs" disabled={!valid || count.isPending} onClick={() => count.mutate()}>{count.isPending ? "Saving…" : `Record count (${lines.length})`}</button>
        <button type="button" className="text-rce-muted" onClick={onDone}>cancel</button>
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
          {retired > 0 && <button type="button" className="text-xs text-rce-accent" onClick={() => setShowRetired((s) => !s)}>{showRetired ? "hide retired" : `show retired (${retired})`}</button>}
          <button type="button" className="btn btn-secondary text-xs" onClick={() => setAdding((a) => !a)}>{adding ? "Hide" : "Add tool"}</button>
        </span>
      </div>
      {adding && <AddToolForm locations={locations} onDone={() => setAdding(false)} />}
      {isLoading && <p className="mt-2 text-sm text-rce-muted">Loading…</p>}
      {!isLoading && live.length === 0 && <p className="mt-2 text-sm text-rce-muted">No tools on the register yet — land a tool PO or add one by hand.</p>}
      {live.length > 0 && (
        <table className="mt-2 w-full text-sm">
          <thead className="text-left text-[11px] uppercase tracking-wide text-rce-soft">
            <tr><th className="pr-2">Tool</th><th className="pr-2">Serial</th><th className="pr-2 text-right">Cost</th><th className="pr-2">Condition</th><th className="pr-2">Location</th><th className="text-right">Actions</th></tr>
          </thead>
          <tbody>
            {visible.map((t) => <ToolRow key={t.id} tool={t} locations={locations} />)}
          </tbody>
        </table>
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
      <button type="button" className="text-rce-muted" onClick={onDone}>cancel</button>
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
          <span className="inline-flex gap-2">
            <button type="button" className="text-rce-accent" onClick={() => setMode(mode === "move" ? "view" : "move")}>Move</button>
            <button type="button" className="text-rce-accent" onClick={() => setMode(mode === "edit" ? "view" : "edit")}>Edit</button>
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
