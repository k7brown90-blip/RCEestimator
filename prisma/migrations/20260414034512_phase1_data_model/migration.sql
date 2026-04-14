-- AlterTable
ALTER TABLE "Visit" ADD COLUMN "actualMaterialCost" REAL DEFAULT 0;
ALTER TABLE "Visit" ADD COLUMN "estimatedCost" REAL;
ALTER TABLE "Visit" ADD COLUMN "estimatedJobLength" REAL;
ALTER TABLE "Visit" ADD COLUMN "laborHours" REAL DEFAULT 0;
ALTER TABLE "Visit" ADD COLUMN "overheadAllocation" REAL DEFAULT 0;
ALTER TABLE "Visit" ADD COLUMN "revenue" REAL;

-- CreateTable
CREATE TABLE "Receipt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobId" TEXT,
    "category" TEXT NOT NULL,
    "vendor" TEXT,
    "amount" REAL NOT NULL,
    "lineItems" TEXT,
    "imageUrl" TEXT,
    "receivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Document" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "pdfUrl" TEXT NOT NULL,
    "signedAt" DATETIME,
    "signedByIp" TEXT,
    "signedByName" TEXT,
    "sentAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "MaterialOrder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobId" TEXT NOT NULL,
    "supplier" TEXT NOT NULL,
    "items" TEXT NOT NULL,
    "sentAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Lead" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "source" TEXT NOT NULL DEFAULT 'email',
    "status" TEXT NOT NULL DEFAULT 'new',
    "notes" TEXT,
    "address" TEXT,
    "jobType" TEXT,
    "callType" TEXT,
    "referredBy" TEXT,
    "urgentFlag" BOOLEAN NOT NULL DEFAULT false,
    "warrantyCall" BOOLEAN NOT NULL DEFAULT false,
    "warrantyNote" TEXT,
    "contactPreference" TEXT,
    "leadStatus" TEXT NOT NULL DEFAULT 'new',
    "followUpDate" DATETIME,
    "followUpReason" TEXT,
    "followUpCount" INTEGER NOT NULL DEFAULT 0,
    "lostReason" TEXT,
    "lostNotes" TEXT,
    "bestTimeToReach" TEXT,
    "estimateId" TEXT,
    "existingVisitId" TEXT,
    "customerId" TEXT,
    "propertyId" TEXT,
    "visitId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Lead" ("address", "callType", "createdAt", "customerId", "email", "estimateId", "existingVisitId", "id", "jobType", "name", "notes", "phone", "propertyId", "referredBy", "source", "status", "updatedAt", "urgentFlag", "visitId", "warrantyCall", "warrantyNote") SELECT "address", "callType", "createdAt", "customerId", "email", "estimateId", "existingVisitId", "id", "jobType", "name", "notes", "phone", "propertyId", "referredBy", "source", "status", "updatedAt", "urgentFlag", "visitId", "warrantyCall", "warrantyNote" FROM "Lead";
DROP TABLE "Lead";
ALTER TABLE "new_Lead" RENAME TO "Lead";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
