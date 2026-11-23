/**
 * The people and AI agents a group chat can hold (work order agent-team, C7), as two lists of tick boxes. ONE picker, used by
 * both doors onto the same job: "New group chat" on the Messages page (the first members) and "Add members" in a group's own
 * drawer (more of them). A person is a name; an agent reads "Name (AI) — Role", only keys that are switched on are offered,
 * and there is no way to name a customer.
 */
import type { GroupChoices } from "../../../shared/hub/views";

export interface GroupPicks {
  technicianIds: string[];
  agentKeyIds: string[];
}

export const NO_PICKS: GroupPicks = { technicianIds: [], agentKeyIds: [] };

export const picksCount = (p: GroupPicks): number => p.technicianIds.length + p.agentKeyIds.length;

const toggle = (list: string[], id: string): string[] => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

export function GroupMemberPicker({
  choices, picks, onChange, alreadyIn = { technicianIds: [], agentKeyIds: [] },
}: {
  choices: GroupChoices;
  picks: GroupPicks;
  onChange: (next: GroupPicks) => void;
  /** Members the group already has: left out of the lists. */
  alreadyIn?: GroupPicks;
}) {
  const people = choices.people.filter((p) => !alreadyIn.technicianIds.includes(p.id));
  const agents = choices.agents.filter((a) => !alreadyIn.agentKeyIds.includes(a.id));
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <fieldset className="rounded-lg border border-rce-border p-2">
        <legend className="px-1 text-xs font-semibold text-rce-soft">People</legend>
        {people.length === 0 && <p className="text-xs text-rce-muted">Everyone on the team is already in this group.</p>}
        <ul className="space-y-1">
          {people.map((p) => (
            <li key={p.id}>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={picks.technicianIds.includes(p.id)}
                  onChange={() => onChange({ ...picks, technicianIds: toggle(picks.technicianIds, p.id) })}
                />
                {p.name}
              </label>
            </li>
          ))}
        </ul>
      </fieldset>
      <fieldset className="rounded-lg border border-rce-border p-2">
        <legend className="px-1 text-xs font-semibold text-rce-soft">AI agents</legend>
        {agents.length === 0 && (
          <p className="text-xs text-rce-muted">
            {choices.agents.length === 0 ? "No agent is switched on. Agents are made in Settings → Agent keys." : "Every agent that is switched on is already in this group."}
          </p>
        )}
        <ul className="space-y-1">
          {agents.map((a) => (
            <li key={a.id}>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={picks.agentKeyIds.includes(a.id)}
                  disabled={!a.canJoin}
                  title={a.reason ?? undefined}
                  onChange={() => { if (a.canJoin) onChange({ ...picks, agentKeyIds: toggle(picks.agentKeyIds, a.id) }); }}
                />
                <span className={a.canJoin ? undefined : "text-rce-muted"}>
                  {a.name} <span className="rounded bg-violet-100 px-1 text-[10px] font-semibold text-violet-800">AI</span>{" "}
                  <span className="text-xs text-rce-muted">{a.roleLabel}</span>
                  {!a.canJoin && <span className="block text-xs text-amber-800" data-testid="agent-cannot-join">{a.reason}</span>}
                </span>
              </label>
            </li>
          ))}
        </ul>
      </fieldset>
    </div>
  );
}
