-- THE CIRCUIT DIAGNOSTIC REPORT (Kyle, 2026-09-20).
--
-- "I need the field app to have its own diagnostics report. I am going to charge $25 - $50 for
-- each outlet that is reviewed rather than a flat fee. Price depends on difficulty of access."
--
-- Four new tables, nothing altered, no backfill: DiagnosticReport (one circuit, one visit),
-- DiagnosticOutlet (every box opened, breaker to last outlet), DiagnosticPhoto (bytes in Postgres
-- beside InspectionPhoto so evidence rides the managed backups) and DiagnosticReportDelivery
-- (delivery proof, same reason as HealthReportDelivery).
--
-- `DiagnosticOutlet.difficulty` uses the EXISTING "PriceBookDifficulty" enum rather than a new
-- one: three access tiers are three lines of one price-book item, and no new pricing concept was
-- created for this (the plan's own instruction).
--
-- ── THIS MIGRATION MUST NEVER KILL A DEPLOY ───────────────────────────────────────────────────
-- `npm start` runs `prisma migrate deploy` before the server boots, so a migration that throws
-- leaves production DOWN — the whole CRM, for a feature nobody is using yet. Same guarded pattern
-- as 20260921120000_global_search_finds_every_record: every statement is idempotent
-- (IF NOT EXISTS, and each foreign key is added only when it is not already there), and the
-- whole thing sits in a DO block that turns any error into a WARNING.
--
-- Degrading rather than failing is safe HERE specifically because of the field app's durable
-- queue: a diagnostic captured on a phone is written to IndexedDB before any network call and
-- retries until the server accepts it. If these tables somehow did not get created, pushes 500
-- and stay queued — visible, retryable, nothing lost — instead of the business being offline.
-- Re-running this migration by hand converges.

DO $$
BEGIN

  CREATE TABLE IF NOT EXISTS "DiagnosticReport" (
      "id" TEXT NOT NULL,
      "visitId" TEXT NOT NULL,
      "propertyId" TEXT NOT NULL,
      "customerId" TEXT NOT NULL,
      "technicianId" TEXT,
      "reportDate" TIMESTAMP(3) NOT NULL,
      "complaint" TEXT NOT NULL,
      "circuitLabel" TEXT NOT NULL,
      "circuitNumber" TEXT,
      "panelLocation" TEXT,
      "breakerRating" TEXT,
      "breakerInspected" BOOLEAN NOT NULL DEFAULT false,
      "coverage" TEXT NOT NULL,
      "coverageNote" TEXT,
      "summary" TEXT,
      "diagnosticItemId" TEXT,
      "quotedNormal" INTEGER NOT NULL DEFAULT 0,
      "quotedDifficult" INTEGER NOT NULL DEFAULT 0,
      "quotedVeryDifficult" INTEGER NOT NULL DEFAULT 0,
      "changeOrderDraftId" TEXT,
      "status" TEXT NOT NULL DEFAULT 'in_progress',
      "completedAt" TIMESTAMP(3),
      "voidedAt" TIMESTAMP(3),
      "voidReason" TEXT,
      "appVersion" TEXT,
      "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL,

      CONSTRAINT "DiagnosticReport_pkey" PRIMARY KEY ("id")
  );

  CREATE TABLE IF NOT EXISTS "DiagnosticOutlet" (
      "id" TEXT NOT NULL,
      "reportId" TEXT NOT NULL,
      "sequence" INTEGER NOT NULL,
      "locationLabel" TEXT NOT NULL,
      "deviceType" TEXT NOT NULL,
      "deviceLabel" TEXT,
      "enclosure" TEXT,
      "gangs" INTEGER,
      "circuitNumber" TEXT,
      "difficulty" "PriceBookDifficulty" NOT NULL DEFAULT 'NORMAL',
      "vPhaseGround" DOUBLE PRECISION,
      "vPhaseNeutral" DOUBLE PRECISION,
      "vPhasePhase" DOUBLE PRECISION,
      "terminationsTightened" BOOLEAN NOT NULL DEFAULT false,
      "corrosion" BOOLEAN NOT NULL DEFAULT false,
      "corrosionNote" TEXT,
      "findings" TEXT,
      "fixed" TEXT,
      "equipmentDefective" BOOLEAN NOT NULL DEFAULT false,
      "defectDescription" TEXT,
      "photoIds" TEXT[],
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL,

      CONSTRAINT "DiagnosticOutlet_pkey" PRIMARY KEY ("id")
  );

  CREATE TABLE IF NOT EXISTS "DiagnosticPhoto" (
      "id" TEXT NOT NULL,
      "reportId" TEXT NOT NULL,
      "mimeType" TEXT NOT NULL,
      "sizeBytes" INTEGER NOT NULL,
      "data" BYTEA NOT NULL,
      "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

      CONSTRAINT "DiagnosticPhoto_pkey" PRIMARY KEY ("id")
  );

  CREATE TABLE IF NOT EXISTS "DiagnosticReportDelivery" (
      "id" TEXT NOT NULL,
      "reportId" TEXT NOT NULL,
      "documentId" TEXT NOT NULL,
      "sentTo" TEXT NOT NULL,
      "sentBy" TEXT NOT NULL,
      "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

      CONSTRAINT "DiagnosticReportDelivery_pkey" PRIMARY KEY ("id")
  );

  CREATE INDEX IF NOT EXISTS "DiagnosticReport_visitId_idx" ON "DiagnosticReport"("visitId");
  CREATE INDEX IF NOT EXISTS "DiagnosticReport_propertyId_reportDate_idx" ON "DiagnosticReport"("propertyId", "reportDate");
  CREATE INDEX IF NOT EXISTS "DiagnosticReport_customerId_reportDate_idx" ON "DiagnosticReport"("customerId", "reportDate");
  CREATE INDEX IF NOT EXISTS "DiagnosticOutlet_reportId_sequence_idx" ON "DiagnosticOutlet"("reportId", "sequence");
  CREATE INDEX IF NOT EXISTS "DiagnosticPhoto_reportId_idx" ON "DiagnosticPhoto"("reportId");
  CREATE INDEX IF NOT EXISTS "DiagnosticReportDelivery_reportId_sentAt_idx" ON "DiagnosticReportDelivery"("reportId", "sentAt");

  -- Foreign keys. `ADD CONSTRAINT` has no IF NOT EXISTS in PostgreSQL, so each is guarded by a
  -- catalog lookup — that is what makes a re-run converge instead of throwing duplicate_object.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'DiagnosticReport_diagnosticItemId_fkey') THEN
    ALTER TABLE "DiagnosticReport" ADD CONSTRAINT "DiagnosticReport_diagnosticItemId_fkey"
      FOREIGN KEY ("diagnosticItemId") REFERENCES "PriceBookAtomic"("itemId") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'DiagnosticReport_visitId_fkey') THEN
    ALTER TABLE "DiagnosticReport" ADD CONSTRAINT "DiagnosticReport_visitId_fkey"
      FOREIGN KEY ("visitId") REFERENCES "Visit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'DiagnosticReport_propertyId_fkey') THEN
    ALTER TABLE "DiagnosticReport" ADD CONSTRAINT "DiagnosticReport_propertyId_fkey"
      FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'DiagnosticReport_customerId_fkey') THEN
    ALTER TABLE "DiagnosticReport" ADD CONSTRAINT "DiagnosticReport_customerId_fkey"
      FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'DiagnosticReport_technicianId_fkey') THEN
    ALTER TABLE "DiagnosticReport" ADD CONSTRAINT "DiagnosticReport_technicianId_fkey"
      FOREIGN KEY ("technicianId") REFERENCES "Technician"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'DiagnosticOutlet_reportId_fkey') THEN
    ALTER TABLE "DiagnosticOutlet" ADD CONSTRAINT "DiagnosticOutlet_reportId_fkey"
      FOREIGN KEY ("reportId") REFERENCES "DiagnosticReport"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'DiagnosticPhoto_reportId_fkey') THEN
    ALTER TABLE "DiagnosticPhoto" ADD CONSTRAINT "DiagnosticPhoto_reportId_fkey"
      FOREIGN KEY ("reportId") REFERENCES "DiagnosticReport"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'DiagnosticReportDelivery_reportId_fkey') THEN
    ALTER TABLE "DiagnosticReportDelivery" ADD CONSTRAINT "DiagnosticReportDelivery_reportId_fkey"
      FOREIGN KEY ("reportId") REFERENCES "DiagnosticReport"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

EXCEPTION
  WHEN OTHERS THEN
    RAISE WARNING 'circuit diagnostics: the diagnostic tables were not created (%: %). Field diagnostic pushes will fail and stay in the phone''s durable queue until an administrator re-applies this migration.', SQLSTATE, SQLERRM;
END
$$;

-- NOT INCLUDED, DELIBERATELY. `prisma migrate diff` also emitted
--   DROP INDEX "PriceBookDraftEstimate_changeOrderForId_idx";
--   ALTER TABLE "IssuedEstimate" ALTER COLUMN "selectedOptions" DROP DEFAULT;
-- Those are the two known undeclared leftovers documented in .claude/constants.md ("The dev
-- database is CURRENT again", 2026-09-14) — an index that is a free performance asset and a
-- default Prisma never relies on. They are passengers this migration picked up, exactly as the
-- 2026-09-14 one did, and they are stripped here for the same reason: a migration ships what it
-- means to ship. Any migration generated from this schema will keep emitting them; strip them.
