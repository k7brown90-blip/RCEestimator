/**
 * Technician Google Calendars — the availability source for scheduling.
 *
 * Techs are onboarded with company Workspace emails; `Technician.email` IS the
 * tech's Google Calendar ID. Everything that answers "when are we free?" —
 * Savannah's availability tool, the CRM scheduler, block-availability checks —
 * unions these calendars with the primary so a slot one tech has claimed is
 * never offered twice.
 *
 * The per-tech read (`techAvailabilityForDate`) powers the CRM's tech picker:
 * pick a date, see each tech's busy blocks, assign the one who's open.
 *
 * Silent-exclusion warning: Google's freebusy API OMITS calendars the token
 * cannot read rather than erroring. An unshared calendar looks exactly like a
 * free tech. Every consumer here treats "absent from the response" as
 * "calendar not accessible" and says so, and the Team page probe
 * (`probeTechCalendar`) sets `Technician.calendarShared` explicitly.
 */

import { google } from "googleapis";
import { prisma } from "../lib/prisma";

const TZ = "America/Chicago";

// Legacy additive list — kept so the owner's personal calendar can stay in the
// availability union without being a Technician row.
const EXTRA_CALENDAR_IDS = (process.env.EXTRA_CALENDAR_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);

export interface TechCalendar {
  technicianId: string;
  name: string;
  email: string;
}

/** Active technicians that have a calendar email on file. */
export async function activeTechCalendars(): Promise<TechCalendar[]> {
  const techs = await prisma.technician.findMany({
    where: { isActive: true, email: { not: null } },
    select: { id: true, name: true, email: true },
    orderBy: { createdAt: "asc" },
  });
  return techs.map((t) => ({ technicianId: t.id, name: t.name, email: t.email! }));
}

/**
 * The full calendar-ID set for company-wide availability: primary + env extras
 * + every active tech. De-duplicated because the owner's own address may appear
 * both as EXTRA_CALENDAR_IDS and as a Technician row.
 */
export async function companyCalendarIds(): Promise<string[]> {
  const techs = await activeTechCalendars();
  const ids = new Set<string>(["primary", ...EXTRA_CALENDAR_IDS, ...techs.map((t) => t.email)]);
  return [...ids];
}

function calendarClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("Missing Google Calendar credentials. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN.");
  }
  const auth = new google.auth.OAuth2(clientId, clientSecret);
  auth.setCredentials({ refresh_token: refreshToken });
  return google.calendar({ version: "v3", auth });
}

export interface BusyBlock {
  start: string;      // ISO
  end: string;        // ISO
  startLocal: string; // formatted CT
  endLocal: string;
}

export interface TechDayAvailability {
  technicianId: string;
  name: string;
  email: string;
  /** False when Google omitted this calendar — not shared with the app's account. */
  calendarAccessible: boolean;
  busy: BusyBlock[];
}

function formatTimeCT(d: Date): string {
  return d.toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" });
}

/** Convert CT wall-clock on a YYYY-MM-DD date to UTC, DST-safe. */
export function ctToUtc(dateStr: string, hour: number, minute = 0): Date {
  const [year, month, day] = dateStr.split("-").map(Number);
  const guess = new Date(Date.UTC(year, month - 1, day, hour + 6, minute));
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(guess);
  const get = (t: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === t)!.value);
  const gotMin = (get("hour") === 24 ? 0 : get("hour")) * 60 + get("minute");
  return new Date(guess.getTime() - (gotMin - (hour * 60 + minute)) * 60_000);
}

/**
 * Per-tech busy blocks for one CT calendar day (00:00–23:59).
 * Techs whose calendars Google omits come back with calendarAccessible=false
 * and are surfaced to the scheduler as "can't see their calendar" — never as free.
 */
export async function techAvailabilityForDate(dateStr: string): Promise<TechDayAvailability[]> {
  const techs = await activeTechCalendars();
  if (techs.length === 0) return [];

  const calendar = calendarClient();
  const timeMin = ctToUtc(dateStr, 0).toISOString();
  const timeMax = ctToUtc(dateStr, 23, 59).toISOString();

  const response = await calendar.freebusy.query({
    requestBody: {
      timeMin,
      timeMax,
      timeZone: TZ,
      items: techs.map((t) => ({ id: t.email })),
    },
  });

  const calendars = response.data.calendars ?? {};

  return techs.map((tech) => {
    const cal = calendars[tech.email] as { busy?: Array<{ start?: string | null; end?: string | null }>; errors?: unknown[] } | undefined;
    // Omitted from the response, or returned with errors → not readable.
    const accessible = !!cal && !(Array.isArray(cal.errors) && cal.errors.length > 0);
    const busy: BusyBlock[] = accessible
      ? (cal!.busy ?? []).map((b) => {
          const start = new Date(b.start!);
          const end = new Date(b.end!);
          return { start: start.toISOString(), end: end.toISOString(), startLocal: formatTimeCT(start), endLocal: formatTimeCT(end) };
        })
      : [];
    return { technicianId: tech.technicianId, name: tech.name, email: tech.email, calendarAccessible: accessible, busy };
  });
}

/**
 * One-tech probe for the Team page's "verify calendar access" button.
 * Persists the outcome to Technician.calendarShared.
 */
export async function probeTechCalendar(technicianId: string): Promise<{ accessible: boolean; email: string | null }> {
  const tech = await prisma.technician.findUniqueOrThrow({
    where: { id: technicianId },
    select: { email: true },
  });
  if (!tech.email) return { accessible: false, email: null };

  const calendar = calendarClient();
  const now = new Date();
  const response = await calendar.freebusy.query({
    requestBody: {
      timeMin: now.toISOString(),
      timeMax: new Date(now.getTime() + 86_400_000).toISOString(),
      timeZone: TZ,
      items: [{ id: tech.email }],
    },
  });
  const cal = response.data.calendars?.[tech.email] as { errors?: unknown[] } | undefined;
  const accessible = !!cal && !(Array.isArray(cal.errors) && cal.errors.length > 0);

  await prisma.technician.update({ where: { id: technicianId }, data: { calendarShared: accessible } });
  return { accessible, email: tech.email };
}
