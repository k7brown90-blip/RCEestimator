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
} from "./agent-helpers";
import { checkAvailabilityBlock } from "../services/schedule";
import { getAvailability } from "../services/googleCalendar";

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

// Zod error handler — must be after all routes
sharedAgentRouter.use(zodErrorMiddleware as express.ErrorRequestHandler);
