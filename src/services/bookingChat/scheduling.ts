/**
 * Calendar side of the website booking chat: the slots the bot may offer and the tentative HOLD it
 * writes (plan decision A — the bot holds, the office confirms).
 *
 * The hold goes through the SAME slot-claim + freebusy re-check core Savannah's bookAppointment()
 * uses (googleCalendar.withVerifiedFreeSlot) and then writes one tentative event on the primary
 * calendar. Because the event is on the calendar, every later availability read already treats the
 * slot as taken.
 *
 * NOTHING HERE SENDS ANYTHING TO THE CUSTOMER. bookAppointment() emails and texts ungated
 * (googleCalendar.ts); the hold deliberately does not go through it. Customer confirmations belong
 * to "Confirm booking" (U3), behind the automation gate.
 */

import { prisma } from "../../lib/prisma";
import {
  BookingConflictError,
  BookingInputError,
  getAvailability,
  parseAvailabilityDate,
  withVerifiedFreeSlot,
} from "../googleCalendar";
import { createCalendarEvent, deleteCalendarEvent } from "../schedule";
import { logSystemEvent } from "../systemEvents";
import { FIXED_BLOCK_STARTS } from "./limits";
import { gateRecordedAddress } from "./serviceArea";

const TZ = "America/Chicago";
const BLOCK_HOURS = 2;
export const PLACEHOLDER_NAME = "Website chat visitor";

export interface SlotLabelParts {
  /** "Tuesday, November 3" */
  day: string;
  /** "8:00 AM – 10:00 AM" */
  window: string;
  /** "Tuesday, November 3, 8:00 AM – 10:00 AM" */
  label: string;
}

/** Day/time wording for a held block, always in Central Time — the server's words, not the model's. */
export function describeBlock(start: Date, end: Date): SlotLabelParts {
  const day = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "long", month: "long", day: "numeric" }).format(start);
  const t = (d: Date) => new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" }).format(d);
  const window = `${t(start)} – ${t(end)}`;
  return { day, window, label: `${day}, ${window}` };
}

/** "Tuesday, November 3" for a YYYY-MM-DD, with no timezone drift. */
function dayLabelFromYmd(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric" })
    .format(new Date(Date.UTC(y, m - 1, d, 12)));
}

/** Today's date in Central Time as YYYY-MM-DD. */
export function todayYmdCT(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function isRealYmd(ymd: string): boolean {
  const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

export interface OfferedSlot {
  date: string;
  startTime: string;
  endTime: string;
  day: string;
  window: string;
}

/**
 * The fixed 2-hour blocks that are free on every company calendar, earliest first.
 *
 * NEVER TODAY. Kyle's prompt: "Never promise … same-day service." The earliest block the bot may
 * offer is tomorrow (Central Time) — getAvailability() would otherwise hand back this afternoon's
 * blocks.
 */
export async function listOfferableSlots(opts: { fromDate?: string; limit?: number }): Promise<{
  slots: OfferedSlot[];
  unreachableCalendars: string[];
}> {
  let startDate: Date | undefined;
  if (opts.fromDate) {
    if (!isRealYmd(opts.fromDate)) throw new BookingInputError(`Bad from_date: "${opts.fromDate}"`);
    startDate = parseAvailabilityDate(opts.fromDate, "12:00");
  }
  const avail = await getAvailability(startDate);
  if (avail.unreachable_calendars.length > 0) {
    // Slots are still returned — availability for those calendars is unknown, not free, and Kyle needs to see it.
    logSystemEvent("warn", "bookingChat", "get_available_slots: freebusy could not read some calendars; offered slots may be incomplete", {
      unreachableCalendars: avail.unreachable_calendars,
    });
  }
  const limit = Math.max(1, Math.min(opts.limit ?? 12, 24));
  const today = todayYmdCT();
  const slots = avail.slots.filter((s) => s.date > today).slice(0, limit).map((s) => ({
    date: s.date,
    startTime: s.startTime,
    endTime: s.endTime,
    day: dayLabelFromYmd(s.date),
    window: s.label,
  }));
  return { slots, unreachableCalendars: avail.unreachable_calendars };
}

export type HoldResult =
  | { ok: true; alreadyHeld: boolean; start: Date; end: Date; label: string; day: string; window: string }
  | { ok: false; code: "need_details" | "need_zip" | "out_of_area" | "bad_slot" | "slot_taken" | "calendar_error"; message: string };

/**
 * Hold one fixed block for a chat. The SERVER decides whether the slot is legal: it must be one of
 * the four fixed blocks, in the future, free on every calendar at this moment, and the chat's Lead
 * must have a real name, phone and an address in the service area.
 *
 * One hold per chat: a new hold is written FIRST and the previous event deleted after, so a slot
 * that turns out to be taken never costs the customer the hold they already had.
 */
export async function holdSlotForChat(
  chatId: string,
  args: { date: string; startTime: string },
): Promise<HoldResult> {
  const chat = await prisma.bookingChat.findUnique({ where: { id: chatId }, include: { lead: true } });
  if (!chat) return { ok: false, code: "calendar_error", message: "chat not found" };
  const lead = chat.lead;

  if (!lead || lead.name === PLACEHOLDER_NAME || !lead.phone || !lead.address) {
    return {
      ok: false,
      code: "need_details",
      message: "Cannot hold a time yet: the customer's name, phone number and service address must all be recorded with update_work_order first.",
    };
  }

  const gate = await gateRecordedAddress(lead.address);
  if (!gate.ok) return { ok: false, code: gate.code, message: gate.message };

  if (!(FIXED_BLOCK_STARTS as readonly string[]).includes(args.startTime) || !isRealYmd(args.date)) {
    return {
      ok: false,
      code: "bad_slot",
      message: `Only the fixed blocks ${FIXED_BLOCK_STARTS.join(", ")} on a real date can be held. Use a date and startTime exactly as returned by get_available_slots.`,
    };
  }
  const start = parseAvailabilityDate(args.date, args.startTime);
  const end = new Date(start.getTime() + BLOCK_HOURS * 3_600_000);
  if (start.getTime() <= Date.now()) {
    return { ok: false, code: "bad_slot", message: "That time has already started or passed. Offer times from get_available_slots." };
  }
  // Same-day service is never promised. A date model-typed as "today" is refused as well as one not offered.
  if (args.date <= todayYmdCT()) {
    return { ok: false, code: "bad_slot", message: "Same-day appointments are not offered. The earliest day is tomorrow; offer times from get_available_slots." };
  }
  // getAvailability() only looks 30 days out; a hold beyond that was never offered.
  if (start.getTime() > Date.now() + 35 * 86_400_000) {
    return { ok: false, code: "bad_slot", message: "That date is too far ahead. Offer times from get_available_slots." };
  }
  const parts = describeBlock(start, end);

  // Asking for the block already held is a no-op, not a conflict with our own event.
  if (chat.heldEventId && chat.heldStart && chat.heldStart.getTime() === start.getTime()) {
    return { ok: true, alreadyHeld: true, start, end, ...parts };
  }

  const summary = `HOLD: ${lead.name} — ${lead.address.substring(0, 60)}`;
  const description = [
    "Website booking chat HOLD — not confirmed.",
    `Lead ${lead.id}: ${lead.name}, ${lead.phone}${lead.email ? `, ${lead.email}` : ""}`,
    "Confirm booking or Release hold from the lead on the CRM Leads page.",
  ].join("\n");

  let eventId: string;
  try {
    eventId = await withVerifiedFreeSlot(start, end, "booking-chat", async () => {
      const ev = await createCalendarEvent({
        summary,
        description,
        location: lead.address ?? undefined,
        startTime: start,
        endTime: end,
      });
      return ev.id;
    });
  } catch (err) {
    if (err instanceof BookingConflictError) {
      return { ok: false, code: "slot_taken", message: "That time was just taken. Offer other times from get_available_slots." };
    }
    logSystemEvent("error", "bookingChat", "Calendar hold failed", {
      chatId, error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, code: "calendar_error", message: "The calendar could not be reached. Do not promise a time; offer the office phone number." };
  }

  const previousEventId = chat.heldEventId;
  await prisma.bookingChat.update({
    where: { id: chatId },
    data: { heldEventId: eventId, heldStart: start, heldEnd: end, status: "held" },
  });

  if (previousEventId && previousEventId !== eventId) {
    try {
      await deleteCalendarEvent(previousEventId);
    } catch (err) {
      // A leaked HOLD would block a slot nobody is coming for — make it findable.
      logSystemEvent("error", "bookingChat", "Previous HOLD event could not be deleted — remove it from the calendar by hand", {
        chatId, eventId: previousEventId, error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { ok: true, alreadyHeld: false, start, end, ...parts };
}
