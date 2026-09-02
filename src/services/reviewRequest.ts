/**
 * The Google review ask (Kyle, 2026-09-02: "This is the google review request,
 * I need a review request to send out once I mark a job done.").
 *
 * Fires from BOTH completion doors — the CRM's Mark-complete and the field's
 * driveway close-out — and never from anywhere else. Guards, in order:
 *   - the visit is a completed job with a customer email on file;
 *   - this job hasn't asked already (reviewRequestedAt);
 *   - this CUSTOMER hasn't been asked in the last 90 days on any job — a
 *     repeat customer gets one ask per season, not one per service call;
 *   - the automation gate (customerSendsEnabled "reviewRequests") — a
 *     suppressed send logs itself, per the never-silent rule.
 *
 * Fire-and-forget at the call sites: a review email must never fail a
 * completion that is already recorded.
 */

import type { PrismaClient } from "@prisma/client";
import { sendBrandedEmail, escapeHtml } from "./confirmationEmail";
import { customerSendsEnabled, logCustomerSendSkipped } from "./automationGate";
import { logSystemEvent } from "./systemEvents";

/** Kyle's Google review link, given 2026-09-02. */
export const GOOGLE_REVIEW_URL = "https://g.page/r/CdXY7dazs17QEBM/review";
const REPEAT_ASK_DAYS = 90;

export async function sendReviewRequestEmail(prisma: PrismaClient, visitId: string): Promise<void> {
  const visit = await prisma.visit.findUnique({
    where: { id: visitId },
    include: {
      customer: { select: { id: true, name: true, email: true } },
      property: { select: { addressLine1: true, city: true } },
    },
  });
  if (!visit || visit.status !== "completed") return;
  if (visit.reviewRequestedAt) return;
  if (!visit.customer.email) {
    logSystemEvent("info", "jobs", `Review request skipped — no email on ${visit.customer.name}'s account`, { visitId });
    return;
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
    return;
  }
  if (!customerSendsEnabled("reviewRequests")) {
    logCustomerSendSkipped("reviewRequests", `visit ${visitId} (${visit.customer.name})`);
    return;
  }

  const firstName = visit.customer.name.trim().split(/\s+/)[0] || visit.customer.name;
  const sent = await sendBrandedEmail({
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
  if (sent) {
    await prisma.visit.update({ where: { id: visitId }, data: { reviewRequestedAt: new Date() } });
    logSystemEvent("info", "jobs", `Review request emailed to ${visit.customer.email} (${visit.customer.name})`, { visitId });
  }
}
