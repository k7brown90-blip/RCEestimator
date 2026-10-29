/**
 * "Email the customer" — THE ONE EMAIL TOOL on a record (Kyle, 2026-10-27: "A rule of thumb is there
 * is one tool for one task. We do not create multiple tools that do the same thing.").
 *
 * ── WHAT IT WAS ───────────────────────────────────────────────────────────────────────────────────
 * 2026-09-20 communications build: Kyle, "Follow ups can be done by sending an email straight from
 * the CRM." One panel on the lead, account and job drawers: a compose form (recipient, subject,
 * body) that posts to `POST /communications/email`, plus the thread of what has already been sent —
 * "the thread of what has been sent shows ON the record — that is what makes a follow-up trackable
 * rather than a thing Kyle remembers." Reuses `SendToPicker` for the recipient when the record has
 * one (account, job); a lead before conversion has no CustomerContact rows, so it falls back to a
 * plain override input seeded with the lead's own email. WITHOUT a `record` prop that is still
 * exactly what this is: the "Send email" button, Subject, Message, "Send".
 *
 * ── WHAT IT IS NOW, WITH A `record` ───────────────────────────────────────────────────────────────
 * The invoice drawer carried seven separate email controls, the estimate side four more, each with
 * its own route and only some with a way to say WHO it went to. They are this one panel:
 *   1. "What are you sending?" - only the kinds that apply to this record (the host decides, via
 *      `record.kinds`): Invoice · Deposit request · Financing link · Review request · Estimate ·
 *      Message. A kind that cannot go right now is greyed WITH the reason, never hidden
 *      (CLAUDE.md click-through rule 5).
 *   2. To - SendToPicker (customer on file pre-selected, saved contacts, a typed address) + CC.
 *   3. Extras for the kind - photos (invoice, estimate), the Health Record report / Generator sheet /
 *      financing-line tick-boxes (estimate, shared/estimateEmail.ts), subject + body (message), and
 *      an optional note on every other kind.
 *   4. ONE Send button that names both what and to whom: "Send invoice 2026-1104 to jane@example.com".
 *   5. The thread of everything sent from this record (below).
 * Every kind except Message goes through `POST /customer-emails` (api.sendCustomerEmail); Message
 * keeps `POST /communications/email`. The server decides WHO through one rule
 * (emailCc.resolveRecipients) and each email's words stay in its own service.
 */

import { useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { CustomerEmailInput, ReceiptReportOption } from "../lib/api";
import type { EmailDeliveryRow } from "../lib/types";
import { money, shortDate } from "../lib/utils";
import { CcChips, SendToPicker } from "./SendToPicker";
import { PhotoAttachPicker } from "./PhotoGalleryPanel";
import { ESTIMATE_EMAIL_DEFAULTS, estimateEmailExtras, estimateEmailRequest } from "../../../shared/estimateEmail";
import { COMPLETION_REPORT_ID } from "../../../shared/jobCompletionLimits";

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

/** What can be sent from a record. `message` is the free-form one; the rest are fixed emails. */
export type EmailKind = "invoice" | "receipt" | "deposit" | "financing" | "review" | "estimate" | "message";

export interface EmailKindOffer {
  kind: EmailKind;
  /** The radio's words. Default: the kind's own name (with the record's number where it has one). */
  label?: string;
  /** Greyed with this reason when set - never hidden. */
  blocked?: string | null;
  /** What the Send button calls it: "Send <sendAs> to …" (a change order row says "change order 2026-1097"). */
  sendAs?: string;
}

/** The record the structured kinds are about. Absent = the plain "Send email" message panel. */
export interface EmailRecord {
  /** invoice / receipt / deposit / financing / estimate. */
  estimateId?: string | null;
  /** "2026-1104" - named on the Send button. */
  number?: string;
  /** review: the job (Visit.id). */
  visitId?: string | null;
  kinds: EmailKindOffer[];
  /** Invoice only: something is owing and the pay link is open, so a second send reads as a reminder. */
  invoiceOwing?: boolean;
  /**
   * Receipt only (Kyle, 2026-10-29): the reports on file for the job - the "Attach reports" list
   * (payment-info `email.reports`). An unavailable one is shown greyed with its `blockedReason`.
   */
  reports?: ReceiptReportOption[];
  /** Called after any send that went out - the host refreshes whatever it shows. */
  onSent?: () => void;
  /** Offer photos from just these addresses (the Property page: this property's). Default: every address on the account. */
  photoProperties?: Array<{ id: string; name: string; addressLine1: string; city: string }>;
}

const DEFAULT_LABEL: Record<EmailKind, (number?: string) => string> = {
  invoice: (n) => (n ? `Invoice ${n}` : "Invoice"),
  receipt: (n) => (n ? `Receipt ${n}` : "Receipt"),
  deposit: () => "Deposit request",
  financing: () => "Financing link",
  review: () => "Review request",
  estimate: (n) => (n ? `Estimate ${n}` : "Estimate"),
  message: () => "Message",
};

/** What the Send button calls the thing: "Send invoice 2026-1104 to …". */
const SEND_WORDS: Record<EmailKind, (number?: string) => string> = {
  invoice: (n) => (n ? `invoice ${n}` : "invoice"),
  receipt: (n) => (n ? `receipt ${n}` : "receipt"),
  deposit: () => "deposit request",
  financing: () => "financing link",
  review: () => "review request",
  estimate: (n) => (n ? `estimate ${n}` : "estimate"),
  message: () => "message",
};

/** The delivery-row kinds that count as "this was sent" for each choice (a retired separate bill filed as "balance"). */
const DELIVERY_KINDS: Record<EmailKind, string[]> = {
  invoice: ["invoice", "balance"],
  receipt: ["receipt"],
  deposit: ["deposit"],
  financing: ["financing"],
  review: ["review_request"],
  estimate: ["estimate"],
  message: ["communication"],
};
const NOT_DELIVERED = new Set(["failed", "bounced", "complained"]);

/** Everything a send can change on a screen behind the panel - one list so no host has to remember it. */
const REFRESH_KEYS = [
  ["invoices"], ["paymentInfo"], ["payments"], ["financials"], ["estimate-record"], ["account-estimates"], ["estimate-chain"],
  ["pb-issued"], ["pb-issued-detail"], ["jobs"], ["visit"], ["account-summary"],
];

export function SendEmailPanel({
  target,
  id,
  primaryEmail,
  /** Present only when the record has CustomerContact rows to offer (account, job). */
  accountIdForContacts,
  record,
  startOpen = false,
}: {
  target: "lead" | "account" | "job";
  id: string;
  primaryEmail: string | null;
  accountIdForContacts?: string | null;
  record?: EmailRecord;
  /** Open already expanded - for a screen whose own button just asked for it (Present to the customer). */
  startOpen?: boolean;
}) {
  const queryClient = useQueryClient();
  const radioName = useId();
  const [open, setOpen] = useState(startOpen);
  const [chosen, setChosen] = useState<EmailKind | null>(null);
  const [to, setTo] = useState<string | null>(null);
  const [customTo, setCustomTo] = useState(primaryEmail ?? "");
  // CC (Kyle, 2026-10-24: "The email will be the same as doing a CC email.") - on every record.
  const [cc, setCc] = useState<string[]>([]);
  const [ccTyped, setCcTyped] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  // The optional note on every fixed email (the wire name is `message`).
  const [note, setNote] = useState("");
  const [photoIds, setPhotoIds] = useState<string[]>([]);
  // The estimate's own tick-boxes (shared/estimateEmail.ts) - the same defaults the field app starts from.
  const [attachHealthReport, setAttachHealthReport] = useState(ESTIMATE_EMAIL_DEFAULTS.attachHealthReport);
  const [attachGeneratorReport, setAttachGeneratorReport] = useState(ESTIMATE_EMAIL_DEFAULTS.attachGeneratorReport);
  const [includeFinancingLink, setIncludeFinancingLink] = useState(ESTIMATE_EMAIL_DEFAULTS.includeFinancingLink);
  // Receipt: the report ids the office has ticked, or null = untouched (the Job Completion Report, when it has something to send).
  const [reportPick, setReportPick] = useState<string[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The kinds on offer. No record = the plain message panel, as before.
  const offers: EmailKindOffer[] = record?.kinds && record.kinds.length > 0 ? record.kinds : [{ kind: "message" }];
  const active: EmailKind = (offers.find((o) => o.kind === chosen && !o.blocked) ?? offers.find((o) => !o.blocked) ?? offers[0]).kind;
  const structured = active !== "message";
  const estimateId = record?.estimateId ?? null;
  // The receipt's "Attach reports": what is ticked now (never an unavailable one).
  const reportOptions = record?.reports ?? [];
  const ticked = (reportPick ?? reportOptions.filter((r) => r.id === COMPLETION_REPORT_ID).map((r) => r.id))
    .filter((rid) => reportOptions.some((r) => r.id === rid && r.available));
  const toggleReport = (rid: string) => setReportPick(ticked.includes(rid) ? ticked.filter((x) => x !== rid) : [...ticked, rid]);

  // The thread: everything sent from this record. A record keyed by an estimate reads the estimate's
  // deliveries (invoice, deposit, financing, estimate and any message filed against it) plus the
  // job's own when the Message goes to the job; a plain message panel reads its own target's.
  const threadKey = threadKeyFor(target, id);
  const { data: targetThread } = useQuery({
    queryKey: ["email-deliveries", target, id],
    queryFn: () => api.emailDeliveries(threadKey),
    enabled: !estimateId || target === "job",
  });
  const { data: estimateThread } = useQuery({
    queryKey: ["email-deliveries", "estimate", estimateId],
    queryFn: () => api.emailDeliveries({ estimateId: estimateId as string, limit: 50 }),
    enabled: Boolean(estimateId),
  });
  const thread: EmailDeliveryRow[] | undefined = (() => {
    if (!targetThread && !estimateThread) return undefined;
    const seen = new Set<string>();
    const merged: EmailDeliveryRow[] = [];
    for (const d of [...(estimateThread ?? []), ...(!estimateId || target === "job" ? targetThread ?? [] : [])]) {
      if (seen.has(d.id)) continue;
      seen.add(d.id);
      merged.push(d);
    }
    return merged.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  })();

  // Photos: any photo on the customer's account (Kyle, 2026-10-01), for the two kinds that carry them.
  // Same key and same call as Estimate Intake and Present to the customer (tests/queryKeyCollisions.test.ts):
  // one /accounts/:id response, one cache entry.
  const accountId = accountIdForContacts;
  const { data: account } = useQuery({
    queryKey: ["account", accountId],
    queryFn: () => api.account(accountId as string),
    enabled: Boolean(accountId) && !record?.photoProperties && (active === "invoice" || active === "receipt" || active === "estimate"),
  });
  const properties = record?.photoProperties ?? (account?.properties ?? []).map((p) => ({ id: p.id, name: p.name, addressLine1: p.addressLine1, city: p.city }));

  const addTypedCc = () => {
    const a = ccTyped.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a)) return;
    if (!cc.some((c) => c.toLowerCase() === a.toLowerCase())) setCc([...cc, a]);
    setCcTyped("");
  };

  // Who it goes to: the picker's choice, else the address on file (the server uses the same default).
  const toAddress = (accountIdForContacts ? to : (customTo.trim() || null)) ?? null;
  const who = (toAddress ?? primaryEmail ?? "").trim();
  const recordNumber = record?.number;

  const buildRequest = (): CustomerEmailInput => {
    const base = { to: toAddress, ...(cc.length > 0 ? { cc } : {}), message: note.trim() || null };
    switch (active) {
      case "invoice":
        return { kind: "invoice", estimateId: estimateId as string, ...base, photoIds: photoIds.length > 0 ? photoIds : undefined };
      case "receipt":
        return { kind: "receipt", estimateId: estimateId as string, ...base, photoIds: photoIds.length > 0 ? photoIds : undefined, reports: ticked };
      case "deposit":
        return { kind: "deposit", estimateId: estimateId as string, ...base };
      case "financing":
        return { kind: "financing", estimateId: estimateId as string, ...base };
      case "review":
        return { kind: "review", visitId: record?.visitId as string, ...base };
      default:
        // estimate - the body is built by shared/estimateEmail.ts, the same builder the field app uses.
        return {
          kind: "estimate",
          estimateId: estimateId as string,
          ...estimateEmailRequest({
            to: toAddress ?? "",
            cc,
            message: note,
            photoIds,
            attachHealthReport,
            attachGeneratorReport,
            includeFinancingLink,
          }),
        };
    }
  };

  const finish = () => {
    void queryClient.invalidateQueries({ queryKey: ["email-deliveries"] });
    for (const key of REFRESH_KEYS) void queryClient.invalidateQueries({ queryKey: key });
    record?.onSent?.();
  };

  const send = useMutation({
    mutationFn: async () => {
      if (active === "message") {
        const r = await api.sendRecordEmail({
          target,
          id,
          to: toAddress,
          ...(cc.length > 0 ? { cc } : {}),
          subject: subject.trim(),
          body: body.trim(),
          ...(estimateId ? { estimateId } : {}),
        });
        return { message: r, sent: null };
      }
      return { message: null, sent: await api.sendCustomerEmail(buildRequest()) };
    },
    onSuccess: ({ message, sent }) => {
      setError(null);
      if (message) {
        setSubject("");
        setBody("");
        const everyone = message.cc && message.cc.length > 0 ? `${message.to}, cc ${message.cc.join(", ")}` : message.to;
        setNotice(
          message.suppressed
            ? `Sent to ${everyone}. Note: this address unsubscribed from marketing email — this was a direct reply, not a campaign send.`
            : `Sent to ${everyone}.`,
        );
      } else if (sent) {
        const everyone = sent.cc && sent.cc.length > 0 ? `${sent.to}, cc ${sent.cc.join(", ")}` : sent.to;
        const owed = sent.amount !== undefined ? ` — ${money(sent.amount)} ${sent.kind === "deposit" ? "deposit requested" : "due"}` : "";
        const words: Record<string, string> = {
          invoice: sent.reminder ? `Reminder for invoice ${recordNumber ?? ""} emailed to` : `Invoice ${recordNumber ?? ""} emailed to`,
          receipt: `Receipt for invoice ${recordNumber ?? ""} emailed to`,
          deposit: "Deposit request emailed to",
          financing: "Financing link emailed to",
          review: "Review request emailed to",
          estimate: `Estimate ${recordNumber ?? ""} emailed to`,
        };
        setNotice(`${(words[sent.kind] ?? "Emailed to").replace("  ", " ")} ${everyone}${sent.kind === "invoice" || sent.kind === "deposit" ? owed : ""}.`);
        setNote("");
        setPhotoIds([]);
        setReportPick(null);
      }
      finish();
    },
    onError: (err) => { setNotice(null); setError((err as Error).message); },
  });

  // "Last sent" for the chosen kind - and the honest warning that a second invoice send is a reminder.
  const last = thread?.find((d) => DELIVERY_KINDS[active].includes(d.kind) && !NOT_DELIVERED.has(d.status)) ?? null;
  const lastDate = last ? new Date(last.createdAt).toLocaleDateString() : null;
  const reminderComing = active === "invoice" && Boolean(record?.invoiceOwing) && Boolean(last) && Boolean(who)
    && last!.to.trim().toLowerCase() === who.toLowerCase();

  const sendWords = offers.find((o) => o.kind === active)?.sendAs ?? SEND_WORDS[active](recordNumber);
  const canSend = active === "message"
    ? Boolean(subject.trim() && body.trim())
    : Boolean(who);
  const sendLabel = send.isPending
    ? "Sending…"
    : !record
      ? "Send"
      : who ? `Send ${sendWords} to ${who}` : `Send ${sendWords}`;

  return (
    <div className="space-y-2">
      {!open && (
        <button type="button" className="btn btn-secondary text-xs" onClick={() => setOpen(true)}>
          {record ? "Email the customer" : "Send email"}
        </button>
      )}

      {open && (
        <form
          className="space-y-2 rounded-lg border border-rce-border p-3"
          aria-label={record ? "Email the customer" : "Send email"}
          onSubmit={(event) => { event.preventDefault(); if (canSend) send.mutate(); }}
        >
          {record && <p className="text-sm font-semibold">Email the customer</p>}

          {record && (
            <fieldset className="space-y-1">
              <legend className="text-xs font-medium text-rce-soft">What are you sending?</legend>
              {offers.map((o) => (
                <div key={o.kind}>
                  <label
                    className={`flex items-center gap-2 text-sm ${o.blocked ? "text-rce-soft opacity-70" : ""}`}
                    title={o.blocked ?? undefined}
                  >
                    <input
                      type="radio"
                      name={radioName}
                      value={o.kind}
                      checked={active === o.kind}
                      disabled={Boolean(o.blocked)}
                      onChange={() => { setChosen(o.kind); setNotice(null); setError(null); }}
                    />
                    {o.label ?? DEFAULT_LABEL[o.kind](recordNumber)}
                  </label>
                  {o.blocked && <p className="ml-6 text-[11px] text-rce-soft">{o.blocked}</p>}
                </div>
              ))}
            </fieldset>
          )}

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

          {active === "message" ? (
            <>
              <label className="block text-xs font-medium text-rce-soft">
                Subject
                <input className="field mt-1" value={subject} onChange={(e) => setSubject(e.target.value)} required maxLength={200} />
              </label>
              <label className="block text-xs font-medium text-rce-soft">
                {record ? "Message text" : "Message"}
                <textarea className="field mt-1" rows={5} value={body} onChange={(e) => setBody(e.target.value)} required maxLength={10000} />
              </label>
            </>
          ) : (
            <>
              <label className="block text-xs font-medium text-rce-soft">
                Note <span className="font-normal">(optional, goes in the email)</span>
                <input className="field mt-1" value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} placeholder="Optional note to include in the email" />
              </label>
              {active === "estimate" && (
                <div className="space-y-1">
                  {/* Support documentation (Kyle, 2026-08-29): the reports render fresh at send time. */}
                  <label className="flex items-center gap-2 text-xs text-rce-soft">
                    <input type="checkbox" checked={attachHealthReport} onChange={(e) => setAttachHealthReport(e.target.checked)} />
                    Attach Electrical Health Record report (latest assessment at this address)
                  </label>
                  <label className="flex items-center gap-2 text-xs text-rce-soft">
                    <input type="checkbox" checked={attachGeneratorReport} onChange={(e) => setAttachGeneratorReport(e.target.checked)} />
                    Attach Generator Sizing data sheet
                  </label>
                  {/* Ticked by default (Kyle, 2026-10-02): the line has gone out on every estimate email since 2026-09-16. */}
                  <label className="flex items-center gap-2 text-xs text-rce-soft">
                    <input type="checkbox" checked={includeFinancingLink} onChange={(e) => setIncludeFinancingLink(e.target.checked)} />
                    Include the Synchrony financing link
                  </label>
                </div>
              )}
              {active === "receipt" && (
                <fieldset className="space-y-1">
                  {/* Kyle, 2026-10-29: the realtor needs the receipt AND the report - every report on the job rides from here. */}
                  <legend className="text-xs font-medium text-rce-soft">Attach reports</legend>
                  {reportOptions.length === 0 && (
                    <p className="text-[11px] text-rce-soft">No reports are on file for this job yet.</p>
                  )}
                  {reportOptions.map((r) => (
                    <div key={r.id}>
                      <label
                        className={`flex items-center gap-2 text-xs ${r.available ? "text-rce-soft" : "text-rce-soft opacity-70"}`}
                        title={!r.available ? r.blockedReason : undefined}
                      >
                        <input
                          type="checkbox"
                          checked={ticked.includes(r.id)}
                          disabled={!r.available}
                          onChange={() => toggleReport(r.id)}
                        />
                        {r.label}{r.date ? ` — ${shortDate(r.date)}` : ""}
                      </label>
                      {!r.available && r.blockedReason && <p className="ml-6 text-[11px] text-rce-soft">{r.blockedReason}</p>}
                    </div>
                  ))}
                </fieldset>
              )}
              {(active === "invoice" || active === "receipt" || active === "estimate") && accountIdForContacts && (
                <PhotoAttachPicker properties={properties} selected={photoIds} onChange={setPhotoIds} />
              )}
              {active === "invoice" && (
                <p className="text-[11px] text-rce-soft">
                  Attaches the itemized invoice PDF and carries the amount due, the paid-to-date and the pay link.
                </p>
              )}
              {active === "receipt" && (
                <p className="text-[11px] text-rce-soft">
                  Attaches the itemized invoice PDF and every report ticked.
                </p>
              )}
              {active === "estimate" && estimateEmailExtras({ photoIds, attachHealthReport, attachGeneratorReport }) && (
                <p className="text-[11px] text-rce-soft">Riding along: {estimateEmailExtras({ photoIds, attachHealthReport, attachGeneratorReport })}.</p>
              )}
            </>
          )}

          {record && structured && last && (
            <p className="text-xs text-rce-muted">
              {reminderComing
                ? `This already went to ${last.to} on ${lastDate} and is still open — sending it again goes out worded as a friendly reminder.`
                : `Last sent to ${last.to} on ${lastDate}.`}
            </p>
          )}
          {record && !who && active !== "message" && (
            <p className="text-xs text-rce-soft">No email on file — pick a contact or type an address above.</p>
          )}

          <div className="flex justify-end gap-2">
            <button type="button" className="btn btn-secondary text-xs" onClick={() => setOpen(false)}>Cancel</button>
            <button type="submit" className="btn btn-primary text-xs" disabled={send.isPending || !canSend}>
              {sendLabel}
            </button>
          </div>
        </form>
      )}

      {notice && <p className="rounded bg-amber-50 px-2 py-1 text-xs text-amber-900">{notice}</p>}
      {error && <p role="alert" className="rounded bg-red-50 px-2 py-1 text-xs text-red-800">{error}</p>}

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
