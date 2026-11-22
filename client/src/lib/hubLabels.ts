/**
 * The Messages hub's words on screen (work order agent-team, U2/U3): ONE place for what a message
 * status, a thread kind and an author are called, so the record conversation, the Messages page and
 * the Thread drawer cannot name the same thing two ways.
 */
import type { HubMessageStatus } from "../../../shared/hub/model";

export interface StatusChip {
  label: string;
  /** Tailwind classes for the chip. */
  tone: string;
  /** Hover text that says what it means. */
  title: string;
}

const GREY = "bg-gray-100 text-gray-700";
const AMBER = "bg-amber-100 text-amber-800";
const GREEN = "bg-emerald-100 text-emerald-800";
const RED = "bg-red-100 text-red-800";

/**
 * The chip a message carries, or null when the message needs none (posted, received, edited).
 * 'blocked' is a text the CRM refused to send: it is "Not texted", never "Sent" and never "Failed".
 */
export const MESSAGE_STATUS_CHIPS: Partial<Record<HubMessageStatus, StatusChip>> = {
  draft: { label: "Draft", tone: GREY, title: "A draft that is not ready for approval yet." },
  pending_approval: { label: "Needs approval", tone: AMBER, title: "Waiting for someone with approval to send, edit or reject it." },
  approving: { label: "Sending", tone: AMBER, title: "Approved, and going out now." },
  approved: { label: "Approved", tone: GREEN, title: "Approved; it goes out as soon as it is allowed to." },
  sent: { label: "Sent", tone: GREEN, title: "Sent to the customer." },
  failed: { label: "Failed", tone: RED, title: "It could not be sent." },
  rejected: { label: "Rejected", tone: RED, title: "Rejected by the office; it was not sent." },
  superseded: { label: "Replaced", tone: GREY, title: "A newer fact made this draft moot." },
  edited: { label: "Edited before sending", tone: GREY, title: "The office changed the words; the version they sent is the next message." },
  blocked: { label: "Not texted", tone: RED, title: "The CRM refused to send this text. The reason is shown under the message." },
};

export function messageStatusChip(status: string, messageClass?: string | null): StatusChip | null {
  // An internal text went to Kyle, the operator number or a technician: "Sent" must never read as "sent to the customer".
  if (status === "sent" && messageClass === "internal") {
    return { label: "Sent to staff", tone: GREY, title: "Texted to Kyle, the alert number or a technician. The customer did not get this text." };
  }
  return MESSAGE_STATUS_CHIPS[status as HubMessageStatus] ?? null;
}

/**
 * The line that says who an automatic text went to: "Automatic text to (615) ***-0101", or "Text to Kyle" /
 * "Staff alert" for an internal text, so an alert filed in a customer's conversation never reads as a text the
 * customer received. Null for a message that is not an automatic text.
 */
export function automaticTextLine(message: { authorType: string; channel: string; messageClass?: string | null; toMasked?: string | null }): string | null {
  if (message.authorType !== "system" || message.channel !== "sms") return null;
  if (message.messageClass === "internal") return message.toMasked === "Kyle" ? "Text to Kyle (staff alert, not sent to the customer)" : `Staff alert text${message.toMasked ? ` to ${message.toMasked}` : ""} (not sent to the customer)`;
  return `Automatic text${message.toMasked ? ` to ${message.toMasked}` : ""}`;
}

/** What each kind of thread is called. */
export const THREAD_KIND_LABELS: Record<string, string> = {
  customer: "Customer",
  job: "Crew chat",
  team: "Team",
  dev: "Dev",
  training: "Training",
};

export const threadKindLabel = (kind: string): string => THREAD_KIND_LABELS[kind] ?? kind;

export const isAiAuthor = (authorType: string): boolean => authorType === "ai_agent" || authorType === "claude";

/** "RCE Admin (AI)": an AI author always reads as one, whatever its key is called. */
export function authorLabel(authorType: string, display: string): string {
  if (isAiAuthor(authorType) && !/\(AI\)\s*$/.test(display)) return `${display} (AI)`;
  return display;
}

/** The compose button on a thread, by kind: "Post to crew" on a job, "Post to team" on a Team thread. */
export function postButtonLabel(kind: string): string {
  if (kind === "job") return "Post to crew";
  if (kind === "team") return "Post to team";
  return "Post";
}

export function whenText(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
