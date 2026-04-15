-- CreateTable
CREATE TABLE "AgentAuditLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "action" TEXT NOT NULL,
    "visitId" TEXT,
    "entityType" TEXT,
    "entityId" TEXT,
    "payloadJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
