-- AlterTable
ALTER TABLE "AgentAuditLog" ADD COLUMN     "agentKeyId" TEXT,
ADD COLUMN     "door" TEXT,
ADD COLUMN     "recordIds" JSONB,
ADD COLUMN     "resultCode" TEXT,
ADD COLUMN     "scopeUsed" TEXT;

-- AlterTable
ALTER TABLE "AgentIdempotency" ADD COLUMN     "agentKeyId" TEXT,
ADD COLUMN     "requestHash" TEXT,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'done';

-- CreateTable
CREATE TABLE "AgentKey" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "agentRole" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "displayPrefix" TEXT NOT NULL,
    "secretHash" TEXT NOT NULL,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "writesEnabled" BOOLEAN NOT NULL DEFAULT false,
    "hubThreadKinds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "expiresAt" TIMESTAMP(3),
    "retiresAt" TIMESTAMP(3),
    "rotatedFromId" TEXT,
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,
    "lastUsedAt" TIMESTAMP(3),
    "lastUsedTool" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentKey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentKey_secretHash_key" ON "AgentKey"("secretHash");

-- CreateIndex
CREATE UNIQUE INDEX "AgentKey_rotatedFromId_key" ON "AgentKey"("rotatedFromId");

-- CreateIndex
CREATE INDEX "AgentAuditLog_agentKeyId_createdAt_idx" ON "AgentAuditLog"("agentKeyId", "createdAt");


-- Append-only agent audit (work order agent-team, K-U3): the database refuses to change or remove
-- an AgentAuditLog row. This block hand-written, not from the schema diff. tests/globalSetup.ts runs
-- the same block (db push never runs migration SQL), so the tests exercise the real trigger.
-- BEGIN append-only trigger
CREATE OR REPLACE FUNCTION "agent_audit_log_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AgentAuditLog is append-only: % is not allowed', TG_OP USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AgentAuditLog_append_only" BEFORE UPDATE OR DELETE ON "AgentAuditLog"
FOR EACH ROW EXECUTE FUNCTION "agent_audit_log_append_only"();
-- END append-only trigger
