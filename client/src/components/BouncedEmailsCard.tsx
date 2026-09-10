/**
 * Bounced emails — the Financials card that lists every customer email that could not be
 * delivered, with the account, what was sent, the receiver's reason, and a Resolve door.
 *
 * Kyle, 2026-09-09: *"My emails are not getting to the clients"* / *"very few are actually
 * getting through, this is priority number one."* The transport checked out (SPF, DKIM,
 * DMARC all pass); what was missing was anyone SEEING the failures. Two sources feed this
 * card now: Resend's bounced / complained webhook (customer email leaves Resend-first, with
 * Gmail as the automatic fallback) within a minute, and Gmail's Delivery Status Notifications,
 * read from the mailbox every ten minutes — "Check now" runs that poll on demand.
 *
 * The status strip at the top says which pipe is live and whether the delivery webhook is
 * verified, so a silent misconfiguration (no RESEND_WEBHOOK_SECRET) is visible here rather
 * than as a row that never turns green.
 *
 * Resolve means Kyle dealt with it — called the customer, fixed the address, re-sent — and
 * takes a note so the trail says what happened. Resolving also clears the red badge on
 * the estimate the bounce named.
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import type { EmailBounceRow, EmailStatus } from "../lib/types";

const KIND_LABEL: Record<string, string> = {
  estimate: "Estimate",
  invoice: "Invoice",
  appointment: "Appointment email",
  deposit: "Deposit request",
  balance: "Balance request",
  receipt: "Receipt",
  health_record: "Electrical Health Record",
  document: "Document",
  campaign: "Campaign",
  other: "Email",
};

/**
 * One line: "Transactional email: Resend (service@…), Gmail fallback · webhook: connected".
 * The webhook is "connected" once the secret is set AND an event has arrived; "secret set,
 * no events yet" between; "NOT connected" when the secret is missing — with the fix named.
 */
function EmailStatusStrip({ status }: { status?: EmailStatus }) {
  if (!status) return null;
  const fromAddress = status.from.match(/<([^>]+)>/)?.[1] ?? status.from;
  const pipe = status.provider === "resend"
    ? `Resend (${fromAddress}), Gmail fallback`
    : status.resendConfigured
      ? "Gmail (Resend is configured but TRANSACTIONAL_EMAIL_PROVIDER=gmail)"
      : "Gmail only — set RESEND_API_KEY to switch to Resend";
  const webhook = !status.webhookSecretSet
    ? { text: "NOT connected — set RESEND_WEBHOOK_SECRET", tone: "text-red-700" }
    : status.lastWebhookEventAt
      ? {
          text: `connected (last event ${new Date(status.lastWebhookEventAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })})`,
          tone: "text-emerald-700",
        }
      : { text: "secret set, no events yet", tone: "text-amber-700" };
  const c = status.last24h;
  const counts = [
    c.delivered ? `${c.delivered} delivered` : null,
    c.sent ? `${c.sent} sent` : null,
    c.delayed ? `${c.delayed} delayed` : null,
    c.bounced ? `${c.bounced} bounced` : null,
    c.complained ? `${c.complained} complained` : null,
    c.failed ? `${c.failed} failed` : null,
  ].filter(Boolean).join(", ");
  return (
    <p className="mt-2 rounded-md border border-rce-border/60 bg-rce-bg/40 px-2.5 py-1.5 text-xs text-rce-muted">
      Transactional email: <span className="font-medium text-rce-text">{pipe}</span>
      {" · "}webhook: <span className={`font-medium ${webhook.tone}`}>{webhook.text}</span>
      {status.provider === "resend" && (
        <>{" · "}last 24 h: <span className="text-rce-text">{counts || "no emails"}</span></>
      )}
    </p>
  );
}

/** Everything the estimate/invoice pages invalidate when a flag changes. */
const FLAG_QUERY_KEYS = [["email-bounces"], ["estimate-chain"], ["invoices"], ["account-estimates"]] as const;

export function BouncedEmailsCard() {
  const queryClient = useQueryClient();
  const { data: rows = [], isLoading } = useQuery({
    queryKey: ["email-bounces", "unresolved"],
    queryFn: () => api.emailBounces(true),
  });
  const { data: status } = useQuery({ queryKey: ["email-status"], queryFn: api.emailStatus, refetchInterval: 60_000 });
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
            Customer emails the receiver rejected. Resend reports within a minute; Gmail's mailbox is checked every 10 minutes.
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

      <EmailStatusStrip status={status} />

      {notice && <p className="mt-2 text-xs text-rce-muted">{notice}</p>}

      {isLoading && <p className="mt-3 text-sm text-rce-muted">Loading…</p>}

      {!isLoading && rows.length === 0 && (
        <p className="mt-3 rounded-lg border border-dashed border-rce-border/60 p-4 text-center text-sm text-rce-soft">
          Nothing has bounced. A Resend bounce shows up here within a minute; a Gmail one within ten.
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
  // Gmail rows: "5.7.0 554 …" (status code + Diagnostic-Code). Resend rows: the bounce type
  // ("Permanent" / "Transient") and Resend's message.
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
            <span className="rounded bg-red-100 px-1.5 py-0.5 text-[11px] font-semibold text-red-800">
              {row.action === "complained" ? "complained" : "bounced"}
            </span>
            {row.provider && (
              <span className="text-[11px] text-rce-muted">via {row.provider === "resend" ? "Resend" : "Gmail"}</span>
            )}
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
