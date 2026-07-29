-- An address should have ONE calculation history, not two.
--
-- The Article 220 calculation taken on item A2 during a Health Record was
-- landing only on HealthInspection.loadCalcJson, while standalone capacity
-- checks landed in CapacityCheck. Same house, same question, two places to
-- look — and two documents that could quote different amperages with nothing
-- explaining why.
--
-- Assessment-derived calculations now also write a CapacityCheck row. This
-- column records which record it came from, because a calculation done with
-- the panel open and the plates read is not the same quality of document as
-- one run in two minutes on the phone, even when they agree.

ALTER TABLE "CapacityCheck" ADD COLUMN IF NOT EXISTS "sourceInspectionId" TEXT;

CREATE INDEX IF NOT EXISTS "CapacityCheck_sourceInspectionId_idx"
  ON "CapacityCheck"("sourceInspectionId");
