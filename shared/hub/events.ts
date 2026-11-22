/**
 * The events the CRM sends the AI agents (work order agent-team, BA4/BA6/TC4), and where each goes.
 * ONE list, read by the server (the emitter, the Agent events screen filter, the route table) and the
 * CRM (the Event-type dropdown, the Agent webhooks card).
 *
 * Phase 1 types only. The payload of every one is the same closed shape (services/hubEvents.ts): an
 * event_id, the type, occurred_at with an offset, the record ids, and a templated non-personal
 * summary. Never a name, a link, a phone, an email, an address or any free text.
 */

export const HUB_EVENT_TYPES = [
  "message.inbound",
  "message.team",
  "message.dev",
  "approval.decided",
  "estimate.viewed",
  "estimate.signed",
  "estimate.accepted",
  "payment.received",
  "lead.created",
  "lead.web_chat",
  "job.completed",
  "material.used",
] as const;
export type HubEventType = (typeof HUB_EVENT_TYPES)[number];

export function isHubEventType(value: unknown): value is HubEventType {
  return typeof value === "string" && (HUB_EVENT_TYPES as readonly string[]).includes(value);
}

export const HUB_EVENT_LABELS: Record<HubEventType, string> = {
  "message.inbound": "A customer message came in",
  "message.team": "A team message was posted",
  "message.dev": "A dev-thread message was posted",
  "approval.decided": "A draft was approved, edited or rejected",
  "estimate.viewed": "A customer opened an estimate",
  "estimate.signed": "A customer signed an estimate",
  "estimate.accepted": "The office recorded an acceptance",
  "payment.received": "A payment was recorded",
  "lead.created": "A lead was entered",
  "lead.web_chat": "A website-chat lead arrived",
  "job.completed": "A job was marked complete",
  "material.used": "Material was used on a job",
};

/** The receiving agents an event can be sent to. `admin` is the default and the HUB_AGENT_WEBHOOK_URL fallback. */
export const HUB_WEBHOOK_TARGET_IDS = ["admin", "inventory"] as const;
export type HubWebhookTargetId = (typeof HUB_WEBHOOK_TARGET_IDS)[number];

export const HUB_WEBHOOK_TARGET_LABELS: Record<HubWebhookTargetId, string> = {
  admin: "Admin",
  inventory: "Inventory",
};

/** Who gets each event until Kyle changes the table: Admin, except material.used which is the Inventory agent's. */
export const DEFAULT_EVENT_ROUTES: Record<HubEventType, HubWebhookTargetId> = {
  "message.inbound": "admin",
  "message.team": "admin",
  "message.dev": "admin",
  "approval.decided": "admin",
  "estimate.viewed": "admin",
  "estimate.signed": "admin",
  "estimate.accepted": "admin",
  "payment.received": "admin",
  "lead.created": "admin",
  "lead.web_chat": "admin",
  "job.completed": "admin",
  "material.used": "inventory",
};

/** The delivery states a HubEvent row is in. */
export const HUB_EVENT_STATUSES = ["pending", "retrying", "delivered", "dead", "no_target"] as const;
export type HubEventStatus = (typeof HUB_EVENT_STATUSES)[number];

/** Seconds after the 1st..5th failed attempt to try again. A 6th failure is dead. */
export const HUB_EVENT_RETRY_SECONDS = [30, 120, 600, 3600, 21600] as const;
export const HUB_EVENT_MAX_ATTEMPTS = HUB_EVENT_RETRY_SECONDS.length + 1;

export const RESEND_DELIVERED_REASON = "Already delivered — the agents ignore a repeat of the same event";
