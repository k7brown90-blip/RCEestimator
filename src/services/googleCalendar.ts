import { google } from "googleapis";

const TZ = "America/Chicago";
const BUSINESS_START = 8;  // 8 AM CT
const BUSINESS_END = 17;   // 5 PM CT
const LOOKAHEAD_DAYS = 7;

interface AvailableSlot {
  date: string;
  start: string;
  end: string;
  timezone: string;
}

interface AvailabilityResponse {
  available_slots: AvailableSlot[];
  current_time_central: string;
  current_date_central: string;
}

// ── Timezone helpers (no external tz library) ────────────────────────────────

function getCentralParts(d: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
  }).formatToParts(d);

  const get = (t: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === t)!.value);

  const wdMap: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  const wdStr = parts.find((p) => p.type === "weekday")!.value;

  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour") === 24 ? 0 : get("hour"),
    minute: get("minute"),
    weekday: wdMap[wdStr] ?? 0,
  };
}

/** Convert Central Time components → UTC Date, handling CST/CDT automatically */
function centralToUtc(year: number, month: number, day: number, hour: number, minute = 0): Date {
  // Initial guess assuming CST (UTC-6)
  const guess = new Date(Date.UTC(year, month - 1, day, hour + 6, minute));
  const actual = getCentralParts(guess);
  const wantMin = hour * 60 + minute;
  const gotMin = actual.hour * 60 + actual.minute;
  const delta = gotMin - wantMin;
  return new Date(guess.getTime() - delta * 60_000);
}

function formatDate(d: Date): string {
  return d.toLocaleDateString("en-US", {
    timeZone: TZ,
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

function formatTime(d: Date): string {
  return d.toLocaleTimeString("en-US", {
    timeZone: TZ,
    hour: "numeric",
    minute: "2-digit",
  });
}

// ── Google Calendar client ───────────────────────────────────────────────────

function getCalendarClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "Missing Google Calendar credentials. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN.",
    );
  }

  const auth = new google.auth.OAuth2(clientId, clientSecret);
  auth.setCredentials({ refresh_token: refreshToken });
  return google.calendar({ version: "v3", auth });
}

// ── Main availability function ───────────────────────────────────────────────

export async function getAvailability(): Promise<AvailabilityResponse> {
  const calendar = getCalendarClient();
  const now = new Date();
  const nowCt = getCentralParts(now);

  // Build 7-day query window starting from today in CT
  const windowStart = centralToUtc(nowCt.year, nowCt.month, nowCt.day, 0);
  const endParts = getCentralParts(new Date(windowStart.getTime() + LOOKAHEAD_DAYS * 86_400_000));
  const windowEnd = centralToUtc(endParts.year, endParts.month, endParts.day, 23, 59);

  const response = await calendar.freebusy.query({
    requestBody: {
      timeMin: windowStart.toISOString(),
      timeMax: windowEnd.toISOString(),
      timeZone: TZ,
      items: [{ id: "primary" }],
    },
  });

  const busyPeriods = (response.data.calendars?.["primary"]?.busy ?? []).map((b) => ({
    start: new Date(b.start!),
    end: new Date(b.end!),
  }));

  busyPeriods.sort((a, b) => a.start.getTime() - b.start.getTime());

  const slots: { start: Date; end: Date }[] = [];

  // For each of the next 7 days, compute free slots within business hours
  for (let offset = 0; offset < LOOKAHEAD_DAYS; offset++) {
    const dayBase = new Date(windowStart.getTime() + offset * 86_400_000);
    const dayParts = getCentralParts(dayBase);

    // Skip weekends
    if (dayParts.weekday === 0 || dayParts.weekday === 6) continue;

    const dayStart = centralToUtc(dayParts.year, dayParts.month, dayParts.day, BUSINESS_START);
    const dayEnd = centralToUtc(dayParts.year, dayParts.month, dayParts.day, BUSINESS_END);

    // Skip entire day if it's already past business hours
    if (dayEnd.getTime() <= now.getTime()) continue;

    // Effective start is max(dayStart, now)
    const effectiveStart = dayStart.getTime() < now.getTime() ? now : dayStart;

    // Filter busy periods that overlap this day's business hours
    const dayBusy = busyPeriods.filter(
      (b) => b.start.getTime() < dayEnd.getTime() && b.end.getTime() > dayStart.getTime(),
    );

    // Interval complement: walk through busy periods, collect gaps
    let cursor = effectiveStart;

    for (const busy of dayBusy) {
      const clippedStart = busy.start.getTime() < dayStart.getTime() ? dayStart : busy.start;
      const clippedEnd = busy.end.getTime() > dayEnd.getTime() ? dayEnd : busy.end;

      if (cursor.getTime() < clippedStart.getTime()) {
        slots.push({ start: new Date(cursor.getTime()), end: clippedStart });
      }
      if (clippedEnd.getTime() > cursor.getTime()) {
        cursor = clippedEnd;
      }
    }

    // Remaining gap after last busy period
    if (cursor.getTime() < dayEnd.getTime()) {
      slots.push({ start: new Date(cursor.getTime()), end: dayEnd });
    }
  }

  return {
    available_slots: slots.map((s) => ({
      date: formatDate(s.start),
      start: formatTime(s.start),
      end: formatTime(s.end),
      timezone: "Central Time",
    })),
    current_time_central: formatTime(now),
    current_date_central: formatDate(now),
  };
}
