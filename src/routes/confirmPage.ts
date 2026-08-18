/**
 * Public appointment confirmation page — /confirm/:token
 *
 * Linked from confirmation emails and SMS. No auth: the unguessable token is
 * the credential (same pattern as the /sign/:documentId e-signature page).
 * Email links carry ?action=confirm|reschedule|cancel and apply immediately;
 * bare visits render buttons that POST back to this route.
 */

import express from "express";
import { prisma } from "../lib/prisma";
import { asyncHandler, readParam } from "./agent-helpers";
import { applyConfirmationAction, type ConfirmationAction } from "../services/visitConfirmations";

export const confirmPageRouter = express.Router();

const TZ = "America/Chicago";
const BUSINESS_PHONE = "615-625-2163";

function page(title: string, inner: string): string {
  return `<!DOCTYPE html>
<html><head><title>${title} — Red Cedar Electric</title><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:40px auto;padding:0 20px;color:#333;">
  <div style="background:#1a5c2e;color:#fff;padding:16px 24px;border-radius:8px 8px 0 0;">
    <h1 style="margin:0;font-size:20px;">Red Cedar Electric LLC</h1>
    <p style="margin:4px 0 0;font-size:14px;opacity:0.9;">Appointment Confirmation</p>
  </div>
  <div style="padding:20px 24px;background:#fff;border:1px solid #e0e0e0;border-top:none;border-radius:0 0 8px 8px;">
    ${inner}
    <p style="font-size:13px;color:#888;margin:24px 0 0;border-top:1px solid #eee;padding-top:12px;">
      Questions? Call us at ${BUSINESS_PHONE} &middot; Licensed &amp; Insured &middot; Serving Middle Tennessee
    </p>
  </div>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const VALID_ACTIONS: ConfirmationAction[] = ["confirm", "reschedule", "cancel"];

async function loadVisitByToken(token: string) {
  if (!token || token.length < 8) return null;
  return prisma.visit.findUnique({
    where: { confirmationToken: token },
    include: { customer: { select: { name: true } }, property: true },
  });
}

function describeVisit(visit: NonNullable<Awaited<ReturnType<typeof loadVisitByToken>>>): string {
  const when = visit.scheduledStart
    ? `${visit.scheduledStart.toLocaleDateString("en-US", { timeZone: TZ, weekday: "long", month: "long", day: "numeric" })} at ${visit.scheduledStart.toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" })}`
    : "Not yet scheduled";
  const address = [visit.property.addressLine1, visit.property.city, visit.property.state].filter(Boolean).join(", ");
  return `
    <div style="background:#f0f7f1;padding:16px;border-radius:6px;margin:0 0 16px;">
      <p style="margin:0 0 6px;font-size:15px;"><strong>When:</strong> ${when}</p>
      <p style="margin:0 0 6px;font-size:15px;"><strong>Address:</strong> ${escapeHtml(address)}</p>
      ${visit.jobType ? `<p style="margin:0 0 6px;font-size:15px;"><strong>Service:</strong> ${escapeHtml(visit.jobType)}</p>` : ""}
    </div>`;
}

function resultHtml(action: ConfirmationAction, customerName: string): string {
  const first = escapeHtml(customerName.split(/\s+/)[0] || customerName);
  const messages: Record<ConfirmationAction, string> = {
    confirm: `<h2 style="color:#1a5c2e;margin:0 0 12px;">You're confirmed!</h2><p style="font-size:15px;">Thanks, ${first}. We'll see you at your scheduled time. You'll get a reminder the day before.</p>`,
    reschedule: `<h2 style="color:#1a5c2e;margin:0 0 12px;">Reschedule requested</h2><p style="font-size:15px;">Thanks, ${first}. A member of our team will call you shortly to arrange a new time.</p>`,
    cancel: `<h2 style="color:#a33;margin:0 0 12px;">Cancellation requested</h2><p style="font-size:15px;">Understood, ${first}. We've flagged your request and will follow up to confirm the cancellation.</p>`,
  };
  return messages[action];
}

async function handleAction(token: string, action: ConfirmationAction, res: express.Response): Promise<void> {
  const visit = await loadVisitByToken(token);
  if (!visit) {
    res.status(404).send(page("Not Found", `<h2 style="margin:0 0 12px;">Link not found</h2><p style="font-size:15px;">This confirmation link is invalid or has expired. Please call us at ${BUSINESS_PHONE}.</p>`));
    return;
  }
  const outcome = await applyConfirmationAction(visit.id, action, "email_link");
  res.send(page("Thank You", resultHtml(action, outcome.customerName)));
}

confirmPageRouter.get("/confirm/:token", asyncHandler(async (req, res) => {
  const token = readParam(req, "token");
  const action = String(req.query.action ?? "");

  if (VALID_ACTIONS.includes(action as ConfirmationAction)) {
    await handleAction(token, action as ConfirmationAction, res);
    return;
  }

  const visit = await loadVisitByToken(token);
  if (!visit) {
    res.status(404).send(page("Not Found", `<h2 style="margin:0 0 12px;">Link not found</h2><p style="font-size:15px;">This confirmation link is invalid or has expired. Please call us at ${BUSINESS_PHONE}.</p>`));
    return;
  }

  if (visit.confirmationStatus === "confirmed") {
    res.send(page("Confirmed", `${resultHtml("confirm", visit.customer.name)}${describeVisit(visit)}<p style="font-size:13px;color:#777;">Need to make a change after all? Use the buttons below.</p>${actionButtons(token)}`));
    return;
  }

  res.send(page("Confirm Appointment", `
    <p style="font-size:16px;margin:0 0 16px;">Hi ${escapeHtml(visit.customer.name.split(/\s+/)[0] || visit.customer.name)}, please confirm your appointment:</p>
    ${describeVisit(visit)}
    ${actionButtons(token)}`));
}));

function actionButtons(token: string): string {
  const btn = (action: string, label: string, bg: string) => `
    <form method="POST" action="/api/confirm/${token}" style="display:inline-block;margin:0 6px 8px 0;">
      <input type="hidden" name="action" value="${action}">
      <button type="submit" style="background:${bg};color:#fff;border:none;padding:12px 22px;border-radius:6px;font-size:15px;font-weight:600;cursor:pointer;">${label}</button>
    </form>`;
  return `<div style="text-align:center;margin:0 0 8px;">
    ${btn("confirm", "Confirm Appointment", "#1a5c2e")}
    ${btn("reschedule", "Request Reschedule", "#8a6d1a")}
    ${btn("cancel", "Cancel", "#a33")}
  </div>`;
}

confirmPageRouter.post("/confirm/:token", asyncHandler(async (req, res) => {
  const token = readParam(req, "token");
  const action = String((req.body as Record<string, unknown>)?.action ?? "");
  if (!VALID_ACTIONS.includes(action as ConfirmationAction)) {
    res.status(400).send(page("Invalid", `<h2 style="margin:0 0 12px;">Invalid request</h2><p style="font-size:15px;">Please use the buttons on the confirmation page, or call us at ${BUSINESS_PHONE}.</p>`));
    return;
  }
  await handleAction(token, action as ConfirmationAction, res);
}));
