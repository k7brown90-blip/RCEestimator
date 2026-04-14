/**
 * Appointment confirmation email — sends branded HTML to customer
 * when an appointment is booked (via Savannah, email, or CRM).
 *
 * Uses Gmail OAuth2 via nodemailer (same setup as dailySummary.ts).
 */

import nodemailer from "nodemailer";

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

        <p style="font-size:14px;color:#888;margin:16px 0 0;border-top:1px solid #eee;padding-top:12px;">
          Red Cedar Electric LLC · Licensed &amp; Insured<br>
          Serving Middle Tennessee
        </p>
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
