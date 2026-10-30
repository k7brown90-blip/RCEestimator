-- CreateTable
CREATE TABLE "BookingChat" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "leadId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "srcParam" TEXT,
    "platform" TEXT,
    "priority" BOOLEAN NOT NULL DEFAULT false,
    "priorityQuote" TEXT,
    "originalRequest" TEXT,
    "squareFootage" TEXT,
    "yearBuilt" TEXT,
    "concernsJson" TEXT NOT NULL DEFAULT '[]',
    "questionsJson" TEXT NOT NULL DEFAULT '[]',
    "prepAreasJson" TEXT NOT NULL DEFAULT '[]',
    "transcriptJson" TEXT NOT NULL DEFAULT '[]',
    "heldEventId" TEXT,
    "heldStart" TIMESTAMP(3),
    "heldEnd" TIMESTAMP(3),
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "aiCallCount" INTEGER NOT NULL DEFAULT 0,
    "visitorIpHash" TEXT,
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kyleNotifiedAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookingChat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadPhoto" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "room" TEXT,
    "caption" TEXT,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeadPhoto_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BookingChat_token_key" ON "BookingChat"("token");

-- CreateIndex
CREATE UNIQUE INDEX "BookingChat_leadId_key" ON "BookingChat"("leadId");

-- CreateIndex
CREATE INDEX "BookingChat_status_lastActivityAt_idx" ON "BookingChat"("status", "lastActivityAt");

-- CreateIndex
CREATE INDEX "BookingChat_visitorIpHash_createdAt_idx" ON "BookingChat"("visitorIpHash", "createdAt");

-- CreateIndex
CREATE INDEX "LeadPhoto_leadId_idx" ON "LeadPhoto"("leadId");

-- AddForeignKey
ALTER TABLE "BookingChat" ADD CONSTRAINT "BookingChat_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadPhoto" ADD CONSTRAINT "LeadPhoto_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

