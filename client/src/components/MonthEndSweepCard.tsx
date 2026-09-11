/**
 * Month-end sweep (Kyle, 2026-09-09).
 *
 * "At the end of each month I will take whatever money is over that value and
 * deposit it into the Chase savings accounts for taxes and owner distributions."
 *
 * Ratified: the floats are set in Settings; the sweep happens ON A CLICK from
 * the number this card shows on the first of the month — never automatic. The
 * card shows the main account's balance, float, outbound in flight and the
 * EXCESS, each truck against its float, and the "Sweep $X to Chase" button
 * that asks Kyle to type SWEEP before the server moves a cent. When the sweep
 * cannot run the reason is written out (scope, no account chosen, no
 * destination, no excess). The last five attempts sit underneath with status.
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import type { SweepView, TreasurySweepRow } from "../lib/types";
import { money } from "../lib/utils";
import { CollapsibleCard } from "./CollapsibleCard";

const STATUS_LABEL: Record<string, string> = {
  created: "sent to Stripe",
  posted: "posted",
  failed: "failed",
  returned: "returned",
  canceled: "canceled",
};

function statusClass(status: string): string {
  if (status === "failed" || status === "returned" || status === "canceled") return "bg-red-100 text-red-800";
  if (status === "posted") return "bg-emerald-100 text-emerald-800";
  return "bg-amber-100 text-amber-800";
}

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function MonthEndSweepCard() {
  const queryClient = useQueryClient();
  const { data, isFetching } = useQuery({ queryKey: ["financials-sweep"], queryFn: () => api.financialsSweep(false) });
  const [confirming, setConfirming] = useState(false);
  const [amount, setAmount] = useState("");
  const [word, setWord] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["financials-sweep"] });
    void queryClient.invalidateQueries({ queryKey: ["financials-balances"] });
    void queryClient.invalidateQueries({ queryKey: ["trucks"] });
  };

  const sweep = useMutation({
    mutationFn: (input: { amount: number; confirm: string }) => api.runSweep(input),
    onSuccess: () => {
      setConfirming(false);
      setWord("");
      setError(null);
      invalidate();
    },
    onError: (e: Error) => setError(e.message),
  });

  /** Forget the five-minute cache and read Stripe again — the first-of-the-month number. */
  const refreshNow = async () => {
    setRefreshing(true);
    try {
      const fresh: SweepView = await api.financialsSweep(true);
      queryClient.setQueryData(["financials-sweep"], fresh);
      void queryClient.invalidateQueries({ queryKey: ["financials-balances"] });
    } finally {
      setRefreshing(false);
    }
  };

  if (!data) return null;
  const main = data.main;
  const excess = main?.excess ?? 0;
  const openConfirm = () => {
    setAmount(excess.toFixed(2));
    setWord("");
    setError(null);
    setConfirming(true);
  };
  const parsedAmount = Number(amount);
  const amountOk = Number.isFinite(parsedAmount) && parsedAmount > 0 && parsedAmount <= excess + 0.005;
  const ready = data.canSweep && amountOk && word.trim() === "SWEEP";

  // Folded by default (Kyle, 2026-09-10) — the header still says what a click would move.
  const summary = `Excess ${money(excess)} · ${data.trucks.length} truck${data.trucks.length === 1 ? "" : "s"}`;

  return (
    <CollapsibleCard id="month-end-sweep" title="Month-end sweep" summary={summary}>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <div className="flex items-center gap-3 text-xs text-rce-muted">
          <span>as of {when(data.asOf)}</span>
          <button type="button" className="btn btn-secondary text-xs" disabled={refreshing || isFetching} onClick={() => void refreshNow()}>
            {refreshing ? "Reading Stripe…" : "Read Stripe now"}
          </button>
        </div>
      </div>
      <p className="mb-3 text-xs text-rce-muted">
        Whatever the main account holds over its float goes to Chase for taxes and owner distributions — on your click,
        never on a schedule. Floats live in <Link to="/settings" className="text-rce-accent hover:underline">Settings → Treasury</Link>.
      </p>

      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        {/* Main account */}
        <div className="rounded-lg border border-rce-border p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-rce-soft">Main account</p>
          {main ? (
            <>
              <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 text-sm tabular-nums">
                <dt className="text-rce-muted">Balance</dt><dd className="text-right">{money(main.balance)}</dd>
                <dt className="text-rce-muted">Float (kept)</dt><dd className="text-right">− {money(main.float)}</dd>
                <dt className="text-rce-muted">Outbound pending</dt><dd className="text-right">− {money(main.outboundPending)}</dd>
                {main.inboundPending > 0 && (
                  <><dt className="text-rce-muted">Inbound pending (not counted)</dt><dd className="text-right text-rce-muted">{money(main.inboundPending)}</dd></>
                )}
              </dl>
              <p className="mt-2 text-xs uppercase tracking-wide text-rce-soft">Excess</p>
              <p className={`text-3xl font-bold tabular-nums ${excess > 0 ? "text-emerald-700" : "text-rce-muted"}`}>{money(excess)}</p>
              <p className="break-all text-xs text-rce-muted">{main.financialAccountId}</p>
            </>
          ) : (
            <p className="mt-1 text-sm text-rce-muted">Not readable yet.</p>
          )}
        </div>

        {/* Trucks against their floats */}
        <div className="rounded-lg border border-rce-border p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-rce-soft">Trucks</p>
          {data.trucks.length === 0 ? (
            <p className="mt-1 text-sm text-rce-muted">No trucks yet.</p>
          ) : (
            <div className="mt-1 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-rce-soft">
                  <th className="py-0.5 pr-2">Truck</th>
                  <th className="py-0.5 pr-2 text-right">Balance</th>
                  <th className="py-0.5 pr-2 text-right">Float</th>
                  <th className="py-0.5 text-right">Over / short</th>
                </tr>
              </thead>
              <tbody>
                {data.trucks.map((t) => (
                  <tr key={t.truckId} className="border-t border-rce-border/60">
                    <td className="py-0.5 pr-2">{t.truckName}{!t.financialAccountId && <span className="text-xs text-rce-muted"> · no account</span>}</td>
                    <td className="py-0.5 pr-2 text-right tabular-nums">{t.balance === null ? "—" : money(t.balance)}</td>
                    <td className="py-0.5 pr-2 text-right tabular-nums">{money(t.float)}</td>
                    <td className={`py-0.5 text-right tabular-nums ${t.excessOrShortfall !== null && t.excessOrShortfall < 0 ? "text-red-700" : ""}`}>
                      {t.excessOrShortfall === null ? "—" : t.excessOrShortfall < 0 ? `short ${money(-t.excessOrShortfall)}` : money(t.excessOrShortfall)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          )}
        </div>
      </div>

      {/* The click */}
      <div className="mt-3">
        {!data.canSweep ? (
          <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">{data.reason}</p>
        ) : !confirming ? (
          <button type="button" className="btn btn-primary" onClick={openConfirm}>
            Sweep {money(excess)} to {data.destination?.label ?? "Chase"}
          </button>
        ) : (
          <div className="rounded-lg border border-rce-border bg-white p-3">
            <p className="text-sm font-semibold">Confirm the sweep</p>
            <p className="break-words text-xs text-rce-muted">
              Stripe will move this from the main account to <b>{data.destination?.label}</b> ({data.destination?.externalAccountId}). At most the excess, {money(excess)}.
            </p>
            <div className="mt-2 grid gap-3 md:grid-cols-2">
              <label className="text-sm font-medium">
                Amount
                <input className="field mt-1 w-full tabular-nums" type="number" min="0.01" step="0.01" max={excess} value={amount} onChange={(e) => setAmount(e.target.value)} />
              </label>
              <label className="text-sm font-medium">
                Type SWEEP to confirm
                <input className="field mt-1 w-full" value={word} autoComplete="off" onChange={(e) => setWord(e.target.value)} placeholder="SWEEP" />
              </label>
            </div>
            {!amountOk && amount !== "" && <p className="mt-1 text-xs text-red-700">The amount must be more than zero and at most the excess.</p>}
            {error && <p className="mt-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">{error}</p>}
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                className="btn btn-primary"
                disabled={!ready || sweep.isPending}
                onClick={() => sweep.mutate({ amount: Math.round(parsedAmount * 100) / 100, confirm: word.trim() })}
              >
                {sweep.isPending ? "Sweeping…" : `Sweep ${Number.isFinite(parsedAmount) ? money(parsedAmount) : ""} now`}
              </button>
              <button type="button" className="btn btn-secondary" disabled={sweep.isPending} onClick={() => { setConfirming(false); setError(null); }}>Cancel</button>
            </div>
          </div>
        )}
        {!data.canSweep && error && <p className="mt-2 text-xs text-red-700">{error}</p>}
      </div>

      {/* The last five */}
      <RecentSweeps rows={data.recent} />
    </CollapsibleCard>
  );
}

function RecentSweeps({ rows }: { rows: TreasurySweepRow[] }) {
  if (rows.length === 0) return <p className="mt-3 text-xs text-rce-muted">No sweeps yet.</p>;
  return (
    <div className="mt-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-rce-soft">Last {rows.length === 1 ? "sweep" : `${rows.length} sweeps`}</p>
      <ul className="mt-1 space-y-1">
        {rows.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 rounded-lg border border-rce-border px-3 py-1.5 text-sm">
            <span className="tabular-nums">{when(r.createdAt)}</span>
            <span className="font-medium tabular-nums">{money(r.amount)}</span>
            <span className="text-rce-muted">→ {r.destinationLabel}</span>
            <span className={`rounded px-1.5 text-xs ${statusClass(r.status)}`}>{STATUS_LABEL[r.status] ?? r.status}</span>
            {r.stripeTransferId && <span className="break-all text-xs text-rce-muted">{r.stripeTransferId}</span>}
            {r.error && <span className="basis-full break-words text-xs text-red-700">{r.error}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
