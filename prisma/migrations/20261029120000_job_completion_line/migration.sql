-- CreateTable
CREATE TABLE "JobCompletionLine" (
    "id" TEXT NOT NULL,
    "visitId" TEXT NOT NULL,
    "issuedEstimateLineId" TEXT NOT NULL,
    "explanation" TEXT NOT NULL DEFAULT '',
    "necRefs" TEXT[],
    "readingsJson" JSONB NOT NULL DEFAULT '[]',
    "photoIds" TEXT[],
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobCompletionLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "JobCompletionLine_issuedEstimateLineId_key" ON "JobCompletionLine"("issuedEstimateLineId");

-- CreateIndex
CREATE INDEX "JobCompletionLine_visitId_idx" ON "JobCompletionLine"("visitId");

-- AddForeignKey
ALTER TABLE "JobCompletionLine" ADD CONSTRAINT "JobCompletionLine_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "Visit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobCompletionLine" ADD CONSTRAINT "JobCompletionLine_issuedEstimateLineId_fkey" FOREIGN KEY ("issuedEstimateLineId") REFERENCES "IssuedEstimateLine"("id") ON DELETE CASCADE ON UPDATE CASCADE;

