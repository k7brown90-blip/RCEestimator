/**
 * Appointment confirmation email — sends branded HTML to customer
 * when an appointment is booked (via Savannah, email, or CRM).
 *
 * Uses Gmail OAuth2 via nodemailer (same setup as dailySummary.ts).
 */

import nodemailer from "nodemailer";

const BRANDED_FOOTER = `
  <p style="font-size:14px;color:#888;margin:16px 0 0;border-top:1px solid #eee;padding-top:12px;">
    Red Cedar Electric LLC &middot; Licensed &amp; Insured<br>
    Serving Middle Tennessee
  </p>`;

interface ConfirmationInput {
  customerName: string;
  customerEmail: string;
  appointmentDate: string;   // e.g. "Monday, April 21"
  appointmentWindow: string; // e.g. "8:00 AM – 10:00 AM"
  serviceAddress: string;
  jobType?: string;
}

function getTransporter() {
  const gmailUser = process.env.GMAIL_USER;
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (!gmailUser || !clientId || !clientSecret || !refreshToken) {
    return null;
  }

  return {
    transporter: nodemailer.createTransport({
      service: "gmail",
      auth: {
        type: "OAuth2" as const,
        user: gmailUser,
        clientId,
        clientSecret,
        refreshToken,
      },
    }),
    from: `"Red Cedar Electric" <${gmailUser}>`,
  };
}

export async function sendConfirmationEmail(input: ConfirmationInput): Promise<boolean> {
  const mail = getTransporter();
  if (!mail) {
    console.warn("[ConfirmationEmail] Gmail not configured — skipping.");
    return false;
  }

  const jobLine = input.jobType
    ? `<p style="margin:0 0 6px;font-size:15px;"><strong>Service:</strong> ${input.jobType}</p>`
    : "";

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:0 auto;color:#333;">
      <div style="background:#1a5c2e;color:#fff;padding:20px 24px;border-radius:8px 8px 0 0;">
        <h1 style="margin:0;font-size:20px;">Appointment Confirmed</h1>
        <p style="margin:4px 0 0;font-size:14px;opacity:0.9;">Red Cedar Electric LLC</p>
      </div>
      <div style="padding:20px 24px;background:#fff;border:1px solid #e0e0e0;border-top:none;border-radius:0 0 8px 8px;">
        <p style="font-size:16px;margin:0 0 16px;">Hi ${input.customerName},</p>
        <p style="font-size:15px;margin:0 0 16px;">Your appointment has been scheduled. Here are the details:</p>

        <div style="background:#f0f7f1;padding:16px;border-radius:6px;margin:0 0 16px;">
          <p style="margin:0 0 6px;font-size:15px;"><strong>Date:</strong> ${input.appointmentDate}</p>
          <p style="margin:0 0 6px;font-size:15px;"><strong>Arrival Window:</strong> ${input.appointmentWindow}</p>
          <p style="margin:0 0 6px;font-size:15px;"><strong>Address:</strong> ${input.serviceAddress}</p>
          ${jobLine}
        </div>

        <p style="font-size:14px;color:#555;margin:0 0 8px;"><strong>What to expect:</strong></p>
        <ul style="font-size:14px;color:#555;margin:0 0 16px;padding-left:20px;">
          <li>Kyle will arrive within the scheduled window in a marked Red Cedar Electric vehicle.</li>
          <li>Please ensure access to the electrical panel and work area.</li>
          <li>If you need to reschedule, reply to this email or call (615) 857-6389.</li>
        </ul>

        ${BRANDED_FOOTER}
      </div>
    </div>`;

  try {
    await mail.transporter.sendMail({
      from: mail.from,
      to: input.customerEmail,
      subject: `Appointment Confirmed — ${input.appointmentDate}`,
      html,
    });
    console.log(`[ConfirmationEmail] Sent to ${input.customerEmail}`);
    return true;
  } catch (err) {
    console.error("[ConfirmationEmail] Failed:", err);
    return false;
  }
}

// ─── RESCHEDULE EMAIL ─────────────────────────────────────────────────────────

interface RescheduleInput {
  customerName: string;
  customerEmail: string;
  oldDate: string;
  oldWindow: string;
  newDate: string;
  newWindow: string;
  serviceAddress: string;
  jobType?: string;
}

export async function sendRescheduleEmail(input: RescheduleInput): Promise<boolean> {
  const mail = getTransporter();
  if (!mail) {
    console.warn("[RescheduleEmail] Gmail not configured — skipping.");
    return false;
  }

  const jobLine = input.jobType
    ? `<p style="margin:0 0 6px;font-size:15px;"><strong>Service:</strong> ${input.jobType}</p>`
    : "";

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:0 auto;color:#333;">
      <div style="background:#1a5c2e;color:#fff;padding:20px 24px;border-radius:8px 8px 0 0;">
        <h1 style="margin:0;font-size:20px;">Appointment Rescheduled</h1>
        <p style="margin:4px 0 0;font-size:14px;opacity:0.9;">Red Cedar Electric LLC</p>
      </div>
      <div style="padding:20px 24px;background:#fff;border:1px solid #e0e0e0;border-top:none;border-radius:0 0 8px 8px;">
        <p style="font-size:16px;margin:0 0 16px;">Hi ${input.customerName},</p>
        <p style="font-size:15px;margin:0 0 16px;">Your appointment has been rescheduled. Here are the updated details:</p>

        <div style="background:#fff8e1;padding:16px;border-radius:6px;margin:0 0 12px;">
          <p style="margin:0;font-size:14px;color:#888;text-decoration:line-through;">
            Previously: ${input.oldDate}, ${input.oldWindow}
          </p>
        </div>

        <div style="background:#f0f7f1;padding:16px;border-radius:6px;margin:0 0 16px;">
          <p style="margin:0 0 6px;font-size:15px;"><strong>New Date:</strong> ${input.newDate}</p>
          <p style="margin:0 0 6px;font-size:15px;"><strong>Arrival Window:</strong> ${input.newWindow}</p>
          <p style="margin:0 0 6px;font-size:15px;"><strong>Address:</strong> ${input.serviceAddress}</p>
          ${jobLine}
        </div>

        <p style="font-size:14px;color:#555;">If you need to make further changes, reply to this email or call (615) 857-6389.</p>

        ${BRANDED_FOOTER}
      </div>
    </div>`;

  try {
    await mail.transporter.sendMail({
      from: mail.from,
      to: input.customerEmail,
      subject: `Appointment Rescheduled — ${input.newDate}`,
      html,
    });
    console.log(`[RescheduleEmail] Sent to ${input.customerEmail}`);
    return true;
  } catch (err) {
    console.error("[RescheduleEmail] Failed:", err);
    return false;
  }
}

// ─── CANCELLATION EMAIL ───────────────────────────────────────────────────────

interface CancellationInput {
  customerName: string;
  customerEmail: string;
  appointmentDate: string;
  serviceAddress: string;
  jobType?: string;
}

export async function sendCancellationEmail(input: CancellationInput): Promise<boolean> {
  const mail = getTransporter();
  if (!mail) {
    console.warn("[CancellationEmail] Gmail not configured — skipping.");
    return false;
  }

  const jobLine = input.jobType
    ? `<p style="margin:0 0 6px;font-size:15px;"><strong>Service:</strong> ${input.jobType}</p>`
    : "";

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:0 auto;color:#333;">
      <div style="background:#1a5c2e;color:#fff;padding:20px 24px;border-radius:8px 8px 0 0;">
        <h1 style="margin:0;font-size:20px;">Appointment Cancelled</h1>
        <p style="margin:4px 0 0;font-size:14px;opacity:0.9;">Red Cedar Electric LLC</p>
      </div>
      <div style="padding:20px 24px;background:#fff;border:1px solid #e0e0e0;border-top:none;border-radius:0 0 8px 8px;">
        <p style="font-size:16px;margin:0 0 16px;">Hi ${input.customerName},</p>
        <p style="font-size:15px;margin:0 0 16px;">Your appointment has been cancelled.</p>

        <div style="background:#fce4e4;padding:16px;border-radius:6px;margin:0 0 16px;">
          <p style="margin:0 0 6px;font-size:15px;"><strong>Date:</strong> ${input.appointmentDate}</p>
          <p style="margin:0 0 6px;font-size:15px;"><strong>Address:</strong> ${input.serviceAddress}</p>
          ${jobLine}
        </div>

        <p style="font-size:15px;margin:0 0 16px;">To reschedule, reply to this email or call us at (615) 857-6389. We'd be happy to find a new time that works for you.</p>

        ${BRANDED_FOOTER}
      </div>
    </div>`;

  try {
    await mail.transporter.sendMail({
      from: mail.from,
      to: input.customerEmail,
      subject: `Appointment Cancelled — Red Cedar Electric`,
      html,
    });
    console.log(`[CancellationEmail] Sent to ${input.customerEmail}`);
    return true;
  } catch (err) {
    console.error("[CancellationEmail] Failed:", err);
    return false;
  }
}

// ─── PROPOSAL EMAIL ──────────────────────────────────────────────────────────

interface ProposalEmailInput {
  customerName: string;
  customerEmail: string;
  serviceAddress: string;
  jobDescription: string;
  signUrl: string;
}

export async function sendProposalEmail(input: ProposalEmailInput): Promise<boolean> {
  const mail = getTransporter();
  if (!mail) {
    console.warn("[ProposalEmail] Gmail not configured — skipping.");
    return false;
  }

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:0 auto;color:#333;">
      <div style="background:#1a5c2e;color:#fff;padding:16px 24px;border-radius:8px 8px 0 0;">
        <h1 style="margin:0;font-size:18px;">Your Proposal from Red Cedar Electric</h1>
      </div>
      <div style="padding:20px 24px;background:#fff;border:1px solid #e0e0e0;border-top:none;">
        <p style="font-size:15px;">Hi ${input.customerName},</p>
        <p style="font-size:14px;">Thank you for choosing Red Cedar Electric. Your proposal is ready for review.</p>
        <div style="background:#f7f7f7;border:1px solid #e0e0e0;border-radius:8px;padding:16px;margin:16px 0;">
          <p style="margin:0 0 6px;font-size:13px;color:#888;">Service Address</p>
          <p style="margin:0;font-weight:600;">${input.serviceAddress}</p>
          <p style="margin:12px 0 6px;font-size:13px;color:#888;">Description</p>
          <p style="margin:0;">${input.jobDescription}</p>
        </div>
        <div style="text-align:center;margin:24px 0;">
          <a href="${input.signUrl}" style="display:inline-block;background:#1a5c2e;color:#fff;text-decoration:none;padding:14px 36px;font-size:16px;font-weight:600;border-radius:6px;">
            Review &amp; Sign Your Proposal
          </a>
        </div>
        <p style="font-size:13px;color:#888;">If you have any questions, feel free to call or reply to this email.</p>
      </div>
      <div style="padding:12px 24px;border:1px solid #e0e0e0;border-top:none;border-radius:0 0 8px 8px;">
        ${BRANDED_FOOTER}
      </div>
    </div>`;

  try {
    await mail.transporter.sendMail({
      from: mail.from,
      to: input.customerEmail,
      subject: "Your Proposal from Red Cedar Electric — Review & Sign",
      html,
    });
    console.log(`[ProposalEmail] Sent to ${input.customerEmail}`);
    return true;
  } catch (err) {
    console.error("[ProposalEmail] Failed:", err);
    return false;
  }
}

// ─── KYLE NOTIFICATION EMAIL ──────────────────────────────────────────────────

export async function sendKyleNotificationEmail(subject: string, body: string): Promise<boolean> {
  const mail = getTransporter();
  if (!mail) {
    console.warn("[KyleNotificationEmail] Gmail not configured — skipping.");
    return false;
  }

  const kyleEmail = process.env.KYLE_EMAIL ?? process.env.GMAIL_USER;
  if (!kyleEmail) return false;

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:0 auto;color:#333;">
      <div style="background:#1a5c2e;color:#fff;padding:16px 24px;border-radius:8px 8px 0 0;">
        <h1 style="margin:0;font-size:18px;">${subject}</h1>
      </div>
      <div style="padding:20px 24px;background:#fff;border:1px solid #e0e0e0;border-top:none;border-radius:0 0 8px 8px;">
        <pre style="font-family:inherit;font-size:14px;margin:0;white-space:pre-wrap;">${body}</pre>
      </div>
    </div>`;

  try {
    await mail.transporter.sendMail({
      from: mail.from,
      to: kyleEmail,
      subject: `[RCE] ${subject}`,
      html,
    });
    console.log(`[KyleNotificationEmail] Sent: ${subject}`);
    return true;
  } catch (err) {
    console.error("[KyleNotificationEmail] Failed:", err);
    return false;
  }
}
