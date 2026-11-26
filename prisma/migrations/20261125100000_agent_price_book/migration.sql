-- Agent price book (Kyle, 2026-11-24 / 2026-11-25), batch 1: scopes, the agent door, proposals, audit and events.
-- Batch 1 changes no table or column (a datamodel-to-datamodel `prisma migrate diff` of the schema before and after this batch is empty), so this
-- file is DATA only. Later batches of the same work order (the sales-tax column) append their own statements below before anything deploys.

-- DATA: the unused scope "pricebook:propose" (nothing in the code ever read it) is retired from every key, and live keys get Kyle's new defaults:
--   Inventory:                                  pricebook:read + pricebook:write ("Read the price book", "Add to the price book and propose changes")
--   every other role but Other (admin, outreach,
--   research, cfo, facebook, scout, nec_coach,
--   claude_code):                               pricebook:read
-- Only these scope strings are touched; every other scope on a key stays exactly as stored, in the same order. Idempotent: a removal takes out only
-- what is there and an add appends only what is missing, so a second run changes nothing. Revoked keys are not given the new scopes.
UPDATE "AgentKey"
SET "scopes" = ARRAY(SELECT t.s FROM unnest("scopes") WITH ORDINALITY AS t(s, o) WHERE t.s <> 'pricebook:propose' ORDER BY t.o)
WHERE 'pricebook:propose' = ANY("scopes");

UPDATE "AgentKey" AS k
SET "scopes" = array_cat(k."scopes", ARRAY(SELECT a FROM unnest(m."add_scopes") AS a WHERE a <> ALL (k."scopes")))
FROM (VALUES
  ('inventory',   ARRAY['pricebook:read', 'pricebook:write']::text[]),
  ('admin',       ARRAY['pricebook:read']::text[]),
  ('outreach',    ARRAY['pricebook:read']::text[]),
  ('research',    ARRAY['pricebook:read']::text[]),
  ('cfo',         ARRAY['pricebook:read']::text[]),
  ('facebook',    ARRAY['pricebook:read']::text[]),
  ('scout',       ARRAY['pricebook:read']::text[]),
  ('nec_coach',   ARRAY['pricebook:read']::text[]),
  ('claude_code', ARRAY['pricebook:read']::text[])
) AS m("role", "add_scopes")
WHERE k."agentRole" = m."role" AND k."revokedAt" IS NULL;
