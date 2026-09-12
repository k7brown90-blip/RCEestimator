/**
 * Time and payroll — TWO CLOCKS, KEPT SEPARATE (Kyle, 2026-09-11).
 *
 *   SHIFT CLOCK (payroll). Clock in / clock out, on the field app's MAIN
 *   screen, working whether or not a job is assigned. Payroll hours are
 *   clocked-in to clocked-out.
 *
 *   JOB CLOCK (job time). Arrive → Complete, or Pause on a multi-day job. Job
 *   hours are the sum of the arrive-to-leave sessions.
 *
 * The rules, verbatim intent:
 *
 *  1. Job time sits INSIDE the shift. Arrive while clocked out starts the shift
 *     too and says so on screen. Clocking out while a job clock runs pauses that
 *     job first and says so.
 *  2. Shift hours minus job hours is UNBILLED time (drive, shop, supply house) —
 *     company overhead, never job cost. Reported, never charged to a customer.
 *  3. A pay rate is FROZEN onto each entry when it closes. A raise changes
 *     tomorrow, never last month.
 *  4. Every hour is editable with a reason and a trail (TimeEdit).
 *  5. A clock still running after 12 hours is FLAGGED, STOPS ACCRUING, and the
 *     technician is asked to confirm the real end time. It cannot count again
 *     until someone answers.
 *  6. Rates are typed by Kyle, never defaulted. No rate = hours but NO cost, and
 *     every surface says "rate not set" rather than inventing a number.
 *  7. Commission: a hand-entered PERCENTAGE per technician on JOB PROFIT =
 *     revenue − material cost − fees (permits, inspections). Labor is NOT
 *     subtracted. Overridable per job with a reason.
 *  8. Overtime is automatic under Tennessee rules, which means federal FLSA:
 *     over 40 hours in a fixed 7-day workweek at 1.5×. The premium (the extra
 *     0.5×) rides the hours that crossed 40, in the order worked, so the long
 *     job carries it. WEEKLY pay period, Monday through Sunday.
 */

import type { ShiftEntry, TimeEntry } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { logSystemEvent } from "./systemEvents";
import { estimateMaterialCost, estimateOptionTotal, materialCostForJobs, type MaterialSource } from "./jobCosting";
import { fullBillOf } from "./stripePayments";

/** Rule 5: a clock still running after this many hours is flagged and stops accruing. */
export const RUNAWAY_HOURS = 12;
/** Rule 8: FLSA — over 40 hours in the fixed Monday–Sunday workweek at 1.5×. */
export const OVERTIME_THRESHOLD_MINUTES = 40 * 60;
export const OVERTIME_MULTIPLIER = 1.5;

const round2 = (n: number) => Math.round(n * 100) / 100;
const MINUTE = 60_000;

export class TimeError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "TimeError";
    this.statusCode = statusCode;
  }
}

/**
 * Rule 5, one predicate used everywhere: a flagged entry does not count until
 * somebody confirms the real end time. Expressed as a Prisma filter so no total
 * anywhere can forget it.
 */
const COUNTS = { OR: [{ flaggedAt: null }, { confirmedAt: { not: null } }] };

/** Minutes between two stamps, never below 1 — a punch is a punch. */
function minutesBetween(from: Date, to: Date): number {
  return Math.max(1, Math.round((to.getTime() - from.getTime()) / MINUTE));
}

// ─── The shift clock ─────────────────────────────────────────────────────────

/** The technician's open shift, flagged or not. */
export async function openShift(technicianId: string): Promise<ShiftEntry | null> {
  return prisma.shiftEntry.findFirst({
    where: { technicianId, endedAt: null },
    orderBy: { startedAt: "desc" },
  });
}

/** The technician's open job session (any visit, or one named visit). */
export async function openJobSession(technicianId: string, visitId?: string): Promise<TimeEntry | null> {
  return prisma.timeEntry.findFirst({
    where: { technicianId, endedAt: null, ...(visitId ? { visitId } : {}) },
    orderBy: { startedAt: "desc" },
  });
}

export async function startShift(
  technicianId: string,
  opts: { source: "field" | "office"; at?: Date; note?: string | null },
): Promise<ShiftEntry> {
  const already = await openShift(technicianId);
  if (already) {
    throw new TimeError(
      already.flaggedAt
        ? `A shift from ${already.startedAt.toISOString()} is still open and flagged — confirm when it really ended first.`
        : `Already clocked in since ${already.startedAt.toISOString()}.`,
      409,
    );
  }
  return prisma.shiftEntry.create({
    data: {
      technicianId,
      startedAt: opts.at ?? new Date(),
      source: opts.source,
      note: opts.note ?? null,
    },
  });
}

export interface EndShiftResult {
  shift: ShiftEntry;
  /** Rule 1: the job clock that was running and had to be paused first. */
  pausedJob: { visitId: string; minutes: number } | null;
  rateSet: boolean;
}

/**
 * Rule 1 — clocking out while a job clock runs PAUSES that job first and says
 * so. Rule 3 — the rate freezes here, from the technician's current hourlyRate.
 */
export async function endShift(
  technicianId: string,
  opts: { at?: Date; reason?: string | null } = {},
): Promise<EndShiftResult> {
  const shift = await openShift(technicianId);
  if (!shift) throw new TimeError("Not clocked in.", 409);
  const endedAt = opts.at ?? new Date();
  if (endedAt.getTime() <= shift.startedAt.getTime()) {
    throw new TimeError("A shift cannot end before it started.", 400);
  }

  // The job clock first — leaving the day means the work stopped.
  let pausedJob: EndShiftResult["pausedJob"] = null;
  const running = await openJobSession(technicianId);
  if (running) {
    const closed = await closeJobSession(running, endedAt, "clock_out");
    pausedJob = { visitId: closed.visitId, minutes: closed.minutes ?? 0 };
  }

  const rate = await currentRate(technicianId);
  const updated = await prisma.shiftEntry.update({
    where: { id: shift.id },
    data: {
      endedAt,
      minutes: minutesBetween(shift.startedAt, endedAt),
      rateApplied: rate,
      ...(opts.reason ? { note: opts.reason } : {}),
    },
  });
  return { shift: updated, pausedJob, rateSet: rate != null };
}

/** Rule 6: the rate Kyle typed, or null. Never a default. */
async function currentRate(technicianId: string): Promise<number | null> {
  const tech = await prisma.technician.findUnique({
    where: { id: technicianId },
    select: { hourlyRate: true },
  });
  return tech?.hourlyRate ?? null;
}

// ─── The job clock ───────────────────────────────────────────────────────────

export interface ArriveResult {
  entry: TimeEntry;
  /** Rule 1: the arrival auto-started the shift, and the UI has to say so. */
  startedShift: boolean;
  shift: ShiftEntry;
  /** A job clock running on ANOTHER visit was paused so this one could start. */
  pausedOther: { visitId: string; minutes: number } | null;
}

/**
 * Arrive on site. Rule 1: job time sits inside the shift, so arriving while
 * clocked out starts the shift too and reports startedShift so the screen can
 * say "Shift started too".
 */
export async function arrive(visitId: string, technicianId: string): Promise<ArriveResult> {
  const already = await openJobSession(technicianId, visitId);
  if (already) {
    throw new TimeError(
      already.flaggedAt
        ? `This job's clock has been running since ${already.startedAt.toISOString()} and is flagged — confirm when you really left first.`
        : `Already on this job since ${already.startedAt.toISOString()}.`,
      409,
    );
  }

  const at = new Date();
  let shift = await openShift(technicianId);
  let startedShift = false;
  if (!shift) {
    shift = await startShift(technicianId, { source: "field", at });
    startedShift = true;
  }

  // One job at a time: a clock still running somewhere else pauses here.
  let pausedOther: ArriveResult["pausedOther"] = null;
  const elsewhere = await openJobSession(technicianId);
  if (elsewhere) {
    const closed = await closeJobSession(elsewhere, at, "paused");
    pausedOther = { visitId: closed.visitId, minutes: closed.minutes ?? 0 };
  }

  const entry = await prisma.timeEntry.create({
    data: { visitId, technicianId, startedAt: at, shiftEntryId: shift.id },
  });
  return { entry, startedShift, shift, pausedOther };
}

export interface CloseJobResult {
  entry: TimeEntry;
  minutes: number;
  /** Everything banked on the visit, flagged entries excluded (rule 5). */
  laborMinutes: number;
  laborHours: number;
  rateSet: boolean;
}

async function endJob(
  visitId: string,
  technicianId: string,
  endedReason: "paused" | "completed" | "clock_out",
  opts: { at?: Date; reason?: string | null } = {},
): Promise<CloseJobResult> {
  const open = await openJobSession(technicianId, visitId);
  if (!open) throw new TimeError("The clock is not running on this job.", 409);
  const at = opts.at ?? new Date();
  const entry = await closeJobSession(open, at, endedReason, opts.reason ?? null);
  const totals = await recomputeVisitLabor(visitId);
  return {
    entry,
    minutes: entry.minutes ?? 0,
    laborMinutes: totals.laborMinutes,
    laborHours: totals.laborHours,
    rateSet: entry.rateApplied != null,
  };
}

/** Pause on a multi-day job — the session closes, the job stays open. */
export function pauseJob(visitId: string, technicianId: string, opts: { at?: Date; reason?: string | null } = {}) {
  return endJob(visitId, technicianId, "paused", opts);
}

/** Complete: the last session of this job for this tech. */
export function completeJob(visitId: string, technicianId: string, opts: { at?: Date; reason?: string | null } = {}) {
  return endJob(visitId, technicianId, "completed", opts);
}

/** Close one session, freezing the rate (rule 3). */
async function closeJobSession(
  entry: TimeEntry,
  endedAt: Date,
  endedReason: "paused" | "completed" | "clock_out" | "manual",
  note?: string | null,
): Promise<TimeEntry> {
  const rate = entry.technicianId ? await currentRate(entry.technicianId) : null;
  return prisma.timeEntry.update({
    where: { id: entry.id },
    data: {
      endedAt,
      minutes: minutesBetween(entry.startedAt, endedAt),
      endedReason,
      rateApplied: rate,
      ...(note ? { note } : {}),
    },
  });
}

/**
 * Visit.laborHours is what job profitability's labor line reads, so it is kept
 * as the sum of CLOSED, COUNTING sessions — exactly as the old clock-out did,
 * minus anything flagged and unanswered (rule 5).
 */
export async function recomputeVisitLabor(visitId: string): Promise<{ laborMinutes: number; laborHours: number }> {
  const total = await prisma.timeEntry.aggregate({
    where: { visitId, endedAt: { not: null }, OR: COUNTS.OR },
    _sum: { minutes: true },
  });
  const laborMinutes = Math.round(total._sum?.minutes ?? 0);
  const laborHours = Math.round((laborMinutes / 60) * 100) / 100;
  await prisma.visit.update({ where: { id: visitId }, data: { laborHours } });
  return { laborMinutes, laborHours };
}

// ─── Rule 5: the runaway sweep ───────────────────────────────────────────────

export interface FlaggedEntry {
  kind: "shift" | "job";
  id: string;
  technicianId: string | null;
  visitId: string | null;
  startedAt: string;
  hoursOpen: number;
}

/**
 * Cron sweep. Anything open longer than the cutoff is stamped flaggedAt: it
 * STOPS ACCRUING (every total filters it out), and the field app's main screen
 * asks the technician to confirm the real end time.
 */
export async function flagRunaways(opts: { hours?: number; now?: Date } = {}): Promise<{ shifts: number; sessions: number }> {
  const hours = opts.hours ?? RUNAWAY_HOURS;
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - hours * 60 * MINUTE);

  const [shifts, sessions] = await Promise.all([
    prisma.shiftEntry.findMany({
      where: { endedAt: null, flaggedAt: null, startedAt: { lt: cutoff } },
      select: { id: true, technicianId: true, startedAt: true },
    }),
    prisma.timeEntry.findMany({
      where: { endedAt: null, flaggedAt: null, startedAt: { lt: cutoff } },
      select: { id: true, technicianId: true, visitId: true, startedAt: true },
    }),
  ]);
  if (shifts.length === 0 && sessions.length === 0) return { shifts: 0, sessions: 0 };

  if (shifts.length > 0) {
    await prisma.shiftEntry.updateMany({ where: { id: { in: shifts.map((s) => s.id) } }, data: { flaggedAt: now } });
  }
  if (sessions.length > 0) {
    await prisma.timeEntry.updateMany({ where: { id: { in: sessions.map((s) => s.id) } }, data: { flaggedAt: now } });
  }
  logSystemEvent(
    "warn",
    "time",
    `Flagged ${shifts.length} shift(s) and ${sessions.length} job session(s) open past ${hours} hours — they stop accruing until the end time is confirmed`,
    { shiftIds: shifts.map((s) => s.id), sessionIds: sessions.map((s) => s.id), hours },
  );
  return { shifts: shifts.length, sessions: sessions.length };
}

/** Flagged and still unanswered, for the field app's red banner and the Team tab. */
export async function flaggedFor(technicianId: string, now: Date = new Date()): Promise<FlaggedEntry[]> {
  const [shifts, sessions] = await Promise.all([
    prisma.shiftEntry.findMany({
      where: { technicianId, flaggedAt: { not: null }, confirmedAt: null },
      orderBy: { startedAt: "asc" },
    }),
    prisma.timeEntry.findMany({
      where: { technicianId, flaggedAt: { not: null }, confirmedAt: null },
      orderBy: { startedAt: "asc" },
    }),
  ]);
  const open = (startedAt: Date) => Math.round(((now.getTime() - startedAt.getTime()) / (60 * MINUTE)) * 10) / 10;
  return [
    ...shifts.map((s): FlaggedEntry => ({
      kind: "shift", id: s.id, technicianId: s.technicianId, visitId: null,
      startedAt: s.startedAt.toISOString(), hoursOpen: open(s.startedAt),
    })),
    ...sessions.map((s): FlaggedEntry => ({
      kind: "job", id: s.id, technicianId: s.technicianId, visitId: s.visitId,
      startedAt: s.startedAt.toISOString(), hoursOpen: open(s.startedAt),
    })),
  ].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

/** The answer to rule 5's question: close the flagged entry at the real time. */
export async function confirmEntry(
  kind: "shift" | "job",
  id: string,
  input: { endedAt: Date; actor: string; reason: string },
): Promise<ShiftEntry | TimeEntry> {
  if (kind === "shift") {
    const before = await prisma.shiftEntry.findUnique({ where: { id } });
    if (!before) throw new TimeError("Shift not found.", 404);
    if (!before.flaggedAt) throw new TimeError("That shift is not flagged — edit it instead.", 400);
    assertRealEnd(before.startedAt, input.endedAt);
    const rate = before.rateApplied ?? (await currentRate(before.technicianId));
    const after = await prisma.shiftEntry.update({
      where: { id },
      data: {
        endedAt: input.endedAt,
        minutes: minutesBetween(before.startedAt, input.endedAt),
        rateApplied: rate,
        confirmedAt: new Date(),
      },
    });
    await writeTimeEdit("shift", after.id, null, input.actor, input.reason, before, after);
    return after;
  }
  const before = await prisma.timeEntry.findUnique({ where: { id } });
  if (!before) throw new TimeError("Job session not found.", 404);
  if (!before.flaggedAt) throw new TimeError("That session is not flagged — edit it instead.", 400);
  assertRealEnd(before.startedAt, input.endedAt);
  const rate = before.rateApplied ?? (before.technicianId ? await currentRate(before.technicianId) : null);
  const after = await prisma.timeEntry.update({
    where: { id },
    data: {
      endedAt: input.endedAt,
      minutes: minutesBetween(before.startedAt, input.endedAt),
      endedReason: before.endedReason ?? "manual",
      rateApplied: rate,
      confirmedAt: new Date(),
    },
  });
  await writeTimeEdit("job", null, after.id, input.actor, input.reason, before, after);
  await recomputeVisitLabor(after.visitId);
  return after;
}

function assertRealEnd(startedAt: Date, endedAt: Date): void {
  if (endedAt.getTime() <= startedAt.getTime()) throw new TimeError("The end time has to come after the start.", 400);
  if (endedAt.getTime() > Date.now() + 5 * MINUTE) throw new TimeError("That end time is in the future.", 400);
}

// ─── Rule 4: edits with a reason and a trail ─────────────────────────────────

async function writeTimeEdit(
  kind: "shift" | "job",
  shiftEntryId: string | null,
  timeEntryId: string | null,
  actor: string,
  reason: string,
  before: unknown,
  after: unknown,
): Promise<void> {
  await prisma.timeEdit.create({
    data: {
      kind,
      shiftEntryId,
      timeEntryId,
      actor,
      reason,
      beforeJson: JSON.stringify(before),
      afterJson: JSON.stringify(after),
    },
  });
}

export interface TimeEditInput {
  startedAt?: Date;
  endedAt?: Date | null;
  note?: string | null;
  actor: string;
  reason: string;
}

export async function editShift(id: string, input: TimeEditInput): Promise<ShiftEntry> {
  const before = await prisma.shiftEntry.findUnique({ where: { id } });
  if (!before) throw new TimeError("Shift not found.", 404);
  const startedAt = input.startedAt ?? before.startedAt;
  const endedAt = input.endedAt === undefined ? before.endedAt : input.endedAt;
  if (endedAt && endedAt.getTime() <= startedAt.getTime()) {
    throw new TimeError("The end time has to come after the start.", 400);
  }
  // Rule 3: a rate already frozen stays frozen. Only a newly closed entry takes
  // today's rate — a raise changes tomorrow, never last month.
  const rateApplied = endedAt
    ? before.rateApplied ?? (await currentRate(before.technicianId))
    : null;
  const after = await prisma.shiftEntry.update({
    where: { id },
    data: {
      startedAt,
      endedAt,
      minutes: endedAt ? minutesBetween(startedAt, endedAt) : null,
      rateApplied,
      ...(input.note !== undefined ? { note: input.note } : {}),
      // A hand-corrected entry has been answered for (rule 5).
      ...(before.flaggedAt && endedAt ? { confirmedAt: new Date() } : {}),
    },
  });
  await writeTimeEdit("shift", id, null, input.actor, input.reason, before, after);
  return after;
}

export async function editJobSession(id: string, input: TimeEditInput): Promise<TimeEntry> {
  const before = await prisma.timeEntry.findUnique({ where: { id } });
  if (!before) throw new TimeError("Job session not found.", 404);
  const startedAt = input.startedAt ?? before.startedAt;
  const endedAt = input.endedAt === undefined ? before.endedAt : input.endedAt;
  if (endedAt && endedAt.getTime() <= startedAt.getTime()) {
    throw new TimeError("The end time has to come after the start.", 400);
  }
  const rateApplied = endedAt
    ? before.rateApplied ?? (before.technicianId ? await currentRate(before.technicianId) : null)
    : null;
  const after = await prisma.timeEntry.update({
    where: { id },
    data: {
      startedAt,
      endedAt,
      minutes: endedAt ? minutesBetween(startedAt, endedAt) : null,
      rateApplied,
      ...(endedAt && !before.endedReason ? { endedReason: "manual" } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
      ...(before.flaggedAt && endedAt ? { confirmedAt: new Date() } : {}),
    },
  });
  await writeTimeEdit("job", null, id, input.actor, input.reason, before, after);
  await recomputeVisitLabor(after.visitId);
  return after;
}

export async function deleteShift(id: string, input: { actor: string; reason: string }): Promise<void> {
  const before = await prisma.shiftEntry.findUnique({ where: { id } });
  if (!before) throw new TimeError("Shift not found.", 404);
  await writeTimeEdit("shift", id, null, input.actor, input.reason, before, { deleted: true });
  await prisma.shiftEntry.delete({ where: { id } });
}

export async function deleteJobSession(id: string, input: { actor: string; reason: string }): Promise<void> {
  const before = await prisma.timeEntry.findUnique({ where: { id } });
  if (!before) throw new TimeError("Job session not found.", 404);
  await writeTimeEdit("job", null, id, input.actor, input.reason, before, { deleted: true });
  await prisma.timeEntry.delete({ where: { id } });
  await recomputeVisitLabor(before.visitId);
}

// ─── Office-entered time ─────────────────────────────────────────────────────

export async function createShift(input: {
  technicianId: string;
  startedAt: Date;
  endedAt?: Date | null;
  note?: string | null;
  source?: "field" | "office";
}): Promise<ShiftEntry> {
  if (input.endedAt && input.endedAt.getTime() <= input.startedAt.getTime()) {
    throw new TimeError("The end time has to come after the start.", 400);
  }
  const rate = input.endedAt ? await currentRate(input.technicianId) : null;
  return prisma.shiftEntry.create({
    data: {
      technicianId: input.technicianId,
      startedAt: input.startedAt,
      endedAt: input.endedAt ?? null,
      minutes: input.endedAt ? minutesBetween(input.startedAt, input.endedAt) : null,
      rateApplied: rate,
      source: input.source ?? "office",
      note: input.note ?? null,
    },
  });
}

export async function createJobSession(input: {
  visitId: string;
  technicianId: string;
  startedAt: Date;
  endedAt?: Date | null;
  note?: string | null;
}): Promise<TimeEntry> {
  if (input.endedAt && input.endedAt.getTime() <= input.startedAt.getTime()) {
    throw new TimeError("The end time has to come after the start.", 400);
  }
  const rate = input.endedAt ? await currentRate(input.technicianId) : null;
  const entry = await prisma.timeEntry.create({
    data: {
      visitId: input.visitId,
      technicianId: input.technicianId,
      startedAt: input.startedAt,
      endedAt: input.endedAt ?? null,
      minutes: input.endedAt ? minutesBetween(input.startedAt, input.endedAt) : null,
      endedReason: input.endedAt ? "manual" : null,
      rateApplied: rate,
      note: input.note ?? null,
    },
  });
  await recomputeVisitLabor(input.visitId);
  return entry;
}

// ─── Rule 8: the workweek ────────────────────────────────────────────────────

/** Monday 00:00 local through Sunday 23:59:59.999 local — the fixed pay period. */
export function weekOf(date: Date): { start: Date; end: Date } {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  // getDay(): 0 = Sunday. Monday is the first day of the pay week.
  const shift = (start.getDay() + 6) % 7;
  start.setDate(start.getDate() - shift);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

export interface PayrollEntryView {
  kind: "shift" | "job";
  id: string;
  startedAt: string;
  endedAt: string | null;
  minutes: number | null;
  /** Frozen rate; null when the technician had no rate on file (rule 6). */
  rateApplied: number | null;
  /** How the minutes split once the week crossed 40 (rule 8, in the order worked). */
  regularMinutes: number;
  overtimeMinutes: number;
  /** regular pay + the 0.5× premium this entry carries; null when no rate is set. */
  pay: number | null;
  source?: string;
  note: string | null;
  visitId?: string;
  visitLabel?: string | null;
  endedReason?: string | null;
  flagged: boolean;
  confirmed: boolean;
  open: boolean;
}

export interface PayrollWeek {
  technicianId: string;
  technicianName: string;
  weekStart: string;
  weekEnd: string;
  shiftMinutes: number;
  jobMinutes: number;
  /** Rule 2: shift − job. Company overhead, never a job cost. */
  unbilledMinutes: number;
  regularMinutes: number;
  overtimeMinutes: number;
  /** The technician's CURRENT rate, or null (rule 6). */
  rate: number | null;
  rateSet: boolean;
  regularPay: number;
  /** The extra 0.5× on the hours past 40 only. */
  overtimePremium: number;
  commissions: number;
  total: number;
  openEntries: number;
  flagged: FlaggedEntry[];
  shifts: PayrollEntryView[];
  sessions: PayrollEntryView[];
  commissionRows: Array<{
    id: string; visitId: string | null; visitLabel: string | null; basis: string;
    percent: number | null; amount: number; note: string | null; reason: string | null;
    earnedAt: string; paidAt: string | null;
  }>;
}

export async function payrollForWeek(technicianId: string, weekStart: Date): Promise<PayrollWeek> {
  const { start, end } = weekOf(weekStart);
  const tech = await prisma.technician.findUnique({
    where: { id: technicianId },
    select: { id: true, name: true, hourlyRate: true },
  });
  if (!tech) throw new TimeError("Technician not found.", 404);

  const [shiftRows, sessionRows, commissionRows, flagged] = await Promise.all([
    prisma.shiftEntry.findMany({
      where: { technicianId, startedAt: { gte: start, lte: end } },
      orderBy: { startedAt: "asc" },
    }),
    prisma.timeEntry.findMany({
      where: { technicianId, startedAt: { gte: start, lte: end } },
      orderBy: { startedAt: "asc" },
      include: {
        visit: {
          select: {
            id: true, jobType: true, purpose: true,
            customer: { select: { name: true } },
            property: { select: { addressLine1: true } },
          },
        },
      },
    }),
    prisma.commission.findMany({
      where: { technicianId, earnedAt: { gte: start, lte: end } },
      orderBy: { earnedAt: "asc" },
      include: {
        visit: { select: { id: true, customer: { select: { name: true } }, property: { select: { addressLine1: true } } } },
      },
    }),
    flaggedFor(technicianId),
  ]);

  const counts = (e: { flaggedAt: Date | null; confirmedAt: Date | null; endedAt: Date | null; minutes: number | null }) =>
    e.endedAt != null && e.minutes != null && (e.flaggedAt == null || e.confirmedAt != null);

  /*
    Rule 8, the attribution. Walk the week's CLOSED shifts in the order they were
    worked; everything past the 40-hour line is overtime, so the premium rides
    the hours that crossed it — the long job carries it, not an average.
    Each entry pays at ITS OWN frozen rate (rule 3).
  */
  let running = 0;
  let regularMinutes = 0;
  let overtimeMinutes = 0;
  let regularPay = 0;
  let overtimePremium = 0;
  const shifts: PayrollEntryView[] = shiftRows.map((s) => {
    let reg = 0;
    let ot = 0;
    if (counts(s)) {
      const mins = s.minutes ?? 0;
      const beforeLine = Math.max(0, Math.min(mins, OVERTIME_THRESHOLD_MINUTES - running));
      reg = beforeLine;
      ot = mins - beforeLine;
      running += mins;
      regularMinutes += reg;
      overtimeMinutes += ot;
      if (s.rateApplied != null) {
        regularPay += (reg / 60) * s.rateApplied;
        overtimePremium += (ot / 60) * s.rateApplied * (OVERTIME_MULTIPLIER - 1);
      }
    }
    return {
      kind: "shift",
      id: s.id,
      startedAt: s.startedAt.toISOString(),
      endedAt: s.endedAt?.toISOString() ?? null,
      minutes: s.minutes,
      rateApplied: s.rateApplied,
      regularMinutes: reg,
      overtimeMinutes: ot,
      pay: s.rateApplied == null
        ? null
        : round2((reg / 60) * s.rateApplied + (ot / 60) * s.rateApplied * OVERTIME_MULTIPLIER),
      source: s.source,
      note: s.note,
      flagged: s.flaggedAt != null,
      confirmed: s.confirmedAt != null,
      open: s.endedAt == null,
    };
  });

  const sessions: PayrollEntryView[] = sessionRows.map((e) => ({
    kind: "job",
    id: e.id,
    startedAt: e.startedAt.toISOString(),
    endedAt: e.endedAt?.toISOString() ?? null,
    minutes: e.minutes,
    rateApplied: e.rateApplied,
    regularMinutes: counts(e) ? e.minutes ?? 0 : 0,
    overtimeMinutes: 0,
    pay: e.rateApplied != null && e.minutes != null ? round2((e.minutes / 60) * e.rateApplied) : null,
    note: e.note,
    visitId: e.visitId,
    visitLabel: e.visit
      ? `${e.visit.customer.name} — ${e.visit.property.addressLine1}`
      : e.visitId,
    endedReason: e.endedReason,
    flagged: e.flaggedAt != null,
    confirmed: e.confirmedAt != null,
    open: e.endedAt == null,
  }));

  const shiftMinutes = shiftRows.filter(counts).reduce((sum, s) => sum + (s.minutes ?? 0), 0);
  const jobMinutes = sessionRows.filter(counts).reduce((sum, s) => sum + (s.minutes ?? 0), 0);
  const commissions = round2(commissionRows.reduce((sum, c) => sum + c.amount, 0));

  regularPay = round2(regularPay);
  overtimePremium = round2(overtimePremium);

  return {
    technicianId: tech.id,
    technicianName: tech.name,
    weekStart: start.toISOString(),
    weekEnd: end.toISOString(),
    shiftMinutes,
    jobMinutes,
    // Rule 2. Never negative: job time logged outside a shift is a correction to
    // make on the Team tab, not a negative overhead number on the report.
    unbilledMinutes: Math.max(0, shiftMinutes - jobMinutes),
    regularMinutes,
    overtimeMinutes,
    rate: tech.hourlyRate ?? null,
    rateSet: tech.hourlyRate != null,
    regularPay,
    overtimePremium,
    commissions,
    total: round2(regularPay + overtimePremium + commissions),
    openEntries:
      shiftRows.filter((s) => s.endedAt == null).length + sessionRows.filter((s) => s.endedAt == null).length,
    flagged,
    shifts,
    sessions,
    commissionRows: commissionRows.map((c) => ({
      id: c.id,
      visitId: c.visitId,
      visitLabel: c.visit ? `${c.visit.customer.name} — ${c.visit.property.addressLine1}` : null,
      basis: c.basis,
      percent: c.percent,
      amount: c.amount,
      note: c.note,
      reason: c.reason,
      earnedAt: c.earnedAt.toISOString(),
      paidAt: c.paidAt?.toISOString() ?? null,
    })),
  };
}

// ─── The job's own time, for the Jobs tab ────────────────────────────────────

export interface JobTimeView {
  visitId: string;
  technicians: Array<{
    technicianId: string;
    name: string;
    minutes: number;
    hours: number;
    rate: number | null;
    rateSet: boolean;
    cost: number | null;
    assigned: boolean;
  }>;
  sessions: PayrollEntryView[];
  totalMinutes: number;
  totalHours: number;
  /** Null when any counted session has no rate — the surface says "rate not set". */
  laborCost: number | null;
  anyRateMissing: boolean;
}

export async function jobTime(visitId: string): Promise<JobTimeView> {
  const [rows, assignments] = await Promise.all([
    prisma.timeEntry.findMany({ where: { visitId }, orderBy: { startedAt: "asc" } }),
    prisma.visitAssignment.findMany({
      where: { visitId },
      include: { technician: { select: { id: true, name: true, hourlyRate: true } } },
    }),
  ]);
  const techIds = [...new Set(rows.map((r) => r.technicianId).filter((id): id is string => Boolean(id)))];
  const techs = techIds.length === 0
    ? []
    : await prisma.technician.findMany({ where: { id: { in: techIds } }, select: { id: true, name: true, hourlyRate: true } });
  const nameById = new Map<string, { name: string; hourlyRate: number | null }>();
  for (const t of techs) nameById.set(t.id, { name: t.name, hourlyRate: t.hourlyRate });
  for (const a of assignments) nameById.set(a.technician.id, { name: a.technician.name, hourlyRate: a.technician.hourlyRate });

  const counts = (e: typeof rows[number]) =>
    e.endedAt != null && e.minutes != null && (e.flaggedAt == null || e.confirmedAt != null);

  const perTech = new Map<string, { minutes: number; cost: number; missing: boolean }>();
  let totalMinutes = 0;
  let laborCost = 0;
  let anyRateMissing = false;
  for (const r of rows) {
    if (!counts(r)) continue;
    const mins = r.minutes ?? 0;
    totalMinutes += mins;
    const key = r.technicianId ?? "unassigned";
    const bucket = perTech.get(key) ?? { minutes: 0, cost: 0, missing: false };
    bucket.minutes += mins;
    if (r.rateApplied == null) {
      bucket.missing = true;
      anyRateMissing = true;
    } else {
      bucket.cost += (mins / 60) * r.rateApplied;
      laborCost += (mins / 60) * r.rateApplied;
    }
    perTech.set(key, bucket);
  }
  // Assigned techs with no hours yet still belong on the job's list.
  for (const a of assignments) if (!perTech.has(a.technicianId)) perTech.set(a.technicianId, { minutes: 0, cost: 0, missing: false });

  const assignedIds = new Set(assignments.map((a) => a.technicianId));
  return {
    visitId,
    technicians: [...perTech.entries()].map(([technicianId, b]) => {
      const t = nameById.get(technicianId);
      return {
        technicianId,
        name: t?.name ?? (technicianId === "unassigned" ? "Unattributed (legacy punch)" : technicianId),
        minutes: b.minutes,
        hours: Math.round((b.minutes / 60) * 100) / 100,
        rate: t?.hourlyRate ?? null,
        rateSet: t?.hourlyRate != null,
        cost: b.missing && b.cost === 0 ? null : round2(b.cost),
        assigned: assignedIds.has(technicianId),
      };
    }),
    sessions: rows.map((e) => ({
      kind: "job",
      id: e.id,
      startedAt: e.startedAt.toISOString(),
      endedAt: e.endedAt?.toISOString() ?? null,
      minutes: e.minutes,
      rateApplied: e.rateApplied,
      regularMinutes: counts(e) ? e.minutes ?? 0 : 0,
      overtimeMinutes: 0,
      pay: e.rateApplied != null && e.minutes != null ? round2((e.minutes / 60) * e.rateApplied) : null,
      note: e.note,
      visitId: e.visitId,
      visitLabel: nameById.get(e.technicianId ?? "")?.name ?? null,
      endedReason: e.endedReason,
      flagged: e.flaggedAt != null,
      confirmed: e.confirmedAt != null,
      open: e.endedAt == null,
    })),
    totalMinutes,
    totalHours: Math.round((totalMinutes / 60) * 100) / 100,
    laborCost: anyRateMissing && laborCost === 0 ? null : round2(laborCost),
    anyRateMissing,
  };
}

// ─── Rule 7: commission on JOB PROFIT ────────────────────────────────────────

/** Receipt categories and card-spend kinds that ARE job fees (Kyle, 2026-09-11). */
export const FEE_CATEGORIES = ["permit", "inspection"] as const;

export interface CommissionBasis {
  visitId: string;
  revenue: number | null;
  materialCost: number;
  materialSource: MaterialSource;
  fees: number;
  feeRows: Array<{ kind: "receipt" | "card"; id: string; label: string; category: string; amount: number }>;
  /** revenue − material − fees. Labor is NOT subtracted (Kyle's ruling). */
  profit: number | null;
}

/**
 * The math behind a commission, shown rather than asserted.
 *
 * Revenue rides the SAME ladder the Jobs tab uses (typed Visit.revenue, else the
 * legacy accepted option, else the signed issued estimate's full bill through
 * fullBillOf) and material rides materialCostForJobs — imported, not re-derived,
 * so this can never disagree with the job card.
 */
export async function commissionBasisForJob(visitId: string): Promise<CommissionBasis> {
  const visit = await prisma.visit.findUnique({
    where: { id: visitId },
    select: {
      id: true, revenue: true, actualMaterialCost: true,
      estimates: { include: { options: true }, orderBy: { createdAt: "desc" } },
    },
  });
  if (!visit) throw new TimeError("Job not found.", 404);

  const issued = await prisma.issuedEstimate.findFirst({
    where: { voidedAt: null, signedAt: { not: null }, OR: [{ jobVisitId: visitId }, { visitId }] },
    orderBy: { createdAt: "desc" },
    include: { options: true, lines: { select: { option: true, materialCost: true } } },
  });

  const { acceptedTotal } = estimateOptionTotal(visit.estimates[0]?.options ?? []);
  const signedRevenue = issued
    ? fullBillOf({
      total: issued.total,
      tripCharge: issued.tripCharge,
      selectedOptions: issued.selectedOptions,
      comboCapJson: issued.comboCapJson,
      discountJson: issued.discountJson,
      warrantyJson: issued.warrantyJson,
      optionsSubtotals: issued.options.map((o) => ({ option: o.option, subtotal: o.subtotal })),
    })
    : null;
  const revenue = visit.revenue ?? acceptedTotal ?? signedRevenue ?? null;

  const materials = await materialCostForJobs([{
    visitId,
    actualMaterialCost: visit.actualMaterialCost,
    estimatedMaterialCost: issued ? estimateMaterialCost(issued) : null,
  }]);
  const material = materials.get(visitId)!;

  // Fees = permits and inspections on this job, counted once. A card swipe that
  // is already itemized by a receipt rides that receipt (the card-spend rule).
  const [receipts, spends] = await Promise.all([
    prisma.receipt.findMany({
      where: { jobId: visitId, category: { in: [...FEE_CATEGORIES] } },
      select: { id: true, vendor: true, amount: true, category: true },
    }),
    prisma.cardSpend.findMany({
      where: {
        kind: { in: [...FEE_CATEGORIES] },
        status: { not: "ignored" },
        receiptId: null,
        purchaseOrder: { jobId: visitId },
      },
      select: { id: true, merchantName: true, amount: true, kind: true },
    }),
  ]);
  const feeRows: CommissionBasis["feeRows"] = [
    ...receipts.map((r) => ({ kind: "receipt" as const, id: r.id, label: r.vendor ?? "Receipt", category: r.category, amount: r.amount })),
    ...spends.map((s) => ({ kind: "card" as const, id: s.id, label: s.merchantName, category: s.kind, amount: s.amount })),
  ];
  const fees = round2(feeRows.reduce((sum, f) => sum + f.amount, 0));

  return {
    visitId,
    revenue,
    materialCost: material.materialCost,
    materialSource: material.materialSource,
    fees,
    feeRows,
    profit: revenue == null ? null : round2(revenue - material.materialCost - fees),
  };
}

export interface CommissionQuote extends CommissionBasis {
  technicianId: string;
  percent: number | null;
  percentSet: boolean;
  /** percent × profit, or null when the percent was never typed (rule 6's sibling). */
  amount: number | null;
}

/**
 * What this job would pay the technician at their hand-entered percentage.
 * Never invents a percentage: with none on file the amount is null and the
 * surface says so.
 */
export async function commissionForJob(visitId: string, technicianId: string, percentOverride?: number | null): Promise<CommissionQuote> {
  const basis = await commissionBasisForJob(visitId);
  const tech = await prisma.technician.findUnique({
    where: { id: technicianId },
    select: { commissionPercent: true },
  });
  if (!tech) throw new TimeError("Technician not found.", 404);
  const percent = percentOverride ?? tech.commissionPercent ?? null;
  return {
    ...basis,
    technicianId,
    percent,
    percentSet: percent != null,
    // A job that lost money pays no commission; it never claws one back.
    amount: percent == null || basis.profit == null ? null : round2(Math.max(0, basis.profit * (percent / 100))),
  };
}
