/**
 * Scheduling service — transactional job scheduling with calendar + DB + SMS.
 * All scheduling operations wrap calendar update + DB update + both SMS sends.
 * If any SMS fails, the calendar change is rolled back.
 */

import { prisma } from "../lib/prisma";
import { createCalendarEvent, deleteCalendarEvent, moveCalendarEvent, checkAvailabilityBlock } from "./schedule";
import * as notify from "./notifications";
import { sendRescheduleEmail, sendCancellationEmail, sendKyleNotificationEmail } from "./confirmationEmail";
import { acquireSlotHolds, releaseSlotHolds, workingDaysCT, SlotContentionError } from "./slotHolds";
import { sendVisitConfirmationRequest, notifyTechnicianOfAssignment } from "./visitConfirmations";
import { customerSendsEnabled, logCustomerSendSkipped } from "./automationGate";

const TZ = "America/Chicago";
const DEFAULT_START_TIME = process.env.DEFAULT_JOB_START_TIME ?? "07:00";

// ─── APPOINTMENT KINDS ─────────────────────────────────────────────────────────

/**
 * Estimates and production work occupy the calendar very differently.
 *
 * A production job claims whole business days through SlotHold, because the crew
 * is committed for the duration. An estimate is a 2-hour visit plus an hour of
 * travel leeway — claiming a whole day for it would burn capacity the owner
 * still needs to sell into. So estimates book by the hour and never take a hold.
 *
 * The kind is derived from Visit.status rather than stored, so there's no way
 * for a job to be scheduled as one kind and reported as the other.
 */
export type AppointmentKind = "estimate" | "production";

export const ESTIMATE_BLOCK_MINUTES = 120;
// Kyle, 2026-09-03: "get rid of the 3 hour back end scheduling. It needs to
// match the 2 hour blocks that are available to schedule." An estimate books
// exactly its 2-hour slot - no travel padding on the calendar event.
export const ESTIMATE_TRAVEL_BUFFER_MINUTES = 0;

export function appointmentKindFor(visitStatus: string): AppointmentKind {
  return visitStatus === "estimate" ? "estimate" : "production";
}

/** Statuses from which a visit may be put on the calendar. */
const SCHEDULABLE_STATUSES = ["estimate", "contracted"] as const;

/** Fire-and-forget: notify every tech assigned to a visit about an event. */
async function notifyAssignedTechs(visitId: string, event: "assigned" | "changed" | "cancelled"): Promise<void> {
  const assignments = await prisma.visitAssignment.findMany({
    where: { visitId, status: { in: ["assigned", "in_progress"] } },
    select: { technicianId: true },
  });
  await Promise.all(assignments.map((a) => notifyTechnicianOfAssignment(a.technicianId, visitId, event)));
}

// ─── TYPES ──────────────────────────────────────────────────────────────────────

export interface ScheduleJobResult {
  jobId: string;
  scheduledStart: Date;
  scheduledEnd: Date;
  durationDays: number;
  appointmentKind: AppointmentKind;
  /** Minutes of travel leeway reserved after an estimate block; 0 for production. */
  travelBufferMinutes: number;
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

/**
 * Compute end date given start + duration in consecutive calendar days.
 * Weekends count (Kyle, 2026-08-30) — mirrors workingDaysCT in slotHolds.
 */
function computeEndDate(startDate: Date, durationDays: number): Date {
  let cursor = new Date(startDate);
  let remaining = durationDays;
  while (remaining > 1) {
    cursor = new Date(cursor.getTime() + 86_400_000);
    remaining--;
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

/** Explicit end of the scheduled block (Kyle, 2026-09-02: "update the scheduling
 *  time with a start and end time/date... I should be able to schedule over
 *  multiple days"). Date + optional time; when absent the old duration-derived
 *  end stands, so every existing caller keeps working. */
export interface ScheduleEnd {
  date: string; // YYYY-MM-DD
  time?: string | null; // HH:MM CT; defaults to 16:00
}

/** Calendar days spanned, inclusive, from two YYYY-MM-DD strings. */
function calendarDaysInclusive(startDateStr: string, endDateStr: string): number {
  const [sy, sm, sd] = startDateStr.split("-").map(Number);
  const [ey, em, ed] = endDateStr.split("-").map(Number);
  const a = Date.UTC(sy, sm - 1, sd);
  const b = Date.UTC(ey, em - 1, ed);
  return Math.round((b - a) / 86_400_000) + 1;
}

export async function scheduleJob(
  jobId: string,
  startDateStr: string,
  startTime?: string | null,
  technicianId?: string | null,
  end?: ScheduleEnd | null,
): Promise<ScheduleJobResult> {
  // Load the job
  const job = await prisma.visit.findUnique({
    where: { id: jobId },
    include: { customer: true, property: true },
  });
  if (!job) throw new Error("Job not found");
  if (!SCHEDULABLE_STATUSES.includes(job.status as (typeof SCHEDULABLE_STATUSES)[number])) {
    throw new Error(`Job status is "${job.status}", expected one of ${SCHEDULABLE_STATUSES.join(", ")}`);
  }

  // Resolve the assigned tech up front — their email goes on the calendar
  // event as an attendee, so the booking lands on their own calendar and
  // their availability reflects it immediately.
  const technician = technicianId
    ? await prisma.technician.findUnique({ where: { id: technicianId }, select: { id: true, email: true, name: true } })
    : null;
  if (technicianId && !technician) throw new Error("Technician not found");

  const kind = appointmentKindFor(job.status);
  const isEstimate = kind === "estimate";
  const travelBufferMinutes = isEstimate ? ESTIMATE_TRAVEL_BUFFER_MINUTES : 0;

  // ── THE DEPOSIT GATE (Kyle, 2026-08-25) ────────────────────────────────────
  // "We need to implement a 1/3 deposit on every job. Deposit required before
  // it can be scheduled. This is different from estimates."
  // Production work only — estimate appointments book freely. Money at or past
  // ⅓ of the billed total (card via the deposit link, or cash/check recorded
  // by hand) opens the gate. A job with no signed estimate has no total to
  // take a third of, so it is not gated — the signature is the moment the
  // deposit starts existing.
  if (!isEstimate) {
    const est = await prisma.issuedEstimate.findFirst({
      where: {
        signedAt: { not: null },
        status: { not: "void" },
        OR: [{ jobVisitId: jobId }, { visitId: jobId }],
      },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    if (est) {
      const { paymentSummary } = await import("./stripePayments");
      const summary = await paymentSummary(prisma, est.id, "https://unused.invalid");
      if (summary && !summary.depositSatisfied) {
        throw new ConflictError(
          `Deposit required before scheduling: $${(summary.depositDue - summary.depositPaid).toFixed(2)} of the ` +
          `$${summary.depositDue.toFixed(2)} deposit (1/3 of $${summary.billedTotal.toFixed(2)}) is still unpaid. ` +
          `Take the deposit — card via the Take payment panel, or record the cash/check — then schedule.`,
          [],
        );
      }
    }
  }

  // An estimate is a fixed 2-hour block regardless of the job's day estimate —
  // durationDays only describes the work, not the visit that prices it.
  // Production work with an EXPLICIT end (Kyle, 2026-09-02): the block is what
  // the operator set — days and daily hours derive from it, never the reverse.
  const scheduledStart = buildStartDate(startDateStr, startTime);
  const explicitEnd = !isEstimate && end ? buildStartDate(end.date, end.time ?? "16:00") : null;
  if (explicitEnd && explicitEnd.getTime() <= scheduledStart.getTime()) {
    throw new ConflictError(
      "The end of the job must be after its start.",
      [],
      "The end date/time is before the start — check the dates.",
    );
  }
  const durationDays = isEstimate
    ? 1
    : explicitEnd
      ? calendarDaysInclusive(startDateStr, end!.date)
      : (job.estimatedDurationDays ?? 1);
  const scheduledEnd = isEstimate
    ? new Date(scheduledStart.getTime() + ESTIMATE_BLOCK_MINUTES * 60_000)
    : explicitEnd ?? computeEndDate(scheduledStart, durationDays);
  // Hours per working day, off the block's own clock — this is the "we track
  // the hours for each job" number the P&L schedules against.
  const dailyHours = explicitEnd
    ? (() => {
        const startMin = scheduledStart.getUTCHours() * 60 + scheduledStart.getUTCMinutes();
        const endMin = scheduledEnd.getUTCHours() * 60 + scheduledEnd.getUTCMinutes();
        const span = (endMin - startMin + 1440) % 1440;
        return span > 0 ? Math.round((span / 60) * 100) / 100 : null;
      })()
    : null;
  const timeDisplay = formatTimeCT(scheduledStart);

  // Production work claims the business days atomically BEFORE the availability
  // read, so two concurrent bookings can't both pass the check. Estimates skip
  // the hold entirely — they don't own the day, so there's nothing to contend.
  const holdDates = isEstimate ? [] : workingDaysCT(scheduledStart, durationDays);
  if (holdDates.length > 0) {
    try {
      await acquireSlotHolds(holdDates, "scheduler", jobId);
    } catch (err) {
      if (err instanceof SlotContentionError) {
        throw new ConflictError(
          `Another booking is in progress for ${err.dates.join(", ")}`,
          err.dates.map((date) => ({ date, reason: "booking in progress" })),
          "Someone else is booking that date right now. Want to try a different date?",
        );
      }
      throw err;
    }
  }

  let event: { id: string };
  try {
    if (!isEstimate) {
      // The check defends the block Kyle actually set - not the whole business
      // day - and never counts this job's own existing calendar event against
      // itself (a prior booking of the same job is not a conflict).
      const availability = await checkAvailabilityBlock(
        scheduledStart,
        durationDays,
        job.googleEventId ?? undefined,
        { start: scheduledStart, end: scheduledEnd },
      );
      if (!availability.available) {
        const conflictSummary = availability.conflicts.map(c => `${c.date}: ${c.reason}`).join("; ");
        throw new ConflictError(`Calendar conflict: ${conflictSummary}`, availability.conflicts);
      }
    }

    // The estimate event runs long by the travel buffer so the calendar — and
    // therefore the availability the voice agents read — reserves the drive.
    const eventEnd = new Date(scheduledEnd.getTime() + travelBufferMinutes * 60_000);
    const calendarTitle = isEstimate
      ? `ESTIMATE: ${job.customer.name} — ${job.jobType ?? "site visit"}`
      : `JOB: ${job.customer.name} — ${job.jobType ?? "service"} — ${durationDays}d`;
    event = await createCalendarEvent({
      summary: calendarTitle,
      description: [
        `Job ID: ${jobId}`,
        `Customer: ${job.customer.name}`,
        `Phone: ${job.customer.phone ?? "N/A"}`,
        `Address: ${job.property.addressLine1}`,
        ...(technician ? [`Technician: ${technician.name}`] : []),
        ...(travelBufferMinutes > 0 ? [`Includes ${travelBufferMinutes} min travel leeway after the visit.`] : []),
      ].join("\n"),
      location: `${job.property.addressLine1}, ${job.property.city}, ${job.property.state}`,
      startTime: scheduledStart,
      endTime: eventEnd,
      attendees: technician?.email ? [technician.email] : undefined,
    });
  } finally {
    // The calendar event itself blocks the days from here on (or the booking
    // failed) — either way the transient hold has done its job.
    if (holdDates.length > 0) await releaseSlotHolds(holdDates);
  }

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

  // Update the job record.
  //
  // An estimate visit stays at status "estimate" once booked — it's still at the
  // estimate stage of the funnel, and "scheduled" is reserved for production work
  // that's been contracted. Booked-ness is expressed by scheduledStart, not status.
  // This also keeps appointmentKindFor() honest: flipping the status here would
  // make a booked estimate report itself as production work.
  await prisma.visit.update({
    where: { id: jobId },
    data: {
      ...(isEstimate ? {} : { status: "scheduled" }),
      scheduledStart,
      scheduledEnd,
      // An explicit block writes the job's tracked span (Kyle, 2026-09-02);
      // a derived end leaves the stored estimates alone.
      ...(explicitEnd ? { estimatedDurationDays: durationDays, ...(dailyHours ? { estimatedDurationHours: dailyHours } : {}) } : {}),
      googleEventId: event.id,
      confirmationStatus: "unconfirmed",
      confirmedAt: null,
      reminderSentAt: null,
    },
  });

  // Dual-channel confirmation request + tech notifications (fire-and-forget)
  //
  // GATED (manual-first, 2026-08-11) — AND THIS ONE IS A JUDGMENT CALL, FLAGGED IN THE REPORT.
  // A human triggers the booking, so the send is arguably "attended". It is gated anyway
  // because manual-first means Kyle is the one talking to the customer, and an automatic
  // "you're booked" text landing alongside his own call is the double-touch the ruling avoids.
  // The booking itself, the calendar event and the tech notification are all UNAFFECTED —
  // only the customer-facing confirmation is suppressed. One env var reverses this.
  if (!customerSendsEnabled("bookingConfirmations")) {
    logCustomerSendSkipped("bookingConfirmations", `Confirmation request for visit ${jobId} suppressed; booking and calendar event unaffected.`);
  } else
  sendVisitConfirmationRequest({
    visitId: jobId,
    customerName: job.customer.name,
    email: job.customer.email,
    phone: job.customer.phone,
    address: `${job.property.addressLine1}, ${job.property.city}`,
    scheduledStart,
    jobType: job.jobType,
  }).catch((err) => console.error("[scheduleJob] Confirmation request failed:", err));

  // Assign the selected tech (upsert — rebooking the same pair just refreshes it),
  // then notify everyone assigned, including them.
  if (technician) {
    await prisma.visitAssignment.upsert({
      where: { visitId_technicianId: { visitId: jobId, technicianId: technician.id } },
      create: { visitId: jobId, technicianId: technician.id, role: "primary" },
      update: { status: "assigned", completedAt: null },
    });
  }
  notifyAssignedTechs(jobId, "assigned").catch((err) => console.error("[scheduleJob] Tech notify failed:", err));

  return {
    jobId,
    scheduledStart,
    scheduledEnd,
    durationDays,
    appointmentKind: kind,
    travelBufferMinutes,
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
  end?: ScheduleEnd | null,
): Promise<ScheduleJobResult> {
  const job = await prisma.visit.findUnique({
    where: { id: jobId },
    include: { customer: true, property: true },
  });
  if (!job) throw new Error("Job not found");
  if (!job.scheduledStart || !job.scheduledEnd) throw new Error("Job is not currently scheduled");
  if (!job.googleEventId) throw new Error("Job has no calendar event to reschedule");

  // Preserve the original shape of the appointment — an estimate stays a 2-hour
  // block with its travel leeway; production work keeps its day count.
  const kind = appointmentKindFor(job.status);
  const isEstimate = kind === "estimate";
  const travelBufferMinutes = isEstimate ? ESTIMATE_TRAVEL_BUFFER_MINUTES : 0;
  const newStart = buildStartDate(newStartDateStr, newStartTime);
  const rescheduleEnd = !isEstimate && end ? buildStartDate(end.date, end.time ?? "16:00") : null;
  if (rescheduleEnd && rescheduleEnd.getTime() <= newStart.getTime()) {
    throw new ConflictError("The end of the job must be after its start.", [], "The end date/time is before the start — check the dates.");
  }
  const durationDays = isEstimate
    ? 1
    : rescheduleEnd
      ? calendarDaysInclusive(newStartDateStr, end!.date)
      : (job.estimatedDurationDays ?? 1);
  const newEnd = isEstimate
    ? new Date(newStart.getTime() + ESTIMATE_BLOCK_MINUTES * 60_000)
    : rescheduleEnd ?? computeEndDate(newStart, durationDays);
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

  // Atomically claim the target days before the availability read (same race
  // protection as scheduleJob). Estimates take no hold — they don't own the day.
  const holdDates = isEstimate ? [] : workingDaysCT(newStart, durationDays);
  if (holdDates.length > 0) {
    try {
      await acquireSlotHolds(holdDates, "scheduler", jobId);
    } catch (err) {
      if (err instanceof SlotContentionError) {
        throw new ConflictError(
          `Another booking is in progress for ${err.dates.join(", ")}`,
          err.dates.map((date) => ({ date, reason: "booking in progress" })),
          "Someone else is booking that date right now. Want to try a different date?",
        );
      }
      throw err;
    }
  }

  try {
    if (!isEstimate) {
      // Check availability (exclude current event)
      const availability = await checkAvailabilityBlock(newStart, durationDays, job.googleEventId, {
        start: newStart,
        end: newEnd,
      });
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
    }

    // Move the calendar event, keeping the travel leeway on the far side.
    await moveCalendarEvent(
      job.googleEventId,
      newStart,
      new Date(newEnd.getTime() + travelBufferMinutes * 60_000),
    );
  } finally {
    if (holdDates.length > 0) await releaseSlotHolds(holdDates);
  }

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
      ...(rescheduleEnd ? { estimatedDurationDays: durationDays } : {}),
      scheduledStart: newStart,
      scheduledEnd: newEnd,
      confirmationStatus: "unconfirmed",
      confirmedAt: null,
      reminderSentAt: null,
    },
  });

  // Re-request confirmation for the new time + tech notifications (fire-and-forget)
  //
  // GATED (manual-first, 2026-08-11) — AND THIS ONE IS A JUDGMENT CALL, FLAGGED IN THE REPORT.
  // A human triggers the booking, so the send is arguably "attended". It is gated anyway
  // because manual-first means Kyle is the one talking to the customer, and an automatic
  // "you're booked" text landing alongside his own call is the double-touch the ruling avoids.
  // The booking itself, the calendar event and the tech notification are all UNAFFECTED —
  // only the customer-facing confirmation is suppressed. One env var reverses this.
  if (!customerSendsEnabled("bookingConfirmations")) {
    logCustomerSendSkipped("bookingConfirmations", `Confirmation request for visit ${jobId} suppressed; booking and calendar event unaffected.`);
  } else
  sendVisitConfirmationRequest({
    visitId: jobId,
    customerName: job.customer.name,
    email: job.customer.email,
    phone: job.customer.phone,
    address: `${job.property.addressLine1}, ${job.property.city}`,
    scheduledStart: newStart,
    jobType: job.jobType,
  }).catch((err) => console.error("[rescheduleJob] Confirmation request failed:", err));
  notifyAssignedTechs(jobId, "changed").catch((err) => console.error("[rescheduleJob] Tech notify failed:", err));

  return {
    jobId,
    scheduledStart: newStart,
    scheduledEnd: newEnd,
    durationDays,
    appointmentKind: kind,
    travelBufferMinutes,
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

  notifyAssignedTechs(jobId, "cancelled").catch((err) => console.error("[cancelJob] Tech notify failed:", err));

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
