import { describe, expect, it } from "vitest";
import {
  DEFAULT_QUIET_WINDOW, isReminderSendableNow, isSendableNow, isValidQuietWindow, nextReminderSendableAt, nextSendableAt, parseClock,
} from "../shared/sms/quietHours";

/**
 * Customer SMS goes out 8:00 AM to 8:00 PM on ALL SEVEN days (Kyle, 2026-11-22: "Weekends should be open to
 * customer texts 8AM - 8PM"); Kyle's own approval reminders keep Monday to Friday (work order agent-team, U8). Every instant is written in UTC so the test cannot depend on the machine's own zone; the
 * Chicago reading is in the comment. 2026 US daylight saving: springs forward Sun Mar 8, falls back
 * Sun Nov 1. Nov 20 2026 is a Friday.
 */
const utc = (iso: string) => new Date(iso);
const next = (iso: string, tz?: string) => nextSendableAt(utc(iso), DEFAULT_QUIET_WINDOW, tz).toISOString();

describe("the default window", () => {
  it("is 8 AM to 8 PM", () => {
    expect(DEFAULT_QUIET_WINDOW).toEqual({ start: "08:00", end: "20:00" });
  });
});

describe("isSendableNow", () => {
  it("opens at 8:00 AM and closes at 8:00 PM (end is exclusive)", () => {
    expect(isSendableNow(utc("2026-11-23T13:59:00Z"))).toBe(false); // Mon 7:59 AM CST
    expect(isSendableNow(utc("2026-11-23T14:00:00Z"))).toBe(true); // Mon 8:00 AM CST
    expect(isSendableNow(utc("2026-11-24T01:59:00Z"))).toBe(true); // Mon 7:59 PM CST
    expect(isSendableNow(utc("2026-11-24T02:00:00Z"))).toBe(false); // Mon 8:00 PM CST
  });

  it("is sendable on Saturday and Sunday inside the same 8-to-8 window", () => {
    expect(isSendableNow(utc("2026-11-21T18:00:00Z"))).toBe(true); // Sat noon CST
    expect(isSendableNow(utc("2026-11-22T18:00:00Z"))).toBe(true); // Sun noon CST
    expect(isSendableNow(utc("2026-11-21T13:59:00Z"))).toBe(false); // Sat 7:59 AM CST
    expect(isSendableNow(utc("2026-11-21T14:00:00Z"))).toBe(true); // Sat 8:00 AM CST
    expect(isSendableNow(utc("2026-11-22T01:59:00Z"))).toBe(true); // Sat 7:59 PM CST
    expect(isSendableNow(utc("2026-11-22T02:00:00Z"))).toBe(false); // Sat 8:00 PM CST
    expect(isSendableNow(utc("2026-11-22T14:00:00Z"))).toBe(true); // Sun 8:00 AM CST
    expect(isSendableNow(utc("2026-11-23T02:00:00Z"))).toBe(false); // Sun 8:00 PM CST
  });

  it("reads the day by the Chicago date, not the UTC date", () => {
    // Fri 7:30 PM CST is already Saturday in UTC and is sendable.
    expect(isSendableNow(utc("2026-11-21T01:30:00Z"))).toBe(true);
    // Sat 7:30 PM CST is Sunday in UTC; Sat 9 PM CST is closed on the hour rule, not the day.
    expect(isSendableNow(utc("2026-11-22T01:30:00Z"))).toBe(true);
    expect(isSendableNow(utc("2026-11-22T03:00:00Z"))).toBe(false);
  });

  it("follows daylight saving: 8 AM / 8 PM Chicago is a different UTC hour in summer", () => {
    expect(isSendableNow(utc("2026-07-06T12:59:00Z"))).toBe(false); // Mon 7:59 AM CDT
    expect(isSendableNow(utc("2026-07-06T13:00:00Z"))).toBe(true); // Mon 8:00 AM CDT
    expect(isSendableNow(utc("2026-07-07T00:59:00Z"))).toBe(true); // Mon 7:59 PM CDT
    expect(isSendableNow(utc("2026-07-07T01:00:00Z"))).toBe(false); // Mon 8:00 PM CDT
  });

  it("changes at the right instant on the days the clock changes", () => {
    // Fri Mar 6 2026 (CST) and Tue Mar 10 2026 (CDT): the same 8 PM close, an hour apart in UTC.
    expect(isSendableNow(utc("2026-03-07T01:59:00Z"))).toBe(true); // Fri 7:59 PM CST
    expect(isSendableNow(utc("2026-03-07T02:00:00Z"))).toBe(false); // Fri 8:00 PM CST
    expect(isSendableNow(utc("2026-03-11T00:59:00Z"))).toBe(true); // Tue 7:59 PM CDT
    expect(isSendableNow(utc("2026-03-11T01:00:00Z"))).toBe(false); // Tue 8:00 PM CDT
    // Sunday Mar 8 itself, the day of the change, is open like any other day (8 AM CST/CDT boundary: 2 AM change).
    expect(isSendableNow(utc("2026-03-08T18:00:00Z"))).toBe(true);
  });

  it("honours a custom window", () => {
    const window = { start: "09:30", end: "17:00" };
    expect(isSendableNow(utc("2026-11-23T15:29:00Z"), window)).toBe(false); // Mon 9:29 AM CST
    expect(isSendableNow(utc("2026-11-23T15:30:00Z"), window)).toBe(true); // 9:30 AM
    expect(isSendableNow(utc("2026-11-23T22:59:00Z"), window)).toBe(true); // 4:59 PM
    expect(isSendableNow(utc("2026-11-23T23:00:00Z"), window)).toBe(false); // 5:00 PM
  });

  it("is judged in the recipient's zone when one is given (default stays Chicago)", () => {
    // Tue Nov 17: 7:30 PM Chicago is 8:30 PM in New York. Sendable in Chicago, not in New York.
    const at = utc("2026-11-18T01:30:00Z");
    expect(isSendableNow(at)).toBe(true);
    expect(isSendableNow(at, DEFAULT_QUIET_WINDOW, "America/Chicago")).toBe(true);
    expect(isSendableNow(at, DEFAULT_QUIET_WINDOW, "America/New_York")).toBe(false);
    // And the other way: 7:30 AM Chicago is 8:30 AM New York.
    const early = utc("2026-11-17T13:30:00Z");
    expect(isSendableNow(early)).toBe(false);
    expect(isSendableNow(early, DEFAULT_QUIET_WINDOW, "America/New_York")).toBe(true);
  });

  it("rejects an invalid window rather than guessing", () => {
    const at = utc("2026-11-23T18:00:00Z");
    expect(() => isSendableNow(at, { start: "20:00", end: "08:00" })).toThrow(RangeError);
    expect(() => isSendableNow(at, { start: "8am", end: "20:00" })).toThrow(RangeError);
    expect(() => nextSendableAt(at, { start: "08:00", end: "08:00" })).toThrow(RangeError);
  });
});

describe("nextSendableAt", () => {
  it("returns the same instant when it is already sendable", () => {
    const at = utc("2026-11-23T18:17:00Z");
    expect(nextSendableAt(at).getTime()).toBe(at.getTime());
  });

  it("approved Friday 9 PM Chicago -> Saturday 8:00 AM Chicago", () => {
    expect(next("2026-11-21T03:00:00Z")).toBe("2026-11-21T14:00:00.000Z"); // Fri 9 PM CST -> Sat 8 AM CST
  });

  it("a weekend moment inside the window is sendable as it is", () => {
    expect(next("2026-11-21T18:00:00Z")).toBe("2026-11-21T18:00:00.000Z"); // Sat noon
    expect(next("2026-11-22T23:00:00Z")).toBe("2026-11-22T23:00:00.000Z"); // Sun 5 PM
  });

  it("a weekend moment outside the window waits for the next 8:00 AM, weekend or not", () => {
    expect(next("2026-11-21T12:00:00Z")).toBe("2026-11-21T14:00:00.000Z"); // Sat 6 AM -> Sat 8 AM
    expect(next("2026-11-22T03:00:00Z")).toBe("2026-11-22T14:00:00.000Z"); // Sat 9 PM -> Sun 8 AM
    expect(next("2026-11-23T05:00:00Z")).toBe("2026-11-23T14:00:00.000Z"); // Sun 11 PM CST -> Mon 8 AM
  });

  it("before opening on a business day waits for that same morning", () => {
    expect(next("2026-11-24T11:00:00Z")).toBe("2026-11-24T14:00:00.000Z"); // Tue 5 AM -> Tue 8 AM
    expect(next("2026-11-24T05:59:00Z")).toBe("2026-11-24T14:00:00.000Z"); // Mon 11:59 PM -> Tue 8 AM
  });

  it("after closing on Mon-Thu waits for the next morning", () => {
    expect(next("2026-11-24T02:00:00Z")).toBe("2026-11-24T14:00:00.000Z"); // Mon 8 PM -> Tue 8 AM
  });

  it("crosses the fall-back change: Saturday 9 PM CDT -> Sunday 8 AM CST", () => {
    // Sat Oct 31 9 PM CDT = Nov 1 02:00Z; the clock falls back at 2 AM Sunday, so 8 AM Sunday is CST = 14:00Z.
    expect(next("2026-11-01T02:00:00Z")).toBe("2026-11-01T14:00:00.000Z");
  });

  it("crosses the spring-forward change: Saturday 9 PM CST -> Sunday 8 AM CDT", () => {
    // Sat Mar 7 9 PM CST = Mar 8 03:00Z; the clock springs forward at 2 AM Sunday, so 8 AM Sunday is CDT = 13:00Z.
    expect(next("2026-03-08T03:00:00Z")).toBe("2026-03-08T13:00:00.000Z");
  });

  it("the result is always sendable and never earlier than the input", () => {
    // Sweep a full fortnight across the November change in 37-minute steps.
    const from = utc("2026-10-28T00:00:00Z").getTime();
    for (let i = 0; i < (14 * 24 * 60) / 37; i += 1) {
      const at = new Date(from + i * 37 * 60_000);
      const result = nextSendableAt(at);
      expect(result.getTime()).toBeGreaterThanOrEqual(at.getTime());
      expect(isSendableNow(result)).toBe(true);
    }
  });

  it("uses the recipient's zone when one is given", () => {
    // Tue Nov 17 7:30 PM Chicago = 8:30 PM New York: New York opens again Wed 8 AM EST = 13:00Z.
    expect(next("2026-11-18T01:30:00Z", "America/New_York")).toBe("2026-11-18T13:00:00.000Z");
    // The same instant is sendable as-is in Chicago.
    expect(next("2026-11-18T01:30:00Z")).toBe("2026-11-18T01:30:00.000Z");
  });
});

describe("Kyle's approval reminder keeps Monday to Friday (team answer 8)", () => {
  it("is sendable on a weekday inside the window and never on a Saturday or Sunday", () => {
    expect(isReminderSendableNow(utc("2026-11-24T18:00:00Z"))).toBe(true); // Tue noon CST
    expect(isReminderSendableNow(utc("2026-11-24T14:00:00Z"))).toBe(true); // Tue 8 AM CST
    expect(isReminderSendableNow(utc("2026-11-25T02:00:00Z"))).toBe(false); // Tue 8 PM CST
    expect(isReminderSendableNow(utc("2026-11-21T18:00:00Z"))).toBe(false); // Sat noon CST
    expect(isReminderSendableNow(utc("2026-11-22T18:00:00Z"))).toBe(false); // Sun noon CST
  });

  it("the same Saturday instant is open to a customer and closed to a reminder: the rules do not drift", () => {
    const sat = utc("2026-11-21T18:00:00Z");
    expect(isSendableNow(sat)).toBe(true);
    expect(isReminderSendableNow(sat)).toBe(false);
  });

  it("a weekend moment waits for Monday 8:00 AM, and Friday 9 PM does too", () => {
    const nextR = (iso: string) => nextReminderSendableAt(utc(iso)).toISOString();
    expect(nextR("2026-11-21T18:00:00Z")).toBe("2026-11-23T14:00:00.000Z"); // Sat noon
    expect(nextR("2026-11-21T03:00:00Z")).toBe("2026-11-23T14:00:00.000Z"); // Fri 9 PM CST
    expect(nextR("2026-11-24T11:00:00Z")).toBe("2026-11-24T14:00:00.000Z"); // Tue 5 AM
  });
});

describe("the window helpers", () => {
  it("parses and validates HH:MM", () => {
    expect(parseClock("08:00")).toBe(480);
    expect(parseClock("23:59")).toBe(1439);
    expect(parseClock("24:00")).toBeNull();
    expect(parseClock("8:00")).toBeNull();
    expect(isValidQuietWindow({ start: "08:00", end: "20:00" })).toBe(true);
    expect(isValidQuietWindow({ start: "20:00", end: "08:00" })).toBe(false);
    expect(isValidQuietWindow({ start: "08:00", end: "08:00" })).toBe(false);
  });
});
