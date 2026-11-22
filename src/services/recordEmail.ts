/**
 * Free-form follow-up email — the single-recipient send Kyle asked for (2026-09-20,
 * .claude/plans/2026-09-20-drawers-and-tab-purpose.md, Phase 4 "communications"):
 *
 *   "Campaigns can fold into the lead section and we can create a communications ability
 *    since we already have customer emails. Follow ups can be done by sending an email
 *    straight from the CRM."
 *
 * This is NEW server surface, not a move — every existing send is transactional and
 * estimate-bound (sendProposalEmail, emailDepositRequest, emailBalanceRequest,
 * emailHealthReport) and `campaignTestSend` is hardcoded to the company's own address.
 * There was no door for "type a subject and a body, send it to this one person."
 *
 * REUSE, NOT A SECOND MAIL PATH: this goes through the exact same `sendBrandedEmail` ->
 * `sendCustomerEmail` pipe as every other customer email (services/confirmationEmail.ts,
 * services/transactionalEmail.ts) — Resend first, Gmail fallback, one EmailDelivery row
 * per send, bounces filed the same way. `kind: "communication"` and the new
 * leadId/customerId columns (prisma/migrations/20260920220000_communications_thread_the_record)
 * are the only additions, so the lead/account/job drawer can each read back its own thread
 * from the SAME table the bounce badges already watch — a send here cannot go invisible to
 * them the way a hand-rolled fetch() would.
 *
 * ── DECISION: the automation gate does NOT apply ───────────────────────────────────────────
 *
 * services/automationGate.ts gates AUTOMATED customer sends — the 8 AM reminder cron, booking
 * confirmations, the web-lead auto-reply, inbound auto-replies: things that fire without a
 * human deciding, on a clock or a webhook. This send only ever happens because an operator is
 * looking at one record and presses Send — the exact shape `services/issuedEstimateSend.ts`
 * already carved out for `sendEstimateEmail` ("Kyle tapped Send, on one estimate he is looking
 * at" is not automation; it is the operator using the tool). The safety property is the same
 * one that file relies on: the only caller is a PIN-authenticated route handler
 * (routes/communications.ts), nothing scheduled or webhook-driven reaches this function.
 *
 * ── DECISION: an unsubscribed address is NOT refused ───────────────────────────────────────
 *
 * `EmailSuppression` (the unsubscribe list) already gates exactly one thing in this codebase:
 * being ADDED to a marketing list (`POST /leads/:leadId/add-to-campaign`, the account
 * auto-enrol at convert) — see services/emailCampaigns.ts `isSuppressed`. It has never gated a
 * transactional send: sendProposalEmail, the deposit/balance reminders, and every appointment
 * email go out to whatever address is on file regardless of suppression status, because CAN-SPAM's
 * unsubscribe requirement is a MARKETING-list rule and these are relationship mail about a
 * specific quote or job. A one-to-one follow-up composed by a human about one customer's own
 * work is the same category, not a campaign send — so it PROCEEDS. What it does NOT do is
 * pretend the suppression doesn't exist: the caller gets back `suppressed: true` on the
 * response so the CRM can show a quiet note ("this address unsubscribed from marketing — this
 * is not a campaign send") without blocking the human's decision. Refusing outright would let a
 * customer who unsubscribed from the newsletter also cut off a reply about their own signed
 * estimate, which is not what "unsubscribe" means to them or to CAN-SPAM.
 */

import { prisma } from "../lib/prisma";
import { sendBrandedEmail, escapeHtml } from "./confirmationEmail";
import { isSuppressed } from "./emailCampaigns";
import { resolveRecipients } from "./emailCc";

export type RecordEmailTarget =
  | { kind: "lead"; leadId: string }
  | { kind: "account"; customerId: string }
  | { kind: "job"; visitId: string };

export interface SendRecordEmailInput {
  to: string;
  /** Already cleaned by cleanCc (routes/communications.ts). */
  cc?: string[];
  subject: string;
  body: string;
  target: RecordEmailTarget;
  /** The estimate / invoice the message is about, so its drawer's thread shows it (2026-10-27). */
  issuedEstimateId?: string | null;
}

export interface SendRecordEmailResult {
  ok: boolean;
  suppressed: boolean;
  /** The EmailDelivery row this send wrote (also on a failure), or null when it could not be written. */
  deliveryId: string | null;
  /** The transport's reason when the send failed. */
  error: string | null;
}

/** Plain typed text -> the same branded shell every other customer email uses, newlines kept. */
function bodyHtmlFrom(body: string): string {
  return `<p style="white-space:pre-wrap;margin:0;font-size:15px;line-height:1.6;">${escapeHtml(body)}</p>`;
}

export async function sendRecordEmail(input: SendRecordEmailInput): Promise<SendRecordEmailResult> {
  const to = input.to.trim();
  const suppressed = await isSuppressed(prisma, to);

  const outcome: { deliveryId?: string | null; error?: string | null } = {};
  const ok = await sendBrandedEmail({
    to,
    ...(input.cc && input.cc.length > 0 ? { cc: input.cc } : {}),
    subject: input.subject,
    headline: input.subject,
    bodyHtml: bodyHtmlFrom(input.body),
    kind: "communication",
    issuedEstimateId: input.issuedEstimateId ?? null,
    leadId: input.target.kind === "lead" ? input.target.leadId : null,
    customerId: input.target.kind === "account" ? input.target.customerId : null,
    visitId: input.target.kind === "job" ? input.target.visitId : null,
    outcome,
  });

  return { ok, suppressed, deliveryId: outcome.deliveryId ?? null, error: outcome.error ?? null };
}

export interface SendRecordMessageInput {
  target: RecordEmailTarget;
  /** The address to send to; null or absent uses the record's own primary email. */
  to?: string | null;
  /** Already cleaned by cleanCc / ccSchema. */
  cc?: string[];
  subject: string;
  body: string;
  /** The estimate / invoice the message is about, so its drawer's thread shows it. */
  estimateId?: string | null;
}

export type SendRecordMessageResult =
  | { ok: true; to: string; cc: string[]; suppressed: boolean; deliveryId: string | null }
  | { ok: false; status: 400 | 404 | 502; error: string; suppressed: boolean; deliveryId: string | null };

/**
 * The whole "email one person from a record" send (lifted out of POST /communications/email, work order
 * agent-team U4): look the record up, take its primary address when none was chosen, pass THE one
 * recipient rule, send. The route and the Messages hub's send function (services/hubSend.ts) both call
 * this, so an approved draft goes out exactly the way "Email the customer" does: same pipe, one
 * EmailDelivery row, same CC rule.
 */
export async function sendRecordMessage(input: SendRecordMessageInput): Promise<SendRecordMessageResult> {
  const refuse = (status: 400 | 404, error: string): SendRecordMessageResult => ({ ok: false, status, error, suppressed: false, deliveryId: null });
  let onFile: string | null;
  if (input.target.kind === "lead") {
    const lead = await prisma.lead.findUnique({ where: { id: input.target.leadId }, select: { email: true } });
    if (!lead) return refuse(404, "Lead not found.");
    onFile = lead.email;
  } else if (input.target.kind === "account") {
    const customer = await prisma.customer.findUnique({ where: { id: input.target.customerId }, select: { email: true } });
    if (!customer) return refuse(404, "Account not found.");
    onFile = customer.email;
  } else {
    const visit = await prisma.visit.findUnique({ where: { id: input.target.visitId }, select: { customer: { select: { email: true } } } });
    if (!visit) return refuse(404, "Job not found.");
    onFile = visit.customer.email;
  }

  // THE ONE RECIPIENT RULE (emailCc.resolveRecipients) - the same check every customer send passes.
  const recipients = resolveRecipients(
    { toOverride: input.to?.trim() || null, onFile, cc: input.cc },
    "No email address on file for this record — add one, or type an address to send to.",
  );
  if (!recipients.ok) return refuse(400, recipients.reason);

  const result = await sendRecordEmail({
    to: recipients.to, cc: recipients.cc, subject: input.subject, body: input.body,
    target: input.target, issuedEstimateId: input.estimateId ?? null,
  });
  if (!result.ok) {
    return {
      ok: false, status: 502, suppressed: result.suppressed, deliveryId: result.deliveryId,
      error: "The email could not be sent — see the delivery log (email-deliveries) for the reason.",
    };
  }
  return { ok: true, to: recipients.to, cc: recipients.cc, suppressed: result.suppressed, deliveryId: result.deliveryId };
}
