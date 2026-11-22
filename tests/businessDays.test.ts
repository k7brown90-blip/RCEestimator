import { describe, expect, it } from "vitest";
import {
  addBusinessDays, isBusinessDay, zonedParts, zonedWallToInstant,
} from "../shared/businessDays";

/**
 * Monday-Friday in America/Chicago, no holiday list (work order agent-team, step 0). Every instant
 * below is written in UTC so the test does not depend on the machine's own time zone; the Chicago
 * reading is in the comment. 2026 US daylight saving: springs forward Sun Mar 8, falls back Sun Nov 1.
 */
const utc = (iso: string) => new Date(iso);

describe("isBusinessDay", () => {
  it("is true Monday through Friday and false on the weekend, by the Chicago date", () => {
    expect(isBusinessDay(utc("2026-11-16T18:00:00Z"))).toBe(true); // Mon noon CST
    expect(isBusinessDay(utc("2026-11-20T18:00:00Z"))).toBe(true); // Fri noon CST
    expect(isBusinessDay(utc("2026-11-21T18:00:00Z"))).toBe(false); // Sat noon CST
    expect(isBusinessDay(utc("2026-11-22T18:00:00Z"))).toBe(false); // Sun noon CST
  });

  it("changes day at Chicago midnight, not at UTC midnight", () => {
    expect(isBusinessDay(utc("2026-11-21T05:59:00Z"))).toBe(true); // Fri 11:59 PM CST
    expect(isBusinessDay(utc("2026-11-21T06:00:00Z"))).toBe(false); // Sat 12:00 AM CST
    expect(isBusinessDay(utc("2026-11-23T05:59:00Z"))).toBe(false); // Sun 11:59 PM CST
    expect(isBusinessDay(utc("2026-11-23T06:00:00Z"))).toBe(true); // Mon 12:00 AM CST
    // 11 PM Friday Chicago is already Saturday in UTC, and is still a business day here.
    expect(isBusinessDay(utc("2026-11-21T04:30:00Z"))).toBe(true);
  });

  it("follows the zone it is given", () => {
    // Fri 11:30 PM Chicago is Sat 12:30 AM in New York.
    expect(isBusinessDay(utc("2026-11-21T05:30:00Z"), "America/Chicago")).toBe(true);
    expect(isBusinessDay(utc("2026-11-21T05:30:00Z"), "America/New_York")).toBe(false);
  });
});

describe("addBusinessDays", () => {
  it("keeps the Chicago time of day: Friday 3 PM + 1 is Monday 3 PM", () => {
    const fri3pm = utc("2026-11-20T21:00:00Z"); // Fri 3:00 PM CST
    expect(addBusinessDays(fri3pm, 1).toISOString()).toBe("2026-11-23T21:00:00.000Z"); // Mon 3:00 PM CST
  });

  it("counts only weekdays: Thursday + 2 is the next Monday, Monday + 2 is Wednesday", () => {
    expect(addBusinessDays(utc("2026-11-19T16:00:00Z"), 2).toISOString()).toBe("2026-11-23T16:00:00.000Z");
    expect(addBusinessDays(utc("2026-11-16T16:00:00Z"), 2).toISOString()).toBe("2026-11-18T16:00:00.000Z");
  });

  it("starting on a weekend, day 1 is the Monday", () => {
    expect(addBusinessDays(utc("2026-11-21T18:00:00Z"), 1).toISOString()).toBe("2026-11-23T18:00:00.000Z"); // Sat
    expect(addBusinessDays(utc("2026-11-22T18:00:00Z"), 1).toISOString()).toBe("2026-11-23T18:00:00.000Z"); // Sun
    expect(addBusinessDays(utc("2026-11-21T18:00:00Z"), 2).toISOString()).toBe("2026-11-24T18:00:00.000Z");
  });

  it("0 returns the same instant, and negative counts walk backward over the weekend", () => {
    const sat = utc("2026-11-21T18:00:00Z");
    expect(addBusinessDays(sat, 0).getTime()).toBe(sat.getTime());
    expect(addBusinessDays(utc("2026-11-23T16:00:00Z"), -1).toISOString()).toBe("2026-11-20T16:00:00.000Z"); // Mon -> Fri
  });

  it("holds the Chicago wall-clock hour across the fall-back change (Nov 1)", () => {
    // Fri Oct 30 3:00 PM CDT = 20:00Z. Monday Nov 2 3:00 PM CST = 21:00Z.
    expect(addBusinessDays(utc("2026-10-30T20:00:00Z"), 1).toISOString()).toBe("2026-11-02T21:00:00.000Z");
  });

  it("holds the Chicago wall-clock hour across the spring-forward change (Mar 8)", () => {
    // Fri Mar 6 3:00 PM CST = 21:00Z. Monday Mar 9 3:00 PM CDT = 20:00Z.
    expect(addBusinessDays(utc("2026-03-06T21:00:00Z"), 1).toISOString()).toBe("2026-03-09T20:00:00.000Z");
  });

  it("rejects a fractional count", () => {
    expect(() => addBusinessDays(new Date(), 1.5)).toThrow(RangeError);
  });
});

describe("zonedWallToInstant (daylight saving)", () => {
  it("reads an ordinary wall time in winter (CST) and summer (CDT)", () => {
    expect(zonedWallToInstant(2026, 11, 23, 8, 0).toISOString()).toBe("2026-11-23T14:00:00.000Z");
    expect(zonedWallToInstant(2026, 7, 6, 8, 0).toISOString()).toBe("2026-07-06T13:00:00.000Z");
  });

  it("a wall time inside the spring-forward gap lands an hour later, never earlier", () => {
    // 2:30 AM does not exist on Mar 8 2026; it reads as 3:30 AM CDT = 08:30Z.
    const at = zonedWallToInstant(2026, 3, 8, 2, 30);
    expect(at.toISOString()).toBe("2026-03-08T08:30:00.000Z");
    expect(zonedParts(at).hour).toBe(3);
  });

  it("a wall time that happens twice on the fall-back day resolves to the first one", () => {
    // 1:30 AM on Nov 1 2026 is 06:30Z (CDT) and again 07:30Z (CST). The first.
    expect(zonedWallToInstant(2026, 11, 1, 1, 30).toISOString()).toBe("2026-11-01T06:30:00.000Z");
  });

  it("works for a zone that is not Chicago", () => {
    expect(zonedWallToInstant(2026, 11, 18, 8, 0, "America/New_York").toISOString()).toBe("2026-11-18T13:00:00.000Z");
  });
});
