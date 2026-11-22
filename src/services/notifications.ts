/**
 * Locked SMS notification templates for scheduling messages. The SMS bodies are not generated
 * by a model — these templates are the single source of truth.
 */

import { sendSms, KYLE_PHONE, type SmsMeta, type SmsSent } from "./twilio";
import { twilioSendEnabled, logTwilioSendSkipped } from "./automationGate";

const BUSINESS_PHONE = "615-625-2163";
const TZ = "America/Chicago";

// ─── TYPE DEFINITIONS ───────────────────────────────────────────────────────────

export interface JobData {
  customerName: string;
  phone: string;
  address: string;
  jobType: string;
  scheduledStart: Date;
  scheduledEnd: Date;
  durationDays: number;
  startTime: string;   // e.g. "7:00 AM"
}

export interface DateRange {
  start: Date;
  end: Date;
  time: string;
}

// ─── FORMATTING HELPERS ─────────────────────────────────────────────────────────

function firstName(fullName: string): string {
  return fullName.split(/\s+/)[0] || fullName;
}

function formatDayOfWeek(d: Date): string {
  return d.toLocaleDateString("en-US", { timeZone: TZ, weekday: "long" });
}

function formatDate(d: Date): string {
  return d.toLocaleDateString("en-US", { timeZone: TZ, month: "long", day: "numeric" });
}

function formatShortDate(d: Date): string {
  return d.toLocaleDateString("en-US", { timeZone: TZ, weekday: "short", month: "short", day: "numeric" });
}

// ─── CUSTOMER SMS TEMPLATES ─────────────────────────────────────────────────────
//
// These are the WORDS only. The company name and the reason label ("Red Cedar Electric: Job Scheduled Mon
// 11/23, 8 AM") are the header, and "Reply STOP to opt out." is the footer on the first text to a number:
// both are added by the one composer inside sendSms (shared/sms/compose.ts), so a template never writes
// either (a body that does is refused).

export function customerWorkScheduled(job: JobData): string {
  return `Hi ${firstName(job.customerName)}, your ${job.jobType} is scheduled to start ${formatDayOfWeek(job.scheduledStart)} ${formatDate(job.scheduledStart)} at ${job.startTime}. We expect ${job.durationDays} day(s) on site. Our team will text the morning of with arrival details.`;
}

export function customerReschedule(job: JobData, oldDates: DateRange, newDates: DateRange): string {
  return `Hi ${firstName(job.customerName)}, your ${job.jobType} has been moved to ${formatDayOfWeek(newDates.start)} ${formatDate(newDates.start)} at ${newDates.time}. Same ${job.durationDays} day(s) on site. Our team will text the morning of.`;
}

export function customerCancellation(job: JobData): string {
  return `Hi ${firstName(job.customerName)}, your ${job.jobType} originally scheduled for ${formatDate(job.scheduledStart)} has been cancelled. Call us at ${BUSINESS_PHONE} to reschedule.`;
}

/**
 * Sent once, immediately, the first time a web lead checks the SMS consent
 * checkbox and provides a phone number. This is the literal opt-in
 * confirmation declared in the Twilio A2P campaign — the wording here must
 * match what's registered there. Do not add variables or personalize it;
 * carriers expect the opt-in confirmation to be a fixed, predictable message.
 *
 * U9 (2026-11-21): it now goes out through the one composer like every customer text, so the words
 * below are what follows the header ("Red Cedar Electric: Text Alerts Confirmed <send time>") and the
 * "Reply STOP to opt out." footer comes from the composer (this is the first text to a new number).
 * The old wording began with the company name and carried its own "Reply STOP to cancel", both now
 * refused as a double header and a double footer. KYLE: the A2P opt-in sample must be re-registered
 * with this wording and the header (see the report).
 */
export function webOptInConfirmation(): string {
  return "You're confirmed to receive service and appointment texts from us. Msg frequency varies, up to 10 msgs/month. Msg & data rates may apply. Reply HELP for help. Terms: redcedarelectricllc.com/terms Privacy: redcedarelectricllc.com/privacy";
}

// ─── KYLE SMS TEMPLATES ─────────────────────────────────────────────────────────

export function kyleWorkScheduled(job: JobData): string {
  return [
    "JOB SCHEDULED",
    `${job.customerName} — ${job.phone}`,
    job.address,
    `${job.jobType} — ${job.durationDays} day(s)`,
    `Start: ${formatShortDate(job.scheduledStart)} at ${job.startTime}`,
    `End: ${formatShortDate(job.scheduledEnd)}`,
  ].join("\n");
}

export function kyleReschedule(job: JobData, oldDates: DateRange, newDates: DateRange, reason: string): string {
  return [
    "RESCHEDULE",
    `${job.customerName} — ${job.phone}`,
    job.address,
    `Was: ${formatShortDate(oldDates.start)} at ${oldDates.time}`,
    `Now: ${formatShortDate(newDates.start)} at ${newDates.time}`,
    `Reason: ${reason}`,
  ].join("\n");
}

export function kyleRescheduleConflict(
  job: JobData,
  requestedDate: Date,
  conflict: string,
): string {
  return [
    "RESCHEDULE ATTEMPTED — BLOCKED",
    `${job.customerName} (${job.phone}) wanted to move ${job.jobType} from ${formatShortDate(job.scheduledStart)} to ${formatShortDate(requestedDate)}`,
    `Conflict: ${conflict}`,
  ].join("\n");
}

// ─── SMS SEND WRAPPERS ─────────────────────────────────────────────────────────

/**
 * GATED (no-Twilio-texts ruling 2026-08-13).
 *
 * These two wrappers are the choke point for the scheduling.ts and googleCalendar.ts job
 * lifecycle texts — the send sites P004's inventory missed entirely, which is why they were
 * still live after P004. Gating the wrapper rather than the eight call sites keeps the
 * decision in one readable place, and a *future* caller inherits default-deny, which is the
 * posture the ruling asks for.
 *
 * A gated call returns `null` — the exact value every caller already handles for "Twilio
 * unavailable", so no call site changes behaviour beyond reporting the send as not made.
 * Every one of these paths has an email counterpart that is untouched.
 */
export async function sendCustomerSms(phone: string, body: string, meta: SmsMeta): Promise<SmsSent | null> {
  if (!twilioSendEnabled("customerLifecycleSms")) {
    logTwilioSendSkipped("customerLifecycleSms", "Customer job-lifecycle SMS suppressed; the confirmation email path is unaffected.");
    return null; // a leg switched off writes nothing to the conversation
  }
  return sendSms(phone, body, meta);
}

export async function sendKyleSms(body: string, meta: SmsMeta): Promise<SmsSent | null> {
  if (!twilioSendEnabled("operatorNotifications")) {
    logTwilioSendSkipped("operatorNotifications", "Kyle notification SMS suppressed; the Kyle notification email is unaffected.");
    return null;
  }
  return sendSms(KYLE_PHONE, body, meta);
}
