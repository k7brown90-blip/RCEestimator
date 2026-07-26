/**
 * Slot holds — atomic day-claims that close the check-then-book race.
 *
 * The scheduling flow is read-then-write: checkAvailabilityBlock() reads the
 * calendar, then createCalendarEvent() writes it. Two concurrent voice-agent
 * calls (or an agent racing a human) can both pass the read and double-book.
 * A SlotHold row per business day, enforced by a Postgres unique constraint on
 * holdDate, makes the claim atomic: exactly one caller wins the day; the other
 * receives SlotContentionError and offers the caller a different date.
 *
 * Holds are transient. The winner releases them as soon as the calendar event
 * exists (the event itself blocks the day from then on); the TTL guarantees a
 * crashed process can never wedge a date permanently.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";

const TZ = "America/Chicago";
export const HOLD_TTL_MS = 2 * 60 * 1000; // safety net for crashed processes

export class SlotContentionError extends Error {
  dates: string[];

  constructor(dates: string[]) {
    super(`Another booking is in progress for: ${dates.join(", ")}`);
    this.name = "SlotContentionError";
    this.dates = dates;
  }
}

/** YYYY-MM-DD in Central Time. */
function dateStrCT(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
  return parts; // en-CA formats as YYYY-MM-DD
}

/**
 * Hold key for an hourly appointment slot ("YYYY-MM-DDTHH:mm" CT). Day-block
 * jobs hold whole dates ("YYYY-MM-DD"); the two key shapes never collide, and
 * cross-type conflicts are covered by the calendar freebusy check once events
 * exist — holds only need to serialize concurrent writers of the same slot.
 */
export function slotKeyCT(d: Date): string {
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
  return `${dateStrCT(d)}T${time}`;
}

/** The business days (CT, skipping Sundays) a job occupies — mirrors computeEndDate. */
export function workingDaysCT(start: Date, durationDays: number): string[] {
  const days: string[] = [dateStrCT(start)];
  let cursor = new Date(start);
  let remaining = durationDays;
  while (remaining > 1) {
    cursor = new Date(cursor.getTime() + 86_400_000);
    const wd = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short" }).format(cursor);
    if (wd !== "Sun") {
      remaining--;
      days.push(dateStrCT(cursor));
    }
  }
  return days;
}

/**
 * Atomically claim a set of business days. Throws SlotContentionError if any
 * day is actively held by someone else. Expired holds are cleared first.
 */
export async function acquireSlotHolds(
  dates: string[],
  heldBy: string,
  jobId?: string,
): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      await tx.slotHold.deleteMany({
        where: { holdDate: { in: dates }, expiresAt: { lt: new Date() } },
      });
      await tx.slotHold.createMany({
        data: dates.map((holdDate) => ({
          holdDate,
          heldBy,
          jobId: jobId ?? null,
          expiresAt: new Date(Date.now() + HOLD_TTL_MS),
        })),
      });
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw new SlotContentionError(dates);
    }
    throw err;
  }
}

/** Release held days (idempotent). */
export async function releaseSlotHolds(dates: string[]): Promise<void> {
  await prisma.slotHold.deleteMany({ where: { holdDate: { in: dates } } });
}
