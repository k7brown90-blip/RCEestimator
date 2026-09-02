-- Assessment / load-calc revisions (Kyle, 2026-09-01): "any change needs to be sent out and
-- overwrite the original... the customer isn't left holding an inaccurate calculation."
-- A revision is a NEW inspection row that names what it revises; the revised row is marked
-- superseded. History is never rewritten — the correction is delivered on top of it.
ALTER TABLE "HealthInspection" ADD COLUMN "revisesId" TEXT;
ALTER TABLE "HealthInspection" ADD COLUMN "supersededById" TEXT;
CREATE INDEX "HealthInspection_revisesId_idx" ON "HealthInspection"("revisesId");
