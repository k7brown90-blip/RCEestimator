-- CreateTable
CREATE TABLE "AssemblyParameterDefinition" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "templateId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "valueType" TEXT NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "defaultValueJson" TEXT,
    "enumOptionsJson" TEXT,
    "unit" TEXT,
    "helpText" TEXT,
    "estimatorFacing" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "minValue" REAL,
    "maxValue" REAL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AssemblyParameterDefinition_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "AssemblyTemplate" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AssemblyTemplateVariant" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "templateId" TEXT NOT NULL,
    "variantKey" TEXT NOT NULL,
    "variantValue" TEXT,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AssemblyTemplateVariant_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "AssemblyTemplate" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "AssemblyParameterDefinition_templateId_key_key" ON "AssemblyParameterDefinition"("templateId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "AssemblyTemplateVariant_templateId_variantKey_variantValue_key" ON "AssemblyTemplateVariant"("templateId", "variantKey", "variantValue");
