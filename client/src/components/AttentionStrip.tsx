/**
 * The per-tab "needs attention" strip (2026-09-20, tab separation — build #5 of the
 * "drawers and tab purpose" plan).
 *
 * Kyle: "we need to review what can be separated so each tab is very clear what its for
 * and what information is there." So every tab opens with ONE short strip that answers that
 * tab's own question — Estimates: which quotes are stale or never arrived; Purchasing & Stock:
 * which money has no proof; Financials: which money is owed or bounced; Leads: which follow-ups
 * are overdue. Per tab, never one merged queue: a merged queue is the Dashboard's job ("what is
 * stuck today"), and merging tabs is exactly what Kyle rejected.
 *
 * Every strip is assembled from a queue the tab ALREADY fetches (`/receipt-review`,
 * `/receipts-needing-po`, the live P.O. list, `/warranty-receivables`, `/invoices`,
 * `/crm/analytics/follow-ups`, the estimate chain) — no new endpoints were invented for it.
 *
 * Renders nothing when there is nothing to say. A strip that reads "0 · 0 · 0" is clutter,
 * and a tab with a clean strip should look clean.
 */

import type { ReactNode } from "react";

export type AttentionChip = {
  key: string;
  /** "3 P.O.s need proof", "2 bounced" — already pluralised by the caller. */
  label: string;
  count: number;
  tone?: "amber" | "red";
};

export type AttentionRow = {
  key: string;
  text: ReactNode;
  detail?: ReactNode;
  /** The record's own action — an Open (drawer) button, Attach receipt, a link to the account. */
  action?: ReactNode;
};

const CHIP_TONE = {
  amber: "bg-amber-100 text-amber-900",
  red: "bg-red-100 text-red-900",
} as const;

/** Rows shown before "and N more" — the strip is a heads-up, not the list. */
const ROW_CAP = 5;

export function AttentionStrip({
  title = "Needs attention",
  chips,
  rows = [],
  moreText,
}: {
  title?: string;
  chips: AttentionChip[];
  rows?: AttentionRow[];
  /** Where the rest live when the rows are capped — "the rest are in the cards below". */
  moreText?: string;
}) {
  const live = chips.filter((c) => c.count > 0);
  if (live.length === 0 && rows.length === 0) return null;
  const visible = rows.slice(0, ROW_CAP);
  const hidden = rows.length - visible.length;

  return (
    <section
      data-attention-strip
      className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3"
      aria-label={title}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold text-amber-900">{title}</h2>
        {live.map((chip) => (
          <span
            key={chip.key}
            className={`rounded-full px-2 py-0.5 text-xs font-medium tabular-nums ${CHIP_TONE[chip.tone ?? "amber"]}`}
          >
            {chip.label}
          </span>
        ))}
      </div>
      {visible.length > 0 && (
        <ul className="mt-2 space-y-1">
          {visible.map((row) => (
            <li
              key={row.key}
              className="flex flex-wrap items-center justify-between gap-2 rounded border border-amber-200 bg-white px-3 py-1.5 text-sm"
            >
              <span className="min-w-0">
                <span className="font-medium">{row.text}</span>
                {row.detail !== undefined && row.detail !== null && (
                  <span className="block text-xs text-rce-muted">{row.detail}</span>
                )}
              </span>
              {row.action !== undefined && row.action !== null && (
                <span className="flex shrink-0 flex-wrap items-center gap-2">{row.action}</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {hidden > 0 && (
        <p className="mt-1 text-xs text-amber-800">
          and {hidden} more{moreText ? ` — ${moreText}` : ""}
        </p>
      )}
    </section>
  );
}
