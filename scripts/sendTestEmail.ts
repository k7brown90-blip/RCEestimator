/**
 * Email smoke test — proves the Gmail path actually delivers. (P032)
 *
 * `checkGoogleCalendarConnection.ts` proves the refresh token can be exchanged and that the
 * CALENDAR API answers. That is necessary but not sufficient: Gmail is a different API reached
 * over SMTP with XOAUTH2, and a token can carry the calendar scope while the mail path still
 * fails. On 2026-08-18 the token was dead and both were broken together, which is exactly the
 * situation where it is tempting to declare victory on one check.
 *
 * So this sends a real message through `sendBrandedEmail` — the same function every customer
 * email goes through — and reports what came back.
 *
 * Run from app/ (needs the production credentials, NOT the database):
 *     railway run npx tsx scripts/sendTestEmail.ts [recipient]
 *
 * DEFAULTS TO KYLE'S OWN ADDRESS. A smoke test must never be able to reach a customer by
 * accident, so the recipient is his inbox unless one is typed explicitly.
 */

import { sendBrandedEmail } from "../src/services/confirmationEmail";

async function main(): Promise<void> {
  const to = process.argv[2] ?? process.env.GMAIL_USER ?? "service@redcedarelectricllc.com";
  const at = new Date().toISOString();

  console.log(`Sending a test email to ${to} …`);

  const ok = await sendBrandedEmail({
    to,
    subject: `Email smoke test — ${at}`,
    headline: "Email is working",
    bodyHtml: `
      <p style="font-size:15px;">This is an automated smoke test of the Gmail send path.</p>
      <p style="font-size:14px;color:#666;">Sent ${at}. If you are reading this, estimates,
      appointment confirmations and the daily digest can all send.</p>`,
  });

  if (ok) {
    console.log("✅ SENT — the Gmail path is working end to end.");
    return;
  }

  console.error("❌ NOT SENT.");
  console.error("   The reason was written to SystemEvent (source=\"email\") with the transport");
  console.error("   code and a likely cause. Read it with:");
  console.error("     railway ssh \"node dist/scripts/readSystemEvents.js --source email --details\"");
  process.exitCode = 1;
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
