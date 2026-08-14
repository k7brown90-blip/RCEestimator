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
  readVapiCallId,
} from "./agent-helpers";
import { checkAvailabilityBlock } from "../services/schedule";
import { getAvailability } from "../services/googleCalendar";
import { applyCallDisposition } from "../services/callDisposition";
import { prisma } from "../lib/prisma";
import { sendSms } from "../services/twilio";
import { twilioSendEnabled, logTwilioSendSkipped } from "../services/automationGate";
import { sendDocumentEmail, humanizeDocType } from "../services/documentDelivery";
import { generateHealthReport } from "../services/pdfGenerator";

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

  const spoken = availability.unreachable_calendars.length > 0
    ? `Heads up: ${availability.unreachable_calendars.length} team calendar(s) couldn't be read, so this availability may be incomplete — offer slots but note the schedule will be confirmed. Open slots cover ${availability.available_slots.length} business days.`
    : `I have availability for the next ${availability.available_slots.length} business days. Let me share the open slots.`;

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
  const endpoint = "/calendar/call-disposition";

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
    // A caller-supplied idempotency key that survives even when Vapi reuses
    // the same x-client-request-id header for every tool call in a session —
    // this endpoint is meant to be called more than once per call (a mid-call
    // disposition on booking failure, then a final one), and each of those
    // needs its own cache slot.
    disposition_event_id: z.string().min(1).optional(),
  }).refine((b) => b.lead_id || b.phone || b.name, {
    message: "Provide lead_id, phone, or name so the disposition can be attached to a lead",
  }).parse(req.body);

  const clientRequestId = body.disposition_event_id ?? (req.headers["x-client-request-id"] as string | undefined);
  const callId = readVapiCallId(req);

  const cached = await checkIdempotency(clientRequestId, endpoint);
  if (cached) { res.json(cached); return; }

  const { lead, created } = await applyCallDisposition({
    leadId: body.lead_id,
    phone: body.phone,
    name: body.name,
    callType: body.call_type,
    leadStatus: body.lead_status,
    followUpDate: body.follow_up_date,
    followUpReason: body.follow_up_reason,
    lostReason: body.lost_reason,
    bestTimeToReach: body.best_time_to_reach,
    notes: body.notes,
  });

  const spoken = body.follow_up_date
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
    responseStatus: 200, durationMs: Date.now() - start, clientRequestId, callId,
  });
  res.json(resp);
}));

// ─── POST /technicians/verify ──────────────────────────────────────────────────
// Voice-agent field-team authentication. A caller who claims to be internal
// staff (technician, supervisor, admin) is verified by employee number. On
// match, we return the technician's identity, role, active assignments, and
// recent job history so the agent can transition into administrative mode and
// tie every downstream action back to a real employee (audit + payroll).

sharedAgentRouter.post("/technicians/verify", asyncHandler(async (req, res) => {
  const start = Date.now();
  const clientRequestId = req.headers["x-client-request-id"] as string | undefined;
  const endpoint = "/technicians/verify";

  const cached = await checkIdempotency(clientRequestId, endpoint);
  if (cached) { res.json(cached); return; }

  const body = z.object({
    employee_number: z.string().min(1),
    stated_name: z.string().optional(),
  }).parse(req.body);

  const trimmed = body.employee_number.trim();
  const technician = await prisma.technician.findUnique({
    where: { employeeNumber: trimmed },
    include: {
      assignments: {
        where: { status: { in: ["assigned", "in_progress"] } },
        orderBy: { assignedAt: "desc" },
        take: 5,
        include: {
          visit: {
            select: {
              id: true,
              scheduledStart: true,
              purpose: true,
              status: true,
              customer: { select: { name: true } },
              property: { select: { addressLine1: true, city: true } },
            },
          },
        },
      },
    },
  });

  if (!technician || !technician.isActive) {
    const resp = {
      success: false,
      data: { verified: false },
      spoken_confirmation:
        "I don't have that verified — I'll flag your request for our operations lead.",
      error: { code: "TECH_NOT_VERIFIED", message: "Employee number not recognized or technician is inactive" },
    };
    logAgent("technician_verify_failed", {
      endpoint,
      payload: { employee_number_masked: trimmed.slice(0, 2) + "***", stated_name: body.stated_name },
      responseStatus: 401,
      durationMs: Date.now() - start,
      clientRequestId,
    });
    res.status(401).json(resp);
    return;
  }

  const activeAssignments = technician.assignments.map((a) => ({
    visit_id: a.visit.id,
    customer_name: a.visit.customer.name,
    address: [a.visit.property.addressLine1, a.visit.property.city].filter(Boolean).join(", "),
    purpose: a.visit.purpose,
    status: a.visit.status,
    scheduled_start: a.visit.scheduledStart?.toISOString() ?? null,
    assignment_status: a.status,
  }));

  const nextJob = activeAssignments
    .filter((a) => a.scheduled_start)
    .sort((a, b) => (a.scheduled_start! < b.scheduled_start! ? -1 : 1))[0] ?? null;

  const spokenParts: string[] = [`Got it — thanks, verified as ${technician.name}.`];
  if (nextJob) {
    const when = new Date(nextJob.scheduled_start!).toLocaleString("en-US", {
      timeZone: "America/Chicago",
      weekday: "long",
      hour: "numeric",
      minute: "2-digit",
    });
    spokenParts.push(`Your next job is ${nextJob.customer_name} on ${when}.`);
  } else if (activeAssignments.length > 0) {
    spokenParts.push(`You have ${activeAssignments.length} active assignment${activeAssignments.length === 1 ? "" : "s"}.`);
  }

  const resp = successResponse(
    {
      verified: true,
      technician_id: technician.id,
      name: technician.name,
      role: technician.role,
      active_assignments: activeAssignments,
      next_job: nextJob,
    },
    spokenParts.join(" "),
  );

  await saveIdempotency(clientRequestId, endpoint, undefined, resp);
  logAgent("technician_verify_success", {
    endpoint,
    entityType: "Technician",
    entityId: technician.id,
    payload: { role: technician.role, active_count: activeAssignments.length },
    responseStatus: 200,
    durationMs: Date.now() - start,
    clientRequestId,
  });
  res.json(resp);
}));

// ─── POST /documents/send ──────────────────────────────────────────────────────
// Re-send an existing document PDF (contract, work order, material list, change
// order, health report) to a customer by email, SMS, or both. Used by the
// receptionist agent to fulfill "send me my invoice/receipt/health report"
// requests without human intervention. For SMS, the caller is told the file is
// on the way to their email — the PDF itself is delivered via email attachment.
// Health reports are generated fresh from live inspection data on each send.

sharedAgentRouter.post("/documents/send", asyncHandler(async (req, res) => {
  const start = Date.now();
  const clientRequestId = req.headers["x-client-request-id"] as string | undefined;
  const endpoint = "/documents/send";

  const cached = await checkIdempotency(clientRequestId, endpoint);
  if (cached) { res.json(cached); return; }

  const body = z.object({
    kind: z.enum(["document", "health_report"]),
    id: z.string().min(1),
    method: z.enum(["email", "sms", "both"]),
    email: z.string().email().optional(),
    phone: z.string().min(7).optional(),
    note: z.string().max(500).optional(),
  }).parse(req.body);

  let pdfPath: string;
  let docType: string;
  let documentId: string | null = null;
  let customerName: string;
  let customerEmail: string | null;
  let customerPhone: string | null;

  if (body.kind === "document") {
    const doc = await prisma.document.findUnique({
      where: { id: body.id },
      // A document belongs to a job or, since the finding ledger, directly to an
      // address — a cure certificate for a third-party repair has no Red Cedar
      // visit behind it. Either way there's exactly one customer to send it to.
      include: {
        job: { include: { customer: true } },
        property: { include: { customer: true } },
      },
    });
    if (!doc) {
      res.status(404).json({
        success: false,
        data: null,
        spoken_confirmation: "I couldn't find that document. Let me try again or take a message.",
        error: { code: "NOT_FOUND", message: "Document not found" },
      });
      return;
    }
    const recipient = doc.job?.customer ?? doc.property?.customer;
    if (!recipient) {
      res.status(409).json({
        success: false,
        data: null,
        spoken_confirmation: "That document isn't attached to a customer yet, so I can't send it.",
        error: { code: "NO_RECIPIENT", message: "Document has neither a job nor a property to resolve a customer from" },
      });
      return;
    }
    pdfPath = doc.pdfUrl;
    docType = doc.type;
    documentId = doc.id;
    customerName = recipient.name;
    customerEmail = recipient.email;
    customerPhone = recipient.phone;
  } else {
    const inspection = await prisma.healthInspection.findUnique({
      where: { id: body.id },
      include: { customer: true },
    });
    if (!inspection) {
      res.status(404).json({
        success: false,
        data: null,
        spoken_confirmation: "I couldn't find that health record. Let me try again or take a message.",
        error: { code: "NOT_FOUND", message: "Health inspection not found" },
      });
      return;
    }
    // Generate a fresh PDF (also persists a Document row).
    const generated = await generateHealthReport(inspection.id);
    pdfPath = generated.pdfPath;
    documentId = generated.documentId;
    docType = "health_report";
    customerName = inspection.customer.name;
    customerEmail = inspection.customer.email;
    customerPhone = inspection.customer.phone;
  }

  const recipientEmail = body.email ?? customerEmail ?? null;
  const recipientPhone = body.phone ?? customerPhone ?? null;

  const wantEmail = body.method === "email" || body.method === "both";
  const wantSms = body.method === "sms" || body.method === "both";

  if (wantEmail && !recipientEmail) {
    res.status(400).json({
      success: false,
      data: null,
      spoken_confirmation: "I don't have an email address on file. Can you spell out an address to send it to?",
      error: { code: "NO_EMAIL", message: "No email on file for this customer; provide one in the 'email' field" },
    });
    return;
  }
  if (wantSms && !recipientPhone) {
    res.status(400).json({
      success: false,
      data: null,
      spoken_confirmation: "I don't have a phone number on file for a text. What number should I use?",
      error: { code: "NO_PHONE", message: "No phone on file for this customer; provide one in the 'phone' field" },
    });
    return;
  }

  const label = humanizeDocType(docType);

  let emailed = false;
  if (wantEmail && recipientEmail) {
    emailed = await sendDocumentEmail({
      to: recipientEmail,
      customerName,
      docType,
      pdfPath,
      note: body.note,
    });
  }

  let smsSent = false;
  // GATED (no-Twilio-texts ruling 2026-08-13). The email leg above is untouched and is the one
  // that actually carries the PDF — this SMS was only a "your document is ready" notification.
  if (wantSms && recipientPhone && !twilioSendEnabled("agentSends")) {
    logTwilioSendSkipped("agentSends", `${label} notification SMS to ${customerName} suppressed; the email leg is unaffected.`);
  } else if (wantSms && recipientPhone) {
    // MMS with public URL is not wired up — SMS acts as a notification only.
    const emailNote = emailed
      ? ` It's on the way to ${recipientEmail}.`
      : recipientEmail
        ? ` We'll send the PDF to ${recipientEmail} shortly.`
        : "";
    const noteLine = body.note ? `\n\n${body.note}` : "";
    const smsBody = `Hi ${customerName}, your ${label} from Red Cedar Electric is ready.${emailNote}${noteLine}\n\nReply STOP to opt out.`;
    const result = await sendSms(recipientPhone, smsBody);
    smsSent = !!result;
  }

  if (documentId && emailed) {
    await prisma.document.update({
      where: { id: documentId },
      data: { sentAt: new Date() },
    }).catch((err) => console.error("[documents/send] Failed to stamp sentAt:", err));
  }

  const anySent = emailed || smsSent;
  const spoken = anySent
    ? `Sent your ${label.toLowerCase()}${emailed && smsSent ? " by email and text" : emailed ? " to your email" : " by text"}.`
    : `I couldn't send that right now. I'll flag it for Kyle to handle personally.`;

  const status = anySent ? 200 : 502;
  const resp = anySent
    ? successResponse(
        {
          document_id: documentId,
          doc_type: docType,
          emailed,
          sms_sent: smsSent,
          recipient_email: emailed ? recipientEmail : null,
          recipient_phone: smsSent ? recipientPhone : null,
        },
        spoken,
      )
    : {
        success: false,
        data: null,
        spoken_confirmation: spoken,
        error: {
          code: "DELIVERY_FAILED",
          message: "Neither email nor SMS delivery succeeded — check GMAIL/Twilio credentials",
        },
      };

  await saveIdempotency(clientRequestId, endpoint, undefined, resp);
  logAgent("send_document", {
    endpoint,
    entityType: "Document",
    entityId: documentId ?? undefined,
    payload: { kind: body.kind, method: body.method, emailed, smsSent },
    responseStatus: status,
    durationMs: Date.now() - start,
    clientRequestId,
  });
  res.status(status).json(resp);
}));

// Zod error handler — must be after all routes
sharedAgentRouter.use(zodErrorMiddleware as express.ErrorRequestHandler);
