-- Kyle's flat book prices are exempt from the job-level material gates (2026-08-31):
-- a "+New Item" entered at $456 was landing on the estimate at $285.98 because gate 2
-- re-marked its material share. The engine now skips flat-priced lines; this flag freezes
-- that fact on each issued line so the combination discount recomputed from frozen lines
-- (signing, customer page) agrees with the issue without consulting the live catalog.
ALTER TABLE "IssuedEstimateLine" ADD COLUMN "flatPriced" BOOLEAN NOT NULL DEFAULT false;
