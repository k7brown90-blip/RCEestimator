-- Account conversation notes (Kyle, 2026-10-01: "Notes should be account based for an admin that
-- is answering calls and dispatching. Any info gathered during a conversation should be able to be
-- documented and shared with others per account.").
--
-- A new table, not a column: `Visit.notes` is one overwritable box about one job, with no author
-- and no time, and it stays exactly what it is. This is a running log on the ACCOUNT that several
-- people add to — one row per conversation, who took it, when, and optionally which job it was
-- about. Nothing existing is touched or migrated.
--
-- `takenBy` is typed by the person recording the call: there is no per-user identity in this app
-- (one shared PIN), so the server cannot know who took it and will not invent an author.
--
-- Deletes: the account OWNS the log, so deleting the account takes its notes with it (CASCADE,
-- like CustomerContact). The job link is a TAG, so deleting the job keeps the note on the account
-- and only clears the tag (SET NULL, like EmailDelivery.visitId).

-- CreateTable
CREATE TABLE "CustomerNote" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "visitId" TEXT,
    "body" TEXT NOT NULL,
    "takenBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerNote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CustomerNote_customerId_createdAt_idx" ON "CustomerNote"("customerId", "createdAt");

-- CreateIndex
CREATE INDEX "CustomerNote_visitId_idx" ON "CustomerNote"("visitId");

-- AddForeignKey
ALTER TABLE "CustomerNote" ADD CONSTRAINT "CustomerNote_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerNote" ADD CONSTRAINT "CustomerNote_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "Visit"("id") ON DELETE SET NULL ON UPDATE CASCADE;
