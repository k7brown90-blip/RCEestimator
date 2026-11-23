/**
 * ONE quiet-hours helper, TWO day rules that cannot drift into each other (work order agent-team).
 *
 *   - A CUSTOMER text (isSendableNow / nextSendableAt) goes out 8:00 AM to 8:00 PM on ALL SEVEN days,
 *     in the RECIPIENT's local time (and, by the caller, Chicago too - ruling R3). Kyle, 2026-11-22:
 *     "Weekends should be open to customer texts 8AM - 8PM". This replaced the weekdays-only rule.
 *   - Kyle's own approval reminders (isReminderSendableNow, used only by services/hubRenotify.ts, team
 *     answer 8) stay Monday to Friday. That is a push to Kyle's devices, not a customer text.
 *
 * Both go through one internal function that takes the days EXPLICITLY ("every-day" or "weekdays"),
 * so neither rule is a default the other can quietly change. Booking (appointments Mon-Fri, "Weekends
 * close") is not this helper's business and is not touched.
 *
 * Every Middle Tennessee number is America/Chicago, the default zone here; working the zone out from
 * the area code is a later texting unit's job, so these functions only take the zone they are handed.
 * Pure functions, no DB. The configured window (owner-only setting key `quietHours`) is read once by
 * services/ownerSettings.ts `getQuietWindow()` and passed in here; the days are not configurable.
 *
 * Every read of the clock goes through Intl with an explicit timeZone (shared/businessDays.ts, which
 * defaults to CALENDAR_DAY_TIME_ZONE from shared/calendarDay.ts) - never server-local Date methods,
 * because Railway's zone is not Chicago. The start is inclusive and the end exclusive: 8:00:00 PM
 * is already quiet.
 */

import { CALENDAR_DAY_TIME_ZONE } from "../calendarDay";
import { isBusinessDay, shiftDate, weekdayOfDate, zonedParts, zonedWallToInstant } from "../businessDays";

/** Local clock times in the recipient's zone, "HH:MM" 24-hour. `start` must be earlier than `end`. */
export interface QuietWindow {
  /** First minute a text may go out. */
  start: string;
  /** First minute a text may NOT go out. */
  end: string;
}

export const DEFAULT_QUIET_WINDOW: QuietWindow = { start: "08:00", end: "20:00" };

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** "HH:MM" -> minutes after midnight, or null when it is not a valid 24-hour time. */
export function parseClock(value: string): number | null {
  const m = HHMM.exec(value);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** True when `window` is two valid "HH:MM" times with start strictly before end. */
export function isValidQuietWindow(window: QuietWindow): boolean {
  const s = parseClock(window.start);
  const e = parseClock(window.end);
  return s !== null && e !== null && s < e;
}

function bounds(window: QuietWindow): { start: number; end: number } {
  const start = parseClock(window.start);
  const end = parseClock(window.end);
  if (start === null || end === null || start >= end) {
    throw new RangeError(`Invalid quiet window ${window.start}-${window.end}`);
  }
  return { start, end };
}

/** Which days a window is open on. The rule is named at every call, never inferred. */
export type SendDays = "every-day" | "weekdays";

function dayAllowed(at: Date, days: SendDays, timeZone: string): boolean {
  return days === "every-day" || isBusinessDay(at, timeZone);
}

function sendableNow(at: Date, window: QuietWindow, timeZone: string, days: SendDays): boolean {
  const { start, end } = bounds(window);
  if (!dayAllowed(at, days, timeZone)) return false;
  const p = zonedParts(at, timeZone);
  const minute = p.hour * 60 + p.minute;
  return minute >= start && minute < end;
}

function sendableAt(at: Date, window: QuietWindow, timeZone: string, days: SendDays): Date {
  const { start } = bounds(window);
  if (sendableNow(at, window, timeZone, days)) return new Date(at.getTime());

  const p = zonedParts(at, timeZone);
  const minute = p.hour * 60 + p.minute;
  const startHour = Math.floor(start / 60);
  const startMinute = start % 60;

  // Before opening on an open day: the same day's opening.
  if (dayAllowed(at, days, timeZone) && minute < start) {
    return zonedWallToInstant(p.year, p.month, p.day, startHour, startMinute, timeZone);
  }
  // After closing, or on a closed day: the opening of the next open day.
  let day = { year: p.year, month: p.month, day: p.day };
  for (let i = 0; i < 7; i += 1) {
    day = shiftDate(day.year, day.month, day.day, 1);
    const wd = weekdayOfDate(day.year, day.month, day.day);
    if (days === "every-day" || (wd >= 1 && wd <= 5)) {
      return zonedWallToInstant(day.year, day.month, day.day, startHour, startMinute, timeZone);
    }
  }
  throw new Error("unreachable: a week always contains an open day");
}

/**
 * True when a CUSTOMER text may be sent at this instant: inside the window on any day of the week.
 * `timeZone` is the RECIPIENT's zone and defaults to America/Chicago.
 */
export function isSendableNow(
  at: Date, window: QuietWindow = DEFAULT_QUIET_WINDOW, timeZone: string = CALENDAR_DAY_TIME_ZONE,
): boolean {
  return sendableNow(at, window, timeZone, "every-day");
}

/**
 * The earliest instant at or after `at` when a CUSTOMER text may go out, in the recipient's zone
 * (default Chicago). `at` itself when it is already sendable. Friday 9 PM Chicago -> Saturday 8:00 AM
 * Chicago; Tuesday 6 AM -> Tuesday 8:00 AM; Saturday noon -> Saturday noon. Otherwise always lands on
 * the window's start.
 */
export function nextSendableAt(
  at: Date, window: QuietWindow = DEFAULT_QUIET_WINDOW, timeZone: string = CALENDAR_DAY_TIME_ZONE,
): Date {
  return sendableAt(at, window, timeZone, "every-day");
}

/**
 * True when KYLE'S approval reminder may go out at this instant: inside the window, Monday to Friday
 * only (team answer 8). Not a customer text; never use this for one, and never use isSendableNow for
 * a reminder.
 */
export function isReminderSendableNow(
  at: Date, window: QuietWindow = DEFAULT_QUIET_WINDOW, timeZone: string = CALENDAR_DAY_TIME_ZONE,
): boolean {
  return sendableNow(at, window, timeZone, "weekdays");
}

/** The earliest instant at or after `at` when Kyle's reminder may go out (Monday to Friday). */
export function nextReminderSendableAt(
  at: Date, window: QuietWindow = DEFAULT_QUIET_WINDOW, timeZone: string = CALENDAR_DAY_TIME_ZONE,
): Date {
  return sendableAt(at, window, timeZone, "weekdays");
}
