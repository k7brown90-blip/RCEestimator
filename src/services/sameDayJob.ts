/**
 * Complete work now · Schedule for later · Pause job (Kyle, 2026-09-21).
 *
 * "The field app should only have a 'complete work now' option that ties the accepted estimate
 * to the consultation. This will keep the scheduling on the admin side but allow the tech to
 * complete work now without having to go through the scheduling process. Bigger projects that
 * cannot be done same day would be labeled schedule for later and that would then go back to the
 * admin side." — and — "No notifications should be sent on the same day jobs." — and — "The
 * complete work now should have a pause job option that allows for it to be scheduled later ...
 * just in case the work doesn't get finished or if it was a mistake."
 *
 * THE SHAPE OF THE PROBLEM. At signature `createJobFromSignedEstimate` (accountSpine.ts) mints
 * a NEW job Visit for the signed estimate — status contracted, no date, no technician. The
 * consultation the tech is standing on is a different Visit. So:
 *
 *   Complete work now  = the CONSULTATION becomes the job. The signed estimate's `jobVisitId`
 *                        is repointed at the consultation, its status moves to in_progress, and
 *                        the empty job Visit minted at signature is removed — but ONLY if it is
 *                        still empty (nothing scheduled, nothing attached). One Visit carries the
 *                        estimate, the time, the P.O.s and the payments; the consultation's
 *                        calendar block stays as it is; nothing is booked.
 *   Schedule for later = the minted job stays contracted for the office to schedule; the
 *                        consultation is closed properly; the held deposit request (below) is
 *                        released. The field books NOTHING — scheduling is admin-only.
 *   Pause job          = any job underway goes back to "contracted" with its booking released,
 *                        keeping its estimate, payments, P.O.s, time and materials. The exit for
 *                        a mistaken Complete work now and for unfinished work. NOT the job
 *                        clock's pause (timeTracking.pauseJob), which only closes a time session
 *                        and leaves the job exactly where it was.
 *
 * THE NOTIFICATION GUARANTEE. The field signs through the customer's public page, whose sign
 * door fires the deposit-request email ("one step to get you scheduled") the instant the
 * signature lands — before the tech has chosen anything. So `holdOrSendDepositRequest` is what
 * the public door calls instead: when the estimate's origin visit is a LIVE technician
 * consultation (status estimate, not closed, a tech assigned, and underway — scheduled for now
 * or earlier, or never scheduled at all, as a field-created service call is), the email is HELD
 * and an `deposit_request_held` event is written on the estimate. Complete work now cancels the
 * hold (nothing is ever sent); Schedule for later releases it (the ordinary email goes out then,
 * still subject to its own "deposit required and unpaid" checks). Any other signature — from
 * home, on a closed consultation, on a visit with no technician — sends immediately, exactly as
 * before. The hold is a persisted event, not a timer: a server restart cannot lose it, and Kyle
 * can see it on the estimate's timeline.
 *
 * Nothing here sends the customer anything. Kyle's internal notification is fire-and-forget.
 */

import type { PrismaClient } from "@prisma/client";
import { logSystemEvent } from "./systemEvents";
import { sendKyleNotificationEmail } from "./confirmationEmail";
import { signedRootForJob, type InvoiceDocRow } from "./invoiceGroup";
import { createJobFromSignedEstimate } from "./accountSpine";

export const EVENT_DEPOSIT_HELD = "deposit_request_held";
export const EVENT_DEPOSIT_RELEASED = "deposit_request_released";
export const EVENT_DEPOSIT_CANCELLED = "deposit_request_cancelled";
export const EVENT_SAME_DAY_JOB = "same_day_job";
export const EVENT_SCHEDULE_FOR_LATER = "schedule_for_later";
export const EVENT_JOB_PAUSED = "job_paused";

/** Statuses a job can be paused FROM: work is underway or booked to be. */
export const PAUSABLE_STATUSES = ["in_progress", "scheduled"] as const;

export class SameDayError extends Error {
  constructor(message: string, readonly status: number = 409) {
    super(message);
    this.name = "SameDayError";
  }
}

const money = (n: number) => `$${n.toFixed(2)}`;

// ─── The deposit-request hold ────────────────────────────────────────────────

/**
 * Is a technician's consultation on this estimate still open — i.e. is the tech's choice
 * (Complete work now / Schedule for later) still ahead of us?
 */
export async function fieldChoicePending(
  prisma: PrismaClient,
  est: { visitId: string | null; jobVisitId: string | null },
  now: Date = new Date(),
): Promise<boolean> {
  if (!est.visitId) return false;
  // Already decided: the consultation IS the job (Complete work now happened).
  if (est.jobVisitId && est.jobVisitId === est.visitId) return false;
  const visit = await prisma.visit.findUnique({
    where: { id: est.visitId },
    select: { status: true, completedAt: true, scheduledStart: true, _count: { select: { assignments: true } } },
  });
  if (!visit) return false;
  if (visit.status !== "estimate" || visit.completedAt) return false;
  if (visit._count.assignments === 0) return false;
  // A consultation booked for a later day is not underway: a customer signing from home ahead of
  // it gets the ordinary deposit email now, not a hold until the appointment.
  if (visit.scheduledStart && visit.scheduledStart.getTime() > now.getTime()) return false;
  return true;
}

/**
 * The public sign door's deposit step. Sends the ordinary deposit-request email unless a
 * technician's choice is pending, in which case the request is HELD (event on the estimate) and
 * nothing goes to the customer. Returns what happened so the caller can say so to Kyle.
 */
export async function holdOrSendDepositRequest(
  prisma: PrismaClient,
  estimateId: string,
  payBaseUrl: string,
): Promise<"sent" | "held"> {
  const est = await prisma.issuedEstimate.findUnique({
    where: { id: estimateId },
    select: { id: true, number: true, visitId: true, jobVisitId: true },
  });
  if (est && (await fieldChoicePending(prisma, est))) {
    await prisma.issuedEstimateEvent.create({
      data: {
        estimateId: est.id,
        type: EVENT_DEPOSIT_HELD,
        actor: "system:sign",
        detail: "Deposit request held — a technician's consultation on this estimate is still open. "
          + "Complete work now sends nothing; Schedule for later releases it.",
      },
    });
    logSystemEvent("info", "issued-estimate", `Deposit request held on ${est.number} — technician's choice pending`, { estimateId: est.id });
    return "held";
  }
  const { sendDepositRequestEmail } = await import("./paymentReceipts");
  await sendDepositRequestEmail(prisma, estimateId, payBaseUrl);
  return "sent";
}

/** A hold that has been neither released nor cancelled. */
async function openHold(prisma: PrismaClient, estimateId: string): Promise<boolean> {
  const last = await prisma.issuedEstimateEvent.findFirst({
    where: { estimateId, type: { in: [EVENT_DEPOSIT_HELD, EVENT_DEPOSIT_RELEASED, EVENT_DEPOSIT_CANCELLED] } },
    orderBy: { at: "desc" },
    select: { type: true },
  });
  return last?.type === EVENT_DEPOSIT_HELD;
}

// ─── Shared lookups ──────────────────────────────────────────────────────────

interface ConsultationForChoice {
  visit: { id: string; status: string; completedAt: Date | null; customerId: string; propertyId: string };
  root: InvoiceDocRow;
  label: string;
}

/** The consultation and the signed root estimate written on it, or a SameDayError saying why not. */
async function consultationWithSignedRoot(prisma: PrismaClient, visitId: string): Promise<ConsultationForChoice> {
  const visit = await prisma.visit.findUnique({
    where: { id: visitId },
    select: {
      id: true, status: true, completedAt: true, customerId: true, propertyId: true,
      customer: { select: { name: true } },
      property: { select: { addressLine1: true, city: true } },
    },
  });
  if (!visit) throw new SameDayError("Visit not found.", 404);
  if (visit.status === "cancelled") throw new SameDayError("This visit was cancelled.");
  const root = await signedRootForJob(prisma, visitId);
  if (!root || !root.signedAt) {
    throw new SameDayError("No signed estimate on this visit yet — the customer signs first, then you choose.");
  }
  return {
    visit,
    root,
    label: `${visit.customer.name} — ${visit.property.addressLine1}, ${visit.property.city}`,
  };
}

// ─── Complete work now ───────────────────────────────────────────────────────

export interface CompleteWorkNowResult {
  ok: true;
  /** The one Visit that is now the job — the consultation's id. */
  jobVisitId: string;
  /** The empty job Visit minted at signature, removed here; null when none existed. */
  removedVisitId: string | null;
  /** True when this had already been done (a second tap). */
  alreadyDone: boolean;
}

/**
 * Everything that could have attached itself to the minted job in the seconds between the
 * signature and the tech's choice. Any of these present = the Visit is not empty = REFUSE rather
 * than delete (the Visit's cascades would silently take TimeEntries, photos and assignments
 * with it). IssuedEstimate rows are not in this list: they are repointed, not lost.
 */
async function attachedToVisit(prisma: PrismaClient, visitId: string): Promise<string[]> {
  const v = await prisma.visit.findUnique({
    where: { id: visitId },
    select: {
      status: true, scheduledStart: true, googleEventId: true,
      customerRequest: { select: { id: true } },
      _count: {
        select: {
          assignments: true, timeEntries: true, purchaseOrders: true, stockMovements: true, visitPhotos: true,
          documents: true, healthInspections: true, diagnosticReports: true, commissions: true,
          priceBookDrafts: true, observations: true, findings: true, limitations: true, recommendations: true,
          estimates: true,
        },
      },
    },
  });
  if (!v) return [];
  const reasons: string[] = [];
  if (v.status !== "contracted") reasons.push(`status is "${v.status}"`);
  if (v.scheduledStart || v.googleEventId) reasons.push("the office already scheduled it");
  const names: Record<keyof typeof v._count, string> = {
    assignments: "a technician assignment", timeEntries: "clocked time", purchaseOrders: "a purchase order",
    stockMovements: "material movements", visitPhotos: "photos", documents: "documents",
    healthInspections: "an inspection", diagnosticReports: "a diagnostic report", commissions: "a commission",
    priceBookDrafts: "a quote draft", observations: "observations", findings: "findings", limitations: "limitations",
    recommendations: "recommendations", estimates: "a legacy estimate",
  };
  for (const [key, count] of Object.entries(v._count) as Array<[keyof typeof v._count, number]>) {
    if (count > 0) reasons.push(names[key]);
  }
  if (v.customerRequest) reasons.push("a customer request");
  const [receipts, payments] = await Promise.all([
    prisma.receipt.count({ where: { jobId: visitId } }),
    prisma.payment.count({ where: { visitId } }),
  ]);
  if (receipts > 0) reasons.push("receipts");
  if (payments > 0) reasons.push("payments recorded against it");
  return reasons;
}

/**
 * The consultation becomes the job. Idempotent: a second tap on an already-converted visit
 * returns alreadyDone rather than failing.
 */
export async function completeWorkNow(
  prisma: PrismaClient,
  input: { visitId: string; actor: string; technicianName?: string | null },
): Promise<CompleteWorkNowResult> {
  const { visit, root, label } = await consultationWithSignedRoot(prisma, input.visitId);

  if (root.jobVisitId === visit.id) {
    return { ok: true, jobVisitId: visit.id, removedVisitId: null, alreadyDone: true };
  }
  if (visit.status !== "estimate") {
    throw new SameDayError(`This visit is already a job (status "${visit.status}").`);
  }
  if (visit.completedAt) {
    throw new SameDayError("This consultation is already closed — the job is with the office to schedule.");
  }
  if (root.visitId !== visit.id) {
    throw new SameDayError("The signed estimate was not written on this visit.");
  }

  // The job Visit minted at signature. It must still be EMPTY to be removed; anything on it means
  // somebody has started treating it as the job, and the honest answer is to stop here.
  const minted = root.jobVisitId
    ? await prisma.visit.findUnique({ where: { id: root.jobVisitId }, select: { id: true, estimatedCost: true, jobType: true } })
    : null;
  if (minted) {
    const attached = await attachedToVisit(prisma, minted.id);
    if (attached.length > 0) {
      throw new SameDayError(
        `The job created at signature already has ${attached.join(", ")} — it cannot be folded into this visit. `
        + "Use Schedule for later, or pause that job from the office.",
      );
    }
  }

  const estimatedCost = minted?.estimatedCost ?? root.total;
  const holdOpen = await openHold(prisma, root.id);

  await prisma.$transaction(async (tx) => {
    // Every signed document that named the minted job (the root and any change order that
    // joined it) now names the consultation. Done BEFORE the delete: the relation is SetNull.
    if (minted) {
      await tx.issuedEstimate.updateMany({ where: { jobVisitId: minted.id }, data: { jobVisitId: visit.id } });
      await tx.emailDelivery.updateMany({ where: { visitId: minted.id }, data: { visitId: visit.id } });
      await tx.emailBounce.updateMany({ where: { visitId: minted.id }, data: { visitId: visit.id } });
    } else {
      await tx.issuedEstimate.update({ where: { id: root.id }, data: { jobVisitId: visit.id } });
    }
    await tx.visit.update({
      where: { id: visit.id },
      data: {
        status: "in_progress",
        contractedAt: root.signedAt,
        estimatedCost,
        ...(minted?.jobType ? { jobType: minted.jobType } : {}),
      },
    });
    if (minted) await tx.visit.delete({ where: { id: minted.id } });
    await tx.issuedEstimateEvent.create({
      data: {
        estimateId: root.id,
        type: EVENT_SAME_DAY_JOB,
        actor: input.actor,
        detail: minted
          ? "Complete work now — the consultation became the job; the empty job visit minted at signature was removed."
          : "Complete work now — the consultation became the job.",
      },
    });
    if (holdOpen) {
      await tx.issuedEstimateEvent.create({
        data: {
          estimateId: root.id,
          type: EVENT_DEPOSIT_CANCELLED,
          actor: input.actor,
          detail: "Same-day job — the held deposit request is never sent (no customer notifications on a same-day job).",
        },
      });
    }
  });

  logSystemEvent("info", "jobs", `Complete work now: ${label} — consultation became the job (${root.number})`, {
    visitId: visit.id,
    estimateId: root.id,
    removedVisitId: minted?.id ?? null,
    actor: input.actor,
  });
  sendKyleNotificationEmail(
    `Same-day job started: ${label}`,
    [
      label,
      `Estimate ${root.number} — ${money(root.total)}`,
      `By: ${input.technicianName ?? input.actor}`,
      "",
      "The technician is completing the work now. Nothing to schedule; the customer has been sent nothing.",
      "If this was a mistake, Pause job (field or CRM) sends it back to scheduling.",
    ].join("\n"),
  ).catch(() => {});

  return { ok: true, jobVisitId: visit.id, removedVisitId: minted?.id ?? null, alreadyDone: false };
}

// ─── Schedule for later ──────────────────────────────────────────────────────

export interface ScheduleForLaterResult {
  ok: true;
  /** The contracted job waiting for the office to schedule. */
  jobVisitId: string;
  /** The held deposit request was released to the ordinary email path. */
  depositRequestReleased: boolean;
}

/**
 * The job goes back to the admin side. Books nothing. Closes the consultation the way the
 * office's complete-consultation door does (completedAt + archived, status untouched), releases
 * a held deposit request, and tells Kyle there is a job to schedule — not the old "quote
 * follow-up" wording, which described an unsigned estimate.
 */
export async function scheduleForLater(
  prisma: PrismaClient,
  input: { visitId: string; actor: string; technicianId?: string | null; technicianName?: string | null; payBaseUrl: string },
): Promise<ScheduleForLaterResult> {
  const { visit, root, label } = await consultationWithSignedRoot(prisma, input.visitId);
  if (root.jobVisitId === visit.id || visit.status !== "estimate") {
    throw new SameDayError("This visit is already the job — pause it to send it back to scheduling.");
  }

  // The sign door creates the job fire-and-forget; if that failed, make it here, idempotently.
  let jobVisitId = root.jobVisitId;
  if (!jobVisitId || !(await prisma.visit.findUnique({ where: { id: jobVisitId }, select: { id: true } }))) {
    const made = await createJobFromSignedEstimate(prisma, root.id, { actor: input.actor });
    if (!made.ok) throw new SameDayError(made.reason);
    jobVisitId = made.visitId;
  }

  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.visit.update({
      where: { id: visit.id },
      data: { completedAt: now, nextStep: "archived", nextStepAt: now },
    });
    await tx.visitAssignment.updateMany({
      where: { visitId: visit.id, ...(input.technicianId ? { technicianId: input.technicianId } : {}), status: { not: "completed" } },
      data: { status: "completed", completedAt: now },
    });
    await tx.issuedEstimateEvent.create({
      data: {
        estimateId: root.id,
        type: EVENT_SCHEDULE_FOR_LATER,
        actor: input.actor,
        detail: "Schedule for later — the consultation is closed; the job waits for the office to schedule it.",
      },
    });
  });

  let depositRequestReleased = false;
  if (await openHold(prisma, root.id)) {
    await prisma.issuedEstimateEvent.create({
      data: {
        estimateId: root.id,
        type: EVENT_DEPOSIT_RELEASED,
        actor: input.actor,
        detail: "Held deposit request released — sent now if a deposit is required and still unpaid.",
      },
    });
    depositRequestReleased = true;
    const { sendDepositRequestEmail } = await import("./paymentReceipts");
    await sendDepositRequestEmail(prisma, root.id, input.payBaseUrl).catch((err) =>
      console.error("[sameDayJob] released deposit request failed:", err));
  }

  const { paymentSummary } = await import("./stripePayments");
  const summary = await paymentSummary(prisma, root.id, input.payBaseUrl).catch(() => null);
  const depositLine = summary
    ? summary.depositRequired
      ? summary.depositSatisfied ? "Deposit: in." : `Deposit: ${money(summary.depositDue - summary.depositPaid)} still due — scheduling waits for it.`
      : "Deposit: not required — schedule when ready."
    : "";

  logSystemEvent("info", "jobs", `Schedule for later: ${label} — job ${jobVisitId} waits for the office (${root.number})`, {
    visitId: visit.id,
    jobVisitId,
    estimateId: root.id,
    actor: input.actor,
  });
  sendKyleNotificationEmail(
    `Job to schedule — signed in the field: ${label}`,
    [
      label,
      `Estimate ${root.number} — ${money(root.total)}, signed.`,
      `Closed by: ${input.technicianName ?? input.actor}`,
      ...(depositLine ? [depositLine] : []),
      "",
      "The technician chose Schedule for later. The job is on the calendar's unscheduled rail; book it from the CRM.",
    ].join("\n"),
  ).catch(() => {});

  return { ok: true, jobVisitId, depositRequestReleased };
}

// ─── Pause job ───────────────────────────────────────────────────────────────

export interface PauseJobResult {
  ok: true;
  visitId: string;
  /** Open clock sessions closed by the pause (their minutes are kept). */
  sessionsClosed: number;
  /** The Google event was deleted because its block had not ended yet. */
  calendarEventDeleted: boolean;
  laborHours: number;
}

/**
 * Any job underway goes back to the office to be scheduled again. Keeps EVERYTHING: the estimate
 * link, payments, P.O.s, time entries (open ones are closed first, minutes kept), materials, the
 * technician assignment. Releases the booking: status contracted, no scheduled window.
 *
 * THE CALENDAR: the Google event is deleted when its block has not ENDED yet — the calendar's
 * job is to say what is ahead, and a paused job is no longer ahead; the hours that were worked
 * are on the clock, not in the event. A block that is entirely past is history and stays. The
 * CRM's own calendar reads Visit.scheduledStart, so the paused job leaves it either way.
 *
 * Distinct from timeTracking.pauseJob (the CLOCK's pause) in name, route and effect: that one
 * closes a session and leaves the job where it is; this one changes what the job IS.
 */
export async function pauseJobForLater(
  prisma: PrismaClient,
  input: { visitId: string; actor: string; reason?: string | null; technicianName?: string | null },
): Promise<PauseJobResult> {
  const visit = await prisma.visit.findUnique({
    where: { id: input.visitId },
    select: {
      id: true, status: true, scheduledStart: true, scheduledEnd: true, googleEventId: true, laborHours: true,
      customer: { select: { name: true } },
      property: { select: { addressLine1: true, city: true } },
    },
  });
  if (!visit) throw new SameDayError("Job not found.", 404);
  if (!(PAUSABLE_STATUSES as readonly string[]).includes(visit.status)) {
    throw new SameDayError(
      visit.status === "contracted"
        ? "This job is already waiting to be scheduled."
        : `Only a job underway can be paused — this one is "${visit.status}".`,
    );
  }
  const label = `${visit.customer.name} — ${visit.property.addressLine1}, ${visit.property.city}`;

  // Close every running clock session on this job (minutes kept, reason "paused"); the SHIFT
  // clock is untouched — the drive back is still paid time.
  const open = await prisma.timeEntry.findMany({
    where: { visitId: visit.id, endedAt: null },
    select: { technicianId: true },
  });
  const { pauseJob: pauseClock, recomputeVisitLabor } = await import("./timeTracking");
  let sessionsClosed = 0;
  for (const techId of [...new Set(open.map((e) => e.technicianId).filter((id): id is string => Boolean(id)))]) {
    try {
      await pauseClock(visit.id, techId, { reason: "Job paused — back to scheduling" });
      sessionsClosed += 1;
    } catch (err) {
      // A flagged session stays open for the tech to confirm; it is not this verb's to resolve.
      console.warn("[sameDayJob] could not close a clock session on pause:", err instanceof Error ? err.message : err);
    }
  }
  const totals = await recomputeVisitLabor(visit.id);

  const now = new Date();
  let calendarEventDeleted = false;
  if (visit.googleEventId && visit.scheduledEnd && visit.scheduledEnd.getTime() > now.getTime()) {
    const { deleteCalendarEvent } = await import("./schedule");
    try {
      await deleteCalendarEvent(visit.googleEventId);
      calendarEventDeleted = true;
    } catch (err) {
      console.error("[sameDayJob] calendar delete on pause failed:", err);
    }
  }

  await prisma.visit.update({
    where: { id: visit.id },
    data: {
      status: "contracted",
      scheduledStart: null,
      scheduledEnd: null,
      ...(calendarEventDeleted ? { googleEventId: null } : {}),
      confirmationStatus: "unconfirmed",
      confirmedAt: null,
      reminderSentAt: null,
      nextStep: null,
      nextStepAt: null,
    },
  });

  const root = await signedRootForJob(prisma, visit.id);
  if (root) {
    await prisma.issuedEstimateEvent.create({
      data: {
        estimateId: root.id,
        type: EVENT_JOB_PAUSED,
        actor: input.actor,
        detail: `Job paused — back to the office to schedule.${input.reason ? ` Reason: ${input.reason}` : ""}`,
      },
    });
  }

  logSystemEvent("info", "jobs", `Job paused — back to scheduling: ${label}`, {
    visitId: visit.id,
    actor: input.actor,
    reason: input.reason ?? null,
    sessionsClosed,
    calendarEventDeleted,
    wasStatus: visit.status,
  });
  sendKyleNotificationEmail(
    `Job paused — needs rescheduling: ${label}`,
    [
      label,
      `Paused by: ${input.technicianName ?? input.actor}`,
      input.reason ? `Reason: ${input.reason}` : "Reason: not given",
      `Hours on the job so far: ${totals.laborHours}`,
      root ? `Estimate ${root.number} — ${money(root.total)}` : "No signed estimate on this job.",
      "",
      "Its estimate, payments, P.O.s, time and materials stay on the job. It is on the calendar's unscheduled rail; book it from the CRM.",
      "The customer has been sent nothing.",
    ].join("\n"),
  ).catch(() => {});

  return { ok: true, visitId: visit.id, sessionsClosed, calendarEventDeleted, laborHours: totals.laborHours };
}
