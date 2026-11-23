/**
 * The Thread drawer (work order agent-team, U3): one conversation from the Messages page, opened by
 * `?thread=<id>`. Kyle, 2026-09-29: "the drawer is an action tool where as the tabs are the
 * informative tools" — the Messages page lists and opens, this is where you read and answer.
 *
 *   Job and Team threads  the messages with who said them (an AI author reads "RCE Admin (AI)"), a box
 *                         and "Post to crew" / "Post to team". Your own messages carry Edit and
 *                         Delete; a deleted one leaves "Deleted by … — reason".
 *   Customer threads      the record's own Conversation (RecordConversation): "Add call note" and
 *                         "Email the customer" are the same buttons as on the account, never a second
 *                         email box here.
 *   Group chats (C7)      the office-made kind: a Members panel on top (Remove, Add members, Delete group - only
 *                         while nothing has been said in it) and "Post to group". Header "Close group" / "Reopen".
 *   Header                "Rename" and "Close thread" / "Reopen". There is no Delete thread and no New
 *                         thread: a Team thread is one per person, made the first time they write
 *                         (team answer 9a), so its exit is Close. "Audit" (Kyle only, greyed with the reason
 *                         for anyone else) shows what the hub did in THIS conversation.
 *   AI drafts             an AI message waiting for approval (or held, failed or refused) is the ApprovalCard
 *                         in place of the plain message: Approve, Edit and Reject, the same card as in the
 *                         Messages "Needs approval" queue.
 *
 *   Photos (U5, amendment 9b)  "Add photo" beside the box on a job, Team or Training thread. On a Team or
 *                         Training thread the picture is shrunk to 1600 px, held on the message you send (one
 *                         HubAttachment) and taken back with "Remove" until it is sent; deleting the message takes
 *                         its photos with it. On a JOB thread the picture is filed on the job's own photos when
 *                         you press "Post to crew" and named by the message. Pictures are fetched with your session.
 *
 * Opening a thread marks it read for you. Live (U6): the open thread refreshes by itself.
 */

import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, fetchProtectedObjectUrl } from "../../lib/api";
import { downscale, downscaleToBlob } from "../../lib/images";
import { useHubPollMs } from "../../lib/hubStreamStatus";
import { useDrawerParams } from "../../lib/drawers";
import { refreshHub, useHubApprovals } from "../../lib/hubQueries";
import { useIsKyle } from "../../lib/session";
import { useLead } from "../../lib/recordQueries";
import { authorLabel, automaticTextLine, isAiAuthor, messageStatusChip, postButtonLabel, threadKindLabel, whenText } from "../../lib/hubLabels";
import { sendBlockText } from "../../../../shared/hub/sendBlocks";
import type { ThreadDetail, ThreadMessage } from "../../../../shared/hub/views";
import { Drawer } from "../Drawer";
import { RecordConversation } from "../RecordConversation";
import { ApprovalCard, isOpenCard } from "../ApprovalCard";
import { MessageAuditLog, AUDIT_LOCK_REASON } from "../MessageAuditLog";
import { SendEmailPanel } from "../SendEmailPanel";
import { GroupPanel } from "../GroupPanel";

/** One picture, fetched with the session (a browser will not send the Authorization header from an <img src>). */
function PhotoThumb({ path, alt }: { path: string; alt: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    let made: string | null = null;
    fetchProtectedObjectUrl(path).then((url) => {
      if (!alive) { URL.revokeObjectURL(url); return; }
      made = url;
      setSrc(url);
    }).catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; if (made) URL.revokeObjectURL(made); };
  }, [path]);
  if (failed) return <span className="text-xs text-rce-muted">Photo unavailable</span>;
  if (!src) return <span className="inline-block h-24 w-24 rounded bg-rce-bg" aria-label="Loading photo" />;
  return (
    <a href={src} target="_blank" rel="noreferrer" title="Open the photo">
      <img src={src} alt={alt} className="h-24 w-24 rounded object-cover" />
    </a>
  );
}

function MessagePhotos({ message }: { message: ThreadMessage }) {
  if (message.deleted || (message.attachments.length === 0 && message.photoIds.length === 0)) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-2" data-testid="message-photos">
      {message.attachments.map((a) => <PhotoThumb key={a.id} path={`/hub/attachments/${encodeURIComponent(a.id)}`} alt="Photo on this message" />)}
      {message.photoIds.map((id) => <PhotoThumb key={id} path={`/health-record-admin/visit-photos/${encodeURIComponent(id)}`} alt="Job photo on this message" />)}
    </div>
  );
}

/** A picture picked and not yet sent. A Team/Training photo is already held on the server (`attachmentId`); a job's is kept here until Post. */
interface StagedPhoto {
  key: string;
  preview: string;
  /** HubAttachment id (Team and Training threads). */
  attachmentId?: string;
  /** The picture to file on the job when the message is posted (job threads). */
  dataUrl?: string;
  /** The job photo (VisitPhoto) this picture became once it was filed. A second "Post to crew" after a failed post names it instead of filing the picture again. */
  visitPhotoId?: string;
}

/** Why "Save changes" is greyed on an empty box (a photo-only message edited down to nothing). */
export const EDIT_NEEDS_WORDS = "Type some words to save. A message can't be edited down to nothing. To take the photo back, use Delete.";

function MessageRow({ message, isNew }: { message: ThreadMessage; isNew: boolean }) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<"view" | "edit" | "delete">("view");
  const [draft, setDraft] = useState(message.body ?? "");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const done = () => { setMode("view"); setError(null); refreshHub(queryClient); };
  const edit = useMutation({
    mutationFn: () => api.editHubMessage(message.id, { body: draft.trim() }),
    onSuccess: done,
    onError: (err) => setError((err as Error).message),
  });
  const remove = useMutation({
    mutationFn: () => api.deleteHubMessage(message.id, { reason: reason.trim() }),
    onSuccess: done,
    onError: (err) => setError((err as Error).message),
  });

  const chip = messageStatusChip(message.status, message.messageClass);
  const autoLine = automaticTextLine(message);
  const ai = isAiAuthor(message.authorType);
  return (
    <li
      className={`rounded-lg border px-3 py-2 text-sm ${message.mine ? "border-rce-accent/40 bg-rce-accentBg/40" : "border-rce-border"} ${isNew ? "ring-1 ring-amber-400" : ""}`}
      data-message-id={message.id}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-rce-muted">
          <span className="font-semibold text-rce-soft">{authorLabel(message.authorType, message.authorDisplay)}</span>
          {ai && <span className="ml-1 rounded bg-violet-100 px-1 text-[10px] font-semibold text-violet-800">AI</span>}
          {" "}· {whenText(message.createdAt)}
          {message.editedAt && <span className="text-amber-800"> · edited {whenText(message.editedAt)}</span>}
          {isNew && <span className="ml-1 font-semibold text-amber-800">New</span>}
          {autoLine && <span data-testid="automatic-text-line"> · {autoLine}</span>}
        </p>
        {chip && <span className={`inline-block rounded px-1.5 py-0.5 text-[11px] font-medium ${chip.tone}`} title={chip.title}>{chip.label}</span>}
      </div>

      {message.deleted ? (
        <p className="mt-1 text-xs italic text-rce-muted">
          Deleted{message.deletedBy ? ` by ${message.deletedBy}` : ""}{message.deletedReason ? ` — ${message.deletedReason}` : ""}
        </p>
      ) : mode === "edit" ? (
        <form
          className="mt-1 space-y-2"
          aria-label="Edit message"
          onSubmit={(e) => { e.preventDefault(); if (draft.trim()) edit.mutate(); }}
        >
          <textarea className="field" rows={3} aria-label="Message text" value={draft} onChange={(e) => setDraft(e.target.value)} />
          {!draft.trim() && <p className="text-xs text-amber-800" data-testid="edit-needs-words">{EDIT_NEEDS_WORDS}</p>}
          <div className="flex gap-2">
            <button type="submit" className="btn btn-primary text-xs" disabled={!draft.trim() || edit.isPending} title={draft.trim() ? "Saves the change — the message will show as edited" : "A message needs text."}>
              {edit.isPending ? "Saving…" : "Save changes"}
            </button>
            <button type="button" className="btn btn-secondary text-xs" onClick={() => { setMode("view"); setError(null); }}>Cancel</button>
          </div>
        </form>
      ) : (
        <>
          {message.subject && <p className="mt-1 font-medium">{message.subject}</p>}
          {message.body ? <p className="mt-0.5 whitespace-pre-wrap break-words">{message.body}</p> : null}
          <MessagePhotos message={message} />
          {message.error && <p className="mt-1 text-xs text-red-700">{message.status === "blocked" ? sendBlockText(message.error) : message.error}</p>}
        </>
      )}

      {mode === "delete" && (
        <form
          className="mt-2 space-y-2 rounded border border-red-200 bg-red-50 p-2"
          aria-label="Delete message"
          onSubmit={(e) => { e.preventDefault(); if (reason.trim()) remove.mutate(); }}
        >
          <label className="block text-xs font-medium text-rce-soft">
            Why is it being deleted?
            <input className="field mt-1" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} autoFocus />
          </label>
          <div className="flex gap-2">
            <button type="submit" className="btn btn-danger text-xs" disabled={!reason.trim() || remove.isPending} title={reason.trim() ? "Leaves a mark that it was deleted, by whom and why" : "Say why first."}>
              {remove.isPending ? "Deleting…" : "Delete message"}
            </button>
            <button type="button" className="btn btn-secondary text-xs" onClick={() => { setMode("view"); setError(null); }}>Cancel</button>
          </div>
        </form>
      )}

      {mode === "view" && !message.deleted && (message.canEdit || message.canDelete) && (
        <div className="mt-1 flex gap-1">
          {message.canEdit && (
            <button type="button" className="btn btn-secondary px-2 py-0.5 text-xs min-h-0" onClick={() => { setDraft(message.body ?? ""); setMode("edit"); }}>Edit</button>
          )}
          {message.canDelete && (
            <button type="button" className="btn btn-danger px-2 py-0.5 text-xs min-h-0" onClick={() => { setReason(""); setMode("delete"); }}>Delete</button>
          )}
        </div>
      )}
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </li>
  );
}

/** A customer thread is the record's own Conversation: the same section, the same two buttons. */
function CustomerThreadBody({ thread }: { thread: ThreadDetail["thread"] }) {
  const customerId = thread.customerId;
  const accountId = customerId ?? "";
  const { data: summary } = useQuery({
    // The same read, under the same key, as the Account page (lib/queryKeys.ts: a key names an endpoint).
    queryKey: ["account-summary", accountId],
    queryFn: () => api.accountSummary(accountId),
    enabled: Boolean(accountId),
  });
  const { data: lead } = useLead(customerId ? undefined : thread.leadId ?? undefined);

  if (customerId) {
    return (
      <div className="space-y-2">
        <p><Link to={`/accounts/${customerId}`} className="btn btn-secondary px-2 py-0.5 text-xs min-h-0">Open the account →</Link></p>
        <RecordConversation
          surface="account"
          record={{ key: "customerId", id: customerId }}
          accountId={customerId}
          emailPanel={
            <SendEmailPanel
              target="account" id={customerId} primaryEmail={summary?.account.email ?? null}
              accountIdForContacts={customerId} showThread={false} openLabel="Email the customer"
            />
          }
        />
      </div>
    );
  }
  const leadId = thread.leadId;
  if (!leadId) return <p className="text-sm text-rce-muted">This conversation is not attached to a customer.</p>;
  return (
    <RecordConversation
      surface="lead"
      record={{ key: "leadId", id: leadId }}
      accountId={null}
      emailPanel={
        lead?.email
          ? <SendEmailPanel target="lead" id={leadId} primaryEmail={lead.email} showThread={false} openLabel="Email the customer" />
          : undefined
      }
      emailNote={lead && !lead.email ? "This lead has no email address — add one from the lead." : undefined}
    />
  );
}

export function ThreadDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const drawers = useDrawerParams();
  const pollMs = useHubPollMs();
  const { data, isLoading, error } = useQuery({ queryKey: ["hub-thread", id], queryFn: () => api.hubThread(id), refetchInterval: pollMs });

  // What was new when this opened. Marking the thread read moves the stored time, so keep the first one.
  const seenAt = useRef<string | null | undefined>(undefined);
  if (data && seenAt.current === undefined) seenAt.current = data.lastReadAt;

  const markRead = useMutation({
    mutationFn: () => api.markHubThreadRead(id),
    onSuccess: () => refreshHub(queryClient),
  });
  const unread = data?.thread.unread ?? 0;
  useEffect(() => {
    if (unread > 0 && !markRead.isPending) markRead.mutate();
  }, [unread]);

  const isKyle = useIsKyle();
  const [showAudit, setShowAudit] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);

  const patch = useMutation({
    mutationFn: (input: { title?: string; status?: "open" | "closed" }) => api.patchHubThread(id, input),
    onSuccess: () => { setRenaming(false); setActionError(null); refreshHub(queryClient); },
    onError: (err) => setActionError((err as Error).message),
  });
  const [staged, setStaged] = useState<StagedPhoto[]>([]);
  const [picking, setPicking] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);
  // Photos this person added here and never sent (the drawer was closed, a post failed): shown again with their Remove.
  const restoring = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const held of data?.staged ?? []) {
      if (restoring.current.has(held.id)) continue;
      restoring.current.add(held.id);
      fetchProtectedObjectUrl(`/hub/attachments/${encodeURIComponent(held.id)}`)
        .then((url) => setStaged((list) => (list.some((x) => x.attachmentId === held.id) ? list : [...list, { key: held.id, preview: url, attachmentId: held.id }])))
        .catch(() => { restoring.current.delete(held.id); });
    }
  }, [data?.staged]);
  // The ONE id of the message being composed: made on the first press of Post, reused by every retry of it (a failed answer, a
  // second press), and dropped when it goes or the words or pictures change. The server turns a repeat into the message it made.
  const composeId = useRef<string | null>(null);
  const post = useMutation({
    mutationFn: async () => {
      // A job's pictures are filed on the job first (its own VisitPhoto), then named by the message.
      const photoIds: string[] = [];
      for (const p of staged) {
        if (p.visitPhotoId) { photoIds.push(p.visitPhotoId); continue; }
        if (p.dataUrl && data?.thread.visitId) {
          const filed = (await api.uploadVisitPhoto(data.thread.visitId, { dataUrl: p.dataUrl })).id;
          photoIds.push(filed);
          // Remember it: if the post itself fails, pressing "Post to crew" again names this photo, it does not file a second.
          setStaged((list) => list.map((x) => (x.key === p.key ? { ...x, visitPhotoId: filed } : x)));
        }
      }
      const attachmentIds = staged.flatMap((p) => (p.attachmentId ? [p.attachmentId] : []));
      const clientMessageId = composeId.current ?? crypto.randomUUID();
      composeId.current = clientMessageId;
      return api.postHubMessage(id, {
        body: text.trim(),
        clientMessageId,
        ...(photoIds.length > 0 ? { photoIds } : {}),
        ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
      });
    },
    onSuccess: () => {
      composeId.current = null;
      for (const p of staged) URL.revokeObjectURL(p.preview);
      setStaged([]); setText(""); setActionError(null); refreshHub(queryClient);
    },
    onError: (err) => setActionError((err as Error).message),
  });

  // "Add photo": the picture is shrunk to 1600 px here, then held (Team, Training) or kept for the job (job).
  async function addPhoto(file: File | undefined) {
    if (!file || !data) return;
    setPicking(true);
    setActionError(null);
    try {
      composeId.current = null; // a different picture set is a different message
      if (data.thread.kind === "job") {
        // Kept here and filed on the job when the message is posted; a data URL previews itself.
        const dataUrl = await downscale(file);
        setStaged((list) => [...list, { key: crypto.randomUUID(), preview: dataUrl, dataUrl }]);
      } else {
        const blob = await downscaleToBlob(file);
        const saved = await api.uploadHubAttachment(id, blob);
        setStaged((list) => [...list, { key: saved.id, preview: URL.createObjectURL(blob), attachmentId: saved.id }]);
      }
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setPicking(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  // Take a picture back before it is sent. A Team photo is removed from the server too.
  async function removePhoto(photo: StagedPhoto) {
    try {
      if (photo.attachmentId) await api.removeHubAttachment(photo.attachmentId);
      composeId.current = null;
      URL.revokeObjectURL(photo.preview);
      setStaged((list) => list.filter((p) => p.key !== photo.key));
    } catch (e) {
      setActionError((e as Error).message);
    }
  }

  const thread = data?.thread;
  // The cards of this conversation (a customer thread draws its own through RecordConversation).
  const { data: approvals } = useHubApprovals({ status: "all", threadId: id }, Boolean(thread) && thread?.kind !== "customer");
  const cardById = new Map((approvals?.cards ?? []).map((c) => [c.id, c]));
  const closed = thread?.status === "closed";
  const isCustomer = thread?.kind === "customer";
  const postLabel = thread ? postButtonLabel(thread.kind) : "Post";
  // The server says when this is another person's Team thread (data.postBlock); that reason leads.
  const postBlock = data?.postBlock ?? (closed ? "This thread is closed. Reopen it to post." : !text.trim() && staged.length === 0 ? "Write a message first." : null);
  // Dev threads hold no photos; every other kind that has a composer does.
  const photoBlock: string | null = !thread || thread.kind === "dev" || thread.kind === "group" ? "Photos go on a job, Team or Training thread."
    : data?.postBlock ?? (closed ? "This thread is closed. Reopen it to add a photo." : null);
  const newAfter = seenAt.current ? new Date(seenAt.current).getTime() : 0;

  return (
    <Drawer
      title={thread?.title ?? "Messages"}
      subtitle={thread ? `${threadKindLabel(thread.kind)}${closed ? " · closed" : ""}` : undefined}
      onClose={onClose}
      wide
      headerActions={thread ? (
        <>
          <button type="button" className="btn btn-secondary px-2 py-1 text-xs min-h-0" onClick={() => { setTitle(thread.title); setRenaming((v) => !v); }}>
            Rename
          </button>
          <button
            type="button"
            className="btn btn-secondary px-2 py-1 text-xs min-h-0"
            disabled={!isKyle}
            aria-expanded={showAudit}
            title={isKyle ? "What the hub did in this conversation: approvals, sends and blocked texts" : AUDIT_LOCK_REASON}
            onClick={() => setShowAudit((v) => !v)}
          >
            Audit
          </button>
          <button
            type="button"
            className="btn btn-secondary px-2 py-1 text-xs min-h-0"
            disabled={patch.isPending}
            title={closed ? "Bring this conversation back to the Messages list" : "Take this conversation off the Messages list; it can be reopened"}
            onClick={() => patch.mutate({ status: closed ? "open" : "closed" })}
          >
            {closed ? "Reopen" : thread.kind === "group" ? "Close group" : "Close thread"}
          </button>
        </>
      ) : null}
    >
      {error && <p className="text-sm text-red-600">Could not load this conversation: {(error as Error).message}</p>}
      {isLoading && <p className="text-sm text-rce-muted">Loading…</p>}

      {thread && renaming && (
        <form
          className="mb-3 flex flex-wrap items-end gap-2"
          aria-label="Rename thread"
          onSubmit={(e) => { e.preventDefault(); if (title.trim()) patch.mutate({ title: title.trim() }); }}
        >
          <label className="block flex-1 text-xs font-medium text-rce-soft">
            Name
            <input className="field mt-1" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} autoFocus />
          </label>
          <button type="submit" className="btn btn-primary text-xs" disabled={!title.trim() || patch.isPending}>Save name</button>
          <button type="button" className="btn btn-secondary text-xs" onClick={() => setRenaming(false)}>Cancel</button>
        </form>
      )}
      {actionError && <p className="mb-2 text-xs text-red-600">{actionError}</p>}
      {thread && !isKyle && <p className="mb-2 text-xs text-rce-muted">Audit: {AUDIT_LOCK_REASON}</p>}
      {thread && isKyle && showAudit && (
        <div className="mb-3 rounded-lg border border-rce-border p-3">
          <p className="mb-2 text-sm font-semibold">Audit for this conversation</p>
          <MessageAuditLog threadId={id} />
        </div>
      )}

      {thread && isCustomer && <CustomerThreadBody thread={thread} />}

      {thread && !isCustomer && data && (
        <div className="space-y-3 pb-4">
          {thread.kind === "job" && thread.visitId && (
            <p>
              <button type="button" className="btn btn-secondary px-2 py-0.5 text-xs min-h-0" onClick={() => drawers.open("job", thread.visitId as string)}>
                Open the job
              </button>
            </p>
          )}
          {thread.kind === "group" && data.group && <GroupPanel threadId={thread.id} group={data.group} onDeleted={onClose} notMemberReason={data.postBlock} />}
          {data.truncated && <p className="text-xs text-rce-muted">Showing the most recent messages; older ones are not listed here.</p>}
          <ul className="space-y-2">
            {data.messages.map((m) => {
              const card = cardById.get(m.id);
              if (card && isOpenCard(card.status)) {
                return (
                  <li key={m.id} data-message-id={m.id}>
                    <ApprovalCard card={card} canApprove={approvals?.canApprove ?? false} approveReason={approvals?.approveReason ?? null} />
                  </li>
                );
              }
              return <MessageRow key={m.id} message={m} isNew={!m.mine && newAfter > 0 && new Date(m.createdAt).getTime() > newAfter} />;
            })}
            {data.messages.length === 0 && <li className="text-sm text-rce-muted">Nothing has been said here yet.</li>}
          </ul>
          <form
            className="space-y-2"
            aria-label={postLabel}
            onSubmit={(e) => { e.preventDefault(); if (!postBlock) post.mutate(); }}
          >
            <label className="block text-xs font-medium text-rce-soft">
              Message
              <textarea className="field mt-1" rows={3} value={text} onChange={(e) => { composeId.current = null; setText(e.target.value); }} disabled={closed || Boolean(data?.postBlock)} />
            </label>
            {staged.length > 0 && (
              <ul className="flex flex-wrap gap-2" aria-label="Photos to send">
                {staged.map((p) => (
                  <li key={p.key} className="relative">
                    <img src={p.preview} alt="Photo to send" className="h-20 w-20 rounded object-cover" />
                    <button type="button" className="btn btn-secondary absolute right-0 top-0 px-1.5 py-0 text-[11px] min-h-0" onClick={() => void removePhoto(p)}>Remove</button>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <button type="submit" className="btn btn-primary text-sm" disabled={Boolean(postBlock) || post.isPending} title={postBlock ?? undefined}>
                {post.isPending ? "Posting…" : postLabel}
              </button>
              <input
                ref={fileInput} type="file" accept="image/*" capture="environment" className="hidden" aria-label="Choose a photo"
                onChange={(e) => void addPhoto(e.target.files?.[0])}
              />
              <button
                type="button" className="btn btn-secondary text-sm"
                disabled={photoBlock !== null || picking || staged.length >= 6}
                title={photoBlock ?? (staged.length >= 6 ? "Six photos at most in one message." : "Take or choose a picture to send with this message")}
                onClick={() => fileInput.current?.click()}
              >
                {picking ? "Adding…" : "Add photo"}
              </button>
              {photoBlock && photoBlock !== postBlock && <span className="text-xs text-rce-muted">{photoBlock}</span>}
              {postBlock && <span className="text-xs text-rce-muted">{postBlock}</span>}
            </div>
          </form>
        </div>
      )}
    </Drawer>
  );
}
