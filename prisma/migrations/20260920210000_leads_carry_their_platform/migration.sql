-- WHICH PLATFORM sent the lead (Kyle, 2026-09-20, the four-phase funnel):
-- "Leads to accounts tracks how well the marketing is doing via google, yelp,
-- nextdoor, and angi leads."
--
-- `Lead.source` records HOW a lead arrived (email | phone | web | manual |
-- referral | savannah_text | retention) and keeps its history untouched.
-- `platform` records WHO SENT IT — google | yelp | nextdoor | angi | referral |
-- repeat_customer | other (vocabulary in shared/leadPlatform.ts). Tagged at
-- intake; null on every lead that predates this ("unknown" in reports).
--
-- The same column on Customer is copied from the lead at convert, so lifetime
-- spend and repeat work (phase 4) can be read by the platform that brought the
-- account (phase 1). Without it the platform was lost the moment a lead became
-- an account.

ALTER TABLE "Lead"     ADD COLUMN "platform" TEXT;
ALTER TABLE "Customer" ADD COLUMN "platform" TEXT;
