import { google } from "googleapis";

import { sendConfirmationEmail, sendKyleNotificationEmail } from "./confirmationEmail";
import { customerVisitConfirmation, customerDiagnosticConfirmation, kyleNewBooking, sendCustomerSms, sendKyleSms } from "./notifications";
import { acquireSlotHolds, releaseSlotHolds, slotKeyCT, SlotContentionError } from "./slotHolds";
import { companyCalendarIds } from "./techCalendars";
import { logSystemEvent } from "./systemEvents";

const TZ = "America/Chicago";
const BUSINESS_START = 8;  // 8 AM CT
const BUSINESS_END = 16;   // 4 PM CT
const LOOKAHEAD_DAYS = 30;
const SLOT_DURATION = 2;   // 2-hour appointment windows

// Calendar set comes from services/techCalendars.ts (primary + EXTRA_CALENDAR_IDS
// env + every active technician's Workspace calendar).

interface SlotTime {
  start: string;
  end: string;
}

interface DayAvailability {
  date: string;
  slots: SlotTime[];
  timezone: string;
}

/** One fixed scheduling block, in the shape Vapi's tools consume directly. */
interface FixedBlockSlot {
  date: string;      // YYYY-MM-DD
  startTime: string; // "08:00" | "10:00" | "12:00" | "14:00"
  endTime: string;   // "10:00" | "12:00" | "14:00" | "16:00"
  label: string;
}

interface AvailabilityResponse {
  available_slots: DayAvailability[];
  /** Fixed 8-10/10-12/12-2/2-4 CT blocks only — never an odd window like 3-5. */
  slots: FixedBlockSlot[];
  current_time_central: string;
  current_date_central: string;
  /** Calendar IDs Google omitted or errored on — availability for these is UNKNOWN, not free. */
  unreachable_calendars: string[];
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

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** "08:00"-style label for a business-hour integer, e.g. 14 -> "14:00". */
function hourLabel(hour: number): string {
  return `${pad2(hour)}:00`;
}

function ymd(year: number, month: number, day: number): string {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

const BLOCK_LABELS: Record<number, string> = {
  8: "Morning 8–10",
  10: "Late morning 10–12",
  12: "Midday 12–2",
  14: "Afternoon 2–4",
};

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

  // Union of the whole company calendar set — primary + env extras + every
  // active technician's Workspace calendar. A slot any tech has claimed is
  // busy for everyone; per-tech granularity lives in the CRM's tech picker.
  const calendarIds = await companyCalendarIds();

  const response = await calendar.freebusy.query({
    requestBody: {
      timeMin: windowStart.toISOString(),
      timeMax: windowEnd.toISOString(),
      timeZone: TZ,
      items: calendarIds.map((id) => ({ id })),
    },
  });

  const calendarsData = response.data.calendars ?? {};

  // Google's freebusy OMITS calendars the token can't read instead of erroring,
  // so an unshared tech calendar is indistinguishable from a perfectly free one.
  const unreachableCalendars = calendarIds.filter((id) => {
    const cal = calendarsData[id] as { errors?: unknown[] } | undefined;
    return !cal || (Array.isArray(cal.errors) && cal.errors.length > 0);
  });
  if (unreachableCalendars.length > 0) {
    logSystemEvent("warn", "googleCalendar", `freebusy could not read ${unreachableCalendars.length} calendar(s) — availability may be incomplete`, {
      unreachableCalendars,
    });
  }

  const busyPeriods = Object.values(calendarsData)
    .flatMap(cal => ((cal as any).busy ?? []).map((b: any) => ({
      start: new Date(b.start!),
      end: new Date(b.end!),
    })));

  busyPeriods.sort((a, b) => a.start.getTime() - b.start.getTime());

  const days: DayAvailability[] = [];
  const flatSlots: FixedBlockSlot[] = [];

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
        flatSlots.push({
          date: ymd(dayParts.year, dayParts.month, dayParts.day),
          startTime: hourLabel(wStart),
          endTime: hourLabel(wEnd),
          label: BLOCK_LABELS[wStart] ?? `${hourLabel(wStart)}–${hourLabel(wEnd)}`,
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
    slots: flatSlots,
    current_time_central: formatTime(now),
    current_date_central: formatDate(now),
    unreachable_calendars: unreachableCalendars,
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
  visitType?: "estimate" | "diagnostic"; // defaults to "estimate"
}

interface BookingResult {
  eventId: string;
  start: string;
  end: string;
  summary: string;
}

/** Bad date/time input from the caller's tool arguments — a 400, not a 500. */
export class BookingInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BookingInputError";
  }
}

function parseTimeString(timeStr: string): { hour: number; minute: number } {
  const t = timeStr.trim();

  // 12-hour: "10:00 AM", "1 PM", "1:30pm"
  const ampm = t.match(/^(\d{1,2})(?::(\d{2}))?\s*([AaPp])\.?[Mm]\.?$/);
  if (ampm) {
    let hour = parseInt(ampm[1]);
    const minute = ampm[2] ? parseInt(ampm[2]) : 0;
    if (hour >= 1 && hour <= 12 && minute <= 59) {
      const isPm = ampm[3].toLowerCase() === "p";
      if (isPm && hour !== 12) hour += 12;
      if (!isPm && hour === 12) hour = 0;
      return { hour, minute };
    }
  }

  // 24-hour: "13:00", "08:00" — the format Vapi's tool calls actually send.
  const h24 = t.match(/^(\d{1,2}):(\d{2})$/);
  if (h24) {
    const hour = parseInt(h24[1]);
    const minute = parseInt(h24[2]);
    if (hour <= 23 && minute <= 59) return { hour, minute };
  }

  throw new BookingInputError(`Cannot parse time: "${timeStr}" (use "10:00 AM" or 24-hour "13:00")`);
}

export function parseAvailabilityDate(dateStr: string, timeStr: string): Date {
  const { hour, minute } = parseTimeString(timeStr);

  // ISO "2026-08-05" — parsed by hand so it can't shift a day across timezones.
  const iso = dateStr.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    return centralToUtc(Number(iso[1]), Number(iso[2]), Number(iso[3]), hour, minute);
  }

  // "Wednesday, April 16, 2026" (availability response format) or "April 16, 2026"
  const withoutWeekday = dateStr.replace(/^[A-Za-z]+,\s*/, "");
  const dateParsed = new Date(withoutWeekday);
  if (isNaN(dateParsed.getTime())) {
    throw new BookingInputError(`Cannot parse date: "${dateStr}"`);
  }

  return centralToUtc(dateParsed.getFullYear(), dateParsed.getMonth() + 1, dateParsed.getDate(), hour, minute);
}

export class BookingConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BookingConflictError";
  }
}

export async function bookAppointment(params: BookingParams): Promise<BookingResult> {
  const calendar = getCalendarClient();
  const isDiagnostic = params.visitType === "diagnostic";
  const durationHours = isDiagnostic ? 2 : SLOT_DURATION;
  const startUtc = parseAvailabilityDate(params.date, params.startTime);
  const endUtc = new Date(startUtc.getTime() + durationHours * 3600_000);

  // Serialize concurrent bookings of the same slot (check-then-book race):
  // claim the slot atomically, then RE-verify the window against the calendar
  // before writing — this endpoint previously inserted blind.
  const slotKey = slotKeyCT(startUtc);
  try {
    await acquireSlotHolds([slotKey], "vapi-booking");
  } catch (err) {
    if (err instanceof SlotContentionError) {
      throw new BookingConflictError("Someone else is booking that time right now — please pick a different slot.");
    }
    throw err;
  }

  let eventId: string;
  const prefix = isDiagnostic ? "DIAG" : "EST";
  const summary = `${prefix}: ${params.customerName} — ${params.address.substring(0, 60)}`;
  try {
    // Re-check the whole company calendar set, not just primary — the
    // availability read promised the slot against every tech's calendar.
    const recheckIds = await companyCalendarIds();
    const freebusy = await calendar.freebusy.query({
      requestBody: {
        timeMin: startUtc.toISOString(),
        timeMax: endUtc.toISOString(),
        items: recheckIds.map((id) => ({ id })),
      },
    });
    const busy = Object.values(freebusy.data.calendars ?? {})
      .flatMap((cal) => (cal as { busy?: unknown[] }).busy ?? []);
    if (busy.length > 0) {
      throw new BookingConflictError("That time was just taken — please pick a different slot.");
    }

    const inserted = await calendar.events.insert({
      calendarId: "primary",
      requestBody: {
        summary,
        description: params.description,
        location: params.address,
        start: { dateTime: startUtc.toISOString(), timeZone: TZ },
        end: { dateTime: endUtc.toISOString(), timeZone: TZ },
      },
    });
    eventId = inserted.data.id!;
  } finally {
    await releaseSlotHolds([slotKey]);
  }

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
      jobType: isDiagnostic ? `Diagnostic ($175 flat fee) — ${params.description}` : params.description,
    }).catch(err => console.error("[bookAppointment] Customer email failed:", err));
  }

  // Send dual SMS notifications (fire-and-forget)
  const visitData: import("./notifications").VisitData = {
    customerName: params.customerName,
    phone: params.phone ?? "",
    address: params.address,
    date: startUtc,
    time: params.startTime,
    jobDescription: params.description,
  };

  // Customer SMS
  if (params.phone) {
    const customerMsg = isDiagnostic
      ? customerDiagnosticConfirmation(visitData)
      : customerVisitConfirmation(visitData);
    sendCustomerSms(params.phone, customerMsg)
      .catch(err => console.error("[bookAppointment] Customer SMS failed:", err));
  }

  // Kyle SMS
  sendKyleSms(kyleNewBooking({ ...visitData, urgency: isDiagnostic ? "Diagnostic ($175)" : undefined }))
    .catch(err => console.error("[bookAppointment] Kyle SMS failed:", err));

  // Kyle notification email (fire-and-forget)
  const kyleBody = [
    `Customer: ${params.customerName}`,
    params.phone ? `Phone: ${params.phone}` : null,
    params.email ? `Email: ${params.email}` : null,
    `Address: ${params.address}`,
    `Date: ${params.date} at ${params.startTime}`,
    `Type: ${isDiagnostic ? "Diagnostic ($175)" : "Free Estimate"}`,
    `Description: ${params.description}`,
  ].filter(Boolean).join("\n");
  sendKyleNotificationEmail(isDiagnostic ? "New Diagnostic Booked" : "New Estimate Booked", kyleBody)
    .catch(err => console.error("[bookAppointment] Kyle email failed:", err));

  return {
    eventId,
    start: startUtc.toISOString(),
    end: endUtc.toISOString(),
    summary,
  };
}
