-- CreateTable
CREATE TABLE "EstimateModifier" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "estimateId" TEXT NOT NULL,
    "modifierType" TEXT NOT NULL,
    "modifierValue" TEXT NOT NULL,
    "laborMultiplier" REAL NOT NULL DEFAULT 1.0,
    "materialMult" REAL NOT NULL DEFAULT 1.0,
    CONSTRAINT "EstimateModifier_estimateId_fkey" FOREIGN KEY ("estimateId") REFERENCES "Estimate" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "EstimateModifier_estimateId_modifierType_key" ON "EstimateModifier"("estimateId", "modifierType");
