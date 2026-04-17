/**
 * Schedule service — reads Google Calendar events and maps them to CRM jobs.
 * Used by /api/schedule/* endpoints and the daily SMS digest.
 */

import { google } from "googleapis";

const TZ = "America/Chicago";

function getCalendarClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("Missing Google Calendar credentials.");
  }

  const auth = new google.auth.OAuth2(clientId, clientSecret);
  auth.setCredentials({ refresh_token: refreshToken });
  return google.calendar({ version: "v3", auth });
}

export interface CalendarEvent {
  id: string;
  summary: string;
  description: string | null;
  start: string;     // ISO string
  end: string;       // ISO string
  startLocal: string; // formatted CT
  endLocal: string;
  location: string | null;
}

function formatCT(d: Date): string {
  return d.toLocaleString("en-US", {
    timeZone: TZ,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatTimeCT(d: Date): string {
  return d.toLocaleTimeString("en-US", {
    timeZone: TZ,
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatDateCT(d: Date): string {
  return d.toLocaleDateString("en-US", {
    timeZone: TZ,
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

function startOfDayCT(d: Date): Date {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);

  const get = (t: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === t)!.value);

  // Approximate: assume UTC-6 (CST), then adjust
  const guess = new Date(Date.UTC(get("year"), get("month") - 1, get("day"), 6));
  const actual = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hour: "2-digit",
    hour12: false,
  }).formatToParts(guess);
  const gotHour = Number(actual.find((p) => p.type === "hour")!.value);
  return new Date(guess.getTime() - gotHour * 60 * 60_000);
}

function endOfDayCT(d: Date): Date {
  return new Date(startOfDayCT(d).getTime() + 24 * 60 * 60_000);
}

/** Get calendar events for today in Central Time */
export async function getTodaySchedule(): Promise<{ date: string; events: CalendarEvent[] }> {
  const now = new Date();
  const dayStart = startOfDayCT(now);
  const dayEnd = endOfDayCT(now);

  return getEventsForRange(dayStart, dayEnd, formatDateCT(now));
}

/** Get calendar events for the current week (Mon–Fri) in Central Time */
export async function getWeekSchedule(): Promise<{ weekOf: string; days: Array<{ date: string; events: CalendarEvent[] }> }> {
  const now = new Date();

  // Find this Monday
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    weekday: "short",
  }).formatToParts(now);
  const wdStr = parts.find((p) => p.type === "weekday")!.value;
  const wdMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const wd = wdMap[wdStr] ?? 0;
  const daysToMon = wd === 0 ? 6 : wd - 1; // Sunday wraps to previous Monday

  const monStart = startOfDayCT(new Date(now.getTime() - daysToMon * 86_400_000));
  const friEnd = new Date(monStart.getTime() + 5 * 86_400_000);

  const calendar = getCalendarClient();

  const response = await calendar.events.list({
    calendarId: "primary",
    timeMin: monStart.toISOString(),
    timeMax: friEnd.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
  });

  const events = (response.data.items ?? []).map(mapEvent);

  // Group by day
  const days: Array<{ date: string; events: CalendarEvent[] }> = [];
  for (let i = 0; i < 5; i++) {
    const dayDate = new Date(monStart.getTime() + i * 86_400_000);
    const dayEnd = new Date(dayDate.getTime() + 86_400_000);
    const dayEvents = events.filter((e) => {
      const s = new Date(e.start);
      return s >= dayDate && s < dayEnd;
    });

    days.push({
      date: formatDateCT(dayDate),
      events: dayEvents,
    });
  }

  return {
    weekOf: formatDateCT(monStart),
    days,
  };
}

/** Get calendar events for an entire month */
export async function getMonthSchedule(year: number, month: number): Promise<{
  year: number;
  month: number;
  days: Array<{ date: string; dayOfMonth: number; weekday: number; events: CalendarEvent[] }>;
}> {
  const calendar = getCalendarClient();

  // First and last day of the month in CT
  const firstDay = new Date(Date.UTC(year, month - 1, 1, 12)); // noon UTC to avoid boundary issues
  const rangeStart = startOfDayCT(firstDay);
  const lastDayNum = new Date(year, month, 0).getDate(); // days in this month
  const lastDay = new Date(Date.UTC(year, month - 1, lastDayNum, 12));
  const rangeEnd = endOfDayCT(lastDay);

  const response = await calendar.events.list({
    calendarId: "primary",
    timeMin: rangeStart.toISOString(),
    timeMax: rangeEnd.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
  });

  const events = (response.data.items ?? []).map(mapEvent);

  const days: Array<{ date: string; dayOfMonth: number; weekday: number; events: CalendarEvent[] }> = [];
  for (let d = 1; d <= lastDayNum; d++) {
    const dayDate = new Date(Date.UTC(year, month - 1, d, 12));
    const dayStart = startOfDayCT(dayDate);
    const dayEndDt = endOfDayCT(dayDate);

    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: TZ,
      weekday: "short",
    }).formatToParts(dayDate);
    const wdStr = parts.find((p) => p.type === "weekday")!.value;
    const wdMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

    const dayEvents = events.filter((e) => {
      const s = new Date(e.start);
      return s >= dayStart && s < dayEndDt;
    });

    days.push({
      date: formatDateCT(dayDate),
      dayOfMonth: d,
      weekday: wdMap[wdStr] ?? 0,
      events: dayEvents,
    });
  }

  return { year, month, days };
}

/** Get next day's schedule — used for Kyle's daily SMS digest */
export async function getNextDaySchedule(): Promise<{ date: string; events: CalendarEvent[] }> {
  const tomorrow = new Date(Date.now() + 86_400_000);
  const dayStart = startOfDayCT(tomorrow);
  const dayEnd = endOfDayCT(tomorrow);

  return getEventsForRange(dayStart, dayEnd, formatDateCT(tomorrow));
}

/** Create a calendar event (block time) */
export async function createCalendarEvent(input: {
  summary: string;
  description?: string;
  location?: string;
  startTime: Date;
  endTime: Date;
}): Promise<CalendarEvent> {
  const calendar = getCalendarClient();

  const response = await calendar.events.insert({
    calendarId: "primary",
    requestBody: {
      summary: input.summary,
      description: input.description,
      location: input.location,
      start: { dateTime: input.startTime.toISOString(), timeZone: TZ },
      end: { dateTime: input.endTime.toISOString(), timeZone: TZ },
    },
  });

  return mapEvent(response.data);
}

/** Delete a calendar event */
export async function deleteCalendarEvent(eventId: string): Promise<void> {
  const calendar = getCalendarClient();
  await calendar.events.delete({ calendarId: "primary", eventId });
}

/** Move/reschedule a calendar event */
export async function moveCalendarEvent(eventId: string, newStart: Date, newEnd: Date): Promise<CalendarEvent> {
  const calendar = getCalendarClient();

  const response = await calendar.events.patch({
    calendarId: "primary",
    eventId,
    requestBody: {
      start: { dateTime: newStart.toISOString(), timeZone: TZ },
      end: { dateTime: newEnd.toISOString(), timeZone: TZ },
    },
  });

  return mapEvent(response.data);
}

// ── Internal helpers ─────────────────────────────────────────────────────────

async function getEventsForRange(
  start: Date,
  end: Date,
  dateLabel: string,
): Promise<{ date: string; events: CalendarEvent[] }> {
  const calendar = getCalendarClient();

  const response = await calendar.events.list({
    calendarId: "primary",
    timeMin: start.toISOString(),
    timeMax: end.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
  });

  return {
    date: dateLabel,
    events: (response.data.items ?? []).map(mapEvent),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapEvent(e: any): CalendarEvent {
  const startDt = e.start?.dateTime ?? e.start?.date ?? "";
  const endDt = e.end?.dateTime ?? e.end?.date ?? "";
  const startDate = new Date(startDt);
  const endDate = new Date(endDt);

  return {
    id: e.id ?? "",
    summary: e.summary ?? "(no title)",
    description: e.description ?? null,
    start: startDt,
    end: endDt,
    startLocal: formatCT(startDate),
    endLocal: formatTimeCT(endDate),
    location: e.location ?? null,
  };
}

// ─── AVAILABILITY CHECKING (used by scheduling endpoints) ───────────────────────

export interface AvailabilityCheckResult {
  available: boolean;
  conflicts: Array<{ date: string; reason: string }>;
}

function getCTParts(d: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
  }).formatToParts(d);

  const get = (t: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === t)!.value);

  const wdMap: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  const wdStr = parts.find((p) => p.type === "weekday")!.value;

  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour") === 24 ? 0 : get("hour"),
    minute: get("minute"),
    weekday: wdMap[wdStr] ?? 0,
  };
}

/** Convert Central Time components → UTC Date */
function ctToUtc(year: number, month: number, day: number, hour: number, minute = 0): Date {
  const guess = new Date(Date.UTC(year, month - 1, day, hour + 6, minute));
  const actual = getCTParts(guess);
  const wantMin = hour * 60 + minute;
  const gotMin = actual.hour * 60 + actual.minute;
  const delta = gotMin - wantMin;
  return new Date(guess.getTime() - delta * 60_000);
}

/**
 * Check if a block of consecutive working days is available on the calendar.
 * Skips Sundays. Mon–Fri 7am–5pm, Sat 8am–12pm.
 */
export async function checkAvailabilityBlock(
  startDate: Date,
  daysNeeded: number,
  excludeEventId?: string,
): Promise<AvailabilityCheckResult> {
  const calendar = getCalendarClient();

  // Build working day list (skip Sundays)
  const workDays: Date[] = [];
  let cursor = new Date(startDate);
  while (workDays.length < daysNeeded) {
    const dp = getCTParts(cursor);
    if (dp.weekday !== 0) { // Skip Sundays
      workDays.push(new Date(cursor));
    }
    cursor = new Date(cursor.getTime() + 86_400_000);
  }

  // Query freebusy for the full range
  const firstParts = getCTParts(workDays[0]);
  const rangeStart = ctToUtc(firstParts.year, firstParts.month, firstParts.day, 0);
  const lastParts = getCTParts(workDays[workDays.length - 1]);
  const rangeEnd = ctToUtc(lastParts.year, lastParts.month, lastParts.day, 23, 59);

  const response = await calendar.freebusy.query({
    requestBody: {
      timeMin: rangeStart.toISOString(),
      timeMax: rangeEnd.toISOString(),
      timeZone: TZ,
      items: [{ id: "primary" }],
    },
  });

  let busyPeriods = (response.data.calendars?.["primary"]?.busy ?? []).map((b) => ({
    start: new Date(b.start!),
    end: new Date(b.end!),
  }));

  // If excluding a specific event (reschedule), filter its busy block
  if (excludeEventId) {
    try {
      const event = await calendar.events.get({ calendarId: "primary", eventId: excludeEventId });
      const es = event.data.start?.dateTime ?? event.data.start?.date;
      const ee = event.data.end?.dateTime ?? event.data.end?.date;
      if (es && ee) {
        const exStart = new Date(es).getTime();
        const exEnd = new Date(ee).getTime();
        busyPeriods = busyPeriods.filter(
          (b) => !(b.start.getTime() === exStart && b.end.getTime() === exEnd),
        );
      }
    } catch {
      // Event may have been deleted — proceed without exclusion
    }
  }

  const conflicts: Array<{ date: string; reason: string }> = [];

  for (const day of workDays) {
    const dp = getCTParts(day);
    const isSaturday = dp.weekday === 6;
    const bhStart = isSaturday ? 8 : 7;
    const bhEnd = isSaturday ? 12 : 17;
    const dayStart = ctToUtc(dp.year, dp.month, dp.day, bhStart);
    const dayEnd = ctToUtc(dp.year, dp.month, dp.day, bhEnd);

    const dayBusy = busyPeriods.filter(
      (b) => b.start.getTime() < dayEnd.getTime() && b.end.getTime() > dayStart.getTime(),
    );

    if (dayBusy.length > 0) {
      const summaries = dayBusy.map((b) =>
        `${formatTimeCT(b.start)}–${formatTimeCT(b.end)}`
      ).join(", ");
      conflicts.push({
        date: formatDateCT(day),
        reason: `Busy: ${summaries}`,
      });
    }
  }

  return { available: conflicts.length === 0, conflicts };
}

/**
 * Find the next block of consecutive open working days.
 */
export async function findConsecutiveOpenDays(
  fromDate: Date,
  daysNeeded: number,
  lookAheadDays: number = 30,
): Promise<Date[]> {
  let cursor = new Date(fromDate);
  const limit = new Date(fromDate.getTime() + lookAheadDays * 86_400_000);

  while (cursor < limit) {
    const dp = getCTParts(cursor);
    if (dp.weekday === 0) { // Skip Sundays
      cursor = new Date(cursor.getTime() + 86_400_000);
      continue;
    }

    const result = await checkAvailabilityBlock(cursor, daysNeeded);
    if (result.available) {
      const days: Date[] = [];
      let c = new Date(cursor);
      while (days.length < daysNeeded) {
        const cdp = getCTParts(c);
        if (cdp.weekday !== 0) days.push(new Date(c));
        c = new Date(c.getTime() + 86_400_000);
      }
      return days;
    }

    cursor = new Date(cursor.getTime() + 86_400_000);
  }

  return [];
}
