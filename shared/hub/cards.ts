/**
 * The approval card's kinds and its header line (work order agent-team, TC1 + TC3). ONE card component
 * on every screen draws every kind; what differs per kind is registered here and in the server's
 * registry (services/hubCards.ts), never in a second component.
 *
 *   customer_message  a drafted email or text to a customer (the kind built now)
 *   team_reply        a drafted in-app post in a job, Team, Dev or Training thread
 *   contact_instead   "Call or email instead" for an opted-out customer - registered for step 6 (P2B-3/7)
 *   opt_out_review    "Opted out by text - review" - registered for step 6 (P2B-8)
 *
 * A kind stored on HubMessage.actionKind. A message with no actionKind is a plain draft and its kind is
 * worked out from its channel (kindOfMessage in the server registry).
 */
import { messageCategoryFor, type MessageClass } from "./messageCategories";
import { isSmsPurposeKey, smsPurposeLabel } from "../sms/purposes";

export const CARD_KINDS = {
  customer_message: { label: "Message to a customer", implemented: true },
  team_reply: { label: "Reply in a conversation", implemented: true },
  contact_instead: { label: "Call or email instead", implemented: false },
  opt_out_review: { label: "Opted out by text — review", implemented: false },
} as const;

export type CardKind = keyof typeof CARD_KINDS;

export function isCardKind(value: unknown): value is CardKind {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(CARD_KINDS, value);
}

const CLASS_WORD: Record<MessageClass, string> = { transactional: "Transactional", marketing: "Marketing", internal: "Internal" };
const CHANNEL_WORD: Record<string, string> = { sms: "Text", email: "Email", in_app: "Message", web_chat: "Website chat", system: "Automatic" };

export const channelWord = (channel: string): string => CHANNEL_WORD[channel] ?? "Message";

/**
 * The header line that says what is being approved, built ONLY from the frozen columns (channel,
 * messageClass, purposeKey, category), never from words an agent wrote:
 *   "Text · Transactional — Appointment Confirmation", "Text · Marketing", "Email · Transactional — Reply in a conversation",
 *   "Message · Internal only".
 */
export function cardHeaderLine(m: {
  channel: string; messageClass: string | null; purposeKey: string | null; category: string | null; labels?: Partial<Record<string, string>>;
}): string {
  const channel = channelWord(m.channel);
  if (m.channel === "in_app") return `${channel} · Internal only`;
  const cls = m.messageClass as MessageClass | null;
  if (cls !== "transactional" && cls !== "marketing" && cls !== "internal") return `${channel} · No class set`;
  if (cls === "marketing") return `${channel} · ${CLASS_WORD.marketing}`;
  const label = m.purposeKey && isSmsPurposeKey(m.purposeKey)
    ? smsPurposeLabel(m.purposeKey, m.labels)
    : messageCategoryFor(m.category)?.label ?? null;
  return label ? `${channel} · ${CLASS_WORD[cls]} — ${label}` : `${channel} · ${CLASS_WORD[cls]}`;
}
