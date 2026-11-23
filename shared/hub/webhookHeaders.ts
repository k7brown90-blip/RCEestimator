/**
 * The rules for the custom headers Kyle can add to an agent webhook (work order C6b, the Grok team's
 * request of 2026-11-22). ONE list of rules, read by the server (the save refuses what fails here) and
 * the CRM card (it says why before the save). The header's VALUE is a secret (an Authorization bearer,
 * for example): it is stored encrypted, shown only as the last four characters, and never put in a
 * payload, a log or an answer.
 */

export const WEBHOOK_HEADERS_MAX = 5;
export const WEBHOOK_HEADER_NAME_MAX = 64;
export const WEBHOOK_HEADER_VALUE_MAX = 2000;

/** RFC 7230 token: the characters a header name may have. */
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** Names a custom header can never take: the CRM sets these itself. Any X-RCE-* is reserved too. */
export const RESERVED_WEBHOOK_HEADERS = [
  "content-type", "content-length", "host", "transfer-encoding", "connection",
  // Node's fetch (undici) throws on these before anything is sent, which would fail every delivery to the agent.
  "keep-alive", "upgrade", "expect",
] as const;

export function isReservedWebhookHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith("x-rce-") || (RESERVED_WEBHOOK_HEADERS as readonly string[]).includes(lower);
}

/** The shape rules only (token, length), NOT the reserved list: what a STORED row is read with, so a name that becomes reserved later never makes the whole row unreadable. */
export function webhookHeaderNameShapeProblem(name: string): string | null {
  if (name === "") return "A header needs a name.";
  if (name.length > WEBHOOK_HEADER_NAME_MAX) return `A header name can be at most ${WEBHOOK_HEADER_NAME_MAX} characters.`;
  if (!TOKEN.test(name)) return "A header name can use only letters, digits and these symbols: ! # $ % & ' * + - . ^ _ ` | ~ (no spaces or colon).";
  return null;
}

/** Why this name is refused when SAVING, in words, or null when it is fine. */
export function webhookHeaderNameProblem(name: string): string | null {
  const shape = webhookHeaderNameShapeProblem(name);
  if (shape) return shape;
  if (isReservedWebhookHeader(name)) return `"${name}" is set by the CRM itself and cannot be a custom header (reserved: X-RCE-*, ${RESERVED_WEBHOOK_HEADERS.join(", ")}).`;
  return null;
}

/** Why this value is refused (never quoting the value), or null when it is fine. Printable ASCII only: no CR, LF or other control character. */
export function webhookHeaderValueProblem(value: string): string | null {
  if (value === "") return "A header needs a value.";
  if (value.length > WEBHOOK_HEADER_VALUE_MAX) return `A header value can be at most ${WEBHOOK_HEADER_VALUE_MAX} characters.`;
  if (!/^[\x20-\x7e]+$/.test(value)) return "A header value can use only plain printable characters (no line breaks, tabs or other control characters).";
  return null;
}
