-- W2-E (Kyle 2026-11-23 item 7): one CodingRun row per "@Coding" request in a Team, group or crew chat.
-- Made by prisma migrate diff (datamodel to datamodel against the pre-edit schema); no data step is needed.

-- CreateTable
CREATE TABLE "CodingRun" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "triggerMessageId" TEXT NOT NULL,
    "requestedByKey" TEXT NOT NULL,
    "requestedByDisplay" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "refusedReason" TEXT,
    "githubStatus" INTEGER,
    "prUrl" TEXT,
    "branch" TEXT,
    "replyMessageId" TEXT,
    "cancelledByKey" TEXT,
    "dispatchedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CodingRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CodingRun_triggerMessageId_key" ON "CodingRun"("triggerMessageId");

-- CreateIndex
CREATE INDEX "CodingRun_threadId_status_idx" ON "CodingRun"("threadId", "status");

-- AddForeignKey
ALTER TABLE "CodingRun" ADD CONSTRAINT "CodingRun_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "HubThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CodingRun" ADD CONSTRAINT "CodingRun_triggerMessageId_fkey" FOREIGN KEY ("triggerMessageId") REFERENCES "HubMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

