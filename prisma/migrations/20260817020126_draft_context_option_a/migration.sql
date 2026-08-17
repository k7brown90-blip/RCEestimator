-- AlterTable
ALTER TABLE "PriceBookDraftEstimate" ADD COLUMN     "customerId" TEXT,
ADD COLUMN     "leadId" TEXT,
ADD COLUMN     "visitId" TEXT;

-- AddForeignKey
ALTER TABLE "PriceBookDraftEstimate" ADD CONSTRAINT "PriceBookDraftEstimate_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceBookDraftEstimate" ADD CONSTRAINT "PriceBookDraftEstimate_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceBookDraftEstimate" ADD CONSTRAINT "PriceBookDraftEstimate_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "Visit"("id") ON DELETE SET NULL ON UPDATE CASCADE;
