-- Two clocks, kept separate (Kyle, 2026-09-11).
--
-- SHIFT CLOCK = payroll. Clock in / clock out on the field app's main screen,
-- whether or not a job is assigned. Payroll hours are clocked-in to clocked-out.
--
-- JOB CLOCK = job time. Arrive -> Complete, or Pause on a multi-day job. Job
-- hours are the sum of the arrive-to-leave sessions, and they sit INSIDE the
-- shift: arriving while clocked out starts the shift too; clocking out while a
-- job clock runs pauses that job first.
--
-- Shift hours minus job hours is UNBILLED time (drive, shop, supply house) —
-- company overhead, reported and never charged to a customer.
--
-- A pay rate is FROZEN onto each entry when it closes ("a raise changes
-- tomorrow, never last month"), which is why rateApplied lives on the row and
-- not only on the technician. A technician with no rate contributes hours but
-- NO cost — rates are typed by Kyle, never defaulted.
--
-- A clock still running after 12 hours is FLAGGED, stops accruing, and the tech
-- is asked on the main screen to confirm the real end time; flagged entries are
-- excluded from every total until confirmedAt is set.

-- ── Shift entries (payroll) ──────────────────────────────────────────────────
CREATE TABLE "ShiftEntry" (
    "id"           TEXT NOT NULL,
    "technicianId" TEXT NOT NULL,
    "startedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt"      TIMESTAMP(3),
    "minutes"      DOUBLE PRECISION,
    -- The rate frozen when the entry closed. NULL = no rate on file: hours, no cost.
    "rateApplied"  DOUBLE PRECISION,
    "source"       TEXT NOT NULL DEFAULT 'field',  -- field | office
    "note"         TEXT,
    "flaggedAt"    TIMESTAMP(3),
    "confirmedAt"  TIMESTAMP(3),
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ShiftEntry_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ShiftEntry_technicianId_fkey" FOREIGN KEY ("technicianId")
        REFERENCES "Technician"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "ShiftEntry_technicianId_startedAt_idx" ON "ShiftEntry"("technicianId", "startedAt");
CREATE INDEX "ShiftEntry_endedAt_idx" ON "ShiftEntry"("endedAt");

-- ── Job sessions gain the same vocabulary ────────────────────────────────────
-- visitId/technicianId are untouched: technicianId stays optional for legacy
-- punches written before the tech was recorded. Every new write sets it.
ALTER TABLE "TimeEntry" ADD COLUMN "endedReason"  TEXT;              -- completed | paused | clock_out | manual
ALTER TABLE "TimeEntry" ADD COLUMN "rateApplied"  DOUBLE PRECISION;
ALTER TABLE "TimeEntry" ADD COLUMN "flaggedAt"    TIMESTAMP(3);
ALTER TABLE "TimeEntry" ADD COLUMN "confirmedAt"  TIMESTAMP(3);
ALTER TABLE "TimeEntry" ADD COLUMN "note"         TEXT;
-- The shift this session was worked inside. No FK: a session must survive a
-- shift correction, and the payroll math reads by technician + date anyway.
ALTER TABLE "TimeEntry" ADD COLUMN "shiftEntryId" TEXT;

-- ── The trail (Kyle: "every hour is editable with a reason and a trail") ─────
CREATE TABLE "TimeEdit" (
    "id"           TEXT NOT NULL,
    "kind"         TEXT NOT NULL,          -- shift | job
    "shiftEntryId" TEXT,
    "timeEntryId"  TEXT,
    "actor"        TEXT NOT NULL,
    "reason"       TEXT NOT NULL,
    "beforeJson"   TEXT NOT NULL,
    "afterJson"    TEXT NOT NULL,
    "at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TimeEdit_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "TimeEdit_shiftEntryId_idx" ON "TimeEdit"("shiftEntryId");
CREATE INDEX "TimeEdit_timeEntryId_idx" ON "TimeEdit"("timeEntryId");

-- ── Pay rate and commission percent, typed by Kyle, never defaulted ─────────
ALTER TABLE "Technician" ADD COLUMN "hourlyRate"        DOUBLE PRECISION;
ALTER TABLE "Technician" ADD COLUMN "commissionPercent" DOUBLE PRECISION;

-- ── Commission (Kyle: a hand-entered PERCENTAGE per technician, on JOB PROFIT
--    = revenue − material − fees (permits, inspections). Labor is NOT
--    subtracted. Overridable per job with a reason.) ────────────────────────
CREATE TABLE "Commission" (
    "id"               TEXT NOT NULL,
    "technicianId"     TEXT NOT NULL,
    "visitId"          TEXT,
    "issuedEstimateId" TEXT,
    "basis"            TEXT NOT NULL DEFAULT 'job_profit',  -- job_profit | manual
    "percent"          DOUBLE PRECISION,
    "amount"           DOUBLE PRECISION NOT NULL,
    "note"             TEXT,
    "reason"           TEXT,
    "earnedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt"           TIMESTAMP(3),
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Commission_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Commission_technicianId_fkey" FOREIGN KEY ("technicianId")
        REFERENCES "Technician"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Commission_visitId_fkey" FOREIGN KEY ("visitId")
        REFERENCES "Visit"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "Commission_technicianId_idx" ON "Commission"("technicianId");
CREATE INDEX "Commission_visitId_idx" ON "Commission"("visitId");
