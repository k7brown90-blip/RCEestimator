import type { Request, Response, NextFunction } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { isPublicRoute } from "./publicRoutes";
import type { AuthOutcome, RequestAuthState } from "./accessLog";

/**
 * Record how the gate resolved, for the access log (P017). Auth decides the outcome; the log
 * only reports it — which is why this is set here rather than inferred from a status code
 * downstream, where a 401 from a route's own credential check would be indistinguishable from
 * a 401 from the session gate.
 */
function mark(req: Request, outcome: AuthOutcome, actor: string | null = null): void {
  const state = req as Request & RequestAuthState;
  state._authOutcome = outcome;
  state._authActor = actor;
}

const JWT_SECRET = process.env.JWT_SECRET ?? "rce-dev-secret-change-me";
const SESSION_HOURS = 8;

/**
 * Session gate. DEFAULT-DENY as of P015 — see middleware/publicRoutes.ts for the why and the
 * allowlist itself.
 *
 * Two things this used to do, and no longer does:
 *
 *   * It skipped any request that was not marked `_isApi`, and `_isApi` was set only for paths
 *     beginning `/api`. Since every data route is mounted at its bare path, `GET /accounts`
 *     answered in full with no session while `GET /api/accounts` returned 401. Authentication
 *     must not depend on how a path is spelled.
 *   * It carried its own inline list of exempt paths, which had drifted into a comment
 *     explaining that the entries "no longer gate anything" because of where the middleware was
 *     mounted. An allowlist that does not gate is worse than none: it reads like a decision.
 *
 * The middleware is now installed ahead of every route, and the only exemption is the allowlist.
 */
export function pinAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Dev/test convenience ONLY, and gated on NODE_ENV so the convenience cannot leak into
  // production by itself (PUNCHLIST B3).
  //
  // Before this, "no PIN_HASH" meant "let everything through" in every environment — server.ts
  // refusing to boot in production without PIN_HASH was the ONLY thing standing between an unset
  // var and a wide-open CRM ("a pair", the old comment said). A pair is two single points of
  // failure, not one: any way past the boot check — a redeploy that dropped the env var, a
  // process that never went through server.ts's startServer() (a script, a test harness, a
  // future entry point) — reopened the whole app with nothing else in the way.
  //
  // Now the gate fails CLOSED on its own unless NODE_ENV says, explicitly, "development" or
  // "test" — a DENY-list of convenience, not an allow-list of danger (security review,
  // 2026-09-22). Keying on `=== "production"` would share server.ts's boot check's one trigger: a
  // NODE_ENV that is unset or spelled differently on the host would switch BOTH layers off at
  // once. Vitest runs with NODE_ENV=test; local dev sets NODE_ENV=development or a PIN_HASH.
  // The boot check stays as the first line of defence (never even start), and this is the second
  // (never serve, even if something started anyway).
  if (!process.env.PIN_HASH) {
    const devOrTest = process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test";
    if (!devOrTest) {
      if (isPublicRoute(req.method, req.path)) {
        mark(req, "public");
        next();
        return;
      }
      mark(req, "unconfigured");
      res.status(503).json({ error: "Server misconfigured: authentication is not set up." });
      return;
    }
    mark(req, "gate-disabled");
    next();
    return;
  }

  if (isPublicRoute(req.method, req.path)) {
    mark(req, "public");
    next();
    return;
  }

  // Header only. A session token used to be accepted from the query string as
  // well, which put it into server logs, browser history and Referer headers on
  // every navigation away. The only thing that needed it was an `<img src>`
  // pointing at a protected endpoint — inspection photo evidence — and that now
  // fetches its bytes properly (client/src/components/ProtectedImage.tsx).
  const token = req.headers.authorization?.replace("Bearer ", "");

  if (!token) {
    mark(req, "unauthenticated");
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  try {
    const claims = jwt.verify(token, JWT_SECRET);
    // `sub` is "owner" for the PIN session. It is an identity, never a credential — the token
    // itself must not reach the log.
    const actor = typeof claims === "object" && claims !== null && typeof claims.sub === "string"
      ? claims.sub
      : "unknown";

    mark(req, "ok", actor);
    next();
  } catch {
    mark(req, "bad-credentials");
    res.status(401).json({ error: "Invalid or expired session" });
  }
}

export async function handlePinLogin(req: Request, res: Response): Promise<void> {
  const pinHash = process.env.PIN_HASH;
  if (!pinHash) {
    res.status(500).json({ error: "PIN not configured" });
    return;
  }

  const { pin } = req.body as { pin?: string };
  if (!pin || typeof pin !== "string") {
    res.status(400).json({ error: "PIN required" });
    return;
  }

  const valid = await bcrypt.compare(pin, pinHash);
  if (!valid) {
    res.status(401).json({ error: "Invalid PIN" });
    return;
  }

  res.json(issueSessionToken());
}

/**
 * The one place a session token is signed. Login and refresh both call it, so a session's
 * length and claims cannot drift between the two doors.
 */
function issueSessionToken(): { token: string; expiresIn: number } {
  const token = jwt.sign({ sub: "owner" }, JWT_SECRET, {
    expiresIn: `${SESSION_HOURS}h`,
  });
  return { token, expiresIn: SESSION_HOURS * 60 * 60 };
}

/**
 * POST /auth/refresh — a still-valid session token buys a fresh one (sliding renewal), so a
 * session in use is never locked out at the 8-hour mark. It is NOT a public route: it sits behind
 * pinAuthMiddleware like everything else, and this handler re-verifies the token itself (defence
 * in depth — it does not trust that the gate ran). The PIN stays the only way to START a session;
 * an expired or invalid token gets 401, never a new one. Header only — no token in a URL.
 */
export function handleSessionRefresh(req: Request, res: Response): void {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  try {
    const claims = jwt.verify(token, JWT_SECRET);
    if (typeof claims !== "object" || claims === null || claims.sub !== "owner") {
      res.status(401).json({ error: "Invalid or expired session" });
      return;
    }
    res.json(issueSessionToken());
  } catch {
    res.status(401).json({ error: "Invalid or expired session" });
  }
}

/** Utility: generate a PIN hash for use in env vars */
export async function hashPin(pin: string): Promise<string> {
  return bcrypt.hash(pin, 10);
}
