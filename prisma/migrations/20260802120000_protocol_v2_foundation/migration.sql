-- Health Assessment Protocol v2 — foundation data model.
--
-- Turns the checklist inspection into an evidence-based, function-tested
-- record per the master protocol (2026-08-02): enclosures as first-class rows,
-- structured measurements with validation, bus visual rubric, GFCI coverage
-- resolved by location, disclosed sampling, versioned reference data, and an
-- internal-only MONITOR recurrence tracker (pending counsel review).
--
-- Everything EXTENDS HealthInspection: itemsJson remains the v1 checklist
-- payload; v2 rows hang off the same inspection id. Reference tables are
-- append-only by policy (spec_version / superseded_by); the application never
-- updates them in place, because a historical inspection must reproduce the
-- spec value applied on its date forever.

-- ── Property: code-era resolution inputs (§1.3) ──
ALTER TABLE "Property" ADD COLUMN IF NOT EXISTS "ahjCodeEdition" TEXT;
ALTER TABLE "Property" ADD COLUMN IF NOT EXISTS "estimatedInstallYear" INTEGER;
ALTER TABLE "Property" ADD COLUMN IF NOT EXISTS "conductorMaterialService" TEXT;
ALTER TABLE "Property" ADD COLUMN IF NOT EXISTS "conductorMaterialBranch" TEXT;

-- ── Reference data ──
CREATE TABLE IF NOT EXISTS "PanelManufacturer" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "PanelManufacturer_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "PanelManufacturer_name_key" ON "PanelManufacturer"("name");

CREATE TABLE IF NOT EXISTS "PanelModel" (
    "id" TEXT NOT NULL,
    "manufacturerId" TEXT NOT NULL,
    "modelDesignation" TEXT NOT NULL,
    "frameType" TEXT,
    "isObsoleteLine" BOOLEAN NOT NULL DEFAULT false,
    "hazardFlag" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    CONSTRAINT "PanelModel_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PanelModel_manufacturerId_fkey" FOREIGN KEY ("manufacturerId") REFERENCES "PanelManufacturer"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "PanelModel_manufacturerId_modelDesignation_key" ON "PanelModel"("manufacturerId", "modelDesignation");

CREATE TABLE IF NOT EXISTS "TorqueSpec" (
    "id" TEXT NOT NULL,
    "panelModelId" TEXT,
    "conductorSizeMin" TEXT,
    "conductorSizeMax" TEXT,
    "breakerRatingMinA" INTEGER,
    "breakerRatingMaxA" INTEGER,
    "torqueValue" DOUBLE PRECISION NOT NULL,
    "torqueUnit" TEXT NOT NULL,
    "sourceCitation" TEXT NOT NULL,
    "sourceConfidence" TEXT NOT NULL,
    "verifiedSource" TEXT,
    "verificationDate" TIMESTAMP(3),
    "specVersion" INTEGER NOT NULL DEFAULT 1,
    "supersededById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TorqueSpec_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TorqueSpec_panelModelId_fkey" FOREIGN KEY ("panelModelId") REFERENCES "PanelModel"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "TorqueSpec_panelModelId_idx" ON "TorqueSpec"("panelModelId");

CREATE TABLE IF NOT EXISTS "ThermalThreshold" (
    "id" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "deltaTMinC" DOUBLE PRECISION NOT NULL,
    "deltaTMaxC" DOUBLE PRECISION,
    "classification" TEXT NOT NULL,
    "recommendedAction" TEXT NOT NULL,
    "standardCitation" TEXT NOT NULL,
    "specVersion" INTEGER NOT NULL DEFAULT 1,
    "supersededById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ThermalThreshold_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "CodeRequirement" (
    "id" TEXT NOT NULL,
    "necArticle" TEXT NOT NULL,
    "necEditionIntroduced" TEXT NOT NULL,
    "requirementType" TEXT NOT NULL,
    "appliesTo" TEXT NOT NULL,
    "isRetroactive" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT NOT NULL,
    CONSTRAINT "CodeRequirement_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "CodeRequirement_requirementType_idx" ON "CodeRequirement"("requirementType");

-- ── Operational data ──
CREATE TABLE IF NOT EXISTS "Enclosure" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "locationKey" TEXT NOT NULL,
    "enclosureType" TEXT NOT NULL,
    "disconnectSubtype" TEXT,
    "equipmentServed" TEXT,
    "panelModelId" TEXT,
    "locationDescription" TEXT,
    "distanceFromMainFt" DOUBLE PRECISION,
    "labelTorqueValueObserved" TEXT,
    "labelLegible" BOOLEAN,
    "busMaterial" TEXT,
    "serviceSideEnergized" BOOLEAN NOT NULL DEFAULT false,
    "retiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Enclosure_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Enclosure_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "Enclosure_propertyId_locationKey_key" ON "Enclosure"("propertyId", "locationKey");
CREATE INDEX IF NOT EXISTS "Enclosure_propertyId_idx" ON "Enclosure"("propertyId");

CREATE TABLE IF NOT EXISTS "InspectionItem" (
    "id" TEXT NOT NULL,
    "inspectionId" TEXT NOT NULL,
    "enclosureId" TEXT,
    "componentType" TEXT NOT NULL,
    "locationLabel" TEXT,
    "circuitNumber" TEXT,
    "busLeg" TEXT,
    "stabPosition" INTEGER,
    "classification" TEXT NOT NULL,
    "codeEditionApplied" TEXT,
    "techNote" TEXT,
    "customerVisible" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "InspectionItem_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "InspectionItem_inspectionId_fkey" FOREIGN KEY ("inspectionId") REFERENCES "HealthInspection"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "InspectionItem_enclosureId_fkey" FOREIGN KEY ("enclosureId") REFERENCES "Enclosure"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "InspectionItem_inspectionId_idx" ON "InspectionItem"("inspectionId");
CREATE INDEX IF NOT EXISTS "InspectionItem_enclosureId_idx" ON "InspectionItem"("enclosureId");

CREATE TABLE IF NOT EXISTS "Measurement" (
    "id" TEXT NOT NULL,
    "inspectionItemId" TEXT NOT NULL,
    "measurementType" TEXT NOT NULL,
    "measuredValue" DOUBLE PRECISION NOT NULL,
    "unit" TEXT NOT NULL,
    "referenceValueApplied" DOUBLE PRECISION,
    "referenceSourceId" TEXT,
    "referenceMethod" TEXT,
    "comparativeReferenceItemId" TEXT,
    "comparativeLoadDeltaAmps" DOUBLE PRECISION,
    "loadAmperageAtReading" DOUBLE PRECISION,
    "ambientAtReadingC" DOUBLE PRECISION,
    "methodStandard" TEXT,
    "methodConditionsMet" BOOLEAN NOT NULL DEFAULT true,
    "classificationCeiling" TEXT NOT NULL DEFAULT 'pass_fail',
    "passed" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Measurement_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Measurement_inspectionItemId_fkey" FOREIGN KEY ("inspectionItemId") REFERENCES "InspectionItem"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "Measurement_inspectionItemId_idx" ON "Measurement"("inspectionItemId");

CREATE TABLE IF NOT EXISTS "BusVisualAssessment" (
    "id" TEXT NOT NULL,
    "inspectionItemId" TEXT NOT NULL,
    "corrosionLocation" TEXT NOT NULL,
    "corrosionProduct" TEXT,
    "platingStatus" TEXT NOT NULL,
    "materialLoss" TEXT NOT NULL,
    "arcSignature" TEXT NOT NULL,
    "adjacentPolymer" TEXT NOT NULL,
    "heatTintMetal" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BusVisualAssessment_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "BusVisualAssessment_inspectionItemId_fkey" FOREIGN KEY ("inspectionItemId") REFERENCES "InspectionItem"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "BusVisualAssessment_inspectionItemId_key" ON "BusVisualAssessment"("inspectionItemId");

CREATE TABLE IF NOT EXISTS "GfciCoverage" (
    "id" TEXT NOT NULL,
    "inspectionId" TEXT NOT NULL,
    "locationDescriptor" TEXT NOT NULL,
    "requiredAtInstall" BOOLEAN NOT NULL,
    "requiredCurrentCode" BOOLEAN NOT NULL,
    "protectionSource" TEXT NOT NULL,
    "functionTestResult" TEXT,
    "classification" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GfciCoverage_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "GfciCoverage_inspectionId_fkey" FOREIGN KEY ("inspectionId") REFERENCES "HealthInspection"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "GfciCoverage_inspectionId_idx" ON "GfciCoverage"("inspectionId");

CREATE TABLE IF NOT EXISTS "SamplingRecord" (
    "id" TEXT NOT NULL,
    "inspectionId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "totalCount" INTEGER NOT NULL,
    "testedCount" INTEGER NOT NULL,
    "basis" TEXT NOT NULL,
    "expandedDueToFail" BOOLEAN NOT NULL DEFAULT false,
    "untestedLocations" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SamplingRecord_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SamplingRecord_inspectionId_fkey" FOREIGN KEY ("inspectionId") REFERENCES "HealthInspection"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "SamplingRecord_inspectionId_idx" ON "SamplingRecord"("inspectionId");

-- Internal-only pending counsel review (§1.5). Deliberately NO FK into
-- customer-facing chains beyond property.
CREATE TABLE IF NOT EXISTS "MonitorTracker" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "inspectionItemId" TEXT,
    "locationKey" TEXT NOT NULL DEFAULT '_default',
    "componentType" TEXT NOT NULL,
    "firstObservedInspectionId" TEXT NOT NULL,
    "lastObservedInspectionId" TEXT NOT NULL,
    "occurrenceCount" INTEGER NOT NULL DEFAULT 1,
    "trendDirection" TEXT,
    "internalNotes" TEXT,
    "followUpDueDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MonitorTracker_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "MonitorTracker_propertyId_idx" ON "MonitorTracker"("propertyId");
CREATE INDEX IF NOT EXISTS "MonitorTracker_followUpDueDate_idx" ON "MonitorTracker"("followUpDueDate");
