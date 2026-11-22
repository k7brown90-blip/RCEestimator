/**
 * ONE quiet-hours rule for customer-facing SMS (work order agent-team, step 0; the team's ruling,
 * relayed by Kyle): a customer text goes out only 8:00 AM to 8:00 PM and never on a Saturday or
 * Sunday, in the RECIPIENT's local time. Every Middle Tennessee number is America/Chicago, which is
 * the default zone here; working the zone out from the area code is a later texting unit's job, so
 * these functions only take the zone they are handed. Pure functions, no DB. The configured window
 * (owner-only setting key `quietHours`) is read once by services/ownerSettings.ts
 * `getQuietWindow()` and passed in here; the weekday rule is not configurable.
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

/**
 * True when a customer text may be sent at this instant. `timeZone` is the RECIPIENT's zone and
 * defaults to America/Chicago.
 */
export function isSendableNow(
  at: Date, window: QuietWindow = DEFAULT_QUIET_WINDOW, timeZone: string = CALENDAR_DAY_TIME_ZONE,
): boolean {
  const { start, end } = bounds(window);
  if (!isBusinessDay(at, timeZone)) return false;
  const p = zonedParts(at, timeZone);
  const minute = p.hour * 60 + p.minute;
  return minute >= start && minute < end;
}

/**
 * The earliest instant at or after `at` when a customer text may go out, in the recipient's zone
 * (default Chicago). `at` itself when it is already sendable. Friday 9 PM Chicago -> Monday 8:00 AM
 * Chicago; Tuesday 6 AM -> Tuesday 8:00 AM; Saturday noon -> Monday 8:00 AM. Otherwise always lands
 * on the window's start.
 */
export function nextSendableAt(
  at: Date, window: QuietWindow = DEFAULT_QUIET_WINDOW, timeZone: string = CALENDAR_DAY_TIME_ZONE,
): Date {
  const { start } = bounds(window);
  if (isSendableNow(at, window, timeZone)) return new Date(at.getTime());

  const p = zonedParts(at, timeZone);
  const minute = p.hour * 60 + p.minute;
  const startHour = Math.floor(start / 60);
  const startMinute = start % 60;

  // Before opening on a business day: the same day's opening.
  if (isBusinessDay(at, timeZone) && minute < start) {
    return zonedWallToInstant(p.year, p.month, p.day, startHour, startMinute, timeZone);
  }
  // After closing, or a weekend: the opening of the next business day.
  let day = { year: p.year, month: p.month, day: p.day };
  for (let i = 0; i < 7; i += 1) {
    day = shiftDate(day.year, day.month, day.day, 1);
    const wd = weekdayOfDate(day.year, day.month, day.day);
    if (wd >= 1 && wd <= 5) return zonedWallToInstant(day.year, day.month, day.day, startHour, startMinute, timeZone);
  }
  throw new Error("unreachable: a week always contains a weekday");
}
