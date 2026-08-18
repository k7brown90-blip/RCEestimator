-- CreateTable
CREATE TABLE "IssuedEstimate" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "token" TEXT NOT NULL,
    "draftId" TEXT NOT NULL,
    "supersedesId" TEXT,
    "customerId" TEXT,
    "leadId" TEXT,
    "visitId" TEXT,
    "customerName" TEXT NOT NULL,
    "customerEmail" TEXT,
    "customerPhone" TEXT,
    "serviceAddress" TEXT,
    "title" TEXT NOT NULL,
    "scopeText" TEXT,
    "includedText" TEXT,
    "validDays" INTEGER NOT NULL DEFAULT 30,
    "workSubtotal" DOUBLE PRECISION NOT NULL,
    "tripCharge" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "tripWaived" BOOLEAN NOT NULL DEFAULT false,
    "total" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "sentAt" TIMESTAMP(3),
    "sentBy" TEXT,
    "sentTo" TEXT,
    "firstViewedAt" TIMESTAMP(3),
    "signedAt" TIMESTAMP(3),
    "signerName" TEXT,
    "signerIp" TEXT,
    "signerUserAgent" TEXT,
    "consentText" TEXT,
    "voidedAt" TIMESTAMP(3),
    "voidReason" TEXT,

    CONSTRAINT "IssuedEstimate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IssuedEstimateLine" (
    "id" TEXT NOT NULL,
    "estimateId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "unitPrice" DOUBLE PRECISION NOT NULL,
    "lineTotal" DOUBLE PRECISION NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "IssuedEstimateLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IssuedEstimateEvent" (
    "id" TEXT NOT NULL,
    "estimateId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor" TEXT NOT NULL,
    "detail" TEXT,

    CONSTRAINT "IssuedEstimateEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "IssuedEstimate_token_key" ON "IssuedEstimate"("token");

-- CreateIndex
CREATE UNIQUE INDEX "IssuedEstimate_supersedesId_key" ON "IssuedEstimate"("supersedesId");

-- CreateIndex
CREATE INDEX "IssuedEstimate_status_createdAt_idx" ON "IssuedEstimate"("status", "createdAt");

-- CreateIndex
CREATE INDEX "IssuedEstimate_draftId_idx" ON "IssuedEstimate"("draftId");

-- CreateIndex
CREATE UNIQUE INDEX "IssuedEstimate_number_revision_key" ON "IssuedEstimate"("number", "revision");

-- CreateIndex
CREATE INDEX "IssuedEstimateLine_estimateId_idx" ON "IssuedEstimateLine"("estimateId");

-- CreateIndex
CREATE INDEX "IssuedEstimateLine_itemId_idx" ON "IssuedEstimateLine"("itemId");

-- CreateIndex
CREATE INDEX "IssuedEstimateEvent_estimateId_at_idx" ON "IssuedEstimateEvent"("estimateId", "at");

-- AddForeignKey
ALTER TABLE "IssuedEstimate" ADD CONSTRAINT "IssuedEstimate_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "PriceBookDraftEstimate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IssuedEstimate" ADD CONSTRAINT "IssuedEstimate_supersedesId_fkey" FOREIGN KEY ("supersedesId") REFERENCES "IssuedEstimate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IssuedEstimateLine" ADD CONSTRAINT "IssuedEstimateLine_estimateId_fkey" FOREIGN KEY ("estimateId") REFERENCES "IssuedEstimate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IssuedEstimateLine" ADD CONSTRAINT "IssuedEstimateLine_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "PriceBookAtomic"("itemId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IssuedEstimateEvent" ADD CONSTRAINT "IssuedEstimateEvent_estimateId_fkey" FOREIGN KEY ("estimateId") REFERENCES "IssuedEstimate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

