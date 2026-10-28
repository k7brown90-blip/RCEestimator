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
import { ccSchema, resolveRecipients } from "../services/emailCc";

export const communicationsRouter = express.Router();

const TARGETS = ["lead", "account", "job"] as const;

const sendBody = z.object({
  target: z.enum(TARGETS),
  id: z.string().trim().min(1),
  to: z.string().trim().email().nullable().optional(),
  // CC (Kyle, 2026-10-24: "The email will be the same as doing a CC email.")
  cc: ccSchema,
  subject: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(10000),
  /**
   * The estimate / invoice this message is about (Kyle, 2026-10-27): the "Email the customer" panel
   * on an invoice or estimate drawer files its Message kind against the estimate too, so the thread
   * under the panel shows everything sent from that record - invoice, financing link AND message.
   */
  estimateId: z.string().trim().min(1).optional(),
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

  // THE ONE RECIPIENT RULE (emailCc.resolveRecipients) - the same check every customer send passes.
  const recipients = resolveRecipients(
    { toOverride: to, cc: parsed.cc },
    "No email address on file for this record — add one, or type an address to send to.",
  );
  if (!recipients.ok) { res.status(400).json({ error: recipients.reason }); return; }
  to = recipients.to;
  const cc = recipients.cc;

  const result = await sendRecordEmail({ to, cc, subject: parsed.subject, body: parsed.body, target, issuedEstimateId: parsed.estimateId ?? null });
  if (!result.ok) {
    res.status(502).json({ error: "The email could not be sent — see the delivery log (email-deliveries) for the reason.", suppressed: result.suppressed });
    return;
  }
  res.json({ sent: true, to, cc, suppressed: result.suppressed });
}));
