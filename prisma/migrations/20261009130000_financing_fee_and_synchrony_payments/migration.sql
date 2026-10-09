-- The financing fee record and the Synchrony payment columns (Kyle, 2026-10-08, decisions 7, 8
-- and 12 of the one-estimating-system plan; Phase 6 Unit 6A). ADDITIVE ONLY: a new table and
-- nullable columns with no default and no backfill - every existing Payment row is untouched and
-- no invoice gains a fee. Hand-written (like options_d_through_h, issued_estimate_financing_plans
-- and void_a_recorded_payment): `prisma migrate dev` would touch the drifted .env database.
ALTER TABLE "Payment" ADD COLUMN "financingFeeId" TEXT;
ALTER TABLE "Payment" ADD COLUMN "financingPlanNumber" TEXT;
ALTER TABLE "Payment" ADD COLUMN "financingAuthNumber" TEXT;
ALTER TABLE "Payment" ADD COLUMN "financingNet" DOUBLE PRECISION;
ALTER TABLE "Payment" ADD COLUMN "financingCut" DOUBLE PRECISION;

CREATE TABLE "FinancingFee" (
    "id" TEXT NOT NULL,
    "estimateId" TEXT NOT NULL,
    "planNumber" TEXT NOT NULL,
    "planDescription" TEXT NOT NULL,
    "discountRatePct" DOUBLE PRECISION NOT NULL,
    "feeBaseCents" INTEGER NOT NULL,
    "feeCents" INTEGER NOT NULL,
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appliedBy" TEXT NOT NULL,
    "removedAt" TIMESTAMP(3),
    "removedBy" TEXT,
    "removeReason" TEXT,

    CONSTRAINT "FinancingFee_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "FinancingFee_estimateId_idx" ON "FinancingFee"("estimateId");
