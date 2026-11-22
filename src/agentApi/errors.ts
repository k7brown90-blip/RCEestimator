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
  scope_denied: { status: 403, retryable: false, reason: "This key's scopes do not allow that." },
  writes_disabled: { status: 403, retryable: false, reason: "Writes are not enabled for this key." },
  forbidden: { status: 403, retryable: false, reason: "This key may not do that." },
  not_found: { status: 404, retryable: false, reason: "Not found." },
  bad_request: { status: 400, retryable: false, reason: "The request was not valid." },
  bad_time: { status: 400, retryable: false, reason: "Times must be ISO 8601 with an offset, like 2026-11-23T09:00:00-06:00." },
  bad_cursor: { status: 400, retryable: false, reason: "The cursor is not valid. Start again from the first page." },
  idempotency_conflict: { status: 409, retryable: false, reason: "That idempotency_key was already used with a different request." },
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
}

export interface AgentErrorOptions {
  /** Replaces the catalog sentence, e.g. the CRM screen's own greyed-button reason. */
  reason?: string;
  retryAfterSeconds?: number;
}

/** Throw this from agent code for a known refusal; `toAgentError` turns it into the response. */
export class AgentApiError extends Error {
  readonly code: AgentErrorCode;
  readonly reason: string;
  readonly retryAfterSeconds?: number;

  constructor(code: AgentErrorCode, options: AgentErrorOptions = {}) {
    super(code);
    this.name = "AgentApiError";
    this.code = code;
    this.reason = options.reason ?? AGENT_ERRORS[code].reason;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

export function agentErrorBody(code: AgentErrorCode, options: AgentErrorOptions = {}): AgentErrorBody {
  const entry = AGENT_ERRORS[code];
  const body: AgentErrorBody = { code, reason: options.reason ?? entry.reason, retryable: entry.retryable };
  if (options.retryAfterSeconds !== undefined) body.retry_after = Math.max(1, Math.ceil(options.retryAfterSeconds));
  return body;
}

export interface AgentErrorResult {
  status: number;
  body: AgentErrorBody;
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
      body: agentErrorBody(err.code, { reason: err.reason, retryAfterSeconds: err.retryAfterSeconds }),
    };
  }
  if (err instanceof ZodError) {
    const fields = [...new Set(err.issues.map((i) => i.path.join(".") || "(body)"))].slice(0, 10);
    // A time field that failed the offset rule gets its own code, so an agent can fix it.
    const badTime = err.issues.some((i) => /datetime|iso/i.test(`${i.code} ${"format" in i ? String(i.format) : ""}`));
    const code: AgentErrorCode = badTime ? "bad_time" : "bad_request";
    return {
      status: AGENT_ERRORS[code].status,
      body: agentErrorBody(code, { reason: `${AGENT_ERRORS[code].reason} Check: ${fields.join(", ")}.` }),
    };
  }
  logSystemEvent("error", "agent_api", err instanceof Error ? err.message : "non-error thrown", {
    ...(route ? { route } : {}),
    name: err instanceof Error ? err.name : typeof err,
    stack: err instanceof Error ? err.stack : undefined,
  });
  return { status: AGENT_ERRORS.internal.status, body: agentErrorBody("internal") };
}
