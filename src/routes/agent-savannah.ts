/**
 * Savannah agent routes — receptionist/scheduling endpoints.
 * lookup-job, job-schedule, reschedule-job
 */

import express from "express";
import { z, ZodError } from "zod";
import { prisma } from "../lib/prisma";
import {
  asyncHandler,
  normalizePhone,
  logAgent,
  checkIdempotency,
  saveIdempotency,
  agentAuth,
  zodErrorMiddleware,
  successResponse,
  errorResponse,
} from "./agent-helpers";
import { rescheduleJob, cancelJob, ConflictError } from "../services/scheduling";
import { checkAvailabilityBlock } from "../services/schedule";

const TZ = "America/Chicago";

export const savannahRouter = express.Router();
savannahRouter.use(agentAuth);

// ─── POST /savannah/lookup-job ──────────────────────────────────────────────────

savannahRouter.post("/lookup-job", asyncHandler(async (req, res) => {
  const start = Date.now();
  const clientRequestId = req.headers["x-client-request-id"] as string | undefined;
  const endpoint = "/savannah/lookup-job";

  const cached = await checkIdempotency(clientRequestId, endpoint);
  if (cached) { res.json(cached); return; }

  const body = z.object({
    phone: z.string().optional(),
    address: z.string().optional(),
  }).refine(
    (d) => d.phone || d.address,
    { message: "At least one of phone or address is required" },
  ).parse(req.body);

  // Find matching customers/properties
  const customerConditions: Array<{ customerId: { in: string[] } }> = [];

  if (body.phone) {
    const normalized = normalizePhone(body.phone);
    const digits10 = normalized.replace(/\D/g, "").slice(-10);
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
    const resp = successResponse(
      { matches: [], disambiguation_hint: null },
      "I couldn't find any jobs matching that information.",
    );
    await saveIdempotency(clientRequestId, endpoint, undefined, resp, "savannah");
    res.json(resp);
    return;
  }

  // Find jobs (visits) with status scheduled or in_progress, with future dates
  const jobs = await prisma.visit.findMany({
    where: {
      status: { in: ["scheduled", "in_progress"] },
      scheduledStart: { gte: new Date() },
      ...(customerConditions.length === 1
        ? customerConditions[0]
        : { OR: customerConditions }),
    },
    include: {
      customer: { select: { name: true, phone: true } },
      property: { select: { addressLine1: true, city: true } },
    },
    orderBy: { scheduledStart: "asc" },
    take: 3,
  });

  let matches = jobs;
  if (matches.length === 0 && body.phone) {
    const digits10 = normalizePhone(body.phone).replace(/\D/g, "").slice(-10);
    const customers = await prisma.customer.findMany({
      where: { phone: { contains: digits10 } },
      select: { id: true },
      take: 5,
    });
    if (customers.length > 0) {
      matches = await prisma.visit.findMany({
        where: {
          customerId: { in: customers.map(c => c.id) },
          status: { in: ["scheduled", "in_progress"] },
        },
        include: {
          customer: { select: { name: true, phone: true } },
          property: { select: { addressLine1: true, city: true } },
        },
        orderBy: { scheduledStart: "asc" },
        take: 3,
      });
    }
  }

  const matchData = matches.map((j) => ({
    job_id: j.id,
    customer_name: j.customer.name,
    address: `${j.property.addressLine1}, ${j.property.city}`,
    scheduled_start: j.scheduledStart?.toISOString() ?? null,
    scheduled_end: j.scheduledEnd?.toISOString() ?? null,
    duration_days: j.estimatedDurationDays ?? 1,
    job_type: j.jobType ?? "service",
    status: j.status,
  }));

  const disambiguation = matchData.length > 1
    ? `I found ${matchData.length} jobs. Which one are you calling about?`
    : null;

  const spoken = matchData.length === 0
    ? "I couldn't find any upcoming jobs matching that information."
    : matchData.length === 1
      ? `I found a ${matchData[0].job_type} for ${matchData[0].customer_name}.`
      : `I found ${matchData.length} upcoming jobs. Which one are you calling about?`;

  const resp = successResponse(
    { matches: matchData, disambiguation_hint: disambiguation },
    spoken,
  );
  await saveIdempotency(clientRequestId, endpoint, undefined, resp, "savannah");
  logAgent("savannah_lookup_job", { agent: "savannah", endpoint, responseStatus: 200, durationMs: Date.now() - start, clientRequestId });
  res.json(resp);
}));

// ─── POST /savannah/job-schedule ────────────────────────────────────────────────

savannahRouter.post("/job-schedule", asyncHandler(async (req, res) => {
  const start = Date.now();
  const clientRequestId = req.headers["x-client-request-id"] as string | undefined;
  const endpoint = "/savannah/job-schedule";

  const cached = await checkIdempotency(clientRequestId, endpoint);
  if (cached) { res.json(cached); return; }

  const body = z.object({
    job_id: z.string().min(1),
  }).parse(req.body);

  const job = await prisma.visit.findUnique({
    where: { id: body.job_id },
    include: {
      customer: { select: { name: true, phone: true } },
      property: { select: { addressLine1: true, city: true } },
    },
  });

  if (!job) {
    res.status(404).json(errorResponse("NOT_FOUND", "Job not found", "I couldn't find that job."));
    return;
  }

  const formatDate = (d: Date) => d.toLocaleDateString("en-US", {
    timeZone: TZ, weekday: "long", month: "long", day: "numeric",
  });
  const formatTime = (d: Date) => d.toLocaleTimeString("en-US", {
    timeZone: TZ, hour: "numeric", minute: "2-digit",
  });

  const data = {
    job_id: job.id,
    customer_name: job.customer.name,
    customer_phone: job.customer.phone,
    address: `${job.property.addressLine1}, ${job.property.city}`,
    job_type: job.jobType ?? "service",
    status: job.status,
    scheduled_start: job.scheduledStart?.toISOString() ?? null,
    scheduled_end: job.scheduledEnd?.toISOString() ?? null,
    scheduled_start_display: job.scheduledStart ? `${formatDate(job.scheduledStart)} at ${formatTime(job.scheduledStart)}` : null,
    scheduled_end_display: job.scheduledEnd ? formatDate(job.scheduledEnd) : null,
    duration_days: job.estimatedDurationDays ?? 1,
    google_event_id: job.googleEventId ?? null,
  };

  const spoken = job.scheduledStart
    ? `${job.customer.name}'s ${job.jobType ?? "service"} is scheduled for ${formatDate(job.scheduledStart)} at ${formatTime(job.scheduledStart)}, ${job.estimatedDurationDays ?? 1} day(s).`
    : `${job.customer.name}'s ${job.jobType ?? "service"} is not yet scheduled.`;

  const resp = successResponse(data, spoken);
  await saveIdempotency(clientRequestId, endpoint, body.job_id, resp, "savannah");
  logAgent("savannah_job_schedule", { agent: "savannah", endpoint, responseStatus: 200, durationMs: Date.now() - start, clientRequestId });
  res.json(resp);
}));

// ─── POST /savannah/reschedule-job ──────────────────────────────────────────────

savannahRouter.post("/reschedule-job", asyncHandler(async (req, res) => {
  const start = Date.now();
  const clientRequestId = req.headers["x-client-request-id"] as string | undefined;
  const endpoint = "/savannah/reschedule-job";

  const cached = await checkIdempotency(clientRequestId, endpoint);
  if (cached) { res.json(cached); return; }

  // Reject duration-changing parameters
  if (req.body && ("new_duration" in req.body || "duration_days" in req.body)) {
    res.status(400).json(errorResponse(
      "INVALID_PARAMETER",
      "Duration changes are not allowed on reschedule — contact Kyle directly for scope changes.",
      "I can't change the duration of a job. I can only move it to a new date. For scope changes, Kyle will need to discuss that with you.",
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
      timeZone: TZ, weekday: "long", month: "long", day: "numeric",
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
      `Done — rescheduled to ${formatDate(result.scheduledStart)} at ${formatTime(result.scheduledStart)}. Both you and Kyle have been notified.`,
    );
    await saveIdempotency(clientRequestId, endpoint, body.job_id, resp, "savannah");
    logAgent("savannah_reschedule_job", { agent: "savannah", endpoint, responseStatus: 200, durationMs: Date.now() - start, clientRequestId });
    res.json(resp);
  } catch (err) {
    if (err instanceof ConflictError) {
      const resp = errorResponse("CALENDAR_CONFLICT", err.message, err.spokenFallback);
      logAgent("savannah_reschedule_job_conflict", { agent: "savannah", endpoint, responseStatus: 409, durationMs: Date.now() - start, clientRequestId });
      res.status(409).json(resp);
      return;
    }
    throw err;
  }
}));

// ─── POST /savannah/lookup-customer ─────────────────────────────────────────────

savannahRouter.post("/lookup-customer", asyncHandler(async (req, res) => {
  const start = Date.now();
  const clientRequestId = req.headers["x-client-request-id"] as string | undefined;
  const endpoint = "/savannah/lookup-customer";

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
  await saveIdempotency(clientRequestId, endpoint, undefined, resp, "savannah");
  logAgent("savannah_lookup_customer", { agent: "savannah", endpoint, responseStatus: 200, durationMs: Date.now() - start, clientRequestId });
  res.json(resp);
}));

// ─── POST /savannah/cancel-job ──────────────────────────────────────────────────

savannahRouter.post("/cancel-job", asyncHandler(async (req, res) => {
  const start = Date.now();
  const clientRequestId = req.headers["x-client-request-id"] as string | undefined;
  const endpoint = "/savannah/cancel-job";

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
  await saveIdempotency(clientRequestId, endpoint, body.job_id, resp, "savannah");
  logAgent("savannah_cancel_job", { agent: "savannah", endpoint, responseStatus: 200, durationMs: Date.now() - start, clientRequestId });
  res.json(resp);
}));

// ─── POST /savannah/lookup-customer-by-email ────────────────────────────────────

savannahRouter.post("/lookup-customer-by-email", asyncHandler(async (req, res) => {
  const start = Date.now();
  const clientRequestId = req.headers["x-client-request-id"] as string | undefined;
  const endpoint = "/savannah/lookup-customer-by-email";

  const cached = await checkIdempotency(clientRequestId, endpoint);
  if (cached) { res.json(cached); return; }

  const body = z.object({
    email: z.string().min(1, "Email is required"),
  }).parse(req.body);

  const customers = await prisma.customer.findMany({
    where: { email: { contains: body.email } },
    include: {
      properties: { select: { id: true, addressLine1: true, city: true, state: true, postalCode: true } },
    },
    take: 5,
  });

  if (customers.length === 0) {
    res.status(404).json(errorResponse("NOT_FOUND", "No customers found with that Email", `I couldn't find any customer with the email ${body.email}.`));
    return;
  }

  const data = customers.map(c => ({
    customer_id: c.id,
    name: c.name,
    phone: c.phone ?? null,
    email: c.email ?? null,
    service_addresses: c.properties.map(p => ({
      property_id: p.id,
      address: `${p.addressLine1}, ${p.city}, ${p.state} ${p.postalCode}`,
    })),
  }));

  const spoken = customers.length === 1
    ? `Found ${data[0].name} with email ${data[0].email}${data[0].service_addresses.length > 0 ? ` at ${data[0].service_addresses[0].address}` : ""}.`
    : `Found ${customers.length} customers matching that email.`;

  const resp = successResponse({ customers: data }, spoken);
  await saveIdempotency(clientRequestId, endpoint, undefined, resp, "savannah");
  logAgent("savannah_lookup_customer_by_email", { agent: "savannah", endpoint, responseStatus: 200, durationMs: Date.now() - start, clientRequestId });
  res.json(resp);
}));

// Zod error handler — must be after all routes
savannahRouter.use(zodErrorMiddleware as express.ErrorRequestHandler);
