/*
  Warnings:

  - Added the required column `expiresAt` to the `AgentIdempotency` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "AgentAuditLog" ADD COLUMN "agent" TEXT;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_AgentIdempotency" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientRequestId" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "agent" TEXT,
    "visitId" TEXT,
    "responseJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL
);
INSERT INTO "new_AgentIdempotency" ("clientRequestId", "createdAt", "endpoint", "id", "responseJson", "visitId") SELECT "clientRequestId", "createdAt", "endpoint", "id", "responseJson", "visitId" FROM "AgentIdempotency";
DROP TABLE "AgentIdempotency";
ALTER TABLE "new_AgentIdempotency" RENAME TO "AgentIdempotency";
CREATE UNIQUE INDEX "AgentIdempotency_clientRequestId_endpoint_key" ON "AgentIdempotency"("clientRequestId", "endpoint");
CREATE TABLE "new_Visit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "propertyId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "purpose" TEXT,
    "visitDate" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'estimate',
    "jobType" TEXT,
    "estimatedJobLength" REAL,
    "estimatedDurationDays" INTEGER,
    "estimatedDurationHours" REAL,
    "scheduledStart" DATETIME,
    "scheduledEnd" DATETIME,
    "googleEventId" TEXT,
    "contractedAt" DATETIME,
    "estimatedCost" REAL,
    "actualMaterialCost" REAL DEFAULT 0,
    "laborHours" REAL DEFAULT 0,
    "overheadAllocation" REAL DEFAULT 0,
    "revenue" REAL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Visit_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Visit_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Visit" ("actualMaterialCost", "createdAt", "customerId", "estimatedCost", "estimatedJobLength", "id", "laborHours", "mode", "notes", "overheadAllocation", "propertyId", "purpose", "revenue", "visitDate") SELECT "actualMaterialCost", "createdAt", "customerId", "estimatedCost", "estimatedJobLength", "id", "laborHours", "mode", "notes", "overheadAllocation", "propertyId", "purpose", "revenue", "visitDate" FROM "Visit";
DROP TABLE "Visit";
ALTER TABLE "new_Visit" RENAME TO "Visit";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
