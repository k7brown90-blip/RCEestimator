/**
 * Settings -> "Agent keys" (work order agent-team, K-U2). The routes behind the card that makes,
 * edits, rotates and revokes the keys the Grok agents (and Claude Code) use at /mcp and /api/hub/*.
 *
 * EVERY route here is behind the session gate (not public) and behind `requireBotKeys()`: the
 * `bot_keys` power, which Kyle always holds and others only if he grants it. The AI admin can never
 * pass. Reading is guarded too, so a session without the power learns nothing about the keys.
 *
 *   GET    /settings/agent-keys              the card's data: keys, the kill switch, pepper and write state
 *   POST   /settings/agent-keys              make a key; the secret comes back ONCE in this response
 *   PATCH  /settings/agent-keys/:id          name, scopes, hub thread kinds, expiry, allow-writes
 *   POST   /settings/agent-keys/:id/rotate   a new key with the same settings; the old one stops in 24 hours
 *   POST   /settings/agent-keys/:id/revoke   the exit: the key stops at once. Rows are never deleted
 *
 * The kill switch is NOT here: it is the one owner-settings key `agentAccess`, written only through
 * PUT /owner-settings/agentAccess (routes/ownerSettings.ts), so there is one writer.
 *
 * Nothing returned ever carries a hash. The plaintext key exists in exactly two responses (create and
 * rotate) and is never stored, logged or audited. Every change writes a SystemEvent (source
 * "agent_keys") naming the actor and the key's id and name. Revoke and scope edits apply to the very
 * next agent call: the gate loads the key row on every request (stateless /mcp, team answer 12).
 */
import express from "express";
import { Prisma, type AgentKey } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { asyncHandler, readParam } from "../lib/routeHelpers";
import { actorNameOf } from "../lib/actorName";
import { requireBotKeys } from "../middleware/kylePowers";
import type { RequestAuthState } from "../middleware/accessLog";
import { getAgentAccess } from "../services/ownerSettings";
import { logSystemEvent } from "../services/systemEvents";
import {
  AgentKeyInputError, AgentKeyPepperMissingError, currentAgentEnvironment, mintAgentKey, validateScopes,
} from "../agentApi/keys";
import {
  AGENT_ROLES, AGENT_WRITE_TOOLS_AVAILABLE, AGENT_WRITES_NOT_YET_REASON, HUB_THREAD_KIND_KEYS, isHubThreadKind,
} from "../../shared/agentScopes";
import { toChicagoIso } from "../../shared/calendarDay";
import { zonedWallToInstant } from "../../shared/businessDays";

export const agentKeysRouter = express.Router();

const guard = requireBotKeys();
export const PEPPER_UNSET_REASON = "Set AGENT_KEY_PEPPER in Railway first.";
export const ROTATION_OVERLAP_MS = 24 * 60 * 60 * 1000;

export type AgentKeyStatus = "active" | "retiring" | "retired" | "revoked" | "expired";

/** A key as the card sees it: everything but the hash. Times are Chicago ISO. */
export interface AgentKeyView {
  id: string;
  name: string;
  agentRole: string;
  environment: string;
  displayPrefix: string;
  scopes: string[];
  hubThreadKinds: string[];
  writesEnabled: boolean;
  expiresAt: string | null;
  retiresAt: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
  lastUsedAt: string | null;
  lastUsedTool: string | null;
  createdAt: string;
  createdBy: string;
  rotatedFromId: string | null;
  status: AgentKeyStatus;
}

export function agentKeyStatus(row: AgentKey, now: Date = new Date()): AgentKeyStatus {
  if (row.revokedAt) return "revoked";
  if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) return "expired";
  if (row.retiresAt) return row.retiresAt.getTime() <= now.getTime() ? "retired" : "retiring";
  return "active";
}

const iso = (d: Date | null): string | null => (d ? toChicagoIso(d) : null);

export function toAgentKeyView(row: AgentKey, now: Date = new Date()): AgentKeyView {
  return {
    id: row.id,
    name: row.name,
    agentRole: row.agentRole,
    environment: row.environment,
    displayPrefix: row.displayPrefix,
    scopes: [...row.scopes],
    hubThreadKinds: [...row.hubThreadKinds],
    writesEnabled: row.writesEnabled,
    expiresAt: iso(row.expiresAt),
    retiresAt: iso(row.retiresAt),
    revokedAt: iso(row.revokedAt),
    revokedReason: row.revokedReason,
    lastUsedAt: iso(row.lastUsedAt),
    lastUsedTool: row.lastUsedTool,
    createdAt: toChicagoIso(row.createdAt),
    createdBy: row.createdBy,
    rotatedFromId: row.rotatedFromId,
    status: agentKeyStatus(row, now),
  };
}

/** `YYYY-MM-DD` means the END of that Chicago day (23:59); an ISO time with an offset is taken as it is. Must be in the future. */
function parseExpiry(value: string, now: Date = new Date()): Date {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const date = day
    ? zonedWallToInstant(Number(day[1]), Number(day[2]), Number(day[3]), 23, 59)
    : new Date(value);
  if (Number.isNaN(date.getTime())) throw new AgentKeyInputError("Expiry is not a valid date.");
  if (date.getTime() <= now.getTime()) throw new AgentKeyInputError("Expiry must be in the future.");
  return date;
}

const expirySchema = z.union([z.iso.date(), z.iso.datetime({ offset: true })]);
const nameSchema = z.string().trim().min(1, "A key needs a name.").max(100, "The name is too long.");
const scopesSchema = z.array(z.string().max(60)).max(60);
const kindsSchema = z.array(z.string().max(30)).max(10);

const createSchema = z.object({
  name: nameSchema,
  agentRole: z.enum(AGENT_ROLES),
  scopes: scopesSchema.optional(),
  hubThreadKinds: kindsSchema.optional(),
  expiresAt: expirySchema.nullable().optional(),
}).strict();

const patchSchema = z.object({
  name: nameSchema.optional(),
  scopes: scopesSchema.optional(),
  hubThreadKinds: kindsSchema.optional(),
  writesEnabled: z.boolean().optional(),
  expiresAt: expirySchema.nullable().optional(),
}).strict();

function validKinds(kinds: readonly string[]): string[] {
  const bad = kinds.filter((k) => !isHubThreadKind(k));
  if (bad.length > 0) {
    throw new AgentKeyInputError(`Unknown hub thread kind: ${bad.join(", ")}. Valid kinds: ${HUB_THREAD_KIND_KEYS.join(", ")}`);
  }
  return [...new Set(kinds)];
}

/** Who made a change, for createdBy: "owner" for the PIN, the CRM login id for a person. */
function creatorOf(req: express.Request): string {
  const state = req as express.Request & RequestAuthState;
  return state._crmLogin ? `user:${state._crmLogin.id}` : "owner";
}

function audit(message: string, req: express.Request, actor: string, key: { id: string; name: string }, extra: Record<string, unknown> = {}): void {
  logSystemEvent("info", "agent_keys", message, { route: `${req.method} ${req.baseUrl}${req.path}`.replace(/\/[a-z0-9]{20,}/gi, "/:id"), actor, keyId: key.id, keyName: key.name, ...extra });
}

/** Turn what a handler may throw into the plain `{ error }` the CRM's request helper shows. */
function refuse(res: express.Response, err: unknown): boolean {
  if (err instanceof z.ZodError) {
    res.status(400).json({ error: err.issues.map((i) => i.message).join(" ") });
    return true;
  }
  if (err instanceof AgentKeyInputError) {
    res.status(400).json({ error: err.message });
    return true;
  }
  if (err instanceof AgentKeyPepperMissingError) {
    res.status(503).json({ error: PEPPER_UNSET_REASON });
    return true;
  }
  return false;
}

agentKeysRouter.get("/settings/agent-keys", guard, asyncHandler(async (_req, res) => {
  const now = new Date();
  const [rows, agentAccess] = await Promise.all([
    prisma.agentKey.findMany({ orderBy: { createdAt: "desc" } }),
    getAgentAccess(),
  ]);
  res.json({
    pepperConfigured: Boolean(process.env.AGENT_KEY_PEPPER),
    environment: currentAgentEnvironment(),
    writeToolsAvailable: AGENT_WRITE_TOOLS_AVAILABLE,
    agentAccess,
    keys: rows.map((r) => toAgentKeyView(r, now)),
  });
}));

agentKeysRouter.post("/settings/agent-keys", guard, asyncHandler(async (req, res) => {
  try {
    const body = createSchema.parse(req.body);
    const actor = await actorNameOf(req);
    const { key, row } = await mintAgentKey({
      name: body.name,
      agentRole: body.agentRole,
      scopes: body.scopes ? validateScopes(body.scopes) : undefined,
      hubThreadKinds: body.hubThreadKinds ? validKinds(body.hubThreadKinds) : undefined,
      expiresAt: body.expiresAt ? parseExpiry(body.expiresAt) : null,
      createdBy: creatorOf(req),
    });
    audit("Agent key created", req, actor, row, { agentRole: row.agentRole, scopes: row.scopes, environment: row.environment });
    // The plaintext is in THIS response only.
    res.status(201).json({ key: toAgentKeyView(row), secret: key });
  } catch (err) {
    if (!refuse(res, err)) throw err;
  }
}));

agentKeysRouter.patch("/settings/agent-keys/:id", guard, asyncHandler(async (req, res) => {
  try {
    const id = readParam(req, "id");
    const body = patchSchema.parse(req.body);
    const existing = await prisma.agentKey.findUnique({ where: { id } });
    if (!existing) {
      res.status(404).json({ error: "That key does not exist." });
      return;
    }
    if (existing.revokedAt) {
      res.status(409).json({ error: "This key is revoked and cannot be edited. Make a new key instead." });
      return;
    }
    if (body.writesEnabled === true && !AGENT_WRITE_TOOLS_AVAILABLE) {
      res.status(409).json({ error: AGENT_WRITES_NOT_YET_REASON });
      return;
    }
    const data: Prisma.AgentKeyUpdateInput = {};
    if (body.name !== undefined) data.name = body.name;
    if (body.scopes !== undefined) data.scopes = validateScopes(body.scopes);
    if (body.hubThreadKinds !== undefined) data.hubThreadKinds = validKinds(body.hubThreadKinds);
    if (body.writesEnabled !== undefined) data.writesEnabled = body.writesEnabled;
    if (body.expiresAt !== undefined) data.expiresAt = body.expiresAt === null ? null : parseExpiry(body.expiresAt);
    const row = await prisma.agentKey.update({ where: { id }, data });
    audit("Agent key changed", req, await actorNameOf(req), row, { changed: Object.keys(body) });
    res.json({ key: toAgentKeyView(row) });
  } catch (err) {
    if (!refuse(res, err)) throw err;
  }
}));

agentKeysRouter.post("/settings/agent-keys/:id/rotate", guard, asyncHandler(async (req, res) => {
  try {
    const id = readParam(req, "id");
    const old = await prisma.agentKey.findUnique({ where: { id } });
    if (!old) {
      res.status(404).json({ error: "That key does not exist." });
      return;
    }
    const status = agentKeyStatus(old);
    if (status !== "active") {
      res.status(409).json({ error: status === "retiring" ? "This key is already being replaced." : "Only an active key can be rotated." });
      return;
    }
    const retiresAt = new Date(Date.now() + ROTATION_OVERLAP_MS);
    const made = await prisma.$transaction(async (tx) => {
      const fresh = await mintAgentKey({
        name: old.name, agentRole: old.agentRole as (typeof AGENT_ROLES)[number], scopes: old.scopes,
        hubThreadKinds: old.hubThreadKinds, writesEnabled: old.writesEnabled, expiresAt: old.expiresAt,
        rotatedFromId: old.id, createdBy: creatorOf(req),
      }, tx);
      const retired = await tx.agentKey.update({ where: { id: old.id }, data: { retiresAt } });
      return { ...fresh, retired };
    });
    audit("Agent key rotated", req, await actorNameOf(req), old, { newKeyId: made.row.id, retiresAt: retiresAt.toISOString() });
    res.status(201).json({ key: toAgentKeyView(made.row), retired: toAgentKeyView(made.retired), secret: made.key });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      res.status(409).json({ error: "This key was already rotated." });
      return;
    }
    if (!refuse(res, err)) throw err;
  }
}));

agentKeysRouter.post("/settings/agent-keys/:id/revoke", guard, asyncHandler(async (req, res) => {
  try {
    const id = readParam(req, "id");
    const { reason } = z.object({ reason: z.string().trim().max(200).optional() }).strict().parse(req.body ?? {});
    const existing = await prisma.agentKey.findUnique({ where: { id } });
    if (!existing) {
      res.status(404).json({ error: "That key does not exist." });
      return;
    }
    if (existing.revokedAt) {
      res.json({ key: toAgentKeyView(existing) });
      return;
    }
    const row = await prisma.agentKey.update({ where: { id }, data: { revokedAt: new Date(), revokedReason: reason || null } });
    audit("Agent key revoked", req, await actorNameOf(req), row, { reason: reason || null });
    res.json({ key: toAgentKeyView(row) });
  } catch (err) {
    if (!refuse(res, err)) throw err;
  }
}));
