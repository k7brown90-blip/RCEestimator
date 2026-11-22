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
import { asyncHandler } from "../lib/routeHelpers";
import { sendRecordMessage, type RecordEmailTarget } from "../services/recordEmail";
import { ccSchema } from "../services/emailCc";

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

/** POST /communications/email — { target, id, to?, subject, body }. The send itself is services/recordEmail.ts sendRecordMessage, which the Messages hub's approved drafts use too. */
communicationsRouter.post("/communications/email", asyncHandler(async (req, res) => {
  const parsed = sendBody.parse(req.body ?? {});
  const target: RecordEmailTarget = parsed.target === "lead" ? { kind: "lead", leadId: parsed.id }
    : parsed.target === "account" ? { kind: "account", customerId: parsed.id }
      : { kind: "job", visitId: parsed.id };

  const result = await sendRecordMessage({
    target, to: parsed.to?.trim() || null, cc: parsed.cc, subject: parsed.subject, body: parsed.body, estimateId: parsed.estimateId ?? null,
  });
  if (!result.ok) {
    // The same three answers as before the send was lifted into the service: 404 / 400 carry only the reason, a failed send also says whether the address was suppressed.
    res.status(result.status).json(result.status === 502 ? { error: result.error, suppressed: result.suppressed } : { error: result.error });
    return;
  }
  res.json({ sent: true, to: result.to, cc: result.cc, suppressed: result.suppressed });
}));
