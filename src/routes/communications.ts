/**
 * The single send endpoint for a free-form follow-up email (2026-09-20 communications build,
 * see services/recordEmail.ts for the reuse, automation-gate and unsubscribe reasoning).
 *
 * One record type at a time — lead, account (Customer), or job (Visit) — because those are the
 * three drawers this build put the "Send email" action on. `to` is optional: when omitted the
 * record's own primary email is used (SendToPicker's "Primary" option sends `null` the same way
 * it already does for the estimate/invoice resend pickers).
 *
 * Mounted behind the operator PIN session like every other CRM route (app.use(pinAuthMiddleware)
 * in app.ts runs before any router is registered) — nothing here is a webhook or agent surface.
 */

import express from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { asyncHandler } from "./agent-helpers";
import { sendRecordEmail, type RecordEmailTarget } from "../services/recordEmail";

export const communicationsRouter = express.Router();

const TARGETS = ["lead", "account", "job"] as const;

const sendBody = z.object({
  target: z.enum(TARGETS),
  id: z.string().trim().min(1),
  to: z.string().trim().email().nullable().optional(),
  subject: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(10000),
});

/** POST /communications/email — { target, id, to?, subject, body }. */
communicationsRouter.post("/communications/email", asyncHandler(async (req, res) => {
  const parsed = sendBody.parse(req.body ?? {});
  let to = parsed.to?.trim() || null;
  let target: RecordEmailTarget;

  if (parsed.target === "lead") {
    const lead = await prisma.lead.findUnique({ where: { id: parsed.id }, select: { id: true, email: true } });
    if (!lead) { res.status(404).json({ error: "Lead not found." }); return; }
    to = to ?? lead.email;
    target = { kind: "lead", leadId: lead.id };
  } else if (parsed.target === "account") {
    const customer = await prisma.customer.findUnique({ where: { id: parsed.id }, select: { id: true, email: true } });
    if (!customer) { res.status(404).json({ error: "Account not found." }); return; }
    to = to ?? customer.email;
    target = { kind: "account", customerId: customer.id };
  } else {
    const visit = await prisma.visit.findUnique({
      where: { id: parsed.id },
      select: { id: true, customer: { select: { email: true } } },
    });
    if (!visit) { res.status(404).json({ error: "Job not found." }); return; }
    to = to ?? visit.customer.email;
    target = { kind: "job", visitId: visit.id };
  }

  if (!to) {
    res.status(400).json({ error: "No email address on file for this record — add one, or type an address to send to." });
    return;
  }

  const result = await sendRecordEmail({ to, subject: parsed.subject, body: parsed.body, target });
  if (!result.ok) {
    res.status(502).json({ error: "The email could not be sent — see the delivery log (email-deliveries) for the reason.", suppressed: result.suppressed });
    return;
  }
  res.json({ sent: true, to, suppressed: result.suppressed });
}));
