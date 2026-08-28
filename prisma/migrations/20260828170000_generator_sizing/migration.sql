-- P031 generator sizing recommendation (Kyle, 2026-08-27).
-- Both columns nullable TEXT — no default, no backfill needed: a calculation
-- that never asked the generator question stays NULL, and an estimate carries
-- the one-pager only when a human attached it at issuance (propose-only).
ALTER TABLE "CapacityCheck" ADD COLUMN "generatorJson" TEXT;
ALTER TABLE "IssuedEstimate" ADD COLUMN "generatorJson" TEXT;
