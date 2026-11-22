/**
 * The Messages hub's shared vocabulary (work order agent-team, U1): the lists the server validates
 * against and the screens show. ONE definition, so a status or an author type cannot be spelled two
 * ways. Thread kinds live in shared/agentScopes.ts (HUB_THREAD_KINDS), because an agent key's
 * `hubThreadKinds` limit is made from them.
 */

/** open: live. snoozed: parked by the office. closed: done (Reopen brings it back). */
export const HUB_THREAD_STATUSES = ["open", "snoozed", "closed"] as const;
export type HubThreadStatus = (typeof HUB_THREAD_STATUSES)[number];

export const HUB_AUTHOR_TYPES = ["customer", "tech", "office", "ai_agent", "claude", "system"] as const;
export type HubAuthorType = (typeof HUB_AUTHOR_TYPES)[number];

export const HUB_CHANNELS = ["in_app", "email", "sms", "web_chat", "system"] as const;
export type HubChannel = (typeof HUB_CHANNELS)[number];

export const HUB_DIRECTIONS = ["inbound", "outbound", "internal"] as const;
export type HubDirection = (typeof HUB_DIRECTIONS)[number];

/**
 * Every status a hub message can be in. 'blocked' is a text the CRM refused to send (HubMessage.error
 * says why: opted_out, quiet_hours, ...). 'approving' is the instant between a person pressing
 * Approve and the send finishing, so two approvers cannot both run it. 'superseded' is a draft a
 * newer fact made moot. 'edited' is the draft a person edited before approving (the edited copy
 * points back at it).
 */
export const HUB_MESSAGE_STATUSES = [
  "draft", "pending_approval", "approving", "approved", "sent", "failed", "received", "posted",
  "edited", "rejected", "superseded", "blocked",
] as const;
export type HubMessageStatus = (typeof HUB_MESSAGE_STATUSES)[number];

/** The statuses that count as "a message somebody can read now" for unread counts and the thread preview. */
export const HUB_READABLE_STATUSES: readonly HubMessageStatus[] = ["received", "posted", "sent"];
