-- A signed estimate filed against the account (Kyle, 2026-08-20).
--
-- Additive and nullable: every existing document keeps its filesystem pdfUrl and is untouched.
-- Only rows created for a signed estimate carry this, and those render from the immutable
-- estimate rather than from a file the next deploy would delete.

ALTER TABLE "Document" ADD COLUMN "issuedEstimateId" TEXT;

CREATE INDEX "Document_issuedEstimateId_idx" ON "Document"("issuedEstimateId");

ALTER TABLE "Document"
  ADD CONSTRAINT "Document_issuedEstimateId_fkey"
  FOREIGN KEY ("issuedEstimateId") REFERENCES "IssuedEstimate"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
