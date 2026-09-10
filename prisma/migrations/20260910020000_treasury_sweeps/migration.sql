-- Month-end sweep on a click (Kyle, 2026-09-09).
--
-- "At the end of each month I will take whatever money is over that value and
-- deposit it into the Chase savings accounts for taxes and owner distributions."
-- Ratified: the floats live in Settings (CompanySetting key "treasury" -- no
-- schema change, same JSON store as companyProfile); the sweep happens ON A
-- CLICK from the number Financials shows -- never automatic, never scheduled.
--
-- TreasurySweep is one row per click: the financial account the money left,
-- the dollars, where it went, Stripe's outbound transfer id when Stripe created
-- one, and the status. A refused attempt is recorded too (status 'failed', the
-- exact Stripe message in "error") so Kyle can see what to enable on the key.
--
-- Additive only.

CREATE TABLE "TreasurySweep" (
    "id" TEXT NOT NULL,
    "financialAccountId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,              -- dollars
    "destinationLabel" TEXT NOT NULL,
    "stripeTransferId" TEXT,                         -- obt_... when Stripe created it
    "status" TEXT NOT NULL,                          -- created | failed | posted | returned | canceled
    "error" TEXT,
    "requestedBy" TEXT NOT NULL DEFAULT 'owner',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TreasurySweep_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "TreasurySweep_createdAt_idx" ON "TreasurySweep"("createdAt");
CREATE INDEX "TreasurySweep_status_idx" ON "TreasurySweep"("status");
