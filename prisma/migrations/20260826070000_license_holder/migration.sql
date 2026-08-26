-- License holder flag (Kyle, 2026-08-25): "This has been reviewed and a whole
-- inspection was done, that was the review." An inspection performed by the
-- license holder satisfies the contractor-review requirement automatically;
-- the gate stays armed for future techs without the flag.
ALTER TABLE "Technician" ADD COLUMN "licenseHolder" BOOLEAN NOT NULL DEFAULT false;

-- Kyle's own technician row (RCE-101) is the license holder.
UPDATE "Technician" SET "licenseHolder" = true WHERE "employeeNumber" = 'RCE-101';
