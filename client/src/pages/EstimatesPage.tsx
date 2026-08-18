/**
 * Estimates — a chain view, not a workshop. (P029)
 *
 * Kyle, 2026-08-18: *"the estimates tab is still stand alone that is wrong. How are we linking
 * estimates to accounts when they are made without any connection?"*
 *
 * So this page CREATES NOTHING. Every row names the account and the address the work is at, shows
 * where it has got to in the funnel, and clicks through to that account. Quoting starts from an
 * account (or a visit), which is the full-move ruling — there is deliberately no "new estimate"
 * button anywhere on this screen.
 *
 * Test-account rows are excluded by the server. Price-book practice is an instrument with a
 * planned deletion, and it must not mix into the numbers Kyle reads off this page.
 */

import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { PageHeader } from "../components/PageHeader";
import { api } from "../lib/api";
import type { PbChainRow } from "../lib/types";

const money = (v: number) => `$${v.toFixed(2)}`;

/** The funnel position this row has reached, in Kyle's own sequence. */
function stage(row: PbChainRow): { label: string; tone: string } {
  if (row.supersededBy) return { label: "superseded", tone: "bg-rce-border/50 text-rce-soft" };
  if (row.job) return { label: `job · ${row.job.status}`, tone: "bg-emerald-100 text-emerald-900" };
  if (row.signedAt) return { label: "signed", tone: "bg-emerald-100 text-emerald-900" };
  if (row.status === "viewed") return { label: "viewed", tone: "bg-sky-100 text-sky-900" };
  if (row.status === "sent") return { label: "sent", tone: "bg-sky-100 text-sky-900" };
  if (row.status === "void") return { label: "void", tone: "bg-rce-border/50 text-rce-soft" };
  return { label: "draft", tone: "bg-amber-100 text-amber-900" };
}

export function EstimatesPage() {
  const { data, isLoading } = useQuery({ queryKey: ["estimate-chain"], queryFn: api.estimateChain });
  const rows = data?.estimates ?? [];

  return (
    <div className="space-y-4 pb-24">
      <PageHeader
        title="Estimates"
        subtitle="Every quote, the account and address it belongs to, and where it got to"
      />

      <div className="card p-3 text-xs text-rce-muted">
        Estimates are started from an account — open the account, pick the address you are working
        at, and tap <strong>Start an estimate</strong>. This page is the record of what has been
        quoted, not where quoting begins.
      </div>

      {isLoading && <p className="text-sm text-rce-muted">Loading…</p>}

      {!isLoading && rows.length === 0 && (
        <p className="rounded-lg border border-dashed border-rce-border/60 p-6 text-center text-sm text-rce-soft">
          Nothing quoted yet. Open an account and tap <strong>Start an estimate</strong>.
        </p>
      )}

      <div className="space-y-2">
        {rows.map((row) => {
          const s = stage(row);
          const addr = row.serviceAddress;
          return (
            <Link
              key={row.id}
              to={`/accounts/${row.account.id}`}
              className="card block p-3 active:opacity-70"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{row.account.name}</span>
                    <span className={`rounded px-1.5 py-0.5 text-[11px] ${s.tone}`}>{s.label}</span>
                  </div>
                  <div className="text-sm text-rce-text">{row.title}</div>
                  {/* The address is the point of this row — an account with three properties
                      needs to say WHICH one the work is at. */}
                  <div className="text-xs text-rce-soft">
                    {addr ? `${addr.addressLine1}, ${addr.city}` : "address missing"}
                  </div>
                  <div className="text-xs text-rce-muted">
                    {row.number}
                    {row.revision > 1 ? ` rev ${row.revision}` : ""}
                    {row.signedChannel === "in_person" ? " · signed in person" : ""}
                    {row.signedChannel === "email" ? " · signed from the emailed link" : ""}
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <div className="font-semibold">{money(row.total)}</div>
                  <div className="text-xs text-rce-soft">
                    {new Date(row.createdAt).toLocaleDateString()}
                  </div>
                </div>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
