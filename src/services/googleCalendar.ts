import { google } from "googleapis";

import { sendConfirmationEmail, sendKyleNotificationEmail } from "./confirmationEmail";

const TZ = "America/Chicago";
const BUSINESS_START = 8;  // 8 AM CT
const BUSINESS_END = 16;   // 4 PM CT
const LOOKAHEAD_DAYS = 30;
const SLOT_DURATION = 2;   // 2-hour appointment windows

// Comma-separated list of additional calendar IDs to check for conflicts
const EXTRA_CALENDAR_IDS = (process.env.EXTRA_CALENDAR_IDS ?? "").split(",").filter(Boolean);

interface SlotTime {
  start: string;
  end: string;
}

interface DayAvailability {
  date: string;
  slots: SlotTime[];
  timezone: string;
}

interface AvailabilityResponse {
  available_slots: DayAvailability[];
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
    year: "numeric",
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

export async function getAvailability(startDate?: Date): Promise<AvailabilityResponse> {
  const calendar = getCalendarClient();
  const now = new Date();
  const baseDate = startDate ?? now;
  const baseCt = getCentralParts(baseDate);

  // Build query window starting from baseDate in CT
  const windowStart = centralToUtc(baseCt.year, baseCt.month, baseCt.day, 0);
  const endParts = getCentralParts(new Date(windowStart.getTime() + LOOKAHEAD_DAYS * 86_400_000));
  const windowEnd = centralToUtc(endParts.year, endParts.month, endParts.day, 23, 59);

  const calendarItems = [
    { id: "primary" },
    ...EXTRA_CALENDAR_IDS.map(id => ({ id: id.trim() })),
  ];

  const response = await calendar.freebusy.query({
    requestBody: {
      timeMin: windowStart.toISOString(),
      timeMax: windowEnd.toISOString(),
      timeZone: TZ,
      items: calendarItems,
    },
  });

  const calendarsData = response.data.calendars ?? {};
  const busyPeriods = Object.values(calendarsData)
    .flatMap(cal => ((cal as any).busy ?? []).map((b: any) => ({
      start: new Date(b.start!),
      end: new Date(b.end!),
    })));

  busyPeriods.sort((a, b) => a.start.getTime() - b.start.getTime());

  const days: DayAvailability[] = [];

  // For each of the next 7 days, generate 2-hour appointment windows
  for (let offset = 0; offset < LOOKAHEAD_DAYS; offset++) {
    const dayBase = new Date(windowStart.getTime() + offset * 86_400_000);
    const dayParts = getCentralParts(dayBase);

    // Skip weekends
    if (dayParts.weekday === 0 || dayParts.weekday === 6) continue;

    const dayEnd = centralToUtc(dayParts.year, dayParts.month, dayParts.day, BUSINESS_END);

    // Skip entire day if it's already past business hours
    if (dayEnd.getTime() <= now.getTime()) continue;

    // Filter busy periods that overlap this day's business hours
    const dayStart = centralToUtc(dayParts.year, dayParts.month, dayParts.day, BUSINESS_START);
    const dayBusy = busyPeriods.filter(
      (b) => b.start.getTime() < dayEnd.getTime() && b.end.getTime() > dayStart.getTime(),
    );

    // Generate fixed 2-hour windows: 8-10, 10-12, 12-2, 1-3
    const windowStarts = [8, 10, 12, 14]; // 8-10, 10-12, 12-2, 2-4
    const freeSlots: SlotTime[] = [];

    for (const wStart of windowStarts) {
      const wEnd = wStart + SLOT_DURATION;
      if (wEnd > BUSINESS_END) continue;

      const slotStart = centralToUtc(dayParts.year, dayParts.month, dayParts.day, wStart);
      const slotEnd = centralToUtc(dayParts.year, dayParts.month, dayParts.day, wEnd);

      // Skip if slot is entirely in the past
      if (slotEnd.getTime() <= now.getTime()) continue;

      // Check if any busy period overlaps this slot
      const conflict = dayBusy.some(
        (b) => b.start.getTime() < slotEnd.getTime() && b.end.getTime() > slotStart.getTime(),
      );

      if (!conflict) {
        freeSlots.push({
          start: formatTime(slotStart),
          end: formatTime(slotEnd),
        });
      }
    }

    if (freeSlots.length > 0) {
      days.push({
        date: formatDate(dayStart),
        slots: freeSlots,
        timezone: "Central Time",
      });
    }
  }

  return {
    available_slots: days,
    current_time_central: formatTime(now),
    current_date_central: formatDate(now),
  };
}

// ── Book appointment ────────────────────────────────────────────────────────

interface BookingParams {
  date: string;         // "Wednesday, April 16, 2026" (from availability response)
  startTime: string;    // "10:00 AM" (from availability response)
  customerName: string;
  description: string;
  address: string;
  phone?: string;
  email?: string;
}

interface BookingResult {
  eventId: string;
  start: string;
  end: string;
  summary: string;
}

function parseAvailabilityDate(dateStr: string, timeStr: string): Date {
  // Parse "Wednesday, April 16, 2026" + "10:00 AM"
  // Remove weekday prefix: "April 16, 2026"
  const withoutWeekday = dateStr.replace(/^\w+,\s*/, "");

  // Parse time: "10:00 AM" → hour 10, minute 0
  const timeMatch = timeStr.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!timeMatch) throw new Error(`Cannot parse time: "${timeStr}"`);
  let hour = parseInt(timeMatch[1]);
  const minute = parseInt(timeMatch[2]);
  const ampm = timeMatch[3].toUpperCase();
  if (ampm === "PM" && hour !== 12) hour += 12;
  if (ampm === "AM" && hour === 12) hour = 0;

  // Parse date: "April 16, 2026"
  const dateParsed = new Date(withoutWeekday);
  if (isNaN(dateParsed.getTime())) {
    throw new Error(`Cannot parse date: "${dateStr}"`);
  }
  const month = dateParsed.getMonth() + 1;
  const day = dateParsed.getDate();
  const year = dateParsed.getFullYear();

  return centralToUtc(year, month, day, hour, minute);
}

export async function bookAppointment(params: BookingParams): Promise<BookingResult> {
  const calendar = getCalendarClient();
  const startUtc = parseAvailabilityDate(params.date, params.startTime);
  const endUtc = new Date(startUtc.getTime() + SLOT_DURATION * 3600_000);

  const summary = `RCE: ${params.customerName} — ${params.description.substring(0, 80)}`;

  const event = await calendar.events.insert({
    calendarId: "primary",
    requestBody: {
      summary,
      description: params.description,
      location: params.address,
      start: { dateTime: startUtc.toISOString(), timeZone: TZ },
      end: { dateTime: endUtc.toISOString(), timeZone: TZ },
    },
  });

  const endTimeStr = formatTime(endUtc);
  const appointmentWindow = `${params.startTime} – ${endTimeStr}`;

  // Send confirmation email to customer (fire-and-forget)
  if (params.email) {
    sendConfirmationEmail({
      customerName: params.customerName,
      customerEmail: params.email,
      appointmentDate: params.date,
      appointmentWindow,
      serviceAddress: params.address,
      jobType: params.description,
    }).catch(err => console.error("[bookAppointment] Customer email failed:", err));
  }

  // Notify Kyle (fire-and-forget)
  const kyleBody = [
    `Customer: ${params.customerName}`,
    params.phone ? `Phone: ${params.phone}` : null,
    params.email ? `Email: ${params.email}` : null,
    `Address: ${params.address}`,
    `Date: ${params.date} at ${params.startTime}`,
    `Description: ${params.description}`,
  ].filter(Boolean).join("\n");
  sendKyleNotificationEmail("New Estimate Booked", kyleBody)
    .catch(err => console.error("[bookAppointment] Kyle email failed:", err));

  return {
    eventId: event.data.id!,
    start: startUtc.toISOString(),
    end: endUtc.toISOString(),
    summary,
  };
}
