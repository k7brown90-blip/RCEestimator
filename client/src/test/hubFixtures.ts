/**
 * Fixtures for the Messages hub's screens (work order agent-team, U2/U3): a record's conversation and
 * a thread, built the way the server sends them (shared/hub/views.ts).
 */
import type {
  HubBadge, ThreadDetail, ThreadMessage, ThreadRow, ThreadsResponse, TimelineEntry, TimelineMessage, TimelineNote, TimelineResponse,
} from "../../../shared/hub/views";

export const noteEntry = (note: TimelineNote, jobLabel: string | null = null): TimelineEntry => ({
  type: "note", id: `note:${note.id}`, at: note.createdAt, visitId: note.visitId, jobLabel, note,
});

export const timeline = (entries: TimelineEntry[] = [], over: Partial<TimelineResponse> = {}): TimelineResponse => ({
  scope: { customerId: "cust-1", leadId: null, visitId: null, propertyId: null, name: "Jane Homeowner" },
  readOnly: false, entries, truncated: false, crewThread: null, ...over,
});

export const messageEntry = (over: Partial<TimelineMessage> = {}, visitId: string | null = null): TimelineEntry => {
  const message: TimelineMessage = {
    id: "msg-1", threadId: "thread-1", authorType: "ai_agent", authorDisplay: "RCE Admin", channel: "in_app", direction: "internal",
    status: "pending_approval", subject: null, body: "Draft: confirming Tuesday.", toAddress: null, toMasked: null, messageClass: null, error: null, deleted: false,
    deletedBy: null, deletedReason: null, editedAt: null, createdAt: "2026-11-20T15:00:00.000Z", sentAt: null, emailDelivery: null, ...over,
  };
  return { type: "message", id: `message:${message.id}`, at: message.createdAt, visitId, jobLabel: null, message };
};

export const threadRow = (over: Partial<ThreadRow> = {}): ThreadRow => ({
  id: "thread-1", kind: "job", title: "Jane Homeowner — 12 Main St", status: "open", lastMessageAt: "2026-11-20T15:00:00.000Z",
  unread: 0, pending: 0, aiLast: false, lastLine: null, customerId: null, leadId: null, visitId: "visit-1", technicianId: null, ...over,
});

export const threadsResponse = (threads: ThreadRow[] = [], over: Partial<ThreadsResponse> = {}): ThreadsResponse => ({
  threads, needsApproval: 0, canApprove: true, ...over,
});

export const threadMessage = (over: Partial<ThreadMessage> = {}): ThreadMessage => ({
  id: "m-1", authorType: "tech", authorDisplay: "Eric", channel: "in_app", direction: "internal", status: "posted", subject: null,
  body: "On site, panel is open.", toAddress: null, toMasked: null, messageClass: null, error: null, deleted: false, deletedBy: null, deletedReason: null, editedAt: null,
  createdAt: "2026-11-20T15:00:00.000Z", mine: false, canEdit: false, canDelete: false, attachments: [], photoIds: [], ...over,
});

export const threadDetail = (messages: ThreadMessage[] = [], over: Partial<ThreadRow> = {}, lastReadAt: string | null = null): ThreadDetail => ({
  thread: threadRow(over), messages, lastReadAt, truncated: false, postBlock: null, staged: [],
});

export const badge = (over: Partial<HubBadge> = {}): HubBadge => ({ unread: 0, needsApproval: 0, canApprove: true, total: 0, ...over });

/** An approval card as the server sends it (shared/hub/views.ts ApprovalCardView): an AI email draft waiting. */
export const approvalCard = (over: Partial<import("../../../shared/hub/views").ApprovalCardView> = {}): import("../../../shared/hub/views").ApprovalCardView => ({
  id: "msg-1", threadId: "thread-1", threadTitle: "Jane Homeowner", threadKind: "customer", customerId: "cust-1",
  kind: "customer_message", kindLabel: "Message to a customer", status: "pending_approval", channel: "email",
  draftedBy: "RCE Admin (AI)", draftedByAi: true, createdAt: "2026-11-20T15:00:00.000Z",
  headerLine: "Email · Transactional — Reply", recipient: "Jane", recipientAddress: "jane@example.com",
  subject: "Tuesday", body: "We can be there Tuesday morning.", cc: [], sendsAs: null,
  recent: [{ authorType: "customer", authorDisplay: "Jane", text: "Can you come Tuesday?", at: "2026-11-20T14:00:00.000Z" }],
  effectLines: ["Emails Jane at jane@example.com from Red Cedar Electric.", "The email is filed in the account's Conversation with its delivery status."],
  chip: { tone: "customer", text: "This will email the customer" },
  approve: { label: "Approve and send", confirm: "Send this email to Jane (jane@example.com)? It goes to the customer.", blockedReason: null, editBlockedReason: null },
  editable: { subject: true, to: true, cc: true },
  outcome: { text: null, error: null, decidedBy: null, decidedAt: null, rejectedReason: null, sentAt: null, emailDelivery: null },
  ...over,
});

export const approvalsResponse = (
  cards: ReturnType<typeof approvalCard>[] = [], over: Partial<import("../../../shared/hub/views").ApprovalsResponse> = {},
): import("../../../shared/hub/views").ApprovalsResponse => ({ cards, canApprove: true, approveReason: null, ...over });
