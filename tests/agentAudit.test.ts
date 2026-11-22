import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { prisma } from "../src/lib/prisma";
import { agentAuditRecord, createAgentKeyGate, finishAgentCall, sendAgentResult, type AgentKeyRoute } from "../src/agentApi/gate";
import { withIdempotency } from "../src/agentApi/idempotency";
import { chicagoDayStart, countDraftsToday, recordAgentCall, sha256Hex } from "../src/agentApi/audit";
import { mintAgentKey, type MintAgentKeyInput } from "../src/agentApi/keys";

/**
 * Work order agent-team, K-U3: ONE append-only agent audit. One row per call, written before the
 * response, never a body, never a key; the database refuses UPDATE and DELETE.
 */

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const ROUTES: AgentKeyRoute[] = [
  { methods: ["GET"], path: "/ping", scope: "crm:read", tool: "test.ping", reason: "test" },
  { methods: ["POST"], path: "/draft", scope: "hub:draft", write: true, draft: true, tool: "test.draft", reason: "test" },
];

function testApp() {
  const a = express();
  a.use(express.json());
  a.use(createAgentKeyGate({ routes: ROUTES }));
  a.get("/ping", (req, res) => void finishAgentCall(req, res, { status: 200, body: { ok: true, secretField: "ignored" }, recordIds: ["acct_1", "has spaces and a name"] }));
  a.post("/draft", (req, res) =>
    void finishAgentCall(req, res, { status: 200, body: { ok: true }, madeDraft: true, idempotencyKey: "my-secret-idem-key-1", recordIds: ["draft123"] }));
  return a;
}

let savedPepper: string | undefined;
const keyIds: string[] = [];
beforeAll(() => {
  savedPepper = process.env.AGENT_KEY_PEPPER;
  process.env.AGENT_KEY_PEPPER = "test-pepper-for-the-agent-audit-suite";
});
afterAll(async () => {
  if (savedPepper === undefined) delete process.env.AGENT_KEY_PEPPER; else process.env.AGENT_KEY_PEPPER = savedPepper;
  await prisma.agentKey.deleteMany({ where: { id: { in: keyIds } } });
});

async function mint(opts: Partial<MintAgentKeyInput> = {}) {
  const made = await mintAgentKey({ name: "audit test", agentRole: "admin", createdBy: "owner", ...opts });
  keyIds.push(made.row.id);
  return made;
}
const rowsFor = (agentKeyId: string) => prisma.agentAuditLog.findMany({ where: { agentKeyId }, orderBy: { createdAt: "asc" } });

describe("one row per call", () => {
  it("a success leaves exactly one row: key id, role, door, tool, scope, ids, result, status, no body", async () => {
    const a = testApp();
    const { key, row } = await mint({ scopes: ["crm:read"] });
    const res = await request(a).get("/ping").set(bearer(key));
    expect(res.status).toBe(200);
    const rows = await rowsFor(row.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      agentKeyId: row.id, agent: "admin", door: "rest", action: "test.ping", endpoint: "GET /ping",
      scopeUsed: "crm:read", resultCode: "ok", responseStatus: 200, payloadJson: null, clientRequestId: null,
    });
    expect(rows[0].durationMs).toBeGreaterThanOrEqual(0);
    // ids only: the id-shaped one is kept, the one with spaces (could be a name) is dropped.
    expect(rows[0].recordIds).toEqual(["acct_1"]);
    expect(JSON.stringify(rows[0])).not.toContain(key);
    expect(JSON.stringify(rows[0])).not.toContain("secretField");
  });

  it("a 403, a 401 for a revoked key and a 429 each leave exactly one row", async () => {
    const a = testApp();
    const weak = await mint({ scopes: ["hub:read"] });
    expect((await request(a).get("/ping").set(bearer(weak.key))).status).toBe(403);
    const w = await rowsFor(weak.row.id);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ resultCode: "scope_denied", responseStatus: 403, agentKeyId: weak.row.id });

    const revoked = await mint();
    await prisma.agentKey.update({ where: { id: revoked.row.id }, data: { revokedAt: new Date() } });
    expect((await request(a).get("/ping").set(bearer(revoked.key))).status).toBe(401);
    expect(await rowsFor(revoked.row.id)).toMatchObject([{ resultCode: "key_revoked", responseStatus: 401 }]);

    const limited = createAgentKeyGate({ routes: ROUTES, perKeyPerMinute: 2 });
    const la = express();
    la.use(limited);
    la.get("/ping", (req, res) => void finishAgentCall(req, res, { status: 200, body: {} }));
    const lk = await mint({ scopes: ["crm:read"] });
    for (let i = 0; i < 3; i += 1) await request(la).get("/ping").set(bearer(lk.key));
    const lr = await rowsFor(lk.row.id);
    expect(lr.map((r) => r.resultCode)).toEqual(["ok", "ok", "rate_limited"]);
  });

  it("an unknown key's 401 is logged with agentKeyId null and nothing from the credential", async () => {
    const a = testApp();
    const fake = "rce_test_" + "Zz9".repeat(14) + "Q";
    const before = await prisma.agentAuditLog.count({ where: { agentKeyId: null, resultCode: "unauthenticated" } });
    expect((await request(a).get("/ping").set(bearer(fake))).status).toBe(401);
    const after = await prisma.agentAuditLog.findMany({ where: { agentKeyId: null, resultCode: "unauthenticated" }, orderBy: { createdAt: "desc" }, take: 1 });
    expect(await prisma.agentAuditLog.count({ where: { agentKeyId: null, resultCode: "unauthenticated" } })).toBe(before + 1);
    expect(JSON.stringify(after[0])).not.toContain(fake.slice(9));
    expect(after[0].agent).toBeNull();
  });

  it("stores the idempotency key only as its sha256, and counts a draft only when it made one", async () => {
    const a = testApp();
    const { key, row } = await mint({ scopes: ["hub:draft"], writesEnabled: true });
    expect((await request(a).post("/draft").set(bearer(key)).send({})).status).toBe(200);
    const rows = await rowsFor(row.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].clientRequestId).toBe(sha256Hex("my-secret-idem-key-1"));
    expect(JSON.stringify(rows[0])).not.toContain("my-secret-idem-key-1");
    expect(rows[0].entityType).toBe("draft");
    expect(await countDraftsToday(row.id)).toBe(1);

    await recordAgentCall({
      agentKeyId: row.id, agentRole: "admin", tool: "test.draft", route: "POST /draft", door: "mcp", scopeUsed: "hub:draft",
      resultCode: "replayed", status: 200, durationMs: 1, madeDraft: true, idempotencyKey: "my-secret-idem-key-1",
    });
    expect(await countDraftsToday(row.id)).toBe(1); // a replay made nothing
    expect((await rowsFor(row.id)).at(-1)).toMatchObject({ resultCode: "replayed", entityType: null, door: "mcp" });
  });

  it("when the insert fails the call returns 500 internal and sends no data", async () => {
    const a = testApp();
    const { key } = await mint({ scopes: ["crm:read"] });
    const spy = vi.spyOn(prisma.agentAuditLog, "create").mockRejectedValueOnce(new Error("db down"));
    try {
      const res = await request(a).get("/ping").set(bearer(key));
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ code: "internal", reason: expect.any(String), retryable: true });
      expect(JSON.stringify(res.body)).not.toContain("db down");
      expect(res.body.ok).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it("counts the Chicago day from Chicago midnight (a CST evening and a CDT morning)", () => {
    // 2026-11-22 03:00Z is 21:00 CST on the 21st: the day began 2026-11-21 06:00Z.
    expect(chicagoDayStart(new Date("2026-11-22T03:00:00Z")).toISOString()).toBe("2026-11-21T06:00:00.000Z");
    // 2026-06-15 05:30Z is 00:30 CDT on the 15th: the day began 05:00Z.
    expect(chicagoDayStart(new Date("2026-06-15T05:30:00Z")).toISOString()).toBe("2026-06-15T05:00:00.000Z");
  });
});

describe("a write's audit row joins the write's transaction", () => {
  type P = { keyId: string; role: string };
  function writeApp(failAfterAudit: boolean, marker: string) {
    const a = express();
    a.use(express.json());
    a.use(createAgentKeyGate({ routes: ROUTES }));
    a.post("/draft", async (req, res) => {
      const principal = (req as unknown as { agentPrincipal: P }).agentPrincipal;
      try {
        const { result } = await withIdempotency(principal, "dummy_draft", "dummy-idem-key-1", {}, async (tx) => {
          await tx.systemEvent.create({ data: { level: "info", source: "audit-tx-test", message: marker } }); // the effect
          const record = agentAuditRecord(req, { status: 200, body: {}, madeDraft: true, recordIds: ["draft1"], idempotencyKey: "dummy-idem-key-1" });
          await recordAgentCall(record, tx);
          if (failAfterAudit) throw new Error("rolled back after the audit insert");
          return { draftId: "draft1" };
        });
        sendAgentResult(res, 200, result);
      } catch {
        res.status(500).json({ code: "internal" });
      }
    });
    return a;
  }

  it("the effect and its audit row commit together, and the draft counts", async () => {
    const marker = `audit-tx-${randomUUID()}`;
    const { key, row } = await mint({ scopes: ["hub:draft"], writesEnabled: true });
    const res = await request(writeApp(false, marker)).post("/draft").set(bearer(key)).send({});
    expect(res.status).toBe(200);
    expect(await prisma.systemEvent.count({ where: { message: marker } })).toBe(1);
    const rows = await rowsFor(row.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ resultCode: "ok", entityType: "draft", endpoint: "POST /draft", recordIds: ["draft1"] });
    expect(await countDraftsToday(row.id)).toBe(1);
    await prisma.systemEvent.deleteMany({ where: { message: marker } });
  });

  it("a failure rolls back BOTH: no effect, no audit row, no stored idempotency result", async () => {
    const marker = `audit-tx-${randomUUID()}`;
    const { key, row } = await mint({ scopes: ["hub:draft"], writesEnabled: true });
    const res = await request(writeApp(true, marker)).post("/draft").set(bearer(key)).send({});
    expect(res.status).toBe(500);
    expect(await prisma.systemEvent.count({ where: { message: marker } })).toBe(0);
    expect(await rowsFor(row.id)).toHaveLength(0);
    expect(await countDraftsToday(row.id)).toBe(0);
    expect(await prisma.agentIdempotency.count({ where: { agentKeyId: row.id } })).toBe(0);
  });

  it("a failed audit insert rolls the effect back too: no draft exists without its row", async () => {
    const marker = `audit-tx-${randomUUID()}`;
    const { key, row } = await mint({ scopes: ["hub:draft"], writesEnabled: true });
    const a = express();
    a.use(createAgentKeyGate({ routes: ROUTES }));
    a.post("/draft", async (req, res) => {
      const principal = (req as unknown as { agentPrincipal: P }).agentPrincipal;
      try {
        await withIdempotency(principal, "dummy_draft2", "dummy-idem-key-2", {}, async (tx) => {
          await tx.systemEvent.create({ data: { level: "info", source: "audit-tx-test", message: marker } });
          // An impossible status makes the audit insert itself fail inside the transaction.
          await recordAgentCall({ ...agentAuditRecord(req, { status: 200, body: {}, madeDraft: true }), status: Number.MAX_SAFE_INTEGER }, tx);
          return {};
        });
        res.status(200).json({});
      } catch {
        res.status(500).json({ code: "internal" });
      }
    });
    expect((await request(a).post("/draft").set(bearer(key)).send({})).status).toBe(500);
    expect(await prisma.systemEvent.count({ where: { message: marker } })).toBe(0);
    expect(await rowsFor(row.id)).toHaveLength(0);
  });
});

describe("append-only in the database", () => {
  async function oneRow() {
    return prisma.agentAuditLog.create({ data: { action: "append-only probe", agentKeyId: `probe-${randomUUID()}`, resultCode: "ok" } });
  }

  it("an UPDATE of an audit row throws", async () => {
    const row = await oneRow();
    await expect(prisma.agentAuditLog.update({ where: { id: row.id }, data: { resultCode: "changed" } })).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRawUnsafe(`UPDATE "AgentAuditLog" SET "action" = 'x' WHERE id = '${row.id}'`)).rejects.toThrow(/append-only/);
    expect((await prisma.agentAuditLog.findUnique({ where: { id: row.id } }))?.resultCode).toBe("ok");
  });

  it("a DELETE of an audit row throws, one at a time or in bulk", async () => {
    const row = await oneRow();
    await expect(prisma.agentAuditLog.delete({ where: { id: row.id } })).rejects.toThrow(/append-only/);
    await expect(prisma.agentAuditLog.deleteMany({ where: { id: row.id } })).rejects.toThrow(/append-only/);
    expect(await prisma.agentAuditLog.count({ where: { id: row.id } })).toBe(1);
  });

  it("TRUNCATE is statement-level, so the row trigger does not fire on it (a scratch table with the same trigger proves it)", async () => {
    const tableName = `AgentAuditScratch_${Date.now()}`;
    await prisma.$executeRawUnsafe(`CREATE TABLE "${tableName}" (id int)`);
    try {
      await prisma.$executeRawUnsafe(
        `CREATE TRIGGER "${tableName}_t" BEFORE UPDATE OR DELETE ON "${tableName}" FOR EACH ROW EXECUTE FUNCTION "agent_audit_log_append_only"()`);
      await prisma.$executeRawUnsafe(`INSERT INTO "${tableName}" VALUES (1)`);
      await expect(prisma.$executeRawUnsafe(`DELETE FROM "${tableName}"`)).rejects.toThrow(/append-only/);
      await prisma.$executeRawUnsafe(`TRUNCATE "${tableName}"`);
      expect(await prisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "${tableName}"`)).toEqual([{ n: 0 }]);
    } finally {
      await prisma.$executeRawUnsafe(`DROP TABLE "${tableName}"`);
    }
  });
});
