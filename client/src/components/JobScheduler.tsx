import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { MonthSchedule, ScheduleJobResult, TechDayAvailability } from "../lib/types";

interface Props {
  jobId: string;
  status: string;
  scheduledStart?: string | null;
  scheduledEnd?: string | null;
  durationDays?: number | null;
  /** Set once the consultation was closed out — swaps the card to its archived state. */
  completedAt?: string | null;
  /** Carries the booking result on a fresh schedule (so the caller can say whether the
      customer's confirmation went out); undefined on reschedule/cancel. */
  onScheduled?: (result?: ScheduleJobResult) => void;
  /** Open straight into the date picker — used when launched from Leads or Calendar. */
  autoOpen?: boolean;
}

/** Everything a booking touches. Kept in one place so no call site forgets one. */
const SCHEDULE_QUERY_KEYS = [["jobs"], ["visit"], ["leads"], ["calendar"], ["account"]];

// Fixed 2-hour estimate blocks — same set Savannah's check_availability offers
// so a slot picked in the CRM matches a slot picked over the phone. Kyle wants
// exactly these four, no free-form times, no odd windows like 3-5.
const ESTIMATE_BLOCKS = [
  { start: "08:00", end: "10:00", label: "8–10 AM" },
  { start: "10:00", end: "12:00", label: "10 AM–12 PM" },
  { start: "12:00", end: "14:00", label: "12–2 PM" },
  { start: "14:00", end: "16:00", label: "2–4 PM" },
] as const;

/** Business-hours start/end used to hide personal calendar events outside the workday. */
const BIZ_START_MIN = 8 * 60;
const BIZ_END_MIN = 16 * 60;

/** Central-Time "8:00 AM" / "5:30 PM" -> minutes since midnight, or null if unparseable. */
function ctLabelToMinutes(label: string): number | null {
  const m = label.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const minute = parseInt(m[2], 10);
  const isPm = m[3].toUpperCase() === "PM";
  if (isPm && hour !== 12) hour += 12;
  if (!isPm && hour === 12) hour = 0;
  return hour * 60 + minute;
}

/** Keep only busy blocks that overlap 8am–4pm CT — an unrelated 7pm event isn't a scheduling concern. */
function busyDuringBusinessHours(busy: TechDayAvailability["busy"]): TechDayAvailability["busy"] {
  return busy.filter((b) => {
    const s = ctLabelToMinutes(b.startLocal);
    const e = ctLabelToMinutes(b.endLocal);
    if (s == null || e == null) return true;
    return s < BIZ_END_MIN && e > BIZ_START_MIN;
  });
}

export function JobScheduler({ jobId, status, scheduledStart, scheduledEnd, durationDays, completedAt, onScheduled, autoOpen }: Props) {
  const queryClient = useQueryClient();
  // Consultations get marked completed and archived — signed estimates are
  // what become active jobs (Kyle, 2026-08-29).
  const completeConsultation = useMutation({
    mutationFn: () => api.completeConsultation(jobId),
    onSuccess: () => {
      for (const key of SCHEDULE_QUERY_KEYS) void queryClient.invalidateQueries({ queryKey: key });
      onScheduled?.();
    },
  });
  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth() + 1);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  // Estimates default to the first fixed block; production still uses a 7am
  // crew-start default because the durations aren't slot-shaped.
  const isEstimateVisit = status === "estimate";
  const [startTime, setStartTime] = useState(isEstimateVisit ? "08:00" : "07:00");
  const [technicianId, setTechnicianId] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"idle" | "schedule" | "reschedule" | "cancel">(
    autoOpen ? (scheduledStart ? "reschedule" : "schedule") : "idle",
  );

  const invalidateAll = () => {
    for (const key of SCHEDULE_QUERY_KEYS) queryClient.invalidateQueries({ queryKey: key });
  };

  const {
    data: schedule,
    isPending: scheduleLoading,
    isError: scheduleFailed,
    refetch: refetchSchedule,
  } = useQuery<MonthSchedule>({
    queryKey: ["schedule", "month", year, month],
    queryFn: () => api.monthSchedule(year, month),
    enabled: mode === "schedule" || mode === "reschedule",
  });

  // Per-tech availability for the chosen date + time. Estimates block 2h + 1h
  // travel; production is treated as the full day for conflict purposes.
  const durationMinutes = isEstimateVisit ? 180 : 600;
  const techQuery = useQuery<{ date: string; techs: TechDayAvailability[] }>({
    queryKey: ["tech-availability", selectedDate, startTime, durationMinutes],
    queryFn: () => api.techAvailability(selectedDate!, { start: startTime, durationMinutes }),
    enabled: (mode === "schedule" || mode === "reschedule") && !!selectedDate,
  });
  const techs = techQuery.data?.techs ?? [];

  const scheduleMutation = useMutation({
    mutationFn: () => api.scheduleJob(jobId, { startDate: selectedDate!, startTime, technicianId: technicianId ?? undefined }),
    onSuccess: (result) => {
      invalidateAll();
      setMode("idle");
      setSelectedDate(null);
      setTechnicianId(null);
      setError(null);
      onScheduled?.(result);
    },
    onError: (err: Error) => setError(err.message),
  });

  const rescheduleMutation = useMutation({
    mutationFn: () => api.rescheduleJob(jobId, { newStartDate: selectedDate!, newStartTime: startTime, reason }),
    onSuccess: () => {
      invalidateAll();
      setMode("idle");
      setSelectedDate(null);
      setReason("");
      setError(null);
      onScheduled?.();
    },
    onError: (err: Error) => setError(err.message),
  });

  const cancelMutation = useMutation({
    mutationFn: () => api.cancelJob(jobId, { reason }),
    onSuccess: () => {
      invalidateAll();
      setMode("idle");
      setReason("");
      setError(null);
      onScheduled?.();
    },
    onError: (err: Error) => setError(err.message),
  });

  // Booked-ness comes from scheduledStart, not status: an estimate visit stays at
  // status "estimate" once booked, because it hasn't become production work yet.
  const isScheduled = Boolean(scheduledStart);
  const canSchedule = !isScheduled && (status === "contracted" || status === "estimate");
  const canReschedule = isScheduled;
  const canCancel = isScheduled;

  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const DAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

  function prevMonth() {
    if (month === 1) { setYear(year - 1); setMonth(12); } else setMonth(month - 1);
    setSelectedDate(null);
  }
  function nextMonth() {
    if (month === 12) { setYear(year + 1); setMonth(1); } else setMonth(month + 1);
    setSelectedDate(null);
  }

  // Build grid
  const firstWeekday = schedule?.days[0]?.weekday ?? 0;
  const cells: Array<{ dayOfMonth: number; weekday: number; date: string; hasEvents: boolean } | null> = [];
  for (let i = 0; i < firstWeekday; i++) cells.push(null);
  for (const d of schedule?.days ?? []) {
    const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(d.dayOfMonth).padStart(2, "0")}`;
    cells.push({ dayOfMonth: d.dayOfMonth, weekday: d.weekday, date: dateStr, hasEvents: d.events.length > 0 });
  }

  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

  const formatScheduled = (iso: string) => new Date(iso).toLocaleDateString("en-US", {
    timeZone: "America/Chicago", weekday: "long", month: "long", day: "numeric", year: "numeric",
  });
  const formatTime = (iso: string) => new Date(iso).toLocaleTimeString("en-US", {
    timeZone: "America/Chicago", hour: "numeric", minute: "2-digit",
  });

  return (
    <div className="rounded-lg border border-rce-border bg-rce-bg p-4">
      <h3 className="mb-3 text-sm font-semibold">
        {isEstimateVisit ? "Estimate Appointment" : "Job Scheduling"}
      </h3>

      {/* A closed-out consultation shows its record, not a live booking. */}
      {isEstimateVisit && completedAt ? (
        <div className="mb-3 rounded-md border border-rce-border bg-rce-surface p-3 text-sm">
          <p className="font-medium text-rce-muted">Consultation completed</p>
          <p className="text-xs text-rce-soft">
            {formatScheduled(completedAt)} — archived. A signed estimate is what becomes an active job.
          </p>
        </div>
      ) : isScheduled && scheduledStart ? (
        <div className="mb-3 rounded-md bg-green-50 border border-green-200 p-3 text-sm">
          <p className="font-medium text-green-800">
            {isEstimateVisit ? "Estimate booked" : "Scheduled"}
          </p>
          <p className="text-green-700">
            {formatScheduled(scheduledStart)}
            {isEstimateVisit
              ? ` · ${formatTime(scheduledStart)}${scheduledEnd ? `–${formatTime(scheduledEnd)}` : ""}`
              : scheduledEnd && ` – ${formatScheduled(scheduledEnd)}`}
          </p>
          {isEstimateVisit
            ? <p className="text-green-600 text-xs">2 hr visit + 1 hr travel leeway</p>
            : durationDays ? <p className="text-green-600 text-xs">{durationDays} day(s)</p> : null}
          {/* The close-out Kyle asked for (2026-08-29): "This appointment has
              been completed and there is no way to close it out." */}
          {isEstimateVisit && (
            <button
              type="button"
              className="btn btn-secondary mt-2 text-xs"
              disabled={completeConsultation.isPending}
              onClick={() => completeConsultation.mutate()}
            >
              {completeConsultation.isPending ? "Completing…" : "Mark consultation complete"}
            </button>
          )}
        </div>
      ) : null}

      {/* Action buttons */}
      {mode === "idle" && (
        <div className="flex flex-wrap gap-2">
          {canSchedule && (
            <button onClick={() => setMode("schedule")} className="btn btn-primary text-sm">
              {isEstimateVisit ? "Book Estimate Visit" : "Schedule Work"}
            </button>
          )}
          {canReschedule && (
            <button onClick={() => setMode("reschedule")} className="btn btn-primary text-sm">
              Reschedule
            </button>
          )}
          {canCancel && (
            <button onClick={() => setMode("cancel")} className="rounded-lg border border-red-300 bg-red-50 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-100">
              Cancel Job
            </button>
          )}
          {!canSchedule && !canReschedule && !canCancel && (
            <p className="text-xs text-rce-muted">Not schedulable — status: {status}</p>
          )}
        </div>
      )}

      {/* Cancel mode */}
      {mode === "cancel" && (
        <div className="space-y-3">
          <p className="text-sm font-medium text-red-700">Cancel this job?</p>
          <input
            type="text"
            className="field w-full"
            placeholder="Reason for cancellation"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <div className="flex gap-2">
            <button
              onClick={() => cancelMutation.mutate()}
              disabled={!reason.trim() || cancelMutation.isPending}
              className="rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-40"
            >
              {cancelMutation.isPending ? "Cancelling..." : "Confirm Cancel"}
            </button>
            <button onClick={() => { setMode("idle"); setReason(""); setError(null); }} className="btn text-sm">
              Back
            </button>
          </div>
        </div>
      )}

      {/* Schedule / Reschedule mode — calendar picker */}
      {(mode === "schedule" || mode === "reschedule") && (
        <div className="space-y-3">
          <p className="text-sm font-medium">
            {mode === "schedule" ? "Pick a start date:" : "Pick a new start date:"}
          </p>
          {isEstimateVisit && (
            <p className="text-xs text-rce-muted">
              Books a 2-hour block plus an hour of travel leeway. The rest of the day
              stays open for production work.
            </p>
          )}

          {/* Month nav */}
          <div className="flex items-center justify-between">
            <button onClick={prevMonth} className="rounded px-2 py-1 text-xs hover:bg-rce-surface">&larr;</button>
            <span className="text-sm font-semibold">{MONTHS[month - 1]} {year}</span>
            <button onClick={nextMonth} className="rounded px-2 py-1 text-xs hover:bg-rce-surface">&rarr;</button>
          </div>

          {/* Grid — an empty month is always a failure, never a valid state, so
              say what happened instead of rendering headers over nothing. */}
          {scheduleFailed && (
            <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              Couldn't load the calendar.{" "}
              <button onClick={() => refetchSchedule()} className="font-medium underline">
                Try again
              </button>
            </div>
          )}
          {!scheduleFailed && scheduleLoading && (
            <p className="text-xs text-rce-muted animate-pulse">Loading calendar…</p>
          )}
          {!scheduleFailed && !scheduleLoading && (
          <div className="grid grid-cols-7 gap-px rounded border border-rce-border bg-rce-border overflow-hidden">
            {DAYS.map((d) => (
              <div key={d} className="bg-rce-surface py-1 text-center text-[10px] font-semibold text-rce-muted">{d}</div>
            ))}
            {cells.map((cell, i) => {
              if (!cell) return <div key={`e-${i}`} className="bg-white min-h-[32px]" />;
              const isPast = cell.date < todayStr;
              const isWeekend = cell.weekday === 0 || cell.weekday === 6;
              const isSel = cell.date === selectedDate;
              const isToday = cell.date === todayStr;

              return (
                <button
                  key={cell.date}
                  disabled={isPast || isWeekend}
                  onClick={() => setSelectedDate(isSel ? null : cell.date)}
                  className={`min-h-[32px] text-xs font-medium transition bg-white
                    ${isPast || isWeekend ? "text-rce-muted/40 cursor-not-allowed" : "hover:bg-rce-accentBg/30 cursor-pointer"}
                    ${isSel ? "!bg-rce-accent text-white" : ""}
                    ${isToday && !isSel ? "ring-1 ring-inset ring-rce-accent" : ""}
                  `}
                >
                  {cell.dayOfMonth}
                  {cell.hasEvents && !isSel && (
                    <span className="mx-auto mt-0.5 block h-1 w-1 rounded-full bg-rce-accent" />
                  )}
                </button>
              );
            })}
          </div>
          )}

          {/* Time + reason */}
          <div className="flex items-end gap-3">
            <div className="flex-1">
              <label className="block text-xs text-rce-muted mb-1">
                {isEstimateVisit ? "Start block" : "Start time"}
              </label>
              {isEstimateVisit ? (
                <div className="flex flex-wrap gap-1.5">
                  {ESTIMATE_BLOCKS.map((b) => {
                    const active = startTime === b.start;
                    return (
                      <button
                        key={b.start}
                        type="button"
                        onClick={() => setStartTime(b.start)}
                        className={`rounded-md border px-2.5 py-1 text-xs font-medium transition ${
                          active
                            ? "border-rce-accent bg-rce-accent text-white"
                            : "border-rce-border bg-white text-rce-fg hover:border-rce-accent/50"
                        }`}
                      >
                        {b.label}
                      </button>
                    );
                  })}
                </div>
              ) : (
                <input
                  type="time"
                  className="field"
                  value={startTime}
                  onChange={(e) => setStartTime(e.target.value)}
                />
              )}
            </div>
            {mode === "reschedule" && (
              <div className="flex-1">
                <label className="block text-xs text-rce-muted mb-1">Reason</label>
                <input
                  type="text"
                  className="field w-full"
                  placeholder="Reason for reschedule"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </div>
            )}
          </div>

          {/* Tech picker — who actually takes this appointment. Availability
              comes from each tech's own Google Calendar for the chosen date. */}
          {mode === "schedule" && selectedDate && (
            <div>
              <p className="mb-1 text-xs font-medium text-rce-muted">Assign technician</p>
              {techQuery.isPending && <p className="text-xs text-rce-muted animate-pulse">Checking tech calendars…</p>}
              {techQuery.isError && (
                <p className="text-xs text-red-600">Couldn't read tech calendars — you can still book without an assignment.</p>
              )}
              {!techQuery.isPending && !techQuery.isError && techs.length === 0 && (
                <p className="text-xs text-rce-muted">No technicians with calendar emails yet — add them in the Team tab.</p>
              )}
              <div className="space-y-1">
                {techs.map((tech) => {
                  const selected = technicianId === tech.technicianId;
                  // Filter out purely personal, out-of-hours events (e.g. a
                  // 7pm calendar block on the primary account) — they don't
                  // affect scheduling and were confusing to see next to a name.
                  const inHoursBusy = busyDuringBusinessHours(tech.busy);
                  const busyLabel = inHoursBusy.length > 0
                    ? inHoursBusy.map((b) => `${b.startLocal}–${b.endLocal}`).join(", ")
                    : "free all day";
                  return (
                    <button
                      key={tech.technicianId}
                      type="button"
                      onClick={() => setTechnicianId(selected ? null : tech.technicianId)}
                      className={`flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left text-sm transition ${
                        selected ? "border-rce-accent bg-rce-accentBg/40" : "border-rce-border bg-white hover:border-rce-accent/50"
                      }`}
                    >
                      <span className="font-medium">{tech.name}</span>
                      {!tech.calendarAccessible ? (
                        <span className="text-xs text-amber-600">calendar not shared — can't verify</span>
                      ) : tech.freeAtRequested === false ? (
                        <span className="text-xs text-red-600">busy: {busyLabel}</span>
                      ) : (
                        <span className="text-xs text-green-700">available · {busyLabel}</span>
                      )}
                    </button>
                  );
                })}
              </div>
              {technicianId && techs.find((t) => t.technicianId === technicianId)?.freeAtRequested === false && (
                <p className="mt-1 text-xs text-red-600">
                  Heads up — this tech has a conflict at that time. Booking anyway will double-book them.
                </p>
              )}
            </div>
          )}

          {/* Confirm */}
          <div className="flex gap-2">
            <button
              onClick={() => mode === "schedule" ? scheduleMutation.mutate() : rescheduleMutation.mutate()}
              disabled={
                !selectedDate ||
                (mode === "reschedule" && !reason.trim()) ||
                scheduleMutation.isPending ||
                rescheduleMutation.isPending
              }
              className="btn btn-primary text-sm disabled:opacity-40"
            >
              {(scheduleMutation.isPending || rescheduleMutation.isPending)
                ? "Saving..."
                : mode === "schedule"
                ? "Schedule"
                : "Reschedule"}
            </button>
            <button
              onClick={() => { setMode("idle"); setSelectedDate(null); setReason(""); setError(null); }}
              className="btn text-sm"
            >
              Back
            </button>
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <p className="mt-2 text-sm text-red-600">{error}</p>
      )}
    </div>
  );
}
