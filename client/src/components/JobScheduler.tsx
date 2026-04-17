import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { MonthSchedule } from "../lib/types";

interface Props {
  jobId: string;
  status: string;
  scheduledStart?: string | null;
  scheduledEnd?: string | null;
  durationDays?: number | null;
  onScheduled?: () => void;
}

export function JobScheduler({ jobId, status, scheduledStart, scheduledEnd, durationDays, onScheduled }: Props) {
  const queryClient = useQueryClient();
  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth() + 1);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [startTime, setStartTime] = useState("07:00");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"idle" | "schedule" | "reschedule" | "cancel">("idle");

  const { data: schedule } = useQuery<MonthSchedule>({
    queryKey: ["schedule", "month", year, month],
    queryFn: () => api.monthSchedule(year, month),
    enabled: mode === "schedule" || mode === "reschedule",
  });

  const scheduleMutation = useMutation({
    mutationFn: () => api.scheduleJob(jobId, { startDate: selectedDate!, startTime }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["jobs"] });
      queryClient.invalidateQueries({ queryKey: ["visit"] });
      setMode("idle");
      setSelectedDate(null);
      setError(null);
      onScheduled?.();
    },
    onError: (err: Error) => setError(err.message),
  });

  const rescheduleMutation = useMutation({
    mutationFn: () => api.rescheduleJob(jobId, { newStartDate: selectedDate!, reason }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["jobs"] });
      queryClient.invalidateQueries({ queryKey: ["visit"] });
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
      queryClient.invalidateQueries({ queryKey: ["jobs"] });
      queryClient.invalidateQueries({ queryKey: ["visit"] });
      setMode("idle");
      setReason("");
      setError(null);
      onScheduled?.();
    },
    onError: (err: Error) => setError(err.message),
  });

  const isScheduled = status === "scheduled";
  const isContracted = status === "contracted";
  const canSchedule = isContracted;
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

  return (
    <div className="rounded-lg border border-rce-border bg-rce-bg p-4">
      <h3 className="mb-3 text-sm font-semibold">Job Scheduling</h3>

      {/* Current status */}
      {isScheduled && scheduledStart && (
        <div className="mb-3 rounded-md bg-green-50 border border-green-200 p-3 text-sm">
          <p className="font-medium text-green-800">Scheduled</p>
          <p className="text-green-700">{formatScheduled(scheduledStart)}{scheduledEnd && ` – ${formatScheduled(scheduledEnd)}`}</p>
          {durationDays && <p className="text-green-600 text-xs">{durationDays} day(s)</p>}
        </div>
      )}

      {/* Action buttons */}
      {mode === "idle" && (
        <div className="flex flex-wrap gap-2">
          {canSchedule && (
            <button onClick={() => setMode("schedule")} className="btn btn-primary text-sm">
              Schedule Work
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
            <p className="text-xs text-rce-muted">
              {status === "estimate" ? "Job must be contracted before scheduling." : `Status: ${status}`}
            </p>
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

          {/* Month nav */}
          <div className="flex items-center justify-between">
            <button onClick={prevMonth} className="rounded px-2 py-1 text-xs hover:bg-rce-surface">&larr;</button>
            <span className="text-sm font-semibold">{MONTHS[month - 1]} {year}</span>
            <button onClick={nextMonth} className="rounded px-2 py-1 text-xs hover:bg-rce-surface">&rarr;</button>
          </div>

          {/* Grid */}
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

          {/* Time + reason */}
          <div className="flex items-end gap-3">
            <div>
              <label className="block text-xs text-rce-muted mb-1">Start time</label>
              <input
                type="time"
                className="field"
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
              />
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
