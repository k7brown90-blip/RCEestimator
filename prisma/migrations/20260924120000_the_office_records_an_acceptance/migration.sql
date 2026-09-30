-- The office records an acceptance it was told about (Kyle, 2026-09-24: "The customer accepted
-- button would be good on the estimate drawer, no need to do sign in person on the CRM because
-- that is being developed for an admin/dispatcher").
--
-- No new status: the acceptance lands on status "signed" with signedChannel "office" and NO
-- signature image, so every money and reporting allow-list on "signed" still sees the sale.
-- These two columns carry what makes it visibly a different record from a signature: how the
-- customer told us (phone | email | text | writing | in_person) and the office's internal note.
-- Both null on every existing row — every existing signed row is a real signature.

ALTER TABLE "IssuedEstimate" ADD COLUMN "acceptedVia" TEXT;
ALTER TABLE "IssuedEstimate" ADD COLUMN "acceptedNote" TEXT;
