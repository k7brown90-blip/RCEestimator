-- CreateEnum
CREATE TYPE "PriceBookQuotable" AS ENUM ('YES', 'NO', 'NEVER');

-- CreateTable
CREATE TABLE "PriceBookImportRun" (
    "id" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL,
    "workbookSha256" TEXT NOT NULL,
    "workbookPath" TEXT NOT NULL,
    "workbookMtime" TIMESTAMP(3),
    "mappingVersion" TEXT NOT NULL,
    "billedLaborRate" DOUBLE PRECISION,
    "provisional" BOOLEAN NOT NULL DEFAULT false,
    "provisionalReason" TEXT,
    "activeSupplierId" TEXT,
    "countsJson" TEXT,
    "parityRan" BOOLEAN NOT NULL DEFAULT false,
    "parityPassed" BOOLEAN,
    "parityJson" TEXT,
    "deltaReportPath" TEXT,
    "errorMessage" TEXT,

    CONSTRAINT "PriceBookImportRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceBookSupplier" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "branch" TEXT,
    "channel" TEXT,
    "accountClass" TEXT,
    "quotable" "PriceBookQuotable" NOT NULL,
    "quotableRaw" TEXT,
    "leadTime" TEXT,
    "terms" TEXT,
    "notes" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PriceBookSupplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceBookSupplierPrice" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "priceAsPrinted" DOUBLE PRECISION,
    "pricedUom" TEXT,
    "packQty" DOUBLE PRECISION,
    "unitCost" DOUBLE PRECISION,
    "datePriced" TEXT,
    "source" TEXT,
    "availability" TEXT,
    "accountClass" TEXT,
    "quotable" "PriceBookQuotable" NOT NULL,
    "quotableRaw" TEXT,
    "quotableKey" TEXT,
    "confidence" TEXT,
    "notes" TEXT,
    "workbookRow" INTEGER,
    "lastSeenImportId" TEXT,

    CONSTRAINT "PriceBookSupplierPrice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceBookAtomic" (
    "itemId" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT,
    "sector" TEXT,
    "unit" TEXT,
    "rowType" TEXT,
    "laborNormal" DOUBLE PRECISION,
    "laborDifficult" DOUBLE PRECISION,
    "laborVeryDifficult" DOUBLE PRECISION,
    "difficultyCurve" TEXT,
    "laborStatus" TEXT,
    "necaUnitBasis" TEXT,
    "necaPdfPage" TEXT,
    "retailCost" DOUBLE PRECISION,
    "tradeCost" DOUBLE PRECISION,
    "purchaseUnit" TEXT,
    "purchasePackQty" DOUBLE PRECISION,
    "purchasePrice" DOUBLE PRECISION,
    "costBasisUsed" DOUBLE PRECISION,
    "costBasisSupplier" TEXT,
    "markupTier" TEXT,
    "sellPricePerUnit" DOUBLE PRECISION,
    "necArticle" TEXT,
    "notes" TEXT,
    "workbookRow" INTEGER,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "retiredAt" TIMESTAMP(3),

    CONSTRAINT "PriceBookAtomic_pkey" PRIMARY KEY ("itemId")
);

-- CreateTable
CREATE TABLE "PriceBookAssembly" (
    "assemblyId" TEXT NOT NULL,
    "name" TEXT,
    "sector" TEXT,
    "useCase" TEXT,
    "status" TEXT,
    "superseded" BOOLEAN NOT NULL DEFAULT false,
    "totalLaborNormal" DOUBLE PRECISION,
    "totalLaborFormula" TEXT,
    "laborFormulaIsFrozen" BOOLEAN NOT NULL DEFAULT true,
    "difficultySetting" TEXT,
    "fieldDifficulty" TEXT,
    "permitRequiredRaw" TEXT,
    "utilityStandbyRaw" TEXT,
    "heightAccessAdderHours" DOUBLE PRECISION,
    "ceilingHeightBand" TEXT,
    "jobType" TEXT,
    "sourcingChannel" TEXT,
    "wbLaborHoursAdjusted" DOUBLE PRECISION,
    "wbLaborDollars" DOUBLE PRECISION,
    "wbMaterialCost" DOUBLE PRECISION,
    "wbMaterialSell" DOUBLE PRECISION,
    "wbJobAdderHours" DOUBLE PRECISION,
    "wbJobAdderDollars" DOUBLE PRECISION,
    "wbPermitFee" DOUBLE PRECISION,
    "wbTotalFlatRate" DOUBLE PRECISION,
    "wbComponentsUnpriced" INTEGER,
    "wbMaterialComplete" TEXT,
    "wbTotalJobHours" DOUBLE PRECISION,
    "wbJobFixedCost" DOUBLE PRECISION,
    "wbTotalWithFixedCost" DOUBLE PRECISION,
    "necCodeRefs" TEXT,
    "necCategory" TEXT,
    "pricingFlags" TEXT,
    "notes" TEXT,
    "componentProse" TEXT,
    "componentsTotalDeclared" INTEGER,
    "workbookRow" INTEGER,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "retiredAt" TIMESTAMP(3),

    CONSTRAINT "PriceBookAssembly_pkey" PRIMARY KEY ("assemblyId")
);

-- CreateTable
CREATE TABLE "PriceBookAssemblyComponent" (
    "id" TEXT NOT NULL,
    "assemblyId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "atomicRow" INTEGER,

    CONSTRAINT "PriceBookAssemblyComponent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceBookRateConfig" (
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "workbookRow" INTEGER NOT NULL,
    "numberValue" DOUBLE PRECISION,
    "textValue" TEXT,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PriceBookRateConfig_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "PriceBookNecCategory" (
    "article" TEXT NOT NULL,
    "title" TEXT,
    "onKyleList" TEXT,
    "scopeRule" TEXT,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PriceBookNecCategory_pkey" PRIMARY KEY ("article")
);

-- CreateIndex
CREATE INDEX "PriceBookImportRun_startedAt_idx" ON "PriceBookImportRun"("startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PriceBookSupplierPrice_quotableKey_key" ON "PriceBookSupplierPrice"("quotableKey");

-- CreateIndex
CREATE INDEX "PriceBookSupplierPrice_itemId_idx" ON "PriceBookSupplierPrice"("itemId");

-- CreateIndex
CREATE INDEX "PriceBookSupplierPrice_quotableKey_idx" ON "PriceBookSupplierPrice"("quotableKey");

-- CreateIndex
CREATE UNIQUE INDEX "PriceBookSupplierPrice_itemId_supplierId_key" ON "PriceBookSupplierPrice"("itemId", "supplierId");

-- CreateIndex
CREATE INDEX "PriceBookAtomic_category_idx" ON "PriceBookAtomic"("category");

-- CreateIndex
CREATE INDEX "PriceBookAtomic_retiredAt_idx" ON "PriceBookAtomic"("retiredAt");

-- CreateIndex
CREATE INDEX "PriceBookAssembly_sector_idx" ON "PriceBookAssembly"("sector");

-- CreateIndex
CREATE INDEX "PriceBookAssembly_superseded_idx" ON "PriceBookAssembly"("superseded");

-- CreateIndex
CREATE INDEX "PriceBookAssembly_retiredAt_idx" ON "PriceBookAssembly"("retiredAt");

-- CreateIndex
CREATE INDEX "PriceBookAssemblyComponent_itemId_idx" ON "PriceBookAssemblyComponent"("itemId");

-- CreateIndex
CREATE UNIQUE INDEX "PriceBookAssemblyComponent_assemblyId_itemId_atomicRow_key" ON "PriceBookAssemblyComponent"("assemblyId", "itemId", "atomicRow");

-- AddForeignKey
ALTER TABLE "PriceBookSupplierPrice" ADD CONSTRAINT "PriceBookSupplierPrice_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "PriceBookSupplier"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceBookAssemblyComponent" ADD CONSTRAINT "PriceBookAssemblyComponent_assemblyId_fkey" FOREIGN KEY ("assemblyId") REFERENCES "PriceBookAssembly"("assemblyId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceBookAssemblyComponent" ADD CONSTRAINT "PriceBookAssemblyComponent_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "PriceBookAtomic"("itemId") ON DELETE RESTRICT ON UPDATE CASCADE;
