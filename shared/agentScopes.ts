/**
 * The ONE agent scope list (work order agent-team, K-U1). The server stores a key's scopes as plain
 * strings (AgentKey.scopes) and validates them against this table; the Agent keys card (K-U2) shows
 * the labels and offers exactly these. A scope that is not here is not a scope.
 *
 * Where a scope came from: hub spec section 3.2 (hub:*, inventory:usage, campaign:draft,
 * media:marketing:read, training:write), the agent API prompt section 3 (the rest), the team's
 * answer 15a (media:original:read, media:edit:upload) and the dev loop (dev:read, dev:write,
 * design P3-U4). Which tools a scope opens, and which fields it returns, is decided by the tool
 * registry (K-U5), never here.
 */

export const AGENT_SCOPES = {
  // Hub (spec section 3.2)
  "hub:read": "Read Messages hub threads and messages",
  "hub:draft": "Draft customer messages for approval",
  "inventory:usage": "Draft stock movements, counts and reorder lists",
  "campaign:draft": "Draft email campaigns (never send)",
  "media:marketing:read": "Read cleared marketing photos",
  "training:write": "Draft training modules, lessons and quizzes",
  // Agent API prompt section 3
  "crm:read": "Read leads, accounts, jobs, calendar, estimates and invoices",
  "leads:write": "Create and update leads, mark contacted or lost",
  "leads:draft": "Draft inert leads for the office to accept",
  "leads:dupcheck": "Check whether a lead is a duplicate",
  "schedule:propose": "Propose visits and bookings for approval",
  "estimate:draft": "Create estimate drafts (never issue or send)",
  "estimate:propose_accept": "Propose recording a customer's acceptance",
  "notes:write": "Add notes to records",
  "team:reply": "Read and post in the Team and group chats; post in job crew chats (needs hub:read to read them)",
  "dev:ticket": "File and read dev tickets",
  "inventory:read": "Read price book, stock, purchase orders and receipts",
  "pricebook:propose": "Propose price book additions for approval",
  "outreach:read": "Read finished jobs and consent state for outreach",
  "reviews:confirm": "Mark a review as confirmed",
  "reports:read": "Read de-identified reports",
  "marketing:read": "Read marketing job facts",
  "training:read": "Read apprentice levels and milestones",
  // Team answer 15a
  "media:original:read": "Read stripped originals of finished-job photos",
  "media:edit:upload": "Upload an edited marketing copy of a photo",
  // Dev loop (design P3-U4)
  "dev:read": "Read dev threads and tickets",
  "dev:write": "Post replies and set Claude's statuses on dev tickets",
} as const;

export type AgentScope = keyof typeof AGENT_SCOPES;

export const AGENT_SCOPE_KEYS = Object.keys(AGENT_SCOPES) as AgentScope[];

export function isAgentScope(value: string): value is AgentScope {
  return Object.prototype.hasOwnProperty.call(AGENT_SCOPES, value);
}

export const AGENT_ROLES = [
  "admin", "inventory", "outreach", "research", "facebook", "scout", "nec_coach", "claude_code", "other",
] as const;

export type AgentRole = (typeof AGENT_ROLES)[number];

export function isAgentRole(value: string): value is AgentRole {
  return (AGENT_ROLES as readonly string[]).includes(value);
}

/** What a new key of this role is ticked with; Kyle may change any of it. */
export const DEFAULT_SCOPES_BY_ROLE: Record<AgentRole, readonly AgentScope[]> = {
  admin: [
    "crm:read", "hub:read", "inventory:read", "leads:write", "notes:write", "estimate:draft",
    "schedule:propose", "estimate:propose_accept", "hub:draft", "team:reply", "dev:ticket",
  ],
  inventory: ["inventory:read", "hub:read", "inventory:usage", "pricebook:propose"],
  outreach: ["outreach:read", "hub:draft", "leads:draft", "reviews:confirm"],
  research: ["reports:read"],
  // Team answer 15a: the Facebook agent reads originals and uploads a separate edited copy.
  facebook: ["marketing:read", "media:marketing:read", "media:original:read", "campaign:draft", "media:edit:upload"],
  // Team answer 16a: Scout reaches hub threads, but only training ones (hubThreadKinds below).
  scout: [
    "marketing:read", "media:marketing:read", "leads:dupcheck", "leads:draft", "training:read",
    "training:write", "hub:read", "hub:draft",
  ],
  nec_coach: ["hub:read"],
  // Work order default D29: Claude Code's own revocable key, dev threads only.
  claude_code: ["dev:read", "dev:write"],
  other: [],
};

/** Hub thread kinds a new key of this role is limited to. Empty means no limit (team answer 16a). */
export const DEFAULT_HUB_THREAD_KINDS_BY_ROLE: Record<AgentRole, readonly string[]> = {
  admin: [],
  inventory: [],
  outreach: [],
  research: [],
  facebook: [],
  scout: ["training"],
  nec_coach: [],
  claude_code: ["dev"],
  other: [],
};

/** The reason the Agent keys card gives an AI admin session (and its routes answer it): the card shows, every control is greyed. */
export const AGENT_KEYS_AI_ADMIN_REASON = "Only Kyle can view or change agent keys.";

/** The kinds of hub thread (work order, U1). A key's hubThreadKinds limits it to some of them; empty means no limit. */
export const HUB_THREAD_KINDS = {
  customer: "Customer",
  job: "Job",
  team: "Team",
  dev: "Dev",
  training: "Training",
  /** An office-made group chat (work order agent-team, C7): an agent key sees one only when it is a member (hub.ts visibleThreadWhere). */
  group: "Group",
} as const;
export type HubThreadKind = keyof typeof HUB_THREAD_KINDS;
export const HUB_THREAD_KIND_KEYS = Object.keys(HUB_THREAD_KINDS) as HubThreadKind[];
export const isHubThreadKind = (v: string): v is HubThreadKind => Object.prototype.hasOwnProperty.call(HUB_THREAD_KINDS, v);

/**
 * Which scope opens which kind of hub thread to an AGENT key (work order agent-team, C6; one small table so a
 * new kind, such as C7's `group`, is one line). A key needs ONE of the scopes listed: `read` to see the thread
 * and its messages, `post` to leave a draft in it. An empty `post` list means a key can never post there
 * through the hub door (a Dev thread is written through the dev door). A key's hubThreadKinds still narrows on
 * top of this: the kinds a key may use are the ones its scopes open AND its hubThreadKinds allow.
 */
export const HUB_KIND_SCOPES: Record<HubThreadKind, { read: readonly AgentScope[]; post: readonly AgentScope[] }> = {
  customer: { read: ["hub:read"], post: ["hub:draft"] },
  // W1b: a job thread is the CREW chat. For an agent a post there is an in-app crew post (the same scope as a Team post,
  // team:reply), never a draft to the homeowner: a customer message goes in the customer's own conversation (customer or job link).
  job: { read: ["hub:read"], post: ["team:reply"] },
  team: { read: ["team:reply"], post: ["team:reply"] },
  dev: { read: ["dev:read"], post: [] },
  training: { read: ["training:read", "training:write"], post: ["training:write"] },
  // C7: the same scope as a Team post. The scope is only half the rule: the key must also be a MEMBER of the group
  // (visibleThreadWhere for the hub, hubDoor.threadFor for the door), and a group the key is not in answers as not found.
  group: { read: ["team:reply"], post: ["team:reply"] },
};

export type HubKindAccess = "read" | "post" | "any";

/**
 * The thread kinds these scopes open, narrowed by the key's hubThreadKinds (`limit`, empty = no limit).
 * `any` is read-or-post: what a key may SEE at all (the hub's visibility rule); `read` and `post` are what
 * the door checks for a list/detail and for a draft.
 */
export function hubKindsFor(scopes: readonly string[], access: HubKindAccess, limit: readonly string[] = []): HubThreadKind[] {
  return HUB_THREAD_KIND_KEYS.filter((kind) => {
    if (limit.length > 0 && !limit.includes(kind)) return false;
    const wanted = access === "any" ? [...HUB_KIND_SCOPES[kind].read, ...HUB_KIND_SCOPES[kind].post] : HUB_KIND_SCOPES[kind][access];
    return wanted.some((s) => scopes.includes(s));
  });
}

export const AGENT_ROLE_LABELS: Record<AgentRole, string> = {
  admin: "Admin",
  inventory: "Inventory Manager",
  outreach: "Outreach",
  research: "Research",
  facebook: "Facebook",
  scout: "Scout",
  nec_coach: "NEC Coach",
  claude_code: "Claude Code (dev threads only)",
  other: "Other (no scopes ticked)",
};

/** How the card groups the scope checkboxes. Every scope must be in exactly one group (the type enforces it). */
export type AgentScopeGroup = "read" | "draft" | "write";
export const AGENT_SCOPE_GROUP: Record<AgentScope, AgentScopeGroup> = {
  "crm:read": "read", "hub:read": "read", "inventory:read": "read", "outreach:read": "read", "reports:read": "read",
  "marketing:read": "read", "training:read": "read", "media:marketing:read": "read", "media:original:read": "read",
  "dev:read": "read", "leads:dupcheck": "read",
  "hub:draft": "draft", "campaign:draft": "draft", "leads:draft": "draft", "estimate:draft": "draft",
  "schedule:propose": "draft", "estimate:propose_accept": "draft", "pricebook:propose": "draft", "inventory:usage": "draft",
  "leads:write": "write", "notes:write": "write", "team:reply": "write", "dev:ticket": "write", "dev:write": "write",
  "reviews:confirm": "write", "training:write": "write", "media:edit:upload": "write",
};
