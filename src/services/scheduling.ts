/**
 * Scheduling service — transactional job scheduling with calendar + DB + SMS.
 * All scheduling operations wrap calendar update + DB update + both SMS sends.
 * If any SMS fails, the calendar change is rolled back.
 */

import { prisma } from "../lib/prisma";
import { createCalendarEvent, deleteCalendarEvent, moveCalendarEvent, checkAvailabilityBlock } from "./schedule";
import * as notify from "./notifications";
import { sendRescheduleEmail, sendCancellationEmail, sendKyleNotificationEmail } from "./confirmationEmail";

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

  // Send both SMS (will silently fail while A2P is pending)
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

  // Send email notifications (primary channel while A2P is pending)
  const formatDateLong = (d: Date) => d.toLocaleDateString("en-US", { timeZone: TZ, weekday: "long", month: "long", day: "numeric", year: "numeric" });

  if (job.customer.email) {
    const { sendConfirmationEmail: sendEmail } = await import("./confirmationEmail");
    sendEmail({
      customerName: job.customer.name,
      customerEmail: job.customer.email,
      appointmentDate: formatDateLong(scheduledStart),
      appointmentWindow: `${timeDisplay} – ${formatTimeCT(scheduledEnd)}`,
      serviceAddress: `${job.property.addressLine1}, ${job.property.city}`,
      jobType: job.jobType ?? undefined,
    }).catch(err => console.error("[scheduleJob] Customer email failed:", err));
    customerNotified = true;
  }

  sendKyleNotificationEmail("Job Scheduled", [
    `Customer: ${job.customer.name}`,
    `Phone: ${job.customer.phone ?? "N/A"}`,
    `Address: ${job.property.addressLine1}, ${job.property.city}`,
    `Job: ${job.jobType ?? "service work"} — ${durationDays} day(s)`,
    `Start: ${formatDateLong(scheduledStart)} at ${timeDisplay}`,
  ].join("\n")).catch(err => console.error("[scheduleJob] Kyle email failed:", err));

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

  // Send both SMS (will silently fail while A2P is pending)
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

  // Send email notifications (primary channel while A2P is pending)
  const formatDateLong = (d: Date) => d.toLocaleDateString("en-US", { timeZone: TZ, weekday: "long", month: "long", day: "numeric", year: "numeric" });

  if (job.customer.email) {
    sendRescheduleEmail({
      customerName: job.customer.name,
      customerEmail: job.customer.email,
      oldDate: formatDateLong(oldDates.start),
      oldWindow: oldDates.time,
      newDate: formatDateLong(newDates.start),
      newWindow: newDates.time,
      serviceAddress: `${job.property.addressLine1}, ${job.property.city}`,
      jobType: job.jobType ?? undefined,
    }).catch(err => console.error("[rescheduleJob] Customer email failed:", err));
    customerNotified = true;
  }

  const kyleRescheduleBody = [
    `Customer: ${job.customer.name}`,
    `Phone: ${job.customer.phone ?? "N/A"}`,
    `Address: ${job.property.addressLine1}, ${job.property.city}`,
    `Was: ${oldDates.start.toLocaleDateString("en-US", { timeZone: TZ })} at ${oldDates.time}`,
    `Now: ${newDates.start.toLocaleDateString("en-US", { timeZone: TZ })} at ${newDates.time}`,
    `Reason: ${reason}`,
  ].join("\n");
  sendKyleNotificationEmail("Job Rescheduled", kyleRescheduleBody)
    .catch(err => console.error("[rescheduleJob] Kyle email failed:", err));

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

// ─── CANCEL A JOB ──────────────────────────────────────────────────────────────

export async function cancelJob(
  jobId: string,
  reason: string,
): Promise<{ cancelled: true; customerNotified: boolean; kyleNotified: boolean }> {
  const job = await prisma.visit.findUnique({
    where: { id: jobId },
    include: { customer: true, property: true },
  });
  if (!job) throw new Error("Job not found");
  if (!job.scheduledStart || !job.scheduledEnd) throw new Error("Job is not currently scheduled");

  // Delete calendar event if exists
  if (job.googleEventId) {
    await deleteCalendarEvent(job.googleEventId).catch(err =>
      console.error("[cancelJob] Calendar delete failed:", err),
    );
  }

  const timeDisplay = formatTimeCT(job.scheduledStart);
  const formatDateLong = (d: Date) => d.toLocaleDateString("en-US", { timeZone: TZ, weekday: "long", month: "long", day: "numeric", year: "numeric" });

  let customerNotified = false;
  let kyleNotified = false;

  // Send customer cancellation email
  if (job.customer.email) {
    const sent = await sendCancellationEmail({
      customerName: job.customer.name,
      customerEmail: job.customer.email,
      appointmentDate: formatDateLong(job.scheduledStart),
      serviceAddress: `${job.property.addressLine1}, ${job.property.city}`,
      jobType: job.jobType ?? undefined,
    }).catch(() => false);
    customerNotified = sent === true;
  }

  // Send customer cancellation SMS (will work once A2P is approved)
  if (job.customer.phone) {
    const jobData: notify.JobData = {
      customerName: job.customer.name,
      phone: job.customer.phone,
      address: `${job.property.addressLine1}, ${job.property.city}`,
      jobType: job.jobType ?? "service work",
      scheduledStart: job.scheduledStart,
      scheduledEnd: job.scheduledEnd,
      durationDays: job.estimatedDurationDays ?? 1,
      startTime: timeDisplay,
    };
    const smsResult = await notify.sendCustomerSms(job.customer.phone, notify.customerCancellation(jobData));
    if (smsResult) customerNotified = true;
  }

  // Notify Kyle
  const kyleBody = [
    `Customer: ${job.customer.name}`,
    `Phone: ${job.customer.phone ?? "N/A"}`,
    `Address: ${job.property.addressLine1}, ${job.property.city}`,
    `Was: ${formatDateLong(job.scheduledStart)} at ${timeDisplay}`,
    `Reason: ${reason}`,
  ].join("\n");
  const kyleEmailSent = await sendKyleNotificationEmail("Job Cancelled", kyleBody).catch(() => false);
  const kyleSmsSent = await notify.sendKyleSms(`CANCELLED: ${job.customer.name} — ${formatDateLong(job.scheduledStart)} at ${timeDisplay}. Reason: ${reason}`);
  kyleNotified = kyleEmailSent === true || kyleSmsSent !== null;

  // Update the job record
  await prisma.visit.update({
    where: { id: jobId },
    data: {
      status: "cancelled",
      googleEventId: null,
      scheduledStart: null,
      scheduledEnd: null,
    },
  });

  return { cancelled: true, customerNotified, kyleNotified };
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
