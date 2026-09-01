-- The job-level material cap's scope is continuous-length material only (Kyle, 2026-08-31,
-- "split the difference"): wire, cable and conduit are banded and scaled as a job; unit items
-- (SMMs, panels, disconnects, breakers, fittings) sell at their book price. Frozen per issued
-- line so signing and the customer page recompute the combination discount over the same
-- population the issue used. Existing rows default TRUE — they were issued with every line
-- in the cap, and their numbers must not move.
ALTER TABLE "IssuedEstimateLine" ADD COLUMN "inMaterialCap" BOOLEAN NOT NULL DEFAULT true;
