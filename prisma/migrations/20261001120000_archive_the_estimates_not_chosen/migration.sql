-- Archive the estimates that were not chosen (Kyle, 2026-10-01: "once a job is sold the other
-- ones that are not chosen should be archived. ... The first one totaling over $14,000 is now
-- irrelevent and can be archived.").
--
-- No new status: `status` is the allow-list every money and reporting surface reads, and adding
-- a value to it is how a sale silently leaves the books. Archiving is orthogonal — the row keeps
-- whatever status it had — and is reversible (Unarchive on the estimate drawer). An archived row
-- is always unsigned: the signature and the office acceptance clear both columns as they write.
-- Both null on every existing row: nothing is archived by this migration. Arlene's 2026-1096 is
-- archived by hand from the drawer, or the next time an estimate at that address is signed.

ALTER TABLE "IssuedEstimate" ADD COLUMN "archivedAt" TIMESTAMP(3);
ALTER TABLE "IssuedEstimate" ADD COLUMN "archivedReason" TEXT;
