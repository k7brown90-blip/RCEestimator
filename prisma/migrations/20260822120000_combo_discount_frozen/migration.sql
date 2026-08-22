-- The third gate: the combined selection priced as one job (Kyle, 2026-08-22).
--
-- "If the customer chooses one, two, or three options the savings add up and help push the sale
--  of more work simply by lowing the cost of material. I win because I lose nothing on labor and
--  can get the material all same day."
--
-- Frozen at SIGNATURE rather than at issue: the discount depends on which options the customer
-- ticks, and that selection does not exist until they sign. While unsigned it is recomputed from
-- the frozen lines on every render — deterministic, because the lines are frozen. Once signed it
-- is stored here, because the bands live in code and a band edit must never restate a price a
-- customer put their name to.
--
-- Nullable, no backfill: estimates signed before the gate existed carry no combination discount,
-- and writing one onto them would restate a signed document.

ALTER TABLE "IssuedEstimate" ADD COLUMN "comboCapJson" TEXT;
