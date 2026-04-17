import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { WeekSchedule, AvailabilityResponse } from "../lib/types";

export function CalendarPage() {
  const { data: week, isLoading: weekLoading } = useQuery<WeekSchedule>({
    queryKey: ["schedule", "week"],
    queryFn: () => api.weekSchedule(),
  });

  const { data: availability, isLoading: availLoading } = useQuery<AvailabilityResponse>({
    queryKey: ["schedule", "availability"],
    queryFn: () => api.calendarAvailability(),
  });

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">Calendar</h1>

      {/* Week Schedule */}
      <section>
        <h2 className="mb-3 text-lg font-semibold">
          Week of {week?.weekOf ?? "..."}
        </h2>
        {weekLoading ? (
          <p className="text-rce-muted text-sm">Loading schedule...</p>
        ) : !week ? (
          <p className="text-rce-muted text-sm">Could not load schedule.</p>
        ) : (
          <div className="grid gap-3 md:grid-cols-5">
            {week.days.map((day) => (
              <div
                key={day.date}
                className="rounded-lg border border-rce-border bg-rce-bg p-3"
              >
                <h3 className="mb-2 text-sm font-semibold">{day.date}</h3>
                {day.events.length === 0 ? (
                  <p className="text-xs text-rce-muted">No events</p>
                ) : (
                  <ul className="space-y-1.5">
                    {day.events.map((ev) => (
                      <li
                        key={ev.id}
                        className="rounded-md bg-rce-surface p-2 text-xs"
                      >
                        <p className="font-medium">{ev.summary}</p>
                        <p className="text-rce-muted">
                          {ev.startLocal} – {ev.endLocal}
                        </p>
                        {ev.location && (
                          <p className="text-rce-muted truncate">{ev.location}</p>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Availability — what the AI sees */}
      <section>
        <h2 className="mb-1 text-lg font-semibold">AI Availability View</h2>
        <p className="mb-3 text-xs text-rce-muted">
          This is exactly what Savannah and Jerry see when checking availability.
          {availability && ` Current time: ${availability.current_time_central}`}
        </p>
        {availLoading ? (
          <p className="text-rce-muted text-sm">Loading availability...</p>
        ) : !availability ? (
          <p className="text-rce-muted text-sm">Could not load availability.</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {availability.available_slots.map((day) => (
              <div
                key={day.date}
                className="rounded-lg border border-rce-border bg-rce-bg p-3"
              >
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
