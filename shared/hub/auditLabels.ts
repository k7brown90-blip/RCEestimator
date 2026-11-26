/**
 * What each hub audit action is called on screen (work order agent-team, U4). One list read by the server's
 * audit view (services/hubAuditView.ts) and the CRM's Message audit log card, so an action is never named
 * two ways. An action not listed here (an older or newer one) is shown as it was written.
 */
export const HUB_AUDIT_ACTION_LABELS: Record<string, string> = {
  send_blocked: "Blocked text",
  message_created: "Message posted",
  message_edited: "Message edited",
  message_deleted: "Message deleted",
  message_approved: "Approved",
  // "Auto-approved" is kept for older rows (an auto-send rule) and for a Team post published by its key's own box.
  message_auto_approved: "Auto-approved",
  // Kyle 2026-11-24 (no check-ins): an AI agent's email or text to a customer, sent on the agent's own request.
  message_sent_directly: "Sent by an AI agent, no approval step",
  message_edit_approved: "Edited and approved",
  message_rejected: "Rejected",
  message_retry: "Sent again",
  message_sent: "Sent",
  message_posted: "Posted",
  message_held: "Held — SMS disabled",
  message_send_failed: "Could not be sent",
  message_send_interrupted: "Send interrupted",
  thread_created: "Conversation started",
  thread_status: "Conversation closed or reopened",
  thread_renamed: "Conversation renamed",
  thread_merged: "Conversations joined",
  group_created: "Group chat made",
  group_member_added: "Member added to a group",
  group_member_removed: "Member removed from a group",
  group_deleted: "Group chat deleted",
  // W2-E: the Claude Code ("@Coding") runs.
  coding_requested: "Claude Code asked to change the app",
  coding_refused: "Claude Code request refused",
  coding_dispatched: "Claude Code started on GitHub",
  coding_dispatch_failed: "Claude Code could not be started",
  coding_replied: "Claude Code answered",
  coding_cancelled: "Claude Code request cancelled",
  // Kyle 2026-11-24 (price book for agents)
  price_item_created: "Price book item added by an agent",
  price_change_proposed: "Price book change proposed by an agent",
  price_change_applied: "Price book change approved and applied",
  coding_timed_out: "Claude Code did not answer in an hour",
};

export const hubAuditActionLabel = (action: string): string => HUB_AUDIT_ACTION_LABELS[action] ?? action;
