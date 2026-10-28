-- Kyle, 2026-10-27: a line can carry its own customer-facing name. Additive only.
ALTER TABLE "PriceBookDraftLine" ADD COLUMN "customName" TEXT;

-- The price-book name frozen beside the custom one, for the company copy.
ALTER TABLE "IssuedEstimateLine" ADD COLUMN "catalogDescription" TEXT;
