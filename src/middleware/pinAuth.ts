import type { Request, Response, NextFunction } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { isPublicRoute } from "./publicRoutes";
import type { AuthOutcome, RequestAuthState } from "./accessLog";
import { AI_ADMIN_SUB, currentAdminLoginFor, getAdminLogin } from "../services/adminLogin";
import { CRM_USER_SUB_PREFIX, currentCrmLoginFor, findCrmLoginByUsername, getPrincipalLogin } from "../services/crmLogin";
import { CRM_POWER_KEYS } from "../../shared/crmPowers";
import { isKyle } from "./kylePowers";
import { prisma } from "../lib/prisma";
import { agentKeyRouteFor } from "./publicRoutes";
import { isAgentKeyShaped } from "../agentApi/keys";
import { agentKeyGate } from "../agentApi/gate";

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
 * The AI admin's sign-in lasts a day, not 8 hours. Kyle, 2026-11-22: "I don't want the login to expire until
 * we fix this, I need the agent to have at least 24 hours of access so when leads come in it isn't locked out".
 * It is still renewed while in use, and still ends at once when its login is saved, turned off or removed
 * (the gate checks the row and `ver` on every request). The PIN and a person's login stay at 8 hours.
 */
const AI_ADMIN_SESSION_HOURS = 24;

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
  // A route that lists agent keys (AGENT_KEY_ROUTES, work order agent-team K-U1) hands a key-shaped
  // bearer to the agent gate FIRST, ahead of every PIN_HASH branch below, so that the dev/test
  // convenience (no PIN_HASH) and a misconfigured production can never leave an agent route without
  // its key check. An agent-only route (/mcp) hands over every request, key or not.
  const agentRoute = agentKeyRouteFor(req.method, req.path);
  if (agentRoute && (agentRoute.agentOnly || isAgentKeyShaped(req.headers.authorization?.replace("Bearer ", "")))) {
    agentKeyGate(req, res, next);
    return;
  }

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

  // An agent key (rce_live_ / rce_test_) is a different credential from every session token and is
  // never given a session (work order agent-team, K-U1). On a route that lists agent keys
  // (AGENT_KEY_ROUTES) it already went to the agent gate at the top of this function; anywhere else
  // it is refused here, before jwt.verify and before any identity is built.
  if (isAgentKeyShaped(token)) {
    mark(req, "agent-key");
    res.status(401).json({ code: "agent_key_not_accepted", reason: "Agent keys are not accepted here. Agent keys work on GET /api/hub/threads, GET /api/hub/threads/:id/messages, POST /api/hub/messages and /mcp.", retryable: false });
    return;
  }

  let claims: string | jwt.JwtPayload;
  try {
    claims = jwt.verify(token, JWT_SECRET);
  } catch {
    mark(req, "bad-credentials");
    res.status(401).json({ error: "Invalid or expired session" });
    return;
  }

  // `sub` is "owner" for the PIN session, "ai-admin" for the AI admin's own login and "user:<id>"
  // for a person's CRM login. It is an identity, never a credential — the token itself must not
  // reach the log.
  const actor = typeof claims === "object" && claims !== null && typeof claims.sub === "string"
    ? claims.sub
    : "unknown";

  if (actor.startsWith(CRM_USER_SUB_PREFIX)) {
    // A person's CRM login is only as good as its row: still on, same session version, the roster
    // person still active. Role and powers are read from the row on THIS request, never from the
    // token, so a grant, revoke or role change takes effect at once. A database error fails CLOSED.
    const c = claims as jwt.JwtPayload;
    void (async () => {
      let row: Awaited<ReturnType<typeof currentCrmLoginFor>> = null;
      try {
        row = await currentCrmLoginFor(c.lid, c.ver);
      } catch {
        row = null;
      }
      if (!row || actor !== `${CRM_USER_SUB_PREFIX}${row.id}`) {
        mark(req, "bad-credentials");
        res.status(401).json({ error: "Invalid or expired session" });
        return;
      }
      (req as Request & RequestAuthState)._crmLogin = {
        id: row.id,
        technicianId: row.technicianId,
        name: row.technician.name,
        username: row.username,
        role: row.role,
        isPrincipal: row.isPrincipal,
        powers: [...row.powers],
      };
      mark(req, "ok", actor);
      next();
    })();
    return;
  }

  if (actor !== AI_ADMIN_SUB) {
    // Kyle's PIN session: unchanged, no database read.
    mark(req, "ok", actor);
    next();
    return;
  }

  // The AI admin's session is only as good as its login row: still on, same row, same session
  // version. Save login and Turn off bump the version, so this refuses the very next request.
  // A database error fails CLOSED.
  const c = claims as jwt.JwtPayload;
  void (async () => {
    let row: unknown = null;
    try {
      row = await currentAdminLoginFor(c.aid, c.ver);
    } catch {
      row = null;
    }
    if (!row) {
      mark(req, "bad-credentials");
      res.status(401).json({ error: "Invalid or expired session" });
      return;
    }
    mark(req, "ok", actor);
    next();
  })();
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
 * Who a session token is for. `ver` and `aid` tie an ai-admin token to its AdminLogin row; `lid` and
 * `ver` tie a person's token to their CrmLogin row. The token carries NO role and NO powers - the
 * gate reads those from the row on every request.
 */
type SessionIdentity =
  | { sub: "owner" }
  | { sub: typeof AI_ADMIN_SUB; ver: number; aid: string }
  | { sub: `user:${string}`; lid: string; ver: number };

/**
 * The one place a session token is signed. PIN login, username/password login and refresh all call
 * it, so a session's length and claims cannot drift between the doors. The AI admin's token also
 * carries the login row's `aid` and `sessionVersion` as `ver`; the gate compares both on every
 * request, which is how Save login / Turn off / Remove login end that session at once.
 */
function issueSessionToken(identity: SessionIdentity = { sub: "owner" }): { token: string; expiresIn: number } {
  const hours = identity.sub === AI_ADMIN_SUB ? AI_ADMIN_SESSION_HOURS : SESSION_HOURS;
  const token = jwt.sign({ ...identity }, JWT_SECRET, {
    expiresIn: `${hours}h`,
  });
  return { token, expiresIn: hours * 60 * 60 };
}

/**
 * A real bcrypt hash that no password matches, compared against when the username is unknown (or
 * the login is off), so a miss costs the same time as a wrong password and does not reveal which
 * usernames exist.
 */
const NO_SUCH_LOGIN_HASH = bcrypt.hashSync("no-such-login-" + Math.random().toString(36), 10);

const BAD_LOGIN = { error: "Invalid username or password" };

/**
 * POST /auth/login — the username/password sign-in: the AI admin (Kyle, 2026-11-15) and a person's
 * CRM login (work order agent-team, HA2) share this one door. PUBLIC (publicRoutes.ts, and on the
 * publicLimiter list in app.ts), like /auth/pin, because it cannot require the session it issues.
 * The AdminLogin row and the CrmLogin row are BOTH looked up, concurrently, on every attempt (one
 * query each), and the AI admin's row wins when both match (the two tables may not share a username).
 * Every way to fail — missing field, unknown user, wrong password, login turned off, no password set,
 * roster person deactivated, a tech-role login (no CRM sign-in yet) — is the SAME 401 body, and
 * exactly ONE bcrypt compare runs in every case (against a throwaway hash when there is no usable
 * row), so neither the body nor the number of database round trips nor the timing says which
 * usernames exist.
 * Credentials arrive in the JSON body only, never a URL.
 */
export async function handleAdminLogin(req: Request, res: Response): Promise<void> {
  const body = (req.body ?? {}) as { username?: unknown; password?: unknown };
  const username = typeof body.username === "string" ? body.username.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";

  // A control character (a NUL above all — Postgres refuses it in a text parameter) is never a
  // saved username, so it is a miss like any other: no lookup to throw a 500, same compare, same 401.
  const lookupable = username !== "" && !/[\u0000-\u001f\u007f]/.test(username);
  // BOTH lookups run, concurrently, for every attempt - one query each - so the number of database
  // round trips is the same whether the name is unknown, the AI admin's or a person's. The AI
  // admin's row wins when both match (the two tables may not share a username). The person lookup is
  // case-insensitive: the service refuses two logins that differ only by case, so there is at most one.
  const [row, person] = lookupable
    ? await Promise.all([prisma.adminLogin.findUnique({ where: { username } }), findCrmLoginByUsername(username)])
    : [null, null];
  // The ONE compare. A null password hash counts as a miss: compare against the throwaway.
  const hash = row?.passwordHash ?? person?.passwordHash ?? NO_SUCH_LOGIN_HASH;
  const matches = await bcrypt.compare(password, hash);

  if (row) {
    if (!row.enabled || !password || !matches) {
      res.status(401).json(BAD_LOGIN);
      return;
    }
    res.json(issueSessionToken({ sub: AI_ADMIN_SUB, ver: row.sessionVersion, aid: row.id }));
    return;
  }

  // A tech-role login has no CRM sign-in yet: the same plain 401 as every other miss.
  if (!person || !person.enabled || person.role === "tech" || person.passwordHash === null
    || !person.technician.isActive || !password || !matches) {
    res.status(401).json(BAD_LOGIN);
    return;
  }
  res.json(issueSessionToken({
    sub: `${CRM_USER_SUB_PREFIX}${person.id}`, lid: person.id, ver: person.sessionVersion,
  }));
}

/**
 * POST /auth/refresh — a still-valid session token buys a fresh one (sliding renewal, no cap), so a
 * session in use is never locked out at the 8-hour mark. It is NOT a public route: it sits behind
 * pinAuthMiddleware like everything else, and this handler re-verifies the token itself (defence
 * in depth — it does not trust that the gate ran). A login (PIN, or username and password) is the
 * only way to START a session; an expired or invalid token gets 401, never a new one. The AI
 * admin's token renews only while its login is still on and its version still matches, and the
 * fresh token carries the same `ver`/`aid`. Header only — no token in a URL.
 */
export async function handleSessionRefresh(req: Request, res: Response): Promise<void> {
  const refuse = () => { res.status(401).json({ error: "Invalid or expired session" }); };
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  let claims: string | jwt.JwtPayload;
  try {
    claims = jwt.verify(token, JWT_SECRET);
  } catch {
    refuse();
    return;
  }
  if (typeof claims !== "object" || claims === null) {
    refuse();
    return;
  }
  if (claims.sub === "owner") {
    res.json(issueSessionToken());
    return;
  }
  if (typeof claims.sub === "string" && claims.sub.startsWith(CRM_USER_SUB_PREFIX)) {
    // A person's session renews only while the login is still on, the version matches and the
    // roster person is active; the fresh token carries the same `lid`/`ver`.
    let row = null;
    try {
      row = await currentCrmLoginFor(claims.lid, claims.ver);
    } catch {
      row = null;
    }
    if (!row || claims.sub !== `${CRM_USER_SUB_PREFIX}${row.id}`) {
      refuse();
      return;
    }
    res.json(issueSessionToken({ sub: `${CRM_USER_SUB_PREFIX}${row.id}`, lid: row.id, ver: row.sessionVersion }));
    return;
  }
  if (claims.sub === AI_ADMIN_SUB) {
    let row = null;
    try {
      row = await currentAdminLoginFor(claims.aid, claims.ver);
    } catch {
      row = null;
    }
    if (!row) {
      refuse();
      return;
    }
    res.json(issueSessionToken({ sub: AI_ADMIN_SUB, ver: row.sessionVersion, aid: row.id }));
    return;
  }
  refuse();
}

/** The ONE who-am-I (work order agent-team, HA2): what kind of session this is, and what it may do. */
export interface SessionView {
  kind: "kyle-pin" | "user" | "ai-admin";
  name: string;
  role: string;
  isKyle: boolean;
  /** The Kyle-only powers this session holds (shared/crmPowers.ts keys). */
  powers: string[];
}

/**
 * GET /auth/session — who the caller is. Behind the session gate (NOT on the public allowlist), so
 * it answers only a session the gate already accepted, and for a person it reflects the row as it
 * is on THIS request (role and powers read fresh by the gate). Returns no token and no hash.
 *
 *   * the PIN (or the gate-disabled dev/test convenience): kind "kyle-pin", role "owner", every
 *     power. The name is the principal CRM login's person when Kyle has marked one, else "Kyle".
 *   * a person's login: kind "user", their own role; every power if it is the principal login,
 *     otherwise exactly the powers Kyle granted.
 *   * the AI admin: kind "ai-admin", no powers, isKyle false.
 */
export async function handleAuthSession(req: Request, res: Response): Promise<void> {
  const state = req as Request & RequestAuthState;
  let view: SessionView;

  if (state._crmLogin) {
    const login = state._crmLogin;
    view = {
      kind: "user",
      name: login.name,
      role: login.role,
      isKyle: isKyle(req),
      powers: login.isPrincipal ? [...CRM_POWER_KEYS] : [...login.powers],
    };
  } else if (state._authActor === AI_ADMIN_SUB) {
    let name = "AI admin";
    try {
      name = (await getAdminLogin())?.username ?? name;
    } catch {
      // The name is decoration; the answer does not depend on it.
    }
    view = { kind: "ai-admin", name, role: "ai-admin", isKyle: false, powers: [] };
  } else if (state._authActor === "owner" || state._authOutcome === "gate-disabled") {
    let name = "Kyle";
    try {
      name = (await getPrincipalLogin())?.technician.name ?? name;
    } catch {
      // Same: fall back to the plain name.
    }
    view = { kind: "kyle-pin", name, role: "owner", isKyle: true, powers: [...CRM_POWER_KEYS] };
  } else {
    res.status(401).json({ error: "Invalid or expired session" });
    return;
  }
  res.json(view);
}

/** Utility: generate a PIN hash for use in env vars */
export async function hashPin(pin: string): Promise<string> {
  return bcrypt.hash(pin, 10);
}
