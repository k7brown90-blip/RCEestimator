/**
 * Time and payroll, office side (Kyle, 2026-09-11).
 *
 * Two clocks, kept separate: the SHIFT clock is payroll, the JOB clock is job
 * time, and shift minus job is unbilled company overhead. Rule 4 — "every hour
 * is editable with a reason and a trail": payroll hours on the Team tab, job
 * hours on the Jobs tab, and every PATCH/DELETE here takes a REQUIRED reason
 * that lands in TimeEdit with the before and after.
 *
 * Mounted behind the operator session beside trucksRouter.
 */

import express from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { asyncHandler, readParam } from "./agent-helpers";
import { logSystemEvent } from "../services/systemEvents";
import {
  TimeError,
  commissionForJob,
  confirmEntry,
  createJobSession,
  createShift,
  deleteJobSession,
  deleteShift,
  editJobSession,
  editShift,
  jobTime,
  payrollForWeek,
} from "../services/timeTracking";

export const timeRouter = express.Router();

const reasonSchema = z.string().trim().min(1, "A reason is required").max(300);
const stamp = z.string().datetime({ offset: true }).or(z.string().min(1));
const toDate = (raw: string): Date => {
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) throw new TimeError(`"${raw}" is not a time.`, 400);
  return d;
};

/** Service refusals carry their own status; everything else is a 500 upstream. */
function send(res: express.Response, err: unknown): boolean {
  if (err instanceof TimeError) {
    res.status(err.statusCode).json({ error: err.message });
    return true;
  }
  return false;
}
const guard = (fn: express.RequestHandler): express.RequestHandler =>
  asyncHandler(async (req, res, next) => {
    try {
      await fn(req, res, next);
    } catch (err) {
      if (!send(res, err)) throw err;
    }
  });

// ── Payroll: one technician, one week ────────────────────────────────────────

timeRouter.get("/time/technicians/:id/week", guard(async (req, res) => {
  const start = readQueryDate(req, "start") ?? new Date();
  res.json(await payrollForWeek(readParam(req, "id"), start));
}));

function readQueryDate(req: express.Request, key: string): Date | null {
  const raw = req.query[key];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string" || !value.trim()) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

// ── Shift entries (payroll hours) ────────────────────────────────────────────

timeRouter.post("/time/shifts", guard(async (req, res) => {
  const body = z.object({
    technicianId: z.string().min(1),
    startedAt: stamp,
    endedAt: stamp.nullable().optional(),
    note: z.string().trim().max(300).nullable().optional(),
  }).parse(req.body);
  const shift = await createShift({
    technicianId: body.technicianId,
    startedAt: toDate(body.startedAt),
    endedAt: body.endedAt ? toDate(body.endedAt) : null,
    note: body.note ?? null,
    source: "office",
  });
  res.status(201).json(shift);
}));

timeRouter.patch("/time/shifts/:id", guard(async (req, res) => {
  const body = z.object({
    startedAt: stamp.optional(),
    endedAt: stamp.nullable().optional(),
    note: z.string().trim().max(300).nullable().optional(),
    reason: reasonSchema,
  }).parse(req.body);
  const shift = await editShift(readParam(req, "id"), {
    ...(body.startedAt !== undefined ? { startedAt: toDate(body.startedAt) } : {}),
    ...(body.endedAt !== undefined ? { endedAt: body.endedAt ? toDate(body.endedAt) : null } : {}),
    ...(body.note !== undefined ? { note: body.note } : {}),
    actor: "owner",
    reason: body.reason,
  });
  res.json(shift);
}));

timeRouter.delete("/time/shifts/:id", guard(async (req, res) => {
  const body = z.object({ reason: reasonSchema }).parse(req.body ?? {});
  await deleteShift(readParam(req, "id"), { actor: "owner", reason: body.reason });
  res.status(204).end();
}));

// ── Job sessions (job hours) ─────────────────────────────────────────────────

timeRouter.get("/time/jobs/:visitId", guard(async (req, res) => {
  res.json(await jobTime(readParam(req, "visitId")));
}));

timeRouter.post("/time/jobs/:visitId/sessions", guard(async (req, res) => {
  const body = z.object({
    technicianId: z.string().min(1),
    startedAt: stamp,
    endedAt: stamp.nullable().optional(),
    note: z.string().trim().max(300).nullable().optional(),
  }).parse(req.body);
  const entry = await createJobSession({
    visitId: readParam(req, "visitId"),
    technicianId: body.technicianId,
    startedAt: toDate(body.startedAt),
    endedAt: body.endedAt ? toDate(body.endedAt) : null,
    note: body.note ?? null,
  });
  res.status(201).json(entry);
}));

timeRouter.patch("/time/sessions/:id", guard(async (req, res) => {
  const body = z.object({
    startedAt: stamp.optional(),
    endedAt: stamp.nullable().optional(),
    note: z.string().trim().max(300).nullable().optional(),
    reason: reasonSchema,
  }).parse(req.body);
  const entry = await editJobSession(readParam(req, "id"), {
    ...(body.startedAt !== undefined ? { startedAt: toDate(body.startedAt) } : {}),
    ...(body.endedAt !== undefined ? { endedAt: body.endedAt ? toDate(body.endedAt) : null } : {}),
    ...(body.note !== undefined ? { note: body.note } : {}),
    actor: "owner",
    reason: body.reason,
  });
  res.json(entry);
}));

timeRouter.delete("/time/sessions/:id", guard(async (req, res) => {
  const body = z.object({ reason: reasonSchema }).parse(req.body ?? {});
  await deleteJobSession(readParam(req, "id"), { actor: "owner", reason: body.reason });
  res.status(204).end();
}));

// ── Rule 5: answering a flagged clock from the office ────────────────────────

timeRouter.post("/time/confirm", guard(async (req, res) => {
  const body = z.object({
    kind: z.enum(["shift", "job"]),
    id: z.string().min(1),
    endedAt: stamp,
    reason: reasonSchema,
  }).parse(req.body);
  res.json(await confirmEntry(body.kind, body.id, {
    endedAt: toDate(body.endedAt),
    actor: "owner",
    reason: body.reason,
  }));
}));

// ── Rule 7: commissions ──────────────────────────────────────────────────────

/** What a job would pay at the technician's hand-entered percentage — the math, shown. */
timeRouter.get("/time/commissions/quote", guard(async (req, res) => {
  const q = z.object({
    visitId: z.string().min(1),
    technicianId: z.string().min(1),
    percent: z.coerce.number().min(0).max(100).optional(),
  }).parse(req.query);
  res.json(await commissionForJob(q.visitId, q.technicianId, q.percent ?? null));
}));

timeRouter.get("/time/commissions", guard(async (req, res) => {
  const q = z.object({
    technicianId: z.string().optional(),
    visitId: z.string().optional(),
  }).parse(req.query);
  const rows = await prisma.commission.findMany({
    where: {
      ...(q.technicianId ? { technicianId: q.technicianId } : {}),
      ...(q.visitId ? { visitId: q.visitId } : {}),
    },
    orderBy: { earnedAt: "desc" },
    take: 500,
    include: {
      technician: { select: { id: true, name: true } },
      visit: { select: { id: true, customer: { select: { name: true } }, property: { select: { addressLine1: true } } } },
    },
  });
  res.json(rows.map((c) => ({
    id: c.id,
    technicianId: c.technicianId,
    technicianName: c.technician.name,
    visitId: c.visitId,
    visitLabel: c.visit ? `${c.visit.customer.name} — ${c.visit.property.addressLine1}` : null,
    issuedEstimateId: c.issuedEstimateId,
    basis: c.basis,
    percent: c.percent,
    amount: c.amount,
    note: c.note,
    reason: c.reason,
    earnedAt: c.earnedAt.toISOString(),
    paidAt: c.paidAt?.toISOString() ?? null,
  })));
}));

/**
 * Record a commission. basis "job_profit" computes it from revenue − material −
 * fees at the given (or the technician's) percentage; "manual" takes the amount
 * Kyle types. An override on a job needs a reason — rule 7.
 */
timeRouter.post("/time/commissions", guard(async (req, res) => {
  const body = z.object({
    technicianId: z.string().min(1),
    visitId: z.string().nullable().optional(),
    basis: z.enum(["job_profit", "manual"]).default("job_profit"),
    percent: z.number().min(0).max(100).nullable().optional(),
    amount: z.number().nullable().optional(),
    note: z.string().trim().max(300).nullable().optional(),
    reason: z.string().trim().max(300).nullable().optional(),
    earnedAt: stamp.optional(),
  }).parse(req.body);

  let amount = body.amount ?? null;
  let percent = body.percent ?? null;
  if (body.basis === "job_profit") {
    if (!body.visitId) throw new TimeError("A job-profit commission needs the job it came from.", 400);
    const quote = await commissionForJob(body.visitId, body.technicianId, percent);
    if (quote.amount == null) {
      throw new TimeError(
        quote.percentSet
          ? "That job has no revenue recorded yet, so there is no profit to take a percentage of."
          : "No commission percent is set for this technician — type one on their Team page first.",
        400,
      );
    }
    percent = quote.percent;
    // A typed amount overrides the computed one, which is the per-job override
    // Kyle asked for — and that is exactly when the reason is required.
    if (body.amount != null && Math.abs(body.amount - quote.amount) > 0.005) {
      if (!body.reason) throw new TimeError("Overriding the computed commission takes a reason.", 400);
      amount = body.amount;
    } else {
      amount = quote.amount;
    }
  }
  if (amount == null) throw new TimeError("A manual commission needs an amount.", 400);

  const row = await prisma.commission.create({
    data: {
      technicianId: body.technicianId,
      visitId: body.visitId ?? null,
      basis: body.basis,
      percent,
      amount: Math.round(amount * 100) / 100,
      note: body.note ?? null,
      reason: body.reason ?? null,
      ...(body.earnedAt ? { earnedAt: toDate(body.earnedAt) } : {}),
    },
  });
  res.status(201).json(row);
}));

timeRouter.delete("/time/commissions/:id", guard(async (req, res) => {
  const body = z.object({ reason: reasonSchema }).parse(req.body ?? {});
  const id = readParam(req, "id");
  const existing = await prisma.commission.findUnique({ where: { id } });
  if (!existing) { res.status(404).json({ error: "Commission not found" }); return; }
  // TimeEdit is the trail for HOURS (kind shift|job); a removed commission is
  // money, so its reason is filed where every other money correction is read.
  logSystemEvent("info", "time", `Commission of $${existing.amount.toFixed(2)} removed — ${body.reason}`, {
    commissionId: id, technicianId: existing.technicianId, visitId: existing.visitId, amount: existing.amount,
  });
  await prisma.commission.delete({ where: { id } });
  res.status(204).end();
}));
