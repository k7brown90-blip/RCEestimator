-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_AtomicUnit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "catalog" TEXT NOT NULL DEFAULT 'shared',
    "category" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "unitType" TEXT NOT NULL,
    "visibilityTier" INTEGER NOT NULL DEFAULT 1,
    "baseLaborHrs" REAL NOT NULL DEFAULT 0,
    "baseLaborRate" REAL NOT NULL DEFAULT 115,
    "baseMaterialCost" REAL NOT NULL DEFAULT 0,
    "necRefsJson" TEXT,
    "necaSectionRef" TEXT,
    "requiresCableLength" BOOLEAN NOT NULL DEFAULT false,
    "requiresEndpoint" BOOLEAN NOT NULL DEFAULT false,
    "resolverGroupId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_AtomicUnit" ("baseLaborHrs", "baseLaborRate", "baseMaterialCost", "category", "code", "createdAt", "description", "id", "isActive", "name", "necRefsJson", "necaSectionRef", "requiresCableLength", "requiresEndpoint", "resolverGroupId", "sortOrder", "unitType", "updatedAt", "visibilityTier") SELECT "baseLaborHrs", "baseLaborRate", "baseMaterialCost", "category", "code", "createdAt", "description", "id", "isActive", "name", "necRefsJson", "necaSectionRef", "requiresCableLength", "requiresEndpoint", "resolverGroupId", "sortOrder", "unitType", "updatedAt", "visibilityTier" FROM "AtomicUnit";
DROP TABLE "AtomicUnit";
ALTER TABLE "new_AtomicUnit" RENAME TO "AtomicUnit";
CREATE UNIQUE INDEX "AtomicUnit_catalog_code_key" ON "AtomicUnit"("catalog", "code");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
