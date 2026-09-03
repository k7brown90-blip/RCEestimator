import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { JobScheduler } from "../components/JobScheduler";
import { Modal } from "../components/Modal";
import { PageHeader } from "../components/PageHeader";
import { api } from "../lib/api";
import type {
  AvailabilityResponse,
  CalendarAppointment,
  CalendarSchedule,
  ScheduleJobResult,
  UnscheduledJob,
} from "../lib/types";
import { money } from "../lib/utils";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const DAY_HEADERS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const TZ = "America/Chicago";

const APPOINTMENT_CLASS: Record<string, string> = {
  estimate: "bg-blue-100 text-blue-800",
  contracted: "bg-indigo-100 text-indigo-800",
  scheduled: "bg-rce-accent/20 text-rce-accentDark",
  in_progress: "bg-amber-100 text-amber-900",
  completed: "bg-green-100 text-green-800",
};

/** YYYY-MM-DD in Central, which is how the server keys the schedule. */
function dayKeyCT(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

const timeCT = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" });

const dateCT = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", {
    timeZone: TZ, weekday: "long", month: "long", day: "numeric",
  });

const pad = (n: number) => String(n).padStart(2, "0");

export function CalendarPage() {
  const queryClient = useQueryClient();
  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth() + 1);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [rescheduling, setRescheduling] = useState<CalendarAppointment | UnscheduledJob | null>(null);
  // What the booking just did — so "did the customer get a confirmation?" is answered on
  // screen instead of being invisible (Kyle, 2026-08-24: "Scheduling should also send a
  // confirmation to the customer").
  const [lastBooking, setLastBooking] = useState<ScheduleJobResult | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();

  const daysInMonth = new Date(year, month, 0).getDate();
  const rangeStart = `${year}-${pad(month)}-01`;
  const rangeEnd = `${year}-${pad(month)}-${pad(daysInMonth)}`;

  const { data: schedule, isLoading, error, refetch: refetchSchedule } = useQuery<CalendarSchedule>({
    queryKey: ["calendar", rangeStart, rangeEnd],
    queryFn: () => api.calendarSchedule(rangeStart, rangeEnd),
  });
  const scheduleParamRetried = useRef(false);

  const { data: availability } = useQuery<AvailabilityResponse>({
    queryKey: ["schedule", "availability"],
    queryFn: () => api.calendarAvailability(),
  });

  // Arrived from the signed screen with ?schedule=<jobId>: open the scheduler for that job
  // straight away. The param is consumed once — clearing it keeps back/refresh from
  // reopening a modal the user already dismissed.
  useEffect(() => {
    const scheduleId = searchParams.get("schedule");
    if (!scheduleId || !schedule) return;
    const job =
      schedule.unscheduled.find((j) => j.visitId === scheduleId) ??
      schedule.appointments.find((a) => a.visitId === scheduleId);
    if (job) {
      setRescheduling(job);
      setSearchParams({}, { replace: true });
    } else if (!scheduleParamRetried.current) {
      // A just-created visit (Book consultation -> here) can beat the rail:
      // react-query serves the cached month first, the visit isn't in it, and
      // the old code consumed the param anyway - so the scheduler never opened
      // (Kyle, 2026-09-03, Cecilia Pesavento). Refetch once and keep the param;
      // the effect re-runs on fresh data and opens the picker.
      scheduleParamRetried.current = true;
      void refetchSchedule();
    } else {
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, schedule, setSearchParams, refetchSchedule]);

  /** Appointments and unlinked Google events bucketed by Central calendar day. */
  const byDay = useMemo(() => {
    const map = new Map<string, { appointments: CalendarAppointment[]; googleEvents: CalendarSchedule["googleOnlyEvents"] }>();
    const bucket = (key: string) => {
      if (!map.has(key)) map.set(key, { appointments: [], googleEvents: [] });
      return map.get(key)!;
    };

    for (const appointment of schedule?.appointments ?? []) {
      // A multi-day job occupies every day it spans, not just its start.
      const start = dayKeyCT(appointment.scheduledStart);
      const end = appointment.scheduledEnd ? dayKeyCT(appointment.scheduledEnd) : start;
      const cursor = new Date(`${start}T12:00:00Z`);
      const last = new Date(`${end}T12:00:00Z`);
      while (cursor <= last) {
        bucket(cursor.toISOString().slice(0, 10)).appointments.push(appointment);
        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }
    }
    for (const event of schedule?.googleOnlyEvents ?? []) {
      bucket(dayKeyCT(event.start)).googleEvents.push(event);
    }
    return map;
  }, [schedule]);

  const firstWeekday = new Date(year, month - 1, 1).getDay();
  const cells: Array<string | null> = [
    ...Array.from({ length: firstWeekday }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => `${year}-${pad(month)}-${pad(i + 1)}`),
  ];

  const todayKey = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  const selectedData = selectedDate ? byDay.get(selectedDate) : undefined;

  function shiftMonth(delta: number) {
    const next = month + delta;
    if (next < 1) { setYear(year - 1); setMonth(12); }
    else if (next > 12) { setYear(year + 1); setMonth(1); }
    else setMonth(next);
    setSelectedDate(null);
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Calendar"
        subtitle="Appointments and job timelines — scheduling lives here"
      />

      <div className="flex items-center justify-between">
        <button onClick={() => shiftMonth(-1)} className="rounded-lg border border-rce-border px-3 py-1.5 text-sm font-medium hover:bg-rce-bg">
          &larr; Prev
        </button>
        <h2 className="text-xl font-bold">{MONTH_NAMES[month - 1]} {year}</h2>
        <button onClick={() => shiftMonth(1)} className="rounded-lg border border-rce-border px-3 py-1.5 text-sm font-medium hover:bg-rce-bg">
          Next &rarr;
        </button>
      </div>

      {error ? <p className="text-sm text-red-500">Error loading calendar: {error.message}</p> : null}

      {lastBooking && (
        <div className="rounded-md border border-green-200 bg-green-50 p-3 text-sm text-green-800">
          <strong>Scheduled.</strong>{" "}
          {lastBooking.customerNotified
            ? "A confirmation went to the customer."
            : "No confirmation went out — the customer has no email or phone on file."}
          <button className="ml-2 text-xs underline" onClick={() => setLastBooking(null)}>
            Dismiss
          </button>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_280px]">
        <div className="space-y-4">
          {isLoading ? (
            <p className="text-sm text-rce-muted">Loading calendar…</p>
          ) : (
            <div className="overflow-hidden rounded-lg border border-rce-border">
              <div className="grid grid-cols-7 bg-rce-bg">
                {DAY_HEADERS.map((d) => (
                  <div key={d} className="border-b border-rce-border px-2 py-2 text-center text-xs font-semibold text-rce-muted">
                    {d}
                  </div>
                ))}
              </div>
              <div className="grid grid-cols-7">
                {cells.map((dateKey, i) => {
                  if (!dateKey) {
                    return <div key={`empty-${i}`} className="min-h-[86px] border-b border-r border-rce-border bg-rce-bg/50" />;
                  }
                  const data = byDay.get(dateKey);
                  const appointments = data?.appointments ?? [];
                  const googleEvents = data?.googleEvents ?? [];
                  const dayOfMonth = Number(dateKey.slice(-2));
                  const weekday = new Date(year, month - 1, dayOfMonth).getDay();
                  const isWeekend = weekday === 0 || weekday === 6;

                  return (
                    <button
                      key={dateKey}
                      onClick={() => setSelectedDate(dateKey === selectedDate ? null : dateKey)}
                      className={`relative min-h-[86px] border-b border-r border-rce-border p-1.5 text-left align-top transition hover:bg-rce-accentBg/30 ${
                        dateKey === selectedDate ? "bg-rce-accentBg/40 ring-2 ring-inset ring-rce-accent" : ""
                      } ${isWeekend ? "bg-rce-bg/40" : ""}`}
                    >
                      <span
                        className={`inline-flex h-7 w-7 items-center justify-center rounded-full text-sm font-medium ${
                          dateKey === todayKey ? "bg-rce-accent text-white" : isWeekend ? "text-rce-muted" : "text-rce-text"
                        }`}
                      >
                        {dayOfMonth}
                      </span>
                      <div className="mt-0.5 space-y-0.5">
                        {appointments.slice(0, 2).map((appointment) => (
                          <div
                            key={appointment.visitId}
                            className={`flex items-center gap-1 truncate rounded px-1 text-[10px] font-medium ${
                              APPOINTMENT_CLASS[appointment.status] ?? "bg-zinc-200 text-zinc-700"
                            }`}
                            title={`${appointment.customerName} — ${appointment.address}`}
                          >
                            {appointment.confirmationStatus === "confirmed" && (
                              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" title="Confirmed" />
                            )}
                            <span className="truncate">
                              {appointment.appointmentKind === "estimate" ? "EST " : ""}
                              {timeCT(appointment.scheduledStart)} {appointment.customerName}
                            </span>
                          </div>
                        ))}
                        {googleEvents.slice(0, 1).map((event) => (
                          <div key={event.id} className="truncate rounded bg-zinc-100 px-1 text-[10px] italic text-zinc-500" title={event.summary}>
                            {event.summary}
                          </div>
                        ))}
                        {appointments.length + googleEvents.length > 3 && (
                          <div className="px-1 text-[10px] text-rce-muted">
                            +{appointments.length + googleEvents.length - 3} more
                          </div>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Day detail */}
          {selectedDate && (
            <section className="rounded-lg border border-rce-border bg-rce-bg p-4">
              <h3 className="mb-3 text-base font-semibold">{dateCT(`${selectedDate}T12:00:00Z`)}</h3>

              {(selectedData?.appointments.length ?? 0) === 0 && (selectedData?.googleEvents.length ?? 0) === 0 ? (
                <p className="text-sm text-rce-muted">Nothing scheduled.</p>
              ) : (
                <ul className="space-y-2">
                  {selectedData?.appointments.map((appointment) => (
                    <li key={appointment.visitId} className="rounded-md bg-rce-surface p-3 shadow-sm">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <Link to={`/visits/${appointment.visitId}`} className="font-medium hover:text-rce-accent">
                            {appointment.customerName}
                          </Link>
                          <p className="text-sm text-rce-muted">{appointment.address}</p>
                        </div>
                        <span className={`rounded px-2 py-0.5 text-xs font-semibold uppercase ${APPOINTMENT_CLASS[appointment.status] ?? "bg-zinc-200 text-zinc-700"}`}>
                          {appointment.appointmentKind === "estimate" ? "Estimate" : appointment.status.replaceAll("_", " ")}
                        </span>
                      </div>

                      <p className="mt-1 text-sm">
                        {timeCT(appointment.scheduledStart)}
                        {appointment.scheduledEnd && ` – ${timeCT(appointment.scheduledEnd)}`}
                        {appointment.travelBufferMinutes > 0 && (
                          <span className="text-rce-muted"> (+{appointment.travelBufferMinutes} min travel)</span>
                        )}
                        {appointment.estimatedDurationDays && appointment.estimatedDurationDays > 1 && (
                          <span className="text-rce-muted"> · {appointment.estimatedDurationDays}-day job</span>
                        )}
                      </p>

                      <p className="mt-1 text-xs text-rce-muted">
                        {appointment.jobType || appointment.purpose || "No job type set"}
                        {appointment.estimateTotal != null && ` · ${money(appointment.estimateTotal)}`}
                        {appointment.technicians.length > 0 && ` · ${appointment.technicians.map((t) => t.name).join(", ")}`}
                      </p>

                      <p className="mt-1 text-xs">
                        <span className={appointment.confirmationStatus === "confirmed" ? "text-rce-success" : "text-rce-muted"}>
                          {appointment.confirmationStatus === "confirmed" ? "Customer confirmed" : "Awaiting customer confirmation"}
                        </span>
                      </p>

                      <div className="mt-2 flex gap-2">
                        <button type="button" className="btn btn-secondary text-xs" onClick={() => setRescheduling(appointment)}>
                          Reschedule / Cancel
                        </button>
                      </div>
                    </li>
                  ))}

                  {selectedData?.googleEvents.map((event) => (
                    <li key={event.id} className="rounded-md border border-dashed border-rce-border bg-rce-surface/60 p-3">
                      <p className="font-medium text-rce-muted">{event.summary}</p>
                      <p className="text-sm text-rce-muted">{event.startLocal} – {event.endLocal}</p>
                      {event.location && <p className="text-sm text-rce-muted">{event.location}</p>}
                      <p className="mt-1 text-xs italic text-rce-soft">Google calendar — no linked job</p>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </div>

        {/* Needs-scheduling rail (reworked 2026-09-02 — Kyle: "the 'jobs need
            scheduling' on the calendar are not jobs at all"). SOLD JOBS lead:
            every card in that group has a signed estimate behind it. The lead
            pipe — consultation and estimate visits — keeps its own section
            under its own name, never dressed as production work. */}
        <aside className="space-y-2">
          <h3 className="text-sm font-semibold">Sold jobs — ready to schedule</h3>
          <p className="text-xs text-rce-muted">Signed, deposit in, no appointment yet.</p>
          {(schedule?.unscheduled ?? []).filter((j) => j.status === "contracted" && j.depositSatisfied).map((job) => (
            <div key={job.visitId} className="rounded-lg border border-rce-border bg-rce-bg p-3">
              <Link to={`/visits/${job.visitId}`} className="text-sm font-medium hover:text-rce-accent">
                {job.customerName}
              </Link>
              <p className="text-xs text-rce-muted">{job.address}</p>
              <p className="mt-1 text-xs text-rce-soft">
                Sold job{job.jobType ? ` · ${job.jobType}` : ""}{job.purpose ? ` · ${job.purpose}` : ""}
              </p>
              <button
                type="button"
                className="btn btn-primary mt-2 w-full text-xs"
                onClick={() => setRescheduling(job)}
              >
                Schedule
              </button>
            </div>
          ))}
          {(schedule?.unscheduled ?? []).filter((j) => j.status === "contracted" && j.depositSatisfied).length === 0 && !isLoading && (
            <p className="text-xs text-rce-muted">No sold jobs waiting.</p>
          )}

          {(schedule?.unscheduled ?? []).some((j) => j.status === "contracted" && !j.depositSatisfied) && (
            <>
              <h3 className="pt-3 text-sm font-semibold">Signed — awaiting deposit</h3>
              <p className="text-xs text-rce-muted">Sold, but the deposit gate is not open yet. Collect it, then schedule.</p>
              {(schedule?.unscheduled ?? []).filter((j) => j.status === "contracted" && !j.depositSatisfied).map((job) => (
                <div key={job.visitId} className="rounded-lg border border-amber-300/70 bg-rce-bg p-3">
                  <Link to={`/accounts/${job.customerId}`} className="text-sm font-medium hover:text-rce-accent">
                    {job.customerName}
                  </Link>
                  <p className="text-xs text-rce-muted">{job.address}</p>
                  <p className="mt-1 text-xs text-amber-800">Deposit unpaid — Take payment lives on the account's invoice.</p>
                </div>
              ))}
            </>
          )}

          <h3 className="pt-3 text-sm font-semibold">Estimate visits to book</h3>
          <p className="text-xs text-rce-muted">Consultations from the lead pipe — not sold work.</p>
          {(schedule?.unscheduled ?? []).filter((j) => j.status !== "contracted").map((job) => (
            <div key={job.visitId} className="rounded-lg border border-rce-border/60 bg-rce-bg p-3">
              <Link to={`/visits/${job.visitId}`} className="text-sm font-medium hover:text-rce-accent">
                {job.customerName}
              </Link>
              <p className="text-xs text-rce-muted">{job.address}</p>
              <p className="mt-1 text-xs text-rce-soft">
                Estimate visit{job.jobType ? ` · ${job.jobType}` : ""}{job.purpose ? ` · ${job.purpose}` : ""}
              </p>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  className="btn btn-secondary flex-1 text-xs"
                  onClick={() => setRescheduling(job)}
                >
                  Book the visit
                </button>
                <button
                  type="button"
                  className="btn text-xs text-rce-muted"
                  title="Not needed — removes it from this list"
                  onClick={() => {
                    void api.archiveVisit(job.visitId).then(() => {
                      void queryClient.invalidateQueries({ queryKey: ["calendar"] });
                      void queryClient.invalidateQueries({ queryKey: ["schedule"] });
                    });
                  }}
                >
                  Archive
                </button>
              </div>
            </div>
          ))}
          {(schedule?.unscheduled ?? []).filter((j) => j.status !== "contracted").length === 0 && !isLoading && (
            <p className="text-xs text-rce-muted">None waiting.</p>
          )}
        </aside>
      </div>

      {/* AI Availability */}
      <section>
        <h2 className="mb-1 text-lg font-semibold">AI Availability View</h2>
        <p className="mb-3 text-xs text-rce-muted">
          This is exactly what Savannah and Jerry see when checking availability.
          {availability && ` Current time: ${availability.current_time_central}`}
        </p>
        {!availability ? (
          <p className="text-sm text-rce-muted">Loading availability…</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {availability.available_slots.map((day) => (
              <div key={day.date} className="rounded-lg border border-rce-border bg-rce-bg p-3">
                <h3 className="mb-2 text-sm font-semibold">{day.date}</h3>
                <ul className="space-y-1">
                  {day.slots.map((slot, i) => (
                    <li key={i}>
                      <span className="inline-block rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800">
                        {slot.start} – {slot.end}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>

      {rescheduling && (
        <Modal
          title={rescheduling.customerName}
          subtitle={rescheduling.address}
          onClose={() => setRescheduling(null)}
        >
          <JobScheduler
            autoOpen
            jobId={rescheduling.visitId}
            status={rescheduling.status}
            scheduledStart={"scheduledStart" in rescheduling ? rescheduling.scheduledStart : null}
            scheduledEnd={"scheduledEnd" in rescheduling ? rescheduling.scheduledEnd : null}
            durationDays={rescheduling.estimatedDurationDays}
            onScheduled={(result) => {
              setRescheduling(null);
              setLastBooking(result ?? null);
            }}
          />
        </Modal>
      )}
    </div>
  );
}
