/**
 * Call notes — the part of the record conversation that is what the customer SAID on the phone, on
 * the ACCOUNT.
 *
 * Kyle, from a job page, 2026-09-30: "I have no place to record notes from the customer
 * conversation that can be accessed by admin and other personnel." Ruled 2026-10-01: "Notes should
 * be account based for an admin that is answering calls and dispatching. Any info gathered during
 * a conversation should be able to be documented and shared with others per account."
 *
 * ── WHERE THE LIST LIVES NOW ─────────────────────────────────────────────────────────────────
 * Work order agent-team, default D3: ONE Conversation timeline per record replaces the Conversation-
 * notes list and the sent-email list (components/RecordConversation.tsx). This file keeps what is
 * specific to a call note and nothing else: the "Add call note" form and a note's row with its Edit
 * and Delete, plus the helpers the tests and ReviewRequestPanel read. The list, the ordering and the
 * "Show all" live in RecordConversation, once. The notes ROUTES (app.ts, POST/PATCH/DELETE
 * /accounts/:id/notes) stay the only note writer.
 *
 * ── WHO TOOK THE CALL IS TYPED ───────────────────────────────────────────────────────────────
 * "Taken by" is a required box, the house pattern `reviewInspection(id, { reviewedBy })` already
 * uses. The last name typed is remembered in this browser (localStorage) and prefilled, so Kyle types
 * his name once, not all day — and a second admin on another machine gets an empty box, not Kyle's
 * name. No default name, on purpose: a prefilled "Kyle" on every machine would attribute other
 * people's calls to him.
 *
 * ── EDITABLE, DELETABLE, NEVER SILENTLY REWRITTEN ────────────────────────────────────────────
 * Standing rule: everything the app creates has a way out. A note can be edited and deleted from
 * the row itself. But a log whose entries can be quietly changed is worth less than one that
 * cannot, so a note whose `updatedAt` is later than its `createdAt` says "edited" with the time.
 * The server pins both stamps to one instant at create, so that comparison is exact.
 *
 * NOT `Visit.notes`. That is one overwritable box about one job, behind "Edit details", with no
 * author and no time. It stays what it is; this is a different record.
 */

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { refreshHub } from "../lib/hubQueries";
import { whenText as when } from "../lib/hubLabels";
import type { TimelineNote } from "../../../shared/hub/views";

/** Where the last typed "Taken by" lives in this browser. */
export const TAKEN_BY_STORAGE_KEY = "rce.notes.takenBy";

/** How many entries the job drawer shows before "Show all". */
export const JOB_SURFACE_LIMIT = 3;

/** True once a note has been changed after it was written. Exact — see the server's create path. */
export function isEdited(note: Pick<TimelineNote, "createdAt" | "updatedAt">): boolean {
  return new Date(note.updatedAt).getTime() > new Date(note.createdAt).getTime();
}

/** "Panel upgrade — 12 Main St", or null when the note is not tagged to a job. */
export function noteJobLabel(visit: TimelineNote["visit"]): string | null {
  if (!visit) return null;
  const what = visit.jobType || visit.purpose || "Job";
  return visit.property?.addressLine1 ? `${what} — ${visit.property.addressLine1}` : what;
}

function rememberedTakenBy(): string {
  try {
    return localStorage.getItem(TAKEN_BY_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function rememberTakenBy(name: string) {
  try {
    localStorage.setItem(TAKEN_BY_STORAGE_KEY, name);
  } catch {
    // Private window or blocked storage — the note still saves; the name is just not remembered.
  }
}

/** The "Add call note" form (opened by the button in the conversation's toolbar). */
export function AddCallNoteForm({
  accountId, visitId, compact = false, onClose,
}: {
  accountId: string;
  /** The job the drawer is open on — a note added there is tagged to it. */
  visitId?: string;
  compact?: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [body, setBody] = useState("");
  const [takenBy, setTakenBy] = useState(rememberedTakenBy);
  const [message, setMessage] = useState<string | null>(null);

  const add = useMutation({
    mutationFn: () => api.addAccountNote(accountId, { body: body.trim(), takenBy: takenBy.trim(), visitId: visitId ?? null }),
    onSuccess: () => {
      rememberTakenBy(takenBy.trim());
      setBody("");
      setMessage(null);
      refreshHub(queryClient);
      onClose();
    },
    onError: (err) => setMessage((err as Error).message),
  });

  const addBlock =
    !body.trim() && !takenBy.trim()
      ? "Needs what was said and who took the call."
      : !body.trim()
        ? "Write down what was said."
        : !takenBy.trim()
          ? "Say who took the call."
          : null;

  const size = compact ? "text-xs" : "text-sm";
  return (
    <form
      className="mt-3 space-y-2"
      aria-label="Add call note"
      onSubmit={(e) => {
        e.preventDefault();
        if (!addBlock) add.mutate();
      }}
    >
      <label className="block text-xs font-medium text-rce-soft">
        What was said
        <textarea
          className="field mt-1"
          rows={3}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Called about the flickering in the kitchen; wants a Tuesday morning if possible."
          autoFocus
        />
      </label>
      <label className="block text-xs font-medium text-rce-soft">
        Taken by
        <input className="field mt-1 w-56 max-w-full" value={takenBy} onChange={(e) => setTakenBy(e.target.value)} placeholder="Your name" />
      </label>
      {visitId && <p className="text-xs text-rce-muted">Filed on the account and tagged to this job.</p>}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="submit"
          className={`btn btn-primary ${size}`}
          // Greyed with the reason beside it, never hidden (CLAUDE.md click-through rule 5).
          disabled={Boolean(addBlock) || add.isPending}
          title={addBlock ?? "Saves this note on the account"}
        >
          {add.isPending ? "Saving…" : "Save note"}
        </button>
        <button type="button" className={`btn btn-secondary ${size}`} onClick={onClose}>Cancel</button>
        {addBlock && <span className="text-xs text-rce-muted">{addBlock}</span>}
      </div>
      {message && <p className="text-xs text-red-600">{message}</p>}
    </form>
  );
}

/** One call note in the conversation: what was said, who took it, when, and its Edit and Delete. */
export function CallNoteRow({ note, accountId, readOnly = false }: {
  note: TimelineNote;
  accountId: string;
  /** The Property page shows the account's notes for this address but never edits them. */
  readOnly?: boolean;
}) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [editBody, setEditBody] = useState(note.body);
  const [editTakenBy, setEditTakenBy] = useState(note.takenBy);
  const [message, setMessage] = useState<string | null>(null);

  const update = useMutation({
    mutationFn: () => api.updateAccountNote(accountId, note.id, { body: editBody.trim(), takenBy: editTakenBy.trim() }),
    onSuccess: () => {
      setEditing(false);
      setMessage(null);
      refreshHub(queryClient);
    },
    onError: (err) => setMessage((err as Error).message),
  });

  const remove = useMutation({
    mutationFn: () => api.deleteAccountNote(accountId, note.id),
    onSuccess: () => {
      setMessage(null);
      refreshHub(queryClient);
    },
    onError: (err) => setMessage((err as Error).message),
  });

  const job = noteJobLabel(note.visit);

  if (editing) {
    return (
      <form
        className="space-y-2"
        aria-label="Edit call note"
        onSubmit={(e) => {
          e.preventDefault();
          if (editBody.trim() && editTakenBy.trim()) update.mutate();
        }}
      >
        <label className="block text-xs font-medium text-rce-soft">
          What was said
          <textarea className="field mt-1" rows={3} value={editBody} onChange={(e) => setEditBody(e.target.value)} />
        </label>
        <label className="block text-xs font-medium text-rce-soft">
          Taken by
          <input className="field mt-1 w-56 max-w-full" value={editTakenBy} onChange={(e) => setEditTakenBy(e.target.value)} />
        </label>
        <div className="flex gap-2">
          <button
            type="submit"
            className="btn btn-primary text-xs"
            disabled={!editBody.trim() || !editTakenBy.trim() || update.isPending}
            title={!editBody.trim() || !editTakenBy.trim() ? "Needs what was said and who took the call." : "Saves the change — the note will show as edited"}
          >
            {update.isPending ? "Saving…" : "Save changes"}
          </button>
          <button type="button" className="btn btn-secondary text-xs" onClick={() => setEditing(false)}>Cancel</button>
        </div>
        {message && <p className="text-xs text-red-600">{message}</p>}
      </form>
    );
  }

  return (
    <>
      <p className="whitespace-pre-wrap break-words">{note.body}</p>
      <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-rce-muted">
          Taken by <span className="font-medium text-rce-soft">{note.takenBy}</span> · {when(note.createdAt)}
          {isEdited(note) && (
            <span className="text-amber-800" title={`Written ${when(note.createdAt)}, changed ${when(note.updatedAt)}`}>
              {" "}· edited {when(note.updatedAt)}
            </span>
          )}
          {job && <span> · about {job}</span>}
        </p>
        {!readOnly && (
          <div className="flex gap-1">
            <button type="button" className="btn btn-secondary px-2 py-0.5 text-xs min-h-0" onClick={() => { setEditBody(note.body); setEditTakenBy(note.takenBy); setEditing(true); }}>
              Edit
            </button>
            <button
              type="button"
              className="btn btn-danger px-2 py-0.5 text-xs min-h-0"
              disabled={remove.isPending}
              onClick={() => {
                if (window.confirm(`Delete this note taken by ${note.takenBy}? This cannot be undone.`)) remove.mutate();
              }}
            >
              Delete
            </button>
          </div>
        )}
      </div>
      {message && <p className="mt-1 text-xs text-red-600">{message}</p>}
    </>
  );
}
