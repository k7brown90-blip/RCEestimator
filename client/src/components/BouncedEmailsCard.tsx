/**
 * Bounced emails — the Financials card that lists every customer email Gmail could not
 * deliver, with the account, what was sent, the receiver's reason, and a Resolve door.
 *
 * Kyle, 2026-09-09: *"My emails are not getting to the clients"* / *"very few are actually
 * getting through, this is priority number one."* The transport checked out (SPF, DKIM,
 * DMARC all pass); what was missing was anyone SEEING the Delivery Status Notifications
 * Gmail dropped in the inbox. The server polls them every ten minutes; "Check now" runs
 * the same poll on demand.
 *
 * Resolve means Kyle dealt with it — called the customer, fixed the address, re-sent — and
 * takes a note so the trail says what happened. Resolving also clears the red badge on
 * the estimate the bounce named.
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import type { EmailBounceRow } from "../lib/types";

const KIND_LABEL: Record<string, string> = {
  estimate: "Estimate",
  invoice: "Invoice",
  appointment: "Appointment email",
  deposit: "Deposit request",
  balance: "Balance request",
  receipt: "Receipt",
  campaign: "Campaign",
  other: "Email",
};

/** Everything the estimate/invoice pages invalidate when a flag changes. */
const FLAG_QUERY_KEYS = [["email-bounces"], ["estimate-chain"], ["invoices"], ["account-estimates"]] as const;

export function BouncedEmailsCard() {
  const queryClient = useQueryClient();
  const { data: rows = [], isLoading } = useQuery({
    queryKey: ["email-bounces", "unresolved"],
    queryFn: () => api.emailBounces(true),
  });
  const [notice, setNotice] = useState<string | null>(null);

  const invalidate = () => {
    for (const key of FLAG_QUERY_KEYS) void queryClient.invalidateQueries({ queryKey: [...key] });
  };

  const poll = useMutation({
    mutationFn: () => api.pollEmailBounces(),
    onSuccess: (r) => {
      setNotice(
        r.available
          ? `Checked the mailbox — ${r.scanned} bounce notice${r.scanned === 1 ? "" : "s"} in the last week, ${r.new} new.`
          : `Could not read the mailbox: ${r.reason}`,
      );
      invalidate();
    },
    onError: (err: Error) => setNotice(err.message),
  });

  return (
    <section className="card p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">
            Bounced emails <span className="text-sm font-normal text-rce-muted">({rows.length})</span>
          </h2>
          <p className="text-xs text-rce-muted">
            Customer emails the receiver rejected. The mailbox is checked every 10 minutes.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-secondary text-sm"
          disabled={poll.isPending}
          onClick={() => poll.mutate()}
        >
          {poll.isPending ? "Checking…" : "Check now"}
        </button>
      </div>

      {notice && <p className="mt-2 text-xs text-rce-muted">{notice}</p>}

      {isLoading && <p className="mt-3 text-sm text-rce-muted">Loading…</p>}

      {!isLoading && rows.length === 0 && (
        <p className="mt-3 rounded-lg border border-dashed border-rce-border/60 p-4 text-center text-sm text-rce-soft">
          Nothing has bounced. A bounce shows up here within ten minutes of Gmail reporting it.
        </p>
      )}

      <ul className="mt-3 space-y-2">
        {rows.map((row) => (
          <BounceItem key={row.id} row={row} onResolved={invalidate} />
        ))}
      </ul>
    </section>
  );
}

function BounceItem({ row, onResolved }: { row: EmailBounceRow; onResolved: () => void }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const resolve = useMutation({
    mutationFn: () => api.resolveEmailBounce(row.id, note.trim() || null),
    onSuccess: () => { setOpen(false); onResolved(); },
  });

  const what = row.estimate
    ? `${KIND_LABEL[row.kind] ?? "Email"} ${row.estimate.number}${row.estimate.revision > 1 ? ` rev ${row.estimate.revision}` : ""} — ${row.estimate.title}`
    : row.originalSubject
      ? `${KIND_LABEL[row.kind] ?? "Email"} — ${row.originalSubject}`
      : KIND_LABEL[row.kind] ?? "Email";
  const reason = [row.status, (row.diagnostic ?? "").replace(/^smtp;\s*/i, "")].filter(Boolean).join(" ")
    || "No diagnostic in the bounce notice.";

  return (
    <li className="rounded-lg border border-red-200 bg-red-50/40 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            {row.account ? (
              <Link to={`/accounts/${row.account.id}`} className="font-semibold text-rce-accent underline-offset-2 hover:underline">
                {row.account.name}
              </Link>
            ) : (
              <span className="font-semibold text-rce-muted">No account matched</span>
            )}
            <span className="rounded bg-red-100 px-1.5 py-0.5 text-[11px] font-semibold text-red-800">bounced</span>
          </div>
          <p className="text-sm">{what}</p>
          <p className="text-xs text-rce-muted">
            To <span className="font-medium text-rce-text">{row.recipient}</span>
            {row.remoteMta ? ` · refused by ${row.remoteMta}` : ""}
            {" · "}
            {new Date(row.bouncedAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
          </p>
          <p className="mt-1 break-words text-xs text-red-800">{reason}</p>
        </div>
        <button type="button" className="btn btn-secondary text-sm" onClick={() => setOpen((v) => !v)}>
          {open ? "Cancel" : "Resolve"}
        </button>
      </div>

      {open && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            className="field flex-1 text-sm"
            placeholder="What you did — called, fixed the address, re-sent…"
            value={note}
            maxLength={500}
            onChange={(e) => setNote(e.target.value)}
          />
          <button
            type="button"
            className="btn btn-primary text-sm"
            disabled={resolve.isPending}
            onClick={() => resolve.mutate()}
          >
            {resolve.isPending ? "Saving…" : "Mark resolved"}
          </button>
          {resolve.isError && <p className="w-full text-xs text-red-700">{(resolve.error as Error).message}</p>}
        </div>
      )}
    </li>
  );
}
