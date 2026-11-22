/**
 * The default wording of the header on a customer text (work order agent-team, addendum 4a): every
 * transactional text starts "Red Cedar Electric: <purpose label> <date or window>". Keyed by
 * purposeKey, the frozen column on HubMessage; the send-type registry (shared/hub/messageCategories.ts)
 * says which purposeKey each send type uses. Kyle edits these through an owner setting later (U9);
 * this file is only the defaults. There is NO review-request purpose: a review is never texted.
 */

export const SMS_PURPOSES = {
  consultation: { defaultLabel: "Consultation" },
  job_scheduled: { defaultLabel: "Job Scheduled" },
  reschedule: { defaultLabel: "Reschedule" },
  appointment_cancelled: { defaultLabel: "Appointment Cancelled" },
  appointment_confirmation: { defaultLabel: "Appointment Confirmation" },
  appointment_reminder: { defaultLabel: "Appointment Reminder" },
  cancellation_request: { defaultLabel: "Cancellation Request" },
  text_alerts_confirmed: { defaultLabel: "Text Alerts Confirmed" },
  request_received: { defaultLabel: "Request Received" },
  thread_reply: { defaultLabel: "Reply" },
} as const;

export type SmsPurposeKey = keyof typeof SMS_PURPOSES;

export function isSmsPurposeKey(value: string): value is SmsPurposeKey {
  return Object.prototype.hasOwnProperty.call(SMS_PURPOSES, value);
}

/**
 * The header label for a purpose: Kyle's edited label when he has set one (the `smsPurposeLabels`
 * owner setting, which arrives with U9), otherwise the default above. The composer
 * (shared/sms/compose.ts) is the only caller that prints it.
 */
export function smsPurposeLabel(key: SmsPurposeKey, overrides?: Partial<Record<string, string>>): string {
  const edited = overrides?.[key]?.trim();
  return edited ? edited : SMS_PURPOSES[key].defaultLabel;
}
