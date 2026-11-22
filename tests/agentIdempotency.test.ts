import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "../src/lib/prisma";
import {
  canonicalJson, IDEMPOTENCY_TTL_MS, PENDING_STALE_MS, requestHashOf, withIdempotency,
} from "../src/agentApi/idempotency";
import { toAgentError } from "../src/agentApi/errors";

/**
 * Work order agent-team, K-U6: 24-hour idempotency for agent writes, on AgentIdempotency. The tool
 * registry (K-U5) is Step 2, so the operation here is a dummy that counts how many times it ran.
 */

const keyId = `idem-key-${randomUUID()}`;
const other = `idem-other-${randomUUID()}`;
const principal = { keyId, role: "admin" };

let runs = 0;
async function makeDraft(label: string, delayMs = 0) {
  return async () => {
    runs += 1;
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    return { draftId: `d${runs}`, label };
  };
}

beforeEach(async () => {
  runs = 0;
  await prisma.agentIdempotency.deleteMany({ where: { agentKeyId: { in: [keyId, other] } } });
});
afterAll(async () => {
  await prisma.agentIdempotency.deleteMany({ where: { agentKeyId: { in: [keyId, other] } } });
});

describe("withIdempotency", () => {
  it("the same call twice runs once; the second returns the first result", async () => {
    const input = { threadId: "t1", body: "hello" };
    const first = await withIdempotency(principal, "draft_customer_message", "key-0001-abcd", input, await makeDraft("a"));
    const second = await withIdempotency(principal, "draft_customer_message", "key-0001-abcd", input, await makeDraft("b"));
    expect(runs).toBe(1);
    expect(first).toEqual({ result: { draftId: "d1", label: "a" }, replayed: false });
    expect(second).toEqual({ result: { draftId: "d1", label: "a" }, replayed: true });
  });

  it("the row records the key, operation, hash and status, and the key's role", async () => {
    await withIdempotency(principal, "op_x", "key-0002-abcd", { a: 1 }, await makeDraft("a"));
    const row = await prisma.agentIdempotency.findUniqueOrThrow({
      where: { clientRequestId_endpoint: { clientRequestId: `${keyId}:key-0002-abcd`, endpoint: "op:op_x" } },
    });
    expect(row).toMatchObject({ agentKeyId: keyId, agent: "admin", status: "done", requestHash: requestHashOf({ a: 1 }) });
    expect(JSON.parse(row.responseJson)).toEqual({ draftId: "d1", label: "a" });
    const ttl = row.expiresAt.getTime() - row.createdAt.getTime();
    expect(ttl).toBe(IDEMPOTENCY_TTL_MS);
  });

  it("one operation name is shared by both doors: the same key through MCP then REST makes one record", async () => {
    const viaMcp = await withIdempotency(principal, "create_lead_draft", "key-0003-abcd", { name: "Pat" }, await makeDraft("mcp"));
    const viaRest = await withIdempotency(principal, "create_lead_draft", "key-0003-abcd", { name: "Pat" }, await makeDraft("rest"));
    expect(runs).toBe(1);
    expect(viaRest.result).toEqual(viaMcp.result);
    expect(viaRest.replayed).toBe(true);
  });

  it("key order in the input does not matter; a different body is 409 idempotency_conflict", async () => {
    await withIdempotency(principal, "op", "key-0004-abcd", { a: 1, b: { c: 2, d: 3 } }, await makeDraft("a"));
    const same = await withIdempotency(principal, "op", "key-0004-abcd", { b: { d: 3, c: 2 }, a: 1 }, await makeDraft("b"));
    expect(same.replayed).toBe(true);
    const err = await withIdempotency(principal, "op", "key-0004-abcd", { a: 2 }, await makeDraft("c")).catch((e) => e);
    expect(toAgentError(err)).toEqual({
      status: 409, body: { code: "idempotency_conflict", reason: expect.any(String), retryable: false },
    });
    expect(runs).toBe(1);
  });

  it("two parallel calls: one runs, the other is 409 in_progress (retryable); afterwards the first result replays", async () => {
    const input = { n: 1 };
    const [a, b] = await Promise.allSettled([
      withIdempotency(principal, "op", "key-0005-abcd", input, await makeDraft("slow", 400)),
      withIdempotency(principal, "op", "key-0005-abcd", input, await makeDraft("slow2", 400)),
    ]);
    const outcomes = [a, b];
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((o) => o.status === "rejected") as PromiseRejectedResult;
    expect(toAgentError(rejected.reason)).toEqual({
      status: 409, body: { code: "in_progress", reason: expect.any(String), retryable: true },
    });
    expect(runs).toBe(1);
    const again = await withIdempotency(principal, "op", "key-0005-abcd", input, await makeDraft("x"));
    expect(again.replayed).toBe(true);
    expect(runs).toBe(1);
  });

  it("after 24 hours the key is usable again", async () => {
    const t0 = new Date("2026-11-21T12:00:00Z");
    const later = new Date(t0.getTime() + IDEMPOTENCY_TTL_MS + 1000);
    const first = await withIdempotency(principal, "op", "key-0006-abcd", { a: 1 }, await makeDraft("a"), () => t0);
    expect(first.replayed).toBe(false);
    // Just inside the window: still a replay.
    const inside = await withIdempotency(principal, "op", "key-0006-abcd", { a: 1 }, await makeDraft("b"), () => new Date(t0.getTime() + IDEMPOTENCY_TTL_MS - 1000));
    expect(inside.replayed).toBe(true);
    // Past it: runs again, even with a different body.
    const second = await withIdempotency(principal, "op", "key-0006-abcd", { a: 999 }, await makeDraft("c"), () => later);
    expect(second.replayed).toBe(false);
    expect(second.result).toEqual({ draftId: "d2", label: "c" });
    expect(runs).toBe(2);
    // ...and the new result is what replays now.
    const replay = await withIdempotency(principal, "op", "key-0006-abcd", { a: 999 }, await makeDraft("d"), () => new Date(later.getTime() + 1000));
    expect(replay).toEqual({ result: { draftId: "d2", label: "c" }, replayed: true });
  });

  it("a failed operation rolls back, frees the key, and the real error comes through", async () => {
    const boom = new Error("operation failed");
    await expect(withIdempotency(principal, "op", "key-0007-abcd", { a: 1 }, async () => { throw boom; })).rejects.toBe(boom);
    expect(await prisma.agentIdempotency.count({ where: { clientRequestId: `${keyId}:key-0007-abcd` } })).toBe(0);
    const retry = await withIdempotency(principal, "op", "key-0007-abcd", { a: 1 }, await makeDraft("ok"));
    expect(retry.replayed).toBe(false);
  });

  it("the effect and the record commit together: a throw after the effect leaves neither", async () => {
    const marker = `idem-effect-${randomUUID()}`;
    await expect(withIdempotency(principal, "op", "key-0008-abcd", {}, async (tx) => {
      await tx.systemEvent.create({ data: { level: "info", source: "idem-test", message: marker } });
      throw new Error("after the effect");
    })).rejects.toThrow("after the effect");
    expect(await prisma.systemEvent.count({ where: { message: marker } })).toBe(0);
    await withIdempotency(principal, "op", "key-0009-abcd", {}, async (tx) => {
      await tx.systemEvent.create({ data: { level: "info", source: "idem-test", message: marker } });
      return { ok: true };
    });
    expect(await prisma.systemEvent.count({ where: { message: marker } })).toBe(1);
    await prisma.systemEvent.deleteMany({ where: { message: marker } });
  });

  it("is per key: the same idempotency_key from another agent key is its own call; a short key is refused", async () => {
    await withIdempotency(principal, "op", "shared-key-abcd", { a: 1 }, await makeDraft("a"));
    const theirs = await withIdempotency({ keyId: other, role: "outreach" }, "op", "shared-key-abcd", { a: 1 }, await makeDraft("b"));
    expect(theirs.replayed).toBe(false);
    expect(runs).toBe(2);
    const err = await withIdempotency(principal, "op", "short", {}, await makeDraft("c")).catch((e) => e);
    expect(toAgentError(err).body.code).toBe("bad_request");
    const long = await withIdempotency(principal, "op", "x".repeat(129), {}, await makeDraft("c")).catch((e) => e);
    expect(toAgentError(long).body.code).toBe("bad_request");
  });

  it("a pending row left by a crashed process is taken over after it goes stale", async () => {
    const t0 = new Date("2026-11-21T12:00:00Z");
    await prisma.agentIdempotency.create({
      data: {
        clientRequestId: `${keyId}:key-0010-abcd`, endpoint: "op:op", agent: "admin", agentKeyId: keyId,
        requestHash: requestHashOf({ a: 1 }), status: "pending", responseJson: "", createdAt: t0,
        expiresAt: new Date(t0.getTime() + IDEMPOTENCY_TTL_MS),
      },
    });
    const fresh = await withIdempotency(principal, "op", "key-0010-abcd", { a: 1 }, await makeDraft("x"), () => new Date(t0.getTime() + 1000)).catch((e) => e);
    expect(toAgentError(fresh).body.code).toBe("in_progress");
    const taken = await withIdempotency(principal, "op", "key-0010-abcd", { a: 1 }, await makeDraft("y"), () => new Date(t0.getTime() + PENDING_STALE_MS + 1000));
    expect(taken.replayed).toBe(false);
  });

  it("canonicalJson sorts keys at every depth and drops undefined", () => {
    expect(canonicalJson({ b: [{ z: 1, a: undefined, y: 2 }], a: 1 })).toBe('{"a":1,"b":[{"y":2,"z":1}]}');
  });
});
