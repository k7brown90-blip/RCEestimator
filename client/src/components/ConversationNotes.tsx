/**
 * Conversation notes — the running log of what the customer said, on the ACCOUNT.
 *
 * Kyle, from a job page, 2026-09-30: "I have no place to record notes from the customer
 * conversation that can be accessed by admin and other personnel." Ruled 2026-10-01: "Notes should
 * be account based for an admin that is answering calls and dispatching. Any info gathered during
 * a conversation should be able to be documented and shared with others per account."
 *
 * ── ONE COMPONENT, TWO SURFACES (constants.md: ONE ACTION, ONE IMPLEMENTATION) ───────────────
 * `surface="account"` — the account page, the log's home: every note, newest first.
 * `surface="job"`     — the job drawer: the same account log (a dispatcher looking at a job needs
 *                       what the LAST caller said, whichever job it was about), the newest few with
 *                       "Show all", and a note added here is tagged to this job.
 * Both read `["accountNotes", accountId]` — one query, one cache entry, so a note added in the
 * drawer is already on the account page.
 *
 * ── WHO TOOK THE CALL IS TYPED ───────────────────────────────────────────────────────────────
 * There is no per-user identity behind the PIN gate, so the server cannot know who took the call
 * and this component never pretends to: "Taken by" is a required box, the house pattern
 * `reviewInspection(id, { reviewedBy })` already uses. The last name typed is remembered in this
 * browser (localStorage) and prefilled, so Kyle types his name once, not all day — and a second
 * admin on another machine gets an empty box, not Kyle's name. No default name, on purpose: a
 * prefilled "Kyle" on every machine would attribute other people's calls to him.
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
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { CustomerNote } from "../lib/api";

/** Where the last typed "Taken by" lives in this browser. */
export const TAKEN_BY_STORAGE_KEY = "rce.notes.takenBy";

/** How many notes the job drawer shows before "Show all". */
export const JOB_SURFACE_LIMIT = 3;

/** True once a note has been changed after it was written. Exact — see the server's create path. */
export function isEdited(note: Pick<CustomerNote, "createdAt" | "updatedAt">): boolean {
  return new Date(note.updatedAt).getTime() > new Date(note.createdAt).getTime();
}

/** "Panel upgrade — 12 Main St", or null when the note is not tagged to a job. */
export function noteJobLabel(visit: CustomerNote["visit"]): string | null {
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

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function ConversationNotes({
  accountId,
  surface,
  visitId,
}: {
  accountId: string;
  surface: "account" | "job";
  /** The job the drawer is open on — a note added there is tagged to it. */
  visitId?: string;
}) {
  const queryClient = useQueryClient();
  const { data: notes, isLoading, error } = useQuery({
    queryKey: ["accountNotes", accountId],
    queryFn: () => api.accountNotes(accountId),
    enabled: Boolean(accountId),
  });

  const [adding, setAdding] = useState(false);
  const [body, setBody] = useState("");
  const [takenBy, setTakenBy] = useState(rememberedTakenBy);
  const [showAll, setShowAll] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editBody, setEditBody] = useState("");
  const [editTakenBy, setEditTakenBy] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["accountNotes", accountId] });

  const add = useMutation({
    mutationFn: () =>
      api.addAccountNote(accountId, {
        body: body.trim(),
        takenBy: takenBy.trim(),
        visitId: surface === "job" ? visitId ?? null : null,
      }),
    onSuccess: () => {
      rememberTakenBy(takenBy.trim());
      setBody("");
      setAdding(false);
      setMessage(null);
      refresh();
    },
    onError: (err) => setMessage((err as Error).message),
  });

  const update = useMutation({
    mutationFn: (noteId: string) =>
      api.updateAccountNote(accountId, noteId, { body: editBody.trim(), takenBy: editTakenBy.trim() }),
    onSuccess: () => {
      setEditingId(null);
      setMessage(null);
      refresh();
    },
    onError: (err) => setMessage((err as Error).message),
  });

  const remove = useMutation({
    mutationFn: (noteId: string) => api.deleteAccountNote(accountId, noteId),
    onSuccess: () => {
      setMessage(null);
      refresh();
    },
    onError: (err) => setMessage((err as Error).message),
  });

  const all = notes ?? [];
  const limited = surface === "job" && !showAll;
  const shown = limited ? all.slice(0, JOB_SURFACE_LIMIT) : all;
  const hidden = all.length - shown.length;

  const addBlock =
    !body.trim() && !takenBy.trim()
      ? "Needs what was said and who took the call."
      : !body.trim()
        ? "Write down what was said."
        : !takenBy.trim()
          ? "Say who took the call."
          : null;

  const startEdit = (note: CustomerNote) => {
    setEditingId(note.id);
    setEditBody(note.body);
    setEditTakenBy(note.takenBy);
  };

  const confirmDelete = (note: CustomerNote) => {
    if (window.confirm(`Delete this note taken by ${note.takenBy}? This cannot be undone.`)) {
      remove.mutate(note.id);
    }
  };

  const isAccount = surface === "account";
  const Frame = isAccount ? "section" : "div";
  const frameClass = isAccount ? "card mb-5 p-4" : "rounded-lg border border-rce-border p-2 text-xs";

  return (
    // A named <section> is a landmark on its own; the drawer's compact <div> needs the role spelled out.
    <Frame className={frameClass} role={isAccount ? undefined : "group"} aria-label="Conversation notes">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          {isAccount ? (
            <h2 className="text-lg font-semibold">Conversation notes</h2>
          ) : (
            <p className="font-semibold text-rce-soft">Conversation notes</p>
          )}
          <p className="text-xs text-rce-muted">
            {isAccount
              ? "What the customer said on the phone, who took the call, and when — shared with everyone who opens this account."
              : "The account's log — what the last caller said, whichever job it was about."}
          </p>
        </div>
        {!adding && (
          <button type="button" className={`btn btn-primary ${isAccount ? "text-sm" : "text-xs"}`} onClick={() => setAdding(true)}>
            Add note
          </button>
        )}
      </div>

      {adding && (
        <form
          className="mt-3 space-y-2"
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
            <input
              className="field mt-1 w-56 max-w-full"
              value={takenBy}
              onChange={(e) => setTakenBy(e.target.value)}
              placeholder="Your name"
            />
          </label>
          {surface === "job" && visitId && (
            <p className="text-xs text-rce-muted">Filed on the account and tagged to this job.</p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="submit"
              className={`btn btn-primary ${isAccount ? "text-sm" : "text-xs"}`}
              // Greyed with the reason beside it, never hidden (CLAUDE.md click-through rule 5).
              disabled={Boolean(addBlock) || add.isPending}
              title={addBlock ?? "Saves this note on the account"}
            >
              {add.isPending ? "Saving…" : "Save note"}
            </button>
            <button type="button" className={`btn btn-secondary ${isAccount ? "text-sm" : "text-xs"}`} onClick={() => { setAdding(false); setMessage(null); }}>
              Cancel
            </button>
            {addBlock && <span className="text-xs text-rce-muted">{addBlock}</span>}
          </div>
        </form>
      )}

      {error && <p className="mt-2 text-xs text-red-600">Could not load the notes: {(error as Error).message}</p>}
      {isLoading && <p className="mt-2 text-xs text-rce-muted">Loading notes…</p>}

      <ul className="mt-3 space-y-2">
        {shown.map((note) => {
          const job = noteJobLabel(note.visit);
          const editing = editingId === note.id;
          return (
            <li key={note.id} className={`rounded-lg border border-rce-border px-3 py-2 ${isAccount ? "text-sm" : "text-xs"}`}>
              {editing ? (
                <form
                  className="space-y-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (editBody.trim() && editTakenBy.trim()) update.mutate(note.id);
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
                    <button type="button" className="btn btn-secondary text-xs" onClick={() => setEditingId(null)}>Cancel</button>
                  </div>
                </form>
              ) : (
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
                    <div className="flex gap-1">
                      <button type="button" className="btn btn-secondary px-2 py-0.5 text-xs min-h-0" onClick={() => startEdit(note)}>
                        Edit
                      </button>
                      <button
                        type="button"
                        className="btn btn-danger px-2 py-0.5 text-xs min-h-0"
                        disabled={remove.isPending}
                        onClick={() => confirmDelete(note)}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                </>
              )}
            </li>
          );
        })}
        {!isLoading && !error && all.length === 0 && (
          <li className={`${isAccount ? "text-sm" : "text-xs"} text-rce-muted`}>No conversation notes yet.</li>
        )}
      </ul>

      {surface === "job" && all.length > JOB_SURFACE_LIMIT && (
        <button type="button" className="mt-2 text-xs underline" onClick={() => setShowAll((v) => !v)}>
          {showAll ? `Show the latest ${JOB_SURFACE_LIMIT}` : `Show all ${all.length} notes (${hidden} more)`}
        </button>
      )}

      {message && <p className="mt-2 text-xs text-red-600">{message}</p>}
    </Frame>
  );
}
