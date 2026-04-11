-- AlterTable
ALTER TABLE "EstimateAssembly" ADD COLUMN "assemblyNotes" TEXT;

-- CreateTable
CREATE TABLE "AtomicUnit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
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

-- CreateTable
CREATE TABLE "ModifierDef" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "modifierType" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "laborMultiplier" REAL NOT NULL DEFAULT 1.0,
    "materialMult" REAL NOT NULL DEFAULT 1.0,
    "appliesTo" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isDefault" BOOLEAN NOT NULL DEFAULT false
);

-- CreateTable
CREATE TABLE "EstimateItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "estimateOptionId" TEXT NOT NULL,
    "atomicUnitId" TEXT NOT NULL,
    "location" TEXT,
    "quantity" REAL NOT NULL DEFAULT 1,
    "snapshotLaborHrs" REAL NOT NULL,
    "snapshotLaborRate" REAL NOT NULL,
    "snapshotMaterialCost" REAL NOT NULL,
    "circuitVoltage" INTEGER,
    "circuitAmperage" INTEGER,
    "environment" TEXT,
    "exposure" TEXT,
    "cableLength" REAL,
    "resolvedWiringMethod" TEXT,
    "resolvedCableCode" TEXT,
    "resolvedCableLaborHrs" REAL,
    "resolvedCableLaborCost" REAL,
    "resolvedCableMaterialCost" REAL,
    "laborCost" REAL NOT NULL DEFAULT 0,
    "materialCost" REAL NOT NULL DEFAULT 0,
    "otherCost" REAL NOT NULL DEFAULT 0,
    "totalCost" REAL NOT NULL DEFAULT 0,
    "notes" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "EstimateItem_estimateOptionId_fkey" FOREIGN KEY ("estimateOptionId") REFERENCES "EstimateOption" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "EstimateItem_atomicUnitId_fkey" FOREIGN KEY ("atomicUnitId") REFERENCES "AtomicUnit" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ItemModifier" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "estimateItemId" TEXT NOT NULL,
    "modifierType" TEXT NOT NULL,
    "modifierValue" TEXT NOT NULL,
    "laborMultiplier" REAL NOT NULL DEFAULT 1.0,
    "materialMult" REAL NOT NULL DEFAULT 1.0,
    CONSTRAINT "ItemModifier_estimateItemId_fkey" FOREIGN KEY ("estimateItemId") REFERENCES "EstimateItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SupportItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "estimateId" TEXT NOT NULL,
    "supportType" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "laborHrs" REAL NOT NULL DEFAULT 0,
    "laborRate" REAL NOT NULL DEFAULT 115,
    "laborCost" REAL NOT NULL DEFAULT 0,
    "otherCost" REAL NOT NULL DEFAULT 0,
    "totalCost" REAL NOT NULL DEFAULT 0,
    "isOverridden" BOOLEAN NOT NULL DEFAULT false,
    "overrideNote" TEXT,
    "sourceRule" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SupportItem_estimateId_fkey" FOREIGN KEY ("estimateId") REFERENCES "Estimate" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "NECRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ruleCode" TEXT NOT NULL,
    "necArticle" TEXT NOT NULL,
    "triggerCondition" TEXT NOT NULL,
    "promptText" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0
);

-- CreateTable
CREATE TABLE "Preset" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT,
    "itemsJson" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "JobType" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "occupancyDefault" TEXT NOT NULL DEFAULT 'residential',
    "environmentDefault" TEXT NOT NULL DEFAULT 'interior',
    "exposureDefault" TEXT NOT NULL DEFAULT 'concealed',
    "resolverProfileJson" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Estimate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "visitId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "title" TEXT NOT NULL,
    "notes" TEXT,
    "materialMarkupPct" REAL NOT NULL DEFAULT 30,
    "laborMarkupPct" REAL NOT NULL DEFAULT 0,
    "lockedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Estimate_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "Visit" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Estimate_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Estimate" ("createdAt", "id", "lockedAt", "notes", "propertyId", "revision", "status", "title", "updatedAt", "visitId") SELECT "createdAt", "id", "lockedAt", "notes", "propertyId", "revision", "status", "title", "updatedAt", "visitId" FROM "Estimate";
DROP TABLE "Estimate";
ALTER TABLE "new_Estimate" RENAME TO "Estimate";
CREATE TABLE "new_Property" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "customerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "addressLine1" TEXT NOT NULL,
    "addressLine2" TEXT,
    "city" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "postalCode" TEXT NOT NULL,
    "notes" TEXT,
    "occupancyType" TEXT NOT NULL DEFAULT 'residential',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Property_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Property" ("addressLine1", "addressLine2", "city", "createdAt", "customerId", "id", "name", "notes", "postalCode", "state", "updatedAt") SELECT "addressLine1", "addressLine2", "city", "createdAt", "customerId", "id", "name", "notes", "postalCode", "state", "updatedAt" FROM "Property";
DROP TABLE "Property";
ALTER TABLE "new_Property" RENAME TO "Property";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "AtomicUnit_code_key" ON "AtomicUnit"("code");

-- CreateIndex
CREATE UNIQUE INDEX "ModifierDef_modifierType_value_key" ON "ModifierDef"("modifierType", "value");

-- CreateIndex
CREATE UNIQUE INDEX "NECRule_ruleCode_key" ON "NECRule"("ruleCode");

-- CreateIndex
CREATE UNIQUE INDEX "JobType_name_key" ON "JobType"("name");
