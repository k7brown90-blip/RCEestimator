/**
 * ONE Conversation per record (work order agent-team, U2; default D3).
 *
 * Kyle, 2026-10-01: "Notes should be account based for an admin that is answering calls and
 * dispatching." Kyle, 2026-10-27: "A rule of thumb is there is one tool for one task." This is the one
 * list of everything said to or about a customer, replacing the separate Conversation-notes list and
 * the sent-email list that used to sit on these screens:
 *
 *   surface="account"  — the Account page (/accounts/:id), under the contact card: the whole conversation.
 *   surface="lead"     — the Lead drawer: the same section. A lead that became an account shows the
 *                        account's conversation, so what was said before it converted is still there.
 *   surface="job"      — the Job drawer: the newest three entries, "Show all", a note added here is tagged
 *                        to this job, and the "Crew chat" button opens this job's crew thread.
 *   surface="property" — the Property page, BELOW the Health Record card (never in the top card):
 *                        read-only, only what is tagged to jobs at this address, with a way to the account.
 *
 * What it shows, newest first: call notes (Edit / Delete as before, "edited" marker), emails sent from
 * any door with their delivery status, texts to and from the customer, the hub's own messages (an AI draft waiting has "Review draft",
 * which opens the Thread drawer; on the account, lead and job it IS the ApprovalCard right there - Approve,
 * Edit and Reject - so a draft is decided where the customer's own record is), and one line for a website chat. Its buttons are "Add call note",
 * "Email the customer" — the host's SendEmailPanel, passed in, so there is still exactly one email composer
 * and it still lists nothing of its own here — and "Text the customer" (SendTextPanel, Kyle 2026-11-26: every lead and
 * every customer with a phone gets a working text box, consent or no consent; only a STOP reply or no phone greys it).
 *
 * Standing rule: nothing here is permanent. A note edits and deletes on its row; a message carries
 * the exit its own state allows (a draft is rejected at approval, a sent one is history).
 */

import { useState } from "react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useDrawerParams } from "../lib/drawers";
import { refreshHub, useHubApprovals, useHubTimeline, type TimelineKey } from "../lib/hubQueries";
import { aiSentLine, authorLabel, automaticTextLine, messageStatusChip, whenText } from "../lib/hubLabels";
import { sendBlockText } from "../../../shared/hub/sendBlocks";
import type { TimelineEntry, TimelineMessage } from "../../../shared/hub/views";
import { DeliveryChip } from "./DeliveryChip";
import { AddCallNoteForm, CallNoteRow, JOB_SURFACE_LIMIT } from "./ConversationNotes";
import { ApprovalCard, isOpenCard } from "./ApprovalCard";
import { SendTextPanel, type TextTarget } from "./SendTextPanel";

export type ConversationSurface = "account" | "lead" | "job" | "property";

const CHANNEL_TAG: Record<string, string> = {
  sms: "Text", email: "Email", in_app: "Message", web_chat: "Website chat", system: "Automatic",
};

function Tag({ children }: { children: ReactNode }) {
  return (
    <span className="mr-1.5 inline-block rounded bg-rce-accentBg px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-rce-accentDark">
      {children}
    </span>
  );
}

function MessageEntry({ message, compact, onReview }: { message: TimelineMessage; compact: boolean; onReview: () => void }) {
  const chip = messageStatusChip(message.status, message.messageClass);
  const autoLine = automaticTextLine(message);
  const sentByAi = aiSentLine(message);
  const aiWaiting = (message.status === "pending_approval" || message.status === "draft") && !message.deleted;
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-rce-muted">
          <Tag>{message.authorType === "system" ? "Automatic" : CHANNEL_TAG[message.channel] ?? "Message"}</Tag>
          <span className="font-medium text-rce-soft">{authorLabel(message.authorType, message.authorDisplay)}</span>
          {" "}· {whenText(message.createdAt)}
          {message.editedAt && <span className="text-amber-800"> · edited {whenText(message.editedAt)}</span>}
          {autoLine && <span data-testid="automatic-text-line"> · {autoLine}</span>}
          {sentByAi && <span data-testid="ai-sent-line"> · {sentByAi}</span>}
        </p>
        <span className="flex items-center gap-1">
          {chip && <span className={`inline-block rounded px-1.5 py-0.5 text-[11px] font-medium ${chip.tone}`} title={chip.title}>{chip.label}</span>}
          {message.emailDelivery && <DeliveryChip delivery={message.emailDelivery} />}
        </span>
      </div>
      {message.deleted ? (
        <p className="mt-1 text-xs italic text-rce-muted">
          Deleted{message.deletedBy ? ` by ${message.deletedBy}` : ""}{message.deletedReason ? ` — ${message.deletedReason}` : ""}
        </p>
      ) : (
        <>
          {message.subject && <p className={`mt-1 font-medium ${compact ? "text-xs" : "text-sm"}`}>{message.subject}</p>}
          <p className="mt-0.5 whitespace-pre-wrap break-words">{message.body}</p>
          {message.error && <p className="mt-1 text-xs text-red-700">{message.status === "blocked" ? sendBlockText(message.error) : message.error}</p>}
        </>
      )}
      {aiWaiting && (
        <button type="button" className="btn btn-secondary mt-1 px-2 py-0.5 text-xs min-h-0" onClick={onReview}>
          Review draft
        </button>
      )}
    </>
  );
}

export function RecordConversation({
  surface, record, accountId, visitId, emailPanel, emailNote, emailElsewhere,
}: {
  surface: ConversationSurface;
  /** Which record's conversation to read. */
  record: { key: TimelineKey; id: string };
  /** The account call notes are filed on; null for a lead that is not an account yet. */
  accountId: string | null;
  /** The job the drawer is open on: tags a new note, and names the crew thread. */
  visitId?: string;
  /** The ONE email composer (SendEmailPanel), passed by the host. */
  emailPanel?: ReactNode;
  /** Why "Email the customer" is not offered here (shown greyed, never hidden). */
  emailNote?: string | null;
  /**
   * The composer is on this screen already, in another card (the Job drawer's payment card). Shown as a
   * sentence pointing there, NOT as a second "Email the customer" button: one tool for one task.
   */
  emailElsewhere?: string | null;
}) {
  const queryClient = useQueryClient();
  const drawers = useDrawerParams();
  const { data, isLoading, error } = useHubTimeline(record.key, record.id);
  const [adding, setAdding] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [crewError, setCrewError] = useState<string | null>(null);

  const compact = surface === "job" || surface === "lead";
  const isPage = surface === "account" || surface === "property";
  const readOnly = surface === "property";
  const Frame = isPage ? "section" : "div";
  const frameClass = isPage ? "card mb-5 p-4" : "rounded-lg border border-rce-border p-2 text-xs";
  const text = isPage ? "text-sm" : "text-xs";

  const all: TimelineEntry[] = data?.entries ?? [];
  const limited = surface === "job" && !showAll;
  const shown = limited ? all.slice(0, JOB_SURFACE_LIMIT) : all;
  const hidden = all.length - shown.length;

  // A draft waiting (or held, failed, refused) is the ApprovalCard where it stands, except on the read-only Property page.
  const waiting = all.find((e) => e.type === "message" && isOpenCard(e.message.status));
  const cardThreadId = waiting && waiting.type === "message" ? waiting.message.threadId : "";
  const { data: approvals } = useHubApprovals({ status: "all", threadId: cardThreadId }, Boolean(cardThreadId) && !readOnly);

  const crew = data?.crewThread ?? null;
  const openCrew = useMutation({
    mutationFn: async () => (crew ? { id: crew.id } : api.openJobThread(visitId as string)),
    onSuccess: ({ id }) => {
      setCrewError(null);
      drawers.open("thread", id);
      refreshHub(queryClient);
    },
    onError: (err) => setCrewError((err as Error).message),
  });

  const title = surface === "property" ? "Conversation at this address" : "Conversation";
  const blurb: Record<ConversationSurface, string> = {
    account: "Everything said to or about this customer — calls, emails and messages — newest first, shared with everyone who opens this account.",
    lead: "Everything said to or about this customer — calls, emails and messages — newest first.",
    job: "The account's conversation — what the last caller said, whichever job it was about.",
    property: "What was said and sent about the jobs at this address. Read-only here; the account holds the whole conversation.",
  };
  const noNoteReason = accountId ? null : "Call notes are kept on the account. Turn this lead into an account to add one.";
  // "Text the customer" goes to the record this Conversation is open on (a lead's text is filed on its account once it has one).
  const textTarget: TextTarget | null = record.key === "leadId" ? "lead" : record.key === "customerId" ? "account" : record.key === "visitId" ? "job" : null;

  return (
    <Frame className={frameClass} role={isPage ? undefined : "group"} aria-label="Conversation">
      <div>
        {isPage ? <h2 className="text-lg font-semibold">{title}</h2> : <p className="font-semibold text-rce-soft">{title}</p>}
        <p className="text-xs text-rce-muted">{blurb[surface]}</p>
      </div>

      {readOnly ? (
        accountId && (
          <p className="mt-2">
            <Link className="btn btn-secondary px-2 py-1 text-xs min-h-0" to={`/accounts/${accountId}`}>
              Open the account's conversation
            </Link>
          </p>
        )
      ) : (
        <div className="mt-3 flex flex-wrap items-start gap-2">
          {!adding && (
            <button
              type="button"
              className={`btn btn-primary ${text}`}
              disabled={Boolean(noNoteReason)}
              title={noNoteReason ?? "Write down what the customer said on the phone"}
              onClick={() => setAdding(true)}
            >
              Add call note
            </button>
          )}
          {emailPanel ? (
            <div className="min-w-[14rem] flex-1">{emailPanel}</div>
          ) : !emailElsewhere ? (
            <button type="button" className="btn btn-secondary text-xs" disabled title={emailNote ?? "Email is not available here."}>
              Email the customer
            </button>
          ) : null}
          {textTarget && <SendTextPanel target={textTarget} id={record.id} block={data?.textBlock ?? null} />}
          {surface === "job" && visitId && (
            <button
              type="button"
              className={`btn btn-secondary ${text}`}
              disabled={openCrew.isPending}
              title="Open this job's crew chat"
              onClick={() => openCrew.mutate()}
            >
              Crew chat{crew && crew.unread > 0 ? ` (${crew.unread} new)` : ""}
            </button>
          )}
        </div>
      )}
      {!readOnly && !emailPanel && (emailElsewhere || emailNote) && <p className="mt-1 text-xs text-rce-muted">{emailElsewhere ?? emailNote}</p>}
      {!readOnly && noNoteReason && <p className="mt-1 text-xs text-rce-muted">{noNoteReason}</p>}
      {crewError && <p className="mt-1 text-xs text-red-600">{crewError}</p>}

      {adding && accountId && (
        <AddCallNoteForm accountId={accountId} visitId={surface === "job" ? visitId : undefined} compact={compact} onClose={() => setAdding(false)} />
      )}

      {error && <p className="mt-2 text-xs text-red-600">Could not load the conversation: {(error as Error).message}</p>}
      {isLoading && <p className="mt-2 text-xs text-rce-muted">Loading the conversation…</p>}

      <ul className="mt-3 space-y-2">
        {shown.map((entry) => (
          <li key={entry.id} className={`rounded-lg border border-rce-border px-3 py-2 ${text}`}>
            {entry.type === "note" && (
              <>
                <p className="mb-0.5"><Tag>Call note</Tag></p>
                <CallNoteRow note={entry.note} accountId={entry.note.customerId} readOnly={readOnly} />
              </>
            )}
            {entry.type === "email" && (
              <>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="min-w-0 break-words"><Tag>Email</Tag><span className="font-medium">{entry.email.subject}</span></p>
                  <DeliveryChip delivery={entry.email} />
                </div>
                <p className="mt-0.5 text-xs text-rce-muted">
                  to {entry.email.to}{entry.email.cc.length > 0 ? ` · cc ${entry.email.cc.join(", ")}` : ""} · {whenText(entry.email.createdAt)}
                  {entry.jobLabel && <span> · about {entry.jobLabel}</span>}
                </p>
                {entry.email.error && <p className="text-xs text-red-700">{entry.email.error}</p>}
              </>
            )}
            {entry.type === "message" && (() => {
              const card = approvals?.cards.find((c) => c.id === entry.message.id);
              return card && isOpenCard(card.status) ? (
                <>
                  <ApprovalCard card={card} compact={compact} canApprove={approvals?.canApprove ?? false} approveReason={approvals?.approveReason ?? null} />
                  {entry.jobLabel && <p className="mt-0.5 text-xs text-rce-muted">about {entry.jobLabel}</p>}
                </>
              ) : (
                <>
                  <MessageEntry message={entry.message} compact={compact} onReview={() => drawers.open("thread", entry.message.threadId)} />
                  {entry.jobLabel && <p className="mt-0.5 text-xs text-rce-muted">about {entry.jobLabel}</p>}
                </>
              );
            })()}
            {entry.type === "web_chat" && (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p><Tag>Website chat</Tag>Website chat — {entry.count} {entry.count === 1 ? "message" : "messages"}</p>
                {surface === "lead" && entry.leadId === record.id ? (
                  <span className="text-xs text-rce-muted">The transcript is in Website chat above.</span>
                ) : (
                  <button type="button" className="btn btn-secondary px-2 py-0.5 text-xs min-h-0" onClick={() => drawers.open("lead", entry.leadId)}>
                    Open the chat
                  </button>
                )}
              </div>
            )}
          </li>
        ))}
        {!isLoading && !error && all.length === 0 && (
          <li className={`${text} text-rce-muted`}>
            {readOnly ? "Nothing was said or sent about the jobs at this address yet." : "No conversation yet."}
          </li>
        )}
      </ul>

      {data?.truncated && <p className="mt-2 text-xs text-rce-muted">Showing the most recent entries; older ones are not listed here.</p>}

      {surface === "job" && all.length > JOB_SURFACE_LIMIT && (
        <button type="button" className="mt-2 text-xs underline" onClick={() => setShowAll((v) => !v)}>
          {showAll ? `Show the latest ${JOB_SURFACE_LIMIT}` : `Show all ${all.length} entries (${hidden} more)`}
        </button>
      )}
    </Frame>
  );
}
