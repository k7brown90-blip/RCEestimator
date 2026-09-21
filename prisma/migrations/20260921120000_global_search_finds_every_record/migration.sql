-- Global search (2026-09-20, drawers plan Phase 5). Kyle: "There are too many separate pages and
-- I end up having to jump around too much. I can't keep track of where everything is."
--
-- One endpoint (GET /search, services/globalSearch.ts) matches names, addresses, emails, phone
-- digits, estimate numbers and P.O. numbers with `ILIKE '%term%'`. A btree index cannot serve a
-- leading-wildcard LIKE, and every column below was unindexed for search. These are trigram GIN
-- indexes (pg_trgm), which serve substring and case-insensitive matching directly.
--
-- ── THIS MIGRATION MUST NEVER KILL A DEPLOY ────────────────────────────────────────────────────
-- `npm start` runs `prisma migrate deploy` before the server boots. A migration that fails leaves
-- production DOWN. `CREATE EXTENSION` needs a privilege the database role may not have (pg_trgm is
-- a trusted extension since PostgreSQL 13, so the database OWNER can install it without superuser;
-- a role that is neither cannot), and a host could in principle ship without the contrib package.
-- So the extension is created inside a DO block that catches EVERY error and turns it into a
-- WARNING, and the indexes are created only if the extension is actually present afterwards.
-- On a role that cannot install it the migration still SUCCEEDS, the search endpoint still works
-- (sequential scans — fine at this business's row counts), and the server logs one SystemEvent
-- ("search", warn) the first time a search runs so the gap is visible in readSystemEvents.
--
-- Everything here is idempotent (IF NOT EXISTS), so re-running it by hand is safe.

DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
EXCEPTION
  WHEN OTHERS THEN
    RAISE WARNING 'global search: could not install pg_trgm (%: %). Search will run without its trigram indexes until an administrator runs CREATE EXTENSION pg_trgm and re-applies this migration''s CREATE INDEX statements.', SQLSTATE, SQLERRM;
END
$$;

-- The indexes, guarded the same way: a failure here (a role that owns the tables but has lost
-- CREATE on the schema, say) rolls this block back and warns, and the deploy still completes.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    RAISE WARNING 'global search: pg_trgm is not installed; skipping the trigram indexes.';
    RETURN;
  END IF;

  -- Customer: name, email, phone (the last-four-digits candidate query in services/globalSearch.ts
  -- is a `contains`, which the existing btree on phone cannot serve either).
  CREATE INDEX IF NOT EXISTS "Customer_name_trgm_idx"  ON "Customer" USING GIN ("name"  gin_trgm_ops);
  CREATE INDEX IF NOT EXISTS "Customer_email_trgm_idx" ON "Customer" USING GIN ("email" gin_trgm_ops);
  CREATE INDEX IF NOT EXISTS "Customer_phone_trgm_idx" ON "Customer" USING GIN ("phone" gin_trgm_ops);

  -- Property: the address as Kyle types it.
  CREATE INDEX IF NOT EXISTS "Property_addressLine1_trgm_idx" ON "Property" USING GIN ("addressLine1" gin_trgm_ops);
  CREATE INDEX IF NOT EXISTS "Property_city_trgm_idx"         ON "Property" USING GIN ("city"         gin_trgm_ops);
  CREATE INDEX IF NOT EXISTS "Property_postalCode_trgm_idx"   ON "Property" USING GIN ("postalCode"   gin_trgm_ops);

  -- Lead: both address tracks (free text from phone/email intake, structured from the CRM form).
  CREATE INDEX IF NOT EXISTS "Lead_name_trgm_idx"         ON "Lead" USING GIN ("name"         gin_trgm_ops);
  CREATE INDEX IF NOT EXISTS "Lead_email_trgm_idx"        ON "Lead" USING GIN ("email"        gin_trgm_ops);
  CREATE INDEX IF NOT EXISTS "Lead_phone_trgm_idx"        ON "Lead" USING GIN ("phone"        gin_trgm_ops);
  CREATE INDEX IF NOT EXISTS "Lead_address_trgm_idx"      ON "Lead" USING GIN ("address"      gin_trgm_ops);
  CREATE INDEX IF NOT EXISTS "Lead_addressLine1_trgm_idx" ON "Lead" USING GIN ("addressLine1" gin_trgm_ops);
  CREATE INDEX IF NOT EXISTS "Lead_city_trgm_idx"         ON "Lead" USING GIN ("city"         gin_trgm_ops);

  -- PurchaseOrder: the number (whole, prefix, or last digits) and the supplier.
  CREATE INDEX IF NOT EXISTS "PurchaseOrder_number_trgm_idx"   ON "PurchaseOrder" USING GIN ("number"   gin_trgm_ops);
  CREATE INDEX IF NOT EXISTS "PurchaseOrder_supplier_trgm_idx" ON "PurchaseOrder" USING GIN ("supplier" gin_trgm_ops);

  -- IssuedEstimate: the number and the three frozen strings.
  CREATE INDEX IF NOT EXISTS "IssuedEstimate_number_trgm_idx"         ON "IssuedEstimate" USING GIN ("number"         gin_trgm_ops);
  CREATE INDEX IF NOT EXISTS "IssuedEstimate_title_trgm_idx"          ON "IssuedEstimate" USING GIN ("title"          gin_trgm_ops);
  CREATE INDEX IF NOT EXISTS "IssuedEstimate_customerName_trgm_idx"   ON "IssuedEstimate" USING GIN ("customerName"   gin_trgm_ops);
  CREATE INDEX IF NOT EXISTS "IssuedEstimate_serviceAddress_trgm_idx" ON "IssuedEstimate" USING GIN ("serviceAddress" gin_trgm_ops);
EXCEPTION
  WHEN OTHERS THEN
    RAISE WARNING 'global search: could not create the trigram indexes (%: %). Search still works, unindexed; re-run this migration''s CREATE INDEX statements once the cause is fixed.', SQLSTATE, SQLERRM;
END
$$;
