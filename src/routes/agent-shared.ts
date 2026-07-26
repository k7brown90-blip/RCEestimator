/**
 * Shared agent routes — endpoints used by both Savannah and Jerry.
 * availability-block
 */

import express from "express";
import { z, ZodError } from "zod";
import {
  asyncHandler,
  logAgent,
  checkIdempotency,
  saveIdempotency,
  agentAuth,
  zodErrorMiddleware,
  successResponse,
  normalizePhone,
} from "./agent-helpers";
import { checkAvailabilityBlock } from "../services/schedule";
import { getAvailability } from "../services/googleCalendar";
import { prisma } from "../lib/prisma";

export const sharedAgentRouter = express.Router();
sharedAgentRouter.use(agentAuth);

// ─── POST /calendar/check-availability ─────────────────────────────────────────

sharedAgentRouter.all("/check-availability", asyncHandler(async (req, res) => {
  const start = Date.now();
  const clientRequestId = req.headers["x-client-request-id"] as string | undefined;
  const endpoint = "/calendar/check-availability";

  const cached = await checkIdempotency(clientRequestId, endpoint);
  if (cached) { res.json(cached); return; }

  // Optional start_date param (YYYY-MM-DD) to check availability from a specific date
  let startDate: Date | undefined;
  const rawStartDate = req.body?.start_date ?? req.query?.start_date;
  if (rawStartDate && typeof rawStartDate === "string") {
    const parsed = new Date(`${rawStartDate}T12:00:00Z`);
    if (!isNaN(parsed.getTime())) startDate = parsed;
  }

  const availability = await getAvailability(startDate);

  const spoken = `I have availability for the next ${availability.available_slots.length} business days. Let me share the open slots.`;

  const resp = successResponse(availability, spoken);
  await saveIdempotency(clientRequestId, endpoint, undefined, resp);
  logAgent("check_availability", { endpoint, responseStatus: 200, durationMs: Date.now() - start, clientRequestId });
  res.json(resp);
}));

// ─── POST /calendar/availability-block ──────────────────────────────────────────

sharedAgentRouter.post("/availability-block", asyncHandler(async (req, res) => {
  const start = Date.now();
  const clientRequestId = req.headers["x-client-request-id"] as string | undefined;
  const endpoint = "/calendar/availability-block";

  const cached = await checkIdempotency(clientRequestId, endpoint);
  if (cached) { res.json(cached); return; }

  const body = z.object({
    start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD"),
    days_needed: z.number().int().min(1).max(10),
    exclude_event_id: z.string().optional(),
  }).parse(req.body);

  const startDate = new Date(`${body.start_date}T12:00:00Z`); // Noon UTC to avoid date boundary issues
  const result = await checkAvailabilityBlock(startDate, body.days_needed, body.exclude_event_id);

  const spoken = result.available
    ? `${body.start_date} is open for ${body.days_needed} day${body.days_needed > 1 ? "s" : ""}.`
    : `There are conflicts: ${result.conflicts.map(c => c.date).join(", ")}.`;

  const resp = successResponse(
    {
      available: result.available,
      start_date: body.start_date,
      days_needed: body.days_needed,
      conflicts: result.conflicts,
    },
    spoken,
  );
  await saveIdempotency(clientRequestId, endpoint, undefined, resp);
  logAgent("calendar_availability_block", { endpoint, responseStatus: 200, durationMs: Date.now() - start, clientRequestId });
  res.json(resp);
}));

// ─── POST /calendar/call-disposition ────────────────────────────────────────────
// Structured end-of-call outcome. Every agent call should terminate with one of
// these so no conversation leaves the pipeline without a state: which lead it
// was, where it stands, and when to follow up. Resolves the lead by id, then by
// phone (most recent), and creates one as a last resort so the outcome is never
// dropped on the floor.

sharedAgentRouter.post("/call-disposition", asyncHandler(async (req, res) => {
  const start = Date.now();
  const clientRequestId = req.headers["x-client-request-id"] as string | undefined;
  const endpoint = "/calendar/call-disposition";

  const cached = await checkIdempotency(clientRequestId, endpoint);
  if (cached) { res.json(cached); return; }

  const body = z.object({
    lead_id: z.string().min(1).optional(),
    phone: z.string().min(7).optional(),
    name: z.string().min(1).optional(),
    call_type: z.string().min(1), // new_job | warranty | reschedule | estimate_followup | callback | ...
    lead_status: z.enum(["new", "booked", "unresolved", "planning", "no_answer", "lost", "won"]),
    follow_up_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    follow_up_reason: z.string().optional(),
    lost_reason: z.string().optional(),
    best_time_to_reach: z.string().optional(),
    notes: z.string().optional(),
  }).refine((b) => b.lead_id || b.phone || b.name, {
    message: "Provide lead_id, phone, or name so the disposition can be attached to a lead",
  }).parse(req.body);

  // Resolve the lead: explicit id → most recent lead by phone → create new.
  let lead = body.lead_id
    ? await prisma.lead.findUnique({ where: { id: body.lead_id } })
    : null;
  if (!lead && body.phone) {
    const normalized = normalizePhone(body.phone);
    lead = await prisma.lead.findFirst({
      where: { phone: { in: [body.phone, normalized] } },
      orderBy: { createdAt: "desc" },
    });
  }

  const followUpDate = body.follow_up_date ? new Date(`${body.follow_up_date}T12:00:00Z`) : undefined;
  const dispositionNote = `[Call ${new Date().toISOString().slice(0, 10)}] ${body.call_type}/${body.lead_status}${body.notes ? ` — ${body.notes}` : ""}`;

  let created = false;
  if (lead) {
    lead = await prisma.lead.update({
      where: { id: lead.id },
      data: {
        leadStatus: body.lead_status,
        callType: body.call_type,
        ...(followUpDate ? { followUpDate, followUpCount: { increment: 1 } } : {}),
        ...(body.follow_up_reason ? { followUpReason: body.follow_up_reason } : {}),
        ...(body.lost_reason ? { lostReason: body.lost_reason } : {}),
        ...(body.best_time_to_reach ? { bestTimeToReach: body.best_time_to_reach } : {}),
        notes: lead.notes ? `${lead.notes}\n${dispositionNote}` : dispositionNote,
      },
    });
  } else {
    created = true;
    lead = await prisma.lead.create({
      data: {
        name: body.name ?? "Unknown caller",
        phone: body.phone ? normalizePhone(body.phone) : null,
        source: "phone",
        leadStatus: body.lead_status,
        callType: body.call_type,
        followUpDate: followUpDate ?? null,
        followUpReason: body.follow_up_reason ?? null,
        lostReason: body.lost_reason ?? null,
        bestTimeToReach: body.best_time_to_reach ?? null,
        notes: dispositionNote,
      },
    });
  }

  const spoken = followUpDate
    ? `Got it — logged as ${body.lead_status} with a follow-up on ${body.follow_up_date}.`
    : `Got it — logged as ${body.lead_status}.`;

  const resp = successResponse(
    {
      lead_id: lead.id,
      lead_created: created,
      lead_status: lead.leadStatus,
      follow_up_date: lead.followUpDate?.toISOString() ?? null,
    },
    spoken,
  );
  await saveIdempotency(clientRequestId, endpoint, undefined, resp);
  logAgent("call_disposition", {
    endpoint, entityType: "lead", entityId: lead.id,
    payload: { leadStatus: body.lead_status, callType: body.call_type, created },
    responseStatus: 200, durationMs: Date.now() - start, clientRequestId,
  });
  res.json(resp);
}));

// Zod error handler — must be after all routes
sharedAgentRouter.use(zodErrorMiddleware as express.ErrorRequestHandler);
