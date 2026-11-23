/**
 * The ONE agent gate (work order agent-team, K-U1): every agent call, on /mcp and on REST /api/hub/*,
 * passes through agentKeyGate and nothing else decides whether an agent key is good.
 *
 * Order, and why:
 *   1. A per-IP limiter, in front of key resolution, so key guessing and floods are bounded before
 *      any database read. A request it stops is not audited (the audit would be the flood's target).
 *   2. The bearer must look like a key: `rce_<env>_` + 43 base64url characters. A session JWT, an
 *      owner or ai-admin token, a technician token and a mangled key all fail here with NO database
 *      read, as 401 `unauthenticated`. Agent keys are a separate credential from every human door.
 *   3. The label must match this deployment (live on Railway production, test elsewhere).
 *   4. AGENT_KEY_PEPPER must be set, or 503 `not_configured` (fail closed; not a boot check).
 *   5. Look the key up by its HMAC hash. Unknown is 401. Then revoked, expired, retired (rotation
 *      overlap over), and the row's own environment.
 *   6. The kill switch (owner setting agentAccess), read from the row on EVERY request, no cache:
 *      off is 503 `agents_off`; read_only refuses writes and drafts.
 *   7. The per-key limiter, 60 calls a minute: 429 `rate_limited` with Retry-After.
 *   8. The route's own rule (AGENT_KEY_ROUTES in middleware/publicRoutes.ts): the scope, whether it
 *      is a write (the key's writes switch must be on) and whether it makes a draft (500 a Chicago
 *      day, counted from the audit). A path no entry covers is refused: nothing is open by default.
 *   9. req.agentPrincipal is set and the request continues.
 *
 * Every refusal after step 1 writes ONE audit row (src/agentApi/audit.ts) before the response, and
 * is a `{code, reason, retryable}` body. A successful call writes its row through `finishAgentCall`.
 * Revocation needs no extra step: the key row is loaded on every request, so a revoke or a scope edit
 * applies to the very next call (the stateless /mcp ruling, team answer 12).
 *
 * The gate is mounted by pinAuthMiddleware (middleware/pinAuth.ts) for exactly the routes in AGENT_KEY_ROUTES:
 * today the three REST /api/hub/* routes (K-U7, src/agentApi/hubDoor.ts); /mcp (Step 2) adds its own entry.
 * Nothing here is public: it adds nothing to PUBLIC_ROUTES.
 */
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { rateLimit } from "express-rate-limit";
import type { AgentKey } from "@prisma/client";
import { agentKeyRouteFor, AGENT_KEY_ROUTES, type AgentKeyRoute } from "../middleware/publicRoutes";
import type { RequestAuthState } from "../middleware/accessLog";
import { getAgentAccess, type AgentAccessMode } from "../services/ownerSettings";
import { prisma } from "../lib/prisma";
import { shiftDate, zonedParts, zonedWallToInstant } from "../../shared/businessDays";
import { CALENDAR_DAY_TIME_ZONE } from "../../shared/calendarDay";
import { isAgentScope, type AgentScope } from "../../shared/agentScopes";
import {
  AGENT_KEY_SHAPE, AgentKeyPepperMissingError, bearerFrom, currentAgentEnvironment, findAgentKey,
  type AgentKeyEnvironment,
} from "./keys";
import { AGENT_DAILY_DRAFT_LIMIT, countDraftsToday, recordAgentCall, type AgentCallRecord, type AgentDoor } from "./audit";
import { agentErrorBody, AGENT_ERRORS, toAgentError, type AgentErrorCode, type AgentErrorBody } from "./errors";

export { AGENT_KEY_ROUTES, agentKeyRouteFor };
export type { AgentKeyRoute };

/** Who the gate decided this caller is. Built from the key row on THIS request, never cached. */
export interface AgentPrincipal {
  keyId: string;
  name: string;
  role: string;
  env: AgentKeyEnvironment;
  scopes: AgentScope[];
  writesEnabled: boolean;
  /** Hub thread kinds the key is limited to; empty means no limit. */
  hubThreadKinds: string[];
  /** The kill switch as it read on this request. */
  mode: AgentAccessMode;
}

export interface AgentRequestState {
  agentPrincipal?: AgentPrincipal;
  /** When the gate accepted the call, and through which door, for the audit row. */
  agentCall?: { startedAt: number; door: AgentDoor; route: AgentKeyRoute | null };
}

export type AgentRequest = Request & AgentRequestState & RequestAuthState;

export const AGENT_PER_KEY_PER_MINUTE = 60;
export const AGENT_PER_IP_PER_MINUTE = 600;
const LAST_USED_EVERY_MS = 60_000;

/**
 * Draft calls this process has let through that have not finished yet, per key. The daily cap counts
 * audit rows, and a draft's row is written only when its call finishes, so without this a burst of
 * parallel calls at 499 would all read 499 and overshoot 500. The gate reserves a slot before
 * next() and releases it when the response ends (by which time the audit row is in). One process
 * only: with more than one replica, serialise per key in the database instead (advisory lock).
 */
const draftsInFlight = new Map<string, number>();

export interface AgentKeyGateOptions {
  perKeyPerMinute?: number;
  perIpPerMinute?: number;
  dailyDraftLimit?: number;
  /** The route table; production uses AGENT_KEY_ROUTES. Tests pass their own. */
  routes?: readonly AgentKeyRoute[];
  /** The clock, for tests. */
  now?: () => Date;
}

function nextChicagoMidnight(now: Date): Date {
  const p = zonedParts(now, CALENDAR_DAY_TIME_ZONE);
  const next = shiftDate(p.year, p.month, p.day, 1);
  return zonedWallToInstant(next.year, next.month, next.day, 0, 0, CALENDAR_DAY_TIME_ZONE);
}

function doorOf(path: string): AgentDoor {
  const p = path.toLowerCase();
  return p === "/mcp" || p.startsWith("/mcp/") ? "mcp" : "rest";
}

/**
 * What the audit writes in `endpoint`: the METHOD and the matched entry's DECLARED path, never the
 * request's own path. The request path is chosen by whoever sends it (a refusal row can be written
 * with no valid key) and the table can never be pruned, so only text from our own route table, plus
 * a capped method, may go in.
 */
function auditRouteOf(method: string, route: AgentKeyRoute | null, door: AgentDoor): string {
  return `${method.toUpperCase().slice(0, 10)} ${route ? route.path : door === "mcp" ? "/mcp" : "unmatched"}`;
}

/** A name safe to put in the access log's `actor` field: no control characters, bounded. */
function actorName(name: string): string {
  return `agent:${name.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 60)}`;
}

function principalFrom(row: AgentKey, mode: AgentAccessMode): AgentPrincipal {
  return {
    keyId: row.id,
    name: row.name,
    role: row.agentRole,
    env: row.environment === "live" ? "live" : "test",
    scopes: row.scopes.filter(isAgentScope),
    writesEnabled: row.writesEnabled,
    hubThreadKinds: [...row.hubThreadKinds],
    mode,
  };
}

/** Send an agent error body with its status (and Retry-After for a 429). No audit: callers record first. */
function sendError(res: Response, status: number, body: AgentErrorBody): void {
  if (body.retry_after !== undefined) res.setHeader("Retry-After", String(body.retry_after));
  res.status(status).json(body);
}

export function createAgentKeyGate(options: AgentKeyGateOptions = {}): RequestHandler {
  const clock = options.now ?? (() => new Date());
  const dailyDraftLimit = options.dailyDraftLimit ?? AGENT_DAILY_DRAFT_LIMIT;

  // Both limiters hand control back through next(): the gate decides the body and writes the audit.
  const ipLimiter = rateLimit({
    windowMs: 60_000,
    limit: options.perIpPerMinute ?? AGENT_PER_IP_PER_MINUTE,
    standardHeaders: false,
    legacyHeaders: false,
    handler: (req, _res, next) => {
      (req as Request & { _agentIpLimited?: number })._agentIpLimited = retrySeconds(req, clock());
      next();
    },
  });
  const keyLimiter = rateLimit({
    windowMs: 60_000,
    limit: options.perKeyPerMinute ?? AGENT_PER_KEY_PER_MINUTE,
    standardHeaders: false,
    legacyHeaders: false,
    keyGenerator: (req) => (req as AgentRequest & { _agentKeyIdForLimit?: string })._agentKeyIdForLimit ?? "unknown",
    handler: (req, _res, next) => {
      (req as Request & { _agentKeyLimited?: number })._agentKeyLimited = retrySeconds(req, clock());
      next();
    },
  });

  function retrySeconds(req: Request, now: Date): number {
    const reset = (req as Request & { rateLimit?: { resetTime?: Date } }).rateLimit?.resetTime;
    return reset ? Math.max(1, Math.ceil((reset.getTime() - now.getTime()) / 1000)) : 60;
  }

  const run = (limiter: RequestHandler, req: Request, res: Response): Promise<void> =>
    new Promise((resolve, reject) => {
      limiter(req, res, (err?: unknown) => (err ? reject(err) : resolve()));
    });

  return (req: Request, res: Response, next: NextFunction): void => {
    void (async () => {
      const startedAt = Date.now();
      const state = req as AgentRequest;
      const path = req.baseUrl + req.path;
      const door = doorOf(path);
      const route = agentKeyRouteFor(req.method, path, options.routes ?? AGENT_KEY_ROUTES);
      const auditRoute = auditRouteOf(req.method, route, door);
      const tool = route?.tool ?? auditRoute;
      let row: AgentKey | null = null;
      let scopeUsed: string | null = null;

      /** Audit, then answer. If the audit insert fails the caller gets a 500 and no more. */
      const refuse = async (code: AgentErrorCode, extra: { retryAfterSeconds?: number } = {}): Promise<void> => {
        const body = agentErrorBody(code, extra);
        try {
          await recordAgentCall({
            agentKeyId: row?.id ?? null,
            agentRole: row?.agentRole ?? null,
            tool,
            route: auditRoute,
            door,
            scopeUsed,
            resultCode: code,
            status: AGENT_ERRORS[code].status,
            durationMs: Date.now() - startedAt,
          });
        } catch (err) {
          const e = toAgentError(err, auditRoute);
          sendError(res, e.status, e.body);
          return;
        }
        sendError(res, AGENT_ERRORS[code].status, body);
      };

      try {
        state._authOutcome = "agent-key";

        // 1. Per-IP, in front of key resolution.
        await run(ipLimiter, req, res);
        const ipRetry = (req as Request & { _agentIpLimited?: number })._agentIpLimited;
        if (ipRetry !== undefined) {
          sendError(res, 429, agentErrorBody("rate_limited", { retryAfterSeconds: ipRetry }));
          return;
        }

        // 2. Shape. No database read for anything that is not a key.
        const token = bearerFrom(req.headers.authorization);
        if (!token || !AGENT_KEY_SHAPE.test(token)) {
          await refuse("unauthenticated");
          return;
        }

        // 3. Label against this deployment.
        const now = clock();
        const env = currentAgentEnvironment();
        if (token.slice(4, 4 + env.length + 1) !== `${env}_`) {
          await refuse("key_wrong_environment");
          return;
        }

        // 4 and 5. The pepper, then the row.
        if (!process.env.AGENT_KEY_PEPPER) {
          await refuse("not_configured");
          return;
        }
        row = await findAgentKey(token, prisma);
        if (!row) {
          await refuse("unauthenticated");
          return;
        }
        state._authActor = actorName(row.name);
        if (row.environment !== env) {
          await refuse("key_wrong_environment");
          return;
        }
        if (row.revokedAt) { await refuse("key_revoked"); return; }
        if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) { await refuse("key_expired"); return; }
        if (row.retiresAt && row.retiresAt.getTime() <= now.getTime()) { await refuse("key_retired"); return; }

        // 6. The kill switch, read fresh.
        const { mode } = await getAgentAccess();
        if (mode === "off") { await refuse("agents_off"); return; }

        // 7. Per-key limiter.
        (req as AgentRequest & { _agentKeyIdForLimit?: string })._agentKeyIdForLimit = row.id;
        await run(keyLimiter, req, res);
        const keyRetry = (req as Request & { _agentKeyLimited?: number })._agentKeyLimited;
        if (keyRetry !== undefined) {
          await refuse("rate_limited", { retryAfterSeconds: keyRetry });
          return;
        }

        // 8. The route's own rule. A path no entry covers is refused.
        const principal = principalFrom(row, mode);
        if (!route) { await refuse("scope_denied"); return; }
        if (route.scope !== "any") {
          if (!principal.scopes.includes(route.scope)) { await refuse("scope_denied"); return; }
          scopeUsed = route.scope;
        }
        if (route.write || route.draft) {
          if (mode === "read_only") { await refuse("agents_read_only"); return; }
          if (!principal.writesEnabled) { await refuse("writes_disabled"); return; }
        }
        if (route.draft) {
          const made = await countDraftsToday(row.id, now, prisma);
          const pending = draftsInFlight.get(row.id) ?? 0;
          if (made + pending >= dailyDraftLimit) {
            await refuse("daily_draft_limit", {
              retryAfterSeconds: (nextChicagoMidnight(now).getTime() - now.getTime()) / 1000,
            });
            return;
          }
          // Reserve this call's slot (synchronously after the read above, so parallel calls cannot
          // both take the last one) and give it back when the response ends.
          const keyId = row.id;
          draftsInFlight.set(keyId, pending + 1);
          let released = false;
          const release = () => {
            if (released) return;
            released = true;
            const left = (draftsInFlight.get(keyId) ?? 1) - 1;
            if (left <= 0) draftsInFlight.delete(keyId);
            else draftsInFlight.set(keyId, left);
          };
          res.once("finish", release);
          res.once("close", release);
          // The client may have gone while the gate was awaiting the database, before these listeners
          // existed: 'close' already fired and will not fire again. Give the slot back at once.
          if (res.writableEnded || res.destroyed || req.socket?.destroyed) release();
        }

        // 9. In. lastUsedAt moves at most once a minute and never delays or fails the call.
        if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() >= LAST_USED_EVERY_MS) {
          void prisma.agentKey
            .updateMany({
              where: { id: row.id, OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: new Date(now.getTime() - LAST_USED_EVERY_MS) } }] },
              data: { lastUsedAt: now },
            })
            .catch(() => undefined);
        }
        state.agentPrincipal = principal;
        state.agentCall = { startedAt, door, route };
        next();
      } catch (err) {
        if (err instanceof AgentKeyPepperMissingError) {
          await refuse("not_configured");
          return;
        }
        // Log the real error (toAgentError writes it to SystemEvent), then answer a plain 500
        // through refuse(), so a gate failure also leaves its ONE audit row.
        toAgentError(err, auditRoute);
        if (!res.headersSent) await refuse("internal");
      }
    })();
  };
}

/** The gate production mounts. */
export const agentKeyGate: RequestHandler = createAgentKeyGate();

export interface FinishAgentCall {
  /** The HTTP status of the answer. */
  status: number;
  body: unknown;
  /** The tool name; defaults to the route's. */
  tool?: string;
  /** Ids only. */
  recordIds?: readonly string[];
  /** "ok", "replayed" or an error code. Defaults to ok for a 2xx. */
  resultCode?: string;
  /** True when the call made a draft. */
  madeDraft?: boolean;
  /** The raw idempotency key; stored only as its sha256. */
  idempotencyKey?: string;
}

/**
 * The audit row for a call the gate let through, as data. A WRITE builds it with this and inserts it
 * with `recordAgentCall(record, tx)` INSIDE the withIdempotency callback, after the effect, so the
 * row commits or rolls back with the write; it then sends with `sendAgentResult`. Throws when the
 * request did not come through the gate.
 */
export function agentAuditRecord(req: Request, result: FinishAgentCall): AgentCallRecord {
  const state = req as AgentRequest;
  const principal = state.agentPrincipal;
  const call = state.agentCall;
  if (!principal || !call) throw new Error("agentAuditRecord on a request the agent gate did not accept");
  const route = call.route;
  const auditRoute = auditRouteOf(req.method, route, call.door);
  return {
    agentKeyId: principal.keyId,
    agentRole: principal.role,
    tool: result.tool ?? route?.tool ?? auditRoute,
    route: auditRoute,
    door: call.door,
    scopeUsed: route && route.scope !== "any" ? route.scope : null,
    recordIds: result.recordIds,
    resultCode: result.resultCode ?? (result.status < 400 ? "ok" : "error"),
    status: result.status,
    durationMs: Date.now() - call.startedAt,
    idempotencyKey: result.idempotencyKey,
    madeDraft: result.madeDraft,
  };
}

/** Send an answer. For a write, call this only AFTER its audit row committed with the write. */
export function sendAgentResult(res: Response, status: number, body: unknown): void {
  res.status(status).json(body);
}

/**
 * The way a READ (or a refusal, or a replay) that got through the gate answers: write the audit row,
 * THEN send. If the insert fails the caller gets 500 `internal` and the data is not sent. A write
 * does not use this: it audits inside its own transaction (agentAuditRecord + recordAgentCall(tx)).
 */
export async function finishAgentCall(req: Request, res: Response, result: FinishAgentCall): Promise<void> {
  try {
    await recordAgentCall(agentAuditRecord(req, result));
  } catch (err) {
    const state = req as AgentRequest;
    const e = toAgentError(err, auditRouteOf(req.method, state.agentCall?.route ?? null, state.agentCall?.door ?? "rest"));
    sendError(res, e.status, e.body);
    return;
  }
  sendAgentResult(res, result.status, result.body);
}
