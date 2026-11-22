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
 *
 * THE AI ADMIN'S SEND IS A DRAFT (work order agent-team, U4b, default D2): when the session is the AI admin, this
 * same route does not send. It leaves the email as a message waiting for approval on the record's customer
 * conversation (services/hubDrafts.ts createDraftMessage, the ONE draft door), carrying exactly the To and CC the
 * panel chose; Kyle (or a login holding approve_drafts) sends it from Messages -> Needs approval, and the send is
 * hubSend's email branch - the very sendRecordMessage below. Kyle's session and every other office login send
 * directly, as before. The structured kinds on /customer-emails are not touched.
 */

import express from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/routeHelpers";
import { resolveRecordRecipients, sendRecordMessage, type RecordEmailTarget } from "../services/recordEmail";
import { ccSchema } from "../services/emailCc";
import { HubError, ensureThreadFor, readerFor } from "../services/hub";
import { createDraftMessage } from "../services/hubDrafts";

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

  const reader = readerFor(req);
  if (reader?.kind === "ai-admin") {
    // The same refusals as a send (no record, no address), then a draft instead of a send.
    const recipients = await resolveRecordRecipients(target, parsed.to?.trim() || null, parsed.cc);
    if (!recipients.ok) {
      res.status(recipients.status).json({ error: recipients.error });
      return;
    }
    try {
      const thread = await ensureThreadFor(
        target.kind === "lead" ? { leadId: target.leadId }
          : target.kind === "account" ? { customerId: target.customerId }
            : { customerId: recipients.customerId as string },
      );
      const { message } = await createDraftMessage(reader, {
        threadId: thread.id, channel: "email", category: "thread_reply",
        subject: parsed.subject, body: parsed.body, toAddress: recipients.to, cc: recipients.cc,
        visitId: target.kind === "job" ? target.visitId : null, issuedEstimateId: parsed.estimateId ?? null,
      });
      res.json({ sent: false, drafted: true, messageId: message.id, to: recipients.to, cc: recipients.cc, suppressed: false });
    } catch (err) {
      if (err instanceof HubError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      throw err;
    }
    return;
  }

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
