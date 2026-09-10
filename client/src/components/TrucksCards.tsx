/**
 * The Financials-side view of trucks and money on hand (Kyle, 2026-09-09).
 *
 * BalancesStrip sits at the very top of Financials: Payments available/pending
 * and every Treasury financial account's cash with its truck's name — or the
 * "connect the read scope" note until the restricted key can read them.
 * TrucksCard is one compact row per truck (MTD fuel / maintenance / materials
 * on card / unmatched), linking to /trucks for the ledger.
 */

import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { money } from "../lib/utils";

export function BalancesStrip() {
  const { data } = useQuery({ queryKey: ["financials-balances"], queryFn: api.financialsBalances });
  if (!data) return null;
  return (
    <section className="card flex flex-wrap items-center gap-x-6 gap-y-1 p-3 text-sm">
      <span className="text-xs font-semibold uppercase tracking-wide text-rce-soft">Balances</span>
      {data.payments ? (
        <span className="tabular-nums">
          Payments <b>{money(data.payments.available)}</b> available
          <span className="text-rce-muted"> · {money(data.payments.pending)} pending</span>
        </span>
      ) : (
        <span className="text-xs text-rce-muted">Payments balance not readable</span>
      )}
      {data.available ? (
        data.financialAccounts.length === 0 ? (
          <span className="text-xs text-rce-muted">No financial accounts yet</span>
        ) : (
          data.financialAccounts.map((fa) => (
            <span key={fa.id} className="min-w-0 break-words tabular-nums">
              {fa.truckName ?? fa.id} <b>{money(fa.cashUsd)}</b>
              {fa.inboundPending ? <span className="text-rce-muted"> · {money(fa.inboundPending)} inbound</span> : null}
              {fa.outboundPending ? <span className="text-rce-muted"> · {money(fa.outboundPending)} outbound</span> : null}
            </span>
          ))
        )
      ) : (
        <span className="text-xs text-amber-800">
          Truck accounts not connected — add Issuing and Treasury <b>read</b> scope to the restricted Stripe key.
        </span>
      )}
      <Link to="/trucks" className="ml-auto text-xs text-rce-accent hover:underline">Trucks →</Link>
    </section>
  );
}

export function TrucksCard() {
  const { data } = useQuery({ queryKey: ["trucks"], queryFn: api.trucks });
  const trucks = (data?.trucks ?? []).filter((t) => t.isActive);
  return (
    <section className="card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Trucks</h2>
        <Link to="/trucks" className="text-xs text-rce-accent hover:underline">Open the ledger →</Link>
      </div>
      <p className="mb-2 text-xs text-rce-muted">
        This month on each truck's card. Gas and maintenance belong to the truck, never a job; materials on the card go looking for their PO and receipt.
      </p>
      {trucks.length === 0 && <p className="text-sm text-rce-muted">No trucks yet.</p>}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-rce-border text-left text-xs uppercase text-rce-soft">
              <th className="py-1 pr-2">Truck</th>
              <th className="py-1 pr-2">Card</th>
              <th className="py-1 pr-2 text-right">Fuel</th>
              <th className="py-1 pr-2 text-right">Maintenance</th>
              <th className="py-1 pr-2 text-right">Materials on card</th>
              <th className="py-1 text-right">Unmatched</th>
            </tr>
          </thead>
          <tbody>
            {trucks.map((t) => (
              <tr key={t.id} className="border-b border-rce-border/60">
                <td className="py-1 pr-2"><Link to="/trucks" className="text-rce-accent hover:underline">{t.name}</Link>{t.technicianName ? <span className="text-xs text-rce-muted"> · {t.technicianName}</span> : null}</td>
                <td className="py-1 pr-2 tabular-nums">{t.cardLast4 ? `••••${t.cardLast4}` : <span className="text-xs text-amber-800">no card</span>}</td>
                <td className="py-1 pr-2 text-right tabular-nums">{money(t.mtd.fuel)}</td>
                <td className="py-1 pr-2 text-right tabular-nums">{money(t.mtd.maintenance)}</td>
                <td className="py-1 pr-2 text-right tabular-nums">{money(t.mtd.materials)}</td>
                <td className="py-1 text-right tabular-nums">{t.unmatchedMaterials > 0 ? <span className="rounded bg-amber-100 px-1.5 text-amber-800">{t.unmatchedMaterials}</span> : <span className="text-emerald-700">0</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
