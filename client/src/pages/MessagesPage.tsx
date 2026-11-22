/**
 * Messages (work order agent-team, U3): every conversation the hub holds, and the queue of what is
 * waiting for approval. Kyle, 2026-09-29: "the drawer is an action tool where as the tabs are the
 * informative tools" — this page lists and opens; reading and answering happen in the Thread drawer
 * (`?thread=<id>`), which a click on a row opens.
 *
 *   Chips   All · Customers · Jobs · Team · Needs approval (n)
 *   Rows    title, the last line, when, an unread dot, an "AI" chip when the newest message came from an
 *           AI author, and the chip of that message's state (Draft, Needs approval, Sent, Failed, …)
 *   Search  the thread's name or anything said in it
 *
 * "Needs approval" lists the drafts themselves, each as the one ApprovalCard with Approve, Edit and Reject on it
 * (U4/TC3), not conversation rows: Messages -> Needs approval -> Approve and send.
 *
 * There is no "New thread" and no "Delete thread" here: a Team thread is one per person, made the first
 * time they write (team answer 9a), and a conversation leaves the list by "Close thread" in its drawer.
 * "Show closed threads" brings the closed ones back so they can be reopened.
 *
 * Live (U6): the header says "Live" while the stream is up and "Reconnecting…" while it is not (the lists then
 * refresh every 15 seconds on their own). Notifications (U7): "Turn on notifications on this device", beside it.
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { PageHeader } from "../components/PageHeader";
import { ApprovalQueue } from "../components/ApprovalQueue";
import { NotificationsButton } from "../components/NotificationsButton";
import { api } from "../lib/api";
import { useDrawerParams } from "../lib/drawers";
import { streamLabel, useHubPollMs, useHubStreamStatus } from "../lib/hubStreamStatus";
import { authorLabel, messageStatusChip, threadKindLabel, whenText } from "../lib/hubLabels";
import type { ThreadRow } from "../../../shared/hub/views";

type Chip = "all" | "customer" | "job" | "team" | "approval";

const CHIPS: Array<{ id: Chip; label: string }> = [
  { id: "all", label: "All" },
  { id: "customer", label: "Customers" },
  { id: "job", label: "Jobs" },
  { id: "team", label: "Team" },
];

const EMPTY: Record<Chip, string> = {
  all: "No conversations yet. They appear here once somebody has said something in one.",
  customer: "No customer conversations yet.",
  job: "No crew chats yet. Open a job and press Crew chat to start one.",
  team: "No Team threads yet. Each person's thread is made the first time they write to the AI team.",
  approval: "Nothing is waiting for approval.",
};

function Row({ thread, onOpen }: { thread: ThreadRow; onOpen: () => void }) {
  const chip = thread.lastLine ? messageStatusChip(thread.lastLine.status) : null;
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        data-thread-id={thread.id}
        className="flex w-full items-start gap-3 rounded-lg border border-rce-border px-3 py-2 text-left hover:border-rce-accent"
      >
        <span
          aria-label={thread.unread > 0 ? `${thread.unread} unread` : "Read"}
          className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${thread.unread > 0 ? "bg-rce-accent" : "bg-transparent"}`}
        />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-1.5">
            <span className={`truncate text-sm ${thread.unread > 0 ? "font-bold" : "font-semibold"}`}>{thread.title}</span>
            <span className="rounded bg-rce-bg px-1.5 py-0.5 text-[10px] font-semibold uppercase text-rce-soft">{threadKindLabel(thread.kind)}</span>
            {thread.aiLast && <span className="rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-semibold text-violet-800">AI</span>}
            {thread.pending > 0 && (
              <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-800">
                Needs approval{thread.pending > 1 ? ` (${thread.pending})` : ""}
              </span>
            )}
            {chip && !(thread.pending > 0 && thread.lastLine?.status === "pending_approval") && (
              <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${chip.tone}`} title={chip.title}>{chip.label}</span>
            )}
            {thread.status === "closed" && <span className="rounded bg-gray-200 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-gray-700">Closed</span>}
            {thread.unread > 0 && <span className="text-[11px] font-medium text-rce-accent">{thread.unread} new</span>}
          </span>
          {thread.lastLine && (
            <span className="mt-0.5 block truncate text-xs text-rce-muted">
              <span className="font-medium text-rce-soft">{authorLabel(thread.lastLine.authorType, thread.lastLine.authorDisplay)}:</span>{" "}
              {thread.lastLine.text}
            </span>
          )}
        </span>
        <span className="shrink-0 text-xs text-rce-muted">{whenText(thread.lastMessageAt)}</span>
      </button>
    </li>
  );
}

export function MessagesPage() {
  const drawers = useDrawerParams();
  const [chip, setChip] = useState<Chip>("all");
  const [search, setSearch] = useState("");
  const [showClosed, setShowClosed] = useState(false);
  const pollMs = useHubPollMs();
  const streamStatus = useHubStreamStatus();

  const filter = {
    kind: chip === "customer" || chip === "job" || chip === "team" ? chip : undefined,
    status: showClosed ? "all" : "open",
    needsApproval: chip === "approval",
    q: search.trim() || undefined,
  };
  const { data, isLoading, error } = useQuery({
    queryKey: ["hub-threads", { kind: filter.kind, status: filter.status, needsApproval: filter.needsApproval, q: filter.q }],
    queryFn: () => api.hubThreads(filter),
    refetchInterval: pollMs,
    // Changing a chip or typing in the search keeps the last list (and the waiting count) up until the new one lands.
    placeholderData: (previous) => previous,
  });

  const threads = data?.threads ?? [];
  const waiting = data?.needsApproval ?? 0;

  return (
    <div>
      <PageHeader
        title="Messages"
        subtitle="Every conversation, and what is waiting for approval."
        actions={(
          <>
            <span
              data-testid="stream-status"
              title={streamStatus === "live" ? "New messages and approvals appear here as they happen" : "Not connected for live updates; this page checks again every 15 seconds"}
              className={`rounded-full px-2 py-0.5 text-xs font-semibold ${streamStatus === "live" ? "bg-green-100 text-green-800" : "bg-amber-100 text-amber-800"}`}
            >
              {streamLabel(streamStatus)}
            </span>
            <NotificationsButton />
          </>
        )}
      />

      <div className="mb-3 flex flex-wrap items-center gap-2" role="tablist" aria-label="Show">
        {CHIPS.map((c) => (
          <button
            key={c.id}
            type="button"
            role="tab"
            aria-selected={chip === c.id}
            onClick={() => setChip(c.id)}
            className={`rounded-full border px-3 py-1 text-sm font-medium ${chip === c.id ? "border-rce-accent bg-rce-accent text-white" : "border-rce-border text-rce-soft hover:border-rce-accent"}`}
          >
            {c.label}
          </button>
        ))}
        <button
          type="button"
          role="tab"
          aria-selected={chip === "approval"}
          onClick={() => setChip("approval")}
          className={`rounded-full border px-3 py-1 text-sm font-medium ${chip === "approval" ? "border-rce-accent bg-rce-accent text-white" : waiting > 0 ? "border-amber-400 bg-amber-50 text-amber-900" : "border-rce-border text-rce-soft hover:border-rce-accent"}`}
        >
          Needs approval ({waiting})
        </button>
      </div>

      {chip !== "approval" && (
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <input
          type="search"
          className="field max-w-xs"
          placeholder="Search names and messages"
          aria-label="Search messages"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <label className="flex items-center gap-2 text-xs text-rce-soft">
          <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} />
          Show closed threads
        </label>
      </div>
      )}

      {chip === "approval" ? (
        <ApprovalQueue />
      ) : (
        <>
          {error && <p className="text-sm text-red-600">Could not load Messages: {(error as Error).message}</p>}
          {isLoading && <p className="text-sm text-rce-muted">Loading…</p>}

          <ul className="space-y-2">
            {threads.map((t) => <Row key={t.id} thread={t} onOpen={() => drawers.open("thread", t.id)} />)}
            {!isLoading && !error && threads.length === 0 && (
              <li className="text-sm text-rce-muted">{search.trim() ? "Nothing matches that search." : EMPTY[chip]}</li>
            )}
          </ul>
        </>
      )}
    </div>
  );
}
