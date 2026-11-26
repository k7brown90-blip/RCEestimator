/**
 * The events the CRM sends the AI agents (work order agent-team, BA4/BA6/TC4), and where each goes.
 * ONE list, read by the server (the emitter, the Agent events screen filter, the route table) and the
 * CRM (the Event-type dropdown, the Agent webhooks card).
 *
 * The payload of every type is a closed shape (services/hubEvents.ts): an event_id, the type, occurred_at with an offset, the record
 * ids, and a templated non-personal summary. Never a name, a link, a phone, an email, an address or any free text - EXCEPT
 * message.team (W2, Kyle 2026-11-23 items 4 and 5, supersedes the ids-only rule for that one type): it also carries the author's first
 * name, the message text (through the one scrub: phones, emails and street addresses are withheld) and the @mentions.
 * pricebook.item_created and pricebook.change_proposed (Kyle 2026-11-24) also carry the price-book item's own name, category, unit (Kyle 2026-11-25), cost (PRE-TAX) and sell prices, and a proposal's before/after:
 * the price book holds no customer data.
 *
 * THE WIRE BODY (W2, Kyle 2026-11-23: "put the signature AND timestamp in both the headers and inside the JSON body"). Every event
 * type, test.ping included, is POSTed as the stored payload JSON with two members appended as its LAST two:
 * ,"timestamp":"<unix seconds>","signature":"sha256=<hex>" . The signature is HMAC-SHA256(secret, "<timestamp>.<payload JSON>") where
 * the payload JSON is the body WITHOUT those two members. See WEBHOOK_VERIFY_RECIPE below, which the Agent webhooks card prints.
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
  "pricebook.item_created",
  "pricebook.change_proposed",
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
  "pricebook.item_created": "An agent added an item to the price book",
  "pricebook.change_proposed": "An agent proposed a price book change",
};

/**
 * The receiving agents an event can be sent to. A target id IS an agent role string (shared/agentScopes.ts AGENT_ROLES), so the
 * fan-out maps a key's role straight to its target. `admin` is the default for the routed types and the HUB_AGENT_WEBHOOK_URL /
 * HUB_WEBHOOK_SECRET fallback. W2 (Kyle 2026-11-23, item 4): every agent that can hear a Team chat has a receiver; claude_code is
 * NOT one (Coding is woken by the GitHub dispatch, W2-E) and neither is `other`. EXTEND this list, never rename or remove an id:
 * the stored `agentWebhooks` setting is parsed against it, and a failed parse silently reads as the default (every address gone).
 */
export const HUB_WEBHOOK_TARGET_IDS = ["admin", "inventory", "facebook", "outreach", "scout", "research", "cfo", "nec_coach"] as const;
export type HubWebhookTargetId = (typeof HUB_WEBHOOK_TARGET_IDS)[number];

export const HUB_WEBHOOK_TARGET_LABELS: Record<HubWebhookTargetId, string> = {
  admin: "Admin",
  inventory: "Inventory",
  facebook: "Facebook",
  outreach: "Outreach",
  scout: "Scout",
  research: "Research",
  cfo: "CFO",
  nec_coach: "NEC Coach",
};

/**
 * Event types whose receivers are decided by the FAN-OUT, not by a route (W2, Kyle 2026-11-23 item 4): every agent whose key can read
 * the thread gets one, so there is nothing to point. They are left out of the "Which agent gets which event" table, and a stored
 * routes[type] for one of them is ignored (and dropped the next time the setting is saved).
 * pricebook.item_created and pricebook.change_proposed (Kyle 2026-11-24) are fan-out too: every live key with pricebook:read hears them except the key that did it.
 */
export const FAN_OUT_EVENT_TYPES: readonly HubEventType[] = ["message.team", "pricebook.item_created", "pricebook.change_proposed"];
export const isFanOutEventType = (type: string): boolean => (FAN_OUT_EVENT_TYPES as readonly string[]).includes(type);

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
  // Fan-out types (isFanOutEventType): every other live agent key that can read the price book hears them (services/hubEvents.ts); the route is never read.
  "pricebook.item_created": "admin",
  "pricebook.change_proposed": "admin",
};

/** The delivery states a HubEvent row is in. */
export const HUB_EVENT_STATUSES = ["pending", "retrying", "delivered", "dead", "no_target"] as const;
export type HubEventStatus = (typeof HUB_EVENT_STATUSES)[number];

/** Seconds after the 1st..5th failed attempt to try again. A 6th failure is dead. */
export const HUB_EVENT_RETRY_SECONDS = [30, 120, 600, 3600, 21600] as const;
export const HUB_EVENT_MAX_ATTEMPTS = HUB_EVENT_RETRY_SECONDS.length + 1;

export const RESEND_DELIVERED_REASON = "Already delivered — the agents ignore a repeat of the same event";

/**
 * The type of the test event "Send test event" delivers (work order C6b). It is NOT one of
 * HUB_EVENT_TYPES: it is never routed, never in the Agent webhooks table, never emitted by a code site
 * and never retried. Its payload is exactly event_id, type, occurred_at and target.
 */
export const HUB_TEST_EVENT_TYPE = "test.ping";
export const TEST_RESEND_REASON = "A test event is never sent again — press Send test event for a new one.";

export function isHubWebhookTargetId(value: unknown): value is HubWebhookTargetId {
  return typeof value === "string" && (HUB_WEBHOOK_TARGET_IDS as readonly string[]).includes(value);
}

/** The receiver's recipe, as the Agent webhooks card prints it (one wording, tested against a real receiver in tests/hubEvents.test.ts). */
export const WEBHOOK_VERIFY_RECIPE =
  "To check an event: take the raw request body and cut it at the LAST occurrence of ,\"timestamp\": then add } on the end - that text is the payload. "
  + "The signature is sha256= plus the hex HMAC-SHA256, keyed with this agent's signing secret, over <timestamp>.<payload>. "
  + "The timestamp and signature are also in the X-RCE-Timestamp and X-RCE-Signature headers when your platform shows headers. "
  + "Reject a timestamp more than 5 minutes old. The body is never re-serialised: use the raw text, not parsed JSON.";

/**
 * The wire body for one attempt: the stored payload JSON (a JSON object, always) with the timestamp and signature spliced in before
 * its closing brace. A string splice, never a re-serialise, so the signed text is exactly the stored text. Used by the sender; the
 * mirror image is splitWireBody.
 */
export function wireBodyFor(payloadJson: string, timestamp: string, signature: string): string {
  const end = payloadJson.lastIndexOf("}");
  if (end < 0) throw new Error("A payload is a JSON object");
  return `${payloadJson.slice(0, end)},"timestamp":"${timestamp}","signature":"${signature}"}`;
}

/** The receiver's side of the recipe: a wire body back to { payloadJson, timestamp, signature }, or null when it does not carry them. */
export function splitWireBody(wire: string): { payloadJson: string; timestamp: string; signature: string } | null {
  const at = wire.lastIndexOf(',"timestamp":');
  if (at < 0) return null;
  const tail = /^,"timestamp":"(\d+)","signature":"(sha256=[0-9a-f]+)"\}$/.exec(wire.slice(at));
  if (!tail) return null;
  return { payloadJson: `${wire.slice(0, at)}}`, timestamp: tail[1], signature: tail[2] };
}
