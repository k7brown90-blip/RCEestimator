/**
 * The ONE approval card (work order agent-team, U4 + TC1/TC3): a draft an AI agent wrote, waiting for a
 * person to send, edit or reject it. Every kind of draft draws through this one component, on every screen
 * where a person stands:
 *
 *   Messages -> "Waiting for approval" chip  the queue (ApprovalQueue)
 *   Thread drawer                         an AI draft in a crew, Team or customer conversation
 *   Account / Lead / Job conversation     the same card inline, where the customer's own record is
 *
 * What the card says is the SERVER's (services/hubActions/registry.ts describe()), built from the frozen
 * class and purpose of the message, never from the agent's words: the header line ("Draft by RCE Admin
 * (AI) · Text · Transactional — Appointment Confirmation · to Jane"), the chip ("This will text the
 * customer" / "Internal only — never reaches a customer"), the "When you approve" lines, and "Sends as:" -
 * the exact words a text will go out as.
 *
 * Buttons: "Approve and send" (asks "Send this email to Jane (jane@...)? It goes to the customer." first),
 * "Edit" (subject, words, To and CC, then "Send my version"), "Reject" (a reason is required: "Reject
 * draft" stays greyed with "Type a reason first" until there is one). Greyed, never hidden, and the
 * reason is printed on the card: a session without the approve_drafts power sees the power's sentence; a
 * text that can never go (a marketing text with no opt-in) says why.
 *
 * Exits (nothing here is permanent): a failed message has "Try sending again" and Reject; a text held
 * because texting is off ("Approved — SMS disabled") has "Send now" and Reject. A sent, rejected or blocked
 * card is the record of what happened, with who and why.
 */

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useDrawerParams } from "../lib/drawers";
import { refreshHub } from "../lib/hubQueries";
import { messageStatusChip, whenText } from "../lib/hubLabels";
import type { HubDecision } from "../lib/types";
import type { ApprovalCardView } from "../../../shared/hub/views";
import { REJECT_FIRST_HINT, REJECT_REASON_MIN, approvingLabel, cardLocks, isActionable, isOpenCard } from "../../../shared/hub/approvalRules";
import { DeliveryChip } from "./DeliveryChip";
import { SendToPicker } from "./SendToPicker";

// The card's rules (what is greyed, why, what the buttons say) are shared/hub/approvalRules.ts: the field app's card
// reads the same ones. Re-exported here for the screens that already import them from this file.
export { REJECT_FIRST_HINT, isActionable, isOpenCard };

type Mode = "view" | "edit" | "reject";

export function ApprovalCard({
  card, canApprove, approveReason, compact = false, showThreadLink = false, onDecided,
}: {
  card: ApprovalCardView;
  /** Does this session hold the approve_drafts power? (GET /hub/approvals says.) */
  canApprove: boolean;
  /** The power's sentence, printed beside a greyed button when canApprove is false. */
  approveReason: string | null;
  compact?: boolean;
  /** The queue shows "Open the conversation"; inside the conversation itself it would only point at itself. */
  showThreadLink?: boolean;
  onDecided?: (result: HubDecision, card: ApprovalCardView) => void;
}) {
  const queryClient = useQueryClient();
  const drawers = useDrawerParams();
  const [mode, setMode] = useState<Mode>("view");
  const [error, setError] = useState<string | null>(null);
  const [subject, setSubject] = useState(card.subject ?? "");
  const [body, setBody] = useState(card.body);
  const [to, setTo] = useState<string | null>(null);
  const [cc, setCc] = useState<string[]>(card.cc);
  const [reason, setReason] = useState("");

  const actionable = isActionable(card);
  const text = compact ? "text-xs" : "text-sm";
  const customerFacing = card.chip.tone === "customer";
  const isEmail = card.channel === "email";

  // Edit is greyed only for reasons editing cannot cure (the power, a STOP reply, marketing...). A draft that is
  // blocked because of its own words, or a missing address, keeps Edit live: Edit is the remedy.
  const { lock, editLock, rejectLock, approveLabel: retry } = cardLocks(card, canApprove, approveReason);
  const lockText = rejectLock ?? "";

  const done = (result: HubDecision) => {
    setMode("view");
    setError(null);
    refreshHub(queryClient);
    onDecided?.(result, card);
  };
  const fail = (err: unknown) => setError((err as Error).message);

  const approve = useMutation({ mutationFn: () => api.approveHubMessage(card.id), onSuccess: done, onError: fail });
  const editSend = useMutation({
    mutationFn: () => api.editApproveHubMessage(card.id, {
      body: body.trim(),
      ...(isEmail ? { subject: subject.trim(), ...(to ? { to } : {}), cc } : {}),
    }),
    onSuccess: done,
    onError: fail,
  });
  const reject = useMutation({ mutationFn: () => api.rejectHubMessage(card.id, { reason: reason.trim() }), onSuccess: done, onError: fail });
  const busy = approve.isPending || editSend.isPending || reject.isPending;

  const onApprove = () => {
    if (customerFacing && !window.confirm(card.approve.confirm)) return;
    approve.mutate();
  };

  const chip = messageStatusChip(card.status);
  const when = whenText(card.createdAt);
  const header = `Draft by ${card.draftedBy} · ${card.headerLine}${card.recipient ? ` · to ${card.recipient}` : ""}`;

  return (
    <article
      className={`rounded-lg border border-amber-300 bg-amber-50/40 p-3 ${text}`}
      aria-label={`Draft to ${card.recipient ?? card.threadTitle}`}
      data-testid="approval-card"
      data-message-id={card.id}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="min-w-0 font-semibold text-rce-soft">
          {header}
          <span className="ml-1 font-normal text-rce-muted">· {when}</span>
        </p>
        {chip && card.status !== "pending_approval" && (
          <span className={`inline-block rounded px-1.5 py-0.5 text-[11px] font-medium ${chip.tone}`} title={chip.title}>{chip.label}</span>
        )}
      </div>

      <p
        className={`mt-1 inline-block rounded px-2 py-0.5 text-[11px] font-semibold ${customerFacing ? "bg-amber-200 text-amber-900" : "bg-gray-200 text-gray-800"}`}
        data-testid="approval-chip"
      >
        {card.chip.text}
      </p>

      {showThreadLink && (
        <p className="mt-1 text-xs text-rce-muted">
          In: {card.threadTitle}{" "}
          <button type="button" className="underline" onClick={() => drawers.open("thread", card.threadId)}>Open the conversation</button>
        </p>
      )}

      {card.recent.length > 0 && (
        <details className="mt-2 rounded border border-rce-border bg-white px-2 py-1" open={!compact}>
          <summary className="cursor-pointer text-xs font-medium text-rce-soft">The last {card.recent.length === 1 ? "message" : `${card.recent.length} messages`} before this</summary>
          <ul className="mt-1 space-y-1">
            {card.recent.map((m, i) => (
              <li key={`${m.at}-${i}`} className="text-xs">
                <span className="font-medium text-rce-soft">{m.authorDisplay}:</span> {m.text}
              </li>
            ))}
          </ul>
        </details>
      )}

      {mode !== "edit" ? (
        <div className="mt-2">
          {card.subject && <p className="font-medium">{card.subject}</p>}
          <p className="whitespace-pre-wrap break-words">{card.body}</p>
          {card.recipientAddress && <p className="mt-0.5 text-xs text-rce-muted">To {card.recipientAddress}{card.cc.length > 0 ? ` · cc ${card.cc.join(", ")}` : ""}</p>}
        </div>
      ) : (
        <form
          className="mt-2 space-y-2"
          aria-label="Edit draft"
          onSubmit={(e) => { e.preventDefault(); if (body.trim() && !editLock && !busy) editSend.mutate(); }}
        >
          {isEmail && (
            <label className="block text-xs font-medium text-rce-soft">
              Subject
              <input className="field mt-1" value={subject} maxLength={200} onChange={(e) => setSubject(e.target.value)} />
            </label>
          )}
          <label className="block text-xs font-medium text-rce-soft">
            {isEmail ? "Message" : "Words (the header and the STOP line are added for you)"}
            <textarea className="field mt-1" rows={5} value={body} onChange={(e) => setBody(e.target.value)} />
          </label>
          {isEmail && card.customerId && (
            <div className="text-xs">
              <p className="mb-1 font-medium text-rce-soft">Send to</p>
              <SendToPicker accountId={card.customerId} primaryEmail={card.recipientAddress} onChange={setTo} onCcChange={setCc} />
            </div>
          )}
          {isEmail && !card.customerId && (
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="block text-xs font-medium text-rce-soft">
                To (leave blank for the address on file)
                <input className="field mt-1" type="email" value={to ?? ""} onChange={(e) => setTo(e.target.value.trim() || null)} />
              </label>
              <label className="block text-xs font-medium text-rce-soft">
                CC (separate with commas)
                <input
                  className="field mt-1"
                  value={cc.join(", ")}
                  onChange={(e) => setCc(e.target.value.split(",").map((s) => s.trim()).filter(Boolean))}
                />
              </label>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="submit"
              className="btn btn-primary text-xs"
              disabled={!body.trim() || Boolean(editLock) || busy}
              title={editLock ?? (body.trim() ? "Sends your version to the customer; the AI draft stays on the record as edited" : "Write something first.")}
            >
              {editSend.isPending ? "Sending…" : "Send my version"}
            </button>
            <button type="button" className="btn btn-secondary text-xs" onClick={() => { setMode("view"); setError(null); }}>Cancel</button>
          </div>
        </form>
      )}

      {card.sendsAs && (
        <div className="mt-2 rounded border border-rce-border bg-white px-2 py-1" data-testid="sends-as">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-rce-muted">Sends as:</p>
          <p className="whitespace-pre-wrap break-words text-xs">{card.sendsAs}</p>
        </div>
      )}

      {actionable && card.effectLines.length > 0 && (
        <div className="mt-2 rounded border border-rce-border bg-white px-2 py-1" data-testid="when-you-approve">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-rce-muted">When you approve</p>
          <ul className="list-disc pl-4 text-xs">
            {card.effectLines.map((line) => <li key={line}>{line}</li>)}
          </ul>
        </div>
      )}

      {/* The outcome: who decided and what happened. A sent email carries its delivery chip. */}
      {card.outcome.text && (
        <p className="mt-2 flex flex-wrap items-center gap-2 text-xs font-medium" data-testid="approval-outcome">
          <span>{card.outcome.text}</span>
          {card.outcome.emailDelivery && <DeliveryChip delivery={card.outcome.emailDelivery} />}
        </p>
      )}
      {card.outcome.error && card.status !== "failed" && <p className="mt-1 text-xs text-red-700">{card.outcome.error}</p>}

      {actionable && mode === "reject" && (
        <form
          className="mt-2 space-y-2 rounded border border-red-200 bg-red-50 p-2"
          aria-label="Reject draft"
          onSubmit={(e) => { e.preventDefault(); if (reason.trim().length >= REJECT_REASON_MIN && !busy) reject.mutate(); }}
        >
          <label className="block text-xs font-medium text-rce-soft">
            Why?
            <input className="field mt-1" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} autoFocus />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="submit"
              className="btn btn-danger text-xs"
              disabled={reason.trim().length < REJECT_REASON_MIN || busy}
              title={reason.trim().length < REJECT_REASON_MIN ? REJECT_FIRST_HINT : "Rejects this draft; nothing is sent and your reason is kept"}
            >
              {reject.isPending ? "Rejecting…" : "Reject draft"}
            </button>
            {reason.trim().length < REJECT_REASON_MIN && <span className="text-xs text-rce-muted">{REJECT_FIRST_HINT}</span>}
            <button type="button" className="btn btn-secondary text-xs" onClick={() => { setMode("view"); setReason(""); setError(null); }}>Cancel</button>
          </div>
        </form>
      )}

      {actionable && mode === "view" && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button type="button" className="btn btn-primary text-xs" disabled={Boolean(lock) || busy} title={lock ?? undefined} onClick={onApprove}>
            {approve.isPending ? approvingLabel(card) : retry}
          </button>
          {card.status === "pending_approval" && (
            <button
              type="button"
              className="btn btn-secondary text-xs"
              disabled={Boolean(editLock) || busy}
              title={editLock ?? "Change the words before it goes out"}
              onClick={() => { setBody(card.body); setSubject(card.subject ?? ""); setCc(card.cc); setTo(null); setMode("edit"); }}
            >
              Edit
            </button>
          )}
          <button
            type="button"
            className="btn btn-danger text-xs"
            disabled={Boolean(rejectLock) || busy}
            title={rejectLock ? lockText : "Reject this draft with a reason; nothing is sent"}
            onClick={() => { setReason(""); setMode("reject"); }}
          >
            Reject
          </button>
        </div>
      )}
      {actionable && lock && (
        <p className="mt-1 rounded border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-900" data-testid="approval-lock">{lock}</p>
      )}
      {error && <p className="mt-1 text-xs text-red-600" role="alert">{error}</p>}
    </article>
  );
}
