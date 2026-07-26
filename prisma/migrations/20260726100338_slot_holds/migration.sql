-- CreateTable
CREATE TABLE "SlotHold" (
    "id" TEXT NOT NULL,
    "holdDate" TEXT NOT NULL,
    "jobId" TEXT,
    "heldBy" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SlotHold_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SlotHold_expiresAt_idx" ON "SlotHold"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "SlotHold_holdDate_key" ON "SlotHold"("holdDate");
