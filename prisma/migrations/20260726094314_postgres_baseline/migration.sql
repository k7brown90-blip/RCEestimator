-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Property" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "addressLine1" TEXT NOT NULL,
    "addressLine2" TEXT,
    "city" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "postalCode" TEXT NOT NULL,
    "notes" TEXT,
    "occupancyType" TEXT NOT NULL DEFAULT 'residential',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Property_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemSnapshot" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "serviceSummary" TEXT,
    "panelSummary" TEXT,
    "groundingSummary" TEXT,
    "wiringMethodSummary" TEXT,
    "deficienciesJson" TEXT,
    "changeLogJson" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Visit" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "purpose" TEXT,
    "visitDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'estimate',
    "jobType" TEXT,
    "estimatedJobLength" DOUBLE PRECISION,
    "estimatedDurationDays" INTEGER,
    "estimatedDurationHours" DOUBLE PRECISION,
    "scheduledStart" TIMESTAMP(3),
    "scheduledEnd" TIMESTAMP(3),
    "googleEventId" TEXT,
    "contractedAt" TIMESTAMP(3),
    "estimatedCost" DOUBLE PRECISION,
    "actualMaterialCost" DOUBLE PRECISION DEFAULT 0,
    "laborHours" DOUBLE PRECISION DEFAULT 0,
    "overheadAllocation" DOUBLE PRECISION DEFAULT 0,
    "revenue" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Visit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Technician" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "role" TEXT NOT NULL DEFAULT 'technician',
    "accessToken" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Technician_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VisitAssignment" (
    "id" TEXT NOT NULL,
    "visitId" TEXT NOT NULL,
    "technicianId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'primary',
    "status" TEXT NOT NULL DEFAULT 'assigned',
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "VisitAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HealthInspection" (
    "id" TEXT NOT NULL,
    "visitId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "technicianId" TEXT,
    "jurisdictionId" TEXT NOT NULL,
    "inspectionDate" TIMESTAMP(3) NOT NULL,
    "score" INTEGER NOT NULL,
    "itemsAssessed" INTEGER NOT NULL,
    "criticalFindingsJson" TEXT NOT NULL,
    "contractorReviewed" BOOLEAN NOT NULL DEFAULT false,
    "itemsJson" TEXT NOT NULL,
    "loadCalcJson" TEXT,
    "appVersion" TEXT,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HealthInspection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerRequest" (
    "id" TEXT NOT NULL,
    "visitId" TEXT NOT NULL,
    "requestText" TEXT NOT NULL,
    "urgency" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Observation" (
    "id" TEXT NOT NULL,
    "visitId" TEXT NOT NULL,
    "location" TEXT,
    "observationText" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Observation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Finding" (
    "id" TEXT NOT NULL,
    "visitId" TEXT NOT NULL,
    "findingText" TEXT NOT NULL,
    "confidence" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Finding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Limitation" (
    "id" TEXT NOT NULL,
    "visitId" TEXT NOT NULL,
    "limitationText" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Limitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Recommendation" (
    "id" TEXT NOT NULL,
    "visitId" TEXT NOT NULL,
    "recommendationText" TEXT NOT NULL,
    "priority" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Recommendation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Estimate" (
    "id" TEXT NOT NULL,
    "visitId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "title" TEXT NOT NULL,
    "notes" TEXT,
    "materialMarkupPct" DOUBLE PRECISION NOT NULL DEFAULT 30,
    "laborMarkupPct" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "lockedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Estimate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EstimateOption" (
    "id" TEXT NOT NULL,
    "estimateId" TEXT NOT NULL,
    "optionLabel" TEXT NOT NULL,
    "description" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "accepted" BOOLEAN NOT NULL DEFAULT false,
    "subtotalLabor" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "subtotalMaterial" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "subtotalOther" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalCost" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "EstimateOption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssemblyTemplate" (
    "id" TEXT NOT NULL,
    "assemblyNumber" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT,
    "tier" TEXT NOT NULL,
    "laborClass" TEXT,
    "applicableModesJson" TEXT,
    "parametersJson" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssemblyTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssemblyParameterDefinition" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "valueType" TEXT NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "defaultValueJson" TEXT,
    "enumOptionsJson" TEXT,
    "unit" TEXT,
    "helpText" TEXT,
    "estimatorFacing" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "minValue" DOUBLE PRECISION,
    "maxValue" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssemblyParameterDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssemblyTemplateVariant" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "variantKey" TEXT NOT NULL,
    "variantValue" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssemblyTemplateVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssemblyTemplateChild" (
    "id" TEXT NOT NULL,
    "parentTemplateId" TEXT NOT NULL,
    "childTemplateId" TEXT NOT NULL,
    "quantity" INTEGER,
    "qtyParameterRef" TEXT,
    "required" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "AssemblyTemplateChild_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssemblyTemplateComponent" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "componentType" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "quantityExpr" TEXT,
    "unit" TEXT,
    "unitCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "laborHours" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "laborRate" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "AssemblyTemplateComponent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EstimateAssembly" (
    "id" TEXT NOT NULL,
    "optionId" TEXT NOT NULL,
    "assemblyTemplateId" TEXT NOT NULL,
    "location" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "parametersJson" TEXT,
    "modifiersJson" TEXT,
    "expandedFromPackageId" TEXT,
    "manualLaborOverride" DOUBLE PRECISION,
    "manualMaterialOverride" DOUBLE PRECISION,
    "assemblyNotes" TEXT,
    "laborCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "materialCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "otherCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalCost" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "EstimateAssembly_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssemblyComponent" (
    "id" TEXT NOT NULL,
    "estimateAssemblyId" TEXT NOT NULL,
    "componentType" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "unit" TEXT,
    "unitCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "laborHours" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "laborRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "extendedCost" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "AssemblyComponent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProposalDelivery" (
    "id" TEXT NOT NULL,
    "estimateId" TEXT NOT NULL,
    "estimateRevision" INTEGER NOT NULL,
    "method" TEXT NOT NULL,
    "recipient" TEXT,
    "deliveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "pdfPath" TEXT NOT NULL,
    "notes" TEXT,

    CONSTRAINT "ProposalDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SignatureRecord" (
    "id" TEXT NOT NULL,
    "estimateId" TEXT NOT NULL,
    "estimateRevision" INTEGER NOT NULL,
    "signerName" TEXT NOT NULL,
    "signerEmail" TEXT,
    "signedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "signatureData" TEXT NOT NULL,
    "consentText" TEXT NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "SignatureRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProposalAcceptance" (
    "id" TEXT NOT NULL,
    "estimateId" TEXT NOT NULL,
    "estimateRevision" INTEGER NOT NULL,
    "optionId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "signatureId" TEXT,
    "notes" TEXT,

    CONSTRAINT "ProposalAcceptance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PermitStatus" (
    "id" TEXT NOT NULL,
    "estimateId" TEXT NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "permitType" TEXT,
    "status" TEXT NOT NULL DEFAULT 'not_required',
    "permitNumber" TEXT,
    "filingDate" TIMESTAMP(3),
    "issuedDate" TIMESTAMP(3),
    "cost" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "PermitStatus_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InspectionStatus" (
    "id" TEXT NOT NULL,
    "estimateId" TEXT NOT NULL,
    "inspectionType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'not_scheduled',
    "scheduledDate" TIMESTAMP(3),
    "resultDate" TIMESTAMP(3),
    "notes" TEXT,
    "correctionsJson" TEXT,

    CONSTRAINT "InspectionStatus_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChangeOrder" (
    "id" TEXT NOT NULL,
    "estimateId" TEXT NOT NULL,
    "parentOptionId" TEXT NOT NULL,
    "sequenceNumber" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "reason" TEXT,
    "reasonType" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "estimateRevision" INTEGER NOT NULL,
    "assembliesAddedJson" TEXT,
    "assembliesRemovedJson" TEXT,
    "assembliesModifiedJson" TEXT,
    "deltaLabor" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "deltaMaterial" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "deltaOther" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "deltaTotal" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChangeOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AtomicUnit" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "catalog" TEXT NOT NULL DEFAULT 'shared',
    "category" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "unitType" TEXT NOT NULL,
    "visibilityTier" INTEGER NOT NULL DEFAULT 1,
    "baseLaborHrs" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "baseLaborRate" DOUBLE PRECISION NOT NULL DEFAULT 115,
    "baseMaterialCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "necRefsJson" TEXT,
    "necaSectionRef" TEXT,
    "requiresCableLength" BOOLEAN NOT NULL DEFAULT false,
    "requiresEndpoint" BOOLEAN NOT NULL DEFAULT false,
    "resolverGroupId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AtomicUnit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModifierDef" (
    "id" TEXT NOT NULL,
    "modifierType" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "laborMultiplier" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "materialMult" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "appliesTo" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ModifierDef_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EstimateItem" (
    "id" TEXT NOT NULL,
    "estimateOptionId" TEXT NOT NULL,
    "atomicUnitId" TEXT NOT NULL,
    "location" TEXT,
    "quantity" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "snapshotLaborHrs" DOUBLE PRECISION NOT NULL,
    "snapshotLaborRate" DOUBLE PRECISION NOT NULL,
    "snapshotMaterialCost" DOUBLE PRECISION NOT NULL,
    "circuitVoltage" INTEGER,
    "circuitAmperage" INTEGER,
    "environment" TEXT,
    "exposure" TEXT,
    "cableLength" DOUBLE PRECISION,
    "needsThreeWire" BOOLEAN,
    "resolvedWiringMethod" TEXT,
    "resolvedCableCode" TEXT,
    "resolvedCableLaborHrs" DOUBLE PRECISION,
    "resolvedCableLaborCost" DOUBLE PRECISION,
    "resolvedCableMaterialCost" DOUBLE PRECISION,
    "laborCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "materialCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "otherCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "notes" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EstimateItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ItemModifier" (
    "id" TEXT NOT NULL,
    "estimateItemId" TEXT NOT NULL,
    "modifierType" TEXT NOT NULL,
    "modifierValue" TEXT NOT NULL,
    "laborMultiplier" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "materialMult" DOUBLE PRECISION NOT NULL DEFAULT 1.0,

    CONSTRAINT "ItemModifier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EstimateModifier" (
    "id" TEXT NOT NULL,
    "estimateId" TEXT NOT NULL,
    "modifierType" TEXT NOT NULL,
    "modifierValue" TEXT NOT NULL,
    "laborMultiplier" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "materialMult" DOUBLE PRECISION NOT NULL DEFAULT 1.0,

    CONSTRAINT "EstimateModifier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportItem" (
    "id" TEXT NOT NULL,
    "estimateId" TEXT NOT NULL,
    "supportType" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "laborHrs" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "laborRate" DOUBLE PRECISION NOT NULL DEFAULT 115,
    "laborCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "otherCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "isOverridden" BOOLEAN NOT NULL DEFAULT false,
    "overrideNote" TEXT,
    "sourceRule" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Preset" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT,
    "itemsJson" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Preset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobType" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "occupancyDefault" TEXT NOT NULL DEFAULT 'residential',
    "environmentDefault" TEXT NOT NULL DEFAULT 'interior',
    "exposureDefault" TEXT NOT NULL DEFAULT 'concealed',
    "resolverProfileJson" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "JobType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Lead" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "source" TEXT NOT NULL DEFAULT 'email',
    "status" TEXT NOT NULL DEFAULT 'new',
    "notes" TEXT,
    "address" TEXT,
    "jobType" TEXT,
    "callType" TEXT,
    "referredBy" TEXT,
    "urgentFlag" BOOLEAN NOT NULL DEFAULT false,
    "warrantyCall" BOOLEAN NOT NULL DEFAULT false,
    "warrantyNote" TEXT,
    "contactPreference" TEXT,
    "leadStatus" TEXT NOT NULL DEFAULT 'new',
    "followUpDate" TIMESTAMP(3),
    "followUpReason" TEXT,
    "followUpCount" INTEGER NOT NULL DEFAULT 0,
    "lostReason" TEXT,
    "lostNotes" TEXT,
    "bestTimeToReach" TEXT,
    "estimateId" TEXT,
    "existingVisitId" TEXT,
    "customerId" TEXT,
    "propertyId" TEXT,
    "visitId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Receipt" (
    "id" TEXT NOT NULL,
    "jobId" TEXT,
    "category" TEXT NOT NULL,
    "vendor" TEXT,
    "amount" DOUBLE PRECISION NOT NULL,
    "lineItems" TEXT,
    "imageUrl" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Receipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Document" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "pdfUrl" TEXT NOT NULL,
    "signedAt" TIMESTAMP(3),
    "signedByIp" TEXT,
    "signedByName" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaterialOrder" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "supplier" TEXT NOT NULL,
    "items" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MaterialOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentAuditLog" (
    "id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "agent" TEXT,
    "endpoint" TEXT,
    "visitId" TEXT,
    "entityType" TEXT,
    "entityId" TEXT,
    "payloadJson" TEXT,
    "responseStatus" INTEGER,
    "durationMs" INTEGER,
    "clientRequestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentIdempotency" (
    "id" TEXT NOT NULL,
    "clientRequestId" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "agent" TEXT,
    "visitId" TEXT,
    "responseJson" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentIdempotency_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatMessage" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "visitId" TEXT,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "openaiResponseId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Customer_phone_idx" ON "Customer"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "SystemSnapshot_propertyId_key" ON "SystemSnapshot"("propertyId");

-- CreateIndex
CREATE INDEX "Visit_customerId_visitDate_idx" ON "Visit"("customerId", "visitDate");

-- CreateIndex
CREATE INDEX "Visit_status_scheduledStart_idx" ON "Visit"("status", "scheduledStart");

-- CreateIndex
CREATE UNIQUE INDEX "Technician_accessToken_key" ON "Technician"("accessToken");

-- CreateIndex
CREATE UNIQUE INDEX "VisitAssignment_visitId_technicianId_key" ON "VisitAssignment"("visitId", "technicianId");

-- CreateIndex
CREATE INDEX "HealthInspection_customerId_inspectionDate_idx" ON "HealthInspection"("customerId", "inspectionDate");

-- CreateIndex
CREATE INDEX "HealthInspection_propertyId_inspectionDate_idx" ON "HealthInspection"("propertyId", "inspectionDate");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerRequest_visitId_key" ON "CustomerRequest"("visitId");

-- CreateIndex
CREATE UNIQUE INDEX "AssemblyParameterDefinition_templateId_key_key" ON "AssemblyParameterDefinition"("templateId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "AssemblyTemplateVariant_templateId_variantKey_variantValue_key" ON "AssemblyTemplateVariant"("templateId", "variantKey", "variantValue");

-- CreateIndex
CREATE UNIQUE INDEX "ProposalAcceptance_estimateId_key" ON "ProposalAcceptance"("estimateId");

-- CreateIndex
CREATE UNIQUE INDEX "PermitStatus_estimateId_key" ON "PermitStatus"("estimateId");

-- CreateIndex
CREATE UNIQUE INDEX "ChangeOrder_estimateId_sequenceNumber_key" ON "ChangeOrder"("estimateId", "sequenceNumber");

-- CreateIndex
CREATE UNIQUE INDEX "AtomicUnit_catalog_code_key" ON "AtomicUnit"("catalog", "code");

-- CreateIndex
CREATE UNIQUE INDEX "ModifierDef_modifierType_value_key" ON "ModifierDef"("modifierType", "value");

-- CreateIndex
CREATE UNIQUE INDEX "EstimateModifier_estimateId_modifierType_key" ON "EstimateModifier"("estimateId", "modifierType");

-- CreateIndex
CREATE UNIQUE INDEX "JobType_name_key" ON "JobType"("name");

-- CreateIndex
CREATE INDEX "Lead_customerId_idx" ON "Lead"("customerId");

-- CreateIndex
CREATE INDEX "Lead_leadStatus_followUpDate_idx" ON "Lead"("leadStatus", "followUpDate");

-- CreateIndex
CREATE INDEX "Lead_phone_idx" ON "Lead"("phone");

-- CreateIndex
CREATE INDEX "Lead_createdAt_idx" ON "Lead"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AgentIdempotency_clientRequestId_endpoint_key" ON "AgentIdempotency"("clientRequestId", "endpoint");

-- CreateIndex
CREATE INDEX "ChatMessage_visitId_createdAt_idx" ON "ChatMessage"("visitId", "createdAt");

-- CreateIndex
CREATE INDEX "ChatMessage_sessionId_createdAt_idx" ON "ChatMessage"("sessionId", "createdAt");

-- AddForeignKey
ALTER TABLE "Property" ADD CONSTRAINT "Property_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SystemSnapshot" ADD CONSTRAINT "SystemSnapshot_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Visit" ADD CONSTRAINT "Visit_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Visit" ADD CONSTRAINT "Visit_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisitAssignment" ADD CONSTRAINT "VisitAssignment_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "Visit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisitAssignment" ADD CONSTRAINT "VisitAssignment_technicianId_fkey" FOREIGN KEY ("technicianId") REFERENCES "Technician"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HealthInspection" ADD CONSTRAINT "HealthInspection_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "Visit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HealthInspection" ADD CONSTRAINT "HealthInspection_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HealthInspection" ADD CONSTRAINT "HealthInspection_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HealthInspection" ADD CONSTRAINT "HealthInspection_technicianId_fkey" FOREIGN KEY ("technicianId") REFERENCES "Technician"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerRequest" ADD CONSTRAINT "CustomerRequest_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "Visit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Observation" ADD CONSTRAINT "Observation_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "Visit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Finding" ADD CONSTRAINT "Finding_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "Visit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Limitation" ADD CONSTRAINT "Limitation_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "Visit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Recommendation" ADD CONSTRAINT "Recommendation_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "Visit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Estimate" ADD CONSTRAINT "Estimate_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "Visit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Estimate" ADD CONSTRAINT "Estimate_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EstimateOption" ADD CONSTRAINT "EstimateOption_estimateId_fkey" FOREIGN KEY ("estimateId") REFERENCES "Estimate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssemblyParameterDefinition" ADD CONSTRAINT "AssemblyParameterDefinition_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "AssemblyTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssemblyTemplateVariant" ADD CONSTRAINT "AssemblyTemplateVariant_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "AssemblyTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssemblyTemplateChild" ADD CONSTRAINT "AssemblyTemplateChild_parentTemplateId_fkey" FOREIGN KEY ("parentTemplateId") REFERENCES "AssemblyTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssemblyTemplateChild" ADD CONSTRAINT "AssemblyTemplateChild_childTemplateId_fkey" FOREIGN KEY ("childTemplateId") REFERENCES "AssemblyTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssemblyTemplateComponent" ADD CONSTRAINT "AssemblyTemplateComponent_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "AssemblyTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EstimateAssembly" ADD CONSTRAINT "EstimateAssembly_optionId_fkey" FOREIGN KEY ("optionId") REFERENCES "EstimateOption"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EstimateAssembly" ADD CONSTRAINT "EstimateAssembly_assemblyTemplateId_fkey" FOREIGN KEY ("assemblyTemplateId") REFERENCES "AssemblyTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssemblyComponent" ADD CONSTRAINT "AssemblyComponent_estimateAssemblyId_fkey" FOREIGN KEY ("estimateAssemblyId") REFERENCES "EstimateAssembly"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProposalDelivery" ADD CONSTRAINT "ProposalDelivery_estimateId_fkey" FOREIGN KEY ("estimateId") REFERENCES "Estimate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SignatureRecord" ADD CONSTRAINT "SignatureRecord_estimateId_fkey" FOREIGN KEY ("estimateId") REFERENCES "Estimate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProposalAcceptance" ADD CONSTRAINT "ProposalAcceptance_estimateId_fkey" FOREIGN KEY ("estimateId") REFERENCES "Estimate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PermitStatus" ADD CONSTRAINT "PermitStatus_estimateId_fkey" FOREIGN KEY ("estimateId") REFERENCES "Estimate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InspectionStatus" ADD CONSTRAINT "InspectionStatus_estimateId_fkey" FOREIGN KEY ("estimateId") REFERENCES "Estimate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChangeOrder" ADD CONSTRAINT "ChangeOrder_estimateId_fkey" FOREIGN KEY ("estimateId") REFERENCES "Estimate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChangeOrder" ADD CONSTRAINT "ChangeOrder_parentOptionId_fkey" FOREIGN KEY ("parentOptionId") REFERENCES "EstimateOption"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EstimateItem" ADD CONSTRAINT "EstimateItem_estimateOptionId_fkey" FOREIGN KEY ("estimateOptionId") REFERENCES "EstimateOption"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EstimateItem" ADD CONSTRAINT "EstimateItem_atomicUnitId_fkey" FOREIGN KEY ("atomicUnitId") REFERENCES "AtomicUnit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemModifier" ADD CONSTRAINT "ItemModifier_estimateItemId_fkey" FOREIGN KEY ("estimateItemId") REFERENCES "EstimateItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EstimateModifier" ADD CONSTRAINT "EstimateModifier_estimateId_fkey" FOREIGN KEY ("estimateId") REFERENCES "Estimate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportItem" ADD CONSTRAINT "SupportItem_estimateId_fkey" FOREIGN KEY ("estimateId") REFERENCES "Estimate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Visit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaterialOrder" ADD CONSTRAINT "MaterialOrder_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Visit"("id") ON DELETE CASCADE ON UPDATE CASCADE;
