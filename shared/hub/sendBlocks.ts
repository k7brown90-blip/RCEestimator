/**
 * Why the CRM refused to send a text (work order agent-team, BA7 + addendum item 6 "log every block").
 * One code per reason, written to HubMessage.error and to the send_blocked audit row, and ONE sentence per
 * code shown on the approval card and in Settings -> Message audit log -> Blocked texts. A code is never a
 * phone number or a name; the sentence is what the office reads.
 */
export const SEND_BLOCK_REASONS = {
  no_class: "This text has no class, so no rule can be applied to it.",
  no_purpose: "This text has no reason label, so it cannot be sent.",
  class_mismatch: "This text's class does not match its send type, so it cannot be sent.",
  marketing_not_opted_in: "Red Cedar never sends marketing by text",
  internal_not_allowed: "Internal texts go only to Kyle, the alert number and the technicians.",
  review_never_sms: "A review request is never sent by text. Ask on site (QR or email) instead.",
  no_phone: "There is no phone number on file to text.",
  opted_out: "No texts, call or email — this customer opted out of texts.",
  no_sms_consent: "This customer has not agreed to texts. Call or email instead.",
  reply_window_closed: "Never asked — you can only reply within 36 hours of their last text.",
  empty_body: "A text needs words.",
  double_brand: "The text already starts with the company name. The header is added for you; take it out of the message.",
  double_footer: "The text already says \"Reply STOP\". The footer is added for you; take it out of the message.",
} as const;

export type SendBlockReason = keyof typeof SEND_BLOCK_REASONS;

export function isSendBlockReason(value: unknown): value is SendBlockReason {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(SEND_BLOCK_REASONS, value);
}

/**
 * Reasons an EDIT can cure: the words themselves are the problem (a text that already carries the header or the
 * STOP line, or has no words). Every other reason (no consent, opted out, marketing, no phone...) is about the
 * customer or the kind of message, so editing the words cannot fix it and "Edit" stays greyed for it.
 */
export const EDIT_FIXABLE_REASONS: readonly SendBlockReason[] = ["double_brand", "double_footer", "empty_body"];

export const isEditFixableReason = (reason: string | null | undefined): boolean =>
  typeof reason === "string" && (EDIT_FIXABLE_REASONS as readonly string[]).includes(reason);

/** The sentence for a reason code; an unknown code (an older row) is shown as it was written. */
export function sendBlockText(code: string | null | undefined): string {
  if (!code) return "";
  return isSendBlockReason(code) ? SEND_BLOCK_REASONS[code] : code;
}

/** What HubMessage.error holds while a text is approved but cannot go out because texting is switched off. */
export const SMS_DISABLED_ERROR = "SMS disabled";
