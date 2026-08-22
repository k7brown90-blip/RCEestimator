-- Freeze the job-level band schedule onto the estimate that was priced with it (2026-08-22).
--
-- The bands moved into Rate Config so Kyle can tune them without a deploy. That is what makes
-- this column necessary: the combination discounts on an unsigned estimate's customer page are
-- recomputed on every render, and without the schedule frozen they would be recomputed against
-- whatever Kyle set LAST — silently restating a price he had already quoted, on a page the
-- customer may have open.
--
-- Same discipline as the frozen lines, the frozen options, and the frozen caps: a document says
-- what it said when it was issued.
--
-- Nullable, no backfill. Estimates issued before the schedule was configurable were priced with
-- the code's own constant, and that constant is still the fallback when this is null.

ALTER TABLE "IssuedEstimate" ADD COLUMN "jobBandsJson" TEXT;
