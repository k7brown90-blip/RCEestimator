-- Material COST on the frozen line (Kyle, 2026-08-20).
--
-- "Column E = company cost. Column F = what we charge... In the estimate column E is what we see
--  to track spending."
--
-- The charge was already frozen; the cost was not, so a signed job could not report what it
-- actually cost without re-deriving it from a catalog that may have moved on. Nullable: rows
-- issued before today have no recorded cost, and 0 would claim the material was free.

ALTER TABLE "IssuedEstimateLine" ADD COLUMN "materialCost" DOUBLE PRECISION;
