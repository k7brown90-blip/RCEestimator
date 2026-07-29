-- Property.jurisdictionId: explicit office override for the code jurisdiction at
-- an address. Nullable with no backfill — null means "derive it" via
-- services/jurisdictionResolver.ts (territories ZIP map, then city map).
-- AlterTable
ALTER TABLE "Property" ADD COLUMN     "jurisdictionId" TEXT;

-- Receipt.jobId was unindexed; the account summary reads receipts by job id
-- across an account's whole job history.
-- CreateIndex
CREATE INDEX "Receipt_jobId_idx" ON "Receipt"("jobId");
