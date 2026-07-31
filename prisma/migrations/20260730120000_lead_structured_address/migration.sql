-- Manual lead entry needs a structured address.
--
-- `Lead.address` is one free-text line the phone/email intake fills, and
-- conversion parses it with a regex requiring exactly "line1, city, ST 12345".
-- Anything else fell through and wrote the whole raw string into addressLine1
-- with city/state/postalCode persisted as EMPTY STRINGS — bypassing the .min(1)
-- that POST /properties enforces, and leaving jurisdictionResolver with no ZIP
-- to work from.
--
-- These five columns are what the CRM's manual form fills. Conversion consumes
-- them verbatim, no parsing. They are all-or-nothing at the API boundary, which
-- is what makes an empty-string address unrepresentable rather than merely
-- discouraged. Free text stays for the webhook and voice-agent callers.
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "addressLine1" TEXT;
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "addressLine2" TEXT;
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "city" TEXT;
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "state" TEXT;
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "postalCode" TEXT;

-- Property had no indexes at all. Prisma doesn't index relation scalars on
-- Postgres, and every account read fans out by customerId — now including
-- add/edit/delete-address, which each re-read the account.
CREATE INDEX IF NOT EXISTS "Property_customerId_idx" ON "Property"("customerId");

-- Both changes are expressible in Prisma's schema language, so `prisma db push`
-- creates them and tests/globalSetup.ts needs no companion edit. That file only
-- hand-applies what the schema language cannot express (currently the
-- PropertyFinding partial unique index).
