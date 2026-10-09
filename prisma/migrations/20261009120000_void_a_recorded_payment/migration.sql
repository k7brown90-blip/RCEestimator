-- A recorded payment can be voided, never deleted (Kyle, 2026-10-08, decision 11 of the
-- one-estimating-system plan, Phase 6 Unit 6B). ADD COLUMN only: nullable, no default, no
-- backfill - every existing row stays a live payment. Hand-written (like options_d_through_h and
-- issued_estimate_financing_plans): `prisma migrate dev` would touch the drifted .env database.
ALTER TABLE "Payment" ADD COLUMN "voidedAt" TIMESTAMP(3);
ALTER TABLE "Payment" ADD COLUMN "voidedBy" TEXT;
ALTER TABLE "Payment" ADD COLUMN "voidReason" TEXT;
