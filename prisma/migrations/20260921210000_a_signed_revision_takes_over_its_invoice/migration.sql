-- A signed revision takes over its invoice (2026-09-21, PUNCHLIST A1).
--
-- Revising a SIGNED estimate never re-pointed anything: its change orders kept
-- naming the old row, its payments stayed on the old row, and /invoices hid the
-- old row the moment the revision existed (`supersededBy: null`). Money nobody
-- could list. From today the code moves the invoice when the revision is SIGNED
-- (services/issuedEstimateService.ts adoptSupersededInvoice): change orders and
-- payments move to the signed revision, and the replaced revision is voided with
-- that reason. This applies the same rule to whatever is already in the table.
--
-- Scope: every signed row that a SIGNED higher revision of the same number has
-- replaced. A signed row whose revision is still unsigned is NOT touched — it is
-- still the invoice, and the code now lists it again. Jobs are not touched: the
-- signed revision already minted its own job when it was signed under the old
-- code, and moving a job under a technician's schedule from a migration is not
-- a call to make blind. Idempotent: a second run finds nothing (voidedAt set).

CREATE TEMP TABLE replaced_revision AS
SELECT old."id" AS old_id, old."revision" AS old_revision, live."id" AS new_id, live."revision" AS new_revision
FROM "IssuedEstimate" old
JOIN LATERAL (
  SELECT n."id", n."revision"
  FROM "IssuedEstimate" n
  WHERE n."number" = old."number"
    AND n."revision" > old."revision"
    AND n."signedAt" IS NOT NULL
  ORDER BY n."revision" DESC
  LIMIT 1
) live ON TRUE
WHERE old."signedAt" IS NOT NULL
  AND old."voidedAt" IS NULL
  AND old."status" = 'signed';

-- The change orders: the root moved, so the frozen root link moves with it.
UPDATE "IssuedEstimate" co
SET "changeOrderForId" = r.new_id
FROM replaced_revision r
WHERE co."changeOrderForId" = r.old_id;

-- The money: every payment recorded on the replaced revision sits on the live one.
UPDATE "Payment" p
SET "estimateId" = r.new_id
FROM replaced_revision r
WHERE p."estimateId" = r.old_id;

-- The audit trail, before the void so the events read in order.
INSERT INTO "IssuedEstimateEvent" ("id", "estimateId", "type", "at", "actor", "detail")
SELECT md5(random()::text || clock_timestamp()::text || r.old_id), r.old_id, 'voided', now(), 'system:migration',
       'Rev ' || r.new_revision || ' was signed and took over this invoice (backfilled 2026-09-21): its change orders and payments now sit on rev ' || r.new_revision || '.'
FROM replaced_revision r;

INSERT INTO "IssuedEstimateEvent" ("id", "estimateId", "type", "at", "actor", "detail")
SELECT md5(random()::text || clock_timestamp()::text || r.new_id), r.new_id, 'invoice_taken_over', now(), 'system:migration',
       'Took over the invoice from rev ' || r.old_revision || ' (backfilled 2026-09-21).'
FROM replaced_revision r;

-- The replaced revision is a dead document: void, with the reason written down.
UPDATE "IssuedEstimate" e
SET "status" = 'void',
    "voidedAt" = now(),
    "voidReason" = 'Replaced by signed revision ' || r.new_revision || ' — its change orders and payments moved there (backfilled 2026-09-21).'
FROM replaced_revision r
WHERE e."id" = r.old_id;

DROP TABLE replaced_revision;
