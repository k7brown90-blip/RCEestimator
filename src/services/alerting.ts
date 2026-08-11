/**
 * Operator alerting — the tripwire that turns a production failure into an SMS
 * on Kyle's phone before it becomes an email nobody opens.
 *
 * Reuses the Twilio path already carrying `text_kyle_question` so there is one
 * outbound channel, one credential set, one place to fix.
 *
 * Dedup is in-memory only. Bursts of the same failure inside 15 minutes collapse
 * to one send. A process restart resets the window — acceptable because a Railway
 * restart is usually the crash itself, and the first alert of the next lifetime
 * is exactly what we want.
 */

import { sendSms, KYLE_PHONE } from "./twilio";
import { logSystemEvent } from "./systemEvents";

export type AlertSeverity = "critical" | "warning";

export interface AlertEvent {
  severity: AlertSeverity;
  eventType: string;
  service: string;
  reason?: string;
  /** Overrides the default (eventType) so per-instance events can dedup independently. */
  dedupeKey?: string;
}

export interface AlertResult {
  delivered: boolean;
  /** Twilio's initial status — "queued" or "accepted". Terminal "delivered" arrives via status callback. */
  twilioStatus?: string;
  sid?: string;
  reason?: string;
  deduplicated?: boolean;
}

const DEDUP_TTL_MS = 15 * 60 * 1000;
const recent = new Map<string, number>();

/** Test-only reset — never called from production code. */
export function _resetDedupForTests(): void {
  recent.clear();
}

function operatorNumber(): string {
  return process.env.OPERATOR_ALERT_NUMBER ?? KYLE_PHONE;
}

function statusCallbackUrl(): string | undefined {
  const domain = process.env.RAILWAY_PUBLIC_DOMAIN;
  const token = process.env.INTERNAL_WEBHOOK_TOKEN;
  if (!domain || !token) return undefined;
  return `https://${domain}/internal/webhooks/twilio-status/${token}`;
}

function timestampCdt(): string {
  const s = new Date().toLocaleString("en-US", {
    timeZone: "America/Chicago",
    hour12: false,
  });
  return `${s} CDT`;
}

function formatBody(event: AlertEvent): string {
  const lines = [
    `[RCE ${event.severity.toUpperCase()}] ${event.eventType}`,
    `svc: ${event.service}`,
    `at:  ${timestampCdt()}`,
  ];
  if (event.reason) lines.push(`why: ${event.reason.slice(0, 240)}`);
  return lines.join("\n");
}

export async function sendAlert(event: AlertEvent): Promise<AlertResult> {
  const key = event.dedupeKey ?? event.eventType;
  const now = Date.now();
  const last = recent.get(key);
  if (last !== undefined && now - last < DEDUP_TTL_MS) {
    logSystemEvent("info", "alerting", `deduped ${key}`, { event, sinceMs: now - last });
    return { delivered: false, deduplicated: true, reason: "dedup-window" };
  }
  recent.set(key, now);
  if (recent.size > 1000) {
    for (const [k, t] of recent) if (now - t > DEDUP_TTL_MS) recent.delete(k);
  }

  const body = formatBody(event);
  const result = await sendSms(operatorNumber(), body, {
    bypassConsentCheck: true,
    statusCallback: statusCallbackUrl(),
  });
  if (!result) {
    logSystemEvent("warn", "alerting", `Twilio unavailable — no SMS sent`, { event });
    return { delivered: false, reason: "twilio-unconfigured" };
  }

  logSystemEvent("info", "alerting", `alert queued: ${event.eventType}`, {
    sid: result.sid,
    initialStatus: result.status ?? "unknown",
    event,
  });
  return { delivered: true, twilioStatus: result.status ?? "queued", sid: result.sid };
}
