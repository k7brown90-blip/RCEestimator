/**
 * What the Messages hub's CRM routes send the CRM screens (work order agent-team, U2 and U3). ONE
 * definition read by the server (services/hubTimeline.ts, services/hubInbox.ts) and the client
 * (RecordConversation, the Messages page, the Thread drawer), so the two cannot drift.
 *
 * Nothing here ever carries a technician's access token, a key, a hash or a file's bytes: authors are
 * names only, and a deleted message carries no text at all (the text stays in the audit).
 */
import type { HubMessageStatus } from "./model";

// ── the record conversation (U2) ─────────────────────────────────────────────────────────────────

/** A call note, in the exact shape the notes routes (POST/PATCH /accounts/:id/notes) return. */
export interface TimelineNote {
  id: string;
  customerId: string;
  visitId: string | null;
  body: string;
  takenBy: string;
  createdAt: string;
  updatedAt: string;
  visit: {
    id: string;
    jobType: string | null;
    purpose: string | null;
    visitDate: string;
    property: { addressLine1: string } | null;
  } | null;
}

/** What the mail provider reported for one email (EmailDelivery). */
export interface TimelineEmail {
  id: string;
  provider: "resend" | "gmail";
  status: "sent" | "delivered" | "delayed" | "bounced" | "complained" | "failed";
  statusAt: string | null;
  to: string;
  cc: string[];
  subject: string;
  kind: string;
  estimateNumber: string | null;
  error: string | null;
  createdAt: string;
}

export interface TimelineMessage {
  id: string;
  threadId: string;
  authorType: string;
  authorDisplay: string;
  channel: string;
  direction: string;
  status: HubMessageStatus;
  subject: string | null;
  /** Null once the message was deleted: the text stays in the audit, not on the screen. */
  body: string | null;
  toAddress: string | null;
  /**
   * Who a text went (or would have gone) to, masked for the screen: "(615) ***-0101", or "Kyle" for Kyle's own
   * number. Never the full number. Null for anything that is not a text.
   */
  toMasked: string | null;
  /** transactional, marketing or internal: an internal text went to Kyle, the operator number or a technician, never a customer. */
  messageClass: string | null;
  error: string | null;
  deleted: boolean;
  deletedBy: string | null;
  deletedReason: string | null;
  editedAt: string | null;
  createdAt: string;
  sentAt: string | null;
  /** The delivery report of the email this message sent, when it was an email. */
  emailDelivery: TimelineEmail | null;
}

interface EntryBase {
  /** When it happened: what the list is sorted by, newest first. */
  at: string;
  /** The job it is tagged to, if any (a note's tag, an email's job, a message's job). */
  visitId: string | null;
  /** "Panel upgrade — 12 Main St", or null when it is not about one job. */
  jobLabel: string | null;
}

export type TimelineEntry =
  | (EntryBase & { type: "note"; id: string; note: TimelineNote })
  | (EntryBase & { type: "email"; id: string; email: TimelineEmail })
  | (EntryBase & { type: "message"; id: string; message: TimelineMessage })
  | (EntryBase & { type: "web_chat"; id: string; leadId: string; count: number; status: string });

export interface TimelineResponse {
  scope: {
    customerId: string | null;
    leadId: string | null;
    visitId: string | null;
    propertyId: string | null;
    /** The account's name, or the lead's when it has no account yet. */
    name: string | null;
  };
  /** The Property page's section: every entry is read-only there. */
  readOnly: boolean;
  entries: TimelineEntry[];
  /** True when a source had more rows than the cap, so the oldest are not all shown. */
  truncated: boolean;
  /** The job's own crew thread, once one exists (visitId requests only). */
  crewThread: { id: string; unread: number } | null;
}

// ── the Messages page and the Thread drawer (U3) ─────────────────────────────────────────────────

export interface ThreadLastLine {
  authorType: string;
  authorDisplay: string;
  status: HubMessageStatus;
  /** First 140 characters of the text. */
  text: string;
  at: string;
}

export interface ThreadRow {
  id: string;
  kind: string;
  title: string;
  status: string;
  lastMessageAt: string;
  unread: number;
  /** Messages in this thread waiting for someone to approve them. */
  pending: number;
  /** True when the newest message came from an AI author. */
  aiLast: boolean;
  lastLine: ThreadLastLine | null;
  customerId: string | null;
  leadId: string | null;
  visitId: string | null;
  technicianId: string | null;
}

export interface ThreadsResponse {
  threads: ThreadRow[];
  /** Every message waiting for approval this reader can see, whatever the other filters say. */
  needsApproval: number;
  /** True when this session may approve them (the approve_drafts power). */
  canApprove: boolean;
}

export interface ThreadMessage {
  id: string;
  authorType: string;
  authorDisplay: string;
  channel: string;
  direction: string;
  status: HubMessageStatus;
  subject: string | null;
  body: string | null;
  toAddress: string | null;
  /** Who a text went to, masked ("(615) ***-0101", or "Kyle"); never the full number. Null for anything that is not a text. */
  toMasked: string | null;
  /** transactional, marketing or internal; an internal text never went to a customer. */
  messageClass: string | null;
  error: string | null;
  deleted: boolean;
  deletedBy: string | null;
  deletedReason: string | null;
  editedAt: string | null;
  createdAt: string;
  /** Posted by the signed-in reader. */
  mine: boolean;
  /** An own message posted in the app and not deleted. */
  canEdit: boolean;
  /** An own message, or any message when the reader is Kyle; not already deleted. */
  canDelete: boolean;
  /** Photos held on this message (a Team, Training or group thread's photo). Authenticated fetch by id; never a URL with a token. */
  attachments: AttachmentRef[];
  /** Job photos on this message: VisitPhoto ids already filed on the thread's job (a job thread only). */
  photoIds: string[];
}

/** One photo held on a message (HubAttachment). The bytes are fetched with the reader's own credentials. */
export interface AttachmentRef {
  id: string;
  mimeType: string;
}

/** One member of an office-made group chat (work order agent-team, C7). */
export interface GroupMemberView {
  kind: "person" | "agent";
  /** Technician.id for a person, AgentKey.id for an agent. */
  id: string;
  name: string;
  /** An agent's role as the Agent keys card names it ("Admin", "Inventory Manager"); null for a person. */
  roleLabel: string | null;
  addedAt: string;
  /** This member is the signed-in reader. */
  you: boolean;
  /** False for a person who left the team or an agent key that is switched off or cannot reach groups: they stay listed so the office can remove them. */
  active: boolean;
  /** Why this member is not active (an agent: switched off, or its key cannot see a group), or null. The panel shows it beside the name. */
  reason: string | null;
}

/** What the Thread drawer shows of a group: who is in it, and the state of "Delete group". */
export interface GroupView {
  members: GroupMemberView[];
  /** Every message row ever made in the group, deleted ones included (history). */
  messageCount: number;
  /** The signed-in reader is a member (a member's messages count as unread, and only a member may post). */
  youAreMember: boolean;
  /** "Delete group" is live only while the group holds no message. */
  canDelete: boolean;
  /** Why "Delete group" is greyed, or null when it is live. */
  deleteReason: string | null;
}

/** Who can be put in a group chat: the New group chat picker. Never a customer. */
export interface GroupChoices {
  people: Array<{ id: string; name: string }>;
  /** `canJoin` false = the key could never see or post in a group (no team:reply, or its kinds leave out group): greyed, with `reason`. */
  agents: Array<{ id: string; name: string; roleLabel: string; canJoin: boolean; reason: string | null }>;
}

export interface ThreadDetail {
  thread: ThreadRow;
  messages: ThreadMessage[];
  /** When this reader last opened the thread (before this read): messages after it are new. */
  lastReadAt: string | null;
  /** More messages exist than the page holds (the oldest are not shown). */
  truncated: boolean;
  /** Why this reader may not post here (another person's Team thread), or null when they may. */
  postBlock: string | null;
  /** Photos this reader added to this thread and has not sent: shown again with their Remove, so none is ever stranded. */
  staged: AttachmentRef[];
  /** A group chat's members and its delete state; null for every other kind of thread. */
  group: GroupView | null;
}

export interface HubBadge {
  unread: number;
  needsApproval: number;
  canApprove: boolean;
  /** What the nav badge shows: unread, plus the approvals this session may act on. */
  total: number;
}

// ── approval cards (U4 + TC1/TC3) ────────────────────────────────────────────────────────────────

/**
 * One draft waiting for (or already past) a person's decision, as every screen draws it with the ONE
 * card component. Everything the card says about class and purpose is derived by the server from the
 * frozen columns, never from an agent's words (services/hubCards.ts describe()). No phone number is
 * ever sent: a text's recipient is a name.
 */
export interface ApprovalCardView {
  id: string;
  threadId: string;
  threadTitle: string;
  threadKind: string;
  /** The account the conversation belongs to (so Edit can offer that account's saved addresses), or null. */
  customerId: string | null;
  /** shared/hub/cards.ts CardKind (or the stored actionKind when this build does not know it). */
  kind: string;
  kindLabel: string;
  status: HubMessageStatus;
  channel: string;
  draftedBy: string;
  draftedByAi: boolean;
  createdAt: string;
  /** "Text · Transactional — Appointment Confirmation": channel, class and purpose from the frozen columns. */
  headerLine: string;
  /** Who it goes to ("Jane Smith"), or null for an in-app message. */
  recipient: string | null;
  /** The email address a drafted email will go to; null for text and in-app. */
  recipientAddress: string | null;
  subject: string | null;
  body: string;
  cc: string[];
  /** For a text: the exact words that will be sent, from the same composeSms call the send makes. */
  sendsAs: string | null;
  /** The last messages above the draft, oldest first, at most five. */
  recent: Array<{ authorType: string; authorDisplay: string; text: string; at: string }>;
  /** What happens when this is approved, in the server's words. */
  effectLines: string[];
  chip: { tone: "customer" | "internal"; text: string };
  approve: {
    /** The button's words: "Approve and send", "Approve and post". */
    label: string;
    /** The question asked before it goes out. */
    confirm: string;
    /** Why Approve and "Send my version" are greyed regardless of who is signed in, or null. */
    blockedReason: string | null;
    /**
     * Why Edit and "Send my version" are greyed whoever is signed in, or null. Narrower than blockedReason: a
     * draft that is only blocked because of its own words (or a missing address) can be fixed by editing it.
     */
    editBlockedReason: string | null;
  };
  /** Which fields "Edit" lets the approver change. */
  editable: { subject: boolean; to: boolean; cc: boolean };
  outcome: {
    /** "Sent by Kyle", "Rejected: <reason>", "Approved — SMS disabled", or null while it still waits. */
    text: string | null;
    error: string | null;
    decidedBy: string | null;
    decidedAt: string | null;
    rejectedReason: string | null;
    sentAt: string | null;
    emailDelivery: TimelineEmail | null;
  };
}

export interface ApprovalsResponse {
  cards: ApprovalCardView[];
  /** True when this session may approve (the approve_drafts power). */
  canApprove: boolean;
  /** The sentence to print beside a greyed button when canApprove is false. */
  approveReason: string | null;
}

// ── the message audit log (U4, Kyle only) ────────────────────────────────────────────────────────

export interface AuditEntryView {
  id: string;
  at: string;
  actorKey: string;
  actorDisplay: string;
  action: string;
  /** What the action is called on screen ("Blocked text", "Approved"). */
  actionLabel: string;
  threadId: string | null;
  threadTitle: string | null;
  messageId: string | null;
  /** For a blocked text: why, in words. Never a phone number. */
  reason: string | null;
  messageClass: string | null;
  /** The send type (category key). */
  category: string | null;
  /** A short plain sentence about what happened, never message text. */
  summary: string;
}

export interface AuditResponse {
  entries: AuditEntryView[];
  /** Who has acted, for the "who" filter. */
  actors: Array<{ key: string; display: string }>;
  /** True when older entries exist than were returned. */
  more: boolean;
}

// ── the field app's Messages (U5) ────────────────────────────────────────────────────────────────

/**
 * What a technician's phone sees of the hub. Narrower than the CRM's views on purpose: a technician reads
 * the crew's in-app messages only (never a text or email to a customer), sees names and never a key, a
 * token or a phone number, and a draft an AI agent left for approval is not shown until it is approved.
 */
export interface TechThreadRow {
  /** "team", "training", "group:<threadId>" or "job:<visitId>": stable before a job's thread exists. */
  key: string;
  kind: "team" | "training" | "job" | "group";
  /** Null for an assigned job nobody has written in yet; opening it makes the thread. */
  threadId: string | null;
  title: string;
  visitId: string | null;
  unread: number;
  /**
   * `authorType` and `agentRole` (W2-D) let the list draw the same small avatar and "AI" chip as the thread: see TechMessage.
   */
  lastLine: { authorType: string; agentRole: string | null; authorLabel: string; text: string; at: string } | null;
  lastMessageAt: string | null;
}

export interface TechThreadsResponse {
  threads: TechThreadRow[];
  /** Unread across all of them: the home screen's "Messages (n new)". */
  unread: number;
}

export interface TechMessage {
  id: string;
  /** "tech", "office", "ai_agent", "claude" or "system". */
  authorType: string;
  /**
   * W2-D: the role of the AI agent that wrote it ("admin", "inventory", ..., "claude_code", "other"), so the phone can draw the
   * agent's avatar. Resolved by the server from the key that wrote the post (the role and nothing else of the key); the AI admin's
   * own CRM session is "admin". Null for a person, for an AI post whose key is gone, and for an approver's edited copy of an agent's
   * draft (it is the approver's message: their name is on it and they rewrote it).
   */
  agentRole: string | null;
  /** The name to show; an AI author already reads "... (AI)". Technician.name for a technician. */
  authorLabel: string;
  /** Null once deleted: the text stays in the audit, not on the screen. */
  body: string | null;
  deleted: boolean;
  editedAt: string | null;
  createdAt: string;
  /** When it became readable: the approval time of an AI post (createdAt is when it was drafted), else createdAt. Compare THIS with lastReadAt. */
  at: string;
  mine: boolean;
  canEdit: boolean;
  canDelete: boolean;
  attachments: AttachmentRef[];
  photoIds: string[];
}

export interface TechThreadDetail {
  thread: { id: string; kind: "team" | "training" | "job" | "group"; title: string; visitId: string | null; status: string };
  messages: TechMessage[];
  lastReadAt: string | null;
  truncated: boolean;
  /** Photos this technician added here and has not sent: shown again with their Remove, so none is ever stranded. */
  staged: AttachmentRef[];
}

export interface TechBadge {
  unread: number;
  /**
   * W2-D: how many drafts wait for THIS person to decide (the same cards as Messages -> "Waiting for approval (n)"). 0 for everyone who
   * may not approve, so a plain technician's home button never changes.
   */
  waitingApproval: number;
}
