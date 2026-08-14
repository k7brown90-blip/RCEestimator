-- CreateEnum
CREATE TYPE "PriceBookLineState" AS ENUM ('PROPOSED', 'CONFIRMED');

-- AlterTable
ALTER TABLE "PriceBookDraftLine" ADD COLUMN     "confirmedAt" TIMESTAMP(3),
ADD COLUMN     "confirmedBy" TEXT,
ADD COLUMN     "editedBeforeConfirm" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "proposalReasoning" TEXT,
ADD COLUMN     "proposedAt" TIMESTAMP(3),
ADD COLUMN     "proposedBy" TEXT,
ADD COLUMN     "state" "PriceBookLineState" NOT NULL DEFAULT 'PROPOSED';

-- CreateTable
CREATE TABLE "PriceBookDraftQuestion" (
    "id" TEXT NOT NULL,
    "draftId" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "rawText" TEXT,
    "raisedBy" TEXT NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "resolutionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PriceBookDraftQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PriceBookDraftQuestion_draftId_resolvedAt_idx" ON "PriceBookDraftQuestion"("draftId", "resolvedAt");

-- CreateIndex
CREATE INDEX "PriceBookDraftLine_draftId_state_idx" ON "PriceBookDraftLine"("draftId", "state");

-- AddForeignKey
ALTER TABLE "PriceBookDraftQuestion" ADD CONSTRAINT "PriceBookDraftQuestion_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "PriceBookDraftEstimate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
