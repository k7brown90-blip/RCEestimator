-- The time clock (Phase 5, Kyle 2026-08-25: "we need to have a time stamp for
-- labor tracking with a clock in button too"). One row per punch; clock-out
-- rolls the sum into Visit.laborHours for job profitability's labor line.
CREATE TABLE "TimeEntry" (
    "id"           TEXT NOT NULL,
    "visitId"      TEXT NOT NULL,
    "technicianId" TEXT,
    "startedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt"      TIMESTAMP(3),
    "minutes"      DOUBLE PRECISION,
    CONSTRAINT "TimeEntry_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "TimeEntry_visitId_idx" ON "TimeEntry"("visitId");
CREATE INDEX "TimeEntry_technicianId_endedAt_idx" ON "TimeEntry"("technicianId", "endedAt");
ALTER TABLE "TimeEntry" ADD CONSTRAINT "TimeEntry_visitId_fkey"
    FOREIGN KEY ("visitId") REFERENCES "Visit"("id") ON DELETE CASCADE ON UPDATE CASCADE;
