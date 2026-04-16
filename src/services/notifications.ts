/**
 * Locked SMS notification templates for agent-triggered messages.
 * Agents never generate SMS bodies — these templates are the single source of truth.
 */

import { sendSms, KYLE_PHONE } from "./twilio";

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

export function customerWorkScheduled(job: JobData): string {
  return `Hi ${firstName(job.customerName)}, this is Red Cedar Electric. Your ${job.jobType} is scheduled to start ${formatDayOfWeek(job.scheduledStart)} ${formatDate(job.scheduledStart)} at ${job.startTime}. We expect ${job.durationDays} day(s) on site. Kyle will text the morning of with arrival details. Reply STOP to opt out.`;
}

export function customerReschedule(job: JobData, oldDates: DateRange, newDates: DateRange): string {
  return `Hi ${firstName(job.customerName)}, this is Red Cedar Electric. Your ${job.jobType} has been moved to ${formatDayOfWeek(newDates.start)} ${formatDate(newDates.start)} at ${newDates.time}. Same ${job.durationDays} day(s) on site. Kyle will text the morning of. Reply STOP to opt out.`;
}

export function customerCancellation(job: JobData): string {
  return `Hi ${firstName(job.customerName)}, this is Red Cedar Electric. Your ${job.jobType} originally scheduled for ${formatDate(job.scheduledStart)} has been cancelled. Call us at ${BUSINESS_PHONE} to reschedule. Reply STOP to opt out.`;
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

export async function sendCustomerSms(phone: string, body: string): Promise<{ sid: string } | null> {
  return sendSms(phone, body);
}

export async function sendKyleSms(body: string): Promise<{ sid: string } | null> {
  return sendSms(KYLE_PHONE, body);
}
