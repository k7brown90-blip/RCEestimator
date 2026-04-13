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
    "estimateId" TEXT,
    "existingVisitId" TEXT,
    "customerId" TEXT,
    "propertyId" TEXT,
    "visitId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Lead" ("address", "createdAt", "customerId", "email", "id", "jobType", "name", "notes", "phone", "propertyId", "source", "status", "updatedAt", "visitId") SELECT "address", "createdAt", "customerId", "email", "id", "jobType", "name", "notes", "phone", "propertyId", "source", "status", "updatedAt", "visitId" FROM "Lead";
DROP TABLE "Lead";
ALTER TABLE "new_Lead" RENAME TO "Lead";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

