/**
 * The one door to scheduling (2026-10-01, plan item E3).
 *
 * Kyle: "There are multiple scheduling points and that needs to all be done on the calendar
 * page." The Calendar page is the only place a date is chosen — its month grid IS the picker
 * (CalendarPage.tsx, PUNCHLIST C9). Every other surface that used to host its own
 * `JobScheduler` now shows a button that lands here with the job already selected, which is
 * the same `/calendar?schedule=<visitId>` instruction "Book consultation", "Create job &
 * schedule", the follow-up queue and the in-person signing page have used since 2026-08-24.
 *
 * The path and the labels live together so a drawer and a page never disagree about what the
 * button says or where it goes.
 */

export function scheduleDoorPath(visitId: string): string {
  return `/calendar?schedule=${encodeURIComponent(visitId)}`;
}

/** What the door reads, in the words an operator would say out loud. */
export function scheduleDoorLabel(status: string, scheduledStart: string | null | undefined): string {
  if (scheduledStart) return "Reschedule or cancel on the Calendar";
  return status === "estimate" ? "Book on the Calendar" : "Schedule on the Calendar";
}

/** The statuses the Calendar's rail lists and the scheduler will book (app.ts /crm/schedule/calendar). */
export function canReachScheduler(status: string, scheduledStart: string | null | undefined): boolean {
  if (scheduledStart) return true;
  return status === "estimate" || status === "contracted";
}
