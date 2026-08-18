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
  /** A webhook whose signature did not verify. */
  | "bad-signature"
  /** A surface that has been withdrawn from operations — 410, refused unread (P017 rev 2). */
  | "channel-disabled"
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
 * Paths whose own text must not be written down.
 *
 * The first entry was earned within a minute of the first deploy. `/internal/webhooks/*` carries
 * `INTERNAL_WEBHOOK_TOKEN` as a path segment — the P015 review already had that token printing
 * in plaintext in Railway's EDGE logs as follow-up 4, and this log promptly reproduced the same
 * leak in the app's own output. A log built to answer security questions must not be the thing
 * that answers them for an attacker.
 *
 * Personal data in a path is the other reason to add an entry here. Nothing qualifies today —
 * every identifier in this app is a cuid, which is an ID reference and exactly what
 * `decisions/2026-08-04-customer-data-handling.md` rule 4 asks for — so the next person adding a
 * route with an email or a phone number in the path has an obvious place to put the redaction
 * rather than inventing one at the call site.
 */
const REDACT_PATH_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /^(\/internal\/webhooks\/[^/]+\/)[^/]+/, replacement: "$1<token>" },

  /*
    CAPABILITY TOKENS IN CUSTOMER LINKS (P029 rider, raised by the P027 report).

    `/e/:token` is the customer's estimate page and `/confirm/:token` is their appointment page.
    In both, the path segment IS the credential — anyone holding it can read the estimate and
    SIGN it, or confirm and cancel an appointment. Writing it to the access log put a working
    signature capability into a stream that is kept precisely so it can be read later.

    Same treatment the Railway webhook token already gets, and for the same reason: a log built
    to answer security questions must not answer them for an attacker. Both entries keep the
    route visible (`/e/<token>`), so the log still shows that a customer opened their estimate
    and what the server said — the observability survives, the capability does not.
  */
  { pattern: /^(\/e\/)[^/]+/, replacement: "$1<token>" },
  { pattern: /^(\/confirm\/)[^/]+/, replacement: "$1<token>" },
];

/** Exported so the redaction can be tested directly — a leak here is silent otherwise. */
export function redactPath(path: string): string {
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
/**
 * The caller's IP, as far as it can be known.
 *
 * `req.ip` was wrong here, and the first production run proved it: it reported Railway's own edge
 * addresses (89.222.103.x, varying per request) rather than the caller, because `trust proxy` is
 * set to 1 and Railway fronts the app with more hops than that. An access log whose IP field
 * names the load balancer is decorative.
 *
 * The left-most `X-Forwarded-For` entry is the client, and it matches what Railway's own edge log
 * records as `srcIp`. `trust proxy` is deliberately NOT widened to fix this — that setting also
 * governs rate-limit bucketing, and making it `true` would let a caller choose their own bucket
 * by sending a header.
 *
 * CAVEAT, and it belongs in the record rather than in a footnote: the left-most entry is
 * client-supplied. Railway appends rather than replaces, so a caller can prepend a fake address.
 * The value is good evidence of "which client", not proof of origin. For an incident, Railway's
 * edge log is the corroborating source.
 */
function callerIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const first = String(raw ?? "").split(",")[0].trim();
  return first || req.ip || "unknown";
}

export function accessLogMiddleware(req: Request, res: Response, next: NextFunction): void {
  const startedAt = process.hrtime.bigint();

  // CAPTURED HERE, NOT IN THE `finish` HANDLER. Express rewrites `req.url` when a request enters
  // a mounted router, and `req.path` is derived from it — so by the time the response finishes,
  // `/internal/webhooks/twilio-status/x` reads as `/webhooks/twilio-status/x`. The first
  // production run logged exactly that, silently dropping the mount prefix on every router-served
  // route. `req.originalUrl` is the other candidate and is wrong for a different reason: it still
  // carries the `/api` prefix AND the query string, which must never be logged.
  //
  // `req.path` excludes the query string. That is not incidental: a query string can carry a
  // search term, and a search term in this app can be a customer's name.
  const pathAtEntry = redactPath(req.path);

  res.on("finish", () => {
    const state = req as Request & RequestAuthState;
    emitAccessLog({
      t: new Date().toISOString(),
      method: req.method,
      path: pathAtEntry,
      status: res.statusCode,
      auth: state._authOutcome ?? "gate-disabled",
      actor: state._authActor ?? null,
      ip: callerIp(req),
      ms: Number((process.hrtime.bigint() - startedAt) / 1_000_000n),
    });
  });

  next();
}
