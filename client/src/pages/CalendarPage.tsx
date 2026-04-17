import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { MonthSchedule, AvailabilityResponse, CalendarEvent } from "../lib/types";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const DAY_HEADERS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function CalendarPage() {
  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth() + 1); // 1-indexed
  const [selectedDay, setSelectedDay] = useState<number | null>(null);

  const { data: schedule, isLoading } = useQuery<MonthSchedule>({
    queryKey: ["schedule", "month", year, month],
    queryFn: () => api.monthSchedule(year, month),
  });

  const { data: availability } = useQuery<AvailabilityResponse>({
    queryKey: ["schedule", "availability"],
    queryFn: () => api.calendarAvailability(),
  });

  const todayDay = today.getFullYear() === year && today.getMonth() + 1 === month ? today.getDate() : null;

  // Build calendar grid with leading empty cells
  const firstWeekday = schedule?.days[0]?.weekday ?? 0;
  const cells: Array<{ dayOfMonth: number; weekday: number; events: CalendarEvent[] } | null> = [];
  for (let i = 0; i < firstWeekday; i++) cells.push(null);
  for (const d of schedule?.days ?? []) cells.push(d);

  const selectedDayData = schedule?.days.find((d) => d.dayOfMonth === selectedDay);

  function prevMonth() {
    if (month === 1) { setYear(year - 1); setMonth(12); }
    else setMonth(month - 1);
    setSelectedDay(null);
  }
  function nextMonth() {
    if (month === 12) { setYear(year + 1); setMonth(1); }
    else setMonth(month + 1);
    setSelectedDay(null);
  }

  return (
    <div className="space-y-6">
      {/* Month Header */}
      <div className="flex items-center justify-between">
        <button onClick={prevMonth} className="rounded-lg border border-rce-border px-3 py-1.5 text-sm font-medium hover:bg-rce-bg">
          &larr; Prev
        </button>
        <h1 className="text-xl font-bold">
          {MONTH_NAMES[month - 1]} {year}
        </h1>
        <button onClick={nextMonth} className="rounded-lg border border-rce-border px-3 py-1.5 text-sm font-medium hover:bg-rce-bg">
          Next &rarr;
        </button>
      </div>

      {/* Calendar Grid */}
      {isLoading ? (
        <p className="text-rce-muted text-sm">Loading calendar...</p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-rce-border">
          {/* Day headers */}
          <div className="grid grid-cols-7 bg-rce-bg">
            {DAY_HEADERS.map((d) => (
              <div key={d} className="border-b border-rce-border px-2 py-2 text-center text-xs font-semibold text-rce-muted">
                {d}
              </div>
            ))}
          </div>
          {/* Day cells */}
          <div className="grid grid-cols-7">
            {cells.map((cell, i) => {
              if (!cell) {
                return <div key={`empty-${i}`} className="min-h-[72px] border-b border-r border-rce-border bg-rce-bg/50" />;
              }
              const isToday = cell.dayOfMonth === todayDay;
              const isSelected = cell.dayOfMonth === selectedDay;
              const hasEvents = cell.events.length > 0;
              const isWeekend = cell.weekday === 0 || cell.weekday === 6;

              return (
                <button
                  key={cell.dayOfMonth}
                  onClick={() => setSelectedDay(cell.dayOfMonth === selectedDay ? null : cell.dayOfMonth)}
                  className={`relative min-h-[72px] border-b border-r border-rce-border p-1.5 text-left transition hover:bg-rce-accentBg/30 ${
                    isSelected ? "bg-rce-accentBg/40 ring-2 ring-inset ring-rce-accent" : ""
                  } ${isWeekend ? "bg-rce-bg/40" : ""}`}
                >
                  <span
                    className={`inline-flex h-7 w-7 items-center justify-center rounded-full text-sm font-medium ${
                      isToday
                        ? "bg-rce-accent text-white"
                        : isWeekend
                        ? "text-rce-muted"
                        : "text-rce-text"
                    }`}
                  >
                    {cell.dayOfMonth}
                  </span>
                  {hasEvents && (
                    <div className="mt-0.5 space-y-0.5">
                      {cell.events.slice(0, 2).map((ev) => (
                        <div
                          key={ev.id}
                          className="truncate rounded bg-rce-accent/15 px-1 text-[10px] font-medium text-rce-accentDark"
                          title={ev.summary}
                        >
                          {ev.summary}
                        </div>
                      ))}
                      {cell.events.length > 2 && (
                        <div className="px-1 text-[10px] text-rce-muted">
                          +{cell.events.length - 2} more
                        </div>
                      )}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Selected Day Detail */}
      {selectedDayData && (
        <section className="rounded-lg border border-rce-border bg-rce-bg p-4">
          <h2 className="mb-3 text-base font-semibold">{selectedDayData.date}</h2>
          {selectedDayData.events.length === 0 ? (
            <p className="text-sm text-rce-muted">No events scheduled</p>
          ) : (
            <ul className="space-y-2">
              {selectedDayData.events.map((ev) => (
                <li key={ev.id} className="rounded-md bg-rce-surface p-3 shadow-sm">
                  <p className="font-medium">{ev.summary}</p>
                  <p className="text-sm text-rce-muted">
                    {ev.startLocal} – {ev.endLocal}
                  </p>
                  {ev.location && (
                    <p className="mt-0.5 text-sm text-rce-muted">{ev.location}</p>
                  )}
                  {ev.description && (
                    <p className="mt-1 text-xs text-rce-muted whitespace-pre-line">{ev.description}</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {/* AI Availability */}
      <section>
        <h2 className="mb-1 text-lg font-semibold">AI Availability View</h2>
        <p className="mb-3 text-xs text-rce-muted">
          This is exactly what Savannah and Jerry see when checking availability.
          {availability && ` Current time: ${availability.current_time_central}`}
        </p>
        {!availability ? (
          <p className="text-rce-muted text-sm">Loading availability...</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {availability.available_slots.map((day) => (
              <div key={day.date} className="rounded-lg border border-rce-border bg-rce-bg p-3">
                <h3 className="mb-2 text-sm font-semibold">{day.date}</h3>
                {day.slots.length === 0 ? (
                  <span className="inline-block rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">
                    Fully booked
                  </span>
                ) : (
                  <ul className="space-y-1">
                    {day.slots.map((slot, i) => (
                      <li key={i}>
                        <span className="inline-block rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800">
                          {slot.start} – {slot.end}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
