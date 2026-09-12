-- DropIndex
DROP INDEX "PriceBookDraftEstimate_changeOrderForId_idx";

-- AlterTable
ALTER TABLE "IssuedEstimate" ALTER COLUMN "selectedOptions" DROP DEFAULT;

-- CreateTable
CREATE TABLE "Material" (
    "id" TEXT NOT NULL,
    "upc" TEXT,
    "sku" TEXT,
    "supplier" TEXT,
    "description" TEXT,
    "packQty" DOUBLE PRECISION,
    "packUnit" TEXT,
    "lastCost" DOUBLE PRECISION,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "symbology" TEXT,
    "itemId" TEXT,

    CONSTRAINT "Material_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Material_upc_key" ON "Material"("upc");

-- CreateIndex
CREATE INDEX "Material_itemId_idx" ON "Material"("itemId");

-- CreateIndex
CREATE INDEX "Material_supplier_idx" ON "Material"("supplier");

-- CreateIndex
CREATE UNIQUE INDEX "Material_supplier_sku_key" ON "Material"("supplier", "sku");
