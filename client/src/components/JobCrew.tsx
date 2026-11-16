/**
 * "Technicians on this job" - the ONE place the office adds, removes and chooses the lead of a job's
 * crew. Kyle, 2026-11-14: "I don't have a way to arrange and add/remove techs from jobs." and
 * 2026-11-15: "I am unable to assign multiple techs to the same job and need to update the scheduling
 * so I can manage manpower between jobs."
 *
 * One component, hosted by every screen where the office stands on a job: the schedule card in the
 * Job drawer and the visit workspace (`ScheduleOnCalendar`, including the Test Account's), and the
 * Calendar's Job Scheduling panel when the job is already booked (`JobScheduler`, reschedule mode).
 * It works with or without a date: the crew is the job's, the date is the calendar's. The server
 * side is `services/visitCrew.ts`, which keeps one lead per job and keeps the Google event's guests
 * equal to the crew; a Google failure comes back as a warning and is shown here, never as a failure
 * of the change itself.
 *
 * A cancelled or completed job takes no crew changes: the controls stay on screen, greyed, with the
 * reason beside them (CLAUDE.md click-through rule 5).
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { CrewChangeNotes } from "../lib/api";
import { SCHEDULE_QUERY_KEYS } from "../lib/queryKeys";

interface Props {
  visitId: string;
  status: string;
  /** Set once a consultation was closed out: its status stays "estimate", so this is the only signal. */
  completedAt?: string | null;
  /** The host refreshes its own reads (the drawer's visit, the workspace). */
  onChanged?: () => void;
  /**
   * Each tech's "available / busy" line for a day the host is moving the job to (the Calendar's
   * reschedule panel), keyed by technician id. Shown beside the name; omitted everywhere else.
   */
  availability?: Record<string, CrewAvailability>;
  /** What to say in place of the lines while they are not there (no day picked yet, still reading, failed). */
  availabilityNote?: string | null;
}

export type CrewAvailability = { tone: "ok" | "busy" | "warn"; text: string };

type Notice = { tone: "info" | "warn"; text: string };

/** "primary" is the lead; the field app's own new-service-call used to write "lead" for the same thing. */
const isLeadRole = (role: string) => role === "primary" || role === "lead";

export function JobCrew({ visitId, status, completedAt, onChanged, availability, availabilityNote }: Props) {
  const queryClient = useQueryClient();
  const [technicianId, setTechnicianId] = useState("");
  const [pickedRole, setPickedRole] = useState<"primary" | "helper" | null>(null);
  const [notices, setNotices] = useState<Notice[]>([]);

  const { data: technicians } = useQuery({ queryKey: ["technicians"], queryFn: api.technicians });
  const { data: assignments, isError: crewFailed } = useQuery({
    queryKey: ["visitAssignments", visitId],
    queryFn: () => api.visitAssignments(visitId),
    enabled: Boolean(visitId),
  });

  // Lead first, then in the order they were put on the job. A finished assignment is not on the crew.
  const crew = (assignments ?? [])
    .filter((a) => a.status !== "completed")
    .sort((a, b) => Number(isLeadRole(b.role)) - Number(isLeadRole(a.role)));
  const hasLead = crew.some((a) => isLeadRole(a.role));
  const onJob = new Set(crew.map((a) => a.technicianId));
  const pickable = (technicians ?? []).filter((t) => t.isActive && !onJob.has(t.id));
  // The first tech on a job leads it; everyone after helps unless the office says otherwise.
  const role = pickedRole ?? (hasLead ? "helper" : "primary");

  const closedReason = status === "cancelled" || status === "completed"
    ? `This job is ${status}, so its technicians can't be changed.`
    : completedAt
      ? "This consultation is completed, so its technicians can't be changed."
      : null;

  const settled = (result: (CrewChangeNotes & { id?: string }) | undefined) => {
    const next: Notice[] = [];
    if (result?.promoted) next.push({ tone: "info", text: `${result.promoted.name} is now the lead.` });
    if (result?.warning) next.push({ tone: "warn", text: result.warning });
    setNotices(next);
    void queryClient.invalidateQueries({ queryKey: ["visitAssignments", visitId] });
    for (const key of SCHEDULE_QUERY_KEYS) void queryClient.invalidateQueries({ queryKey: key });
    onChanged?.();
  };

  const add = useMutation({
    mutationFn: () => api.assignTechnician(visitId, { technicianId, role }),
    onSuccess: (result) => { setTechnicianId(""); setPickedRole(null); settled(result); },
  });
  const lead = useMutation({
    mutationFn: (assignmentId: string) => api.makeLeadAssignment(assignmentId),
    onSuccess: settled,
  });
  const remove = useMutation({
    mutationFn: (assignmentId: string) => api.removeAssignment(assignmentId),
    onSuccess: settled,
  });

  const busy = add.isPending || lead.isPending || remove.isPending;
  const addReason = closedReason ?? (!technicianId ? "Pick a technician first." : null);
  const failure = [add.error, lead.error, remove.error].find((e) => e != null) as Error | undefined;

  return (
    <div data-job-crew className="rounded-md border border-rce-border bg-rce-surface p-3">
      <h4 className="mb-2 text-sm font-semibold">Technicians on this job</h4>

      {crewFailed && <p className="mb-2 text-xs text-red-600">Couldn&apos;t load who is on this job.</p>}
      {!crewFailed && assignments && crew.length === 0 && (
        <p className="mb-2 text-xs text-rce-muted">No technician is on this job yet.</p>
      )}

      {crew.length > 0 && availabilityNote && (
        <p className="mb-2 text-xs text-rce-muted">{availabilityNote}</p>
      )}
      {crew.length > 0 && (
        <ul className="mb-3 space-y-2">
          {crew.map((a) => {
            const isLead = isLeadRole(a.role);
            return (
              <li key={a.id} className="flex flex-wrap items-center gap-2 rounded-md border border-rce-border bg-rce-bg p-2 text-sm">
                <span className="font-medium">{a.technician.name}</span>
                <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${isLead ? "bg-green-100 text-green-800" : "bg-rce-surface text-rce-muted"}`}>
                  {isLead ? "Lead" : "Helper"}
                </span>
                {availability?.[a.technicianId] && (
                  <span
                    data-crew-availability
                    className={`text-xs ${availability[a.technicianId].tone === "warn" ? "text-amber-600" : availability[a.technicianId].tone === "busy" ? "text-red-600" : "text-green-700"}`}
                  >
                    {availability[a.technicianId].text}
                  </span>
                )}
                <span className="ml-auto flex flex-wrap gap-2">
                  {!isLead && (
                    <button
                      type="button"
                      className="btn btn-secondary text-xs"
                      disabled={Boolean(closedReason) || busy}
                      onClick={() => lead.mutate(a.id)}
                    >
                      Make lead
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn-secondary text-xs"
                    disabled={Boolean(closedReason) || busy}
                    onClick={() => remove.mutate(a.id)}
                  >
                    Remove from job
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-rce-muted">
          Add a technician
          <select
            className="field mt-1 block"
            value={technicianId}
            disabled={Boolean(closedReason)}
            onChange={(e) => setTechnicianId(e.target.value)}
          >
            <option value="">Pick a technician…</option>
            {pickable.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </label>
        <label className="text-xs text-rce-muted">
          As
          <select
            className="field mt-1 block"
            value={role}
            disabled={Boolean(closedReason)}
            onChange={(e) => setPickedRole(e.target.value as "primary" | "helper")}
          >
            <option value="primary">Lead</option>
            <option value="helper">Helper</option>
          </select>
        </label>
        <button
          type="button"
          className="btn btn-primary text-sm"
          disabled={Boolean(addReason) || busy}
          onClick={() => add.mutate()}
        >
          {add.isPending ? "Adding…" : "Add to job"}
        </button>
      </div>
      {addReason && <p className="mt-1 text-xs text-rce-muted">{addReason}</p>}
      {!closedReason && role === "primary" && hasLead && technicianId && (
        <p className="mt-1 text-xs text-rce-muted">The current lead becomes a helper.</p>
      )}

      {notices.map((n) => (
        <p key={n.text} role={n.tone === "warn" ? "alert" : "status"} className={`mt-2 text-xs ${n.tone === "warn" ? "text-amber-700" : "text-green-700"}`}>
          {n.text}
        </p>
      ))}
      {failure && <p role="alert" className="mt-2 text-xs text-red-600">{failure.message}</p>}
    </div>
  );
}
