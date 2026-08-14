/**
 * Automation gates — the manual-first switches.
 *
 * TWO CLASSES LIVE HERE:
 *
 *   1. AUTOMATED_CUSTOMER_SENDS (P004, ruling 2026-08-11) — unattended sends to customers,
 *      email and SMS alike.
 *   2. TWILIO_SENDS (P013, clarification 2026-08-13) — every outbound Twilio text, whoever
 *      the recipient is. See the second half of this file.
 *
 * They are independent and both must pass for a customer-facing text to leave the app: an
 * automation flag coming back on must not drag Twilio back with it.
 *
 * ── CLASS 1 ────────────────────────────────────────────────────────────────────────────
 *
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

  logTwilioGateState();

  // eslint-disable-next-line no-console
  console.log(
    "[AutomationGate] NOT gated (deliberately still running): all EMAIL — supplier order emails, " +
      "daily summary email to SUMMARY_EMAIL, branded customer confirmation/reminder emails, " +
      "technician assignment emails, Kyle notification emails; and INBOUND Twilio webhooks " +
      "(receiving is not sending — gating inbound is a separate decision nobody has made).",
  );
}

/** Exposed for the report and for tests — the env var that re-enables a given workflow. */
export function workflowEnvVar(workflow: CustomerSendWorkflow): string {
  return WORKFLOW_ENV[workflow];
}

export const MASTER_ENV_VAR = MASTER_ENV;

/* ── CLASS 2 ──────────────────────────────────────────────────────────────────────────────
 *
 * Outbound Twilio gate — "no Twilio texts, period."
 *
 * Kyle, 2026-08-13 (decisions/2026-08-11-manual-first-automation-deferral.md § CLARIFICATION):
 *
 *   "I am not using twilio for texts, intake from Savannah AI Receptionist is a Vapi number and
 *    we will rely only on the emails that are already set up. I do not want to spend time setting
 *    up the twilio campaigns right now. I will make that specific request when I feel the system
 *    is ready for it."
 *
 * P004 gated the customer-facing sends and deliberately left the operator, technician and agent
 * legs running; the P004 review escalated that as a discrepancy with the ruling, and this is the
 * answer: silence outbound Twilio entirely. Email and Kyle's own phone calls are the operational
 * channels.
 *
 * SAME SHAPE AS CLASS 1, ON PURPOSE: callers gated, channel untouched. `sendSms()` still works;
 * nothing about twilio.ts, the A2P registration, or the phone numbers changes. Every leg turns
 * back on with one env var on the day Kyle makes "that specific request."
 *
 * INBOUND IS NOT GATED. Receiving a text is not sending one. The webhook at routes/inboundSms.ts
 * still parses, logs and routes everything that arrives; only its *replies* are gated. Gating
 * inbound is a separate decision nobody has made.
 *
 * WHY PER-LEG AND NOT ONE FLAG:
 *
 *   The ruling names one reactivation event, so four of these six legs will in fact come back
 *   together. They are still separate flags because the other two have their own, already-written
 *   return paths — operator alerting is rollup row 0.1, PARKED with its own prompt, and the
 *   receipt-MMS leg is recorded as folding into the payments/job-costing build, which may not
 *   land on Twilio at all. A single flag would force those two back on with the rest. The cost of
 *   the extra flags is a longer boot log; the cost of one flag is a leg returning before anyone
 *   decided it should.
 */

export type TwilioSendLeg =
  /** Crash / health-check alert texts to the operator number (services/alerting.ts). */
  | "operatorAlerts"
  /** Kyle's own business notifications: new lead, doc signed, bookings, digests, forwards. */
  | "operatorNotifications"
  /** Assignment and job-note texts to technicians. */
  | "technicianSends"
  /** Acknowledgement replies to an inbound MMS receipt from Kyle or a tech. */
  | "inboundAcks"
  /** Texts triggered by a Savannah/Jerry agent tool call. */
  | "agentSends"
  /**
   * Customer job-lifecycle texts — scheduled / rescheduled / cancelled, calendar-booking
   * confirmations, reminders, opt-in and inbound auto-replies. Several of these are ALSO behind
   * class 1; both gates must pass. The class-1 inventory in P004 missed the scheduling.ts and
   * googleCalendar.ts sites entirely — see the P013 report.
   */
  | "customerLifecycleSms";

const TWILIO_MASTER_ENV = "TWILIO_SENDS";

const TWILIO_LEG_ENV: Record<TwilioSendLeg, string> = {
  operatorAlerts: "TWILIO_SENDS_OPERATOR_ALERTS",
  operatorNotifications: "TWILIO_SENDS_OPERATOR_NOTIFICATIONS",
  technicianSends: "TWILIO_SENDS_TECHNICIAN",
  inboundAcks: "TWILIO_SENDS_INBOUND_ACKS",
  agentSends: "TWILIO_SENDS_AGENT",
  customerLifecycleSms: "TWILIO_SENDS_CUSTOMER_LIFECYCLE",
};

const TWILIO_LEG_LABEL: Record<TwilioSendLeg, string> = {
  operatorAlerts: "crash/health alert SMS to the operator number",
  operatorNotifications: "Kyle's notification texts (new lead, signed doc, bookings, digests, forwards)",
  technicianSends: "technician assignment + job-note texts",
  inboundAcks: "receipt acknowledgement replies to Kyle/tech MMS",
  agentSends: "Savannah/Jerry agent-triggered texts",
  customerLifecycleSms: "customer job-lifecycle texts (scheduled/rescheduled/cancelled, reminders, auto-replies)",
};

/** True when this Twilio leg is permitted to send a text right now. Default-deny. */
export function twilioSendEnabled(leg: TwilioSendLeg): boolean {
  if (isOn(process.env[TWILIO_LEG_ENV[leg]])) return true;
  return isOn(process.env[TWILIO_MASTER_ENV]);
}

/**
 * Log a suppressed text. Same reasoning as logCustomerSendSkipped: a send that did not happen
 * has to be as visible as one that did, or "disabled" reads identically to "broken".
 */
export function logTwilioSendSkipped(leg: TwilioSendLeg, detail?: string): void {
  // eslint-disable-next-line no-console
  console.log(
    `[TwilioGate] SKIPPED ${leg} — ${TWILIO_LEG_LABEL[leg]} is DISABLED ` +
      `(no-Twilio-texts ruling 2026-08-13). Re-enable with ${TWILIO_LEG_ENV[leg]}=on ` +
      `or ${TWILIO_MASTER_ENV}=on.${detail ? ` ${detail}` : ""}`,
  );
}

/** Boot-time state report for the Twilio class. Called from logAutomationGateState(). */
export function logTwilioGateState(): void {
  const masterOn = isOn(process.env[TWILIO_MASTER_ENV]);
  const legs = Object.keys(TWILIO_LEG_ENV) as TwilioSendLeg[];

  // eslint-disable-next-line no-console
  console.log(
    `[TwilioGate] MASTER ${TWILIO_MASTER_ENV}=${process.env[TWILIO_MASTER_ENV] ?? "(unset)"} -> ` +
      `${masterOn ? "ENABLED" : "DISABLED (default)"} — no-Twilio-texts ruling 2026-08-13`,
  );

  for (const leg of legs) {
    const override = process.env[TWILIO_LEG_ENV[leg]];
    const on = twilioSendEnabled(leg);
    // eslint-disable-next-line no-console
    console.log(
      `[TwilioGate]   ${on ? "ENABLED " : "DISABLED"} ${leg} — ${TWILIO_LEG_LABEL[leg]}` +
        (override ? ` (${TWILIO_LEG_ENV[leg]}=${override})` : ""),
    );
  }

  // eslint-disable-next-line no-console
  console.log(
    "[TwilioGate] INBOUND Twilio (webhook receive, media fetch, opt-out recording) is NOT gated — " +
      "receiving is not sending. Alerting after this gate: Railway's own email notifications plus " +
      "the scheduled email read (ruling 2026-08-11 §3), and every alert is still persisted as a " +
      "SystemEvent row and printed to the Railway log.",
  );
}

/** Exposed for the report and for tests — the env var that re-enables a given Twilio leg. */
export function twilioLegEnvVar(leg: TwilioSendLeg): string {
  return TWILIO_LEG_ENV[leg];
}

export const TWILIO_MASTER_ENV_VAR = TWILIO_MASTER_ENV;
