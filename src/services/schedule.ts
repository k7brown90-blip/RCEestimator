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
