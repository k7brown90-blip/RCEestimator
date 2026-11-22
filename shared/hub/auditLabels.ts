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
  message_auto_approved: "Auto-approved",
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
};

export const hubAuditActionLabel = (action: string): string => HUB_AUDIT_ACTION_LABELS[action] ?? action;
