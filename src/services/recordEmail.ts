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

export type RecordEmailTarget =
  | { kind: "lead"; leadId: string }
  | { kind: "account"; customerId: string }
  | { kind: "job"; visitId: string };

export interface SendRecordEmailInput {
  to: string;
  subject: string;
  body: string;
  target: RecordEmailTarget;
}

export interface SendRecordEmailResult {
  ok: boolean;
  suppressed: boolean;
}

/** Plain typed text -> the same branded shell every other customer email uses, newlines kept. */
function bodyHtmlFrom(body: string): string {
  return `<p style="white-space:pre-wrap;margin:0;font-size:15px;line-height:1.6;">${escapeHtml(body)}</p>`;
}

export async function sendRecordEmail(input: SendRecordEmailInput): Promise<SendRecordEmailResult> {
  const to = input.to.trim();
  const suppressed = await isSuppressed(prisma, to);

  const ok = await sendBrandedEmail({
    to,
    subject: input.subject,
    headline: input.subject,
    bodyHtml: bodyHtmlFrom(input.body),
    kind: "communication",
    leadId: input.target.kind === "lead" ? input.target.leadId : null,
    customerId: input.target.kind === "account" ? input.target.customerId : null,
    visitId: input.target.kind === "job" ? input.target.visitId : null,
  });

  return { ok, suppressed };
}
