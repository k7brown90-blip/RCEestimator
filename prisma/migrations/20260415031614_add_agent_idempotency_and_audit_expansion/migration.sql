-- AlterTable
ALTER TABLE "AgentAuditLog" ADD COLUMN "clientRequestId" TEXT;
ALTER TABLE "AgentAuditLog" ADD COLUMN "durationMs" INTEGER;
ALTER TABLE "AgentAuditLog" ADD COLUMN "endpoint" TEXT;
ALTER TABLE "AgentAuditLog" ADD COLUMN "responseStatus" INTEGER;

-- CreateTable
CREATE TABLE "AgentIdempotency" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientRequestId" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "visitId" TEXT,
    "responseJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentIdempotency_clientRequestId_endpoint_key" ON "AgentIdempotency"("clientRequestId", "endpoint");
