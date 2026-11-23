-- W2 batch A (Kyle, 2026-11-23): the field app is where Kyle and Michael talk to the whole AI team.

-- AlterTable
ALTER TABLE "AgentAuditLog" ADD COLUMN     "agentKeyName" TEXT;

-- AlterTable
ALTER TABLE "AgentKey" ADD COLUMN     "teamPostsPublish" BOOLEAN NOT NULL DEFAULT true;

-- DATA: bring every live (not revoked) agent key's HUB scopes to Kyle's 2026-11-23 defaults, by role.
-- Only hub:read, hub:draft, team:read and team:reply are touched; every other scope string stays as stored.
-- Idempotent: a removal takes out only what is there, an add appends only what is missing, so a second run changes nothing.
--   admin, outreach:                 Read team, Post team, Read customer, Draft customer
--   inventory, facebook, scout,
--   claude_code, research, nec_coach: Read team, Post team (no hub:read, no hub:draft)
-- ("other" has no defaults and the new "cfo" role has no keys yet, so neither is listed.)
UPDATE "AgentKey" AS k
SET "scopes" = array_cat(
  ARRAY(SELECT t.s FROM unnest(k."scopes") WITH ORDINALITY AS t(s, o) WHERE t.s <> ALL (m."remove_scopes") ORDER BY t.o),
  ARRAY(SELECT a FROM unnest(m."add_scopes") AS a WHERE a <> ALL (k."scopes"))
)
FROM (VALUES
  ('admin',       ARRAY['team:read','team:reply','hub:read','hub:draft']::text[], ARRAY[]::text[]),
  ('outreach',    ARRAY['team:read','team:reply','hub:read','hub:draft']::text[], ARRAY[]::text[]),
  ('inventory',   ARRAY['team:read','team:reply']::text[],                        ARRAY['hub:read','hub:draft']::text[]),
  ('facebook',    ARRAY['team:read','team:reply']::text[],                        ARRAY['hub:read','hub:draft']::text[]),
  ('scout',       ARRAY['team:read','team:reply']::text[],                        ARRAY['hub:read','hub:draft']::text[]),
  ('claude_code', ARRAY['team:read','team:reply']::text[],                        ARRAY['hub:read','hub:draft']::text[]),
  ('research',    ARRAY['team:read','team:reply']::text[],                        ARRAY['hub:read','hub:draft']::text[]),
  ('nec_coach',   ARRAY['team:read','team:reply']::text[],                        ARRAY['hub:read','hub:draft']::text[])
) AS m("role", "add_scopes", "remove_scopes")
WHERE k."agentRole" = m."role" AND k."revokedAt" IS NULL;

-- DATA: Scout (was training threads only) and Claude Code (was dev threads only) are no longer limited to one kind of thread.
UPDATE "AgentKey"
SET "hubThreadKinds" = '{}'
WHERE "agentRole" IN ('scout', 'claude_code') AND "revokedAt" IS NULL AND cardinality("hubThreadKinds") > 0;
