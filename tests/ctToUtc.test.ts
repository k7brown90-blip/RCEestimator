/**
 * Central Time -> UTC at the edges of a day (2026-10-02).
 *
 * Both `ctToUtc` helpers guess "hour + 6 UTC" (right on standard time) and then correct. While
 * Central is on daylight time, hour 23 guesses into the NEXT Central day, and the old correction
 * compared only minutes-of-day, so the clock came out right and the DATE a day late:
 * `ctToUtc("2026-10-06", 23, 59)` returned 2026-10-08T04:59Z — through Oct 7. That is why the
 * tech picker for Oct 6 showed a tech with an all-day block on Oct 7 as "available · 12:00 AM-11:59 PM".
 */
import { describe, expect, it } from "vitest";
import { ctToUtc as ctToUtcParts } from "../src/services/schedule";
import { ctToUtc as ctToUtcDate } from "../src/services/techCalendars";

type Case = { date: string; hour: number; minute: number; utc: string; why: string };

const CASES: Case[] = [
  // Daylight time (CDT, UTC-5)
  { date: "2026-10-06", hour: 0, minute: 0, utc: "2026-10-06T05:00:00.000Z", why: "CDT start of day" },
  { date: "2026-10-06", hour: 23, minute: 59, utc: "2026-10-07T04:59:00.000Z", why: "CDT end of day (was a day late)" },
  // Standard time (CST, UTC-6)
  { date: "2026-12-06", hour: 0, minute: 0, utc: "2026-12-06T06:00:00.000Z", why: "CST start of day" },
  { date: "2026-12-06", hour: 23, minute: 59, utc: "2026-12-07T05:59:00.000Z", why: "CST end of day" },
  // The two transition days
  { date: "2026-03-08", hour: 0, minute: 0, utc: "2026-03-08T06:00:00.000Z", why: "spring-forward day starts on CST" },
  { date: "2026-03-08", hour: 23, minute: 59, utc: "2026-03-09T04:59:00.000Z", why: "spring-forward day ends on CDT" },
  { date: "2026-11-01", hour: 0, minute: 0, utc: "2026-11-01T05:00:00.000Z", why: "fall-back day starts on CDT" },
  { date: "2026-11-01", hour: 23, minute: 59, utc: "2026-11-02T05:59:00.000Z", why: "fall-back day ends on CST" },
  // An ordinary working hour is untouched
  { date: "2026-10-06", hour: 9, minute: 30, utc: "2026-10-06T14:30:00.000Z", why: "CDT mid-morning" },
];

describe("ctToUtc (schedule.ts — year, month, day, hour, minute)", () => {
  for (const c of CASES) {
    it(`${c.date} ${String(c.hour).padStart(2, "0")}:${String(c.minute).padStart(2, "0")} CT — ${c.why}`, () => {
      const [y, m, d] = c.date.split("-").map(Number);
      expect(ctToUtcParts(y, m, d, c.hour, c.minute).toISOString()).toBe(c.utc);
    });
  }
});

describe("ctToUtc (techCalendars.ts — YYYY-MM-DD, hour, minute)", () => {
  for (const c of CASES) {
    it(`${c.date} ${String(c.hour).padStart(2, "0")}:${String(c.minute).padStart(2, "0")} CT — ${c.why}`, () => {
      expect(ctToUtcDate(c.date, c.hour, c.minute).toISOString()).toBe(c.utc);
    });
  }
});
