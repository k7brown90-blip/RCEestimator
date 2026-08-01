/**
 * Visit confirmation & notification service — the customer/tech communication
 * mesh built on top of the existing Gmail (nodemailer) + Twilio helpers.
 *
 * Responsibilities:
 * - Dual-channel (email + SMS) appointment confirmation requests with a
 *   public /confirm/:token page and SMS keyword replies (YES/NO/RESCHEDULE)
 * - 24-hour-before reminders (fired by the morning cron sweep)
 * - Technician job notifications (assigned / changed / cancelled)
 *
 * Everything degrades gracefully: missing email/phone or unconfigured
 * providers log a warning and skip — they never fail the calling operation.
 */

import crypto from "node:crypto";
import { prisma } from "../lib/prisma";
import { sendSms, KYLE_PHONE } from "./twilio";
import { sendBrandedEmail, escapeHtml } from "./confirmationEmail";

const TZ = "America/Chicago";
const BUSINESS_PHONE = "(731) 462-0443";

function publicBaseUrl(): string {
  // Customer-facing links (SMS + email confirm/manage URLs) prefer the branded
  // domain: carriers score links on a brand's own domain better than shared
  // infrastructure domains like *.up.railway.app, and some filter the latter.
  // PUBLIC_BASE_URL (e.g. "https://go.redcedarelectricllc.com") is a CNAME to
  // the same Railway service, so every route works identically through it.
  const branded = process.env.PUBLIC_BASE_URL;
  if (branded) return branded.replace(/\/+$/, "");
  const domain = process.env.RAILWAY_PUBLIC_DOMAIN;
  return domain ? `https://${domain}` : `http://localhost:${process.env.PORT ?? 4000}`;
}

function firstName(fullName: string): string {
  return fullName.split(/\s+/)[0] || fullName;
}

function formatDateCT(d: Date): string {
  return d.toLocaleDateString("en-US", { timeZone: TZ, weekday: "long", month: "long", day: "numeric" });
}

function formatTimeCT(d: Date): string {
  return d.toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" });
}

// ─── CONFIRMATION TOKEN ─────────────────────────────────────────────────────────

/** Ensure a visit has a confirmation token; returns it. */
export async function ensureConfirmationToken(visitId: string): Promise<string> {
  const visit = await prisma.visit.findUniqueOrThrow({ where: { id: visitId }, select: { confirmationToken: true } });
  if (visit.confirmationToken) return visit.confirmationToken;
  const token = crypto.randomBytes(16).toString("base64url");
  await prisma.visit.update({ where: { id: visitId }, data: { confirmationToken: token } });
  return token;
}

// ─── CONFIRMATION REQUEST (booked / rescheduled) ────────────────────────────────

export interface VisitContact {
  visitId: string;
  customerName: string;
  email?: string | null;
  phone?: string | null;
  address: string;
  scheduledStart: Date;
  jobType?: string | null;
}

/**
 * Send the dual-channel confirmation request for a scheduled visit.
 * Email gets Confirm / Reschedule / Cancel links; SMS gets keyword instructions.
 */
export async function sendVisitConfirmationRequest(c: VisitContact): Promise<{ email: boolean; sms: boolean }> {
  const token = await ensureConfirmationToken(c.visitId);
  const url = `${publicBaseUrl()}/api/confirm/${token}`;
  const dateStr = formatDateCT(c.scheduledStart);
  const timeStr = formatTimeCT(c.scheduledStart);
  const result = { email: false, sms: false };

  if (c.email) {
    const jobLine = c.jobType ? `<p style="margin:0 0 6px;font-size:15px;"><strong>Service:</strong> ${escapeHtml(c.jobType)}</p>` : "";
    result.email = await sendBrandedEmail({
      to: c.email,
      subject: `Please confirm your appointment — ${dateStr}`,
      headline: "Confirm Your Appointment",
      bodyHtml: `
        <p style="font-size:16px;margin:0 0 16px;">Hi ${escapeHtml(firstName(c.customerName))},</p>
        <p style="font-size:15px;margin:0 0 16px;">Please confirm your upcoming appointment with us:</p>
        <div style="background:#f0f7f1;padding:16px;border-radius:6px;margin:0 0 16px;">
          <p style="margin:0 0 6px;font-size:15px;"><strong>Date:</strong> ${dateStr}</p>
          <p style="margin:0 0 6px;font-size:15px;"><strong>Arrival:</strong> ${timeStr}</p>
          <p style="margin:0 0 6px;font-size:15px;"><strong>Address:</strong> ${escapeHtml(c.address)}</p>
          ${jobLine}
        </div>
        <div style="text-align:center;margin:0 0 16px;">
          <a href="${url}?action=confirm" style="display:inline-block;background:#1a5c2e;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;font-size:16px;font-weight:600;">Confirm Appointment</a>
        </div>
        <p style="font-size:13px;color:#777;text-align:center;margin:0 0 8px;">
          Need a different time? <a href="${url}?action=reschedule" style="color:#1a5c2e;">Request a reschedule</a>
          &nbsp;&middot;&nbsp; <a href="${url}?action=cancel" style="color:#a33;">Cancel</a>
        </p>
        <p style="font-size:13px;color:#777;text-align:center;margin:0;">Or call us at ${BUSINESS_PHONE}.</p>`,
    });
  }

  if (c.phone) {
    const sms = `Hi ${firstName(c.customerName)}, this is Red Cedar Electric. Please confirm your appointment on ${dateStr} at ${timeStr}. Reply YES to confirm, RESCHEDULE for a new time, or NO to cancel. Details: ${url} Reply STOP to opt out.`;
    result.sms = (await sendSms(c.phone, sms)) !== null;
  }

  if (!c.email && !c.phone) {
    console.warn(`[VisitConfirmations] Visit ${c.visitId} has no email or phone — confirmation request skipped.`);
  }
  return result;
}

// ─── CONFIRMATION ACTIONS (shared by /confirm page + SMS replies) ──────────────

export type ConfirmationAction = "confirm" | "reschedule" | "cancel";

export interface ConfirmationOutcome {
  visitId: string;
  customerName: string;
  action: ConfirmationAction;
  alreadyDone: boolean;
}

/**
 * Apply a customer confirmation action to a visit and notify Kyle.
 * `channel` records how the customer responded (email_link | sms_reply).
 */
export async function applyConfirmationAction(
  visitId: string,
  action: ConfirmationAction,
  channel: "email_link" | "sms_reply",
): Promise<ConfirmationOutcome> {
  const visit = await prisma.visit.findUniqueOrThrow({
    where: { id: visitId },
    include: { customer: { select: { name: true, phone: true } }, property: true },
  });

  const statusMap: Record<ConfirmationAction, string> = {
    confirm: "confirmed",
    reschedule: "reschedule_requested",
    cancel: "cancel_requested",
  };
  const target = statusMap[action];
  const alreadyDone = visit.confirmationStatus === target;

  if (!alreadyDone) {
    await prisma.visit.update({
      where: { id: visitId },
      data: {
        confirmationStatus: target,
        confirmationChannel: channel,
        ...(action === "confirm" ? { confirmedAt: new Date() } : {}),
      },
    });

    const when = visit.scheduledStart ? `${formatDateCT(visit.scheduledStart)} at ${formatTimeCT(visit.scheduledStart)}` : "unscheduled";
    const address = [visit.property.addressLine1, visit.property.city].filter(Boolean).join(", ");
    const kyleMsg: Record<ConfirmationAction, string> = {
      confirm: `CONFIRMED: ${visit.customer.name} — ${when} — ${address}`,
      reschedule: `RESCHEDULE REQUEST: ${visit.customer.name} — currently ${when} — ${address}${visit.customer.phone ? ` — ${visit.customer.phone}` : ""}. Call to arrange a new time.`,
      cancel: `CANCEL REQUEST: ${visit.customer.name} — was ${when} — ${address}${visit.customer.phone ? ` — ${visit.customer.phone}` : ""}. Job NOT removed from calendar — review and cancel manually.`,
    };
    sendSms(KYLE_PHONE, kyleMsg[action]).catch((err) => console.error("[VisitConfirmations] Kyle SMS failed:", err));
  }

  return { visitId, customerName: visit.customer.name, action, alreadyDone };
}

// ─── 24-HOUR REMINDERS (cron) ───────────────────────────────────────────────────

/**
 * Send email+SMS reminders for visits starting within the next 18–30 hours
 * that haven't been reminded yet. Returns how many visits were reminded.
 */
export async function sendVisitReminders(now = new Date()): Promise<number> {
  const windowStart = new Date(now.getTime() + 18 * 3600_000);
  const windowEnd = new Date(now.getTime() + 30 * 3600_000);

  const visits = await prisma.visit.findMany({
    where: {
      scheduledStart: { gte: windowStart, lte: windowEnd },
      status: { in: ["scheduled", "contracted", "estimate"] },
      reminderSentAt: null,
      confirmationStatus: { notIn: ["cancel_requested"] },
    },
    include: { customer: true, property: true },
  });

  let sent = 0;
  for (const visit of visits) {
    const start = visit.scheduledStart!;
    const dateStr = formatDateCT(start);
    const timeStr = formatTimeCT(start);
    const address = [visit.property.addressLine1, visit.property.city, visit.property.state].filter(Boolean).join(", ");
    const token = await ensureConfirmationToken(visit.id);
    const url = `${publicBaseUrl()}/api/confirm/${token}`;

    if (visit.customer.email) {
      await sendBrandedEmail({
        to: visit.customer.email,
        subject: `Reminder: your appointment tomorrow — ${dateStr}`,
        headline: "Appointment Reminder",
        bodyHtml: `
          <p style="font-size:16px;margin:0 0 16px;">Hi ${escapeHtml(firstName(visit.customer.name))},</p>
          <p style="font-size:15px;margin:0 0 16px;">A quick reminder — we'll see you <strong>${dateStr}</strong> at <strong>${timeStr}</strong> at ${escapeHtml(address)}.</p>
          <p style="font-size:14px;color:#555;margin:0 0 16px;">Please ensure access to the electrical panel and work area. Need to make a change? <a href="${url}" style="color:#1a5c2e;">Manage your appointment</a> or call ${BUSINESS_PHONE}.</p>`,
      }).catch((err) => console.error("[VisitReminders] Email failed:", err));
    }
    if (visit.customer.phone) {
      await sendSms(
        visit.customer.phone,
        `Hi ${firstName(visit.customer.name)}, reminder from Red Cedar Electric: we'll see you tomorrow, ${dateStr} at ${timeStr}. Reply RESCHEDULE if you need a new time. Reply STOP to opt out.`,
      ).catch((err) => console.error("[VisitReminders] SMS failed:", err));
    }

    await prisma.visit.update({ where: { id: visit.id }, data: { reminderSentAt: new Date() } });
    sent += 1;
  }
  return sent;
}

// ─── TECHNICIAN JOB NOTIFICATIONS ───────────────────────────────────────────────

export type TechNotifyEvent = "assigned" | "changed" | "cancelled";

/**
 * Notify a technician about an assignment event (dual-channel where contact
 * info exists). Fire-and-forget from route handlers.
 */
export async function notifyTechnicianOfAssignment(
  technicianId: string,
  visitId: string,
  event: TechNotifyEvent,
): Promise<void> {
  const [tech, visit] = await Promise.all([
    prisma.technician.findUnique({ where: { id: technicianId } }),
    prisma.visit.findUnique({ where: { id: visitId }, include: { customer: { select: { name: true } }, property: true } }),
  ]);
  if (!tech || !visit) return;

  const when = visit.scheduledStart ? `${formatDateCT(visit.scheduledStart)} at ${formatTimeCT(visit.scheduledStart)}` : "not yet scheduled";
  const address = [visit.property.addressLine1, visit.property.city, visit.property.state].filter(Boolean).join(", ");
  const purpose = visit.purpose ?? visit.jobType ?? "Service visit";

  const headlines: Record<TechNotifyEvent, string> = {
    assigned: "New Job Assigned",
    changed: "Job Updated",
    cancelled: "Job Cancelled",
  };
  const smsLead: Record<TechNotifyEvent, string> = {
    assigned: "NEW JOB",
    changed: "JOB UPDATED",
    cancelled: "JOB CANCELLED",
  };

  if (tech.phone) {
    const sms = [
      `${smsLead[event]} — Red Cedar Electric`,
      `${visit.customer.name} — ${address}`,
      `${purpose}`,
      `When: ${when}`,
      event !== "cancelled" ? "Details in the field app." : null,
    ].filter(Boolean).join("\n");
    sendSms(tech.phone, sms).catch((err) => console.error("[TechNotify] SMS failed:", err));
  }

  if (tech.email) {
    sendBrandedEmail({
      to: tech.email,
      subject: `${headlines[event]}: ${visit.customer.name} — ${when}`,
      headline: headlines[event],
      bodyHtml: `
        <p style="font-size:15px;margin:0 0 16px;">Hi ${escapeHtml(firstName(tech.name))},</p>
        <div style="background:#f0f7f1;padding:16px;border-radius:6px;margin:0 0 16px;">
          <p style="margin:0 0 6px;font-size:15px;"><strong>Customer:</strong> ${escapeHtml(visit.customer.name)}</p>
          <p style="margin:0 0 6px;font-size:15px;"><strong>Address:</strong> ${escapeHtml(address)}</p>
          <p style="margin:0 0 6px;font-size:15px;"><strong>Scope:</strong> ${escapeHtml(purpose)}</p>
          <p style="margin:0 0 6px;font-size:15px;"><strong>When:</strong> ${when}</p>
        </div>
        ${event !== "cancelled" ? `<p style="font-size:14px;color:#555;margin:0;">Full details and the inspection checklist are in the field app.</p>` : ""}`,
    }).catch((err) => console.error("[TechNotify] Email failed:", err));
  }
}

// ─── WEB-FORM AUTO-REPLY ────────────────────────────────────────────────────────

/** Instant "we got your request" email for web-form leads. */
export async function sendWebLeadAutoReply(input: { name: string; email: string; jobType?: string | null }): Promise<boolean> {
  return sendBrandedEmail({
    to: input.email,
    subject: "We received your request — Red Cedar Electric",
    headline: "Request Received",
    bodyHtml: `
      <p style="font-size:16px;margin:0 0 16px;">Hi ${escapeHtml(firstName(input.name))},</p>
      <p style="font-size:15px;margin:0 0 16px;">Thanks for reaching out${input.jobType ? ` about your <strong>${escapeHtml(input.jobType)}</strong> project` : ""}. Your request is in our system and a member of our team will follow up within one business day — typically sooner.</p>
      <p style="font-size:14px;color:#555;margin:0 0 8px;"><strong>What happens next:</strong></p>
      <ul style="font-size:14px;color:#555;margin:0 0 16px;padding-left:20px;">
        <li>We'll review your project details and reach out by your preferred contact method.</li>
        <li>If it helps, you can reply to this email with photos of the work area.</li>
        <li>Prefer to talk now? Call us at ${BUSINESS_PHONE}.</li>
      </ul>`,
  });
}
