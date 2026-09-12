/**
 * Trucks (Kyle, 2026-09-09).
 *
 * "Each tech will have their own card for material and gas through stripe and
 * I will have to set up a financial account for each." One row per truck: its
 * tech, its card, its financial-account balance, and this month's spend by
 * kind. Gas and maintenance belong to the truck, never a job. Materials on the
 * card go looking for a PO on their own; the ones still missing a receipt
 * photo are listed here so the photo gets attached ("photo verifies, card
 * proves").
 *
 * Detail expands in place — no new window or tab (Kyle's rule). Every edit
 * to a card transaction takes a one-line reason.
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { PageHeader } from "../components/PageHeader";
import { api } from "../lib/api";
import type { CardSpendKind, CardSpendRow, ReceiptCandidate, TruckRow } from "../lib/types";
import { money, shortDate } from "../lib/utils";

const KIND_LABEL: Record<CardSpendKind, string> = {
  materials: "Materials",
  fuel: "Fuel",
  maintenance: "Maintenance",
  tool: "Tools",
  // Job fees (Kyle, 2026-09-11) — subtracted from job profit before commission.
  permit: "Permit fee",
  inspection: "Inspection fee",
  other: "Other",
};
const KINDS: CardSpendKind[] = ["materials", "fuel", "maintenance", "tool", "permit", "inspection", "other"];

/** Everything a truck or card-spend change can move. */
function useTruckRefresh() {
  const queryClient = useQueryClient();
  return () => {
    for (const key of [["trucks"], ["truck"], ["card-spend"], ["card-spend-receipt-candidates"], ["purchase-orders"], ["purchase-order"], ["receipts-needing-po"], ["receipt-review"], ["financials"], ["financials-balances"]]) {
      void queryClient.invalidateQueries({ queryKey: key });
    }
  };
}

function ReasonRow({ label, busy, onSubmit, onCancel }: { label: string; busy: boolean; onSubmit: (reason: string) => void; onCancel: () => void }) {
  const [reason, setReason] = useState("");
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <input className="field w-52 max-w-full px-1 py-0.5 text-xs" placeholder="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} />
      <button type="button" className="btn btn-primary px-2 py-0.5 text-xs" disabled={!reason.trim() || busy} onClick={() => onSubmit(reason.trim())}>{label}</button>
      <button type="button" className="text-xs text-rce-muted" onClick={onCancel}>cancel</button>
    </span>
  );
}

export function TrucksPage() {
  const { data, isLoading } = useQuery({ queryKey: ["trucks"], queryFn: api.trucks });
  const { data: technicians = [] } = useQuery({ queryKey: ["technicians"], queryFn: api.technicians });
  const refresh = useTruckRefresh();
  const [openId, setOpenId] = useState<string | null>(null);
  const [year, setYear] = useState(new Date().getFullYear());
  const [newName, setNewName] = useState("");
  const [newTech, setNewTech] = useState("");
  const [syncNote, setSyncNote] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => api.createTruck({ name: newName.trim(), technicianId: newTech || null }),
    onSuccess: () => { setNewName(""); setNewTech(""); refresh(); },
  });
  const sync = useMutation({
    mutationFn: () => api.syncCardSpend(30),
    onSuccess: (r) => {
      setSyncNote(r.available ? `${r.seen} transaction(s) seen · ${r.created} new · ${r.updated} refreshed` : r.reason);
      refresh();
    },
    onError: (err) => setSyncNote((err as Error).message),
  });

  const trucks = data?.trucks ?? [];
  const techName = (id: string | null) => technicians.find((t) => t.id === id)?.name ?? null;

  return (
    <div className="space-y-6">
      <PageHeader title="Trucks" subtitle="Each truck's tech, card, balance, and this month's fuel, maintenance and materials on the card" />

      <section className="card p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-rce-muted">
            Spend routes to a truck by the card — never by guessing. Gas and maintenance belong to the truck, never a job.
            A materials swipe with no PO behind it drafts one after the fact; it cannot close until the receipt photo is on it.
          </p>
          <span className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn btn-secondary text-sm" disabled={sync.isPending} onClick={() => sync.mutate()}>
              {sync.isPending ? "Syncing…" : "Sync card spend (30 days)"}
            </button>
            <button className="btn btn-secondary text-xs" onClick={() => setYear((y) => y - 1)}>← {year - 1}</button>
            <span className="text-sm font-semibold">{year}</span>
            <button className="btn btn-secondary text-xs" onClick={() => setYear((y) => y + 1)}>{year + 1} →</button>
          </span>
        </div>
        {syncNote && <p className="mt-1 text-xs text-rce-muted">{syncNote}</p>}
        {data && !data.balancesAvailable && (
          <p className="mt-2 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
            Balances are not readable yet — the restricted Stripe key needs Money Management <b>Financial Accounts Read</b> (and Transactions Read for the card feed) in the Dashboard.
            {data.balancesReason ? <span className="block text-amber-800">{data.balancesReason}</span> : null}
          </p>
        )}

        {isLoading && <p className="mt-2 text-sm text-rce-muted">Loading…</p>}
        <ul className="mt-3 space-y-1">
          {trucks.map((t) => (
            <li key={t.id} className={`rounded-lg border border-rce-border px-3 py-2 text-sm ${t.isActive ? "" : "opacity-60"}`}>
              <button type="button" className="flex w-full flex-wrap items-center justify-between gap-2 text-left" onClick={() => setOpenId(openId === t.id ? null : t.id)}>
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{t.name}</span>
                  <span className="text-xs text-rce-muted">{t.technicianName ?? techName(t.technicianId) ?? "no tech"}</span>
                  {t.cardLast4
                    ? <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] tabular-nums text-slate-700">card ••••{t.cardLast4}</span>
                    : <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-800">no card</span>}
                  {!t.isActive && <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[11px] text-slate-700">retired</span>}
                </span>
                <span className="flex flex-wrap items-center gap-3 text-xs tabular-nums text-rce-muted">
                  <span>balance {t.balance ? money(t.balance.cashUsd) : t.stripeFinancialAccountId ? "—" : "no account"}</span>
                  <span>MTD fuel {money(t.mtd.fuel)}</span>
                  <span>maint. {money(t.mtd.maintenance)}</span>
                  <span>materials on card {money(t.mtd.materials)}</span>
                  {/* Build 3: what the truck is carrying. */}
                  <span>stock {money(t.stockValue)}</span>
                  <span>{t.toolCount} tool{t.toolCount === 1 ? "" : "s"}</span>
                  {t.unmatchedMaterials > 0
                    ? <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-800">{t.unmatchedMaterials} need a receipt</span>
                    : <span className="text-emerald-700">receipts matched</span>}
                  <span className="text-rce-accent">{openId === t.id ? "Hide" : "Open"}</span>
                </span>
              </button>
              {openId === t.id && <TruckDetailPanel truck={t} year={year} technicians={technicians} />}
            </li>
          ))}
        </ul>
        {data?.unassigned && (data.unassigned.unmatched > 0 || data.unassigned.materials + data.unassigned.fuel + data.unassigned.maintenance + data.unassigned.other + data.unassigned.tool !== 0) && (
          <p className="mt-2 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
            Spend this month on a card no truck claims: fuel {money(data.unassigned.fuel)} · maintenance {money(data.unassigned.maintenance)} · materials {money(data.unassigned.materials)}.
            Map the card on its truck below and the rows follow it.
          </p>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-rce-border pt-3">
          <input className="field w-40" placeholder="New truck name" value={newName} onChange={(e) => setNewName(e.target.value)} />
          <select className="field" value={newTech} onChange={(e) => setNewTech(e.target.value)}>
            <option value="">No tech yet</option>
            {technicians.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <button type="button" className="btn btn-primary text-sm" disabled={!newName.trim() || create.isPending} onClick={() => create.mutate()}>Add truck</button>
          {create.error && <span className="w-full text-xs text-red-600">{(create.error as Error).message}</span>}
        </div>
      </section>
    </div>
  );
}

// ─── Detail: settings, ledger, receipts needed ────────────────────────────────

function TruckDetailPanel({ truck, year, technicians }: { truck: TruckRow; year: number; technicians: { id: string; name: string }[] }) {
  const { data: detail } = useQuery({ queryKey: ["truck", truck.id, year], queryFn: () => api.truck(truck.id, year) });
  if (!detail) return <p className="mt-2 text-xs text-rce-muted">Loading…</p>;
  return (
    <div className="mt-2 space-y-3 rounded-md bg-rce-bg p-3 text-xs">
      <TruckSettings truck={truck} technicians={technicians} />
      {detail.balance && (
        <p className="tabular-nums">
          Financial account <span className="font-semibold">{money(detail.balance.cashUsd)}</span> cash
          {detail.balance.inboundPending ? ` · ${money(detail.balance.inboundPending)} inbound pending` : ""}
          {detail.balance.outboundPending ? ` · ${money(detail.balance.outboundPending)} outbound pending` : ""}
          <span className="text-rce-muted"> · {detail.balance.status}</span>
        </p>
      )}
      {!detail.balance && truck.stripeFinancialAccountId && !detail.balancesAvailable && (
        <p className="text-amber-800">Balance not readable — the Stripe key needs Treasury read scope.</p>
      )}

      <NeedingReceipt rows={detail.needingReceipt} />

      <div>
        <p className="font-semibold uppercase tracking-wide text-rce-soft">Ledger {year}</p>
        {detail.ledger.every((k) => k.rows.length === 0) && <p className="text-rce-muted">No card spend this year.</p>}
        {detail.ledger.filter((k) => k.rows.length > 0).map((k) => (
          <LedgerKind key={k.kind} kind={k.kind} total={k.total} rows={k.rows} />
        ))}
      </div>

      <div>
        <p className="font-semibold uppercase tracking-wide text-rce-soft">Purchase orders on this truck ({detail.purchaseOrders.length})</p>
        {detail.purchaseOrders.length === 0 && <p className="text-rce-muted">None this year.</p>}
        <ul className="mt-1 space-y-0.5">
          {detail.purchaseOrders.slice(0, 12).map((po) => (
            <li key={po.id} className="flex flex-wrap items-center gap-2">
              <span className="font-semibold tabular-nums">{po.number}</span>
              <span>{po.supplier}</span>
              <span className="text-rce-muted">{po.status} · opened {shortDate(po.openedAt)}</span>
              {po.cardMatched && <span className="rounded bg-sky-100 px-1 text-[11px] text-sky-800">card</span>}
              {po.afterTheFact && <span className="rounded bg-amber-100 px-1 text-[11px] text-amber-800">after the fact</span>}
            </li>
          ))}
        </ul>
        {detail.purchaseOrders.length > 12 && (
          <Link to="/financials" className="text-rce-accent hover:underline">All POs live on Financials → Purchases</Link>
        )}
      </div>
    </div>
  );
}

function TruckSettings({ truck, technicians }: { truck: TruckRow; technicians: { id: string; name: string }[] }) {
  const refresh = useTruckRefresh();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(truck.name);
  const [technicianId, setTechnicianId] = useState(truck.technicianId ?? "");
  const [stripeCardId, setStripeCardId] = useState(truck.stripeCardId ?? "");
  const [cardLast4, setCardLast4] = useState(truck.cardLast4 ?? "");
  const [financialAccountId, setFinancialAccountId] = useState(truck.stripeFinancialAccountId ?? "");
  const [notes, setNotes] = useState(truck.notes ?? "");
  const [isActive, setIsActive] = useState(truck.isActive);
  const [manualCard, setManualCard] = useState(false);
  const { data: cards } = useQuery({ queryKey: ["trucks-stripe-cards"], queryFn: api.truckStripeCards, enabled: editing });
  const save = useMutation({
    mutationFn: () => api.updateTruck(truck.id, {
      name: name.trim(), technicianId: technicianId || null, stripeCardId: stripeCardId.trim() || null, cardLast4: cardLast4.trim() || null,
      stripeFinancialAccountId: financialAccountId.trim() || null, notes: notes.trim() || null, isActive,
    }),
    onSuccess: () => { setEditing(false); refresh(); },
  });
  const [actionError, setActionError] = useState<string | null>(null);
  const retire = useMutation({
    mutationFn: () => api.updateTruck(truck.id, { isActive: false }),
    onSuccess: () => { setActionError(null); setEditing(false); refresh(); },
    onError: (err) => setActionError((err as Error).message),
  });
  const remove = useMutation({
    mutationFn: () => api.deleteTruck(truck.id),
    onSuccess: () => { setActionError(null); setEditing(false); refresh(); },
    onError: (err) => setActionError((err as Error).message),
  });
  const pickCard = (id: string) => {
    setStripeCardId(id);
    const card = cards?.available ? cards.cards.find((c) => c.id === id) : undefined;
    if (card) {
      setCardLast4(card.last4);
      if (card.financialAccountId && !financialAccountId) setFinancialAccountId(card.financialAccountId);
    }
  };

  if (!editing) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0 break-words">
          <span className="font-semibold">{truck.name}</span> · {truck.technicianName ?? "no tech"} ·
          {truck.stripeCardId ? ` card ${truck.stripeCardId}${truck.cardLast4 ? ` (••••${truck.cardLast4})` : ""}` : " no card mapped"} ·
          {truck.stripeFinancialAccountId ? ` account ${truck.stripeFinancialAccountId}` : " no financial account"}
          {truck.notes ? <span className="block text-rce-muted">{truck.notes}</span> : null}
        </span>
        <button type="button" className="text-rce-accent" onClick={() => setEditing(true)}>Edit</button>
      </div>
    );
  }
  const cardOptions = cards?.available ? cards.cards : [];
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-1">
        <input className="field w-36 px-1 py-0.5 text-xs" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" />
        <select className="field px-1 py-0.5 text-xs" value={technicianId} onChange={(e) => setTechnicianId(e.target.value)}>
          <option value="">No tech</option>
          {technicians.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <label className="flex items-center gap-1"><input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} /> active</label>
        {/* Kyle, 2026-09-10: "need to be able to delete truck 1. This should be editable and
            trucks retired." Retire hides it (the server refuses while stock, tools or open POs
            sit on it); Delete is only for a truck the books never pointed at. */}
        {truck.isActive && (
          <button
            type="button"
            className="btn btn-secondary px-2 py-0.5 text-xs"
            disabled={retire.isPending}
            onClick={() => { if (window.confirm(`Retire ${truck.name}? It leaves every picker and stays in history.`)) retire.mutate(); }}
          >
            Retire truck
          </button>
        )}
        <button
          type="button"
          className="text-xs text-red-600 hover:underline"
          disabled={remove.isPending}
          onClick={() => { if (window.confirm(`Delete ${truck.name}? Only works when nothing in the books points at it.`)) remove.mutate(); }}
        >
          Delete
        </button>
        {actionError && <span className="w-full text-xs text-red-600">{actionError}</span>}
      </div>
      <div className="flex flex-wrap items-center gap-1">
        {cards && cards.available && !manualCard ? (
          <select className="field px-1 py-0.5 text-xs" value={stripeCardId} onChange={(e) => pickCard(e.target.value)}>
            <option value="">No card</option>
            {cardOptions.map((c) => (
              <option key={c.id} value={c.id}>••••{c.last4} · {c.cardholderName ?? "cardholder"} · {c.status}</option>
            ))}
            {stripeCardId && !cardOptions.some((c) => c.id === stripeCardId) && <option value={stripeCardId}>{stripeCardId}</option>}
          </select>
        ) : (
          <input className="field w-52 max-w-full px-1 py-0.5 text-xs" value={stripeCardId} onChange={(e) => setStripeCardId(e.target.value)} placeholder="Issuing card id (ic_…)" />
        )}
        {cards && cards.available && (
          <button type="button" className="text-rce-accent" onClick={() => setManualCard((m) => !m)}>{manualCard ? "pick from Stripe" : "type the id"}</button>
        )}
        {cards && !cards.available && <span className="text-amber-800">This card is issued by your Financial Account, not classic Issuing — enter the last 4 and pick the financial account below; spend routes by the account.</span>}
        <input className="field w-16 px-1 py-0.5 text-xs" value={cardLast4} onChange={(e) => setCardLast4(e.target.value.replace(/\D/g, "").slice(0, 4))} placeholder="last4" />
        <input className="field w-52 max-w-full px-1 py-0.5 text-xs" value={financialAccountId} onChange={(e) => setFinancialAccountId(e.target.value)} placeholder="Financial account id (fa_…)" />
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <input className="field w-72 max-w-full px-1 py-0.5 text-xs" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes" />
        <button type="button" className="btn btn-primary px-2 py-0.5 text-xs" disabled={!name.trim() || save.isPending} onClick={() => save.mutate()}>Save</button>
        <button type="button" className="text-rce-muted" onClick={() => setEditing(false)}>cancel</button>
        {save.error && <span className="w-full text-red-600">{(save.error as Error).message}</span>}
      </div>
    </div>
  );
}

// ─── Card spend needing a receipt ─────────────────────────────────────────────

function NeedingReceipt({ rows }: { rows: CardSpendRow[] }) {
  return (
    <div>
      <p className="font-semibold uppercase tracking-wide text-amber-800">Card spend needing a receipt ({rows.length})</p>
      {rows.length === 0 && <p className="text-rce-muted">Every materials swipe has its receipt photo.</p>}
      <ul className="mt-1 space-y-1">
        {rows.map((r) => <NeedingRow key={r.id} row={r} />)}
      </ul>
    </div>
  );
}

function NeedingRow({ row }: { row: CardSpendRow }) {
  const refresh = useTruckRefresh();
  const [mode, setMode] = useState<"view" | "attach" | "ignore">("view");
  const [choice, setChoice] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { data: candidates = [] } = useQuery({
    queryKey: ["card-spend-receipt-candidates", row.id],
    queryFn: () => api.cardSpendReceiptCandidates(row.id),
    enabled: mode === "attach",
  });
  const patch = useMutation({
    mutationFn: (input: { receiptId?: string; status?: "ignored"; reason: string }) => api.updateCardSpend(row.id, input),
    onSuccess: () => { setError(null); setMode("view"); setChoice(""); refresh(); },
    onError: (err) => setError((err as Error).message),
  });
  const label = (c: ReceiptCandidate) =>
    `${c.vendor || "Unknown vendor"} · ${money(c.amount)}${c.exact ? " ✓" : ""} · ${shortDate(c.receivedAt)}${c.purchaseOrderNumber ? ` · ${c.purchaseOrderNumber}` : ""}${c.status !== "confirmed" ? " · needs review" : ""}`;
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 rounded border border-amber-200 bg-amber-50/40 px-2 py-1">
      <span className="min-w-0">
        <span className="font-medium">{row.merchantName}</span> · <span className="tabular-nums">{money(row.amount)}</span> · {shortDate(row.occurredAt)}
        {row.purchaseOrderNumber && <span className="ml-1 rounded bg-slate-100 px-1 tabular-nums text-slate-700">{row.purchaseOrderNumber}</span>}
        {row.purchaseOrderAfterTheFact && <span className="ml-1 rounded bg-amber-100 px-1 text-amber-800">after the fact</span>}
        {/* Kyle, 2026-09-10: a swipe shows up pending and posts a day or two later. */}
        {row.settlement === "pending" && <span className="ml-1 rounded bg-slate-100 px-1 text-slate-600">pending</span>}
      </span>
      {mode === "view" && (
        <span className="flex gap-2">
          <button type="button" className="text-rce-accent" onClick={() => setMode("attach")}>Attach receipt</button>
          <button type="button" className="text-red-600" onClick={() => setMode("ignore")}>Ignore</button>
        </span>
      )}
      {mode === "attach" && (
        <span className="inline-flex flex-wrap items-center gap-1">
          <select className="field px-1 py-0.5 text-xs" value={choice} onChange={(e) => setChoice(e.target.value)}>
            <option value="">Receipt…</option>
            {candidates.map((c) => <option key={c.id} value={c.id}>{label(c)}</option>)}
          </select>
          {candidates.length === 0 && <span className="text-rce-muted">no unmatched receipts near this date — upload the photo first</span>}
          <ReasonRow label="Attach" busy={patch.isPending} onSubmit={(reason) => patch.mutate({ receiptId: choice, reason })} onCancel={() => setMode("view")} />
        </span>
      )}
      {mode === "ignore" && (
        <ReasonRow label="Ignore" busy={patch.isPending} onSubmit={(reason) => patch.mutate({ status: "ignored", reason })} onCancel={() => setMode("view")} />
      )}
      {error && <span className="w-full text-red-600">{error}</span>}
    </li>
  );
}

// ─── Ledger rows ──────────────────────────────────────────────────────────────

function LedgerKind({ kind, total, rows }: { kind: CardSpendKind; total: number; rows: CardSpendRow[] }) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? rows : rows.slice(0, 8);
  return (
    <div className="mt-1">
      <p className="flex items-center justify-between">
        <span className="font-medium">{KIND_LABEL[kind]}</span>
        <span className="tabular-nums">{money(total)}</span>
      </p>
      <div className="overflow-x-auto">
      <table className="w-full">
        <tbody>
          {visible.map((r) => <LedgerRow key={r.id} row={r} />)}
        </tbody>
      </table>
      </div>
      {rows.length > 8 && !showAll && (
        <button type="button" className="text-rce-accent" onClick={() => setShowAll(true)}>Show more ({rows.length - 8})</button>
      )}
    </div>
  );
}

function LedgerRow({ row }: { row: CardSpendRow }) {
  const refresh = useTruckRefresh();
  const [editing, setEditing] = useState(false);
  const [kind, setKind] = useState<CardSpendKind>(row.kind);
  const [error, setError] = useState<string | null>(null);
  const patch = useMutation({
    mutationFn: (input: { kind?: CardSpendKind; status?: "unmatched"; receiptId?: null; reason: string }) => api.updateCardSpend(row.id, input),
    onSuccess: () => { setError(null); setEditing(false); refresh(); },
    onError: (err) => setError((err as Error).message),
  });
  return (
    <tr className={`border-t border-rce-border/60 ${row.status === "ignored" ? "text-rce-muted line-through" : ""}`}>
      <td className="py-0.5 pr-2 tabular-nums">{shortDate(row.occurredAt)}</td>
      <td className="py-0.5 pr-2">{row.merchantName}{row.merchantCity ? <span className="text-rce-muted"> · {row.merchantCity}</span> : null}</td>
      <td className="py-0.5 pr-2 text-right tabular-nums">{money(row.amount)}</td>
      <td className="py-0.5 pr-2 tabular-nums">{row.purchaseOrderNumber ?? <span className="text-rce-muted">—</span>}{row.purchaseOrderAfterTheFact ? <span className="ml-1 rounded bg-amber-100 px-1 text-[11px] text-amber-800">after the fact</span> : null}</td>
      <td className="py-0.5 pr-2">
        {row.receiptId ? <span className="text-emerald-700">receipt ✓</span> : row.status === "ignored" ? `ignored — ${row.ignoredReason ?? ""}` : row.kind === "materials" && row.amount > 0 ? <span className="text-amber-800">no receipt</span> : <span className="text-rce-muted">—</span>}
      </td>
      <td className="py-0.5 text-right">
        {!editing && <button type="button" className="text-rce-accent" onClick={() => setEditing(true)}>edit</button>}
        {editing && (
          <span className="inline-flex flex-wrap items-center justify-end gap-1">
            <select className="field px-1 py-0.5 text-xs" value={kind} onChange={(e) => setKind(e.target.value as CardSpendKind)}>
              {KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
            </select>
            <ReasonRow
              label="Save"
              busy={patch.isPending}
              onSubmit={(reason) => patch.mutate({ kind, ...(row.status === "ignored" ? { status: "unmatched" as const } : {}), reason })}
              onCancel={() => setEditing(false)}
            />
            {row.receiptId && (
              <button type="button" className="text-red-600" onClick={() => { const reason = window.prompt("Reason for detaching the receipt?"); if (reason?.trim()) patch.mutate({ receiptId: null, reason: reason.trim() }); }}>detach receipt</button>
            )}
          </span>
        )}
        {error && <span className="block text-red-600">{error}</span>}
      </td>
    </tr>
  );
}
