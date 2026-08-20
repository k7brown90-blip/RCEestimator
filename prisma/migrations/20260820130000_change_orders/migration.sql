-- Change orders (Kyle, 2026-08-19).
--
-- A signed estimate is never revised. A change order is a separate draft that points at it, may
-- carry negative line quantities to remove work, and is signed in its own right.

ALTER TABLE "PriceBookDraftEstimate" ADD COLUMN "changeOrderForId" TEXT;

CREATE INDEX "PriceBookDraftEstimate_changeOrderForId_idx"
  ON "PriceBookDraftEstimate"("changeOrderForId");

ALTER TABLE "PriceBookDraftEstimate"
  ADD CONSTRAINT "PriceBookDraftEstimate_changeOrderForId_fkey"
  FOREIGN KEY ("changeOrderForId") REFERENCES "IssuedEstimate"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
