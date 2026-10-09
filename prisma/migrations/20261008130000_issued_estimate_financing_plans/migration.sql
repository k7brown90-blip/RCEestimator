-- The Synchrony financing plans in force at issue, frozen on the estimate (2026-10-08, one
-- estimating system, Phase 5). ADD COLUMN only: nullable, no default, no backfill - an estimate
-- issued before this offers no financing figures. Hand-written (like options_d_through_h):
-- `prisma migrate dev` would touch the drifted .env database.
ALTER TABLE "IssuedEstimate" ADD COLUMN "financingPlansJson" TEXT;
