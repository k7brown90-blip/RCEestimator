-- §3.3 grounding instrument limitation: the claim the report may make depends
-- on the instrument used. Kyle confirmed the company kit 2026-08-02: EXTECH
-- Earth Ground Resistance Tester Kit — 3-point fall-of-potential with
-- auxiliary spikes (true electrode resistance, the strongest of the three
-- claims). Stored per inspection so a record made with a different meter
-- keeps its own honest wording; the report template selects language from
-- this value (services/reportLanguage.ts).
ALTER TABLE "HealthInspection" ADD COLUMN IF NOT EXISTS "groundingTestMethod" TEXT;
