/**
 * ONE business-day rule (work order agent-team, step 0): Monday-Friday in America/Chicago, no
 * holiday list. "Escalate after 2 business days" and "follow up 2 business days after view" call
 * `addBusinessDays`; the quiet-hours helper (shared/sms/quietHours.ts) calls `isBusinessDay` and the
 * zone primitives below so there is a single place that knows how to read a wall clock.
 *
 * Same discipline as shared/calendarDay.ts: every read goes through Intl with an explicit timeZone
 * (the CALENDAR_DAY_TIME_ZONE export, not a second copy of the name; it is the default of every
 * function here, and a caller texting a customer may pass the recipient's zone instead). Never
 * getDay()/getHours() or any other server-local Date method - Railway's zone is not Chicago. Pure
 * functions, no DB.
 */

import { CALENDAR_DAY_TIME_ZONE } from "./calendarDay";

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number;
  /** 0 = Sunday ... 6 = Saturday, the weekday of this instant in the zone. */
  weekday: number;
}

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric", month: "numeric", day: "numeric",
      hour: "numeric", minute: "numeric",
      weekday: "short",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** The wall clock (date, time of day, weekday) at an instant, in an explicit zone. */
export function zonedParts(at: Date, timeZone: string = CALENDAR_DAY_TIME_ZONE): ZonedParts {
  if (Number.isNaN(at.getTime())) throw new RangeError("Invalid date");
  const parts = formatterFor(timeZone).formatToParts(at);
  const num = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "NaN");
  const weekdayName = parts.find((p) => p.type === "weekday")?.value ?? "";
  return {
    year: num("year"), month: num("month"), day: num("day"),
    // Some engines print midnight as 24 even under h23; fold it back.
    hour: num("hour") % 24, minute: num("minute"),
    weekday: WEEKDAY_INDEX[weekdayName] ?? NaN,
  };
}

/** Weekday (0 = Sunday) of a calendar date, independent of any zone. */
export function weekdayOfDate(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** The calendar date `days` after (or before) a Y/M/D, as Y/M/D. Pure UTC arithmetic on a date. */
export function shiftDate(
  year: number, month: number, day: number, days: number,
): { year: number; month: number; day: number } {
  const d = new Date(Date.UTC(year, month - 1, day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/**
 * The instant at which the zone's wall clock reads year-month-day hour:minute. Daylight saving:
 * a wall time that happens twice (the autumn fall-back hour) resolves to its FIRST occurrence; one
 * that never happens (the spring-forward gap, 2:00-2:59 AM in the US) resolves to the same clock
 * reading an hour later (2:30 AM becomes 3:30 AM), so the result is never earlier than asked.
 */
export function zonedWallToInstant(
  year: number, month: number, day: number, hour: number, minute: number,
  timeZone: string = CALENDAR_DAY_TIME_ZONE,
): Date {
  const wantedAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  // The wall clock an instant shows, read back as if it were UTC. Its difference from the instant
  // is the zone's UTC offset at that instant.
  const wallAsUtc = (ms: number): number => {
    const p = zonedParts(new Date(ms), timeZone);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  };
  const DAY = 86_400_000;
  // The offsets a day before and a day after bracket any single DST change, so the right instant is
  // the wanted time minus one of them. Keep the earliest candidate that reads back correctly.
  const before = wallAsUtc(wantedAsUtc - DAY) - (wantedAsUtc - DAY);
  const after = wallAsUtc(wantedAsUtc + DAY) - (wantedAsUtc + DAY);
  const matches = [wantedAsUtc - before, wantedAsUtc - after]
    .filter((ms) => wallAsUtc(ms) === wantedAsUtc)
    .sort((x, y) => x - y);
  if (matches.length > 0) return new Date(matches[0]);
  // Gap: the wall time does not exist. The pre-change offset puts it an hour later on the new clock.
  return new Date(wantedAsUtc - before);
}

/** True on a Monday-Friday in the zone (default America/Chicago). No holiday list. */
export function isBusinessDay(at: Date, timeZone: string = CALENDAR_DAY_TIME_ZONE): boolean {
  const { weekday } = zonedParts(at, timeZone);
  return weekday >= 1 && weekday <= 5;
}

/**
 * The instant `n` business days after (or, for negative n, before) `at`, at the SAME wall-clock
 * time of day in the zone (default America/Chicago). Days are counted by stepping the calendar one
 * day at a time and counting only Monday-Friday landings, so from a Saturday, n = 1 is Monday and
 * n = 0 is `at` unchanged. Friday 3 PM + 1 = Monday 3 PM; Thursday + 2 = next Monday. A landing
 * time that the clock skips (DST gap) moves an hour later on the clock.
 */
export function addBusinessDays(at: Date, n: number, timeZone: string = CALENDAR_DAY_TIME_ZONE): Date {
  if (!Number.isInteger(n)) throw new RangeError("n must be a whole number of business days");
  if (n === 0) return new Date(at.getTime());
  const start = zonedParts(at, timeZone);
  const step = n > 0 ? 1 : -1;
  let cursor = { year: start.year, month: start.month, day: start.day };
  let remaining = Math.abs(n);
  while (remaining > 0) {
    cursor = shiftDate(cursor.year, cursor.month, cursor.day, step);
    const wd = weekdayOfDate(cursor.year, cursor.month, cursor.day);
    if (wd >= 1 && wd <= 5) remaining -= 1;
  }
  return zonedWallToInstant(cursor.year, cursor.month, cursor.day, start.hour, start.minute, timeZone);
}
