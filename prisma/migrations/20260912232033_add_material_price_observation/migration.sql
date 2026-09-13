-- CreateTable
CREATE TABLE "MaterialPriceObservation" (
    "id" TEXT NOT NULL,
    "materialId" TEXT NOT NULL,
    "itemId" TEXT,
    "supplier" TEXT,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "qty" DOUBLE PRECISION NOT NULL,
    "unitCost" DOUBLE PRECISION NOT NULL,
    "source" TEXT NOT NULL,
    "matchMethod" TEXT NOT NULL,
    "receiptId" TEXT,
    "purchaseOrderLineId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MaterialPriceObservation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MaterialPriceObservation_materialId_idx" ON "MaterialPriceObservation"("materialId");

-- CreateIndex
CREATE INDEX "MaterialPriceObservation_itemId_idx" ON "MaterialPriceObservation"("itemId");

-- CreateIndex
CREATE INDEX "MaterialPriceObservation_observedAt_idx" ON "MaterialPriceObservation"("observedAt");

-- CreateIndex
CREATE INDEX "MaterialPriceObservation_receiptId_idx" ON "MaterialPriceObservation"("receiptId");

-- AddForeignKey
ALTER TABLE "MaterialPriceObservation" ADD CONSTRAINT "MaterialPriceObservation_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "Material"("id") ON DELETE CASCADE ON UPDATE CASCADE;
