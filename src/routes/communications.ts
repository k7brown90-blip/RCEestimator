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
 * THE AI ADMIN'S SEND GOES OUT (Kyle 2026-11-24: "We are submitting direct requests to these agents which implies approval to all
 * that they are reqested to do in the CRM", which replaces the U4b rule that left it waiting for approval): when the session is the AI
 * admin, this same route sends the email through the ONE agent send (services/hubDrafts.ts createDraftMessage -> services/hubAgentSend.ts
 * sendAgentMessageNow -> hubSend's email branch - the very sendRecordMessage below), carrying exactly the To and CC the panel chose. The
 * message is recorded on the record's customer conversation as sent by "AI admin" with its audit row. Every guard still applies: Agent
 * access must be On, the address must not have unsubscribed. A guard that refuses answers 409 with the reason and the conversation shows the
 * message as not sent; nothing waits for approval. Kyle's session and every other office login send directly, as before. The structured
 * kinds on /customer-emails are not touched.
 */

import express from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/routeHelpers";
import { resolveRecordRecipients, sendRecordMessage, type RecordEmailTarget } from "../services/recordEmail";
import { ccSchema } from "../services/emailCc";
import { HubError, ensureThreadFor, readerFor } from "../services/hub";
import { createDraftMessage } from "../services/hubDrafts";
import { OFFICE_TEXT_CATEGORY, sendOfficeText } from "../services/hubOfficeText";
import { prisma } from "../lib/prisma";

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
    // The same refusals as a send (no record, no address), then the one agent send (recorded in the conversation as sent by the AI admin).
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
      const { message, sent, notSentReason } = await createDraftMessage(reader, {
        threadId: thread.id, channel: "email", category: "thread_reply",
        subject: parsed.subject, body: parsed.body, toAddress: recipients.to, cc: recipients.cc,
        visitId: target.kind === "job" ? target.visitId : null, issuedEstimateId: parsed.estimateId ?? null,
      });
      if (!sent) {
        res.status(409).json({ error: notSentReason ?? "The email was not sent.", sent: false, messageId: message.id });
        return;
      }
      res.json({ sent: true, drafted: false, messageId: message.id, to: recipients.to, cc: recipients.cc, suppressed: false });
    } catch (err) {
      if (err instanceof HubError) {
        res.status(err.status).json(err.status === 429 ? { error: err.message, sent: false } : { error: err.message });
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

const textBody = z.object({
  target: z.enum(TARGETS),
  id: z.string().trim().min(1),
  body: z.string().trim().min(1, "A text needs words.").max(1000),
  /** One id per composed text (the screen makes it once and reuses it on every retry), so a lost answer never sends the text twice. */
  clientMessageId: z.string().trim().min(8).max(100).optional(),
});

/**
 * POST /communications/text - { target, id, body, clientMessageId? }. The Conversation's "Text the customer" box (Kyle 2026-11-26): an office
 * person texts a lead or a customer by their phone on file, whether or not the lead came from the website form or became an account. Goes through
 * the ONE sender (services/hubSend.ts); STOP is the only reason it is refused. A text that does not go is still recorded in the conversation,
 * as "Not texted" with its reason, and answers 409 with that reason. The AI admin's session sends the same text through the one agent send.
 */
communicationsRouter.post("/communications/text", asyncHandler(async (req, res) => {
  const parsed = textBody.parse(req.body ?? {});
  const reader = readerFor(req);
  if (!reader) {
    res.status(403).json({ error: "Sign in to send a text." });
    return;
  }
  try {
    // The text is filed in the customer's conversation (a lead's own before it is an account). A job's text goes to the job's customer, tagged with the job.
    let thread;
    if (parsed.target === "job") {
      const visit = await prisma.visit.findUnique({ where: { id: parsed.id }, select: { customerId: true } });
      if (!visit) throw new HubError("Job not found", 404);
      thread = await ensureThreadFor({ customerId: visit.customerId });
    } else {
      thread = await ensureThreadFor(parsed.target === "lead" ? { leadId: parsed.id } : { customerId: parsed.id });
    }
    const visitId = parsed.target === "job" ? parsed.id : null;
    const clientMessageId = parsed.clientMessageId ?? null;
    let out: { message: { id: string }; sent: boolean; notSentReason: string | null };
    if (reader.kind === "ai-admin") {
      out = await createDraftMessage(reader, { threadId: thread.id, channel: "sms", category: OFFICE_TEXT_CATEGORY, body: parsed.body, visitId, clientMessageId });
    } else {
      out = await sendOfficeText(reader, { threadId: thread.id, body: parsed.body, visitId, clientMessageId });
    }
    if (!out.sent) {
      res.status(409).json({ error: out.notSentReason ?? "The text was not sent.", sent: false, messageId: out.message.id });
      return;
    }
    res.json({ sent: true, messageId: out.message.id });
  } catch (err) {
    if (err instanceof HubError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    throw err;
  }
}));
