/**
 * ONE calendar-day rule for a date that means "a day", not "a moment" — the lead follow-up date
 * (plan lead-intake-fixes, B2; Kyle's admin saw "Follow up Nov 15" displayed as Nov 14).
 *
 * The column is a timestamp (`Lead.followUpDate DateTime?`), but what the office means is a
 * calendar day. So the day is STORED as noon UTC — which falls on the same calendar day in every
 * US time zone — and is READ by its UTC date part, never by the viewer's local zone. "Today" is
 * always the America/Chicago day (the business's day), read through Intl with an explicit
 * timeZone, never from server-local Date methods (Railway's zone is not Chicago).
 *
 * Rows an older writer left at midnight UTC still read as the right day (their UTC date part is
 * the day that was typed). Rows an older writer left as a real moment (the old Snooze +2d sent a
 * full timestamp) read as their Chicago day — see `dayOf`. No data migration is needed for display;
 * an old midnight-UTC row counts in `chicagoDayBounds` from 6 PM the evening before, until it is
 * next saved.
 *
 * Writers: use `dayInstant` / `toFollowUpInstant`. Readers: use `dayOf` / `formatDay`.
 * Comparisons: build the bounds from `chicagoDayBounds`. Never `toLocaleDateString()` a
 * follow-up date, and never compare it with `new Date()`.
 */

export const CALENDAR_DAY_TIME_ZONE = "America/Chicago";

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** True for a bare `YYYY-MM-DD` string — the only shape this module rewrites. */
export function isDayString(value: string): boolean {
  return YMD.test(value);
}

/** `YYYY-MM-DD` → noon UTC of that day. The one writer rule. */
export function dayInstant(ymd: string): Date {
  return new Date(`${ymd}T12:00:00Z`);
}

/**
 * What a follow-up date writer stores. A bare `YYYY-MM-DD` becomes noon UTC of that day; any other
 * string parses exactly as before (the result may be an Invalid Date — the caller checks), so a
 * full timestamp is passed through untouched.
 */
export function toFollowUpInstant(value: string): Date {
  const trimmed = value.trim();
  return isDayString(trimmed) ? dayInstant(trimmed) : new Date(trimmed);
}

/**
 * The calendar day a stored value stands for, as `YYYY-MM-DD`. A typed day (exactly noon or
 * midnight UTC) reads as its UTC date part; any other value is a real moment — the old Dashboard
 * "Snooze +2d", the old renewal writer, a Savannah appointment time — and reads as its Chicago day,
 * the same day `chicagoDayBounds` counts it on.
 */
export function dayOf(value: string | Date): string {
  const date = typeof value === "string" ? new Date(value) : value;
  const h = date.getUTCHours();
  const isTypedDay = (h === 0 || h === 12) && date.getUTCMinutes() === 0
    && date.getUTCSeconds() === 0 && date.getUTCMilliseconds() === 0;
  return isTypedDay ? date.toISOString().slice(0, 10) : chicagoToday(date);
}

/** A stored day as the office reads it, e.g. `11/15/2026`. Never shifts with the viewer's zone. */
export function formatDay(value: string | Date | null | undefined): string {
  if (value === null || value === undefined || value === "") return "";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "";
  return dayInstant(dayOf(date)).toLocaleDateString(undefined, { timeZone: "UTC" });
}

/** Today's calendar day in the business's zone (America/Chicago), as `YYYY-MM-DD`. */
export function chicagoToday(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: CALENDAR_DAY_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const pick = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
}

/** `YYYY-MM-DD` plus (or minus) whole days. */
export function addDays(ymd: string, days: number): string {
  return dayOf(new Date(dayInstant(ymd).getTime() + days * DAY_MS));
}

/**
 * The comparison bounds for "overdue / due today / next 7 days", as UTC instants that line up
 * with stored days (a stored day sits between its own midnight and the next). A follow-up is
 * overdue only once its day has PASSED, so the overdue and due-today counts never share a lead.
 */
export function chicagoDayBounds(now: Date = new Date()): {
  today: string; startOfToday: Date; endOfToday: Date; sevenDaysOut: Date;
} {
  const today = chicagoToday(now);
  return {
    today,
    startOfToday: new Date(`${today}T00:00:00Z`),
    endOfToday: new Date(`${addDays(today, 1)}T00:00:00Z`),
    sevenDaysOut: new Date(`${addDays(today, 8)}T00:00:00Z`),
  };
}

/**
 * The day a lead REALLY reached Red Cedar (`Lead.receivedAt`, plan lead-intake-fixes F3). A Yelp or
 * Angi lead typed in a month later keeps the marketplace's own day, so the funnel and the Dashboard
 * count it in the month it arrived.
 *
 * The same calendar-day rule as the follow-up date: a bare `YYYY-MM-DD` is stored as noon UTC, and
 * is "in the future" only when its day is after today in Chicago. A full timestamp (a client that
 * round-trips the stored value) parses as it is and may not be later than now, give or take a
 * minute of clock skew.
 *
 * Blank (null, undefined or "") is not an error here — the CALLER decides what blank means: a new
 * lead takes "now", an edit resets to the day the row was entered.
 */
export type ReceivedAtResult = { ok: true; date: Date } | { ok: false; error: string };

export const RECEIVED_AT_FUTURE_ERROR = "Original received date cannot be in the future";

export function parseReceivedAt(value: string | Date, now: Date = new Date()): ReceivedAtResult {
  const text = typeof value === "string" ? value.trim() : null;
  const date = text !== null ? (isDayString(text) ? dayInstant(text) : new Date(text)) : value as Date;
  if (Number.isNaN(date.getTime())) return { ok: false, error: "Invalid original received date" };
  const future = text !== null && isDayString(text)
    ? text > chicagoToday(now)
    : date.getTime() > now.getTime() + 60_000;
  if (future) return { ok: false, error: RECEIVED_AT_FUTURE_ERROR };
  return { ok: true, date };
}

/**
 * A marketplace link: an http or https URL, trimmed, at most 2000 characters. Blank means "no
 * link" (null). Anything else — `javascript:`, `ftp:`, text that is not a URL — is refused, because
 * the drawer renders this as a clickable link.
 */
export type SourceUrlResult = { ok: true; value: string | null } | { ok: false; error: string };

export const SOURCE_URL_ERROR = "Marketplace link must start with http:// or https://";

export function parseSourceUrl(value: string | null | undefined): SourceUrlResult {
  const text = (value ?? "").trim();
  if (text === "") return { ok: true, value: null };
  if (text.length > 2000) return { ok: false, error: "Marketplace link is too long" };
  let url: URL;
  try { url = new URL(text); } catch { return { ok: false, error: SOURCE_URL_ERROR }; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, error: SOURCE_URL_ERROR };
  return { ok: true, value: text };
}

/**
 * The calendar day a lead's `receivedAt` stands for, as `YYYY-MM-DD`.
 *
 * `receivedAt` holds two kinds of value. A day the office TYPED is stored at exactly noon UTC (see
 * `parseReceivedAt`) and reads as its UTC date part. Every other value is a real moment — the
 * column's `now()` default for a webhook, booking-chat or Savannah lead, and the migration's copy
 * of `createdAt` for every older lead — and reads as the Chicago day it happened on, so a lead
 * that came in at 9:57 PM on Nov 14 is Nov 14, not Nov 15 (its UTC date). A real moment landing on
 * exactly 12:00:00.000 UTC is the one ambiguity, and is not worth guarding.
 */
export function receivedDay(value: string | Date): string {
  const date = typeof value === "string" ? new Date(value) : value;
  const isTypedDay = date.getUTCHours() === 12 && date.getUTCMinutes() === 0
    && date.getUTCSeconds() === 0 && date.getUTCMilliseconds() === 0;
  return isTypedDay ? dayOf(date) : chicagoToday(date);
}

/** `receivedDay`, as the office reads it (e.g. `11/14/2026`); empty for nothing or garbage. */
export function formatReceived(value: string | Date | null | undefined): string {
  if (value === null || value === undefined || value === "") return "";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "";
  return dayInstant(receivedDay(date)).toLocaleDateString(undefined, { timeZone: "UTC" });
}
