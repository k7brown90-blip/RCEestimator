-- NEC Article 220 capacity checks. 220.83 is the everyday calculation; 220.87 is
-- a separately priced study, gated so it can't become the default.

CREATE TABLE "CapacityCheck" (
  "id" TEXT NOT NULL,
  "visitId" TEXT,
  "propertyId" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "technicianId" TEXT,
  "method" TEXT NOT NULL,
  "serviceAmps" INTEGER NOT NULL,
  "serviceVoltage" INTEGER NOT NULL DEFAULT 240,
  "floorAreaSqFt" INTEGER NOT NULL DEFAULT 0,
  "variant" TEXT,
  "newLoadLabel" TEXT,
  "calculatedAmps" DOUBLE PRECISION NOT NULL,
  "loadPct" DOUBLE PRECISION NOT NULL,
  "fits" BOOLEAN NOT NULL,
  "qualifies" BOOLEAN NOT NULL DEFAULT true,
  "inputJson" TEXT NOT NULL,
  "resultJson" TEXT NOT NULL,
  "supersedesId" TEXT,
  "documentId" TEXT,
  "studyInstallVisitId" TEXT,
  "studyRemovalVisitId" TEXT,
  "studyOrderedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CapacityCheck_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CapacityCheck_propertyId_createdAt_idx" ON "CapacityCheck"("propertyId", "createdAt");
CREATE INDEX "CapacityCheck_visitId_idx" ON "CapacityCheck"("visitId");
