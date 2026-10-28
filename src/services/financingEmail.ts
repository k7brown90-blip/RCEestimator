/**
 * The Synchrony financing invitation, on its own (Kyle, 2026-10-01):
 * "I also need to have the financing link available to email on its own along
 * with a google review request to email on its own." … "These links should be
 * available along side the invoice email button." … "These should be a manual
 * send both from the field app and from the CRM."
 *
 * SENDABLE BEFORE SIGNING (Kyle, 2026-10-08, one-estimating-system plan Phase 4): the buttons are
 * on the field Quote screen's issued panel, Estimate Intake's after-issue panel and the Estimate
 * drawer as well as the payment panel. Refused for a void, lost or superseded estimate.
 *
 * KEYED TO AN ISSUED ESTIMATE, not a visit — matching the plan's own reasoning
 * (2026-10-01-manual-sends-archiving-and-one-calendar.md, item B): the CRM
 * button lives beside the invoice/deposit/balance sends on PaymentPanel, which
 * is estimate-scoped, and a field technician who wants to send it is standing
 * on a job that already has an estimate id in hand. This is the same shape as
 * `sendDepositRequestEmail` / `sendBalanceRequestEmail` in paymentReceipts.ts
 * — load the record, refuse cleanly with a reason, send, log it — kept in its
 * own file rather than folded into paymentReceipts.ts because this is not a
 * receipt or a bill, just an invitation to apply elsewhere.
 *
 * NOT GATED BY automationGate.ts. Every caller is a human pressing a button
 * behind an auth gate (the CRM's PIN session or the technician's bearer
 * token) — never a cron, webhook, or retry — the same property that lets
 * `sendEstimateEmail` skip the gate (see issuedEstimateSend.ts's header
 * comment). There is also no "unattended" version of this send to gate: it
 * was never on the automatic job-completion or signature paths before today
 * and still is not.
 *
 * NO CREDIT TERMS IN THE COPY. Load-bearing, not a style choice: the
 * 2026-09-16 financing-link plan deliberately kept Reg Z (TILA) disclosure
 * out of scope by never stating financing terms anywhere Red Cedar's own
 * mail goes. This email invites the customer to Synchrony's own application
 * page and says nothing about rate, term length, minimum payment, a 0%-promo
 * period, or approval odds — Synchrony's page carries the required disclosure
 * once the customer is on THEIR site. `tests/financingEmail.test.ts` asserts
 * the rendered body contains none of those words, so a future edit that adds
 * one fails loudly instead of shipping quietly.
 */

import type { PrismaClient } from "@prisma/client";
import { sendBrandedEmail, escapeHtml } from "./confirmationEmail";
import { getCompanyProfile } from "./companyProfile";
import { logSystemEvent } from "./systemEvents";
import { resolveRecipients } from "./emailCc";

/**
 * ONE EMAIL TOOL (Kyle, 2026-10-27): the "Email the customer" panel (POST /customer-emails) passes
 * its To, CC and note, and they go through the one recipient rule (emailCc.resolveRecipients).
 * Nothing given = the customer on file, exactly as the field's button and the old buttons did.
 */
export async function sendFinancingEmail(
  prisma: PrismaClient,
  estimateId: string,
  opts: { toOverride?: string | null; cc?: string[]; message?: string | null } = {},
): Promise<{ ok: true; to: string; cc: string[] } | { ok: false; reason: string }> {
  const est = await prisma.issuedEstimate.findUnique({
    where: { id: estimateId },
    select: {
      number: true, title: true, customerName: true, customerEmail: true, status: true,
      supersededBy: { select: { id: true } },
    },
  });
  if (!est) return { ok: false, reason: "Estimate not found." };
  // BEFORE SIGNING IS ALLOWED (Kyle, 2026-10-08: "the financing link should be able to be sent
  // before signing"), and so is after - a signed estimate's payment panel sends it too. What is
  // refused is an estimate that is not a live offer, with the reason the screen shows. Same
  // wording as the estimate email's own refusals (issuedEstimateSend.ts); they are decided HERE,
  // in the service, so the CRM button, the drawer and the phone cannot disagree. Not refused:
  // archived (put away, still the customer's offer) and expired (the link only invites them to apply).
  if (est.supersededBy) {
    return { ok: false, reason: "This estimate has been superseded by a newer revision. Send that one instead." };
  }
  if (est.status === "void") return { ok: false, reason: "This estimate is void." };
  if (est.status === "lost") {
    return { ok: false, reason: "This estimate is marked lost. Reopen it first, then send the financing link." };
  }
  const recipients = resolveRecipients(
    { toOverride: opts.toOverride, onFile: est.customerEmail, cc: opts.cc },
    "No customer email on file — add one to the account first, or type an address when sending.",
  );
  if (!recipients.ok) return { ok: false, reason: recipients.reason };
  const { to, cc } = recipients;

  // financingUrl is Settings-editable and https-only validated at the source
  // (companyProfile.ts:73-76) — read through here, never hardcoded.
  const { financingUrl } = await getCompanyProfile();
  const firstName = est.customerName.trim().split(/\s+/)[0] || est.customerName;

  const sent = await sendBrandedEmail({
    kind: "financing",
    issuedEstimateId: estimateId,
    estimateNumber: est.number,
    to,
    ...(cc.length > 0 ? { cc } : {}),
    subject: `Financing available for ${est.title}`,
    headline: "Flexible financing, if you'd like it",
    bodyHtml: `
      <p style="font-size:15px;">Hi ${escapeHtml(firstName)},</p>
      <p style="font-size:15px;">If you'd like to look at financing options for
      <strong>${escapeHtml(est.title)}</strong>, Red Cedar Electric works with Synchrony.
      You're welcome to apply directly through their secure application — it only
      takes a few minutes, and there's no obligation.</p>
      ${(opts.message ?? "").trim() ? `<p style="font-size:15px;">${escapeHtml((opts.message ?? "").trim())}</p>` : ""}
      <p style="margin:24px 0;">
        <a href="${escapeHtml(financingUrl)}"
           style="background:#1a5c2e;color:#fff;text-decoration:none;padding:14px 28px;
                  border-radius:6px;font-size:16px;font-weight:600;display:inline-block;">
          Apply for financing
        </a>
      </p>
      <p style="font-size:13px;color:#666;">Synchrony will walk you through the details of
      any offer directly on their own site.</p>
      <p style="font-size:14px;">Thank you,<br>Kyle Brown<br>Red Cedar Electric LLC</p>`,
  });
  if (!sent) return { ok: false, reason: "The email could not be sent — check the email connection." };
  logSystemEvent("info", "stripe", `Financing link emailed to ${to} on ${est.number}`, {
    estimateId,
  });
  return { ok: true, to, cc };
}
