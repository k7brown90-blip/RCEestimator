/**
 * Automated customer-send gate — the manual-first switch.
 *
 * Kyle's ruling, 2026-08-11 (decisions/2026-08-11-manual-first-automation-deferral.md):
 * Savannah and Twilio are deferred until the CRM, estimating, and electrical-assessment
 * products work. "Everything runs manually to start: it will be tested live, then slowly
 * integrated and automated." He explicitly approved disabling the production reminder crons
 * behind an env flag.
 *
 * WHAT THIS IS AND IS NOT:
 *
 *   It is a GATE ON CALLERS. Nothing is deleted, nothing is refactored, and the Twilio and
 *   email services are untouched — "move, never delete", applied to code. Every gated workflow
 *   turns back on with one environment variable, per workflow, with no code change. That is
 *   the "sequencing, not deletion" the ruling asks for.
 *
 *   It is NOT a gate on the channel. sendSms()/sendMail() still work, because operator alerts,
 *   technician notifications and human-initiated sends must keep working while the company
 *   runs manual-first. Gating the channel would have taken those down with it.
 *
 * WHY PER-WORKFLOW AND NOT ONE FLAG:
 *
 *   One flag was too coarse. These four workflows differ in who triggers them and how urgent
 *   re-enabling each will be — reminders come back with scheduling, the web-lead auto-reply
 *   comes back with the Google Ads build-out (the ruling's named reactivation trigger), and
 *   booking confirmations may come back the day Kyle decides an automatic "you're booked" text
 *   helps rather than duplicates his phone call. A single flag would force all four back on
 *   together, which is precisely the un-sequenced automation the ruling is avoiding.
 *
 *   So: one MASTER switch, default OFF, plus a per-workflow override. A workflow runs only if
 *   the master is on OR that workflow is explicitly turned on. Default-deny in both directions.
 */

export type CustomerSendWorkflow =
  /** 8:00 AM CT cron — 24-hour appointment reminders, email + SMS, straight to the customer. */
  | "visitReminders"
  /** Booking/reschedule/cancel confirmation requests to the customer. */
  | "bookingConfirmations"
  /** Web-form lead: opt-in confirmation SMS + instant auto-reply email. */
  | "webLeadAutoReply"
  /** Automatic replies to a customer's inbound text (confirm / reschedule / cancel). */
  | "inboundAutoReply";

const MASTER_ENV = "AUTOMATED_CUSTOMER_SENDS";

const WORKFLOW_ENV: Record<CustomerSendWorkflow, string> = {
  visitReminders: "AUTOMATED_CUSTOMER_SENDS_VISIT_REMINDERS",
  bookingConfirmations: "AUTOMATED_CUSTOMER_SENDS_BOOKING_CONFIRMATIONS",
  webLeadAutoReply: "AUTOMATED_CUSTOMER_SENDS_WEB_LEAD_AUTOREPLY",
  inboundAutoReply: "AUTOMATED_CUSTOMER_SENDS_INBOUND_AUTOREPLY",
};

const WORKFLOW_LABEL: Record<CustomerSendWorkflow, string> = {
  visitReminders: "24h appointment reminders (email + SMS to customer)",
  bookingConfirmations: "booking/reschedule/cancel confirmations to customer",
  webLeadAutoReply: "web-lead opt-in SMS + auto-reply email",
  inboundAutoReply: "auto-replies to customer inbound texts",
};

/**
 * Truthy parsing is deliberately strict and default-deny: only an explicit affirmative
 * enables a send. A typo, an empty string, or an unset variable all mean OFF — the failure
 * mode of a misread flag must be "no text went out", never "a text went out".
 */
function isOn(raw: string | undefined): boolean {
  if (!raw) return false;
  return ["on", "true", "1", "yes", "enabled"].includes(raw.trim().toLowerCase());
}

/** True when this workflow is permitted to send to customers right now. */
export function customerSendsEnabled(workflow: CustomerSendWorkflow): boolean {
  if (isOn(process.env[WORKFLOW_ENV[workflow]])) return true;
  return isOn(process.env[MASTER_ENV]);
}

/**
 * Log a skip in a way that proves the gate fired rather than the code silently doing nothing.
 * "Never fabricate success" cuts both ways: a suppressed send has to be as visible as a sent
 * one, or "disabled" is indistinguishable from "broken".
 */
export function logCustomerSendSkipped(workflow: CustomerSendWorkflow, detail?: string): void {
  // eslint-disable-next-line no-console
  console.log(
    `[AutomationGate] SKIPPED ${workflow} — ${WORKFLOW_LABEL[workflow]} is DISABLED ` +
      `(manual-first ruling 2026-08-11). Re-enable with ${WORKFLOW_ENV[workflow]}=on ` +
      `or ${MASTER_ENV}=on.${detail ? ` ${detail}` : ""}`,
  );
}

/**
 * Boot-time state report. Printed on every start so the deployed log — not a code reading —
 * is the evidence of what is on and what is off. The prompt's verification bar is exactly
 * this: "'Disabled' is proven by the deployed boot log stating the disabled state."
 */
export function logAutomationGateState(): void {
  const masterOn = isOn(process.env[MASTER_ENV]);
  const workflows = Object.keys(WORKFLOW_ENV) as CustomerSendWorkflow[];

  // eslint-disable-next-line no-console
  console.log(
    `[AutomationGate] MASTER ${MASTER_ENV}=${process.env[MASTER_ENV] ?? "(unset)"} -> ` +
      `${masterOn ? "ENABLED" : "DISABLED (default)"} — manual-first ruling 2026-08-11`,
  );

  for (const w of workflows) {
    const override = process.env[WORKFLOW_ENV[w]];
    const on = customerSendsEnabled(w);
    // eslint-disable-next-line no-console
    console.log(
      `[AutomationGate]   ${on ? "ENABLED " : "DISABLED"} ${w} — ${WORKFLOW_LABEL[w]}` +
        (override ? ` (${WORKFLOW_ENV[w]}=${override})` : ""),
    );
  }

  // eslint-disable-next-line no-console
  console.log(
    "[AutomationGate] NOT gated (internal / operator / human-initiated, deliberately still running): " +
      "operator SMS to Kyle, crash alerting, technician notifications, supplier order emails, " +
      "daily summary email to SUMMARY_EMAIL, inbound receipt acknowledgements.",
  );
}

/** Exposed for the report and for tests — the env var that re-enables a given workflow. */
export function workflowEnvVar(workflow: CustomerSendWorkflow): string {
  return WORKFLOW_ENV[workflow];
}

export const MASTER_ENV_VAR = MASTER_ENV;
