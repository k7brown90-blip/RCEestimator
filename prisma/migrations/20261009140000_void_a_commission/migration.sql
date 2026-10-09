-- A recorded commission can be voided, never deleted (Kyle's standing money-history rule;
-- one-estimating-system plan, Phase 6 CARRY). ADD COLUMN only: nullable, no default, no
-- backfill - every existing row stays a live commission. Hand-written like
-- 20261009120000_void_a_recorded_payment: `prisma migrate dev` would touch the drifted .env database.
ALTER TABLE "Commission" ADD COLUMN "voidedAt" TIMESTAMP(3);
ALTER TABLE "Commission" ADD COLUMN "voidedBy" TEXT;
ALTER TABLE "Commission" ADD COLUMN "voidReason" TEXT;
