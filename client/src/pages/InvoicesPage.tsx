/**
 * Invoices — signed work and where its money stands.
 *
 * Kyle, 2026-08-26: "I need an invoices tab that tracks the invoices sent and
 * what ones are paid." An invoice IS a signed estimate (his 2026-08-21 ruling:
 * "The signed estimates need to be labeled invoices"), so this page lists every
 * signed, unvoided estimate with its payment rollup and clicks through to the
 * account, where the payment panel lives. It creates nothing and charges
 * nothing — it is the ledger view.
 */

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { PageHeader } from "../components/PageHeader";
import { api } from "../lib/api";
import type { InvoiceSummary } from "../lib/types";

const money = (v: number) => `$${v.toFixed(2)}`;

/** The four money states, in the order Kyle chases them. */
const STATUS_META: Record<InvoiceSummary["paymentStatus"], { label: string; tone: string }> = {
  unpaid: { label: "unpaid", tone: "bg-red-100 text-red-900" },
  partial: { label: "partial — under deposit", tone: "bg-amber-100 text-amber-900" },
  deposit_paid: { label: "deposit paid", tone: "bg-sky-100 text-sky-900" },
  paid: { label: "paid in full", tone: "bg-emerald-100 text-emerald-900" },
};

type Filter = "all" | "open" | InvoiceSummary["paymentStatus"];

export function InvoicesPage() {
  const { data: invoices = [], isLoading, error } = useQuery({
    queryKey: ["invoices"],
    queryFn: api.invoices,
  });
  const [filter, setFilter] = useState<Filter>("all");

  const visible = useMemo(() => {
    if (filter === "all") return invoices;
    if (filter === "open") return invoices.filter((inv) => inv.paymentStatus !== "paid");
    return invoices.filter((inv) => inv.paymentStatus === filter);
  }, [invoices, filter]);

  const totals = useMemo(() => ({
    outstanding: invoices.reduce((s, inv) => s + Math.max(inv.balance, 0), 0),
    collected: invoices.reduce((s, inv) => s + inv.collected, 0),
    openCount: invoices.filter((inv) => inv.paymentStatus !== "paid").length,
  }), [invoices]);

  const filters: { key: Filter; label: string }[] = [
    { key: "all", label: `All (${invoices.length})` },
    { key: "open", label: `Open (${totals.openCount})` },
    { key: "unpaid", label: "Unpaid" },
    { key: "deposit_paid", label: "Deposit paid" },
    { key: "paid", label: "Paid in full" },
  ];

  return (
    <div className="space-y-4 pb-24">
      <PageHeader
        title="Invoices"
        subtitle="Every signed estimate, what has been collected, and what is still owed"
      />

      <div className="grid grid-cols-2 gap-2">
        <div className="card p-3">
          <div className="text-xs uppercase tracking-wide text-rce-muted">Outstanding</div>
          <div className="text-lg font-semibold">{money(totals.outstanding)}</div>
        </div>
        <div className="card p-3">
          <div className="text-xs uppercase tracking-wide text-rce-muted">Collected</div>
          <div className="text-lg font-semibold text-emerald-700">{money(totals.collected)}</div>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {filters.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFilter(f.key)}
            className={`rounded-full px-3 py-1 text-xs font-medium transition ${
              filter === f.key
                ? "bg-rce-accent text-white"
                : "border border-rce-border bg-rce-surface text-rce-muted"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {isLoading && <p className="text-sm text-rce-muted">Loading invoices…</p>}
      {error ? <p className="text-sm text-red-500">Error loading invoices: {(error as Error).message}</p> : null}

      {!isLoading && visible.length === 0 && (
        <p className="rounded-lg border border-dashed border-rce-border/60 p-6 text-center text-sm text-rce-soft">
          {invoices.length === 0
            ? "No invoices yet. An invoice appears here when an estimate is signed."
            : "Nothing in this filter."}
        </p>
      )}

      <div className="space-y-2">
        {visible.map((inv) => {
          const s = STATUS_META[inv.paymentStatus];
          return (
            <Link
              key={inv.id}
              to={`/accounts/${inv.customer.id}`}
              className="card block p-3 active:opacity-70"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{inv.customer.name}</span>
                    <span className={`rounded px-1.5 py-0.5 text-[11px] ${s.tone}`}>{s.label}</span>
                  </div>
                  <div className="text-sm text-rce-text">{inv.title}</div>
                  <div className="text-xs text-rce-soft">{inv.serviceAddress}</div>
                  <div className="text-xs text-rce-muted">
                    {inv.number}
                    {inv.revision > 1 ? ` rev ${inv.revision}` : ""}
                    {" · signed "}
                    {new Date(inv.signedAt).toLocaleDateString()}
                    {inv.sentTo ? ` · sent to ${inv.sentTo}` : " · not emailed"}
                  </div>
                  {inv.discountTotal > 0 && (
                    <div className="text-xs text-emerald-700">
                      includes {money(inv.discountTotal)} non-card savings
                    </div>
                  )}
                </div>
                <div className="shrink-0 text-right">
                  <div className="font-semibold">{money(inv.billedTotal)}</div>
                  {inv.paymentStatus === "paid" ? (
                    <div className="text-xs font-medium text-emerald-700">
                      paid{inv.lastPaidAt ? ` ${new Date(inv.lastPaidAt).toLocaleDateString()}` : ""}
                    </div>
                  ) : (
                    <>
                      <div className="text-xs text-rce-soft">paid {money(inv.totalPaid)}</div>
                      <div className="text-xs font-medium text-red-700">owes {money(inv.balance)}</div>
                    </>
                  )}
                </div>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
