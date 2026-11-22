/**
 * The Kyle-only powers (work order agent-team, unit HA1). ONE list, shared by the server (the 403
 * sentence a gated route returns, middleware/kylePowers.ts) and the CRM (the checkboxes on Team ->
 * CRM login). A power is held by Kyle (the PIN session, or the CRM login marked as his own) and by
 * any CRM login Kyle has granted it to; the login's role (owner, admin, office, tech) is never
 * consulted for a power.
 *
 * `approve_drafts` is the ONE approver mechanism for everything the agents draft (work order,
 * "Overlap rulings"): Kyle only at launch, and others are added by Kyle later through this same
 * list - no second approver list.
 */

export const CRM_POWERS = {
  van_clearance: {
    label: "Clear a technician to run a van",
    reason: "Only Kyle can clear a technician to run a van. Kyle can turn this on for you under Team → CRM login.",
  },
  lle_verify: {
    label: "Verify a technician's license record",
    reason: "Only Kyle can verify a technician's license record. Kyle can turn this on for you under Team → CRM login.",
  },
  level_gates: {
    label: "Set training level gates",
    reason: "Only Kyle can set training level gates. Kyle can turn this on for you under Team → CRM login.",
  },
  training_publish: {
    label: "Publish training",
    reason: "Only Kyle can publish training. Kyle can turn this on for you under Team → CRM login.",
  },
  price_book_edit: {
    label: "Change price book prices, hours and names",
    reason: "Only Kyle can change price book prices, hours and names. Kyle can turn this on for you under Team → CRM login.",
  },
  treasury: {
    label: "Change Treasury settings and run the Sweep",
    reason: "Only Kyle can change Treasury settings or run the Sweep. Kyle can turn this on for you under Team → CRM login.",
  },
  bot_keys: {
    label: "Manage agent keys",
    reason: "Only Kyle can manage agent keys. Kyle can turn this on for you under Team → CRM login.",
  },
  approve_drafts: {
    label: "Approve what the agents draft",
    reason: "Only Kyle can approve what the agents draft. Kyle can turn this on for you under Team → CRM login.",
  },
} as const;

export type CrmPower = keyof typeof CRM_POWERS;

/**
 * Why a technician's access token and role are Kyle's alone (work order agent-team, U10): the token is the phone's
 * sign-in and, for a person whose login holds approve_drafts, the way to approve from the field. Printed on the
 * greyed Show token / Show QR / Rotate token / Role controls and returned (403) by the routes behind them.
 */
export const TECH_TOKEN_ROLE_REASON = "Only Kyle's PIN sign-in can change this.";

/** Every power key, in the order the CRM shows them. */
export const CRM_POWER_KEYS = Object.keys(CRM_POWERS) as CrmPower[];

export function isCrmPower(value: unknown): value is CrmPower {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(CRM_POWERS, value);
}

/**
 * The CRM access role a login carries. It decides which CRM screens a person may open; it never
 * grants a Kyle-only power. Owner, admin and office get today's full CRM minus the powers above;
 * tech has no CRM sign-in yet.
 */
export const CRM_ROLES = ["owner", "admin", "office", "tech"] as const;
export type CrmRole = (typeof CRM_ROLES)[number];

export function isCrmRole(value: unknown): value is CrmRole {
  return typeof value === "string" && (CRM_ROLES as readonly string[]).includes(value);
}
