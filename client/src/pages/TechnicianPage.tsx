import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import { PageHeader } from "../components/PageHeader";
import { api, type PayrollEntry } from "../lib/api";
import { money } from "../lib/utils";

/**
 * One team member's pay week (Kyle, 2026-09-11).
 *
 * Two clocks, kept separate: the SHIFT clock is payroll, the JOB clock is job
 * time, and shift minus job is UNBILLED company overhead — drive, shop, supply
 * house — reported here and never charged to a customer.
 *
 * Overtime is automatic under federal FLSA: over 40 hours in the fixed Monday–
 * Sunday workweek at 1.5×, with the premium riding the hours that crossed 40 in
 * the order worked. Rates are typed, never defaulted: a member with no rate
 * contributes hours but NO cost, and this page says "rate not set" rather than
 * inventing a number. Every hour is editable with a reason, and the reason is
 * required by the server, not just by this form.
 */

const hm = (minutes: number | null | undefined) => {
  const m = Math.round(minutes ?? 0);
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
};

/** Local "YYYY-MM-DDTHH:mm" for a datetime-local input. */
function localInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const toIso = (local: string): string => new Date(local).toISOString();

/** Monday of the week containing `date`, as YYYY-MM-DD. */
function mondayOf(date: Date): string {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function TechnicianPage() {
  const { technicianId = "" } = useParams();
  const queryClient = useQueryClient();
  const [weekStart, setWeekStart] = useState(() => mondayOf(new Date()));

  const { data: technicians } = useQuery({ queryKey: ["technicians"], queryFn: api.technicians });
  const tech = useMemo(() => (technicians ?? []).find((t) => t.id === technicianId) ?? null, [technicians, technicianId]);

  const { data: week, isLoading } = useQuery({
    queryKey: ["payrollWeek", { technicianId, weekStart }],
    queryFn: () => api.payrollWeek(technicianId, new Date(`${weekStart}T12:00:00`).toISOString()),
    enabled: Boolean(technicianId),
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["payrollWeek"] });
    void queryClient.invalidateQueries({ queryKey: ["technicians"] });
  };

  const [rate, setRate] = useState<string>("");
  const [percent, setPercent] = useState<string>("");
  const [payEditing, setPayEditing] = useState(false);
  const savePay = useMutation({
    mutationFn: () =>
      api.updateTechnician(technicianId, {
        hourlyRate: rate.trim() === "" ? null : Number(rate),
        commissionPercent: percent.trim() === "" ? null : Number(percent),
      }),
    onSuccess: () => { setPayEditing(false); refresh(); },
  });

  const shiftDay = (n: number) => {
    const d = new Date(`${weekStart}T12:00:00`);
    d.setDate(d.getDate() + n);
    setWeekStart(mondayOf(d));
  };

  if (!technicianId) return null;

  return (
    <div>
      <PageHeader
        backTo="/team"
        backLabel="Team"
        title={tech?.name ?? week?.technicianName ?? "Team member"}
        subtitle="Pay week — shift hours, job hours, unbilled time, overtime and commissions"
      />

      {/* ── Pay (typed, never defaulted) ── */}
      <section className="card p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">Pay</h2>
          <button
            type="button"
            className="text-xs font-medium text-rce-accent"
            onClick={() => {
              setRate(tech?.hourlyRate != null ? String(tech.hourlyRate) : "");
              setPercent(tech?.commissionPercent != null ? String(tech.commissionPercent) : "");
              setPayEditing((v) => !v);
            }}
          >
            {payEditing ? "Cancel" : "Edit"}
          </button>
        </div>
        {payEditing ? (
          <form
            className="mt-3 flex flex-wrap items-end gap-3"
            onSubmit={(e) => { e.preventDefault(); savePay.mutate(); }}
          >
            <label className="text-sm font-medium">
              Hourly rate
              <input className="field mt-1 w-32" type="number" step="0.01" min="0" value={rate}
                onChange={(e) => setRate(e.target.value)} placeholder="not set" />
            </label>
            <label className="text-sm font-medium">
              Commission %
              <input className="field mt-1 w-32" type="number" step="0.1" min="0" max="100" value={percent}
                onChange={(e) => setPercent(e.target.value)} placeholder="not set" />
            </label>
            <button className="btn btn-primary text-xs" type="submit" disabled={savePay.isPending}>Save</button>
            <p className="w-full text-xs text-rce-muted">
              Leave a box empty to clear it. An empty rate is honest — hours still count, they just carry no cost.
            </p>
          </form>
        ) : (
          <p className="mt-2 text-sm">
            {tech?.hourlyRate != null
              ? <><span className="font-semibold">{money(tech.hourlyRate)}/hr</span></>
              : <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800">rate not set</span>}
            <span className="mx-2 text-rce-soft">·</span>
            {tech?.commissionPercent != null
              ? <span className="font-semibold">{tech.commissionPercent}% of job profit</span>
              : <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800">commission % not set</span>}
          </p>
        )}
        <p className="mt-2 text-xs text-rce-muted">
          Commission is a percentage of JOB PROFIT — revenue minus material minus fees (permits, inspections).
          Labor is not subtracted. A rate change takes effect going forward: hours already closed keep the rate
          they were paid at.
        </p>
      </section>

      {/* ── Week picker ── */}
      <section className="card mt-5 flex flex-wrap items-end gap-3 p-4">
        <button type="button" className="btn btn-secondary text-xs" onClick={() => shiftDay(-7)}>← Previous week</button>
        <label className="text-sm font-medium">
          Week of (Mon)
          <input className="field mt-1" type="date" value={weekStart}
            onChange={(e) => e.target.value && setWeekStart(mondayOf(new Date(`${e.target.value}T12:00:00`)))} />
        </label>
        <button type="button" className="btn btn-secondary text-xs" onClick={() => shiftDay(7)}>Next week →</button>
        <button type="button" className="btn btn-secondary text-xs" onClick={() => setWeekStart(mondayOf(new Date()))}>This week</button>
      </section>

      {isLoading && <p className="mt-4 text-sm text-rce-muted">Loading the week…</p>}

      {week && (
        <>
          {week.flagged.length > 0 && (
            <section className="card mt-5 border-red-300 bg-red-50 p-4">
              <h2 className="text-sm font-semibold text-red-800">
                {week.flagged.length} clock{week.flagged.length === 1 ? "" : "s"} ran past 12 hours and stopped counting
              </h2>
              <p className="mt-1 text-xs text-red-700">
                Nothing here counts toward hours or pay until someone says when it really ended.
              </p>
              <div className="mt-2 space-y-2">
                {week.flagged.map((f) => (
                  <ConfirmRow key={f.id} kind={f.kind} id={f.id} startedAt={f.startedAt} hoursOpen={f.hoursOpen} jobLabel={f.jobLabel} onDone={refresh} />
                ))}
              </div>
            </section>
          )}

          <section className="card mt-5 p-5">
            <h2 className="text-lg font-semibold">
              Week of {new Date(week.weekStart).toLocaleDateString()} – {new Date(week.weekEnd).toLocaleDateString()}
            </h2>
            <div className="mt-3 grid gap-3 text-sm md:grid-cols-4">
              <Stat label="Shift hours (payroll)" value={hm(week.shiftMinutes)} />
              <Stat label="On jobs" value={hm(week.jobMinutes)} />
              <Stat
                label="Unbilled (drive / shop / supply house)"
                value={hm(week.unbilledMinutes)}
                note="Company overhead — never charged to a customer"
              />
              <Stat label="Open entries" value={String(week.openEntries)} />
            </div>
            <div className="mt-3 grid gap-3 rounded-lg bg-rce-bg p-3 text-sm md:grid-cols-5">
              <Stat label="Regular" value={hm(week.regularMinutes)} />
              <Stat label="Overtime (1.5×)" value={hm(week.overtimeMinutes)} />
              <Stat label="Regular pay" value={week.rateSet || week.regularPay > 0 ? money(week.regularPay) : "rate not set"} />
              <Stat label="OT premium (the extra 0.5×)" value={money(week.overtimePremium)} />
              <Stat label="Commissions" value={money(week.commissions)} />
            </div>
            <p className="mt-3 text-base font-semibold">
              Week total {money(week.total)}
              {!week.rateSet && (
                <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-normal text-amber-800">
                  rate not set — hours counted, no labor cost
                </span>
              )}
            </p>
          </section>

          <EntryTable
            title="Payroll hours (shift clock)"
            kind="shift"
            entries={week.shifts}
            technicianId={technicianId}
            onChanged={refresh}
          />

          <EntryTable
            title="Job hours (job clock)"
            kind="job"
            entries={week.sessions}
            technicianId={technicianId}
            onChanged={refresh}
            readOnlyAdd
          />

          <section className="card mt-5 p-5">
            <h2 className="text-lg font-semibold">Commissions this week</h2>
            {week.commissionRows.length === 0 ? (
              <p className="mt-2 text-sm text-rce-muted">None recorded in this week.</p>
            ) : (
              <ul className="mt-3 space-y-2 text-sm">
                {week.commissionRows.map((c) => (
                  <li key={c.id} className="rounded-lg border border-rce-border p-3">
                    <span className="font-semibold">{money(c.amount)}</span>
                    {c.percent != null && <span className="ml-2 text-rce-muted">{c.percent}% of job profit</span>}
                    <span className="ml-2 text-xs text-rce-soft">
                      {c.visitLabel ?? "no job"} · {new Date(c.earnedAt).toLocaleDateString()}
                    </span>
                    {c.reason && <p className="text-xs text-rce-muted">Override reason: {c.reason}</p>}
                    {c.note && <p className="text-xs text-rce-muted">{c.note}</p>}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div>
      <span className="text-xs text-rce-soft">{label}</span>
      <p className="font-semibold">{value}</p>
      {note && <p className="text-[10px] text-rce-muted">{note}</p>}
    </div>
  );
}

/** Rule 5's answer from the office: close a flagged clock at the real end time. */
function ConfirmRow({
  kind, id, startedAt, hoursOpen, jobLabel, onDone,
}: { kind: "shift" | "job"; id: string; startedAt: string; hoursOpen: number; jobLabel?: string | null; onDone: () => void }) {
  const [endedAt, setEndedAt] = useState(localInput(startedAt));
  const [reason, setReason] = useState("");
  const confirm = useMutation({
    mutationFn: () => api.confirmTimeEntry({ kind, id, endedAt: toIso(endedAt), reason: reason.trim() }),
    onSuccess: onDone,
  });
  return (
    <form
      className="flex flex-wrap items-end gap-2 rounded-lg border border-red-200 bg-white p-3"
      onSubmit={(e) => { e.preventDefault(); if (reason.trim()) confirm.mutate(); }}
    >
      {/* Kyle, 2026-09-11: "it says job started but doesn't say which job." */}
      <span className="min-w-0 text-xs text-rce-muted">
        {jobLabel && <span className="block font-medium text-rce-text">{jobLabel}</span>}
        {kind === "shift" ? "Shift" : "Job"} started {new Date(startedAt).toLocaleString()} — {hoursOpen}h open
      </span>
      <label className="text-xs font-medium">
        Really ended
        <input className="field mt-1" type="datetime-local" value={endedAt} onChange={(e) => setEndedAt(e.target.value)} required />
      </label>
      <label className="text-xs font-medium">
        Reason
        <input className="field mt-1" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Forgot to clock out" required />
      </label>
      <button className="btn btn-primary text-xs" type="submit" disabled={confirm.isPending}>Confirm</button>
      {confirm.error && <p className="w-full text-xs text-red-600">{(confirm.error as Error).message}</p>}
    </form>
  );
}

function EntryTable({
  title, kind, entries, technicianId, onChanged, readOnlyAdd,
}: {
  title: string;
  kind: "shift" | "job";
  entries: PayrollEntry[];
  technicianId: string;
  onChanged: () => void;
  /** Job sessions are added on the JOB, which is where a job's hours belong. */
  readOnlyAdd?: boolean;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  return (
    <section className="card mt-5 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">{title}</h2>
        {!readOnlyAdd && (
          <button type="button" className="text-xs font-medium text-rce-accent" onClick={() => setAdding((v) => !v)}>
            {adding ? "Cancel" : "+ Add hours"}
          </button>
        )}
      </div>

      {adding && !readOnlyAdd && (
        <AddShiftForm technicianId={technicianId} onDone={() => { setAdding(false); onChanged(); }} />
      )}

      {entries.length === 0 ? (
        <p className="mt-3 text-sm text-rce-muted">Nothing on the clock this week.</p>
      ) : (
        <ul className="mt-3 space-y-2 text-sm">
          {entries.map((e) => (
            <li key={e.id} className="rounded-lg border border-rce-border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  <span className="font-medium">{new Date(e.startedAt).toLocaleDateString()}</span>
                  <span className="ml-2">
                    {new Date(e.startedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                    {" – "}
                    {e.endedAt ? new Date(e.endedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "running"}
                  </span>
                  <span className="ml-2 font-semibold">{hm(e.minutes)}</span>
                  {e.overtimeMinutes > 0 && (
                    <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800">
                      {hm(e.overtimeMinutes)} OT
                    </span>
                  )}
                  {e.rateApplied != null ? (
                    <span className="ml-2 text-xs text-rce-muted">{money(e.rateApplied)}/hr · {money(e.pay)}</span>
                  ) : (
                    e.endedAt && <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800">rate not set</span>
                  )}
                  {e.visitLabel && <span className="ml-2 text-xs text-rce-soft">{e.visitLabel}</span>}
                  {e.endedReason && <span className="ml-2 text-xs text-rce-soft">({e.endedReason.replaceAll("_", " ")})</span>}
                  {e.flagged && !e.confirmed && (
                    <span className="ml-2 rounded bg-red-100 px-1.5 py-0.5 text-xs text-red-700">flagged — not counted</span>
                  )}
                </span>
                <button
                  type="button"
                  className="text-xs font-medium text-rce-accent"
                  onClick={() => setEditingId(editingId === e.id ? null : e.id)}
                >
                  {editingId === e.id ? "Cancel" : "Edit"}
                </button>
              </div>
              {e.note && <p className="mt-1 text-xs text-rce-muted">{e.note}</p>}
              {editingId === e.id && (
                <EditEntryForm entry={e} kind={kind} onDone={() => { setEditingId(null); onChanged(); }} />
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function AddShiftForm({ technicianId, onDone }: { technicianId: string; onDone: () => void }) {
  const [startedAt, setStartedAt] = useState(localInput(new Date().toISOString()));
  const [endedAt, setEndedAt] = useState("");
  const [note, setNote] = useState("");
  const create = useMutation({
    mutationFn: () => api.createShiftEntry({
      technicianId,
      startedAt: toIso(startedAt),
      endedAt: endedAt ? toIso(endedAt) : null,
      note: note.trim() || null,
    }),
    onSuccess: onDone,
  });
  return (
    <form className="mt-3 flex flex-wrap items-end gap-2 rounded-lg bg-rce-bg p-3"
      onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
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

function EditEntryForm({ entry, kind, onDone }: { entry: PayrollEntry; kind: "shift" | "job"; onDone: () => void }) {
  const [startedAt, setStartedAt] = useState(localInput(entry.startedAt));
  const [endedAt, setEndedAt] = useState(localInput(entry.endedAt));
  const [reason, setReason] = useState("");
  const save = useMutation({
    mutationFn: () => {
      const patch = { startedAt: toIso(startedAt), endedAt: endedAt ? toIso(endedAt) : null, reason: reason.trim() };
      return kind === "shift" ? api.updateShiftEntry(entry.id, patch) : api.updateJobSession(entry.id, patch);
    },
    onSuccess: onDone,
  });
  const remove = useMutation({
    mutationFn: () => (kind === "shift" ? api.deleteShiftEntry(entry.id, reason.trim()) : api.deleteJobSession(entry.id, reason.trim())),
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
        onClick={() => { if (window.confirm("Delete this entry? The reason goes on the trail.")) remove.mutate(); }}
      >
        Delete
      </button>
      {(save.error || remove.error) && (
        <p className="w-full text-xs text-red-600">{((save.error ?? remove.error) as Error).message}</p>
      )}
    </form>
  );
}
