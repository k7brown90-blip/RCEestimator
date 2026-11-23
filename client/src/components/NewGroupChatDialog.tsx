/**
 * Messages -> "New group chat" (work order agent-team, C7). Kyle, 2026-11-22: "The office can create the chat groups and
 * assign members to it including specific AI bots". A name and the first members (people from the team, AI agents that are
 * switched on); "Create group chat" opens the new group's drawer, where it can be renamed, added to, removed from, closed
 * and (while it is empty) deleted.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { refreshHub } from "../lib/hubQueries";
import { Modal } from "./Modal";
import { GroupMemberPicker, NO_PICKS, picksCount, type GroupPicks } from "./GroupMemberPicker";
import { GROUP_NAME_MAX } from "../../../shared/hub/groups";

export function NewGroupChatDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (threadId: string) => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [picks, setPicks] = useState<GroupPicks>(NO_PICKS);
  const [error, setError] = useState<string | null>(null);
  const choices = useQuery({ queryKey: ["hub-group-choices"], queryFn: () => api.hubGroupChoices() });

  const create = useMutation({
    mutationFn: () => api.createHubGroup({ name: name.trim(), technicianIds: picks.technicianIds, agentKeyIds: picks.agentKeyIds }),
    onSuccess: ({ id }) => { refreshHub(queryClient); onCreated(id); },
    onError: (err) => setError((err as Error).message),
  });
  const blocked = !name.trim() ? "Give the group a name first." : null;

  return (
    <Modal title="New group chat" subtitle="A chat the office makes. Only the people and agents you pick can see it." onClose={onClose}>
      <form
        className="space-y-3"
        aria-label="New group chat"
        onSubmit={(e) => { e.preventDefault(); setError(null); if (!blocked) create.mutate(); }}
      >
        <label className="block text-xs font-medium text-rce-soft">
          Group name
          <input className="field mt-1" value={name} maxLength={GROUP_NAME_MAX} autoFocus onChange={(e) => setName(e.target.value)} placeholder="e.g. Install crew" />
        </label>
        {choices.isLoading && <p className="text-sm text-rce-muted">Loading the team…</p>}
        {choices.error && <p className="text-sm text-red-600">Could not load the team: {(choices.error as Error).message}</p>}
        {choices.data && <GroupMemberPicker choices={choices.data} picks={picks} onChange={setPicks} />}
        {error && <p className="text-xs text-red-600">{error}</p>}
        <div className="flex flex-wrap items-center gap-2">
          <button type="submit" className="btn btn-primary text-sm" disabled={Boolean(blocked) || create.isPending} title={blocked ?? undefined}>
            {create.isPending ? "Creating…" : "Create group chat"}
          </button>
          <button type="button" className="btn btn-secondary text-sm" onClick={onClose}>Cancel</button>
          <span className="text-xs text-rce-muted">{blocked ?? `${picksCount(picks)} member${picksCount(picks) === 1 ? "" : "s"} picked`}</span>
        </div>
      </form>
    </Modal>
  );
}
