/**
 * The ONE send-type registry (work order agent-team, ruling L; addendum item 3). A message's
 * `category` is a key here, and `messageClass` and `purposeKey` are DERIVED from it, frozen on the row
 * and never taken from a caller (services/hub.ts createMessageRow). shared/sms/purposes.ts holds only
 * the default header labels, keyed by purposeKey.
 *
 *   * messageClass: transactional (a customer text or email about their own work), marketing (needs a
 *     recorded marketing opt-in; refused outright until that exists) or internal (to Kyle, the
 *     operator alert number or an active technician only).
 *   * purposeKey: the header label's key. Required for a transactional send type; null on marketing
 *     and on internal.
 *   * footer: "first" puts "Reply STOP to opt out." on the first text ever sent to a number; "always"
 *     puts it on every text of that type (the opt-in confirmation: it is the A2P sample and must carry
 *     the opt-out wording whoever it goes to); "never" never does (internal texts). A marketing text carries it every time, by class, whatever the
 *     entry says.
 *   * autoSendEligible: whether Kyle's auto-send allowlist (BA8, all OFF) may ever switch it on.
 *   * lengthCap, allowsPrices, customerFacing: what BA8 checks before a draft in an eligible category may
 *     go out without a person pressing Approve (shared/hub/autoSendCategories.ts is the filtered view).
 *
 * There is NO review-request entry: a review is never sent by text (addendum v2).
 */
import { isSmsPurposeKey, type SmsPurposeKey } from "../sms/purposes";

export const MESSAGE_CLASSES = ["transactional", "marketing", "internal"] as const;
export type MessageClass = (typeof MESSAGE_CLASSES)[number];

export type FooterRule = "first" | "never" | "always";

export interface MessageCategory {
  key: string;
  label: string;
  messageClass: MessageClass;
  purposeKey: SmsPurposeKey | null;
  footer: FooterRule;
  autoSendEligible: boolean;
  /** Longest body an auto-sent message of this type may have. */
  lengthCap: number;
  /** True when a dollar amount may appear in an auto-sent message of this type. */
  allowsPrices: boolean;
  /** False for a message that never reaches a customer (internal texts). */
  customerFacing: boolean;
}

/** The default length cap for an auto-sent message: a short text, not a letter. */
export const DEFAULT_AUTO_SEND_LENGTH_CAP = 320;

const transactional = (key: string, label: string, purposeKey: SmsPurposeKey, autoSendEligible = false, footer: FooterRule = "first"): MessageCategory =>
  ({ key, label, messageClass: "transactional", purposeKey, footer, autoSendEligible, lengthCap: DEFAULT_AUTO_SEND_LENGTH_CAP, allowsPrices: false, customerFacing: true });
const internal = (key: string, label: string, autoSendEligible = false): MessageCategory =>
  ({ key, label, messageClass: "internal", purposeKey: null, footer: "never", autoSendEligible, lengthCap: DEFAULT_AUTO_SEND_LENGTH_CAP, allowsPrices: false, customerFacing: false });

export const MESSAGE_CATEGORY_LIST: readonly MessageCategory[] = [
  transactional("consultation_scheduled", "Consultation scheduled", "consultation"),
  transactional("job_scheduled", "Job scheduled", "job_scheduled"),
  transactional("visit_rescheduled", "Visit rescheduled", "reschedule"),
  transactional("visit_cancelled", "Visit cancelled", "appointment_cancelled"),
  transactional("confirmation_request", "Appointment confirmation request", "appointment_confirmation"),
  transactional("visit_reminder", "Appointment reminder", "appointment_reminder", true),
  transactional("confirmation_reply", "Reply to a confirmation", "appointment_confirmation"),
  transactional("reschedule_reply", "Reply to a reschedule request", "reschedule"),
  transactional("cancel_request_reply", "Reply to a cancellation request", "cancellation_request"),
  transactional("opt_in_confirmation", "Text alerts opt-in confirmation", "text_alerts_confirmed", false, "always"),
  transactional("lead_first_response", "First reply to a new request", "request_received", true),
  transactional("thread_reply", "Reply in a conversation", "thread_reply"),
  internal("internal_alert", "Alert to Kyle or the operator"),
  internal("tech_notice", "Notice to a technician"),
  // In-app posts that never reach a customer (BA8 lists team_internal; amendment 16b adds training_reply). Both are
  // eligible so Kyle has the one switch for them; each stays OFF until he turns it on.
  internal("team_internal", "Team post by an AI", true),
  internal("training_reply", "Reply in a Training thread", true),
];

const BY_KEY = new Map(MESSAGE_CATEGORY_LIST.map((c) => [c.key, c]));

export function messageCategoryFor(key: string | null | undefined): MessageCategory | null {
  return key ? BY_KEY.get(key) ?? null : null;
}

export function isMessageClass(value: unknown): value is MessageClass {
  return typeof value === "string" && (MESSAGE_CLASSES as readonly string[]).includes(value);
}

/** Registry self-check: every transactional entry's purposeKey is a real SMS purpose, internal and marketing have none, no review entry. */
export function registryProblems(list: readonly MessageCategory[] = MESSAGE_CATEGORY_LIST): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const c of list) {
    if (seen.has(c.key)) problems.push(`${c.key}: listed twice`);
    seen.add(c.key);
    if (c.messageClass === "transactional" && (c.purposeKey === null || !isSmsPurposeKey(c.purposeKey))) {
      problems.push(`${c.key}: transactional needs a real purposeKey`);
    }
    if (c.messageClass !== "transactional" && c.purposeKey !== null) problems.push(`${c.key}: only transactional carries a purposeKey`);
    if (/review/i.test(c.key) || /review/i.test(c.purposeKey ?? "")) problems.push(`${c.key}: a review is never texted`);
  }
  return problems;
}
