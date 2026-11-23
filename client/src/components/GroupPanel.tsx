/**
 * A group chat's Members panel (work order agent-team, C7), at the top of the group's Thread drawer: Messages -> the group
 * -> Members. Who is in it, "Remove" on every member, "Add members" (the same picker as New group chat), and "Delete group".
 * Rename and Close / Reopen are the drawer header's own buttons, the same ones every thread has.
 *
 * Nothing here is permanent: a member can be removed (and added back), a group can be closed and reopened, and an EMPTY
 * group can be deleted. A group that has messages keeps its history, so "Delete group" is greyed there and says why;
 * Close is its exit. A member removed here stops seeing the group, hearing it and counting it unread at once.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { refreshHub } from "../lib/hubQueries";
import type { GroupView } from "../../../shared/hub/views";
import { GroupMemberPicker, NO_PICKS, picksCount, type GroupPicks } from "./GroupMemberPicker";

export function GroupPanel({
  threadId, group, onDeleted, notMemberReason = null,
}: {
  threadId: string;
  group: GroupView;
  onDeleted: () => void;
  /** The server's own reason this reader cannot post (ThreadDetail.postBlock), shown as the note when they are not a member. */
  notMemberReason?: string | null;
}) {
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [picks, setPicks] = useState<GroupPicks>(NO_PICKS);
  const [error, setError] = useState<string | null>(null);
  const choices = useQuery({ queryKey: ["hub-group-choices"], queryFn: () => api.hubGroupChoices(), enabled: adding });

  const done = () => { setError(null); refreshHub(queryClient); };
  const add = useMutation({
    mutationFn: () => api.addHubGroupMembers(threadId, picks),
    onSuccess: () => { setAdding(false); setPicks(NO_PICKS); done(); },
    onError: (err) => setError((err as Error).message),
  });
  const remove = useMutation({
    mutationFn: (m: GroupView["members"][number]) => api.removeHubGroupMember(threadId, m.kind === "person" ? { technicianId: m.id } : { agentKeyId: m.id }),
    onSuccess: done,
    onError: (err) => setError((err as Error).message),
  });
  const deleteGroup = useMutation({
    mutationFn: () => api.deleteHubGroup(threadId),
    onSuccess: () => { refreshHub(queryClient); onDeleted(); },
    onError: (err) => setError((err as Error).message),
  });

  const already: GroupPicks = {
    technicianIds: group.members.filter((m) => m.kind === "person").map((m) => m.id),
    agentKeyIds: group.members.filter((m) => m.kind === "agent").map((m) => m.id),
  };

  return (
    <section className="mb-3 rounded-lg border border-rce-border p-3" aria-label="Group members" data-testid="group-panel">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Members ({group.members.length})</h3>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="btn btn-secondary px-2 py-0.5 text-xs min-h-0" aria-expanded={adding} onClick={() => { setAdding((v) => !v); setPicks(NO_PICKS); }}>
            Add members
          </button>
          <button
            type="button"
            className="btn btn-danger px-2 py-0.5 text-xs min-h-0"
            disabled={!group.canDelete || deleteGroup.isPending}
            title={group.deleteReason ?? "Delete this group. Nothing has been said in it, so nothing is lost."}
            onClick={() => { if (window.confirm("Delete this group? Nothing has been said in it.")) deleteGroup.mutate(); }}
          >
            Delete group
          </button>
        </div>
      </div>
      {group.deleteReason && <p className="mb-2 text-xs text-rce-muted" data-testid="group-delete-reason">Delete group is off: {group.deleteReason}</p>}
      {!group.youAreMember && notMemberReason && <p className="mb-2 text-xs text-amber-800" data-testid="group-not-member">{notMemberReason}</p>}

      {group.members.length === 0 && <p className="text-sm text-rce-muted">Nobody is in this group yet. Use Add members.</p>}
      <ul className="space-y-1">
        {group.members.map((m) => (
          <li key={`${m.kind}:${m.id}`} className="flex flex-wrap items-center justify-between gap-2 text-sm" data-member-id={m.id}>
            <span>
              {m.name}
              {m.kind === "agent" && <span className="ml-1 rounded bg-violet-100 px-1 text-[10px] font-semibold text-violet-800">AI</span>}
              {m.roleLabel && <span className="ml-1 text-xs text-rce-muted">{m.roleLabel}</span>}
              {m.you && <span className="ml-1 text-xs font-semibold text-rce-soft">(you)</span>}
              {!m.active && <span className="ml-1 text-xs text-amber-800" data-testid="group-member-reason">{m.reason ?? (m.kind === "agent" ? "switched off" : "no longer on the team")}</span>}
            </span>
            <button
              type="button"
              className="btn btn-secondary px-2 py-0.5 text-xs min-h-0"
              disabled={remove.isPending}
              title="Take them out of this group. They stop seeing it at once; what they said stays."
              aria-label={`Remove ${m.name}`}
              onClick={() => remove.mutate(m)}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>

      {adding && (
        <form
          className="mt-3 space-y-2"
          aria-label="Add members"
          onSubmit={(e) => { e.preventDefault(); setError(null); if (picksCount(picks) > 0) add.mutate(); }}
        >
          {choices.isLoading && <p className="text-sm text-rce-muted">Loading the team…</p>}
          {choices.error && <p className="text-sm text-red-600">Could not load the team: {(choices.error as Error).message}</p>}
          {choices.data && <GroupMemberPicker choices={choices.data} picks={picks} onChange={setPicks} alreadyIn={already} />}
          <div className="flex flex-wrap items-center gap-2">
            <button type="submit" className="btn btn-primary text-xs" disabled={picksCount(picks) === 0 || add.isPending} title={picksCount(picks) === 0 ? "Tick at least one person or agent first." : undefined}>
              {add.isPending ? "Adding…" : "Add selected"}
            </button>
            <button type="button" className="btn btn-secondary text-xs" onClick={() => { setAdding(false); setPicks(NO_PICKS); }}>Cancel</button>
          </div>
        </form>
      )}
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </section>
  );
}
