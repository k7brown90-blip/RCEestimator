/**
 * Deliverability probe (Kyle, 2026-09-09: "I need the emails working, very few
 * are actually getting through"). Sends ONE branded email through the exact
 * production transport (Gmail OAuth2 SMTP via nodemailer, HTML + plain-text
 * twin) to an address you name — a mail-tester.com address, or a customer's
 * mailbox you control — so the receiving side's authentication results and
 * spam score can be read.
 *
 *   railway ssh "node dist/scripts/sendTestEmail.js --to test-rce0909@srv1.mail-tester.com"
 *
 * Nothing is written to the database. Refuses to run without --to.
 */

import { sendBrandedEmail } from "../src/services/confirmationEmail";

const argv = process.argv.slice(2);
const i = argv.indexOf("--to");
const to = i >= 0 ? argv[i + 1] : undefined;

async function main(): Promise<void> {
  if (!to || !to.includes("@")) {
    console.error("usage: --to <address>");
    process.exitCode = 2;
    return;
  }
  const link = "https://rceestimator-production.up.railway.app/e/example";
  const ok = await sendBrandedEmail({
    to,
    subject: "Your estimate from Red Cedar Electric — 2026-TEST",
    headline: "Your estimate is ready",
    bodyHtml: `
      <p style="font-size:16px;margin:0 0 16px;">Hi there,</p>
      <p style="font-size:15px;margin:0 0 16px;">Your estimate for <strong>Deliverability probe</strong> is ready. You can review it and accept it online using the private link below.</p>
      <p style="margin:0 0 16px;"><a href="${link}" style="display:inline-block;background:#1a5c2e;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:600;">View &amp; accept your estimate</a></p>
      <p style="font-size:13px;color:#555;margin:0 0 16px;">Estimate 2026-TEST · Total $100.00 · Valid 30 days.</p>
      <p style="font-size:13px;color:#555;margin:0;">If the button does not work, copy this link into your browser:<br>${link}</p>
      <p style="font-size:15px;margin:16px 0 0;">Thank you,<br>Kyle Brown<br>Red Cedar Electric LLC</p>`,
  });
  console.log(ok ? `Sent to ${to} at ${new Date().toISOString()}` : `NOT sent to ${to} — see the error above`);
  if (!ok) process.exitCode = 1;
}

void main();
