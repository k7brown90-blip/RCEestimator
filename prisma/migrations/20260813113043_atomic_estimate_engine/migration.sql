-- CreateEnum
CREATE TYPE "PriceBookDifficulty" AS ENUM ('NORMAL', 'DIFFICULT', 'VERY_DIFFICULT');

-- CreateEnum
CREATE TYPE "PriceBookQuantitySource" AS ENUM ('COUNT', 'MEASURED_LENGTH', 'TERMINATION_COUNT', 'MANUAL');

-- AlterTable
ALTER TABLE "PriceBookAtomic" ADD COLUMN     "laborUnitBasis" TEXT,
ADD COLUMN     "laborUnitBasisRaw" TEXT,
ADD COLUMN     "laborUnitDivisor" DOUBLE PRECISION;

-- CreateTable
CREATE TABLE "PriceBookDraftEstimate" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "jobDescription" TEXT,
    "scenarioRef" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "finalizedAt" TIMESTAMP(3),
    "billedLaborRate" DOUBLE PRECISION,
    "rateProvisional" BOOLEAN NOT NULL DEFAULT false,
    "provisionalReason" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PriceBookDraftEstimate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceBookDraftLine" (
    "id" TEXT NOT NULL,
    "draftId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "quantitySource" "PriceBookQuantitySource" NOT NULL,
    "difficulty" "PriceBookDifficulty" NOT NULL DEFAULT 'NORMAL',
    "location" TEXT,
    "note" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PriceBookDraftLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PriceBookDraftEstimate_status_createdAt_idx" ON "PriceBookDraftEstimate"("status", "createdAt");

-- CreateIndex
CREATE INDEX "PriceBookDraftLine_draftId_idx" ON "PriceBookDraftLine"("draftId");

-- CreateIndex
CREATE INDEX "PriceBookDraftLine_itemId_idx" ON "PriceBookDraftLine"("itemId");

-- AddForeignKey
ALTER TABLE "PriceBookDraftLine" ADD CONSTRAINT "PriceBookDraftLine_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "PriceBookDraftEstimate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceBookDraftLine" ADD CONSTRAINT "PriceBookDraftLine_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "PriceBookAtomic"("itemId") ON DELETE RESTRICT ON UPDATE CASCADE;
