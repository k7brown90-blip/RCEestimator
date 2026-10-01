/**
 * The Google review ask (Kyle, 2026-09-02: "This is the google review request,
 * I need a review request to send out once I mark a job done.").
 *
 * Fires from THREE doors now:
 *   - the CRM's Mark-complete and the field's driveway close-out (automatic,
 *     fire-and-forget, gated);
 *   - a human pressing "Send review request" on its own, added 2026-10-01
 *     (plan 2026-10-01-manual-sends-archiving-and-one-calendar.md, item B) —
 *     `POST /jobs/:jobId/email-review-request` (app.ts) and
 *     `POST /health-record/visits/:visitId/email-review-request`
 *     (health-record.ts), `opts.manual: true`.
 *
 * Guards, in order:
 *   - the visit is a completed job with a customer email on file;
 *   - this job hasn't asked already (reviewRequestedAt);
 *   - this CUSTOMER hasn't been asked in the last 90 days on any job — a
 *     repeat customer gets one ask per season, not one per service call;
 *   - the automation gate (customerSendsEnabled "reviewRequests") — a
 *     suppressed send logs itself, per the never-silent rule.
 *
 * **`opts.manual` bypasses ONLY the last guard, the automation gate.** Same
 * precedent as `/issued-estimates/:id/payment-reminder` (app.ts): "a human
 * pressed it, so pacing does not apply." Kyle switched
 * `AUTOMATED_CUSTOMER_SENDS_REVIEW_REQUESTS` OFF on 2026-10-01 — "The review
 * request is no longer automated" — so until the manual button existed,
 * NOTHING reached a customer at all. The gate itself (automationGate.ts) is
 * UNCHANGED; this does not reach in and flip it, it just lets a human-pressed
 * call skip the `customerSendsEnabled` check the way the invoice-reminder
 * button already skips ITS gate on a manual press. Every other guard above —
 * job must be completed, no duplicate ask on this job, no repeat ask on this
 * customer within 90 days, customer must have an email on file — still
 * applies on the manual path exactly as it does on the automatic one.
 *
 * The automatic call sites remain fire-and-forget (`.catch(...)`, no await on
 * the result) — a review email must never fail a completion that is already
 * recorded. The manual routes DO await and surface the result, because a
 * human who pressed a button needs to know whether it went.
 */

import type { PrismaClient } from "@prisma/client";
import { sendBrandedEmail, escapeHtml } from "./confirmationEmail";
import { customerSendsEnabled, logCustomerSendSkipped } from "./automationGate";
import { logSystemEvent } from "./systemEvents";

/** Kyle's Google review link, given 2026-09-02. */
/*
  ONE COPY, IN shared/ (2026-10-01). The UI build put a second literal in
  `shared/reviewRequestUrl.ts` for the two frontends and left this one in place, because editing
  a reviewed service was outside that dispatch. Two hardcoded copies of a URL is how one of them
  goes stale the day Kyle changes his Google listing. `shared/` is this project's contract
  boundary and both frontends already read from it, so the server reads it too and there is now
  exactly one place to edit.
*/
export { GOOGLE_REVIEW_URL } from "../../shared/reviewRequestUrl";
import { GOOGLE_REVIEW_URL } from "../../shared/reviewRequestUrl";
const REPEAT_ASK_DAYS = 90;

export async function sendReviewRequestEmail(
  prisma: PrismaClient,
  visitId: string,
  opts: { manual?: boolean } = {},
): Promise<{ ok: true; to: string } | { ok: false; reason: string }> {
  const visit = await prisma.visit.findUnique({
    where: { id: visitId },
    include: {
      customer: { select: { id: true, name: true, email: true } },
      property: { select: { addressLine1: true, city: true } },
    },
  });
  if (!visit) return { ok: false, reason: "Visit not found." };
  if (visit.status !== "completed") {
    return { ok: false, reason: "This job is not marked complete yet." };
  }
  if (visit.reviewRequestedAt) {
    return { ok: false, reason: "A review request has already been sent for this job." };
  }
  if (!visit.customer.email) {
    logSystemEvent("info", "jobs", `Review request skipped — no email on ${visit.customer.name}'s account`, { visitId });
    return { ok: false, reason: `No email on file for ${visit.customer.name} — add one to the account first.` };
  }
  const recentAsk = await prisma.visit.findFirst({
    where: {
      customerId: visit.customer.id,
      reviewRequestedAt: { gte: new Date(Date.now() - REPEAT_ASK_DAYS * 24 * 3600 * 1000) },
    },
    select: { id: true },
  });
  if (recentAsk) {
    logSystemEvent("info", "jobs", `Review request skipped — ${visit.customer.name} was asked within ${REPEAT_ASK_DAYS} days`, { visitId });
    return { ok: false, reason: `${visit.customer.name} was already asked for a review within the last ${REPEAT_ASK_DAYS} days.` };
  }
  if (!opts.manual && !customerSendsEnabled("reviewRequests")) {
    logCustomerSendSkipped("reviewRequests", `visit ${visitId} (${visit.customer.name})`);
    return { ok: false, reason: "Review requests are not sending automatically right now." };
  }

  const firstName = visit.customer.name.trim().split(/\s+/)[0] || visit.customer.name;
  const sent = await sendBrandedEmail({
    kind: "review_request",
    visitId: visit.id,
    to: visit.customer.email,
    subject: `Thank you from Red Cedar Electric — how did we do?`,
    headline: "Thank you — your job is complete",
    bodyHtml: `
      <p style="font-size:15px;">Hi ${escapeHtml(firstName)},</p>
      <p style="font-size:15px;">Thank you for trusting Red Cedar Electric with the work at
      <strong>${escapeHtml(visit.property.addressLine1)}, ${escapeHtml(visit.property.city)}</strong>.
      The job is wrapped up, and it was a pleasure.</p>
      <p style="font-size:15px;">If you have a minute, a Google review helps a small local shop
      more than you'd believe — and it tells us what to keep doing right.</p>
      <p style="margin:24px 0;">
        <a href="${GOOGLE_REVIEW_URL}"
           style="background:#1a5c2e;color:#fff;text-decoration:none;padding:14px 28px;
                  border-radius:6px;font-size:16px;font-weight:600;display:inline-block;">
          Leave us a Google review
        </a>
      </p>
      <p style="font-size:13px;color:#666;">If anything about the work isn't right, reply to this
      email or call us first — we'll make it right.</p>
      <p style="font-size:14px;">Thank you,<br>Kyle Brown<br>Red Cedar Electric LLC</p>`,
  });
  if (!sent) return { ok: false, reason: "The email could not be sent — check the email connection." };
  await prisma.visit.update({ where: { id: visitId }, data: { reviewRequestedAt: new Date() } });
  logSystemEvent("info", "jobs", `Review request emailed to ${visit.customer.email} (${visit.customer.name})`, { visitId });
  return { ok: true, to: visit.customer.email };
}
