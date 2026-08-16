/**
 * The app's own access log — one structured line per data-route request.
 *
 * P017, adopted as follow-up 2 of the P015 review. When the auth bypass was found, the question
 * "did anyone read customer data before the fix?" could only be answered from Railway's edge
 * logs, and only as far back as its deployment retention reached (2026-08-03). Everything before
 * that was unknowable. This closes that gap going forward: the record is ours, it starts at the
 * app, and it does not depend on a hosting vendor's retention policy.
 *
 * ── WHAT MAY BE IN A LINE, AND WHY THE SHAPE IS CLOSED ────────────────────────────────────────
 *
 * `decisions/2026-08-04-customer-data-handling.md` rule 4, verbatim: *"Never log a full record.
 * Log IDs, not objects. Dumping a whole request or response into a log is the single most common
 * way customer data escapes a small application, and it is almost always an agent's convenience
 * during debugging that puts it there."*
 *
 * So the line is not built by spreading an object. `AccessLogLine` is a closed interface and
 * `emitAccessLog` assigns every field by name. There is no `...rest`, no `extra`, no `meta` bag.
 * A future route cannot pass a body through this helper, because the helper has nowhere to put
 * one — that is the point of writing it this way rather than as a formatter over `req`.
 *
 * Paths are logged as-is. That is a deliberate, bounded decision: this codebase's identifiers are
 * cuids (`/accounts/cmsddwek9…`), not names or addresses, so a path is an ID reference — exactly
 * what rule 4 asks for. If a route is ever added whose PATH carries personal data (an email, a
 * phone number), it must be redacted here first; `REDACT_PATH_PATTERNS` is where that goes.
 *
 * NOT LOGGED, deliberately: request bodies, response bodies, query strings (they can carry
 * a search term, which can be a customer's name), headers, cookies, tokens of any kind, user
 * agents, photo URLs.
 */

import type { NextFunction, Request, Response } from "express";

/** How the session gate resolved this request. Set by pinAuthMiddleware. */
export type AuthOutcome =
  /** Authenticated session, valid token. */
  | "ok"
  /** On the public allowlist — no session required, and none was evaluated. */
  | "public"
  /** Protected route, no credential presented. */
  | "unauthenticated"
  /** Protected route, credential presented and rejected (expired/forged/garbage). */
  | "bad-credentials"
  /** A webhook whose signature did not verify (P017 §2). */
  | "bad-signature"
  /** The gate did not run — dev/test only, where PIN_HASH is unset. */
  | "gate-disabled";

/** The complete set of fields a line may contain. Adding one is a deliberate edit here. */
export interface AccessLogLine {
  t: string;
  method: string;
  path: string;
  status: number;
  auth: AuthOutcome;
  /** Session subject or technician id when known. NEVER the PIN, never a token. */
  actor: string | null;
  ip: string;
  ms: number;
}

/** Extra fields the middleware layer hangs on the request. Kept in one place so they are greppable. */
export interface RequestAuthState {
  _authOutcome?: AuthOutcome;
  _authActor?: string | null;
}

/**
 * Paths whose own text could carry personal data. Empty today — every identifier in this app is
 * a cuid — and it exists so the next person adding such a route has an obvious place to put the
 * redaction instead of inventing one at the call site.
 */
const REDACT_PATH_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [];

function redactPath(path: string): string {
  let out = path;
  for (const { pattern, replacement } of REDACT_PATH_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/**
 * Emit one line. Every field assigned by name — see the header for why this is not a spread.
 * Exported for tests, which assert the emitted key set is exactly `AccessLogLine`.
 */
export function emitAccessLog(line: AccessLogLine): void {
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      log: "access",
      t: line.t,
      method: line.method,
      path: line.path,
      status: line.status,
      auth: line.auth,
      actor: line.actor,
      ip: line.ip,
      ms: line.ms,
    }),
  );
}

/**
 * Mounted immediately BEFORE the session gate, so it sees every request the gate will judge —
 * including the ones it refuses. The line is written on response `finish`, which is the only
 * point where the status and the latency are both known, and it fires for refused requests too
 * (a 401 is the most interesting line in the file).
 */
export function accessLogMiddleware(req: Request, res: Response, next: NextFunction): void {
  const startedAt = process.hrtime.bigint();

  res.on("finish", () => {
    const state = req as Request & RequestAuthState;
    emitAccessLog({
      t: new Date().toISOString(),
      method: req.method,
      // `req.path` excludes the query string. That is not incidental: a query string can carry
      // a search term, and a search term in this app can be a customer's name.
      path: redactPath(req.path),
      status: res.statusCode,
      auth: state._authOutcome ?? "gate-disabled",
      actor: state._authActor ?? null,
      // `trust proxy` is set, so this is the caller's IP rather than Railway's edge.
      ip: req.ip ?? "unknown",
      ms: Number((process.hrtime.bigint() - startedAt) / 1_000_000n),
    });
  });

  next();
}
