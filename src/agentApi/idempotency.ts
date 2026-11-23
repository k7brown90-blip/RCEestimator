/**
 * Agent write idempotency (work order agent-team, K-U6), on AgentIdempotency. ONE store for both
 * doors: the row is keyed `<agentKeyId>:<idempotency_key>` on `op:<operation>`, and the operation
 * name is shared by the /mcp tool and its REST twin, so a retry through the OTHER door still finds
 * the first result.
 *
 * What an agent sees:
 *   * Same key, same input, within 24 hours: the first result again, and no second record.
 *   * Same key, different input: 409 `idempotency_conflict`.
 *   * Same key while the first call is still running: 409 `in_progress` (retryable).
 *   * After 24 hours the key is free again.
 *
 * How: a `pending` row is inserted first (the unique index makes exactly one caller the owner), the
 * operation runs in ONE database transaction, and inside that same transaction the row is marked
 * `done` with the result. The effect and its record commit together, so a crash can never leave an
 * effect with no replay record. If the operation throws, the transaction rolls back and the pending
 * row is removed, so the agent can fix the request and retry with the same key. A pending row left by
 * a crashed process is taken over after PENDING_STALE_MS.
 *
 * Every draft or write input schema must require `idempotency_key` (idempotencyKeySchema below, 8 to
 * 128 characters). The result is stored as JSON, so it must be plain data and must already be the
 * agent-safe (scrubbed) answer.
 */
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { AgentApiError } from "./errors";

export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
/** A pending row older than this belongs to a call that died; a new caller may take it over. */
export const PENDING_STALE_MS = 2 * 60 * 1000;
/**
 * How long the operation's transaction may run. The default is 5 seconds, and a draft's effects (the row, the
 * auto-send decision, which can be a real send once a category is switched on, and the fan-out) can take longer
 * on a slow provider: a timeout would roll the audit row back and answer 500 although the message went.
 */
export const IDEMPOTENT_TX_TIMEOUT_MS = 30_000;

export const idempotencyKeySchema = z.string().min(8).max(128);

/** The caller, as much as idempotency needs of the gate's principal. */
export interface IdempotencyPrincipal {
  keyId: string;
  role: string;
}

export interface IdempotentResult<T> {
  result: T;
  /** True when this is the first call's stored result, not a new run. */
  replayed: boolean;
}

/** JSON with object keys sorted at every depth, so the same input always hashes the same. */
export function canonicalJson(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === "object" && !(v instanceof Date)) {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .filter(([, x]) => x !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, x]) => [k, walk(x)]),
      );
    }
    return v;
  };
  return JSON.stringify(walk(value));
}

export function requestHashOf(input: unknown): string {
  return createHash("sha256").update(canonicalJson(input)).digest("hex");
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

export async function withIdempotency<T>(
  principal: IdempotencyPrincipal,
  operation: string,
  key: string,
  input: unknown,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  now: () => Date = () => new Date(),
): Promise<IdempotentResult<T>> {
  if (!idempotencyKeySchema.safeParse(key).success) {
    throw new AgentApiError("bad_request", { reason: "idempotency_key must be 8 to 128 characters." });
  }
  const clientRequestId = `${principal.keyId}:${key}`;
  const endpoint = `op:${operation}`;
  const requestHash = requestHashOf(input);
  const started = now();

  // 1. Become the owner of this key, or find out why not.
  let ownerRowId: string | null = null;
  for (let attempt = 0; attempt < 3 && ownerRowId === null; attempt += 1) {
    try {
      const created = await prisma.agentIdempotency.create({
        data: {
          clientRequestId, endpoint, agent: principal.role, agentKeyId: principal.keyId, requestHash,
          status: "pending", responseJson: "", createdAt: started,
          expiresAt: new Date(started.getTime() + IDEMPOTENCY_TTL_MS),
        },
        select: { id: true },
      });
      ownerRowId = created.id;
      break;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }

    const existing = await prisma.agentIdempotency.findUnique({
      where: { clientRequestId_endpoint: { clientRequestId, endpoint } },
    });
    if (!existing) continue; // it was removed between our insert and our read: try again

    const expired = existing.expiresAt.getTime() <= started.getTime();
    const stalePending = existing.status === "pending" && existing.createdAt.getTime() <= started.getTime() - PENDING_STALE_MS;
    if (expired || stalePending) {
      // Take it over. Only one caller's updateMany can match the row's current state.
      const taken = await prisma.agentIdempotency.updateMany({
        where: expired
          ? { id: existing.id, expiresAt: { lte: started } }
          : { id: existing.id, status: "pending", createdAt: { lte: new Date(started.getTime() - PENDING_STALE_MS) } },
        data: {
          status: "pending", requestHash, responseJson: "", agent: principal.role, agentKeyId: principal.keyId,
          createdAt: started, expiresAt: new Date(started.getTime() + IDEMPOTENCY_TTL_MS),
        },
      });
      if (taken.count === 1) {
        ownerRowId = existing.id;
        break;
      }
      continue; // someone else took it first: read it again
    }

    if (existing.requestHash !== requestHash) throw new AgentApiError("idempotency_conflict");
    if (existing.status === "pending") throw new AgentApiError("in_progress");
    return { result: JSON.parse(existing.responseJson) as T, replayed: true };
  }
  if (ownerRowId === null) throw new AgentApiError("in_progress");

  // 2. Run it. The effect and the `done` record commit together.
  const rowId = ownerRowId;
  try {
    const result = await prisma.$transaction(async (tx) => {
      const out = await fn(tx);
      const json = JSON.stringify(out === undefined ? null : out);
      await tx.agentIdempotency.update({ where: { id: rowId }, data: { status: "done", responseJson: json } });
      return JSON.parse(json) as T;
    }, { timeout: IDEMPOTENT_TX_TIMEOUT_MS, maxWait: 10_000 });
    return { result, replayed: false };
  } catch (err) {
    // Rolled back: free the key so the agent can retry. Never mask the real error.
    await prisma.agentIdempotency.deleteMany({ where: { id: rowId, status: "pending" } }).catch(() => undefined);
    throw err;
  }
}
