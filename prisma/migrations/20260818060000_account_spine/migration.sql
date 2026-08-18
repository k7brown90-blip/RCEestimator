-- P029 — the account spine.
--
-- Kyle, 2026-08-18: "All of it links to their account… if they have multiple addresses on file
-- it needs to link to the address that we are working at."
--
-- `IssuedEstimate.customerId` becomes REQUIRED and `serviceAddressId` is added, REQUIRED. Prisma
-- would generate a bare `ADD COLUMN NOT NULL` for that, which fails outright the moment a single
-- row exists. Production had zero issued estimates when this was written, but "zero right now"
-- is not a property a migration may assume — Kyle can issue one from his phone at any time, and
-- a failed migration takes the whole deploy down.
--
-- So this backfills what is genuinely derivable, and REFUSES rather than invents. The prompt's
-- constraint is "no invented placeholder accounts, ever"; a migration that fabricated an owner
-- to satisfy a NOT NULL would be exactly that, one layer down.

-- ── Test-account marker (P029): the price-book testing instrument, deletable in one action ──
ALTER TABLE "Customer" ADD COLUMN "isTestAccount" BOOLEAN NOT NULL DEFAULT false;

-- ── Add nullable first ──
ALTER TABLE "IssuedEstimate" ADD COLUMN "jobVisitId" TEXT;
ALTER TABLE "IssuedEstimate" ADD COLUMN "serviceAddressId" TEXT;

-- ── Backfill from the originating visit, which already knows both facts ──
UPDATE "IssuedEstimate" e
   SET "serviceAddressId" = v."propertyId",
       "customerId"       = COALESCE(e."customerId", v."customerId")
  FROM "Visit" v
 WHERE e."visitId" = v."id"
   AND e."serviceAddressId" IS NULL;

-- ── Second pass: an estimate that knows its account, where that account owns exactly ONE
-- address, has an unambiguous answer. More than one and it is a guess, so it is left alone. ──
UPDATE "IssuedEstimate" e
   SET "serviceAddressId" = p."id"
  FROM "Property" p
 WHERE e."serviceAddressId" IS NULL
   AND e."customerId" IS NOT NULL
   AND p."customerId" = e."customerId"
   AND (SELECT count(*) FROM "Property" p2 WHERE p2."customerId" = e."customerId") = 1;

-- ── Anything still unowned stops the migration by name. Do not guess an owner for a document
-- a customer may have signed. ──
DO $$
DECLARE orphans INT;
BEGIN
  SELECT count(*) INTO orphans
    FROM "IssuedEstimate"
   WHERE "serviceAddressId" IS NULL OR "customerId" IS NULL;

  IF orphans > 0 THEN
    RAISE EXCEPTION
      'P029 migration stopped: % issued estimate(s) have no derivable account/address. Attach them (or delete them) and redeploy — this migration will not invent an owner for a signed document.',
      orphans;
  END IF;
END $$;

-- ── Now they can be required ──
ALTER TABLE "IssuedEstimate" ALTER COLUMN "serviceAddressId" SET NOT NULL;
ALTER TABLE "IssuedEstimate" ALTER COLUMN "customerId" SET NOT NULL;

-- ── Restrict, not Cascade: an account or address with an issued estimate against it is not
-- deletable. The estimate is the record of what was quoted and it must keep naming who and where.
ALTER TABLE "IssuedEstimate"
  ADD CONSTRAINT "IssuedEstimate_customerId_fkey"
  FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "IssuedEstimate"
  ADD CONSTRAINT "IssuedEstimate_serviceAddressId_fkey"
  FOREIGN KEY ("serviceAddressId") REFERENCES "Property"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "IssuedEstimate_customerId_idx" ON "IssuedEstimate"("customerId");
CREATE INDEX "IssuedEstimate_serviceAddressId_idx" ON "IssuedEstimate"("serviceAddressId");
