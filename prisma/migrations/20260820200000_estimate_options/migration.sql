-- Options the customer can actually choose between (Kyle, 2026-08-20).
--
-- "We still have some work to do on the estimate options... the options are not persisting into
--  the pdf or allowing to pick and choose between them. Only adding them all together."
--
-- The letter already survived onto every frozen line, so the DATA was never lost. What was missing
-- is anywhere to say what an option IS (a name, a description, its own price) and anywhere to
-- record which ones were bought. So the issued document flattened three options into one list and
-- one total, and the customer page offered no way to decline any of it.
--
-- Three parts:
--   1. PriceBookDraftOption      - Kyle's names while the estimate is still editable.
--   2. IssuedEstimateOption      - the same, frozen at issue, with the option's own subtotal.
--   3. IssuedEstimate.selectedOptions - what the customer ticked, recorded when they sign.
--
-- selectedOptions defaults to EMPTY, not to all three. An unsigned estimate has genuinely not been
-- chosen from, and defaulting to "all" would reintroduce the exact bug being fixed: every existing
-- estimate would silently claim the customer bought everything.

CREATE TABLE "PriceBookDraftOption" (
    "id"        TEXT NOT NULL,
    "draftId"   TEXT NOT NULL,
    "option"    "PriceBookOption" NOT NULL,
    "label"     TEXT,
    "note"      TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PriceBookDraftOption_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PriceBookDraftOption_draftId_option_key" ON "PriceBookDraftOption"("draftId", "option");
CREATE INDEX "PriceBookDraftOption_draftId_idx" ON "PriceBookDraftOption"("draftId");

ALTER TABLE "PriceBookDraftOption" ADD CONSTRAINT "PriceBookDraftOption_draftId_fkey"
    FOREIGN KEY ("draftId") REFERENCES "PriceBookDraftEstimate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "IssuedEstimateOption" (
    "id"         TEXT NOT NULL,
    "estimateId" TEXT NOT NULL,
    "option"     "PriceBookOption" NOT NULL,
    "label"      TEXT,
    "note"       TEXT,
    "subtotal"   DOUBLE PRECISION NOT NULL,
    "lineCount"  INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "IssuedEstimateOption_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "IssuedEstimateOption_estimateId_option_key" ON "IssuedEstimateOption"("estimateId", "option");
CREATE INDEX "IssuedEstimateOption_estimateId_idx" ON "IssuedEstimateOption"("estimateId");

ALTER TABLE "IssuedEstimateOption" ADD CONSTRAINT "IssuedEstimateOption_estimateId_fkey"
    FOREIGN KEY ("estimateId") REFERENCES "IssuedEstimate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "IssuedEstimate" ADD COLUMN "selectedOptions" "PriceBookOption"[] DEFAULT ARRAY[]::"PriceBookOption"[];

-- Backfill the option rows for estimates that already exist, so an estimate issued before today
-- still renders as options rather than as a flat list. Subtotals come from the frozen lines, which
-- is the only truthful source for a document already in a customer's hands.
INSERT INTO "IssuedEstimateOption" ("id", "estimateId", "option", "subtotal", "lineCount")
SELECT
    -- Not gen_random_uuid(): that is only core from Postgres 13 and needs pgcrypto before it.
    -- These ids are plain text like every other id in this schema, so there is no reason to make
    -- the migration depend on a server version or an extension being present.
    md5(l."estimateId" || l."option"::text),
    l."estimateId",
    l."option",
    COALESCE(SUM(l."lineTotal"), 0),
    COUNT(*)::int
FROM "IssuedEstimateLine" l
GROUP BY l."estimateId", l."option";
