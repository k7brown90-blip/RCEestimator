/*
  Warnings:

  - A unique constraint covering the columns `[confirmationToken]` on the table `Visit` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "Receipt" ADD COLUMN     "imageData" BYTEA,
ADD COLUMN     "imageMime" TEXT,
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'webhook',
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'confirmed',
ADD COLUMN     "technicianId" TEXT;

-- AlterTable
ALTER TABLE "Visit" ADD COLUMN     "confirmationChannel" TEXT,
ADD COLUMN     "confirmationStatus" TEXT NOT NULL DEFAULT 'unconfirmed',
ADD COLUMN     "confirmationToken" TEXT,
ADD COLUMN     "confirmedAt" TIMESTAMP(3),
ADD COLUMN     "reminderSentAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "VisitPhoto" (
    "id" TEXT NOT NULL,
    "visitId" TEXT NOT NULL,
    "technicianId" TEXT,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "caption" TEXT,
    "data" BYTEA NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VisitPhoto_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InboundMessage" (
    "id" TEXT NOT NULL,
    "fromPhone" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "numMedia" INTEGER NOT NULL DEFAULT 0,
    "matchType" TEXT NOT NULL,
    "matchId" TEXT,
    "handledAs" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InboundMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VisitPhoto_visitId_idx" ON "VisitPhoto"("visitId");

-- CreateIndex
CREATE INDEX "InboundMessage_fromPhone_createdAt_idx" ON "InboundMessage"("fromPhone", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Visit_confirmationToken_key" ON "Visit"("confirmationToken");

-- AddForeignKey
ALTER TABLE "VisitPhoto" ADD CONSTRAINT "VisitPhoto_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "Visit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisitPhoto" ADD CONSTRAINT "VisitPhoto_technicianId_fkey" FOREIGN KEY ("technicianId") REFERENCES "Technician"("id") ON DELETE SET NULL ON UPDATE CASCADE;
