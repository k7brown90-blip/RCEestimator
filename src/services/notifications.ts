/**
 * Locked SMS notification templates for agent-triggered messages.
 * Agents never generate SMS bodies — these templates are the single source of truth.
 */

import { sendSms, KYLE_PHONE } from "./twilio";
import { twilioSendEnabled, logTwilioSendSkipped } from "./automationGate";

const BUSINESS_PHONE = "(731) 462-0443";
const TZ = "America/Chicago";

// ─── TYPE DEFINITIONS ───────────────────────────────────────────────────────────

export interface VisitData {
  customerName: string;
  phone: string;
  address: string;
  date: Date;
  time: string;       // e.g. "9:00 AM"
  jobDescription: string;
  urgency?: string;
}

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

export interface CustomerData {
  name: string;
  phone: string;
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

export function customerVisitConfirmation(visit: VisitData): string {
  return `Hi ${firstName(visit.customerName)}, this is Red Cedar Electric. Your free estimate is confirmed for ${formatDayOfWeek(visit.date)} ${formatDate(visit.date)} at ${visit.time}. Kyle will text the morning of with his arrival window. Reply STOP to opt out.`;
}

export function customerDiagnosticConfirmation(visit: VisitData): string {
  return `Hi ${firstName(visit.customerName)}, this is Red Cedar Electric. Your diagnostic visit is confirmed for ${formatDayOfWeek(visit.date)} ${formatDate(visit.date)} at ${visit.time}. The fee is $175 flat — up to 2 hours. If you go ahead with the repair, the $175 comes right off the total. Kyle will text the morning of. Reply STOP to opt out.`;
}

export function customerWorkScheduled(job: JobData): string {
  return `Hi ${firstName(job.customerName)}, this is Red Cedar Electric. Your ${job.jobType} is scheduled to start ${formatDayOfWeek(job.scheduledStart)} ${formatDate(job.scheduledStart)} at ${job.startTime}. We expect ${job.durationDays} day(s) on site. Kyle will text the morning of with arrival details. Reply STOP to opt out.`;
}

export function customerReschedule(job: JobData, oldDates: DateRange, newDates: DateRange): string {
  return `Hi ${firstName(job.customerName)}, this is Red Cedar Electric. Your ${job.jobType} has been moved to ${formatDayOfWeek(newDates.start)} ${formatDate(newDates.start)} at ${newDates.time}. Same ${job.durationDays} day(s) on site. Kyle will text the morning of. Reply STOP to opt out.`;
}

export function customerCancellation(job: JobData): string {
  return `Hi ${firstName(job.customerName)}, this is Red Cedar Electric. Your ${job.jobType} originally scheduled for ${formatDate(job.scheduledStart)} has been cancelled. Call us at ${BUSINESS_PHONE} to reschedule. Reply STOP to opt out.`;
}

/**
 * Sent once, immediately, the first time a web lead checks the SMS consent
 * checkbox and provides a phone number. This is the literal opt-in
 * confirmation declared in the Twilio A2P campaign — the wording here must
 * match what's registered there. Do not add variables or personalize it;
 * carriers expect the opt-in confirmation to be a fixed, predictable message.
 */
export function webOptInConfirmation(): string {
  return "Red Cedar Electric: You're confirmed to receive service and appointment texts from us. Msg frequency varies, up to 10 msgs/month. Msg & data rates may apply. Reply STOP to cancel, HELP for help. Terms: redcedarelectricllc.com/terms Privacy: redcedarelectricllc.com/privacy";
}

// ─── KYLE SMS TEMPLATES ─────────────────────────────────────────────────────────

export function kyleNewBooking(visit: VisitData): string {
  return [
    "NEW ESTIMATE BOOKED",
    `${visit.customerName} — ${visit.phone}`,
    visit.address,
    `${formatShortDate(visit.date)} at ${visit.time}`,
    `"${visit.jobDescription}"`,
    visit.urgency ? `Urgency: ${visit.urgency}` : null,
  ].filter(Boolean).join("\n");
}

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
    "Savannah told them you'll call back to find another date.",
  ].join("\n");
}

export function kyleQuestion(customer: CustomerData, question: string, context?: string): string {
  const lines = [
    `Question from ${customer.name} (${customer.phone}):`,
    "",
    `"${question}"`,
  ];
  if (context) lines.push("", context);
  lines.push("", "Reply directly to them.");
  return lines.join("\n");
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
export async function sendCustomerSms(phone: string, body: string): Promise<{ sid: string } | null> {
  if (!twilioSendEnabled("customerLifecycleSms")) {
    logTwilioSendSkipped("customerLifecycleSms", "Customer job-lifecycle SMS suppressed; the confirmation email path is unaffected.");
    return null;
  }
  return sendSms(phone, body);
}

export async function sendKyleSms(body: string): Promise<{ sid: string } | null> {
  if (!twilioSendEnabled("operatorNotifications")) {
    logTwilioSendSkipped("operatorNotifications", "Kyle notification SMS suppressed; the Kyle notification email is unaffected.");
    return null;
  }
  return sendSms(KYLE_PHONE, body);
}
