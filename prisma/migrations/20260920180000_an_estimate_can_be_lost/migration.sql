-- An estimate can be LOST (Kyle, 2026-09-20): "The mark lost would also live
-- with an estimate for when we give an estimate but they either hire someone
-- else or end up not moving forward with the job."
--
-- Lost is not void. Void is a dead document (wrong price, superseded, job
-- cancelled) and leaves the win rate; lost is the customer's decision and
-- stays in it. Until now the two were indistinguishable from a quote still
-- sitting out, so Estimate -> Job could not be measured at all.
--
-- `status` gains the value 'lost' (no enum — the vocabulary is
-- shared/estimateStatus.ts). The three columns carry what the funnel reads:
-- when, why (the SAME reason list leads use), and what they said. All three
-- clear when the estimate is reopened.

ALTER TABLE "IssuedEstimate"
  ADD COLUMN "lostAt"     TIMESTAMP(3),
  ADD COLUMN "lostReason" TEXT,
  ADD COLUMN "lostNotes"  TEXT;
