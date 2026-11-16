import { describe, expect, it } from "vitest";
import {
  addDays, chicagoDayBounds, chicagoToday, dayInstant, dayOf, formatDay, formatReceived, isDayString,
  parseReceivedAt, parseSourceUrl, receivedDay, toFollowUpInstant,
} from "../shared/calendarDay";

/**
 * One calendar-day rule for the lead follow-up date (plan lead-intake-fixes, B2).
 *
 * The bug shipped because CI runs in UTC, where midnight UTC renders as the right day. Every
 * assertion here names its instant explicitly and formats with an explicit time zone, so the result
 * does not depend on the machine's TZ.
 */

describe("calendarDay", () => {
  it("stores a bare day as noon UTC and reads it back as the same day", () => {
    const stored = dayInstant("2026-11-15");
    expect(stored.toISOString()).toBe("2026-11-15T12:00:00.000Z");
    expect(dayOf(stored)).toBe("2026-11-15");
    expect(dayOf(stored.toISOString())).toBe("2026-11-15");
  });

  it("the stored day is the same calendar day in every US zone (the point of noon)", () => {
    const stored = dayInstant("2026-11-15");
    for (const timeZone of ["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "Pacific/Honolulu"]) {
      const shown = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(stored);
      expect(shown).toBe("2026-11-15");
    }
  });

  it("reads a legacy midnight-UTC row as the day that was typed, not the evening before", () => {
    // The old writer stored new Date("2026-11-15") = midnight UTC = Nov 14, 6 PM in Chicago.
    const legacy = new Date("2026-11-15T00:00:00.000Z");
    expect(dayOf(legacy)).toBe("2026-11-15");
    expect(formatDay(legacy)).toBe(dayInstant("2026-11-15").toLocaleDateString(undefined, { timeZone: "UTC" }));
    expect(formatDay(legacy)).toMatch(/15/);
    expect(formatDay("2026-11-15T12:00:00.000Z")).toBe(formatDay(legacy));
  });

  it("reads a legacy real-moment row (the old Snooze +2d timestamp) as its Chicago day", () => {
    // Snooze clicked 8 PM CT Nov 14 stored now+2d = 2026-11-17T02:00Z, which is Nov 16 in Chicago.
    const snoozed = new Date("2026-11-17T02:00:00.000Z");
    expect(dayOf(snoozed)).toBe("2026-11-16");
    expect(formatDay(snoozed)).toBe(formatDay(dayInstant("2026-11-16")));
    expect(dayOf(snoozed)).toBe(chicagoToday(snoozed));
  });

  it("formatDay is empty for nothing and for garbage", () => {
    expect(formatDay(null)).toBe("");
    expect(formatDay(undefined)).toBe("");
    expect(formatDay("")).toBe("");
    expect(formatDay("not a date")).toBe("");
  });

  it("toFollowUpInstant rewrites only a bare YYYY-MM-DD and passes a full timestamp through", () => {
    expect(isDayString("2026-11-15")).toBe(true);
    expect(isDayString("2026-11-15T06:00:00Z")).toBe(false);
    expect(toFollowUpInstant("2026-11-15").toISOString()).toBe("2026-11-15T12:00:00.000Z");
    // /vapi/update-lead reads a booked lead's time of day as the appointment window — untouched.
    expect(toFollowUpInstant("2026-11-15T14:30:00.000Z").toISOString()).toBe("2026-11-15T14:30:00.000Z");
    expect(Number.isNaN(toFollowUpInstant("nonsense").getTime())).toBe(true);
  });

  it("chicagoToday is the Chicago day, across the UTC midnight and the DST change", () => {
    // 2026-11-16 03:00 UTC is still Nov 15, 9 PM CST.
    expect(chicagoToday(new Date("2026-11-16T03:00:00Z"))).toBe("2026-11-15");
    // 2026-11-16 06:00 UTC is exactly midnight CST: the new day.
    expect(chicagoToday(new Date("2026-11-16T06:00:00Z"))).toBe("2026-11-16");
    // Summer (CDT, UTC-5): 04:59 UTC is still the day before, 05:00 UTC is the new day.
    expect(chicagoToday(new Date("2026-07-01T04:59:00Z"))).toBe("2026-06-30");
    expect(chicagoToday(new Date("2026-07-01T05:00:00Z"))).toBe("2026-07-01");
  });

  it("addDays walks month and year ends", () => {
    expect(addDays("2026-11-15", 2)).toBe("2026-11-17");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("a follow-up is due on its own day and overdue only after it", () => {
    // Nov 15, 10 AM Chicago (16:00 UTC).
    const { startOfToday, endOfToday, sevenDaysOut, today } = chicagoDayBounds(new Date("2026-11-15T16:00:00Z"));
    expect(today).toBe("2026-11-15");
    const dueToday = dayInstant("2026-11-15");
    const yesterday = dayInstant("2026-11-14");
    const tomorrow = dayInstant("2026-11-16");
    expect(dueToday >= startOfToday && dueToday < endOfToday).toBe(true);
    expect(yesterday < startOfToday).toBe(true);
    expect(tomorrow >= endOfToday && tomorrow < sevenDaysOut).toBe(true);
    // The row the old form wrote (midnight UTC) is also "today", not overdue.
    const legacy = new Date("2026-11-15T00:00:00Z");
    expect(legacy >= startOfToday && legacy < endOfToday).toBe(true);
    // The evening before (Nov 14, 8 PM Chicago = Nov 15 02:00 UTC): a Nov 15 follow-up is not overdue.
    const evening = chicagoDayBounds(new Date("2026-11-15T02:00:00Z"));
    expect(dueToday < evening.startOfToday).toBe(false);
  });
});

describe("the original received day (plan lead-intake-fixes F3)", () => {
  const now = new Date("2026-11-15T16:00:00Z"); // Nov 15, 10 AM Chicago

  it("a typed day is stored at noon UTC", () => {
    const parsed = parseReceivedAt("2026-10-20", now);
    expect(parsed.ok && parsed.date.toISOString()).toBe("2026-10-20T12:00:00.000Z");
  });

  it("today in Chicago is allowed, tomorrow is not, whatever the UTC date says", () => {
    expect(parseReceivedAt("2026-11-15", now).ok).toBe(true);
    const tomorrow = parseReceivedAt("2026-11-16", now);
    expect(tomorrow).toEqual({ ok: false, error: "Original received date cannot be in the future" });
    // 8 PM Chicago on Nov 14 is already Nov 15 in UTC: Nov 14 is today, Nov 15 is the future.
    const evening = new Date("2026-11-15T02:00:00Z");
    expect(parseReceivedAt("2026-11-14", evening).ok).toBe(true);
    expect(parseReceivedAt("2026-11-15", evening).ok).toBe(false);
  });

  it("refuses garbage, and a full timestamp more than a minute ahead; accepts one a moment behind", () => {
    expect(parseReceivedAt("not a date", now)).toEqual({ ok: false, error: "Invalid original received date" });
    expect(parseReceivedAt("2026-11-15T16:05:00Z", now).ok).toBe(false);
    expect(parseReceivedAt("2026-11-15T15:59:30Z", now).ok).toBe(true);
    expect(parseReceivedAt(new Date("2026-10-01T03:00:00Z"), now).ok).toBe(true);
  });

  it("reads a typed day as that day and a real moment as its Chicago day, never the UTC date", () => {
    // 9:57 PM Chicago on Nov 14 = 03:57Z on Nov 15.
    expect(receivedDay("2026-11-15T03:57:00.000Z")).toBe("2026-11-14");
    expect(receivedDay("2026-10-20T12:00:00.000Z")).toBe("2026-10-20");
    expect(receivedDay(new Date("2026-11-15T12:00:00.000Z"))).toBe("2026-11-15");
    expect(formatReceived("2026-11-15T03:57:00.000Z")).toBe(dayInstant("2026-11-14").toLocaleDateString(undefined, { timeZone: "UTC" }));
    expect(formatReceived("2026-10-20T12:00:00.000Z")).toBe(formatDay("2026-10-20T12:00:00.000Z"));
    expect(formatReceived(null)).toBe("");
    expect(formatReceived("nonsense")).toBe("");
  });

  it("a marketplace link is http or https, trimmed, and blank means none", () => {
    expect(parseSourceUrl("  https://www.angi.com/x?y=1 ")).toEqual({ ok: true, value: "https://www.angi.com/x?y=1" });
    expect(parseSourceUrl("http://a.test")).toEqual({ ok: true, value: "http://a.test" });
    expect(parseSourceUrl("")).toEqual({ ok: true, value: null });
    expect(parseSourceUrl(null)).toEqual({ ok: true, value: null });
    expect(parseSourceUrl(undefined)).toEqual({ ok: true, value: null });
    for (const bad of ["javascript:alert(1)", "ftp://x.test", "data:text/html,hi", "angi.com/x", "words", "mailto:a@b.co"]) {
      expect(parseSourceUrl(bad).ok).toBe(false);
    }
    expect(parseSourceUrl(`https://x.test/${"a".repeat(2001)}`)).toEqual({ ok: false, error: "Marketplace link is too long" });
  });
});
