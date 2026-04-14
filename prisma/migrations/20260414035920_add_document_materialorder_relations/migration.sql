-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Document" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "pdfUrl" TEXT NOT NULL,
    "signedAt" DATETIME,
    "signedByIp" TEXT,
    "signedByName" TEXT,
    "sentAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Document_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Visit" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Document" ("createdAt", "id", "jobId", "pdfUrl", "sentAt", "signedAt", "signedByIp", "signedByName", "type") SELECT "createdAt", "id", "jobId", "pdfUrl", "sentAt", "signedAt", "signedByIp", "signedByName", "type" FROM "Document";
DROP TABLE "Document";
ALTER TABLE "new_Document" RENAME TO "Document";
CREATE TABLE "new_MaterialOrder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobId" TEXT NOT NULL,
    "supplier" TEXT NOT NULL,
    "items" TEXT NOT NULL,
    "sentAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MaterialOrder_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Visit" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_MaterialOrder" ("createdAt", "id", "items", "jobId", "sentAt", "supplier") SELECT "createdAt", "id", "items", "jobId", "sentAt", "supplier" FROM "MaterialOrder";
DROP TABLE "MaterialOrder";
ALTER TABLE "new_MaterialOrder" RENAME TO "MaterialOrder";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
