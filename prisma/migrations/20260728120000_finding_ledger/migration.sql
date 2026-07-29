-- Finding ledger: two tracks (defect → corrected, upgrade → replaced/upgraded)
-- over a per-property, per-item, per-location row with an append-only history.

-- Document can now belong to an address rather than a job. A cure certificate
-- for work a third party did has no Red Cedar visit to hang on.
ALTER TABLE "Document" DROP CONSTRAINT IF EXISTS "Document_jobId_fkey";
ALTER TABLE "Document" ALTER COLUMN "jobId" DROP NOT NULL;
ALTER TABLE "Document" ADD COLUMN IF NOT EXISTS "propertyId" TEXT;
ALTER TABLE "Document"
  ADD CONSTRAINT "Document_jobId_fkey" FOREIGN KEY ("jobId")
  REFERENCES "Visit"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Document"
  ADD CONSTRAINT "Document_propertyId_fkey" FOREIGN KEY ("propertyId")
  REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX IF NOT EXISTS "Document_propertyId_type_idx" ON "Document"("propertyId", "type");

CREATE TABLE "PropertyFinding" (
  "id" TEXT NOT NULL,
  "propertyId" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "itemId" TEXT NOT NULL,
  "locationKey" TEXT NOT NULL DEFAULT '_default',
  "cycle" INTEGER NOT NULL DEFAULT 1,
  "track" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "section" TEXT,
  "citationsJson" TEXT NOT NULL,
  "jurisdictionId" TEXT NOT NULL,
  "severity" TEXT NOT NULL,
  "gradedState" TEXT,
  "critical" BOOLEAN NOT NULL DEFAULT false,
  "findingText" TEXT NOT NULL,
  "resolutionNote" TEXT,
  "expectedEolYear" INTEGER,
  "followUpAt" TIMESTAMP(3),
  "status" TEXT NOT NULL DEFAULT 'open',
  "openedInspectionId" TEXT NOT NULL,
  "openedVisitId" TEXT NOT NULL,
  "openedAt" TIMESTAMP(3) NOT NULL,
  "openedByTechnicianId" TEXT,
  "lastObservedInspectionId" TEXT,
  "lastObservedAt" TIMESTAMP(3),
  "observedCount" INTEGER NOT NULL DEFAULT 1,
  "verifiedPassInspectionId" TEXT,
  "verifiedPassAt" TIMESTAMP(3),
  "scheduledVisitId" TEXT,
  "scheduledAt" TIMESTAMP(3),
  "resolvedAt" TIMESTAMP(3),
  "resolutionMethod" TEXT,
  "resolvedByParty" TEXT,
  "resolvedByPartyName" TEXT,
  "resolvedByVisitId" TEXT,
  "resolvedByTechnicianId" TEXT,
  "resolutionDetail" TEXT,
  "certificateDocId" TEXT,
  "declinedAt" TIMESTAMP(3),
  "declinedByName" TEXT,
  "declinedByRelation" TEXT,
  "declinedVerbatim" TEXT,
  "declinedChannel" TEXT,
  "declinationDocId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PropertyFinding_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PropertyFinding_propertyId_status_idx" ON "PropertyFinding"("propertyId", "status");
CREATE INDEX "PropertyFinding_customerId_status_idx" ON "PropertyFinding"("customerId", "status");
CREATE INDEX "PropertyFinding_track_status_followUpAt_idx" ON "PropertyFinding"("track", "status", "followUpAt");

-- At most one LIVE row per (property, item, location). Recurrence after a cure
-- opens cycle + 1 instead of mutating the resolved row — the sequence
-- documented → corrected → recurred is the most valuable thing in the record.
-- Prisma cannot express a partial unique index, so this is hand-written and the
-- test setup applies it separately (tests/globalSetup.ts).
CREATE UNIQUE INDEX "PropertyFinding_live_unique"
  ON "PropertyFinding"("propertyId", "itemId", "locationKey")
  WHERE "status" IN ('open', 'scheduled');

ALTER TABLE "PropertyFinding"
  ADD CONSTRAINT "PropertyFinding_propertyId_fkey" FOREIGN KEY ("propertyId")
  REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "PropertyFindingEvent" (
  "id" TEXT NOT NULL,
  "findingId" TEXT NOT NULL,
  "fromStatus" TEXT,
  "toStatus" TEXT NOT NULL,
  "actorType" TEXT NOT NULL,
  "actorId" TEXT,
  "actorName" TEXT NOT NULL,
  "visitId" TEXT,
  "inspectionId" TEXT,
  "documentId" TEXT,
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PropertyFindingEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PropertyFindingEvent_findingId_inspectionId_toStatus_key"
  ON "PropertyFindingEvent"("findingId", "inspectionId", "toStatus");
CREATE INDEX "PropertyFindingEvent_findingId_createdAt_idx"
  ON "PropertyFindingEvent"("findingId", "createdAt");

ALTER TABLE "PropertyFindingEvent"
  ADD CONSTRAINT "PropertyFindingEvent_findingId_fkey" FOREIGN KEY ("findingId")
  REFERENCES "PropertyFinding"("id") ON DELETE CASCADE ON UPDATE CASCADE;
