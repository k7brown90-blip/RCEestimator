/**
 * Booking input parsing + availability integrity.
 *
 * The 2026-08-02 incident: Vapi sent 24-hour times ("13:00") to /calendar/book,
 * parseAvailabilityDate only accepted "1:00 PM", every booking 500'd, and
 * Savannah confirmed appointments that never reached the calendar. These tests
 * pin the tolerant parser and the unreachable-calendar reporting.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/lib/prisma";

process.env.GOOGLE_CLIENT_ID = "test_id";
process.env.GOOGLE_CLIENT_SECRET = "test_secret";
process.env.GOOGLE_REFRESH_TOKEN = "test_token";

vi.mock("../src/services/twilio", () => ({
  sendSms: vi.fn().mockResolvedValue({ sid: "SM_mock_sid" }),
  KYLE_PHONE: "+19706661626",
  isFromKyle: vi.fn().mockReturnValue(false),
}));
// freebusy answers for primary only — any tech calendar in the request is
// silently omitted, exactly how Google reports an unshared calendar.
vi.mock("googleapis", () => {
  class MockOAuth2 {
    setCredentials() {}
  }
  return {
    google: {
      auth: { OAuth2: MockOAuth2 },
      calendar: () => ({
        freebusy: {
          query: vi.fn().mockResolvedValue({ data: { calendars: { primary: { busy: [] } } } }),
        },
        events: { insert: vi.fn().mockResolvedValue({ data: { id: "gcal_mock_id" } }) },
      }),
    },
  };
});

import { parseAvailabilityDate, BookingInputError, getAvailability } from "../src/services/googleCalendar";

const TECH_EMAIL = "parse-test-tech@redcedarelectricllc.com";

afterAll(async () => {
  await prisma.technician.deleteMany({ where: { email: TECH_EMAIL } });
});

describe("parseAvailabilityDate", () => {
  // 2026-10-13 is CDT (UTC-5)
  it("parses the availability-response format: 'Tuesday, October 13, 2026' + '10:00 AM'", () => {
    expect(parseAvailabilityDate("Tuesday, October 13, 2026", "10:00 AM").toISOString())
      .toBe("2026-10-13T15:00:00.000Z");
  });

  it("parses 24-hour times — what Vapi's tool calls actually send", () => {
    expect(parseAvailabilityDate("2026-10-13", "13:00").toISOString())
      .toBe("2026-10-13T18:00:00.000Z");
    expect(parseAvailabilityDate("2026-10-13", "08:00").toISOString())
      .toBe("2026-10-13T13:00:00.000Z");
  });

  it("parses ISO dates without weekday prefix", () => {
    expect(parseAvailabilityDate("2026-10-13", "10:00 AM").toISOString())
      .toBe("2026-10-13T15:00:00.000Z");
  });

  it("handles 12-hour edge cases: 12 AM, 12 PM, no-minutes '1 PM', lowercase 'pm'", () => {
    expect(parseAvailabilityDate("2026-10-13", "12:00 AM").toISOString())
      .toBe("2026-10-13T05:00:00.000Z");
    expect(parseAvailabilityDate("2026-10-13", "12:00 PM").toISOString())
      .toBe("2026-10-13T17:00:00.000Z");
    expect(parseAvailabilityDate("2026-10-13", "1 PM").toISOString())
      .toBe("2026-10-13T18:00:00.000Z");
    expect(parseAvailabilityDate("2026-10-13", "1:30pm").toISOString())
      .toBe("2026-10-13T18:30:00.000Z");
  });

  it("is DST-aware: January is CST (UTC-6)", () => {
    expect(parseAvailabilityDate("2027-01-13", "13:00").toISOString())
      .toBe("2027-01-13T19:00:00.000Z");
  });

  it("throws BookingInputError (not a bare Error) on garbage", () => {
    expect(() => parseAvailabilityDate("2026-10-13", "one o'clock")).toThrow(BookingInputError);
    expect(() => parseAvailabilityDate("sometime next week", "10:00 AM")).toThrow(BookingInputError);
    expect(() => parseAvailabilityDate("2026-10-13", "25:00")).toThrow(BookingInputError);
  });
});

describe("getAvailability unreachable calendars", () => {
  it("reports a tech calendar Google omits instead of treating it as free", async () => {
    await prisma.technician.create({
      data: { name: "Parse Test Tech", email: TECH_EMAIL, accessToken: `parse-test-${Date.now()}`, isActive: true },
    });

    const availability = await getAvailability();
    expect(availability.unreachable_calendars).toContain(TECH_EMAIL);
    expect(availability.unreachable_calendars).not.toContain("primary");
  });
});
