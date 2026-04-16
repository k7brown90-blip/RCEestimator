/**
 * Scheduling service — transactional job scheduling with calendar + DB + SMS.
 * All scheduling operations wrap calendar update + DB update + both SMS sends.
 * If any SMS fails, the calendar change is rolled back.
 */

import { prisma } from "../lib/prisma";
import { createCalendarEvent, deleteCalendarEvent, moveCalendarEvent, checkAvailabilityBlock } from "./schedule";
import * as notify from "./notifications";

const TZ = "America/Chicago";
const DEFAULT_START_TIME = process.env.DEFAULT_JOB_START_TIME ?? "07:00";

// ─── TYPES ──────────────────────────────────────────────────────────────────────

export interface ScheduleJobResult {
  jobId: string;
  scheduledStart: Date;
  scheduledEnd: Date;
  durationDays: number;
  customerNotified: boolean;
  kyleNotified: boolean;
  googleEventId: string;
}

// ─── HELPERS ────────────────────────────────────────────────────────────────────

function formatTimeCT(d: Date): string {
  return d.toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" });
}

/** Parse "HH:MM" to {hour, minute} */
function parseTime(timeStr: string): { hour: number; minute: number } {
  const [h, m] = timeStr.split(":").map(Number);
  return { hour: h || 7, minute: m || 0 };
}

/** Build a CT date from a YYYY-MM-DD string and optional HH:MM time */
function buildStartDate(dateStr: string, timeStr?: string | null): Date {
  const [year, month, day] = dateStr.split("-").map(Number);
  const { hour, minute } = parseTime(timeStr || DEFAULT_START_TIME);
  // Approximate: assume CST (UTC-6), then adjust
  const guess = new Date(Date.UTC(year, month - 1, day, hour + 6, minute));
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(guess);
  const gotH = Number(parts.find(p => p.type === "hour")!.value);
  const gotM = Number(parts.find(p => p.type === "minute")!.value);
  const wantMin = hour * 60 + minute;
  const gotMin = (gotH === 24 ? 0 : gotH) * 60 + gotM;
  return new Date(guess.getTime() - (gotMin - wantMin) * 60_000);
}

/** Compute end date given start + duration in working days (skip Sundays) */
function computeEndDate(startDate: Date, durationDays: number): Date {
  let cursor = new Date(startDate);
  let remaining = durationDays;
  while (remaining > 1) {
    cursor = new Date(cursor.getTime() + 86_400_000);
    const wd = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short" })
      .format(cursor);
    if (wd !== "Sun") remaining--;
  }
  // End at 5pm CT on the last day
  const dp = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(cursor);
  const get = (t: Intl.DateTimeFormatPartTypes) => Number(dp.find(p => p.type === t)!.value);
  const guess = new Date(Date.UTC(get("year"), get("month") - 1, get("day"), 17 + 6));
  const actual = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, hour: "2-digit", hour12: false,
  }).formatToParts(guess);
  const gotHour = Number(actual.find(p => p.type === "hour")!.value);
  return new Date(guess.getTime() - (gotHour === 24 ? 0 : gotHour - 17) * 3600_000);
}

// ─── SCHEDULE A JOB ─────────────────────────────────────────────────────────────

export async function scheduleJob(
  jobId: string,
  startDateStr: string,
  startTime?: string | null,
): Promise<ScheduleJobResult> {
  // Load the job
  const job = await prisma.visit.findUnique({
    where: { id: jobId },
    include: { customer: true, property: true },
  });
  if (!job) throw new Error("Job not found");
  if (job.status !== "contracted") throw new Error(`Job status is "${job.status}", expected "contracted"`);

  const durationDays = job.estimatedDurationDays ?? 1;
  const scheduledStart = buildStartDate(startDateStr, startTime);
  const scheduledEnd = computeEndDate(scheduledStart, durationDays);
  const timeDisplay = formatTimeCT(scheduledStart);

  // Check availability
  const availability = await checkAvailabilityBlock(scheduledStart, durationDays);
  if (!availability.available) {
    const conflictSummary = availability.conflicts.map(c => `${c.date}: ${c.reason}`).join("; ");
    throw new ConflictError(`Calendar conflict: ${conflictSummary}`, availability.conflicts);
  }

  // Create calendar event
  const calendarTitle = `JOB: ${job.customer.name} — ${job.jobType ?? "service"} — ${durationDays}d`;
  const event = await createCalendarEvent({
    summary: calendarTitle,
    description: `Job ID: ${jobId}\nCustomer: ${job.customer.name}\nPhone: ${job.customer.phone ?? "N/A"}\nAddress: ${job.property.addressLine1}`,
    location: `${job.property.addressLine1}, ${job.property.city}, ${job.property.state}`,
    startTime: scheduledStart,
    endTime: scheduledEnd,
  });

  // Build notification data
  const jobData: notify.JobData = {
    customerName: job.customer.name,
    phone: job.customer.phone ?? "",
    address: `${job.property.addressLine1}, ${job.property.city}`,
    jobType: job.jobType ?? "service work",
    scheduledStart,
    scheduledEnd,
    durationDays,
    startTime: timeDisplay,
  };

  // Send both SMS
  let customerNotified = false;
  let kyleNotified = false;

  if (job.customer.phone) {
    const customerResult = await notify.sendCustomerSms(
      job.customer.phone,
      notify.customerWorkScheduled(jobData),
    );
    customerNotified = customerResult !== null;
  }

  const kyleResult = await notify.sendKyleSms(notify.kyleWorkScheduled(jobData));
  kyleNotified = kyleResult !== null;

  // If customer SMS failed and phone was provided, roll back the calendar event
  if (job.customer.phone && !customerNotified) {
    await deleteCalendarEvent(event.id).catch(() => {});
    throw new Error("Customer SMS failed — calendar event rolled back");
  }

  // Update the job record
  await prisma.visit.update({
    where: { id: jobId },
    data: {
      status: "scheduled",
      scheduledStart,
      scheduledEnd,
      googleEventId: event.id,
    },
  });

  return {
    jobId,
    scheduledStart,
    scheduledEnd,
    durationDays,
    customerNotified,
    kyleNotified,
    googleEventId: event.id,
  };
}

// ─── RESCHEDULE A JOB ───────────────────────────────────────────────────────────

export async function rescheduleJob(
  jobId: string,
  newStartDateStr: string,
  newStartTime: string | null,
  reason: string,
): Promise<ScheduleJobResult> {
  const job = await prisma.visit.findUnique({
    where: { id: jobId },
    include: { customer: true, property: true },
  });
  if (!job) throw new Error("Job not found");
  if (!job.scheduledStart || !job.scheduledEnd) throw new Error("Job is not currently scheduled");
  if (!job.googleEventId) throw new Error("Job has no calendar event to reschedule");

  // Preserve original duration
  const durationDays = job.estimatedDurationDays ?? 1;
  const newStart = buildStartDate(newStartDateStr, newStartTime);
  const newEnd = computeEndDate(newStart, durationDays);
  const newTimeDisplay = formatTimeCT(newStart);
  const oldTimeDisplay = formatTimeCT(job.scheduledStart);

  const jobData: notify.JobData = {
    customerName: job.customer.name,
    phone: job.customer.phone ?? "",
    address: `${job.property.addressLine1}, ${job.property.city}`,
    jobType: job.jobType ?? "service work",
    scheduledStart: job.scheduledStart,
    scheduledEnd: job.scheduledEnd,
    durationDays,
    startTime: oldTimeDisplay,
  };

  // Check availability (exclude current event)
  const availability = await checkAvailabilityBlock(newStart, durationDays, job.googleEventId);
  if (!availability.available) {
    const conflictSummary = availability.conflicts.map(c => `${c.date}: ${c.reason}`).join("; ");
    // Notify Kyle about the blocked reschedule
    await notify.sendKyleSms(notify.kyleRescheduleConflict(jobData, newStart, conflictSummary));
    throw new ConflictError(
      `Calendar conflict: ${conflictSummary}`,
      availability.conflicts,
      "I wasn't able to reschedule — there's a conflict on that date. I've notified Kyle, and he'll call you back to find another date.",
    );
  }

  // Move the calendar event
  await moveCalendarEvent(job.googleEventId, newStart, newEnd);

  const oldDates: notify.DateRange = { start: job.scheduledStart, end: job.scheduledEnd, time: oldTimeDisplay };
  const newDates: notify.DateRange = { start: newStart, end: newEnd, time: newTimeDisplay };

  // Send both SMS
  let customerNotified = false;
  let kyleNotified = false;

  if (job.customer.phone) {
    const customerResult = await notify.sendCustomerSms(
      job.customer.phone,
      notify.customerReschedule(jobData, oldDates, newDates),
    );
    customerNotified = customerResult !== null;
  }

  const kyleResult = await notify.sendKyleSms(notify.kyleReschedule(jobData, oldDates, newDates, reason));
  kyleNotified = kyleResult !== null;

  // If customer SMS failed, roll back the calendar move
  if (job.customer.phone && !customerNotified) {
    await moveCalendarEvent(job.googleEventId, job.scheduledStart, job.scheduledEnd).catch(() => {});
    throw new Error("Customer SMS failed — calendar event rolled back");
  }

  // Update the job record
  await prisma.visit.update({
    where: { id: jobId },
    data: {
      scheduledStart: newStart,
      scheduledEnd: newEnd,
    },
  });

  return {
    jobId,
    scheduledStart: newStart,
    scheduledEnd: newEnd,
    durationDays,
    customerNotified,
    kyleNotified,
    googleEventId: job.googleEventId,
  };
}

// ─── ERROR TYPES ────────────────────────────────────────────────────────────────

export class ConflictError extends Error {
  conflicts: Array<{ date: string; reason: string }>;
  spokenFallback: string;

  constructor(
    message: string,
    conflicts: Array<{ date: string; reason: string }>,
    spokenFallback?: string,
  ) {
    super(message);
    this.name = "ConflictError";
    this.conflicts = conflicts;
    this.spokenFallback = spokenFallback ?? "That date has a scheduling conflict. Want to try a different date?";
  }
}
