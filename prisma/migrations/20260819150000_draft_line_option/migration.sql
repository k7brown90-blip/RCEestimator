-- Three options per estimate (Kyle, 2026-08-19).
--
-- Additive and non-destructive: every existing line becomes Option A, which is what they all
-- were before there was anywhere else to put them.

CREATE TYPE "PriceBookOption" AS ENUM ('A', 'B', 'C');

ALTER TABLE "PriceBookDraftLine"
  ADD COLUMN "option" "PriceBookOption" NOT NULL DEFAULT 'A';

CREATE INDEX "PriceBookDraftLine_draftId_option_idx"
  ON "PriceBookDraftLine"("draftId", "option");
