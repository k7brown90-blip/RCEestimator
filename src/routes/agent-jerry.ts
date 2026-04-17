/**
 * Jerry agent routes — Mode 2 (scheduling) + Mode 1 additions (delete-last-item).
 */

import express from "express";
import { z, ZodError } from "zod";
import { prisma } from "../lib/prisma";
import {
  asyncHandler,
  logAgent,
  checkIdempotency,
  saveIdempotency,
  agentAuth,
  zodErrorMiddleware,
  successResponse,
  errorResponse,
} from "./agent-helpers";
import { scheduleJob, rescheduleJob, cancelJob, ConflictError } from "../services/scheduling";

const TZ = "America/Chicago";

export const jerryRouter = express.Router();
jerryRouter.use(agentAuth);

// ─── POST /jerry/jobs/ready-to-schedule ─────────────────────────────────────────

jerryRouter.post("/jobs/ready-to-schedule", asyncHandler(async (req, res) => {
  const start = Date.now();
  const clientRequestId = req.headers["x-client-request-id"] as string | undefined;
  const endpoint = "/jerry/jobs/ready-to-schedule";

  const cached = await checkIdempotency(clientRequestId, endpoint);
  if (cached) { res.json(cached); return; }

  const jobs = await prisma.visit.findMany({
    where: { status: "contracted" },
    include: {
      customer: { select: { name: true, phone: true } },
      property: { select: { addressLine1: true, city: true } },
    },
    orderBy: { contractedAt: "asc" },
    take: 10,
  });

  const data = jobs.map((j) => ({
    job_id: j.id,
    customer_name: j.customer.name,
    phone: j.customer.phone,
    address: `${j.property.addressLine1}, ${j.property.city}`,
    job_type: j.jobType ?? "service",
    duration_days: j.estimatedDurationDays ?? 1,
    duration_hours: j.estimatedDurationHours ?? (j.estimatedJobLength ?? 8),
    contracted_at: j.contractedAt?.toISOString() ?? null,
  }));

  const spoken = data.length === 0
    ? "No contracted jobs waiting to be scheduled."
    : `${data.length} job${data.length > 1 ? "s" : ""} ready to schedule. The oldest is ${data[0].customer_name}'s ${data[0].job_type}.`;

  const resp = successResponse({ jobs: data }, spoken);
  await saveIdempotency(clientRequestId, endpoint, undefined, resp, "jerry");
  logAgent("jerry_ready_to_schedule", { agent: "jerry", endpoint, responseStatus: 200, durationMs: Date.now() - start, clientRequestId });
  res.json(resp);
}));

// ─── POST /jerry/jobs/schedule ──────────────────────────────────────────────────

jerryRouter.post("/jobs/schedule", asyncHandler(async (req, res) => {
  const start = Date.now();
  const clientRequestId = req.headers["x-client-request-id"] as string | undefined;
  const endpoint = "/jerry/jobs/schedule";

  const cached = await checkIdempotency(clientRequestId, endpoint);
  if (cached) { res.json(cached); return; }

  const body = z.object({
    job_id: z.string().min(1),
    start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD"),
    start_time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  }).parse(req.body);

  try {
    const result = await scheduleJob(body.job_id, body.start_date, body.start_time);

    const formatDate = (d: Date) => d.toLocaleDateString("en-US", {
      timeZone: TZ, weekday: "short", month: "short", day: "numeric",
    });
    const formatTime = (d: Date) => d.toLocaleTimeString("en-US", {
      timeZone: TZ, hour: "numeric", minute: "2-digit",
    });

    const resp = successResponse(
      {
        job_id: result.jobId,
        scheduled_start: result.scheduledStart.toISOString(),
        scheduled_end: result.scheduledEnd.toISOString(),
        duration_days: result.durationDays,
        customer_notified: result.customerNotified,
        kyle_notified: result.kyleNotified,
        google_event_id: result.googleEventId,
      },
      `Scheduled for ${formatDate(result.scheduledStart)} at ${formatTime(result.scheduledStart)}, ${result.durationDays} day${result.durationDays > 1 ? "s" : ""}. Customer and Kyle both notified.`,
    );
    await saveIdempotency(clientRequestId, endpoint, body.job_id, resp, "jerry");
    logAgent("jerry_schedule_job", { agent: "jerry", endpoint, responseStatus: 200, durationMs: Date.now() - start, clientRequestId });
    res.json(resp);
  } catch (err) {
    if (err instanceof ConflictError) {
      const resp = errorResponse("CALENDAR_CONFLICT", err.message, err.spokenFallback);
      logAgent("jerry_schedule_job_conflict", { agent: "jerry", endpoint, responseStatus: 409, durationMs: Date.now() - start, clientRequestId });
      res.status(409).json(resp);
      return;
    }
    throw err;
  }
}));

// ─── POST /jerry/lookup-job ────────────────────────────────────────────────────

jerryRouter.post("/lookup-job", asyncHandler(async (req, res) => {
  const start = Date.now();
  const clientRequestId = req.headers["x-client-request-id"] as string | undefined;
  const endpoint = "/jerry/lookup-job";

  const cached = await checkIdempotency(clientRequestId, endpoint);
  if (cached) { res.json(cached); return; }

  const body = z.object({
    phone: z.string().optional(),
    address: z.string().optional(),
  }).refine(
    (d) => d.phone || d.address,
    { message: "At least one of phone or address is required" },
  ).parse(req.body);

  const customerConditions: Array<{ customerId: { in: string[] } }> = [];

  if (body.phone) {
    const digits10 = body.phone.replace(/\D/g, "").slice(-10);
    const matchingCustomers = await prisma.customer.findMany({
      where: { phone: { contains: digits10 } },
      select: { id: true },
      take: 10,
    });
    if (matchingCustomers.length > 0) {
      customerConditions.push({ customerId: { in: matchingCustomers.map(c => c.id) } });
    }
  }

  if (body.address) {
    const matchingProperties = await prisma.property.findMany({
      where: { addressLine1: { contains: body.address } },
      select: { id: true, customerId: true },
      take: 10,
    });
    if (matchingProperties.length > 0) {
      customerConditions.push({ customerId: { in: matchingProperties.map(p => p.customerId) } });
    }
  }

  if (customerConditions.length === 0) {
    res.status(404).json(errorResponse("NOT_FOUND", "No matching jobs", "I couldn't find any jobs with that info."));
    return;
  }

  const jobs = await prisma.visit.findMany({
    where: {
      OR: customerConditions,
      status: { in: ["scheduled", "in_progress"] },
    },
    include: {
      customer: { select: { name: true, phone: true } },
      property: { select: { addressLine1: true, city: true } },
    },
    orderBy: { scheduledStart: "asc" },
    take: 3,
  });

  if (jobs.length === 0) {
    res.status(404).json(errorResponse("NOT_FOUND", "No scheduled jobs found", "I found the customer but they have no scheduled jobs."));
    return;
  }

  const data = jobs.map(j => ({
    job_id: j.id,
    customer_name: j.customer.name,
    address: `${j.property.addressLine1}, ${j.property.city}`,
    scheduled_start: j.scheduledStart?.toISOString() ?? null,
    scheduled_end: j.scheduledEnd?.toISOString() ?? null,
    duration_days: j.estimatedDurationDays ?? 1,
    job_type: j.jobType ?? "service",
    status: j.status,
  }));

  const spoken = `Found ${data.length} job${data.length > 1 ? "s" : ""}. ${data[0].customer_name}'s ${data[0].job_type} is ${data[0].status}.`;

  const resp = successResponse({ jobs: data }, spoken);
  await saveIdempotency(clientRequestId, endpoint, undefined, resp, "jerry");
  logAgent("jerry_lookup_job", { agent: "jerry", endpoint, responseStatus: 200, durationMs: Date.now() - start, clientRequestId });
  res.json(resp);
}));

// ─── POST /jerry/reschedule-job ───────────────────────────────────────────────

jerryRouter.post("/reschedule-job", asyncHandler(async (req, res) => {
  const start = Date.now();
  const clientRequestId = req.headers["x-client-request-id"] as string | undefined;
  const endpoint = "/jerry/reschedule-job";

  const cached = await checkIdempotency(clientRequestId, endpoint);
  if (cached) { res.json(cached); return; }

  if (req.body && ("new_duration" in req.body || "duration_days" in req.body)) {
    res.status(400).json(errorResponse(
      "INVALID_PARAMETER",
      "Duration changes are not allowed on reschedule.",
      "I can't change the duration of a job. I can only move it to a new date.",
    ));
    return;
  }

  const body = z.object({
    job_id: z.string().min(1),
    new_start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD"),
    new_start_time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    reason: z.string().min(1),
  }).parse(req.body);

  try {
    const result = await rescheduleJob(
      body.job_id,
      body.new_start_date,
      body.new_start_time ?? null,
      body.reason,
    );

    const formatDate = (d: Date) => d.toLocaleDateString("en-US", {
      timeZone: TZ, weekday: "short", month: "short", day: "numeric",
    });
    const formatTime = (d: Date) => d.toLocaleTimeString("en-US", {
      timeZone: TZ, hour: "numeric", minute: "2-digit",
    });

    const resp = successResponse(
      {
        job_id: result.jobId,
        scheduled_start: result.scheduledStart.toISOString(),
        scheduled_end: result.scheduledEnd.toISOString(),
        duration_days: result.durationDays,
        customer_notified: result.customerNotified,
        kyle_notified: result.kyleNotified,
      },
      `Rescheduled to ${formatDate(result.scheduledStart)} at ${formatTime(result.scheduledStart)}. Customer and Kyle both notified.`,
    );
    await saveIdempotency(clientRequestId, endpoint, body.job_id, resp, "jerry");
    logAgent("jerry_reschedule_job", { agent: "jerry", endpoint, responseStatus: 200, durationMs: Date.now() - start, clientRequestId });
    res.json(resp);
  } catch (err) {
    if (err instanceof ConflictError) {
      const resp = errorResponse("CALENDAR_CONFLICT", err.message, err.spokenFallback);
      logAgent("jerry_reschedule_conflict", { agent: "jerry", endpoint, responseStatus: 409, durationMs: Date.now() - start, clientRequestId });
      res.status(409).json(resp);
      return;
    }
    throw err;
  }
}));

// ─── POST /jerry/cancel-job ───────────────────────────────────────────────────

jerryRouter.post("/cancel-job", asyncHandler(async (req, res) => {
  const start = Date.now();
  const clientRequestId = req.headers["x-client-request-id"] as string | undefined;
  const endpoint = "/jerry/cancel-job";

  const cached = await checkIdempotency(clientRequestId, endpoint);
  if (cached) { res.json(cached); return; }

  const body = z.object({
    job_id: z.string().min(1),
    reason: z.string().min(1),
  }).parse(req.body);

  const result = await cancelJob(body.job_id, body.reason);

  const resp = successResponse(
    {
      cancelled: true,
      customer_notified: result.customerNotified,
      kyle_notified: result.kyleNotified,
    },
    `Job cancelled. ${result.customerNotified ? "Customer has been notified." : "Customer could not be reached."} Reason: ${body.reason}`,
  );
  await saveIdempotency(clientRequestId, endpoint, body.job_id, resp, "jerry");
  logAgent("jerry_cancel_job", { agent: "jerry", endpoint, responseStatus: 200, durationMs: Date.now() - start, clientRequestId });
  res.json(resp);
}));

// ─── DELETE /jerry/visits/active/last-item ──────────────────────────────────────

jerryRouter.delete("/visits/active/last-item", asyncHandler(async (req, res) => {
  const start = Date.now();
  const clientRequestId = req.headers["x-client-request-id"] as string | undefined;
  const endpoint = "/jerry/visits/active/last-item";

  // Resolve active visit — import shared state from agent.ts
  // We need to check for x-active-visit-id header since this is a separate router
  const visitId = req.headers["x-active-visit-id"] as string | undefined;
  if (!visitId) {
    res.status(404).json(errorResponse("NO_ACTIVE_VISIT", "No active visit", "Set an active visit first before deleting items."));
    return;
  }

  const body = z.object({
    item_type: z.enum(["observation", "finding", "deficiency", "limitation", "recommendation"]).optional(),
  }).parse(req.body ?? {});

  const itemType = body.item_type;

  // Define which models to search, ordered by most recent first
  type ItemTable = "observation" | "finding" | "limitation" | "recommendation";
  const tables: Array<{ type: ItemTable; model: string; textField: string }> = [
    { type: "observation", model: "observation", textField: "observationText" },
    { type: "finding", model: "finding", textField: "findingText" },
    { type: "limitation", model: "limitation", textField: "limitationText" },
    { type: "recommendation", model: "recommendation", textField: "recommendationText" },
  ];

  // Deficiencies are stored in SystemSnapshot.deficienciesJson — handled separately
  if (itemType === "deficiency") {
    const visit = await prisma.visit.findUnique({
      where: { id: visitId },
      include: { property: { include: { systemSnapshot: true } } },
    });
    if (!visit?.property?.systemSnapshot?.deficienciesJson) {
      res.status(404).json(errorResponse("NO_ITEMS", "No deficiencies to delete", "There are no deficiencies to undo."));
      return;
    }
    const deficiencies: string[] = JSON.parse(visit.property.systemSnapshot.deficienciesJson);
    if (deficiencies.length === 0) {
      res.status(404).json(errorResponse("NO_ITEMS", "No deficiencies to delete", "There are no deficiencies to undo."));
      return;
    }
    const removed = deficiencies.pop()!;
    await prisma.systemSnapshot.update({
      where: { propertyId: visit.propertyId },
      data: { deficienciesJson: JSON.stringify(deficiencies) },
    });
    const resp = successResponse(
      { deleted_type: "deficiency", deleted_content: removed },
      `Removed the last deficiency: "${removed.slice(0, 60)}".`,
    );
    logAgent("jerry_delete_last_item", { agent: "jerry", visitId, endpoint, responseStatus: 200, durationMs: Date.now() - start, clientRequestId });
    res.json(resp);
    return;
  }

  // For regular items, find the most recent across all types (or filtered)
  const searchTables = itemType
    ? tables.filter(t => t.type === itemType)
    : tables;

  let mostRecent: { type: string; id: string; content: string; createdAt: Date } | null = null;

  for (const table of searchTables) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const record = await (prisma as any)[table.model].findFirst({
      where: { visitId },
      orderBy: { createdAt: "desc" },
    });
    if (record) {
      const createdAt = record.createdAt as Date;
      if (!mostRecent || createdAt > mostRecent.createdAt) {
        mostRecent = {
          type: table.type,
          id: record.id as string,
          content: record[table.textField] as string,
          createdAt,
        };
      }
    }
  }

  if (!mostRecent) {
    const typeLabel = itemType ? `${itemType}s` : "items";
    res.status(404).json(errorResponse("NO_ITEMS", `No ${typeLabel} to delete`, `There are no ${typeLabel} to undo.`));
    return;
  }

  // Delete the record
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (prisma as any)[mostRecent.type].delete({ where: { id: mostRecent.id } });

  const resp = successResponse(
    { deleted_type: mostRecent.type, deleted_content: mostRecent.content },
    `Removed the last ${mostRecent.type}: "${mostRecent.content.slice(0, 60)}".`,
  );
  logAgent("jerry_delete_last_item", { agent: "jerry", visitId, endpoint, responseStatus: 200, durationMs: Date.now() - start, clientRequestId });
  res.json(resp);
}));

// ─── POST /jerry/lookup-customer ────────────────────────────────────────────────

jerryRouter.post("/lookup-customer", asyncHandler(async (req, res) => {
  const start = Date.now();
  const clientRequestId = req.headers["x-client-request-id"] as string | undefined;
  const endpoint = "/jerry/lookup-customer";

  const cached = await checkIdempotency(clientRequestId, endpoint);
  if (cached) { res.json(cached); return; }

  const body = z.object({
    name: z.string().min(1, "Customer name is required"),
  }).parse(req.body);

  const customers = await prisma.customer.findMany({
    where: { name: { contains: body.name } },
    include: {
      properties: { select: { id: true, addressLine1: true, city: true, state: true } },
    },
    take: 5,
  });

  if (customers.length === 0) {
    res.status(404).json(errorResponse("NOT_FOUND", "No customers found with that name", `I couldn't find any customer named ${body.name}.`));
    return;
  }

  const data = customers.map(c => ({
    customer_id: c.id,
    name: c.name,
    phone: c.phone ?? null,
    email: c.email ?? null,
    properties: c.properties.map(p => ({
      property_id: p.id,
      address: `${p.addressLine1}, ${p.city}, ${p.state}`,
    })),
  }));

  const spoken = customers.length === 1
    ? `Found ${data[0].name}${data[0].properties.length > 0 ? ` at ${data[0].properties[0].address}` : ""}.`
    : `Found ${customers.length} customers matching "${body.name}".`;

  const resp = successResponse({ customers: data }, spoken);
  await saveIdempotency(clientRequestId, endpoint, undefined, resp, "jerry");
  logAgent("jerry_lookup_customer", { agent: "jerry", endpoint, responseStatus: 200, durationMs: Date.now() - start, clientRequestId });
  res.json(resp);
}));

// Zod error handler — must be after all routes
jerryRouter.use(zodErrorMiddleware as express.ErrorRequestHandler);
