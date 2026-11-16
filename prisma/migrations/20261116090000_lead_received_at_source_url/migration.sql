-- Plan lead-intake-fixes F3 (Kyle, 2026-11-15): a lead keeps the day it really reached Red Cedar
-- ("Original received date") and the marketplace's own link to it ("Marketplace link").

-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "sourceUrl" TEXT;

-- Backfill: every lead that exists today arrived when its row was created, so its Received date
-- reads exactly as before. (The ADD COLUMN above stamped them all with the migration's moment.)
UPDATE "Lead" SET "receivedAt" = "createdAt";

-- CreateIndex
CREATE INDEX "Lead_receivedAt_idx" ON "Lead"("receivedAt");
