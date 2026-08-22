-- The job-level material check, frozen onto the estimate it re-priced (Kyle, 2026-08-21).
--
-- "We have to plan the best way for the material mark ups work against total material cost so it
--  stays within a reasonable range."
--
-- The check itself runs in the engine at compute time; the frozen lines already carry the capped
-- material charge. This column keeps the check's WORKING — cost, what the per-item tiers wanted,
-- the ceiling that governed, the reduction — so the company copy can print it. A price adjustment
-- Kyle cannot see is one he cannot defend when a customer asks.
--
-- Nullable, no backfill: estimates issued before the check existed were never capped, and writing
-- "no cap" onto them would be a claim about a check that never ran.

ALTER TABLE "IssuedEstimate" ADD COLUMN "materialCapsJson" TEXT;
