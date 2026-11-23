/**
 * Agent keys: mint, shape and hash (work order agent-team, K-U1). The ONE key store for the /mcp door
 * and the REST /api/hub/* door; src/agentApi/gate.ts is the ONE gate that reads it.
 *
 * Format: `rce_live_` or `rce_test_` + randomBytes(32) as base64url (43 characters). The label is the
 * environment the key was minted in (RAILWAY_ENVIRONMENT_NAME "production" is live, anything else
 * is test) and the gate refuses a key whose label does not match where it is presented.
 *
 * Storage: only HMAC-SHA256(AGENT_KEY_PEPPER, key) is kept, in AgentKey.secretHash (unique, the
 * lookup). The plaintext is returned once by mintAgentKey and is never stored or logged. With no
 * pepper set, nothing can be minted or looked up: hashAgentKey throws AgentKeyPepperMissingError and
 * the gate answers 503 not_configured. That is deliberately NOT a boot check, so a deploy that lacks
 * the variable still starts and only the agent door is closed.
 */
import { createHmac, randomBytes } from "node:crypto";
import type { Prisma, PrismaClient, AgentKey } from "@prisma/client";
import { prisma as defaultPrisma } from "../lib/prisma";
import {
  AGENT_SCOPES, DEFAULT_HUB_THREAD_KINDS_BY_ROLE, DEFAULT_SCOPES_BY_ROLE, isAgentRole, isAgentScope,
  type AgentRole, type AgentScope,
} from "../../shared/agentScopes";

export type AgentKeyEnvironment = "live" | "test";

/** A bearer that LOOKS like an agent key (not necessarily a real one). Used to keep keys off the human doors. */
export const AGENT_KEY_SHAPE = /^rce_(live|test)_[A-Za-z0-9_-]{43}$/;
/** Anything that starts like a key. The human doors refuse on this wider test, so a mangled key is also refused there. */
const AGENT_KEY_PREFIX = /^rce_(live|test)_/;

export class AgentKeyPepperMissingError extends Error {
  constructor() {
    super("AGENT_KEY_PEPPER is not set");
    this.name = "AgentKeyPepperMissingError";
  }
}

/** True when the bearer token starts like an agent key. No database read. */
export function isAgentKeyShaped(token: string | undefined | null): boolean {
  return typeof token === "string" && AGENT_KEY_PREFIX.test(token);
}

/**
 * An agent key that can still be used: not revoked, not expired, not retired. The ONE definition (W2-C): the Agent keys picker for a
 * group, the group-member check and the webhook fan-out's "every key that can read this thread" all read it, so a key a person can
 * no longer use is never offered, added or woken.
 */
export function activeKeyWhere(now: Date): Prisma.AgentKeyWhereInput {
  return {
    revokedAt: null,
    AND: [
      { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      { OR: [{ retiresAt: null }, { retiresAt: { gt: now } }] },
    ],
  };
}

/** The label this deployment mints and accepts: "live" on Railway production, "test" everywhere else. */
export function currentAgentEnvironment(): AgentKeyEnvironment {
  return process.env.RAILWAY_ENVIRONMENT_NAME === "production" ? "live" : "test";
}

/** HMAC-SHA256(AGENT_KEY_PEPPER, key), hex. Throws AgentKeyPepperMissingError when the pepper is unset. */
export function hashAgentKey(key: string): string {
  const pepper = process.env.AGENT_KEY_PEPPER;
  if (!pepper) throw new AgentKeyPepperMissingError();
  return createHmac("sha256", pepper).update(key).digest("hex");
}

/** Pull the bearer out of an Authorization header, or null. Header only; a key is never read from a URL. */
export function bearerFrom(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

export interface MintAgentKeyInput {
  name: string;
  agentRole: AgentRole;
  /** Defaults to the role's default scopes (shared/agentScopes.ts). */
  scopes?: readonly string[];
  /** Defaults to the role's default thread kinds. Empty means no limit. */
  hubThreadKinds?: readonly string[];
  writesEnabled?: boolean;
  /** W2: the "Team posts publish immediately" box. Defaults to ON (Kyle, 2026-11-23); a rotation copies the old key's. */
  teamPostsPublish?: boolean;
  expiresAt?: Date | null;
  retiresAt?: Date | null;
  rotatedFromId?: string | null;
  /** Who minted it: "owner" or a CRM login id. Never a key. */
  createdBy: string;
  /** Override the environment label (tests only); production code takes it from the deployment. */
  environment?: AgentKeyEnvironment;
}

export class AgentKeyInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentKeyInputError";
  }
}

/** Validate a scope list against the one scope enum. Returns the de-duplicated list; throws on an unknown scope. */
export function validateScopes(scopes: readonly string[]): AgentScope[] {
  const unknown = scopes.filter((s) => !isAgentScope(s));
  if (unknown.length > 0) {
    throw new AgentKeyInputError(`Unknown scope: ${unknown.join(", ")}. Valid scopes: ${Object.keys(AGENT_SCOPES).join(", ")}`);
  }
  return [...new Set(scopes as AgentScope[])];
}

/**
 * Make a key. Returns the plaintext ONCE, with the stored row (which carries only the hash and a
 * display prefix: the first 13 characters, like `rce_live_AbCd`). Writes are OFF by default: Kyle
 * turns them on per key.
 */
export async function mintAgentKey(
  input: MintAgentKeyInput,
  db: PrismaClient | Prisma.TransactionClient = defaultPrisma,
): Promise<{ key: string; row: AgentKey }> {
  if (!isAgentRole(input.agentRole)) throw new AgentKeyInputError(`Unknown agent role: ${String(input.agentRole)}`);
  const name = input.name.trim();
  if (!name) throw new AgentKeyInputError("A key needs a name.");
  const scopes = validateScopes(input.scopes ?? DEFAULT_SCOPES_BY_ROLE[input.agentRole]);
  const environment = input.environment ?? currentAgentEnvironment();
  const key = `rce_${environment}_${randomBytes(32).toString("base64url")}`;
  const row = await db.agentKey.create({
    data: {
      name,
      agentRole: input.agentRole,
      environment,
      displayPrefix: key.slice(0, 13),
      secretHash: hashAgentKey(key),
      scopes,
      writesEnabled: input.writesEnabled ?? false,
      teamPostsPublish: input.teamPostsPublish ?? true,
      hubThreadKinds: [...(input.hubThreadKinds ?? DEFAULT_HUB_THREAD_KINDS_BY_ROLE[input.agentRole])],
      expiresAt: input.expiresAt ?? null,
      retiresAt: input.retiresAt ?? null,
      rotatedFromId: input.rotatedFromId ?? null,
      createdBy: input.createdBy,
    },
  });
  return { key, row };
}

/** The key row for a presented key, or null. Throws AgentKeyPepperMissingError when the pepper is unset. */
export async function findAgentKey(key: string, db: PrismaClient = defaultPrisma): Promise<AgentKey | null> {
  return db.agentKey.findUnique({ where: { secretHash: hashAgentKey(key) } });
}
