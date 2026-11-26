/**
 * Agent API errors (work order agent-team, K-U4): ONE catalog, for both doors (/mcp and REST
 * /api/hub/*). Every refusal an agent sees is `{ code, reason, retryable }` (plus `retry_after`
 * seconds when waiting helps). Never an exception message, never a stack, never a secret.
 *
 * `reason` is a sentence written here, or - for a case the CRM screen already greys out with its own
 * words - the screen's own reason text, passed in by the throwing code. `toAgentError` is the only
 * place an unknown error becomes a response: it answers a plain "internal" and logs the real error
 * to SystemEvent (source "agent_api") where the office can read it.
 */
import { ZodError } from "zod";
import { logSystemEvent } from "../services/systemEvents";

export const AGENT_ERRORS = {
  unauthenticated: { status: 401, retryable: false, reason: "A valid agent key is required." },
  key_revoked: { status: 401, retryable: false, reason: "This key has been revoked." },
  key_expired: { status: 401, retryable: false, reason: "This key has expired." },
  key_retired: { status: 401, retryable: false, reason: "This key was replaced by a newer one and its overlap period has ended." },
  key_wrong_environment: { status: 401, retryable: false, reason: "This key belongs to a different environment." },
  agent_key_not_accepted: { status: 401, retryable: false, reason: "Agent keys are not accepted here." },
  agents_off: { status: 503, retryable: true, reason: "Agent access is switched off." },
  agents_read_only: { status: 503, retryable: true, reason: "Agent access is read-only right now; writes and drafts are refused." },
  not_configured: { status: 503, retryable: false, reason: "Agent access is not configured on this server." },
  rate_limited: { status: 429, retryable: true, reason: "Too many requests. Wait and try again." },
  daily_draft_limit: { status: 429, retryable: true, reason: "The daily draft limit for this key has been reached." },
  // W2 (R-j): too many AI posts in one thread with no person in between.
  thread_agent_limit: { status: 429, retryable: true, reason: "Too many AI replies in this thread in a row. A person needs to post before the AI team posts again." },
  scope_denied: { status: 403, retryable: false, reason: "This key's scopes do not allow that." },
  writes_disabled: { status: 403, retryable: false, reason: "Writes are not enabled for this key." },
  forbidden: { status: 403, retryable: false, reason: "This key may not do that." },
  not_found: { status: 404, retryable: false, reason: "Not found." },
  // W2-B: /mcp is stateless (team answer 12): there is no event stream to open and no session to close.
  method_not_allowed: { status: 405, retryable: false, reason: "Send each /mcp request as a POST with a JSON-RPC body. This door is stateless: there is no event stream (GET) and no session to close (DELETE)." },
  unknown_tool: { status: 400, retryable: false, reason: "There is no such tool. Ask tools/list for the tools this key may use." },
  bad_request: { status: 400, retryable: false, reason: "The request was not valid." },
  bad_time: { status: 400, retryable: false, reason: "Times must be ISO 8601 with an offset, like 2026-11-23T09:00:00-06:00." },
  bad_cursor: { status: 400, retryable: false, reason: "The cursor is not valid. Start again from the first page." },
  idempotency_conflict: { status: 409, retryable: false, reason: "That idempotency_key was already used with a different request." },
  // Price book (Kyle 2026-11-24): a new item whose name is a near-duplicate of one already in the same category. The body carries the existing item.
  duplicate_item: { status: 409, retryable: false, reason: "The price book already has an item with that name in that category." },
  in_progress: { status: 409, retryable: true, reason: "An identical request is still being processed. Retry shortly." },
  internal: { status: 500, retryable: true, reason: "Something went wrong on our side." },
} as const;

export type AgentErrorCode = keyof typeof AGENT_ERRORS;

/** The body of every agent refusal. `retry_after` is whole seconds. */
export interface AgentErrorBody {
  code: AgentErrorCode;
  reason: string;
  retryable: boolean;
  retry_after?: number;
  /** Extra data a refusal carries (the existing item behind a duplicate_item), already projected through an agent profile. */
  existing_item?: unknown;
}

export interface AgentErrorOptions {
  /** Replaces the catalog sentence, e.g. the CRM screen's own greyed-button reason. */
  reason?: string;
  retryAfterSeconds?: number;
  /** Carried into the body as `existing_item` (duplicate_item only). Must already be agent-safe. */
  existingItem?: unknown;
}

/** Throw this from agent code for a known refusal; `toAgentError` turns it into the response. */
export class AgentApiError extends Error {
  readonly code: AgentErrorCode;
  readonly reason: string;
  readonly retryAfterSeconds?: number;
  readonly existingItem?: unknown;

  constructor(code: AgentErrorCode, options: AgentErrorOptions = {}) {
    super(code);
    this.name = "AgentApiError";
    this.code = code;
    this.reason = options.reason ?? AGENT_ERRORS[code].reason;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.existingItem = options.existingItem;
  }
}

export function agentErrorBody(code: AgentErrorCode, options: AgentErrorOptions = {}): AgentErrorBody {
  const entry = AGENT_ERRORS[code];
  const body: AgentErrorBody = { code, reason: options.reason ?? entry.reason, retryable: entry.retryable };
  if (options.retryAfterSeconds !== undefined) body.retry_after = Math.max(1, Math.ceil(options.retryAfterSeconds));
  if (options.existingItem !== undefined) body.existing_item = options.existingItem;
  return body;
}

export interface AgentErrorResult {
  status: number;
  body: AgentErrorBody;
}

/**
 * A schema may carry its own sentence for the agent (a constant written in this repo, never a value the caller sent) by starting the issue message
 * with OWN_REASON_PREFIX. Those sentences, and only those, are added to the refusal's reason (Kyle 2026-11-25: the missing unit on a price book
 * create is refused with the field named and examples). Every other issue still names its FIELD only.
 */
export const OWN_REASON_PREFIX = "agent-reason: ";
export function ownReasonsOf(err: ZodError): string[] {
  const out = err.issues.map((i) => i.message).filter((m) => m.startsWith(OWN_REASON_PREFIX)).map((m) => m.slice(OWN_REASON_PREFIX.length));
  return [...new Set(out)].slice(0, 3);
}

/**
 * Any thrown value to the response an agent gets. A known AgentApiError keeps its own code and
 * reason. A ZodError is a bad_request naming the failing FIELDS only (never the values sent). Anything
 * else is "internal": the response carries no message and no stack, and the real error goes to
 * SystemEvent with the route.
 */
export function toAgentError(err: unknown, route?: string): AgentErrorResult {
  if (err instanceof AgentApiError) {
    return {
      status: AGENT_ERRORS[err.code].status,
      body: agentErrorBody(err.code, { reason: err.reason, retryAfterSeconds: err.retryAfterSeconds, existingItem: err.existingItem }),
    };
  }
  if (err instanceof ZodError) {
    const fields = [...new Set(err.issues.map((i) => i.path.join(".") || "(body)"))].slice(0, 10);
    const own = ownReasonsOf(err);
    // A time field that failed the offset rule gets its own code, so an agent can fix it.
    const badTime = err.issues.some((i) => /datetime|iso/i.test(`${i.code} ${"format" in i ? String(i.format) : ""}`));
    const code: AgentErrorCode = badTime ? "bad_time" : "bad_request";
    return {
      status: AGENT_ERRORS[code].status,
      body: agentErrorBody(code, { reason: `${AGENT_ERRORS[code].reason} Check: ${fields.join(", ")}.${own.length > 0 ? ` ${own.join(" ")}` : ""}` }),
    };
  }
  logSystemEvent("error", "agent_api", err instanceof Error ? err.message : "non-error thrown", {
    ...(route ? { route } : {}),
    name: err instanceof Error ? err.name : typeof err,
    stack: err instanceof Error ? err.stack : undefined,
  });
  return { status: AGENT_ERRORS.internal.status, body: agentErrorBody("internal") };
}
