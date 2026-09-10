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
 * Kyle, 2026-09-07: *"This needs organized. It is turning into an endless list. We need it
 * sectioned into Sent, Viewed, and Sold. Scheduled would live in the jobs tab ... I want an
 * organized and separated page where each has its own search and list. I do not want endless
 * cards being added."* Three cards, each with its own search and a capped list that grows only
 * when asked. A signed estimate leaves this page the moment its job is on the schedule — from
 * then on it is the Jobs tab's business.
 *
 * Test-account rows are excluded by the server. Price-book practice is an instrument with a
 * planned deletion, and it must not mix into the numbers Kyle reads off this page.
 */

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { PageHeader } from "../components/PageHeader";
import { api } from "../lib/api";
import type { PbChainRow } from "../lib/types";
import { money } from "../lib/utils";

/** Rows shown per card before "Show more" — the page never grows on its own. */
const PAGE_SIZE = 8;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Where a row lives on this page. `gone` rows belong to the Jobs tab and are not shown at all. */
type Bucket = "sent" | "viewed" | "sold" | "hidden" | "gone";

/**
 * The funnel position this row has reached, in Kyle's own sequence, and which card it lands in.
 * `hidden` rows (drafts, expired, void, superseded) sit behind the Sent card's toggle.
 */
function classify(row: PbChainRow, now: number): { bucket: Bucket; label: string; tone: string } {
  const quiet = "bg-rce-border/50 text-rce-soft";
  if (row.supersededBy) return { bucket: "hidden", label: "superseded", tone: quiet };
  if (row.status === "void") return { bucket: "hidden", label: "void", tone: quiet };
  if (row.signedAt) {
    // Sold = signed and NOT yet on the schedule. Once the job has a start (or is already
    // finished), it is the Jobs tab's row, not this page's.
    const job = row.job;
    const onSchedule = Boolean(job?.scheduledStart) || job?.status === "completed" || job?.status === "cancelled";
    if (onSchedule) return { bucket: "gone", label: "scheduled", tone: quiet };
    return { bucket: "sold", label: "sold", tone: "bg-emerald-100 text-emerald-900" };
  }
  if (row.sentAt && row.validDays) {
    const expiresAt = new Date(row.sentAt).getTime() + row.validDays * DAY_MS;
    if (expiresAt < now) return { bucket: "hidden", label: "expired", tone: "bg-amber-100 text-amber-900" };
  }
  if (row.status === "viewed") return { bucket: "viewed", label: "viewed", tone: "bg-sky-100 text-sky-900" };
  if (row.status === "sent") return { bucket: "sent", label: "sent", tone: "bg-sky-100 text-sky-900" };
  return { bucket: "hidden", label: "draft", tone: "bg-amber-100 text-amber-900" };
}

type Classified = { row: PbChainRow; label: string; tone: string };

export function EstimatesPage() {
  const { data, isLoading } = useQuery({ queryKey: ["estimate-chain"], queryFn: api.estimateChain });
  const rows = data?.estimates ?? [];

  const sections = useMemo(() => {
    const now = Date.now();
    const out: Record<Exclude<Bucket, "gone">, Classified[]> = { sent: [], viewed: [], sold: [], hidden: [] };
    for (const row of rows) {
      const c = classify(row, now);
      if (c.bucket === "gone") continue;
      out[c.bucket].push({ row, label: c.label, tone: c.tone });
    }
    return out;
  }, [rows]);

  return (
    <div className="space-y-4 pb-24">
      <PageHeader
        title="Estimates"
        subtitle="What has been sent, what the customer has opened, and what is sold but not yet scheduled"
      />

      <div className="card p-3 text-xs text-rce-muted">
        Estimates are started from an account — open the account, pick the address you are working
        at, and tap <strong>Start an estimate</strong>. This page is the record of what has been
        quoted, not where quoting begins. Once a sold job is on the schedule it moves to the Jobs tab.
      </div>

      {isLoading && <p className="text-sm text-rce-muted">Loading…</p>}

      <SectionCard
        title="Sent"
        subtitle="Emailed or presented, not yet opened by the customer"
        rows={sections.sent}
        emptyText="Nothing waiting on a customer."
        hiddenRows={sections.hidden}
      />
      <SectionCard
        title="Viewed"
        subtitle="The customer has opened it and has not signed"
        rows={sections.viewed}
        emptyText="No estimates have been opened without a signature."
      />
      <SectionCard
        title="Sold"
        subtitle="Signed, waiting to be put on the schedule"
        rows={sections.sold}
        emptyText="Nothing sold is waiting on a schedule date."
      />
    </div>
  );
}

/**
 * One section. Search, the list cap, and the show-more all live INSIDE the card
 * (Kyle: "Each search and section would have its functions work within the card it is
 * constrained to"). The Sent card also owns the drafts / expired / void toggle.
 */
function SectionCard({
  title, subtitle, rows, emptyText, hiddenRows,
}: {
  title: string;
  subtitle: string;
  rows: Classified[];
  emptyText: string;
  /** Drafts, expired, void, superseded — only the Sent card carries these. */
  hiddenRows?: Classified[];
}) {
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [showHidden, setShowHidden] = useState(false);

  const pool = useMemo(
    () => (showHidden && hiddenRows ? [...rows, ...hiddenRows] : rows),
    [rows, hiddenRows, showHidden],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return pool;
    return pool.filter(({ row }) => {
      const addr = row.serviceAddress ? `${row.serviceAddress.addressLine1} ${row.serviceAddress.city}` : "";
      return [row.account.name, addr, row.number, row.title]
        .some((field) => field.toLowerCase().includes(q));
    });
  }, [pool, search]);

  const visible = filtered.slice(0, limit);
  const remaining = filtered.length - visible.length;

  return (
    <section className="card p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">
            {title} <span className="text-sm font-normal text-rce-muted">({rows.length})</span>
          </h2>
          <p className="text-xs text-rce-muted">{subtitle}</p>
        </div>
        {hiddenRows && (
          <label className="flex items-center gap-1.5 text-xs text-rce-muted">
            <input
              type="checkbox"
              checked={showHidden}
              onChange={(e) => { setShowHidden(e.target.checked); setLimit(PAGE_SIZE); }}
            />
            Show drafts / expired / void ({hiddenRows.length})
          </label>
        )}
      </div>

      <input
        className="field mt-2 w-full md:w-80"
        placeholder="Search name, address, estimate #, or title…"
        value={search}
        onChange={(e) => { setSearch(e.target.value); setLimit(PAGE_SIZE); }}
      />

      {filtered.length === 0 && (
        <p className="mt-3 rounded-lg border border-dashed border-rce-border/60 p-4 text-center text-sm text-rce-soft">
          {search ? "Nothing matches that search." : emptyText}
        </p>
      )}

      <div className="mt-3 space-y-2">
        {visible.map(({ row, label, tone }) => (
          <EstimateRow key={row.id} row={row} label={label} tone={tone} />
        ))}
      </div>

      {remaining > 0 && (
        <button
          type="button"
          className="btn btn-secondary mt-3 text-sm"
          onClick={() => setLimit((n) => n + PAGE_SIZE)}
        >
          Show more ({remaining} more)
        </button>
      )}
    </section>
  );
}

/** One estimate. Clicks through to the account, the same as the page always has. */
function EstimateRow({ row, label, tone }: Classified) {
  const addr = row.serviceAddress;
  return (
    <Link
      to={`/accounts/${row.account.id}`}
      className="block rounded-lg border border-rce-border p-3 active:opacity-70 hover:border-rce-accent"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">{row.account.name}</span>
            <span className={`rounded px-1.5 py-0.5 text-[11px] ${tone}`}>{label}</span>
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
          <div className="font-semibold">{money(row.billedTotal ?? row.total)}</div>
          {(row.warrantyCovered ?? 0) > 0 && (
            <div className="text-[11px] text-green-700">warranty −{money(row.warrantyCovered ?? 0)}</div>
          )}
          <div className="text-xs text-rce-soft">
            {new Date(row.createdAt).toLocaleDateString()}
          </div>
        </div>
      </div>
    </Link>
  );
}
