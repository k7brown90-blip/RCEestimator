-- Persistent, queryable system event log.
--
-- Until now every runtime failure went to console.error, which scrolls away in
-- Railway and is invisible to anyone auditing after the fact. Two production
-- incidents made the cost concrete: Vapi's create_lead tool silently 401'd for
-- a week after a secret rotation, and Google Calendar connectivity broke with
-- nothing but a generic 500 to show for it. Both would have been one query
-- against this table.
--
-- Also the sink for the CRM feedback box (source = 'feedback'), so operator
-- reports land in the same stream as the errors they describe.
CREATE TABLE IF NOT EXISTS "SystemEvent" (
    "id" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "route" TEXT,
    "detailsJson" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SystemEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "SystemEvent_level_createdAt_idx" ON "SystemEvent"("level", "createdAt");
CREATE INDEX IF NOT EXISTS "SystemEvent_source_createdAt_idx" ON "SystemEvent"("source", "createdAt");
CREATE INDEX IF NOT EXISTS "SystemEvent_createdAt_idx" ON "SystemEvent"("createdAt");
