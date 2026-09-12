import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api, type PayrollEntry } from "../lib/api";
import { money } from "../lib/utils";

/**
 * A job's own hours (Kyle, 2026-09-11).
 *
 * The JOB clock only — arrive-to-leave sessions. Shift hours that never landed
 * on a job are UNBILLED company overhead and live on the Team tab, not here:
 * they are never charged to a customer.
 *
 * Every session is editable with a reason, and the reason is required by the
 * server. Rates are frozen on the session when it closed, so a later raise
 * never rewrites what this job cost; a session whose tech had no rate on file
 * says "rate not set" rather than showing $0.
 */

const hm = (minutes: number | null | undefined) => {
  const m = Math.round(minutes ?? 0);
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
};
function localInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const toIso = (local: string): string => new Date(local).toISOString();

export function JobTimePanel({ visitId }: { visitId: string }) {
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const { data } = useQuery({ queryKey: ["jobTime", visitId], queryFn: () => api.jobTime(visitId) });
  const { data: technicians } = useQuery({ queryKey: ["technicians"], queryFn: api.technicians });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["jobTime", visitId] });
    void queryClient.invalidateQueries({ queryKey: ["jobs"] });
    void queryClient.invalidateQueries({ queryKey: ["visit", visitId] });
  };

  if (!data) return null;

  return (
    <article className="card rounded-2xl border border-rce-border/70 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Time on this job</h2>
        <button type="button" className="text-xs font-medium text-rce-accent" onClick={() => setAdding((v) => !v)}>
          {adding ? "Cancel" : "+ Add hours"}
        </button>
      </div>
      <p className="mt-1 text-sm text-rce-muted">
        {hm(data.totalMinutes)} on the job ({data.totalHours}h)
        {data.laborCost != null && <> · labor {money(data.laborCost)}</>}
        {data.anyRateMissing && (
          <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800">
            some hours have no rate set
          </span>
        )}
      </p>
      <p className="mt-1 text-xs text-rce-muted">
        Job hours only. Drive, shop and supply-house time is unbilled company overhead and sits on the
        team member's pay week.
      </p>

      {adding && (
        <AddSessionForm
          visitId={visitId}
          technicians={(technicians ?? []).filter((t) => t.isActive).map((t) => ({ id: t.id, name: t.name }))}
          onDone={() => { setAdding(false); refresh(); }}
        />
      )}

      {data.technicians.length > 0 && (
        <ul className="mt-3 space-y-1 text-sm">
          {data.technicians.map((t) => (
            <li key={t.technicianId} className="flex flex-wrap items-center gap-2">
              <Link to={`/team/${t.technicianId}`} className="font-medium hover:text-rce-accent">{t.name}</Link>
              <span className="text-rce-muted">{t.hours}h</span>
              {t.rateSet ? (
                <span className="text-xs text-rce-soft">{money(t.rate)}/hr{t.cost != null && ` · ${money(t.cost)}`}</span>
              ) : (
                <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800">rate not set</span>
              )}
              {!t.assigned && <span className="text-xs text-rce-soft">(not currently assigned)</span>}
            </li>
          ))}
        </ul>
      )}

      {data.sessions.length === 0 ? (
        <p className="mt-3 text-sm text-rce-muted">No sessions recorded on this job yet.</p>
      ) : (
        <ul className="mt-3 space-y-2 text-sm">
          {data.sessions.map((s) => (
            <li key={s.id} className="rounded-lg border border-rce-border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  <span className="font-medium">{new Date(s.startedAt).toLocaleDateString()}</span>
                  <span className="ml-2">
                    {new Date(s.startedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                    {" – "}
                    {s.endedAt ? new Date(s.endedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "running"}
                  </span>
                  <span className="ml-2 font-semibold">{hm(s.minutes)}</span>
                  {s.visitLabel && <span className="ml-2 text-xs text-rce-soft">{s.visitLabel}</span>}
                  {s.rateApplied != null ? (
                    <span className="ml-2 text-xs text-rce-muted">{money(s.rateApplied)}/hr · {money(s.pay)}</span>
                  ) : (
                    s.endedAt && <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800">rate not set</span>
                  )}
                  {s.endedReason && <span className="ml-2 text-xs text-rce-soft">({s.endedReason.replaceAll("_", " ")})</span>}
                  {s.flagged && !s.confirmed && (
                    <span className="ml-2 rounded bg-red-100 px-1.5 py-0.5 text-xs text-red-700">flagged — not counted</span>
                  )}
                </span>
                <button
                  type="button"
                  className="text-xs font-medium text-rce-accent"
                  onClick={() => setEditingId(editingId === s.id ? null : s.id)}
                >
                  {editingId === s.id ? "Cancel" : "Edit"}
                </button>
              </div>
              {s.note && <p className="mt-1 text-xs text-rce-muted">{s.note}</p>}
              {editingId === s.id && (
                <EditSessionForm session={s} onDone={() => { setEditingId(null); refresh(); }} />
              )}
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

function AddSessionForm({
  visitId, technicians, onDone,
}: { visitId: string; technicians: Array<{ id: string; name: string }>; onDone: () => void }) {
  const [technicianId, setTechnicianId] = useState(technicians[0]?.id ?? "");
  const [startedAt, setStartedAt] = useState(localInput(new Date().toISOString()));
  const [endedAt, setEndedAt] = useState("");
  const [note, setNote] = useState("");
  const create = useMutation({
    mutationFn: () => api.createJobSession(visitId, {
      technicianId,
      startedAt: toIso(startedAt),
      endedAt: endedAt ? toIso(endedAt) : null,
      note: note.trim() || null,
    }),
    onSuccess: onDone,
  });
  return (
    <form className="mt-3 flex flex-wrap items-end gap-2 rounded-lg bg-rce-bg p-3"
      onSubmit={(e) => { e.preventDefault(); if (technicianId) create.mutate(); }}>
      <label className="text-xs font-medium">
        Who
        <select className="field mt-1" value={technicianId} onChange={(e) => setTechnicianId(e.target.value)} required>
          {technicians.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </label>
      <label className="text-xs font-medium">
        Started
        <input className="field mt-1" type="datetime-local" value={startedAt} onChange={(e) => setStartedAt(e.target.value)} required />
      </label>
      <label className="text-xs font-medium">
        Ended
        <input className="field mt-1" type="datetime-local" value={endedAt} onChange={(e) => setEndedAt(e.target.value)} />
      </label>
      <label className="text-xs font-medium">
        Note
        <input className="field mt-1" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why this was entered by hand" />
      </label>
      <button className="btn btn-primary text-xs" type="submit" disabled={create.isPending}>Add</button>
      {create.error && <p className="w-full text-xs text-red-600">{(create.error as Error).message}</p>}
    </form>
  );
}

function EditSessionForm({ session, onDone }: { session: PayrollEntry; onDone: () => void }) {
  const [startedAt, setStartedAt] = useState(localInput(session.startedAt));
  const [endedAt, setEndedAt] = useState(localInput(session.endedAt));
  const [reason, setReason] = useState("");
  const save = useMutation({
    mutationFn: () => api.updateJobSession(session.id, {
      startedAt: toIso(startedAt),
      endedAt: endedAt ? toIso(endedAt) : null,
      reason: reason.trim(),
    }),
    onSuccess: onDone,
  });
  const remove = useMutation({
    mutationFn: () => api.deleteJobSession(session.id, reason.trim()),
    onSuccess: onDone,
  });
  return (
    <form className="mt-2 flex flex-wrap items-end gap-2 rounded-lg bg-rce-bg p-3"
      onSubmit={(e) => { e.preventDefault(); if (reason.trim()) save.mutate(); }}>
      <label className="text-xs font-medium">
        Started
        <input className="field mt-1" type="datetime-local" value={startedAt} onChange={(e) => setStartedAt(e.target.value)} required />
      </label>
      <label className="text-xs font-medium">
        Ended
        <input className="field mt-1" type="datetime-local" value={endedAt} onChange={(e) => setEndedAt(e.target.value)} />
      </label>
      <label className="text-xs font-medium">
        Reason (required)
        <input className="field mt-1" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why the hours changed" required />
      </label>
      <button className="btn btn-primary text-xs" type="submit" disabled={save.isPending}>Save</button>
      <button
        type="button"
        className="btn btn-danger text-xs"
        disabled={remove.isPending || !reason.trim()}
        onClick={() => { if (window.confirm("Delete this session? The reason goes on the trail.")) remove.mutate(); }}
      >
        Delete
      </button>
      {(save.error || remove.error) && (
        <p className="w-full text-xs text-red-600">{((save.error ?? remove.error) as Error).message}</p>
      )}
    </form>
  );
}
