/*
  Warnings:

  - Added the required column `parentOptionId` to the `ChangeOrder` table without a default value. This is not possible if the table is not empty.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ChangeOrder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "estimateId" TEXT NOT NULL,
    "parentOptionId" TEXT NOT NULL,
    "sequenceNumber" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "reason" TEXT,
    "reasonType" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "estimateRevision" INTEGER NOT NULL,
    "assembliesAddedJson" TEXT,
    "assembliesRemovedJson" TEXT,
    "assembliesModifiedJson" TEXT,
    "deltaLabor" REAL NOT NULL DEFAULT 0,
    "deltaMaterial" REAL NOT NULL DEFAULT 0,
    "deltaOther" REAL NOT NULL DEFAULT 0,
    "deltaTotal" REAL NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ChangeOrder_estimateId_fkey" FOREIGN KEY ("estimateId") REFERENCES "Estimate" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ChangeOrder_parentOptionId_fkey" FOREIGN KEY ("parentOptionId") REFERENCES "EstimateOption" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_ChangeOrder" ("assembliesAddedJson", "assembliesModifiedJson", "assembliesRemovedJson", "createdAt", "deltaLabor", "deltaMaterial", "deltaOther", "deltaTotal", "estimateId", "estimateRevision", "id", "reason", "sequenceNumber", "status", "title") SELECT "assembliesAddedJson", "assembliesModifiedJson", "assembliesRemovedJson", "createdAt", "deltaLabor", "deltaMaterial", "deltaOther", "deltaTotal", "estimateId", "estimateRevision", "id", "reason", "sequenceNumber", "status", "title" FROM "ChangeOrder";
DROP TABLE "ChangeOrder";
ALTER TABLE "new_ChangeOrder" RENAME TO "ChangeOrder";
CREATE UNIQUE INDEX "ChangeOrder_estimateId_sequenceNumber_key" ON "ChangeOrder"("estimateId", "sequenceNumber");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
