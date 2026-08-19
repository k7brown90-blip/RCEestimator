-- The company copy's data, frozen with the rest of the estimate (Kyle, 2026-08-19).
--
-- Additive. Existing rows get option A — every estimate issued before options existed was, in
-- effect, "what the client called for". laborHours and materialSell stay NULL on those rows,
-- which is honest: nobody recorded them at the time, and defaulting them to 0 would assert that
-- those jobs had no labour and no material.

ALTER TABLE "IssuedEstimateLine"
  ADD COLUMN "option" "PriceBookOption" NOT NULL DEFAULT 'A',
  ADD COLUMN "laborHours" DOUBLE PRECISION,
  ADD COLUMN "materialSell" DOUBLE PRECISION;
