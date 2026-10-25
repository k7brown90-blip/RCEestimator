/**
 * "Send email" — the record's own follow-up action (2026-09-20 communications build).
 *
 * Kyle: "Follow ups can be done by sending an email straight from the CRM." One panel, used on
 * the lead, account and job drawers: a compose form (recipient, subject, body) that posts to
 * `POST /communications/email`, plus the thread of what has already been sent — "the thread of
 * what has been sent shows ON the record — that is what makes a follow-up trackable rather than
 * a thing Kyle remembers." Reuses `SendToPicker` for the recipient when the record has one
 * (account, job); a lead before conversion has no CustomerContact rows, so it falls back to a
 * plain override input seeded with the lead's own email.
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { EmailDeliveryRow } from "../lib/types";
import { CcChips, SendToPicker } from "./SendToPicker";

const STATUS_TONE: Record<string, string> = {
  sent: "text-rce-muted",
  delivered: "text-rce-success",
  delayed: "text-amber-700",
  bounced: "text-red-700",
  complained: "text-red-700",
  failed: "text-red-700",
};

function threadKeyFor(target: "lead" | "account" | "job", id: string) {
  if (target === "lead") return { leadId: id };
  if (target === "account") return { customerId: id };
  return { visitId: id };
}

export function SendEmailPanel({
  target,
  id,
  primaryEmail,
  /** Present only when the record has CustomerContact rows to offer (account, job). */
  accountIdForContacts,
}: {
  target: "lead" | "account" | "job";
  id: string;
  primaryEmail: string | null;
  accountIdForContacts?: string | null;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState<string | null>(null);
  const [customTo, setCustomTo] = useState(primaryEmail ?? "");
  // CC (Kyle, 2026-10-24: "The email will be the same as doing a CC email.") - on every record.
  const [cc, setCc] = useState<string[]>([]);
  const [ccTyped, setCcTyped] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  const threadKey = threadKeyFor(target, id);
  const { data: thread } = useQuery({
    queryKey: ["email-deliveries", target, id],
    queryFn: () => api.emailDeliveries(threadKey),
  });

  const addTypedCc = () => {
    const a = ccTyped.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a)) return;
    if (!cc.some((c) => c.toLowerCase() === a.toLowerCase())) setCc([...cc, a]);
    setCcTyped("");
  };

  const send = useMutation({
    mutationFn: () => api.sendRecordEmail({
      target,
      id,
      to: accountIdForContacts ? to : (customTo.trim() || null),
      ...(cc.length > 0 ? { cc } : {}),
      subject: subject.trim(),
      body: body.trim(),
    }),
    onSuccess: (result) => {
      setSubject("");
      setBody("");
      const everyone = result.cc && result.cc.length > 0 ? `${result.to}, cc ${result.cc.join(", ")}` : result.to;
      setNotice(
        result.suppressed
          ? `Sent to ${everyone}. Note: this address unsubscribed from marketing email — this was a direct reply, not a campaign send.`
          : `Sent to ${everyone}.`,
      );
      void queryClient.invalidateQueries({ queryKey: ["email-deliveries", target, id] });
    },
    onError: (err) => setNotice((err as Error).message),
  });

  return (
    <div className="space-y-2">
      {!open && (
        <button type="button" className="btn btn-secondary text-xs" onClick={() => setOpen(true)}>
          Send email
        </button>
      )}

      {open && (
        <form
          className="space-y-2 rounded-lg border border-rce-border p-3"
          onSubmit={(event) => { event.preventDefault(); send.mutate(); }}
        >
          <label className="block text-xs font-medium text-rce-soft">
            To
            <div className="mt-1">
              {accountIdForContacts ? (
                <SendToPicker accountId={accountIdForContacts} primaryEmail={primaryEmail} onChange={setTo} onCcChange={setCc} />
              ) : (
                <>
                  <input
                    className="field text-xs"
                    type="email"
                    placeholder="name@example.com"
                    value={customTo}
                    onChange={(e) => setCustomTo(e.target.value)}
                    required
                  />
                  {/* A lead has no account, so there is no contact list to pick CCs from or save to. */}
                  <div className="mt-1 flex flex-wrap items-center gap-1">
                    <input
                      className="field text-xs"
                      type="email"
                      placeholder="CC: name@example.com"
                      aria-label="CC address"
                      value={ccTyped}
                      onChange={(e) => setCcTyped(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTypedCc(); } }}
                    />
                    <button type="button" className="btn btn-secondary text-xs" disabled={!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(ccTyped.trim())} onClick={addTypedCc}>
                      Add CC
                    </button>
                    <CcChips cc={cc} onRemove={(a) => setCc(cc.filter((c) => c !== a))} />
                    <button
                      type="button"
                      className="text-xs text-rce-muted underline opacity-60"
                      disabled
                      title="Leads have no account to save contacts to"
                    >
                      Save as contact
                    </button>
                    <span className="text-xs text-rce-muted">Leads have no account to save contacts to</span>
                  </div>
                </>
              )}
            </div>
          </label>
          <label className="block text-xs font-medium text-rce-soft">
            Subject
            <input className="field mt-1" value={subject} onChange={(e) => setSubject(e.target.value)} required maxLength={200} />
          </label>
          <label className="block text-xs font-medium text-rce-soft">
            Message
            <textarea className="field mt-1" rows={5} value={body} onChange={(e) => setBody(e.target.value)} required maxLength={10000} />
          </label>
          <div className="flex justify-end gap-2">
            <button type="button" className="btn btn-secondary text-xs" onClick={() => setOpen(false)}>Cancel</button>
            <button type="submit" className="btn btn-primary text-xs" disabled={send.isPending || !subject.trim() || !body.trim()}>
              {send.isPending ? "Sending…" : "Send"}
            </button>
          </div>
        </form>
      )}

      {notice && <p className="rounded bg-amber-50 px-2 py-1 text-xs text-amber-900">{notice}</p>}

      {thread && thread.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-rce-soft">Email thread ({thread.length})</summary>
          <ul className="mt-1 space-y-1">
            {thread.map((d: EmailDeliveryRow) => (
              <li key={d.id} className="rounded border border-rce-border/70 px-2 py-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{d.subject}</span>
                  <span className={STATUS_TONE[d.status] ?? "text-rce-muted"}>{d.status}</span>
                </div>
                <div className="text-rce-muted">
                  to {d.to}{d.cc && d.cc.length > 0 ? ` · cc ${d.cc.join(", ")}` : ""} · {new Date(d.createdAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                </div>
                {d.error && <div className="text-red-700">{d.error}</div>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
